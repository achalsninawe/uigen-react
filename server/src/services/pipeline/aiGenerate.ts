import { chat, chatJson } from '../azure.js'
import { designSchema, type DesignResult } from '../../schemas.js'
import { BUILD_SYSTEM, DESIGN_SYSTEM, buildUser, designUser, type BuildContext } from '../../prompts/aiBuild.js'
import { REFINE_SYSTEM, REPAIR_SYSTEM } from '../../prompts/codegen.js'
import { applyBrand } from '../brand.js'
import { emitFoundation, screenComponentName, screenFilePath, type EmitContext } from '../emit/index.js'
import { withSafeTypeNames } from '../emit/normalise.js'
import { emitTypes } from '../emit/types.js'
import { DEMO_NOTICE } from '../emit/demo.js'
import { COMPONENT_PROPS, UNIVERSAL_PROPS } from '../emit/uikit.js'
import {
  checkComponentProps,
  checkGrounding,
  checkHookOrder,
  checkImports,
  checkSyntax,
  checkUndefinedComponents,
  describeViolations,
  type Violation,
} from './validate.js'
import { byFile, describeErrors, typeCheck, type TypeError } from './typecheck.js'
import { collectSamples } from './samples.js'
import type { GenerateHooks, GenerateResult } from './generate.js'
import type { AppPlan, AppSpec, ConnectionSettings, GeneratedFile, ScreenPlan, SpecDocument } from '../../types.js'

/*
 * The AI builder.
 *
 * The model reads the documents, the real API functions and types, and real
 * responses, then designs the whole app and writes every screen with that same
 * full picture. Code keeps only the guarantees: the API client and the UI kit
 * are emitted, never written by the model, and the result must compile.
 */

type Log = (message: string, level?: 'info' | 'warn' | 'error') => void

const MAX_REPAIRS = 2
const MAX_TYPE_REPAIRS = 2
/** Parallel screen builds; enough to be quick, few enough to stay clear of rate limits. */
const CONCURRENCY = 3
/** Stands in for a flow type the compiler rejects, so one bad type cannot sink the app. */
const FALLBACK_STATE = 'Record<string, unknown>'

function unfence(raw: string): string {
  const fenced = raw.match(/```(?:tsx?|jsx?|typescript)?\s*\n([\s\S]*?)```/)
  return (fenced?.[1] ?? raw).trim()
}

const slug = (value: string, fallback: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback

async function inBatches<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(run))
}

/* ------------------------------------------------------------------ */
/* Design → plan                                                       */
/* ------------------------------------------------------------------ */

/** Exported for verification. */
export function toPlan(design: DesignResult, appSpec: AppSpec, sampleData: boolean): AppPlan {
  const validIds = new Set(appSpec.endpoints.map((e) => e.operationId))
  const usedIds = new Set<string>()
  const usedRoutes = new Set<string>()

  const screens: ScreenPlan[] = design.screens.map((raw, index) => {
    let id = slug(raw.name, `screen-${index + 1}`)
    while (usedIds.has(id)) id = `${id}-${index + 1}`
    usedIds.add(id)

    let route = raw.route.trim().startsWith('/') ? raw.route.trim() : `/${raw.route.trim()}`
    while (usedRoutes.has(route)) route = `${route}-${index + 1}`
    usedRoutes.add(route)

    return {
      id,
      name: raw.name,
      route,
      type: raw.type,
      purpose: raw.purpose,
      icon: raw.icon,
      sections: [],
      endpointIds: [...new Set(raw.calls.filter((c) => validIds.has(c)))],
      showInNav: raw.showInNav,
      ...(raw.hero?.headline ? { hero: raw.hero } : {}),
      ...(raw.aside?.title ? { aside: raw.aside } : {}),
      brief: raw.brief,
      receives: raw.receives.replace(/\s+/g, ' ').trim(),
      navigatesTo: raw.navigatesTo,
    }
  })

  // The app opens on "/", so something must be mounted there.
  if (!screens.some((s) => s.route === '/')) screens[0]!.route = '/'

  if (design.journey && screens.length > 1) {
    screens.forEach((s, i) => (s.step = { index: i + 1, total: screens.length }))
  }

  return {
    screens,
    navigation: screens.filter((s) => s.showInNav).map((s) => ({ screenId: s.id, label: s.name, icon: s.icon })),
    theme: design.theme,
    designNotes: design.designNotes,
    sampleData,
    builder: 'ai',
  }
}

