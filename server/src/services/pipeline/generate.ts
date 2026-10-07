import { chat, chatJson } from '../azure.js'
import { planSchema } from '../../schemas.js'
import { PLAN_SYSTEM, planUser } from '../../prompts/plan.js'
import { CODEGEN_SYSTEM, REFINE_SYSTEM, REPAIR_SYSTEM, codegenUser } from '../../prompts/codegen.js'
import { applyBrand } from '../brand.js'
import { emitFoundation, screenComponentName, screenFilePath, type EmitContext } from '../emit/index.js'
import { withSafeTypeNames } from '../emit/normalise.js'
import { demoNames } from '../emit/demo.js'
import { UNDOCUMENTED_RESPONSE, capturedFields, coveredSpec, formTypeName } from '../emit/types.js'
import { collectionName, storableEntities } from '../emit/localStore.js'
import { COMPONENT_PROPS, UNIVERSAL_PROPS } from '../emit/uikit.js'
import {
  checkComponentProps,
  checkFabricatedData,
  checkGrounding,
  checkImports,
  checkSyntax,
  checkHookOrder,
  checkResponsesRendered,
  checkUndefinedComponents,
  checkUsesApi,
  checkFlowUse,
  checkUsesReadHelpers,
  describeViolations,
  type Violation,
} from './validate.js'
import path from 'node:path'
import { byFile, describeErrors, typeCheck, type TypeError } from './typecheck.js'
import { repairPlan, validatePlan, type FlowIssue } from './flow.js'
import { probeEndpoints } from './probe.js'
import { bindFlow } from './bind.js'
import { senderName } from '../emit/flow.js'
import { config } from '../../config.js'
import type { AppPlan, AppSpec, ConnectionSettings, GeneratedFile, ScreenPlan, SpecDocument } from '../../types.js'

export interface GenerateHooks {
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void
  onPlan?: (plan: AppPlan) => void
  onFile?: (file: GeneratedFile) => void
  onScreenStart?: (screen: ScreenPlan) => void
  onScreenDone?: (screen: ScreenPlan, path: string) => void
}

/** Strips a ```tsx fence if the model wrapped the file in one. */
function unfence(raw: string): string {
  const fenced = raw.match(/```(?:tsx?|jsx?|typescript)?\s*\n([\s\S]*?)```/)
  return (fenced?.[1] ?? raw).trim()
}

