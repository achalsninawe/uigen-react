import { docComment, key, toIdentifier, toTsType } from './lang.js'
import { demoFieldKey } from './demo.js'
import type { AppSpec, DocumentedField, DocumentedScreen, Entity } from '../../types.js'

/** Just enough of a planned screen to resolve what it covers. */
export interface PlannedScreen {
  name: string
  covers?: string[]
}

/** The planned screens, and the flow's fields once they have been worked out. */
export interface PlannedApp {
  screens: PlannedScreen[]
  flow?: { fields: { key: string; label: string }[] }
}

/**
 * What a screen is handed when the supplier's API has no documented response.
 *
 * Deliberately not `any`: a screen that guesses `incoming.premium` must still
 * turn it into text before rendering it, which is where a wrong guess shows.
 */
export const UNDOCUMENTED_RESPONSE = 'Record<string, unknown>'

/**
 * The type name holding what a user typed on a screen.
 *
 * Shared with the planner, so the type a screen imports is always the one that
 * was emitted — deriving the name twice is how those drift apart.
 */
export function formTypeName(screenName: string): string {
  const base = toIdentifier(screenName, 'screen')
  return `${base[0] ? base[0]!.toUpperCase() + base.slice(1) : 'Screen'}Form`
}

/**
 * The documented screens one planned screen answers for, merged into one.
 *
 * A planned screen may cover several documented ones — a project page that
 * carries its updates table answers for both headings — so every consumer that
 * used to look a screen up by name goes through here instead. Fields, buttons
 * and validation rules accumulate in the order the documents listed them, and
 * a field named twice is kept once.
 */
export function coveredSpec(
  screen: { name: string; covers?: string[] },
  documentedScreens: DocumentedScreen[],
): DocumentedScreen | undefined {
  const key = (value: string) => value.toLowerCase().trim()
  const wanted = screen.covers?.length ? screen.covers : [screen.name]

  const matched = wanted
    .map((name) => documentedScreens.find((d) => key(d.name) === key(name)))
    .filter((d): d is DocumentedScreen => Boolean(d))

  if (matched.length === 0) return undefined
  if (matched.length === 1) return matched[0]

  const fields = new Map<string, DocumentedField>()
  for (const spec of matched) {
    for (const field of spec.fields) if (!fields.has(key(field.label))) fields.set(key(field.label), field)
  }

  const actions = new Map<string, DocumentedScreen['actions'][number]>()
  for (const spec of matched) {
    for (const action of spec.actions) if (!actions.has(key(action.label))) actions.set(key(action.label), action)
  }

  const first = matched[0]!
  return {
    ...first,
    // The planned screen's own name, so every other lookup still lines up.
    name: screen.name,
    purpose: matched.map((s) => s.purpose).filter(Boolean).join(' '),
    fields: [...fields.values()],
    actions: [...actions.values()],
    validation: [...new Set(matched.flatMap((s) => s.validation))],
    // A destination stated by any covered part still applies to the whole.
    navigatesTo: matched.find((s) => s.navigatesTo)?.navigatesTo,
  }
}

/**
 * Fields the user fills in — read-only ones are displayed, never captured.
 *
 * A document often says so in the type column ("Policy Number | Read Only")
 * rather than in a flag, and a success page's policy number treated as an
 * input was rendered from an empty form state instead of the response.
 */
const DISPLAY_ONLY = /read[\s-]*only|display|label|output|view only|system generated|auto[\s-]*generated/i

export function capturedFields(screen: DocumentedScreen) {
  return screen.fields.filter((field) => !field.readOnly && !DISPLAY_ONLY.test(field.type ?? ''))
}

/** How much of a form row a field takes. Mirrors FieldSpan in the UI kit. */
export type FieldWidth = 'full' | 'half' | 'third'

const LONG_FIELD =
  /address|description|remark|comment|note|reason|detail|message|summary|purpose|instruction|full name|product name|company|occupation/
