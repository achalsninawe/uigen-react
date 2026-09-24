import type { AppSpec, DocumentedScreen, Flow } from '../types.js'

export const LINK_SYSTEM = `You match prose references to API operations.

Documentation is written by people. A flow document says "the SEARCH button calls the Customer Lookup API"; the reference document defines an operation called "qryCustByRef". They are the same thing, described twice by different authors. Your job is to connect them.

HOW TO MATCH

Read the intent, not the string. Names rarely match literally:
  "Customer Lookup API"  ~  qryCustByRef        both find a customer
  "Pricing API"          ~  calcEstimate        a quote is a calculation
  "Submit Order"         ~  POST /orders        both create an order

An abbreviation, a vendor prefix, an internal code name, a different word for
the same idea — all normal. Compare what the operation *does* against what the
step says it is for.

Use every clue available: the operation's summary, its path, its request and response fields, and what the step says it is for. A step that says "generates refund calculation preview" matches the operation whose response contains refund amounts.

MATCH CONSERVATIVELY

Only link a step to an operation when you are confident they are the same thing. An unmatched step is a fact worth knowing; a wrong match produces a screen that calls the wrong endpoint, which is far worse.

One step may legitimately use more than one operation. Most use none — navigating, validating a form, enabling a button and showing a confirmation are interface behaviour, not API calls. Leave those empty.

Never invent an operationId. Use only the exact values from the list.

OUTPUT
Return a single JSON object:
{
  "links":       [ { "flow": "<flow name>", "step": <step order>, "operationIds": ["..."], "why": "..." } ],
  "actionLinks": [ { "screen": "<screen name>", "action": "<button label>", "operationIds": ["..."], "why": "..." } ]
}

A button labelled "Quote" whose documented effect is "Calls the Pricing
API" is exactly the kind of thing to link — that is a real API call
wearing a friendly name. A button labelled "NEXT" that only navigates is not.

Include an entry only for the steps and buttons you are linking. Omit the rest.`

export function linkUser(appSpec: AppSpec): string {
  const screens = appSpec.documentedScreens
    .map((screen) => {
      const buttons = screen.actions.length
        ? screen.actions.map((a) => `  button "${a.label}": ${a.does}`).join('\n')
        : '  (no buttons)'
      return `Screen "${screen.name}"\n${buttons}`
    })
    .join('\n\n')

  const endpoints = appSpec.endpoints
    .map((e) => {
      const fields = [
        e.requestBody?.typeName ? `body: ${e.requestBody.typeName}` : '',
        e.responses.find((r) => /^2\d\d$/.test(r.status))?.typeName
          ? `returns: ${e.responses.find((r) => /^2\d\d$/.test(r.status))!.typeName}`
          : '',
      ].filter(Boolean)
      return [
        `- ${e.operationId}   ${e.method} ${e.path}`,
        e.summary ? `    ${e.summary}` : '',
        e.description ? `    ${e.description.replace(/\s+/g, ' ').slice(0, 200)}` : '',
        fields.length ? `    ${fields.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')

  const flows = appSpec.flows
    .map(
      (f) =>
        `Flow "${f.name}"\n${f.steps
          .map((s) => `  step ${s.order}: ${s.action}${s.screenHint ? ` [${s.screenHint}]` : ''}`)
          .join('\n')}`,
    )
    .join('\n\n')

  return `OPERATIONS AVAILABLE
${endpoints || '(none)'}

FLOWS TO LINK
${flows || '(none)'}

SCREEN BUTTONS TO LINK
${screens || '(none)'}

Match each step and each button that makes an API call to the operation it calls.`
}

/** Applies the model's matches, ignoring anything that does not resolve. */
export function applyLinks(
  flows: Flow[],
  screens: DocumentedScreen[],
  result: {
    links: { flow: string; step: number; operationIds: string[] }[]
    actionLinks: { screen: string; action: string; operationIds: string[] }[]
  },
  validIds: Set<string>,
): { linked: number } {
  let linked = 0
  const keep = (ids: string[]) => ids.filter((id) => validIds.has(id))

  const flowsByName = new Map(flows.map((f) => [f.name.toLowerCase().trim(), f]))
  for (const link of result.links) {
    const flow = flowsByName.get(link.flow.toLowerCase().trim())
    const step = flow?.steps.find((s) => s.order === link.step)
    if (!step) continue

    const ids = keep(link.operationIds)
    if (ids.length === 0) continue

    // Anything already linked during extraction stands; this only fills gaps.
    const merged = [...new Set([...step.endpointIds, ...ids])]
    linked += merged.length - step.endpointIds.length
    step.endpointIds = merged
  }

  const screensByName = new Map(screens.map((s) => [s.name.toLowerCase().trim(), s]))
  for (const link of result.actionLinks) {
    const screen = screensByName.get(link.screen.toLowerCase().trim())
    const action = screen?.actions.find(
      (a) => a.label.toLowerCase().trim() === link.action.toLowerCase().trim(),
    )
    if (!action) continue

    const ids = keep(link.operationIds)
    if (ids.length === 0) continue

    const merged = [...new Set([...action.endpointIds, ...ids])]
    linked += merged.length - action.endpointIds.length
    action.endpointIds = merged
  }

  return { linked }
}
