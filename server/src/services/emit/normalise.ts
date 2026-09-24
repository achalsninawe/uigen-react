import { primitiveFrom, toPascalCase } from './lang.js'
import type { AppSpec } from '../../types.js'

/**
 * Returns a copy of the spec whose type names are valid TypeScript and
 * resolvable.
 *
 * Documents name their data in prose — "Policy Information", "Refund Summary" —
 * and those names reach three places that must agree: the interfaces in
 * types.ts, the signatures in api.ts, and the type list shown to the model when
 * it writes a screen. Normalising in one place is what keeps them agreeing;
 * doing it per-emitter produced a types.ts that parsed and an api.ts that did
 * not.
 *
 * Two distinct things go wrong without this, and both end as compile errors in
 * emitted infrastructure — the one thing the design promises cannot happen:
 *
 *   A name that is not an identifier. A response typed "Project List Response"
 *   emits `Promise<Project List Response>`, which is a syntax error, and every
 *   function after it in the file is misparsed.
 *
 *   A name nothing declares. The analysis names a response type that never
 *   becomes an entity, so `Promise<ProjectSummary>` refers to an interface that
 *   is not in types.ts.
 *
 * Both are resolved here rather than in the emitters: a type is rewritten to
 * the entity it names, and a type naming nothing is `unknown`. `unknown` is a
 * real answer — the screen must narrow before it reads anything — where a
 * dangling name is a build that never runs.
 *
 * Idempotent, so a spec normalised once passes through untouched.
 */

/**
 * Names that mean something without an entity to declare them.
 *
 * The lowercase spellings are what extraction produces; `toTsType` converts
 * them at emission, so they must survive this pass intact.
 */
const BUILT_IN = new Set([
  'string',
  'number',
  'boolean',
  'bigint',
  'symbol',
  'object',
  'unknown',
  'any',
  'never',
  'void',
  'null',
  'undefined',
  'Date',
  'Blob',
  'File',
  'FormData',
  'Record',
  'Array',
  'Partial',
  'Promise',
  'integer',
  'float',
  'double',
  'long',
  'bool',
  'array',
  'file',
  'binary',
])

export function withSafeTypeNames(appSpec: AppSpec): AppSpec {
  /** Entity name as written, and as it will be declared in types.ts. */
  const safeNames = new Map<string, string>()
  const declared = new Set<string>()
  const taken = new Set<string>()

  for (const entity of appSpec.entities) {
    const base = toPascalCase(entity.name, 'Model')
    let safe = base
    let n = 2
    while (taken.has(safe)) safe = `${base}${n++}`
    taken.add(safe)
    declared.add(safe)
    safeNames.set(entity.name, safe)
  }

  /**
   * One name inside a type expression, resolved to something that will compile.
   *
   * Tried in order: the entity it names, the entity it names once tidied into
   * an identifier, a built-in. Anything left names nothing, and becomes
   * `unknown` rather than a reference to an interface that will not exist.
   */
  const resolveName = (raw: string): string => {
    const name = raw.trim()
    if (!name) return name

    const mapped = safeNames.get(name)
    if (mapped) return mapped

    if (BUILT_IN.has(name)) return name

    // A string-literal union member, e.g. 'open' | 'closed'.
    if (/^['"]/.test(name)) return name

    const pascal = toPascalCase(name, 'Model')
    if (declared.has(pascal)) return pascal

    /*
     * Nothing declares it. Keeping the name would emit a reference to an
     * interface types.ts does not contain, which fails to compile just as
     * surely as a name with a space in it — unless the word names a primitive,
     * as `UUID` and `Timestamp` do, in which case that is what the document
     * said and it can be taken at its word.
     */
    return primitiveFrom(name) ?? 'unknown'
  }

  /**
   * Rewrites a type expression, leaving `[]`, unions, intersections and generic
   * arguments intact. The character class admits spaces so that a multi-word
   * name is resolved whole rather than as several unrelated tokens.
   */
  const rewrite = <T extends string | undefined>(type: T): T => {
    if (!type) return type
    return type.replace(/[A-Za-z_$][\w $]*/g, (token) => {
      const trimmed = token.trim()
      const replacement = resolveName(trimmed)
      return replacement === trimmed ? token : token.replace(trimmed, replacement)
    }) as T
  }

  return {
    ...appSpec,
    entities: appSpec.entities.map((entity) => ({
      ...entity,
      name: safeNames.get(entity.name) ?? entity.name,
      fields: entity.fields.map((field) => ({ ...field, type: rewrite(field.type) })),
    })),
    endpoints: appSpec.endpoints.map((endpoint) => ({
      ...endpoint,
      ...(endpoint.requestBody
        ? { requestBody: { ...endpoint.requestBody, typeName: rewrite(endpoint.requestBody.typeName) } }
        : {}),
      responses: endpoint.responses.map((response) => ({
        ...response,
        typeName: rewrite(response.typeName),
      })),
    })),
  }
}