/* ------------------------------------------------------------------ */
/* src/lib/flow.ts — the typed navigation contract                     */
/* ------------------------------------------------------------------ */

/**
 * One go-to hook per screen and one state hook per screen that receives
 * something, both typed from the design. Sender and receiver compile against
 * the same type, so "the next screen expects a field this one never sent" is a
 * compile error with a line number rather than a blank page.
 */
export function emitFlow(plan: AppPlan, overrides: Map<string, string> = new Map()): string {
  const lines = [
    `import { useLocation, useNavigate } from 'react-router-dom'`,
    `import type * as T from './types'`,
    '',
    '/* Generated by Spec2UI from the app design. Screens navigate only through these. */',
    '',
  ]

  for (const screen of plan.screens) {
    const name = screenComponentName(screen)
    const stateType = overrides.get(name) ?? screen.receives
    const params = [...screen.route.matchAll(/[:{]([A-Za-z0-9_]+)\}?/g)].map((m) => m[1]!)
    const routeExpr = params.length
      ? '`' + screen.route.replace(/[:{]([A-Za-z0-9_]+)\}?/g, (_m, p: string) => '${encodeURIComponent(String(params.' + p + '))}') + '`'
      : `'${screen.route}'`
    const args = [
      ...(params.length ? [`params: { ${params.map((p) => `${p}: string | number`).join('; ')} }`] : []),
      ...(stateType ? [`state: ${name}State`] : []),
    ].join(', ')

    if (stateType) {
      lines.push(`export type ${name}State = ${stateType}`)
      lines.push(
        `export function use${name}State(): ${name}State | undefined {`,
        `  return (useLocation().state ?? undefined) as ${name}State | undefined`,
        `}`,
      )
    }
    lines.push(
      `export function useGoTo${name}() {`,
      `  const navigate = useNavigate()`,
      `  return (${args}) => navigate(${routeExpr}${stateType ? ', { state }' : ''})`,
      `}`,
      '',
    )
  }
  return lines.join('\n')
}

/* void import guard: T may go unused when no screen receives anything */
function withTypesUse(source: string): string {
  return /\bT\./.test(source) ? source : source.replace(`import type * as T from './types'\n`, '')
}

/**
 * Compiles the foundation with placeholder screens, and settles any flow type
 * the compiler rejects before a single screen is written against it.
 */
async function settleFlow(files: GeneratedFile[], plan: AppPlan, log: Log): Promise<string> {
  const overrides = new Map<string, string>()

  for (let round = 0; round < 2; round++) {
    const source = withTypesUse(emitFlow(plan, overrides))
    const stubs: GeneratedFile[] = plan.screens.map((s) => ({
      path: screenFilePath(s),
      content: `export default function ${screenComponentName(s)}() {\n  return null\n}\n`,
      origin: 'emitted',
    }))
    const result = await typeCheck([...files, { path: 'src/lib/flow.ts', content: source, origin: 'emitted' }, ...stubs])
    if (result.unavailable || result.ok) return source

    const flowErrors = result.errors.filter((e) => e.file === 'src/lib/flow.ts')
    const others = result.errors.filter((e) => e.file !== 'src/lib/flow.ts')
    if (others.length > 0) {
      log(`Compile errors in generated infrastructure (${[...byFile(others).keys()].join(', ')}) — please report this`, 'error')
    }
    if (flowErrors.length === 0) return source

    // Map each error to the state type declared on its line.
    const sourceLines = source.split('\n')
    for (const error of flowErrors) {
      const declared = /^export type (\w+)State = /.exec(sourceLines[error.line - 1] ?? '')?.[1]
      if (declared && !overrides.has(declared)) {
        overrides.set(declared, FALLBACK_STATE)
        log(`${declared}: the designed state type did not compile (${error.message}) — using a plain record`, 'warn')
      }
    }
  }
  return withTypesUse(emitFlow(plan, overrides))
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

/** Navigation that bypasses the typed helpers cannot be checked by the compiler. */
export function checkUsesFlow(code: string): Violation[] {
  return /navigate\s*\([^)]*\bstate\s*:/.test(code) || /location\.state/.test(code)
    ? [
        {
          kind: 'grounding',
          message:
            "moves data between screens by hand. Use the useGoTo… helpers and this screen's use…State hook from '../lib/flow' instead of navigate(..., { state }) or location.state.",
        },
      ]
    : []
}

async function buildScreen(
  screen: ScreenPlan,
  ctx: BuildContext,
  allowed: Set<string>,
  screenNames: Set<string>,
  log: Log,
): Promise<{ content: string; violations: Violation[] }> {
  const componentName = screenComponentName(screen)
  const prompt = buildUser(screen, ctx, componentName)
  let content = unfence(await chat({ system: BUILD_SYSTEM, user: prompt, temperature: 0.3, maxTokens: 8000 }))

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    const violations = [
      ...(await checkSyntax(content, `${componentName}.tsx`)),
      ...checkGrounding(content, allowed),
      ...checkImports(content, screenNames),
      ...checkComponentProps(content, COMPONENT_PROPS, UNIVERSAL_PROPS),
      ...checkUndefinedComponents(content),
      ...checkHookOrder(content),
      ...checkUsesFlow(content),
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
        user: `The file below failed validation.\n\nPROBLEMS\n${describeViolations(violations)}\n\nORIGINAL REQUIREMENTS\n${prompt}\n\nFILE\n${content}`,
        temperature: 0.15,
        maxTokens: 8000,
      }),
    )
  }
  return { content, violations: [] }
}

