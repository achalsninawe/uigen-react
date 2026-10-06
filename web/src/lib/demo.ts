import type { AppSpec, Endpoint, Entity } from './types'

/**
 * The studio's half of the demo run: what the player types, and what every API
 * call answers while it plays.
 *
 * Nothing real is called during a demo. The values typed are the documents'
 * examples and whatever was typed when testing; the responses are the best
 * sample on hand — a real response saved by a test, then the documents'
 * example, then one made up from the response's fields — so every step
 * succeeds and the journey can be watched end to end.
 */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Every leaf of a payload, keyed by the name of the field that held it. */
function leaves(value: unknown, into: Record<string, string>, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 2)) leaves(item, into, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (inner !== null && typeof inner === 'object') leaves(inner, into, depth + 1)
    else if (inner !== undefined && inner !== null && inner !== '') {
      const k = norm(key)
      if (k && into[k] === undefined) into[k] = String(inner)
    }
  }
}

/** Values the player types into fields, matched by field name or label. */
export function demoValues(endpoints: Endpoint[]): Record<string, string> {
  const values: Record<string, string> = {}
  // What the person typed outranks the documents' examples.
  for (const e of endpoints) {
    leaves(e.lastTestInput?.body, values)
    leaves(e.lastTestInput?.pathParams, values)
    leaves(e.lastTestInput?.query, values)
  }
  for (const e of endpoints) {
    leaves(e.requestBody?.example, values)
    for (const p of [...e.pathParams, ...e.queryParams]) {
      const k = norm(p.name)
      if (p.example && values[k] === undefined) values[k] = p.example
    }
  }
  // A date field wants today, not the documents' 2026-04-20T00:00:00.
  for (const [k, v] of Object.entries(values)) {
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) values[k] = v.slice(0, 10)
  }
  return values
}

/** True when a body is an error's shape rather than a success. */
function looksLikeFailure(body: unknown): boolean {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false
  const r = body as Record<string, unknown>
  return r.result === 0 || r.success === false || 'error' in r || (Array.isArray(r.Errors) && r.Errors.length > 0)
}

function sampleScalar(name: string, type: string): unknown {
  const t = type.toLowerCase()
  const n = name.toLowerCase()
  if (/date|time|at$/.test(n)) return new Date().toISOString().slice(0, 10)
  if (/bool/.test(t)) return true
  if (/int|long|number|decimal|double|float/.test(t)) return /result|status/.test(n) ? 1 : 1000
  if (/email/.test(n)) return 'demo@example.com'
  if (/name/.test(n)) return 'Alex Demo'
  if (/number|no$|id$|code/.test(n)) return '1055864001'
  return 'Sample'
}

/** A made-up value of a declared type, from the entities the analysis recorded. */
function sampleOf(typeName: string, entities: Entity[], depth = 0): unknown {
  const array = /\[\]$/.test(typeName) || /^array$/i.test(typeName)
  const base = typeName.replace(/\[\]$/, '').trim()
  const entity = entities.find((e) => e.name === base)
  const one = (): unknown => {
    if (!entity || depth > 4) return array ? 'Sample' : {}
    const out: Record<string, unknown> = {}
    for (const field of entity.fields) {
      // Prose-derived names like "Policy Number" or "a.b.c" are not real keys.
      if (/[\s.[\]]/.test(field.name)) continue
      const nested = entities.some((e) => e.name === field.type.replace(/\[\]$/, ''))
      out[field.name] = nested ? sampleOf(field.type, entities, depth + 1) : sampleScalar(field.name, field.type)
    }
    return out
  }
  return array ? [one(), one()] : one()
}

/** The body a demo call answers with. Always a success. */
export function demoResponse(endpoint: Endpoint | undefined, appSpec: AppSpec | undefined): unknown {
  if (!endpoint) return {}
  const successes = endpoint.responses.filter((r) => /^2\d\d$|success|ok/i.test(r.status))
  const example = successes.find((r) => r.example !== undefined && !looksLikeFailure(r.example))?.example
  if (example !== undefined) return example
  const typeName = successes.find((r) => r.typeName)?.typeName
  if (typeName) return sampleOf(typeName, appSpec?.entities ?? [])
  return {}
}