const slug = (value: string, fallback: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

/**
 * The operations that can actually be reached.
 *
 * An endpoint with no host cannot be called, and counting it as a data source
 * produces a screen that fires a request at a relative path and shows an error
 * for ever — strictly worse than admitting there is nothing to call.
 *
 * A host set in Connection settings supplies one for every endpoint at once.
 * That is the normal case, not an edge: an internal API document lists paths,
 * bodies and responses and names no server, because everyone reading it already
 * knows which one. Ignoring the override meant every screen in such a project
 * was written off as undemonstrable and generated with sample data, and setting
 * the host afterwards changed nothing — the decision had already been taken.
 */
export function callableEndpoints(appSpec: AppSpec, baseUrlOverride?: string): Set<string> {
  const override = baseUrlOverride?.trim() ?? ''
  return new Set(
    appSpec.endpoints
      .filter((endpoint) => override.length > 0 || endpoint.baseUrl.trim().length > 0)
      .map((endpoint) => endpoint.operationId),
  )
}

export async function planScreens(
  appSpec: AppSpec,
  ctx: Pick<EmitContext, 'baseUrlOverride'> = {},
  log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  sampleData = false,
): Promise<AppPlan> {
  const result = await chatJson({
    system: PLAN_SYSTEM,
    user: planUser(appSpec),
    schema: planSchema,
    temperature: 0.4,
  })

  const validIds = new Set(appSpec.endpoints.map((e) => e.operationId))
  const usedRoutes = new Set<string>()
  const usedIds = new Set<string>()

  const screens: ScreenPlan[] = result.screens.map((raw, index) => {
    let id = slug(raw.name, `screen-${index + 1}`)
    while (usedIds.has(id)) id = `${id}-${index + 1}`
    usedIds.add(id)

    // Two screens on one route would make the second unreachable.
    let route = raw.route.startsWith('/') ? raw.route : `/${raw.route}`
    while (usedRoutes.has(route)) route = `${route}-${index + 1}`
    usedRoutes.add(route)

    const sections = raw.sections.map((s) => ({
      title: s.title,
      kind: s.kind,
      description: s.description,
      // Drop any operationId the model invented; it cannot be called anyway.
      endpointIds: s.endpoints.filter((e) => validIds.has(e)),
    }))

    const endpointIds = [
      ...new Set([...raw.endpoints.filter((e) => validIds.has(e)), ...sections.flatMap((s) => s.endpointIds)]),
    ]

    return {
      id,
      name: raw.name,
      route,
      type: raw.type,
      purpose: raw.purpose,
      icon: raw.icon,
      sections,
      endpointIds,
      showInNav: raw.showInNav,
      ...(raw.notes ? { notes: raw.notes } : {}),
      ...(raw.hero?.headline ? { hero: raw.hero } : {}),
      ...(raw.aside?.title ? { aside: raw.aside } : {}),
      // Only what the documents actually named. A covers entry pointing at
      // nothing would silently take a documented screen's fields with it.
      ...(raw.covers?.length
        ? {
            covers: raw.covers.filter((name) =>
              appSpec.documentedScreens.some(
                (d) => d.name.toLowerCase().trim() === name.toLowerCase().trim(),
              ),
            ),
          }
        : {}),
    }
  })

  /*
   * When the documents specified a screen, its buttons were already matched to
   * operations by the linking pass. That mapping is authoritative — it came
   * from reading the documentation — so it is applied directly rather than
   * left to the planner to copy across, which it does not reliably do.
   */
  for (const screen of screens) {
    const source = coveredSpec(screen, appSpec.documentedScreens)
    if (!source) continue

    const fromActions = [...new Set(source.actions.flatMap((a) => a.endpointIds))].filter((id) =>
      validIds.has(id),
    )
    if (fromActions.length === 0) continue

    const before = screen.endpointIds.length
    screen.endpointIds = [...new Set([...screen.endpointIds, ...fromActions])]

    // Give the codegen prompt a section per button, so each one is wired.
    for (const action of source.actions) {
      const ids = action.endpointIds.filter((id) => validIds.has(id))
      if (ids.length === 0) continue
      if (screen.sections.some((s) => s.endpointIds.some((id) => ids.includes(id)))) continue
      screen.sections.push({
        title: action.label,
        kind: 'form',
        description: action.does,
        endpointIds: ids,
      })
    }

    if (before === 0) {
      log(`${screen.name}: wired to ${fromActions.join(', ')} from its documented buttons`)
    }
  }

  /*
   * Tell a display-only screen what it is actually handed.
   *
   * `location.state` is `any`, so a screen left to guess writes
   * `policy.premiumAmount` against a payload that has no such field, and the
   * compiler cannot object — it crashes at runtime instead. Naming the real
   * type turns that into a compile error, which the gate then catches.
   */
  const byName = new Map(appSpec.endpoints.map((e) => [e.operationId, e]))
  const successTypeOf = (operationIds: string[]): string | undefined => {
    for (const id of operationIds) {
      const typeName = byName.get(id)?.responses.find((r) => /^2\d\d$/.test(r.status))?.typeName
      if (typeName) return typeName
    }
    return undefined
  }

  for (const [index, screen] of screens.entries()) {
    /*
     * Any screen a documented flow leads to receives the previous screen's
     * result — not only the ones without endpoints. A Free Look entry form
     * calls two APIs of its own *and* needs the policy the search returned, and
     * treating "has endpoints" as "needs nothing" left it with an empty state
     * it could never escape.
     */

    // Whoever declares they navigate here, else simply the screen before it.
    const source =
      appSpec.documentedScreens.find(
        (d) => d.navigatesTo?.toLowerCase().trim() === screen.name.toLowerCase().trim(),
      ) ??
      (index > 0
        ? appSpec.documentedScreens.find(
            (d) => d.name.toLowerCase().trim() === screens[index - 1]!.name.toLowerCase().trim(),
          )
        : undefined)

    const previous = index > 0 ? screens[index - 1] : undefined
    // A documented screen whose buttons name no endpoint still calls whatever
    // the plan gave it — an empty list is not an answer, so fall through.
    const documentedIds = source?.actions.flatMap((a) => a.endpointIds) ?? []
    const fromIds = documentedIds.length > 0 ? documentedIds : previous?.endpointIds ?? []

    /*
     * Follow the chain, do not stop at the first hop.
     *
     * A three-screen flow often goes fetch -> display -> act. The middle screen
     * calls nothing, so asking it "what do your endpoints return?" yields
     * nothing, and the third screen ends up with no data at all. What it really
     * receives is whatever the middle screen was handed, passed along.
     */
    const typeName =
      successTypeOf(fromIds) ??
      (source ? screens.find((s) => s.name === source.name)?.incomingType : undefined) ??
      previous?.incomingType

    /*
     * The supplier really calls an API, but the documents never show what it
     * returns ("returns it as a Map"). The result still arrives in router
     * state; without a type the screen used to be judged as having no data
     * source and was handed invented sample values in place of the real ones.
     */
    const untyped = !typeName && fromIds.some((id) => byName.has(id))

    if (typeName || untyped) {
      screen.incomingType = typeName ?? UNDOCUMENTED_RESPONSE
      screen.incomingFrom = source?.name ?? screens[index - 1]?.name ?? 'the previous screen'
      log(
        typeName
          ? `${screen.name}: receives ${typeName} from ${screen.incomingFrom}`
          : `${screen.name}: receives the result of ${fromIds.join(', ')} from ${screen.incomingFrom} — ` +
              'its shape is not documented, so fields are read by name at runtime',
        typeName ? 'info' : 'warn',
      )
    }
  }

  /*
   * Carry what the user typed, alongside what the API returned.
   *
   * A documented screen routinely lists fields no response contains — the
   * Registration form sends thirteen values and gets four back, yet the next
   * screen is specified to display all thirteen. Those nine live only in the
   * browser, so each screen declares the values it captures and passes them on,
   * and the chain accumulates rather than replacing: a screen three steps down
   * still needs what step one collected.
   */
  for (const [index, screen] of screens.entries()) {
    const spec = coveredSpec(screen, appSpec.documentedScreens)
    if (spec && capturedFields(spec).length > 0) screen.formType = formTypeName(screen.name)

    const previous = index > 0 ? screens[index - 1] : undefined
    const inherited = previous?.formType ?? previous?.incomingFormType
    if (inherited) {
      screen.incomingFormType = inherited
      log(`${screen.name}: also receives ${inherited} entered earlier in the flow`)
    }
  }

  /*
   * A screen with no endpoints generates as a static mockup — the single worst
   * outcome this tool can produce, and a silent one. Recover by matching the
   * screen's route against the endpoint paths, then say plainly what happened.
   */
  if (appSpec.endpoints.length > 0) {
    for (const screen of screens) {
      if (screen.endpointIds.length > 0) continue
      // Already accounted for: it displays what the previous screen fetched.
      if (screen.incomingType) continue

      const recovered = inferEndpoints(screen, appSpec)
      if (recovered.length > 0) {
        screen.endpointIds = recovered
        if (screen.sections.length > 0) screen.sections[0]!.endpointIds = recovered
        else {
          screen.sections = [
            { title: screen.name, kind: 'table', description: screen.purpose, endpointIds: recovered },
          ]
        }
        log(`${screen.name}: plan listed no endpoints — matched ${recovered.join(', ')} by route`, 'warn')
      } else {
        log(`${screen.name}: no endpoint could be matched, this screen will have no live data`, 'warn')
      }
    }
  }

  /*
   * Last resort: a screen with no endpoint, nothing upstream, and no form to
   * fill has nothing to show. Rather than emit an empty shell, give it sample
   * data — clearly labelled as such by the notice the screen renders.
   */
  /*
   * An endpoint with no base URL cannot be called. Counting it as a data source
   * produces a screen that fires a request at a relative path and shows an error
   * for ever, which is strictly worse than admitting there is nothing to call.
   */
  const override = ctx.baseUrlOverride?.trim() ?? ''
  const callable = callableEndpoints(appSpec, override)
  const uncallable = appSpec.endpoints.length - callable.size
  if (uncallable > 0) {
    log(
      `${uncallable} endpoint(s) have no base URL, so they cannot be called. ` +
        'Set one in Connection settings and regenerate to use the real API.',
      'warn',
    )
  } else if (override.length > 0 && appSpec.endpoints.some((e) => !e.baseUrl.trim())) {
    log(`Calling ${override} — the host from Connection settings, which your documents did not state`)
  }

  /*
   * An application the documents model but give no API for.
   *
   * Sample data would make every screen correct and every button inert. A store
   * in the browser makes the same screens work, so this replaces demo mode
   * entirely rather than sitting alongside it.
   */
  const storable = sampleData && appSpec.endpoints.length === 0 ? storableEntities(appSpec) : []
  if (!sampleData && appSpec.endpoints.length === 0) {
    log(
      'No API is documented and sample data is off, so screens show their layout ' +
        'without data. Turn on sample data to demo them, or add the API documentation.',
      'warn',
    )
  } else if (storable.length > 0) {
    for (const screen of screens) screen.local = true
    log(
      'No API is documented, so the app keeps its own data in the browser: ' +
        storable.map((e) => collectionName(e.name)).join(', '),
    )
  } else if (appSpec.endpoints.length === 0) {
    /*
     * Say why the app cannot keep anything.
     *
     * With no endpoints and no data shapes there is nothing to build a store
     * from, so screens fall back to sample data and every button does nothing.
     * That was indistinguishable from a bug until it was named here.
     */
    log(
      'No API and no data shapes were found, so screens will show sample data and ' +
        'cannot save anything. Describe the data — a list of the fields each record ' +
        'holds — and the app will keep its own records instead.',
      'warn',
    )
  }

  for (const screen of screens) {
    if (screen.local) continue
    if (screen.incomingType) continue
    if (screen.endpointIds.some((id) => callable.has(id))) continue

    /*
     * A form is normally exempt — it has nothing to show until the user acts.
     * But a form whose documented buttons were meant to call an API that does
     * not exist has dead controls, which is a worse demo than sample results.
     */
    const documentedActions =
      appSpec.documentedScreens.find(
        (d) => d.name.toLowerCase().trim() === screen.name.toLowerCase().trim(),
      )?.actions ?? []
    const buttonsWantAnApi = documentedActions.some(
      (a) => a.endpointIds.length > 0 || /\bapi\b|call/i.test(a.does),
    )

    const inputOnly = screen.type === 'form' || screen.type === 'auth' || screen.type === 'search'
    if (inputOnly && !buttonsWantAnApi) continue

    if (!sampleData) {
      screen.unsourced = true
      log(
        screen.endpointIds.length > 0
          ? `${screen.name}: its endpoints have no base URL and sample data is off — it will say no API is connected`
          : `${screen.name}: no API supplies this screen and sample data is off — it will say so instead of inventing values`,
        'warn',
      )
      continue
    }

    screen.demo = demoNames(screen.name)
    log(
      screen.endpointIds.length > 0
        ? `${screen.name}: its endpoints have no base URL — using clearly-labelled sample data`
        : `${screen.name}: no data source documented — using clearly-labelled sample data`,
      'warn',
    )
  }

  // A screen on sample data must not also try to call something it cannot reach.
  for (const screen of screens) {
    if (!screen.demo) continue
    screen.endpointIds = []
    screen.sections = screen.sections.map((s) => ({ ...s, endpointIds: [] }))
  }

  // An endpoint no screen reaches is a hole in the app. It is not always wrong
  // — some operations have no place in a UI — so report it rather than force it.
  const covered = new Set(screens.flatMap((s) => s.endpointIds))
  const uncovered = appSpec.endpoints.filter((e) => !covered.has(e.operationId))
  if (uncovered.length > 0) {
    log(
      `${uncovered.length} endpoint(s) are not reachable from any screen: ${uncovered
        .map((e) => e.operationId)
        .join(', ')}`,
      'warn',
    )
  }

  /*
   * Say which documented screens each page answers for, and shout about any
   * the planner left out.
   *
   * The planner decides how many pages there are now, which is what stops a
   * section becoming a route nothing can link to. The risk that comes with the
   * judgement is the old one returning by another door: a documented screen
   * covered by nobody loses its fields and buttons entirely, and a plan that
   * merely looks tidy is indistinguishable from one that dropped half the
   * specification. So the mapping is stated, and the gap is named.
   */
  if (appSpec.documentedScreens.length > 0) {
    const key = (value: string) => value.toLowerCase().trim()

    for (const screen of screens) {
      if (!screen.covers?.length) continue
      const others = screen.covers.filter((name) => key(name) !== key(screen.name))
      if (others.length > 0) log(`${screen.name}: also covers ${others.join(', ')}`)
    }

    const claimed = new Set(
      screens.flatMap((s) => (s.covers?.length ? s.covers : [s.name])).map(key),
    )
    const orphans = appSpec.documentedScreens.filter((d) => !claimed.has(key(d.name)))
    if (orphans.length > 0) {
      log(
        `${orphans.length} documented screen(s) are not covered by any page, so their ` +
          `fields and buttons will not appear: ${orphans.map((d) => d.name).join(', ')}`,
        'error',
      )
    }
  }

  /*
   * Number the screens when the plan is a journey rather than a set of
   * destinations.
   *
   * A sidebar of equal links is right for a dashboard and wrong for an
   * application form: documents that specify screens in order are describing one
   * walk through the product, and flattening "apply, review, pay, confirm" into
   * four interchangeable pages loses the only thing the user wants to know,
   * which is how much is left.
   *
   * The planner says which it is. Counting documented screens used to decide
   * it, and that numbered every app whose documents listed three screens — a
   * list, a detail and a settings page came out as "Step 01 / 03", and one
   * merged screen as "Step 01 / 01". Without the planner's answer, only a
   * chain where every screen is fed by the one before it counts.
   */
  const chained = screens.length >= 3 && screens.slice(1).every((s) => Boolean(s.incomingFrom))
  const journey = screens.length >= 2 && (result.journey ?? chained)
  if (journey) {
    for (const [index, screen] of screens.entries()) {
      screen.step = { index: index + 1, total: screens.length }
    }
    log(`Shown as a ${screens.length}-step journey`)
  }

  // Exactly one screen must own "/", or the router has no landing page.
  if (!screens.some((s) => s.route === '/')) {
    const landing = screens.find((s) => s.showInNav) ?? screens[0]
    if (landing) {
      usedRoutes.delete(landing.route)
      landing.route = '/'
    }
  }

  return {
    screens,
    navigation: screens
      .filter((s) => s.showInNav)
      .map((s) => ({ screenId: s.id, label: s.name, icon: s.icon })),
    theme: result.theme,
    designNotes: result.designNotes,
    sampleData,
  }
}

/**
 * Best-effort match of a screen to endpoints, used only when the planner left
 * it empty. Compares the screen's route against each endpoint's path by
 * resource segment, then narrows by what the screen type implies.
 */
function inferEndpoints(screen: ScreenPlan, appSpec: AppSpec): string[] {
  const segmentsOf = (route: string) =>
    route
      .split('/')
      .filter((s) => s && !s.startsWith(':') && !s.startsWith('{') && s !== 'new')
      .map((s) => s.toLowerCase())

  const routeSegments = new Set(segmentsOf(screen.route))
  // A screen at "/" has no segments to match, so fall back to the screen name.
  if (routeSegments.size === 0) {
    for (const word of screen.name.toLowerCase().split(/[^a-z]+/).filter(Boolean)) routeSegments.add(word)
  }

  const scored = appSpec.endpoints
    .map((endpoint) => {
      const endpointSegments = segmentsOf(endpoint.path)
      let score = 0
      for (const segment of endpointSegments) {
        // Tolerate plural/singular differences between a route and a path.
        for (const routeSegment of routeSegments) {
          if (segment === routeSegment || segment === `${routeSegment}s` || `${segment}s` === routeSegment) score += 2
        }
      }
      if (score === 0) return null

      const takesId = /[{:]/.test(endpoint.path)
      const routeTakesId = /[{:]/.test(screen.route)

      if (screen.type === 'form' && endpoint.method === 'POST') score += 3
      if (screen.type === 'detail' && endpoint.method === 'GET' && takesId) score += 3
      if ((screen.type === 'list' || screen.type === 'dashboard') && endpoint.method === 'GET' && !takesId) score += 3
      if (routeTakesId === takesId) score += 1

      return { operationId: endpoint.operationId, score }
    })
    .filter((x): x is { operationId: string; score: number } => x !== null)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) return []

  // Keep everything within reach of the best match rather than only the top one,
  // so a detail screen still gets its delete alongside its read.
  const best = scored[0]!.score
  return scored.filter((s) => s.score >= best - 2).map((s) => s.operationId)
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

const MAX_REPAIRS = 2

async function generateScreen(
  screen: ScreenPlan,
  appSpec: AppSpec,
  plan: AppPlan,
  allowedApiFunctions: Set<string>,
  screenFileNames: Set<string>,
  log: (message: string, level?: 'info' | 'warn' | 'error') => void,
): Promise<{ content: string; violations: Violation[] }> {
  // A screen given endpoints must use them; one given none may legitimately be
  // a pure display screen fed by the previous step.
  /*
   * An operation whose body the flow module builds is reached through its
   * sender, never directly — so that is the call this screen is held to.
   */
  const boundOperations = new Set(plan.flow?.requests.map((r) => r.operationId) ?? [])
  const callName = (id: string) => (boundOperations.has(id) ? senderName(id) : id)
  const expected = screen.endpointIds.filter((id) => allowedApiFunctions.has(id))

  /*
   * Only a screen that is *supposed* to receive data is held to the stricter
   * rule. When the documents describe no API at all, every screen has no
   * endpoints and static content is exactly right — demanding useLocation()
   * there would refuse to build a perfectly good form or landing page.
   */
  const shouldReceiveData = expected.length === 0 && Boolean(screen.incomingType)

  // Endpoints whose success response carries a payload worth showing.
  const withPayloads = expected.map((id) => {
    const endpoint = appSpec.endpoints.find((e) => e.operationId === id)
    const success = endpoint?.responses.find((r) => /^2\d\d$/.test(r.status))
    return { name: callName(id), returnsValue: Boolean(success?.typeName) && success?.typeName !== 'void' }
  })
  const capturesFields = Boolean(
    plan.flow && coveredSpec(screen, appSpec.documentedScreens) && screen.formType && !screen.demo,
  )
  const componentName = screenComponentName(screen)
  const prompt = codegenUser(screen, appSpec, plan, componentName)

  let content = unfence(
    await chat({ system: CODEGEN_SYSTEM, user: prompt, temperature: 0.35, maxTokens: 6000 }),
  )

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    const violations = [
      ...(await checkSyntax(content, `${componentName}.tsx`)),
      ...checkGrounding(content, allowedApiFunctions),
      ...checkImports(content, screenFileNames),
      ...checkComponentProps(content, COMPONENT_PROPS, UNIVERSAL_PROPS),
      ...checkUndefinedComponents(content),
      ...checkHookOrder(content),
      ...checkResponsesRendered(content, withPayloads),
      ...(screen.demo && !/<DemoNotice\b/.test(content)
        ? [
            {
              kind: 'grounding' as const,
              message:
                'renders sample data without <DemoNotice />. Import it from ' +
                "'../components/DemoNotice' and place it above the data, so nobody " +
                'mistakes invented values for real ones.',
            },
          ]
        : []),
      ...checkUsesApi(content, expected.map(callName)),
      ...(plan.flow
        ? checkFlowUse(content, {
            boundOperations: expected.filter((id) => boundOperations.has(id)),
            capturesFields,
            senderFor: senderName,
          })
        : []),
      ...(screen.demo ? [] : checkFabricatedData(content, shouldReceiveData)),
      ...checkUsesReadHelpers(content, screen.incomingType === UNDOCUMENTED_RESPONSE),
    ]

    if (violations.length === 0) return { content, violations: [] }
    if (attempt === MAX_REPAIRS) {
      log(`${screen.name}: ${violations.length} issue(s) remain after repair`, 'warn')
      return { content, violations }
    }

    log(`${screen.name}: repairing ${violations.length} issue(s)`, 'warn')
    content = unfence(
      await chat({
        system: REPAIR_SYSTEM,
        user: `The file below failed validation.

PROBLEMS
${describeViolations(violations)}

ORIGINAL REQUIREMENTS
${prompt}

FILE
${content}`,
        temperature: 0.15,
        maxTokens: 6000,
      }),
    )
  }

  return { content, violations: [] }
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

export interface GenerateResult {
  plan: AppPlan
  files: GeneratedFile[]
  violations: { screen: string; violations: Violation[] }[]
  /** Compiler errors still present after repair, if any. */
  typeErrors: TypeError[]
  compiles: boolean
  /** Problems in the screen graph that could not be corrected automatically. */
  flowIssues: FlowIssue[]
}

const MAX_TYPE_REPAIRS = 2

/**
 * Compiles the generated project and repairs what the compiler objects to.
 *
 * The per-screen checks catch what they were written to catch; this catches
 * everything else, because it is the same compiler the exported project runs.
 * Errors come back with the offending line attached, which is a far stronger
 * signal for repair than any rule could produce.
 */
async function compileAndRepair(
  files: GeneratedFile[],
  appSpec: AppSpec,
  plan: AppPlan,
  log: (message: string, level?: 'info' | 'warn' | 'error') => void,
): Promise<{ typeErrors: TypeError[]; compiles: boolean }> {
  for (let round = 0; round <= MAX_TYPE_REPAIRS; round++) {
    const result = await typeCheck(files, (m) => log(m))

    if (result.unavailable) {
      log(`Skipped the compile check — ${result.unavailable}`, 'warn')
      return { typeErrors: [], compiles: false }
    }
    if (result.ok) {
      log(round === 0 ? 'Project compiles' : `Project compiles after ${round} repair round(s)`)
      return { typeErrors: [], compiles: true }
    }

    const grouped = byFile(result.errors)

    // A compile error in an emitted file is our bug, not the model's; asking it
    // to patch the component kit would make things worse.
    const ours = [...grouped.keys()].filter((f) => !f.startsWith('src/screens/'))
    if (ours.length > 0) {
      log(`Compile errors in generated infrastructure (${ours.join(', ')}) — please report this`, 'error')
    }

    const screenFiles = [...grouped.entries()].filter(([f]) => f.startsWith('src/screens/'))
    if (screenFiles.length === 0 || round === MAX_TYPE_REPAIRS) {
      log(`${result.errors.length} compile error(s) remain`, 'warn')
      return { typeErrors: result.errors, compiles: false }
    }

    log(`${result.errors.length} compile error(s) in ${screenFiles.length} screen(s) — repairing`, 'warn')

    for (const [filePath, errors] of screenFiles) {
      const file = files.find((f) => f.path === filePath)
      if (!file) continue

      const screen = plan.screens.find((s) => screenFilePath(s) === filePath)
      const componentName = screen ? screenComponentName(screen) : path.basename(filePath, '.tsx')

      const repaired = unfence(
        await chat({
          system: REPAIR_SYSTEM,
          user: `The TypeScript compiler rejected this file.

COMPILER ERRORS
${describeErrors(errors, file.content)}

${screen ? codegenUser(screen, appSpec, plan, componentName) : ''}

FILE
${file.content}`,
          temperature: 0.1,
          maxTokens: 6000,
        }),
      )

      if (repaired.trim()) file.content = repaired
    }
  }

  return { typeErrors: [], compiles: true }
}

/**
 * Another pass at the screens that already exist.
 *
 * Regenerating throws away a working app to re-roll the dice on all of it;
 * usually one screen is wrong and the rest is fine. This re-runs the checks and
 * the compiler against the stored files and repairs only what fails — and takes
 * an optional note, because the failure that matters most is the one only the
 * person watching the preview can see. A screen that compiles cannot be
 * diagnosed by the compiler, so "Total Refund Amount is undefined" is the only
 * thing that makes that screen fixable.
 */
export async function repairApp(
  rawAppSpec: AppSpec,
  plan: AppPlan,
  files: GeneratedFile[],
  options: { note?: string; mode?: 'fix' | 'refine'; screenId?: string } = {},
  hooks: GenerateHooks = {},
): Promise<{ files: GeneratedFile[]; typeErrors: TypeError[]; compiles: boolean }> {
  const log = hooks.log ?? (() => {})
  const appSpec = withSafeTypeNames(rawAppSpec)
  const note = options.note?.trim()
  const mode = options.mode ?? 'fix'
  // A chosen screen is the only one the note may change.
  const chosen = options.screenId ? plan.screens.find((s) => s.id === options.screenId) : undefined
  if (options.screenId && !chosen) throw new Error('That screen is no longer in the app. Reload and pick again.')

  const screenFiles = files.filter(
    (f) => f.path.startsWith('src/screens/') && (!chosen || f.path === screenFilePath(chosen)),
  )
  if (screenFiles.length === 0) {
    log('No generated screens to fix yet — generate the app first.', 'warn')
    return { files, typeErrors: [], compiles: false }
  }

  /*
   * With a note and no chosen screen, every screen gets a look: the person
   * describing a broken amount rarely knows which file renders it, and
   * guessing wrong here means the one thing they asked for is the one thing
   * left untouched. When they did choose, only that screen is touched.
   */
  if (note) {
    const refining = mode === 'refine'
    log(`${refining ? 'Refining' : 'Looking at'} ${chosen ? chosen.name : `${screenFiles.length} screen(s)`}: ${note}`)
    const scope = chosen
      ? 'The person chose this screen, so make the change here.'
      : 'Return it unchanged if the instruction is about a different screen.'
    const fixScope = chosen
      ? 'Fix it in this file.'
      : 'Fix it if this file is the cause, and return the file unchanged if it is not.'

    for (const file of screenFiles) {
      const screen = plan.screens.find((s) => screenFilePath(s) === file.path)
      if (!screen) continue

      const componentName = screenComponentName(screen)
      const revised = unfence(
        await chat({
          system: refining ? REFINE_SYSTEM : REPAIR_SYSTEM,
          user: refining
            ? `Revise this screen as asked. ${scope}

INSTRUCTION
${note}

${codegenUser(screen, appSpec, plan, componentName)}

FILE
${file.content}`
            : `Someone using this screen reported a problem. ${fixScope}

REPORTED PROBLEM
${note}

${codegenUser(screen, appSpec, plan, componentName)}

FILE
${file.content}`,
          // Repair wants the one right answer; refinement is a design request
          // and a little room produces something considered rather than literal.
          temperature: refining ? 0.4 : 0.1,
          maxTokens: 6000,
        }),
      )

      if (revised.trim() && revised.trim() !== file.content.trim()) {
        file.content = revised
        log(`${screen.name}: revised`)
        hooks.onFile?.(file)
      }
    }
  }

  log('Compiling the project')
  const { typeErrors, compiles } = await compileAndRepair(files, appSpec, plan, log)
  for (const file of screenFiles) hooks.onFile?.(file)

  return { files, typeErrors, compiles }
}

export async function generate(
  rawAppSpec: AppSpec,
  ctx: EmitContext,
  hooks: GenerateHooks = {},
  existingPlan?: AppPlan,
  connection?: ConnectionSettings,
  sampleData = false,
  documents: SpecDocument[] = [],
): Promise<GenerateResult> {
  const log = hooks.log ?? (() => {})

  /*
   * Ask the API what it returns before deciding what the screens will read.
   *
   * This runs before normalisation and before planning because everything
   * downstream is built on the entity shapes: the types the screens import, the
   * access paths handed to the model, the columns a table gets. Correcting them
   * afterwards would mean regenerating everything that was built on the guess.
   */
  if (connection && config.analysis.probeEndpoints) {
    const report = await probeEndpoints(rawAppSpec, connection, log)
    if (report.probed.length > 0) {
      log(
        `Read ${report.probed.length} endpoint(s) from the live API` +
          (report.corrected.length > 0
            ? `; ${report.corrected.length} had field names the documents got wrong`
            : ''),
      )
    }
  }

  // One normalisation for the whole run: the planner, the emitters and the
  // codegen prompt must all refer to a type by the same name.
  const appSpec = withSafeTypeNames(rawAppSpec)

  let plan = existingPlan
  if (!plan) {
    log('Designing the screen architecture')
    plan = await planScreens(appSpec, ctx, log, sampleData)
    log(`Planned ${plan.screens.length} screen(s): ${plan.screens.map((s) => s.name).join(', ')}`)
  }
  // Also on a reused plan: the theme may have been uploaded or removed since.
  applyBrand(plan, ctx.brand)
  if (ctx.accent) plan.theme.accent = ctx.accent
  if (ctx.rootSize) plan.theme.rootSize = ctx.rootSize
  for (const screen of plan.screens) {
    const look = ctx.screenLooks?.[screen.name]
    if (look) screen.look = look
  }
  if (ctx.brand) log(`Applying the brand theme from ${ctx.brand.sources.join(', ')}`)
  /*
   * Check the screen graph before writing any code. A screen nothing supplies
   * data to compiles perfectly and shows an empty state for ever, so the
   * compiler cannot catch it — but the plan can be read directly.
   */
  const allIssues = validatePlan(plan, appSpec)
  const flowIssues = repairPlan(plan, appSpec, allIssues)

  for (const issue of allIssues) {
    if (!issue.repaired) continue
    log(`${issue.screen}: ${issue.message} — ${issue.repaired}`, 'warn')
  }
  for (const issue of flowIssues) {
    log(
      `${issue.screen ? `${issue.screen}: ` : ''}${issue.message}`,
      issue.severity === 'error' ? 'error' : 'warn',
    )
  }
  if (allIssues.length === 0) log('Screen flow checks out')

  /*
   * Decide, once and in code, how what the user enters becomes each request.
   *
   * Left to each screen, the submitting one held only its own step's values
   * and filled the rest of the body with the documented example's test person.
   * A plan from before this existed gets it now, so regenerating fixes it.
   */
  if (!plan.flow) {
    log('Mapping the form onto the request bodies')
    plan.flow = await bindFlow(appSpec, plan, documents, log)
  }

  hooks.onPlan?.(plan)

  log('Writing the API client and component kit')
  const files = emitFoundation(appSpec, plan, ctx)
  for (const file of files) hooks.onFile?.(file)

  const allowedApiFunctions = new Set(appSpec.endpoints.map((e) => e.operationId))
  const screenFileNames = new Set(plan.screens.map((s) => `${screenComponentName(s)}`))
  const violations: GenerateResult['violations'] = []

  // Sequential rather than parallel: screen generation is the token-heavy part,
  // and running them one at a time keeps well clear of deployment rate limits
  // while letting the UI reveal each screen as it lands.
  for (const screen of plan.screens) {
    hooks.onScreenStart?.(screen)
    log(`Generating ${screen.name}`)

    const result = await generateScreen(
      screen,
      appSpec,
      plan,
      allowedApiFunctions,
      screenFileNames,
      log,
    )

    const file: GeneratedFile = {
      path: screenFilePath(screen),
      content: result.content,
      origin: 'model',
      screenId: screen.id,
    }
    files.push(file)
    hooks.onFile?.(file)
    hooks.onScreenDone?.(screen, file.path)

    if (result.violations.length > 0) violations.push({ screen: screen.name, violations: result.violations })
  }

  log('Compiling the project')
  const { typeErrors, compiles } = await compileAndRepair(files, appSpec, plan, log)

  /*
   * Re-check the screens the compile stage rewrote. Reporting findings from
   * before that ran tells the user about problems the pipeline already fixed,
   * which is its own kind of wrong answer.
   */
  const finalViolations: GenerateResult['violations'] = []
  for (const { screen } of violations) {
    const plannedScreen = plan.screens.find((s) => s.name === screen)
    const file = plannedScreen ? files.find((f) => f.path === screenFilePath(plannedScreen)) : undefined
    if (!file || !plannedScreen) continue

    const remaining = [
      ...checkGrounding(file.content, allowedApiFunctions),
      ...checkComponentProps(file.content, COMPONENT_PROPS, UNIVERSAL_PROPS),
      ...checkUndefinedComponents(file.content),
      ...checkHookOrder(file.content),
      ...(plannedScreen.demo && !/<DemoNotice\b/.test(file.content)
        ? [{ kind: 'grounding' as const, message: 'renders sample data without <DemoNotice />.' }]
        : []),
    ]
    if (remaining.length > 0) finalViolations.push({ screen, violations: remaining })
  }

  return { plan, files, violations: finalViolations, typeErrors, compiles, flowIssues }
}
