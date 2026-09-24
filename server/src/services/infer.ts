import { toPascalCase } from './emit/lang.js'
import type { Entity, EntityField } from '../types.js'

/**
 * Derives entity definitions from a real API response.
 *
 * Most documentation describes what an endpoint does and omits what it returns.
 * The response itself is a complete, authoritative answer to that question — so
 * rather than guess, or make the user write schemas by hand, one real call
 * supplies the shape. Nothing here is invented: every field and type comes from
 * bytes the API actually sent.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+)?(Z|[+-]\d{2}:?\d{2})?$/

type Shape =
  | { kind: 'primitive'; type: 'string' | 'number' | 'boolean' }
  | { kind: 'unknown' }
  | { kind: 'array'; item: Shape }
  | { kind: 'object'; fields: Map<string, { shape: Shape; optional: boolean }> }

function shapeOf(value: unknown): Shape {
  if (value === null || value === undefined) return { kind: 'unknown' }

  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'array', item: { kind: 'unknown' } }
    // Merge every element, so a field missing from one of them lands optional.
    return { kind: 'array', item: value.map(shapeOf).reduce(mergeShapes) }
  }

  if (typeof value === 'object') {
    const fields = new Map<string, { shape: Shape; optional: boolean }>()
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      fields.set(key, { shape: shapeOf(item), optional: item === null })
    }
    return { kind: 'object', fields }
  }

  if (typeof value === 'number') return { kind: 'primitive', type: 'number' }
  if (typeof value === 'boolean') return { kind: 'primitive', type: 'boolean' }
  return { kind: 'primitive', type: 'string' }
}

function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.kind === 'unknown') return b
  if (b.kind === 'unknown') return a

  if (a.kind === 'array' && b.kind === 'array') {
    return { kind: 'array', item: mergeShapes(a.item, b.item) }
  }

  if (a.kind === 'object' && b.kind === 'object') {
    const fields = new Map(a.fields)
    for (const [key, incoming] of b.fields) {
      const existing = fields.get(key)
      if (!existing) {
        // Present in one element but not the other, so not guaranteed.
        fields.set(key, { ...incoming, optional: true })
      } else {
        fields.set(key, {
          shape: mergeShapes(existing.shape, incoming.shape),
          optional: existing.optional || incoming.optional,
        })
      }
    }
    for (const [key, existing] of fields) {
      if (!b.fields.has(key)) fields.set(key, { ...existing, optional: true })
    }
    return { kind: 'object', fields }
  }

  // Genuinely different primitives: keep the first and let the UI narrow.
  return a
}

/** `coverages` -> `Coverage`, `insureds` -> `Insured`, `policy` -> `Policy`. */
function singularise(name: string): string {
  if (/(ies)$/i.test(name)) return name.replace(/ies$/i, 'y')
  if (/(ses|xes|zes|ches|shes)$/i.test(name)) return name.slice(0, -2)
  if (/s$/i.test(name) && !/ss$/i.test(name)) return name.slice(0, -1)
  return name
}

export interface InferredTypes {
  /** The type the endpoint resolves to, e.g. `QueryPolicyResponse`. */
  rootTypeName: string
  entities: Entity[]
}

/**
 * Turns a response body into named entities.
 *
 * Nested objects are named after the key that holds them, which keeps generated
 * code readable — `policy.policyInfo.policyBasicInfo.policyNumber` reads as
 * `Policy -> PolicyInfo -> PolicyBasicInfo`, matching the payload exactly.
 */
/**
 * @param allOptional Marks every field optional regardless of the sample.
 *
 * Use it for anything the API sends back. A shape learned from one response
 * proves a field CAN be there, never that it must be, but `required: true` tells
 * TypeScript it is guaranteed — and an optional chain stops at its first hop, so
 * `result?.FreelookResult.TotalRefundAmount` type-checks and then throws
 * "Cannot read properties of undefined" the first time the server omits that
 * node. Optional fields push the guard back to compile time, where the gate
 * catches it instead of the user.
 *
 * Request bodies keep their required flags: those describe what to send, and a
 * form needs to know which inputs are mandatory.
 */
export function inferTypes(
  body: unknown,
  rootName: string,
  reserved?: Set<string>,
  { allOptional = false }: { allOptional?: boolean } = {},
): InferredTypes {
  const entities: Entity[] = []
  // Seeded with names already in use, so a derived type never silently merges
  // with an unrelated one that happens to share a name.
  const taken = new Set<string>(reserved ?? [])
  // Identical shapes reuse one entity instead of producing near-duplicates.
  const bySignature = new Map<string, string>()

  const claim = (preferred: string): string => {
    const base = toPascalCase(preferred, 'Model')
    let name = base
    let n = 2
    while (taken.has(name)) name = `${base}${n++}`
    taken.add(name)
    reserved?.add(name)
    return name
  }

  const signature = (shape: Shape): string => {
    if (shape.kind === 'object') {
      return `{${[...shape.fields.entries()]
        .map(([k, v]) => `${k}:${signature(v.shape)}${v.optional ? '?' : ''}`)
        .sort()
        .join(',')}}`
    }
    if (shape.kind === 'array') return `${signature(shape.item)}[]`
    if (shape.kind === 'primitive') return shape.type
    return 'unknown'
  }

  const typeNameFor = (shape: Shape, preferredName: string): string => {
    switch (shape.kind) {
      case 'primitive':
        return shape.type
      case 'unknown':
        return 'unknown'
      case 'array':
        return `${typeNameFor(shape.item, singularise(preferredName))}[]`
      case 'object': {
        const sig = signature(shape)
        const existing = bySignature.get(sig)
        if (existing) return existing

        const name = claim(preferredName)
        bySignature.set(sig, name)

        // Registered before recursing, so a self-referencing shape terminates.
        const entity: Entity = { name, fields: [] }
        entities.push(entity)

        entity.fields = [...shape.fields.entries()].map(([key, value]): EntityField => ({
          name: key,
          type: typeNameFor(value.shape, key),
          required: allOptional ? false : !value.optional,
        }))

        return name
      }
    }
  }

  const rootShape = shapeOf(body)

  // A bare array response is common; name the item, not the wrapper.
  const rootTypeName =
    rootShape.kind === 'array'
      ? `${typeNameFor(rootShape.item, singularise(rootName))}[]`
      : typeNameFor(rootShape, rootName)

  return { rootTypeName, entities }
}

/** Notes which string fields carry ISO dates, so screens can format them. */
export function markDateFields(body: unknown, entities: Entity[]): void {
  const dateKeys = new Set<string>()

  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (typeof item === 'string' && ISO_DATE.test(item)) dateKeys.add(key)
        else walk(item)
      }
    }
  }
  walk(body)

  for (const entity of entities) {
    for (const field of entity.fields) {
      if (field.type === 'string' && dateKeys.has(field.name)) {
        field.description = field.description ?? 'ISO date-time'
      }
    }
  }
}