const COMPACT_FIELD =
  /amount|premium|sum |total|fee|duty|price|balance|rate|term|years?\b|age|count|quantity|qty|number of|percent|currency|date|dob|birth|zip|postal|pin code|tel|phone|mobile|gender/
const LONG_TYPE = /textarea|multi-?line|long text|paragraph|rich text/
const COMPACT_TYPE =
  /^(number|integer|int|decimal|float|date|datetime|time|currency|percentage|boolean|checkbox|radio)$/

/**
 * A field's natural size, taken from what the documentation called it.
 *
 * A currency picker and a postal address are not the same width, and giving
 * every field the whole row is the single thing that makes a generated form look
 * generated — a laptop shows eight labels down one column with half the page
 * empty beside them.
 */
function sizeOf(field: DocumentedField): 'long' | 'compact' | 'normal' {
  const label = field.label.toLowerCase()
  const type = (field.type ?? '').toLowerCase().trim()

  if (LONG_TYPE.test(type) || LONG_FIELD.test(label)) return 'long'
  // A dropdown whose values are sentences needs the room its values need.
  if (field.options?.some((option) => option.length > 30)) return 'long'
  if (COMPACT_TYPE.test(type) || COMPACT_FIELD.test(label)) return 'compact'
  return 'normal'
}

/**
 * The span for each documented field, in the order they were listed.
 *
 * Three or more compact fields in a row become a three-up row; one or two on
 * their own stay halves, because a lone third leaves a gap twice its own width
 * and reads as a mistake rather than a decision.
 */
export function fieldWidths(fields: DocumentedField[]): FieldWidth[] {
  const sizes = fields.map(sizeOf)
  const widths: FieldWidth[] = sizes.map((size) => (size === 'long' ? 'full' : 'half'))

  let i = 0
  while (i < sizes.length) {
    if (sizes[i] !== 'compact') {
      i++
      continue
    }
    let end = i
    while (end < sizes.length && sizes[end] === 'compact') end++
    if (end - i >= 3) for (let k = i; k < end; k++) widths[k] = 'third'
    i = end
  }

  return widths
}

/**
 * Emits `src/lib/types.ts` from the entities in the AppSpec.
 *
 * Like the API client, this is written by code rather than a model: the field
 * names and types are copied from the specification, so a screen that compiles
 * is a screen that matches the documented shapes.
 */

function emitEntity(entity: Entity, known: Set<string>): string {
  const doc = docComment([entity.description])

  if (entity.fields.length === 0) {
    return `${doc}export interface ${entity.name} {\n  [field: string]: unknown\n}`
  }

  const fields = entity.fields.map((field) => {
    const fieldDoc = docComment([field.description], '  ')
    return `${fieldDoc}  ${key(field.name)}${field.required ? '' : '?'}: ${resolveType(field.type, known)}`
  })

  return `${doc}export interface ${entity.name} {\n${fields.join('\n')}\n}`
}

/**
 * Keeps references to entities we actually emit, and degrades anything else to
 * `unknown` so the generated project always compiles.
 */