async function compileAndRepair(
  files: GeneratedFile[],
  plan: AppPlan,
  ctx: BuildContext,
  log: Log,
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
    const ours = [...grouped.keys()].filter((f) => !f.startsWith('src/screens/'))
    if (ours.length > 0) log(`Compile errors in generated infrastructure (${ours.join(', ')}) — please report this`, 'error')

    const screenFiles = [...grouped.entries()].filter(([f]) => f.startsWith('src/screens/'))
    if (screenFiles.length === 0 || round === MAX_TYPE_REPAIRS) {
      log(`${result.errors.length} compile error(s) remain`, 'warn')
      return { typeErrors: result.errors, compiles: false }
    }

    log(`${result.errors.length} compile error(s) in ${screenFiles.length} screen(s) — repairing`, 'warn')
    await inBatches(screenFiles, CONCURRENCY, async ([filePath, errors]) => {
      const file = files.find((f) => f.path === filePath)
      const screen = plan.screens.find((s) => screenFilePath(s) === filePath)
      if (!file || !screen) return
      const repaired = unfence(
        await chat({
          system: REPAIR_SYSTEM,
          user: `The TypeScript compiler rejected this file.\n\nCOMPILER ERRORS\n${describeErrors(errors, file.content)}\n\n${buildUser(screen, ctx, screenComponentName(screen))}\n\nFILE\n${file.content}`,
          temperature: 0.1,
          maxTokens: 8000,
        }),
      )
      if (repaired.trim()) file.content = repaired
    })
  }
  return { typeErrors: [], compiles: true }
}

function buildContext(
  appSpec: AppSpec,
  documents: SpecDocument[],
  plan: AppPlan,
  files: GeneratedFile[],
): BuildContext {
  return {
    appSpec,
    documents,
    screens: plan.screens,
    designNotes: plan.designNotes,
    typesSource: files.find((f) => f.path === 'src/lib/types.ts')?.content ?? '',
    flowSource: files.find((f) => f.path === 'src/lib/flow.ts')?.content ?? '',
    sampleData: plan.sampleData === true,
  }
}

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

