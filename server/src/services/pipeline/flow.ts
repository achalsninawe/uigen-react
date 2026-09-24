import type { AppPlan, AppSpec, ScreenPlan } from '../../types.js'

/**
 * Checks the screen graph before a line of code is written.
 *
 * The compile gate answers "does this build?". It cannot answer "does this
 * work?" — a screen that renders an empty state for ever because nothing hands
 * it data is perfectly valid TypeScript. These are the questions that can be
 * settled by looking at the plan alone, deterministically, in milliseconds:
 * is every screen reachable, does every screen that shows data have a supplier,
 * does every button lead somewhere real.
 *
 * Cheap enough to run always, and it catches a whole class of failure one stage
 * earlier than the compiler.
 */

export interface FlowIssue {
  severity: 'error' | 'warning'
  screen?: string
  message: string
  /** Set when the pipeline corrected it automatically. */
  repaired?: string
}

export interface FlowReport {
  issues: FlowIssue[]
  get ok(): boolean
}

/** A screen that neither calls an API nor receives data shows nothing real. */
function hasDataSource(screen: ScreenPlan): boolean {
  // Sample data counts: the screen shows something, and says what it is. So
  // does an API-only screen that states no API feeds it — already reported.
  return (
    screen.endpointIds.length > 0 ||
    Boolean(screen.incomingType) ||
    Boolean(screen.demo) ||
    Boolean(screen.unsourced)
  )
}

/**
 * A screen whose only job is collecting input is legitimately sourceless — a
 * search box has nothing to display until the user acts.
 */
function isInputOnly(screen: ScreenPlan): boolean {
  return screen.type === 'form' || screen.type === 'auth' || screen.type === 'search'
}

export function validatePlan(plan: AppPlan, appSpec: AppSpec): FlowIssue[] {
  const issues: FlowIssue[] = []
  const routes = new Set(plan.screens.map((s) => s.route))
  const byName = new Map(plan.screens.map((s) => [s.name.toLowerCase().trim(), s]))

  /* ---- a landing page must exist and be unique ---- */
  const landings = plan.screens.filter((s) => s.route === '/')
  if (landings.length === 0) {
    issues.push({ severity: 'error', message: 'No screen is mounted at "/", so the app opens on nothing.' })
  } else if (landings.length > 1) {
    issues.push({
      severity: 'error',
      message: `${landings.length} screens claim "/": ${landings.map((s) => s.name).join(', ')}. Only the first is reachable.`,
    })
  }

  /* ---- every screen must be reachable ---- */
  const reachable = new Set<string>()
  const queue = landings.map((s) => s.id)
  for (const screen of plan.screens) {
    if (screen.showInNav) queue.push(screen.id)
  }

  const documentedTargets = new Map<string, string[]>()
  const link = (fromId: string, toId: string) =>
    documentedTargets.set(fromId, [...(documentedTargets.get(fromId) ?? []), toId])

  for (const doc of appSpec.documentedScreens) {
    const from = byName.get(doc.name.toLowerCase().trim())
    if (!from) continue

    const to = doc.navigatesTo ? byName.get(doc.navigatesTo.toLowerCase().trim()) : undefined
    if (to) link(from.id, to.id)

    // A button with its own destination makes that screen reachable too, which
    // is how a Save / Next / Exit screen reaches more than one place.
    for (const action of doc.actions) {
      const target = action.navigatesTo
        ? byName.get(action.navigatesTo.toLowerCase().trim())
        : undefined
      if (target) link(from.id, target.id)
    }
  }
  // A screen that names its supplier is reachable from it by definition.
  for (const screen of plan.screens) {
    const supplier = screen.incomingFrom ? byName.get(screen.incomingFrom.toLowerCase().trim()) : undefined
    if (supplier) {
      documentedTargets.set(supplier.id, [...(documentedTargets.get(supplier.id) ?? []), screen.id])
    }
  }

  while (queue.length > 0) {
    const id = queue.pop()!
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const next of documentedTargets.get(id) ?? []) queue.push(next)
  }

  for (const screen of plan.screens) {
    if (!reachable.has(screen.id)) {
      issues.push({
        severity: 'warning',
        screen: screen.name,
        message: `Not reachable — it is not in the navigation and no screen links to ${screen.route}.`,
      })
    }
  }

  /* ---- every screen that displays data needs a supplier ---- */
  for (const screen of plan.screens) {
    if (hasDataSource(screen) || isInputOnly(screen)) continue
    issues.push({
      severity: 'error',
      screen: screen.name,
      message:
        'Has no endpoint of its own and receives nothing from another screen, ' +
        'so it can only ever render an empty state.',
    })
  }

  /* ---- a supplier must actually have something to supply ---- */
  for (const screen of plan.screens) {
    if (!screen.incomingType) continue
    const supplier = screen.incomingFrom ? byName.get(screen.incomingFrom.toLowerCase().trim()) : undefined

    if (!supplier) {
      issues.push({
        severity: 'error',
        screen: screen.name,
        message: `Expects data from "${screen.incomingFrom}", which is not a screen in this app.`,
      })
    } else if (supplier.endpointIds.length === 0 && !supplier.incomingType) {
      issues.push({
        severity: 'error',
        screen: screen.name,
        message: `Expects data from ${supplier.name}, but that screen fetches nothing and receives nothing.`,
      })
    }
  }

  /* ---- documented navigation must point at a real route ---- */
  for (const doc of appSpec.documentedScreens) {
    if (!doc.navigatesTo || doc.navigatesTo.toLowerCase().includes('no further')) continue
    if (!byName.has(doc.navigatesTo.toLowerCase().trim())) {
      issues.push({
        severity: 'warning',
        screen: doc.name,
        message: `The documentation says it leads to "${doc.navigatesTo}", which was not built as a screen.`,
      })
    }
  }

  /* ---- every documented button must be represented ---- */
  for (const doc of appSpec.documentedScreens) {
    const screen = byName.get(doc.name.toLowerCase().trim())
    if (!screen) continue

    for (const action of doc.actions) {
      const callsSomething = action.endpointIds.some((id) => screen.endpointIds.includes(id))
      // Its own destination counts first; the screen's applies to whatever
      // button was left without one.
      const named = action.navigatesTo ?? doc.navigatesTo
      const navigatesSomewhere = Boolean(named && byName.has(named.toLowerCase().trim()))
      if (action.endpointIds.length > 0 && !callsSomething) {
        issues.push({
          severity: 'error',
          screen: screen.name,
          message: `The "${action.label}" button should call ${action.endpointIds.join(', ')}, but the screen was not given it.`,
        })
      } else if (action.endpointIds.length === 0 && !navigatesSomewhere) {
        issues.push({
          severity: 'warning',
          screen: screen.name,
          message: `The "${action.label}" button has no endpoint and no destination, so it can only do something local.`,
        })
      }
    }
  }

  /* ---- routes must be distinct ---- */
  if (routes.size !== plan.screens.length) {
    const seen = new Set<string>()
    for (const screen of plan.screens) {
      if (seen.has(screen.route)) {
        issues.push({
          severity: 'error',
          screen: screen.name,
          message: `Shares the route ${screen.route} with an earlier screen, so it can never be opened.`,
        })
      }
      seen.add(screen.route)
    }
  }

  return issues
}

