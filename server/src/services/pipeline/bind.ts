import { chatJson } from '../azure.js'
import { bindSchema } from '../../schemas.js'
import { BIND_SYSTEM, bindUser, type BindPromptInput } from '../../prompts/bind.js'
import { demoFieldKey } from '../emit/demo.js'
import { capturedFields, coveredSpec } from '../emit/types.js'
import { flowFields, formatOf, hasBodyExample, leavesOf, normalisePath, readPath } from '../emit/flow.js'
import type {
  AppPlan,
  AppSpec,
  BodyBinding,
  DocumentedField,
  Endpoint,
  FieldOption,
  FlowSpec,
  RequestBinding,
  SpecDocument,
} from '../../types.js'

type Log = (message: string, level?: 'info' | 'warn' | 'error') => void

const MAX_LEAVES = 400
const MAX_DOCUMENT_CHARS = 40_000

/**
 * Codes so universal that a document using one side of the pair has stated
 * the other: an example with "smoking": "N" has told you what Yes is.
 */
const UNIVERSAL_CODES = new Set(['Y', 'N', 'y', 'n', 'M', 'F', 'true', 'false', 'TRUE', 'FALSE', '0', '1'])

const showValue = (value: unknown) => (typeof value === 'string' ? JSON.stringify(value) : String(value))

/** A response's readable paths: its example when documented, else its type tree. */
function responseLeaves(endpoint: Endpoint, appSpec: AppSpec): string[] {
  const success = endpoint.responses.find((r) => /^2\d\d$/.test(r.status))
  if (!success) return []
  if (success.example !== undefined && success.example !== null && typeof success.example === 'object') {
    return leavesOf(success.example).map((l) => l.path)
  }

  const byName = new Map(appSpec.entities.map((e) => [e.name, e]))
  const out: string[] = []
  const walk = (typeName: string, prefix: string, depth: number) => {
    const entity = byName.get(typeName.replace(/\[\]$/, '').trim())
    if (!entity || depth > 5 || out.length >= MAX_LEAVES) return
    for (const field of entity.fields) {
      const isArray = /\[\]$/.test(field.type)
      const base = field.type.replace(/\[\]$/, '').trim()
      const at = `${prefix ? `${prefix}.` : ''}${field.name}${isArray ? '.0' : ''}`
      if (byName.has(base)) walk(base, at, depth + 1)
      else out.push(at)
    }
  }
  if (success.typeName) walk(success.typeName, '', 0)
  return out
}

/** Every token the documents contain — the only place a code may come from. */
function groundingCorpus(appSpec: AppSpec, documents: SpecDocument[]): { tokens: Set<string>; text: string } {
  const text = [...documents.map((d) => d.text ?? ''), JSON.stringify(appSpec)].join('\n')
  return { tokens: new Set(text.split(/[^A-Za-z0-9_.\-]+/).filter(Boolean)), text }
}

function grounded(value: string, corpus: { tokens: Set<string>; text: string }): boolean {
  if (UNIVERSAL_CODES.has(value)) return true
  if (corpus.tokens.has(value)) return true
  // A code with spaces or punctuation in it, written as a quoted string.
  return value.length > 1 && corpus.text.includes(JSON.stringify(value))
}

const DATE_LIKE = /date|dob|birth|day/i

/**
 * Works out the flow's shared fields, how each request body is built from
 * them, and which dropdown codes are real.
 *
 * The model proposes; code disposes. A path the example does not have, a key
 * the form does not collect, a code no document contains — each is dropped and
 * said out loud, so the generated app can only ever send the documented
 * example with the user's own values in it.
 */