export async function aiGenerate(
  rawAppSpec: AppSpec,
  documents: SpecDocument[],
  ctx: EmitContext,
  hooks: GenerateHooks = {},
  connection?: ConnectionSettings,
  sampleData = false,
): Promise<GenerateResult> {
  const log = hooks.log ?? (() => {})

  // Real responses first: everything after is built on these shapes.
  if (connection) await collectSamples(rawAppSpec, documents, connection, log)

  const appSpec = withSafeTypeNames(rawAppSpec)

  log('Reading the documents and designing the app')
  const design = await chatJson({
    system: DESIGN_SYSTEM,
    user: designUser(appSpec, documents, emitTypes(appSpec), sampleData),
    schema: designSchema,
    temperature: 0.3,
    maxTokens: 12000,
  })
  const plan = toPlan(design, appSpec, sampleData)
  applyBrand(plan, ctx.brand)
  if (ctx.accent) plan.theme.accent = ctx.accent
  if (ctx.rootSize) plan.theme.rootSize = ctx.rootSize
  for (const screen of plan.screens) {
    const look = ctx.screenLooks?.[screen.name]
    if (look) screen.look = look
  }
  if (ctx.brand) log(`Applying the brand theme from ${ctx.brand.sources.join(', ')}`)
  log(`Designed ${plan.screens.length} screen(s): ${plan.screens.map((s) => s.name).join(', ')}`)
  hooks.onPlan?.(plan)

  log('Writing the API client, component kit and screen flow')
  const files = emitFoundation(appSpec, plan, ctx)
  if (sampleData) files.push({ path: 'src/components/DemoNotice.tsx', content: DEMO_NOTICE, origin: 'emitted' })
  files.push({ path: 'src/lib/flow.ts', content: await settleFlow(files, plan, log), origin: 'emitted' })
  for (const file of files) hooks.onFile?.(file)

  const build = buildContext(appSpec, documents, plan, files)
  const allowed = new Set(appSpec.endpoints.map((e) => e.operationId))
  const screenNames = new Set(plan.screens.map((s) => screenComponentName(s)))
  const violations: GenerateResult['violations'] = []
  const built = new Map<string, GeneratedFile>()

  await inBatches(plan.screens, CONCURRENCY, async (screen) => {
    hooks.onScreenStart?.(screen)
    log(`Building ${screen.name}`)
    const result = await buildScreen(screen, build, allowed, screenNames, log)
    const file: GeneratedFile = { path: screenFilePath(screen), content: result.content, origin: 'model', screenId: screen.id }
    built.set(screen.id, file)
    hooks.onFile?.(file)
    hooks.onScreenDone?.(screen, file.path)
    if (result.violations.length > 0) violations.push({ screen: screen.name, violations: result.violations })
  })
  // Keep the files in plan order, whichever finished first.
  for (const screen of plan.screens) files.push(built.get(screen.id)!)

  log('Compiling the project')
  const { typeErrors, compiles } = await compileAndRepair(files, plan, build, log)

  return { plan, files, violations, typeErrors, compiles, flowIssues: [] }
}

/** "Fix or refine" for an app the AI builder made, with the same full context. */
export async function aiRepairApp(
  rawAppSpec: AppSpec,
  documents: SpecDocument[],
  plan: AppPlan,
  files: GeneratedFile[],
  options: { note?: string; mode?: 'fix' | 'refine'; screenId?: string } = {},
  hooks: GenerateHooks = {},
): Promise<{ files: GeneratedFile[]; typeErrors: TypeError[]; compiles: boolean }> {
  const log = hooks.log ?? (() => {})
  const appSpec = withSafeTypeNames(rawAppSpec)
  const note = options.note?.trim()
  const mode = options.mode ?? 'fix'
  const build = buildContext(appSpec, documents, plan, files)
  // A chosen screen is the only one the note may change.
  const chosen = options.screenId ? plan.screens.find((s) => s.id === options.screenId) : undefined
  if (options.screenId && !chosen) throw new Error('That screen is no longer in the app. Reload and pick again.')

  if (note) {
    const targets = (chosen ? [chosen] : plan.screens)
      .map((screen) => ({ screen, file: files.find((f) => f.path === screenFilePath(screen)) }))
      .filter((t): t is { screen: ScreenPlan; file: GeneratedFile } => Boolean(t.file))

    const what = chosen ? chosen.name : `${targets.length} screen(s)`
    log(mode === 'refine' ? `Refining ${what}` : `Fixing ${what}`)
    await inBatches(targets, CONCURRENCY, async ({ screen, file }) => {
      const requirements = buildUser(screen, build, screenComponentName(screen))
      const revised = unfence(
        await chat({
          system: mode === 'refine' ? REFINE_SYSTEM : REPAIR_SYSTEM,
          user:
            `${mode === 'refine' ? 'INSTRUCTION' : 'REPORTED PROBLEM'}\n${note}\n\n` +
            (chosen
              ? 'The person chose this screen, so make the change here.\n\n'
              : 'If this file is not affected, return it unchanged.\n\n') +
            `REQUIREMENTS\n${requirements}\n\nFILE\n${file.content}`,
          temperature: mode === 'refine' ? 0.4 : 0.1,
          maxTokens: 8000,
        }),
      )
      if (revised.trim() && revised !== file.content) {
        file.content = revised
        hooks.onFile?.(file)
        log(`${screen.name}: updated`)
      }
    })
  }

  const { typeErrors, compiles } = await compileAndRepair(files, plan, build, log)
  for (const file of files) if (file.path.startsWith('src/screens/')) hooks.onFile?.(file)
  return { files, typeErrors, compiles }
}
