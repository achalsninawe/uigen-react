import { demoFieldKey } from './demo.js'
import { capturedFields, coveredSpec } from './types.js'
import { key, str, toIdentifier } from './lang.js'
import type { AppPlan, AppSpec, BodyBinding, Endpoint, FlowSpec } from '../../types.js'

/**
 * src/lib/flow.ts — the one place a flow keeps what the user entered and turns
 * it into request bodies.
 *
 * Written by code, not by the model, for the same reason the API client is:
 * the two things that went wrong in generated insurance flows were both data
 * plumbing. Each screen passed only its own values to the next, so the screen
 * that submitted held a fraction of the form; and each screen wrote its request
 * body by hand, pasting the documented example's test person into it and
 * inventing codes. Here the body IS the documented example, with only the
 * values the user supplied laid over it, in the example's own formats.
 */

/** Every value the planned screens collect, keyed the way screens read them. */
export function flowFields(appSpec: AppSpec, plan: Pick<AppPlan, 'screens'>): FlowSpec['fields'] {
  const fields = new Map<string, string>()
  for (const screen of plan.screens) {
    const spec = coveredSpec(screen, appSpec.documentedScreens)
    if (!spec) continue
    for (const field of capturedFields(spec)) {
      const fieldKey = demoFieldKey(field.label)
      if (!fields.has(fieldKey)) fields.set(fieldKey, field.label)
    }
  }
  return [...fields].map(([fieldKey, label]) => ({ key: fieldKey, label }))
}

/** `postIssueTermPolicy` -> `sendPostIssueTermPolicy`. */
export function senderName(operationId: string): string {
  return `send${operationId[0]!.toUpperCase()}${operationId.slice(1)}`
}

/** `buildPostIssueTermPolicyBody`, for a review screen that shows what will be sent. */
export function builderName(operationId: string): string {
  return `build${operationId[0]!.toUpperCase()}${operationId.slice(1)}Body`
}

/**
 * An endpoint whose body can be built from its example: a JSON object to start
 * from. Without one there is nothing to lay the user's values over, and those
 * keep the old path of the screen assembling the body itself.
 */
export function hasBodyExample(endpoint: Endpoint): boolean {
  const example = endpoint.requestBody?.example
  return example !== null && typeof example === 'object' && !Array.isArray(example)
}

export type Leaf = { path: string; value: string | number | boolean | null }

/** Every primitive in an example, addressed with array indexes: `a.0.b`. */
export function leavesOf(value: unknown, prefix = '', out: Leaf[] = []): Leaf[] {
  if (value === null || typeof value !== 'object') {
    if (prefix) out.push({ path: prefix, value: value as Leaf['value'] })
    return out
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value)
  for (const [k, v] of entries) leavesOf(v, prefix ? `${prefix}.${k}` : k, out)
  return out
}

/** `policy.coverages[0].x` and `policy.coverages.0.x` mean the same leaf. */
export function normalisePath(path: string): string {
  return path
    .trim()
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\[\]/g, '.0')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.')
}