export async function bindFlow(
  appSpec: AppSpec,
  plan: AppPlan,
  documents: SpecDocument[],
  log: Log,
): Promise<FlowSpec> {
  const fields = flowFields(appSpec, plan)
  const fieldKeys = new Set(fields.map((f) => f.key))
  const flow: FlowSpec = { fields, requests: [], options: {}, hints: {} }

  // Documented field details, by key, from whichever screen collects it first.
  const documented = new Map<string, { field: DocumentedField; screen: string }>()
  for (const screen of plan.screens) {
    const spec = coveredSpec(screen, appSpec.documentedScreens)
    for (const field of spec ? capturedFields(spec) : []) {
      const k = demoFieldKey(field.label)
      if (!documented.has(k)) documented.set(k, { field, screen: screen.name })
    }
  }

  const byId = new Map(appSpec.endpoints.map((e) => [e.operationId, e]))
  const screenOrder = new Map<string, number>()
  plan.screens.forEach((s, i) => s.endpointIds.forEach((id) => screenOrder.has(id) || screenOrder.set(id, i)))

  const bodies = [...screenOrder.keys()]
    .map((id) => byId.get(id))
    .filter((e): e is Endpoint => Boolean(e) && hasBodyExample(e!))

  const choosable = fields.filter((f) => {
    const doc = documented.get(f.key)?.field
    return Boolean(doc?.options?.length) || /drop|select|choice|radio|yes\s*\/\s*no|toggle|list/i.test(doc?.type ?? '')
  })

  if (bodies.length === 0 && choosable.length === 0) return flow

  const examples = new Map(bodies.map((e) => [e.operationId, leavesOf(e.requestBody!.example)]))
  const responsePaths = new Map(
    [...screenOrder.keys()]
      .map((id) => byId.get(id))
      .filter((e): e is Endpoint => Boolean(e))
      .map((e) => [e.operationId, responseLeaves(e, appSpec)] as const)
      .filter(([, leaves]) => leaves.length > 0),
  )

  const input: BindPromptInput = {
    fields: fields.map((f) => {
      const doc = documented.get(f.key)
      return {
        key: f.key,
        label: f.label,
        type: doc?.field.type,
        options: doc?.field.options,
        notes: doc?.field.notes,
        screen: doc?.screen ?? '',
      }
    }),
    requests: bodies.map((e) => ({
      operationId: e.operationId,
      summary: e.summary || e.name,
      screens: plan.screens.filter((s) => s.endpointIds.includes(e.operationId)).map((s) => s.name),
      leaves: examples
        .get(e.operationId)!
        .slice(0, MAX_LEAVES)
        .map((l) => `${l.path} = ${showValue(l.value)}`),
    })),
    responses: [...responsePaths]
      // Only what an earlier call can have returned by the time a body is built.
      .filter(([id]) => bodies.some((b) => (screenOrder.get(id) ?? 0) <= (screenOrder.get(b.operationId) ?? 0) && id !== b.operationId))
      .map(([operationId, leaves]) => ({ operationId, leaves: leaves.slice(0, 120) })),
    documents: documents
      .map((d) => `--- ${d.filename}\n${d.text ?? ''}`)
      .join('\n\n')
      .slice(0, MAX_DOCUMENT_CHARS),
  }

  log(`Mapping ${fields.length} form field(s) onto ${bodies.length} request bod${bodies.length === 1 ? 'y' : 'ies'}`)
  const answer = await chatJson({
    system: BIND_SYSTEM,
    user: bindUser(input),
    schema: bindSchema,
    temperature: 0.1,
    maxTokens: 8000,
  })

  const corpus = groundingCorpus(appSpec, documents)
  const dropped: string[] = []

  /* ---------------------------- request bodies ---------------------------- */

  for (const body of bodies) {
    const example = body.requestBody!.example
    const leafPaths = new Set(examples.get(body.operationId)!.map((l) => l.path))
    const proposed = answer.bindings.filter((b) => b.operationId === body.operationId)
    const bindings: BodyBinding[] = []
    const seen = new Set<string>()

    for (const raw of proposed) {
      const path = normalisePath(raw.path)
      if (!leafPaths.has(path)) {
        dropped.push(`${body.operationId}: "${raw.path}" is not in the documented example`)
        continue
      }
      if (seen.has(path)) continue

      const leaf = readPath(example, path)
      let format = formatOf(leaf)

      if (raw.field) {
        if (!fieldKeys.has(raw.field)) {
          dropped.push(`${body.operationId}: "${raw.field}" is not a field the form collects`)
          continue
        }
        // An empty example says nothing about format; a date field still wants a date.
        const label = fields.find((f) => f.key === raw.field)!.label
        const type = documented.get(raw.field)?.field.type ?? ''
        if (leaf === '' && (DATE_LIKE.test(label) || /date/i.test(type))) format = 'date'
        bindings.push({ path, field: raw.field, format })
      } else if (raw.template) {
        const unknown = [...raw.template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).filter((k) => !fieldKeys.has(k))
        if (unknown.length > 0 || !/\{\w+\}/.test(raw.template)) {
          dropped.push(`${body.operationId}: template for ${path} uses unknown field(s) ${unknown.join(', ')}`)
          continue
        }
        bindings.push({ path, template: raw.template, format })
      } else if (raw.responseOperationId && raw.responsePath) {
        const sourcePath = normalisePath(raw.responsePath)
        if (!responsePaths.get(raw.responseOperationId)?.includes(sourcePath)) {
          dropped.push(`${body.operationId}: ${raw.responseOperationId} returns no "${raw.responsePath}"`)
          continue
        }
        bindings.push({ path, response: { operationId: raw.responseOperationId, path: sourcePath }, format })
      } else {
        continue
      }
      seen.add(path)
    }

    /*
     * One field, several paths, different example values: the paths do not mean
     * the same thing. "Coverage / Term" bound to chargeYear (15) and to
     * chargePeriod ("2", a unit code) would send the user's 10 as a unit code.
     * The paths agreeing with most of the others stay; with no majority, none
     * do, and the person is told rather than sent a guess.
     */
    for (const fieldKey of new Set(bindings.filter((b) => b.field).map((b) => b.field!))) {
      const mine = bindings.filter((b) => b.field === fieldKey)
      if (mine.length < 2) continue
      const groups = new Map<string, BodyBinding[]>()
      for (const b of mine) {
        const value = String(readPath(example, b.path) ?? '')
        groups.set(value, [...(groups.get(value) ?? []), b])
      }
      if (groups.size < 2) continue
      const ranked = [...groups.values()].sort((a, b) => b.length - a.length)
      const keep = ranked[0]!.length > ranked[1]!.length ? new Set(ranked[0]) : new Set<BodyBinding>()
      const removed = mine.filter((b) => !keep.has(b))
      for (const b of removed) {
        bindings.splice(bindings.indexOf(b), 1)
        seen.delete(b.path)
      }
      const label = fields.find((f) => f.key === fieldKey)!.label
      dropped.push(
        `${label} → ${removed.map((b) => `${b.path} (example ${showValue(readPath(example, b.path))})`).join(', ')}: ` +
          (keep.size
            ? 'these hold a different kind of value from the rest'
            : 'these hold different kinds of value, so none is filled — say in the documents which one it is'),
      )
    }

    flow.requests.push({ operationId: body.operationId, bindings })

    const fromForm = bindings.filter((b) => b.field).length
    const derived = bindings.filter((b) => b.template).length
    const carried = bindings.filter((b) => b.response).length
    log(
      `${body.operationId}: documented example sent as written, with ${fromForm} value(s) from the form` +
        `${derived ? `, ${derived} derived` : ''}${carried ? `, ${carried} from earlier responses` : ''}`,
    )
  }

  /* ------------------------------- dropdowns ------------------------------ */

  for (const proposal of answer.options) {
    if (!fieldKeys.has(proposal.field)) continue
    const kept: FieldOption[] = []
    for (const option of proposal.options) {
      const value = option.value.trim()
      if (!value || kept.some((o) => o.value === value)) continue
      if (!grounded(value, corpus)) {
        dropped.push(`${proposal.field}: code "${value}" (${option.label}) appears nowhere in the documents`)
        continue
      }
      kept.push({ value, label: option.label.trim() || value })
    }
    if (kept.length > 0) flow.options[proposal.field] = kept
  }

  /*
   * The pairs nobody writes down. An example with "smoking": "N" has said what
   * Yes is, and one with "gender": "M" what Female is; leaving these to the
   * model gave a dropdown on one run and a text box on the next.
   */
  for (const field of choosable) {
    if (flow.options[field.key]) continue
    const binding = flow.requests.flatMap((r) => r.bindings).find((b) => b.field === field.key)
    const request = binding && flow.requests.find((r) => r.bindings.includes(binding))
    const sample = binding && request ? readPath(byId.get(request.operationId)!.requestBody!.example, binding.path) : undefined
    if (sample === 'Y' || sample === 'N') {
      flow.options[field.key] = [
        { value: 'Y', label: 'Yes' },
        { value: 'N', label: 'No' },
      ]
    } else if ((sample === 'M' || sample === 'F') && /gender|sex/i.test(field.label)) {
      flow.options[field.key] = [
        { value: 'M', label: 'Male' },
        { value: 'F', label: 'Female' },
      ]
    }
  }

  // A list the documents spelled out is a list of values, even if the model gave none.
  for (const [fieldKey, { field }] of documented) {
    if (flow.options[fieldKey] || !field.options?.length) continue
    flow.options[fieldKey] = field.options.map((o) => ({ value: o, label: o }))
  }

  /* -------------------------------- hints --------------------------------- */

  const bound = (fieldKey: string) =>
    flow.requests.flatMap((r) => r.bindings).find((b) => b.field === fieldKey)

  // Only for a code with no list: anywhere else the example's value is its test
  // person, and "AB598214" is no help as a placeholder for a first name.
  for (const field of choosable) {
    if (flow.options[field.key]) continue
    const binding = bound(field.key)
    if (!binding) continue
    const request = flow.requests.find((r) => r.bindings.includes(binding))!
    const sample = readPath(byId.get(request.operationId)!.requestBody!.example, binding.path)
    // A date's format is handled for the user; showing the example would only suggest typing it.
    if (sample === undefined || sample === null || sample === '' || binding.format === 'date' || binding.format === 'datetime') continue
    flow.hints[field.key] = String(sample)
  }

  /* -------------------------------- report -------------------------------- */

  for (const reason of dropped) log(`Not used — ${reason}`, 'warn')

  for (const field of choosable) {
    if (flow.options[field.key]) continue
    log(
      `${field.label}: the documents give no codes for it, so it is a text box (hint: ` +
        `${flow.hints[field.key] ?? 'none'}). List its codes in the document to get a dropdown.`,
      'warn',
    )
  }

  // A missing code list was already reported above, in one place.
  for (const item of answer.unclear) {
    if (!item.reason || flow.options[item.field] || choosable.some((f) => f.key === item.field)) continue
    const label = fields.find((f) => f.key === item.field)?.label ?? item.field
    log(`${label}: ${item.reason}`, 'warn')
  }

  if (flow.requests.length > 0) {
    const sent = new Set(
      flow.requests.flatMap((r) =>
        r.bindings.flatMap((b) => [b.field, ...[...(b.template ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1])]),
      ),
    )
    const unsent = fields.filter((f) => !sent.has(f.key))
    if (unsent.length > 0) {
      log(
        `Collected but sent to no API: ${unsent.map((f) => f.label).join(', ')}. ` +
          'If the API needs them, say in the documents which request field each one fills.',
        'warn',
      )
    }
  }

  return flow
}

/** The bindings for one operation, when its body is built by the flow module. */
export function requestBinding(flow: FlowSpec | undefined, operationId: string): RequestBinding | undefined {
  return flow?.requests.find((r) => r.operationId === operationId)
}