/**
 * Fixes what can be fixed without guessing, and returns what remains.
 *
 * Only corrections that follow necessarily from the plan are applied: an
 * unreachable screen is put in the navigation, a screen expecting data from a
 * screen that has none is re-pointed at the nearest supplier upstream.
 */
export function repairPlan(plan: AppPlan, appSpec: AppSpec, issues: FlowIssue[]): FlowIssue[] {
  const byName = new Map(plan.screens.map((s) => [s.name.toLowerCase().trim(), s]))

  for (const issue of issues) {
    if (!issue.screen) continue
    const screen = byName.get(issue.screen.toLowerCase().trim())
    if (!screen) continue

    if (issue.message.startsWith('Not reachable')) {
      /*
       * A route with a parameter cannot go in the navigation, because a link
       * needs a value for it and nothing here has one.
       *
       * This used to "repair" it anyway, emitting a link to the literal
       * `/projects/:projectId/updates`. React Router matches that pattern
       * happily and hands the screen the string ":projectId" as its id, so the
       * screen calls the API with it, gets a 404 or an empty guard, and shows
       * nothing. A dead link that reports itself as fixed is worse than an
       * unreachable screen that reports itself as unreachable.
       */
      if (/[:{]/.test(screen.route)) {
        issue.message =
          `${issue.message} Its route takes a parameter, so it cannot be linked from the ` +
          'navigation — only from a screen that holds the value. Give a button on the ' +
          'screen that lists these records a destination in your documentation.'
        continue
      }
      screen.showInNav = true
      plan.navigation.push({ screenId: screen.id, label: screen.name, icon: screen.icon })
      issue.repaired = 'added to the navigation'
      continue
    }

    if (issue.message.includes('fetches nothing and receives nothing')) {
      // Walk back until a screen that genuinely holds data is found.
      const index = plan.screens.indexOf(screen)
      const upstream = plan.screens
        .slice(0, index)
        .reverse()
        .find((s) => s.endpointIds.length > 0)
      if (upstream) {
        screen.incomingFrom = upstream.name
        issue.repaired = `now receives from ${upstream.name}`
      }
    }
  }

  return issues.filter((i) => !i.repaired)
}

export function describeFlowIssues(issues: FlowIssue[]): string {
  return issues.map((i) => `- ${i.screen ? `${i.screen}: ` : ''}${i.message}`).join('\n')
}