export function readPath(value: unknown, path: string): unknown {
  let node = value
  for (const segment of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

/** The format a leaf is written in, read off the documented example itself. */
export function formatOf(value: unknown): BodyBinding['format'] {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string' && DATE_TIME.test(value)) return 'datetime'
  if (typeof value === 'string' && DATE_ONLY.test(value)) return 'date'
  return 'string'
}

/** Array indexes stay numbers, so the emitted path reads as data, not prose. */
const pathLiteral = (path: string) =>
  `[${path
    .split('.')
    .map((s) => (/^\d+$/.test(s) ? s : str(s)))
    .join(', ')}]`

function emitBindings(bindings: BodyBinding[]): string {
  return bindings
    .map((b) => {
      const source = b.field
        ? `field: ${str(b.field)}`
        : b.template
          ? `template: ${str(b.template)}`
          : `response: { operationId: ${str(b.response!.operationId)}, path: ${pathLiteral(b.response!.path)} }`
      return `  { path: ${pathLiteral(b.path)}, ${source}, format: ${str(b.format)} },`
    })
    .join('\n')
}

/** Positional arguments of the generated client function, minus the body. */
function senderArgs(endpoint: Endpoint): { params: string[]; pass: string[]; bodyIndex: number } {
  const op = endpoint.operationId
  const names = [...endpoint.path.matchAll(/\{([^}]+)\}|:([A-Za-z0-9_]+)/g)].map((m) => m[1] ?? m[2]!)
  for (const p of endpoint.pathParams) if (!names.includes(p.name)) names.push(p.name)

  const params: string[] = []
  const pass: string[] = []
  names.forEach((name, index) => {
    const arg = toIdentifier(name, 'param')
    params.push(`${arg}: Parameters<typeof ${op}>[${index}]`)
    pass.push(arg)
  })
  pass.push(`${builderName(op)}()`)
  if (endpoint.queryParams.length > 0) {
    const required = endpoint.queryParams.some((p) => p.required)
    params.push(`query${required ? '' : '?'}: Parameters<typeof ${op}>[${names.length + 1}]`)
    pass.push('query')
  }
  params.push('options?: RequestOptions')
  pass.push('{ ...options, exactBody: true }')
  return { params, pass, bodyIndex: names.length }
}

export function emitFlow(appSpec: AppSpec, plan: AppPlan, projectId: string): string {
  const flow = plan.flow!
  const byId = new Map(appSpec.endpoints.map((e) => [e.operationId, e]))
  const requests = flow.requests.filter((r) => byId.has(r.operationId))
  const ops = requests.map((r) => r.operationId)

  const optionLines = Object.entries(flow.options)
    .map(
      ([field, options]) =>
        `  ${key(field)}: [\n${options
          .map((o) => `    { value: ${str(o.value)}, label: ${str(o.label)} },`)
          .join('\n')}\n  ],`,
    )
    .join('\n')

  const hintLines = Object.entries(flow.hints)
    .map(([field, hint]) => `  ${key(field)}: ${str(hint)},`)
    .join('\n')

  const requestBlocks = requests
    .map((request) => {
      const endpoint = byId.get(request.operationId)!
      const op = endpoint.operationId
      const constBase = toIdentifier(op, 'request').replace(/^./, (c) => c.toUpperCase())
      const { params, pass, bodyIndex } = senderArgs(endpoint)
      return `/* ${endpoint.method} ${endpoint.path} — ${endpoint.summary || endpoint.name} */

/** The request example from your documentation, exactly as written. */
const ${constBase}Example = ${JSON.stringify(endpoint.requestBody!.example, null, 2)}

const ${constBase}Bindings: Binding[] = [
${emitBindings(request.bindings)}
]

/**
 * The body ${op} sends: the documented example, with what the user entered
 * laid over it. Everything not listed in the bindings stays as documented.
 */
export function ${builderName(op)}(from: Draft = draft): Parameters<typeof ${op}>[${bodyIndex}] {
  return build(${constBase}Example, ${constBase}Bindings, from) as Parameters<typeof ${op}>[${bodyIndex}]
}

/** Calls ${op} with that body, and keeps the response for later screens. */
export async function ${senderName(op)}(${params.join(', ')}): Promise<Awaited<ReturnType<typeof ${op}>>> {
  const result = await ${op}(${pass.join(', ')})
  commit({ ...draft, responses: { ...draft.responses, ${str(op)}: result } })
  return result
}`
    })
    .join('\n\n')

  const formMembers = flow.fields.map((f) => `${key(f.key)}`)

  return `/**
 * What this flow collects, and the request bodies built from it.
 *
 * Generated by Spec2UI — not written by a language model.
 *
 * Every screen reads and writes ONE draft, so nothing typed on an earlier step
 * is lost by the time a later one reviews or submits it. It lasts for the
 * browser session, so a refresh mid-flow keeps it.
 *
 * Request bodies are your documented examples, unchanged, except for the
 * values listed in each "Bindings" table: those come from the draft and are
 * written in the format the example itself uses.
 */
import { useSyncExternalStore } from 'react'
${ops.length ? `import { ${ops.join(', ')} } from './api'\n` : ''}import type { RequestOptions } from './api'
import type { FlowForm } from './types'

export type { FlowForm }

export interface Draft {
  form: FlowForm
  /** What each call returned, by operation. */
  responses: Record<string, unknown>
}

/* --------------------------------- Draft --------------------------------- */

const STORAGE_KEY = ${str(`spec2ui:flow:${projectId}`)}
const EMPTY: Draft = { form: {}, responses: {} }

function restore(): Draft {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) return { ...EMPTY, ...(JSON.parse(raw) as Draft) }
  } catch {
    // No storage (private window, sandboxed preview): the draft lives in memory.
  }
  return EMPTY
}

let draft: Draft = restore()
const listeners = new Set<() => void>()

function commit(next: Draft) {
  draft = next
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Same as above — memory only.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The flow's draft, shared by every screen.
 *
 *     const { form, setField } = useDraft()
 *     <Input value={form.firstName ?? ''} onChange={(e) => setField('firstName', e.target.value)} />
 */
export function useDraft() {
  const current = useSyncExternalStore(subscribe, () => draft, () => draft)
  return {
    form: current.form,
    responses: current.responses,
    setField: (field: keyof FlowForm, value: string) =>
      commit({ ...draft, form: { ...draft.form, [field]: value } }),
    /** Start over — after a flow completes, or on "New application". */
    reset: () => commit(EMPTY),
  }
}

export function getDraft(): Draft {
  return draft
}

/** Every key the flow collects, in documented order. */
export const flowFieldKeys = ${JSON.stringify(formMembers)} as const

/* -------------------------------- Choices -------------------------------- */

export interface FieldOption {
  value: string
  label: string
}

/**
 * Dropdown choices. \`value\` is the code the API expects; \`label\` is what
 * the user reads. Only codes found in your documents appear here.
 */
export const fieldOptions: Partial<Record<keyof FlowForm, FieldOption[]>> = {
${optionLines}
}

/**
 * The documented example's value for a field that has no code list, shown as
 * a placeholder so the user knows what form the API expects.
 */
export const fieldHints: Partial<Record<keyof FlowForm, string>> = {
${hintLines}
}

/* ----------------------------- Request bodies ----------------------------- */

type Path = (string | number)[]

interface Binding {
  path: Path
  field?: keyof FlowForm
  template?: string
  response?: { operationId: string; path: Path }
  format: 'string' | 'number' | 'boolean' | 'date' | 'datetime'
}

function readAt(node: unknown, path: Path): unknown {
  let at = node
  for (const segment of path) {
    if (at === null || typeof at !== 'object') return undefined
    at = (at as Record<string, unknown>)[segment as string]
  }
  return at
}

function writeAt(node: unknown, path: Path, value: unknown) {
  let at = node as Record<string, unknown>
  for (const segment of path.slice(0, -1)) {
    const next = at[segment as string]
    if (next === null || typeof next !== 'object') return
    at = next as Record<string, unknown>
  }
  const last = path[path.length - 1] as string
  if (value === undefined) delete at[last]
  else at[last] = value
}

/** A typed date in any common order, as YYYY-MM-DD. */
function isoDate(raw: string): string | undefined {
  const iso = raw.match(/^(\\d{4})-(\\d{2})-(\\d{2})/)
  if (iso) return \`\${iso[1]}-\${iso[2]}-\${iso[3]}\`
  const dmy = raw.match(/^(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})/)
  if (dmy) return \`\${dmy[3]}-\${dmy[2]!.padStart(2, '0')}-\${dmy[1]!.padStart(2, '0')}\`
  return undefined
}

/** Written in the format of the example's own value — separator, seconds, zone. */
function formatted(raw: string, format: Binding['format'], example: unknown): unknown {
  const text = raw.trim()
  switch (format) {
    case 'number': {
      if (text === '') return undefined
      // "15 Years", "1,000,000", "INR 500" — the number is what the API wants.
      const found = numberIn(text)
      return found === undefined ? text : Number(found)
    }
    case 'boolean':
      return /^(true|yes|y|1)$/i.test(text)
    case 'date':
      return text === '' ? '' : (isoDate(text) ?? text)
    case 'datetime': {
      if (text === '') return ''
      const date = isoDate(text)
      if (!date) return text
      const typedTime = text.match(/[T ](\\d{2}:\\d{2}(?::\\d{2})?)/)?.[1] ?? '00:00:00'
      const shape =
        typeof example === 'string' ? example.match(/^\\d{4}-\\d{2}-\\d{2}([T ])(\\d{2}:\\d{2})(:\\d{2})?(.*)$/) : null
      if (!shape) return \`\${date}T\${typedTime.length === 5 ? \`\${typedTime}:00\` : typedTime}\`
      const [, separator, , seconds, rest] = shape
      const hm = typedTime.slice(0, 5)
      const ss = seconds ? (typedTime.length > 5 ? typedTime.slice(5) : ':00') : ''
      return \`\${date}\${separator}\${hm}\${ss}\${rest ?? ''}\`
    }
    default:
      // The example holds a number written as text ("coverageYear": "15"): send
      // the number in the same form, not "15 Years".
      if (typeof example === 'string' && /^-?\\d+(\\.\\d+)?$/.test(example) && text !== '') {
        return numberIn(text) ?? raw
      }
      return raw
  }
}

/** The first number in what was typed, without grouping commas: "1,000,000 INR" -> "1000000". */
function numberIn(text: string): string | undefined {
  return text.match(/-?\\d[\\d,]*(?:\\.\\d+)?/)?.[0]?.replace(/,/g, '')
}

function fill(template: string, form: FlowForm): string {
  return template
    .replace(/\\{(\\w+)\\}/g, (_m, name: string) => (form as Record<string, string | undefined>)[name] ?? '')
    .replace(/\\s+/g, ' ')
    .trim()
}

function build(example: unknown, bindings: Binding[], from: Draft): unknown {
  const body = JSON.parse(JSON.stringify(example)) as unknown
  for (const binding of bindings) {
    const original = readAt(example, binding.path)
    let raw: unknown
    if (binding.field) raw = from.form[binding.field] ?? ''
    else if (binding.template) raw = fill(binding.template, from.form)
    else if (binding.response) {
      raw = readAt(from.responses[binding.response.operationId], binding.response.path)
      // Nothing came back for it: keep the documented value rather than blank it.
      if (raw === undefined || raw === null) continue
    }
    writeAt(body, binding.path, formatted(String(raw ?? ''), binding.format, original))
  }
  return body
}
${requestBlocks ? `\n${requestBlocks}\n` : ''}`
}
