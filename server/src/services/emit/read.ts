/**
 * src/lib/read.ts — reading a response whose shape the documents never gave.
 *
 * Emitted, not written by the model. Left to the model, the lookup came out
 * searching one level deep, and the real payload keeps `policyNumber` under
 * `policyInfo.policyBasicInfo`: every field rendered a dash while the value sat
 * in the list underneath. A search that covers any depth is ten lines of code
 * that only need to be right once.
 */
export const READ_HELPERS = `/**
 * Reads values out of an API response whose shape is not documented.
 * Emitted by Spec2UI — screens import from here rather than guessing paths.
 */

const MAX_DEPTH = 6

/** "Policy Number", "policy_no" and "policyNumber" all compare equal. */
function norm(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/number$/, 'no')
    .replace(/identifier$/, 'id')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Every (key, value) pair at any depth, nearest first, each object once. */
function* walk(source: unknown): Generator<[string, unknown]> {
  const seen = new WeakSet<object>()
  let level: unknown[] = [source]
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
    const next: unknown[] = []
    for (const node of level) {
      if (!isRecord(node) || seen.has(node)) continue
      seen.add(node)
      for (const [key, value] of Object.entries(node)) {
        yield [key, value]
        if (isRecord(value)) next.push(value)
      }
    }
    level = next
  }
}

/** A value as text: primitives as-is, a list as its size, absent as a dash. */
export function asText(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  if (Array.isArray(value)) {
    return value.every((v) => !isRecord(v) && !Array.isArray(v))
      ? value.map(String).join(', ')
      : value.length + (value.length === 1 ? ' item' : ' items')
  }
  if (isRecord(value)) return Object.keys(value).length + ' fields'
  return String(value)
}

/**
 * The raw value of the first key matching any of \`names\`, at any depth.
 * An exact match anywhere beats a partial one, so "currency" finds
 * "currency" before "premiumCurrencyCode".
 */
export function pickValue(source: unknown, ...names: string[]): unknown {
  const wanted = names.map(norm).filter(Boolean)
  if (wanted.length === 0) return undefined
  for (const [key, value] of walk(source)) {
    if (wanted.includes(norm(key)) && !isRecord(value)) return value
  }
  for (const [key, value] of walk(source)) {
    const k = norm(key)
    if (wanted.some((w) => k.includes(w)) && !isRecord(value)) return value
  }
  return undefined
}

/** As pickValue, as text ready to render. */
export function pick(source: unknown, ...names: string[]): string {
  return asText(pickValue(source, ...names))
}

/** "policyBasicInfo" -> "Policy Basic Info". */
export function humanize(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Every leaf of the response as label/value rows, nested objects expanded.
 * The same object reached twice is listed once.
 */
export function fieldsOf(source: unknown): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = []
  const seen = new WeakSet<object>()
  const visit = (node: unknown, trail: string[], depth: number) => {
    if (!isRecord(node) || seen.has(node) || depth > MAX_DEPTH) return
    seen.add(node)
    for (const [key, value] of Object.entries(node)) {
      if (isRecord(value)) visit(value, [...trail, humanize(key)], depth + 1)
      else rows.push({ label: [...trail, humanize(key)].join(' · '), value: asText(value) })
    }
  }
  visit(source, [], 0)
  return rows
}
`