function resolveType(raw: string, known: Set<string>): string {
  const type = toTsType(raw)

  // Unions and intersections: resolve each member.
  if (/[|&]/.test(type)) {
    const separator = type.includes('|') ? '|' : '&'
    return type
      .split(separator)
      .map((part) => resolveType(part.trim(), known))
      .join(` ${separator} `)
  }

  const arrayMatch = type.match(/^(.+)\[\]$/)
  if (arrayMatch) return `${resolveType(arrayMatch[1]!.trim(), known)}[]`

  // String literals from enums, e.g. "pending".
  if (/^["'].*["']$/.test(type)) return type

  /*
   * A date is a string here, never a Date.
   *
   * Every value a generated screen holds has come through JSON — an API
   * response or the local store — and JSON has no date type, so what actually
   * arrives is "2026-09-17". Emitting `Date` told the compiler otherwise, so
   * `startDate?.toISOString()` type-checked and then threw
   * "toISOString is not a function" the first time a record was rendered.
   * Screens format with `new Date(value)`, which is correct for a string.
   */
  if (/^date(-?time)?$/i.test(type)) return 'string'

  const primitives = new Set([
    'string', 'number', 'boolean', 'unknown', 'null', 'void', 'Blob',
    'Record<string, unknown>', 'unknown[]',
  ])
  if (primitives.has(type)) return type
  if (known.has(type)) return type

  return 'unknown'
}

export function emitTypes(appSpec: AppSpec, plan?: PlannedApp): string {
  const known = new Set(appSpec.entities.map((e) => e.name))

  const header = `/**
 * Data shapes described by your specification.
 *
 * Generated by Spec2UI from the extracted entity definitions — not written by a
 * language model. Fields a document did not describe are absent rather than
 * guessed, and any type we could not resolve is \`unknown\` so it must be
 * narrowed before use.
 */
`

  const forms = [emitFormTypes(appSpec, plan), emitFlowForm(plan)].filter(Boolean).join('\n\n')

  if (appSpec.entities.length === 0 && !forms) {
    return `${header}
// Your specification did not define any named data shapes.
export {}
`
  }

  const entities = appSpec.entities.map((e) => emitEntity(e, known)).join('\n\n')
  return `${header}\n${[entities, forms].filter(Boolean).join('\n\n')}\n`
}

/**
 * One interface per documented screen, holding what its user typed.
 *
 * The documents routinely ask a later screen to display fields an earlier screen
 * collected — "collect the remaining fields from stored user data from the
 * Registration step". Those fields are in no API response: Registration sends
 * thirteen values and gets back four. Without a declared type for the other
 * nine, a screen that tries to show them reads properties off a response type
 * that never had them, and the project does not compile.
 *
 * Every member is optional and a string, because that is what an input element
 * yields and what a half-filled form holds.
 */
/**
 * Everything the flow collects, across every screen, as one shape — what the
 * shared draft in src/lib/flow.ts holds.
 */
function emitFlowForm(plan?: PlannedApp): string {
  if (!plan?.flow) return ''
  const members = plan.flow.fields.map((f) => `  ${key(f.key)}?: string   // ${f.label}`).join('\n')
  return `/** Everything the user enters across the flow, shared by every screen. */\nexport interface FlowForm {\n${members}\n}`
}

function emitFormTypes(appSpec: AppSpec, plan?: PlannedApp): string {
  const blocks: string[] = []

  /*
   * One interface per PLANNED screen, not per documented one.
   *
   * A planned screen may cover several documented screens, and it is the
   * planned name the codegen prompt derives `formType` from. Emitting these
   * from the documented names instead produced an interface the screens never
   * import and left the one they do import undeclared.
   */
  const owners: { name: string; spec: DocumentedScreen }[] = plan
    ? plan.screens
        .map((s) => ({ name: s.name, spec: coveredSpec(s, appSpec.documentedScreens) }))
        .filter((o): o is { name: string; spec: DocumentedScreen } => Boolean(o.spec))
    : appSpec.documentedScreens.map((s) => ({ name: s.name, spec: s }))

  const emitted = new Set<string>()

  for (const owner of owners) {
    const screen = { ...owner.spec, name: owner.name }
    if (emitted.has(formTypeName(screen.name))) continue
    emitted.add(formTypeName(screen.name))

    const fields = capturedFields(screen)
    if (fields.length === 0) continue

    const members = fields
      .map((field) => {
        const doc = docComment([field.notes], '  ')
        return `${doc}  ${key(demoFieldKey(field.label))}?: string   // ${field.label}`
      })
      .join('\n')

    blocks.push(
      `/** What the user entered on "${screen.name}". */\n` +
        `export interface ${formTypeName(screen.name)} {\n${members}\n}`,
    )
  }

  return blocks.join('\n\n')
}
