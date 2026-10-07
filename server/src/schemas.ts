import { z } from 'zod'

/**
 * Zod mirrors of the model-authored parts of the domain types.
 *
 * These are deliberately forgiving about optional fields — a doc that never
 * mentions auth should not cause a validation loop — but strict about the
 * fields that downstream emitters depend on.
 */

/**
 * A list of strings, however the model chose to express it.
 *
 * Asked for validation rules it may return ["Policy No. mandatory"], or
 * [{ rule: "Policy No. mandatory" }], or [{ field: "Policy No.", message: "..." }].
 * All three say the same thing, and rejecting two of them fails the whole
 * analysis over formatting. Anything object-shaped is reduced to its most
 * readable text rather than refused.
 */
const TEXT_KEYS = ['rule', 'description', 'text', 'message', 'label', 'name', 'value', 'title', 'detail']

export const looseStrings = z.preprocess((value) => {
  if (!Array.isArray(value)) return value === undefined ? [] : [value]

  return value
    .map((item) => {
      if (typeof item === 'string') return item
      if (item === null || item === undefined) return ''
      if (typeof item !== 'object') return String(item)

      const record = item as Record<string, unknown>
      for (const key of TEXT_KEYS) {
        if (typeof record[key] === 'string' && record[key]) return record[key] as string
      }
      // No obvious text field: join what it does have, so nothing is lost.
      const parts = Object.entries(record)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
        .map(([k, v]) => `${k}: ${v}`)
      return parts.length ? parts.join(', ') : ''
    })
    .filter((s) => s.trim().length > 0)
}, z.array(z.string()))

/**
 * null -> undefined, so a `.default()` or `.optional()` applies rather than
 * the whole reply failing. Models emit `null` for "not applicable" constantly.
 */
const nullable = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === null ? undefined : value), schema)

/** The first non-empty string among these keys of a record. */
function firstString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

/** "Yes" / "true" / true all mean the same thing in a requirements table. */
function boolish(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return /^(y|yes|true|required|mandatory)$/i.test(value.trim())
  return fallback
}

export const paramSchema = z.object({
  name: z.string(),
  in: z.enum(['path', 'query', 'header', 'cookie']).optional(),
  type: z.string().default('string'),
  required: z.boolean().default(false),
  description: z.string().optional(),
  example: z.string().optional(),
  enum: looseStrings.optional(),
})

/**
 * Parameters, with their location taken from the array they arrived in.
 *
 * Models routinely omit `in`, and a default of "query" turns an `Authorization`
 * header into a query string parameter. Which list the model chose to put a
 * parameter in is the clearer statement of intent, so that wins.
 */
const paramsIn = (location: 'path' | 'query' | 'header') =>
  nullable(
    z
      .array(paramSchema)
      .default([])
      .transform((params) => params.map((p) => ({ ...p, in: location }))),
  )

export const bodySchema = z.object({
  contentType: z.string().default('application/json'),
  schema: z.unknown().optional(),
  example: z.unknown().optional(),
  description: z.string().optional(),
})

export const responseSchema = z.object({
  status: z.union([z.string(), z.number()]).transform(String),
  description: z.string().optional(),
  contentType: z.string().optional(),
  schema: z.unknown().optional(),
  example: z.unknown().optional(),
  /**
   * Dotted paths, when the document names the fields instead of showing a body.
   * A shape is reconstructed from them, so the screen has something to render.
   */
  fields: looseStrings.optional(),
})

/**
 * Auth, with the details a scheme implies filled in.
 *
 * A document saying "requires a bearer token" states the scheme by naming it,
 * but models report only `type: "bearer"` and leave `scheme` empty — and an
 * empty scheme means the credential is sent raw, without the `Bearer ` prefix,
 * which every such API rejects. The implied values are restored here.
 */
const authObject = z
  .object({
    type: z.enum(['none', 'bearer', 'apiKey', 'basic', 'oauth2', 'custom']).default('none'),
    name: z.string().optional(),
    in: z.enum(['header', 'query', 'cookie']).optional(),
    scheme: z.string().optional(),
    description: z.string().optional(),
  })
  .transform((raw) => {
    // A reply of `{ type: "none", name: "Authorization", scheme: "Bearer" }`
    // contradicts itself. The specific fields are the real signal — "none" is
    // just what an omitted `type` falls back to — so let them decide.
    let auth = raw
    if (auth.type === 'none' && (auth.scheme || auth.name)) {
      const scheme = auth.scheme?.toLowerCase()
      const name = auth.name?.toLowerCase()
      if (scheme === 'bearer' || name === 'authorization') auth = { ...auth, type: 'bearer' }
      else if (scheme === 'basic') auth = { ...auth, type: 'basic' }
      else if (auth.name) auth = { ...auth, type: 'apiKey' }
    }

    if (auth.type === 'bearer' || auth.type === 'oauth2') {
      return {
        ...auth,
        name: auth.name || 'Authorization',
        in: auth.in ?? ('header' as const),
        scheme: auth.scheme || 'Bearer',
      }
    }
    if (auth.type === 'basic') {
      return {
        ...auth,
        name: auth.name || 'Authorization',
        in: auth.in ?? ('header' as const),
        scheme: auth.scheme || 'Basic',
      }
    }
    if (auth.type === 'apiKey') {
      return { ...auth, name: auth.name || 'X-API-Key', in: auth.in ?? ('header' as const) }
    }
    return auth
  })

/**
 * Auth, however the model chose to express it.
 *
 * Asked what protects an endpoint it answers `{ type: "bearer" }`, or plain
 * `"bearer"`, or `"Bearer Token"` — one fact, three spellings. Only the first
 * used to validate, and because one bad field fails the entire reply, eight
 * `auth: "none"` strings were enough to discard every screen extracted
 * alongside them.
 */
function authType(value: string): string {
  const text = value.toLowerCase()
  if (text.includes('bearer')) return 'bearer'
  if (text.includes('oauth')) return 'oauth2'
  if (text.includes('basic')) return 'basic'
  if (text.includes('key')) return 'apiKey'
  if (text.includes('none') || text.includes('no auth')) return 'none'
  return 'custom'
}

export const authSchema = z.preprocess((value) => {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return { type: authType(value) }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.type === 'string') return { ...record, type: authType(record.type) }
  }
  return value
}, authObject)

const HTTP_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

/**
 * An endpoint whose verb the document never stated.
 *
 * A requirements document says "the SEARCH button calls the Policy Search API"
 * and stops, so the analyze prompt tells the model not to present a guessed verb
 * as documented — and it answers `method: ""`. Left strict, that one empty
 * string failed the whole reply three times over and the analysis produced
 * nothing at all, which is far worse than an assumption nobody hid: a body to
 * send means POST, otherwise GET, and `methodAssumed` makes it reportable so it
 * shows up as a gap instead of passing for fact.
 */
export const endpointSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>

  const stated = typeof record.method === 'string' ? record.method.trim().toUpperCase() : ''
  if ((HTTP_VERBS as readonly string[]).includes(stated)) return { ...record, method: stated }

  return { ...record, method: record.requestBody ? 'POST' : 'GET', methodAssumed: true }
}, z.object({
  name: z.string(),
  method: z.enum(HTTP_VERBS),
  /** True when the verb was inferred because the document did not state one. */
  methodAssumed: z.boolean().optional(),
  path: z.string(),
  baseUrl: z.string().default(''),
  summary: z.string().optional(),
  description: z.string().optional(),
  tags: looseStrings.default([]),
  auth: authSchema.default({ type: 'none' }),
  headers: paramsIn('header'),
  pathParams: paramsIn('path'),
  queryParams: paramsIn('query'),
  requestBody: nullable(bodySchema.optional()),
  responses: nullable(z.array(responseSchema).default([])),
  sourceQuote: z.string().optional(),
}))

export const entitySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  fields: z
    .array(
      z.object({
        name: z.string(),
        type: z.string().default('string'),
        required: z.boolean().default(false),
        description: z.string().optional(),
      }),
    )
    .default([]),
})

export const flowSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z
    .array(
      z.object({
        order: z.number().default(0),
        actor: z.string().optional(),
        action: z.string(),
        screenHint: z.string().optional(),
        endpointRefs: looseStrings.default([]),
      }),
    )
    .default([]),
})

export const gapSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const detail = firstString(record, 'detail', 'description', 'details', 'message', 'issue')
  const topic =
    firstString(record, 'topic', 'title', 'area', 'subject', 'name') ??
    // A gap with only prose is still a gap; name it from its own first clause.
    detail?.split(/[.:—-]/)[0]?.trim().slice(0, 60)
  return { ...record, ...(topic ? { topic } : {}), ...(detail ? { detail } : {}) }
}, z.object({
  severity: z.enum(['info', 'warning']).default('info'),
  topic: z.string(),
  detail: z.string(),
  suggestion: z.string().optional(),
}))

/**
 * A field of a documented screen, under whichever key names the model used.
 *
 * The analyze prompt says what to capture — "every field listed, with its type,
 * whether it is mandatory, and a dropdown's values" — but never dictates JSON
 * key names, so the model writes what that prose implies: `name`, `mandatory`,
 * `values`. This schema demanded `label`, `required`, `options`, and the three
 * renames alone produced 62 of 84 validation errors on a real requirements
 * document. Because the reply is validated as a whole, and `screens` carries
 * `.default([])`, the repair round then satisfied the schema by dropping every
 * screen it had just read correctly — five of six vanished with nothing logged.
 * Accepting both vocabularies is the fix; demanding one of them is not.
 */
const screenFieldSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const label = firstString(record, 'label', 'name', 'field', 'fieldName', 'title')
  const type = firstString(record, 'type', 'fieldType', 'control', 'inputType')
  return {
    ...record,
    ...(label ? { label } : {}),
    ...(type ? { type } : {}),
    required: boolish(record.required ?? record.mandatory ?? record.isRequired),
    // A "Read-Only Text" field states it is read-only in its type and nowhere else.
    readOnly: boolish(
      record.readOnly ?? record.readonly ?? record.isReadOnly,
      /read[s-]*only/i.test(type ?? ''),
    ),
    options: record.options ?? record.values ?? record.enum ?? record.choices ?? [],
    notes: firstString(record, 'notes', 'note', 'description', 'remark', 'comment'),
  }
}, z.object({
  label: z.string(),
  type: z.string().optional(),
  required: z.boolean().default(false),
  readOnly: z.boolean().default(false),
  notes: z.string().optional(),
  options: looseStrings.default([]),
}))

/** A button, under whichever key names the model used. */
const screenActionSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const label = firstString(record, 'label', 'name', 'button', 'control', 'action')
  const does = firstString(record, 'does', 'behaviour', 'behavior', 'description', 'effect', 'purpose')
  return {
    ...record,
    ...(label ? { label } : {}),
    ...(does ? { does } : {}),
    calls: firstString(record, 'calls', 'api', 'endpoint', 'callsApi'),
    enabledWhen: firstString(record, 'enabledWhen', 'enabled', 'condition', 'when'),
    navigatesTo: firstString(record, 'navigatesTo', 'goesTo', 'leadsTo', 'target', 'destination', 'nextScreen'),
  }
}, z.object({
  label: z.string(),
  does: z.string().default(''),
  /** Prose reference; resolved to operationIds by the linking pass. */
  calls: z.string().optional(),
  enabledWhen: z.string().optional(),
  /** Screen this button leads to, as the document names it. */
  navigatesTo: z.string().optional(),
}))

export const documentedScreenSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const name = firstString(record, 'name', 'screen', 'title', 'screenName')
  // "leads to" may arrive as a list; the first entry is the onward screen.
  const next = record.navigatesTo ?? record.leadsTo ?? record.nextScreen
  const navigatesTo = Array.isArray(next)
    ? next.find((n) => typeof n === 'string')
    : typeof next === 'string'
      ? next
      : undefined
  return {
    ...record,
    ...(name ? { name } : {}),
    ...(navigatesTo ? { navigatesTo } : { navigatesTo: undefined }),
    purpose: firstString(record, 'purpose', 'description', 'intent') ?? '',
    fields: record.fields ?? record.inputs ?? [],
    actions: record.actions ?? record.buttons ?? record.controls ?? [],
    validation: record.validation ?? record.validations ?? record.rules ?? [],
  }
}, z.object({
  name: z.string(),
  purpose: z.string().default(''),
  order: z.coerce.number().default(0),
  fields: nullable(z.array(screenFieldSchema).default([])),
  actions: nullable(z.array(screenActionSchema).default([])),
  navigatesTo: z.string().optional(),
  validation: looseStrings.default([]),
}))

/** What the analyze pass returns. */
export const analysisSchema = z.object({
  appName: z.string().default('Generated App'),
  description: z.string().default(''),
  servers: looseStrings.default([]),
  entities: z.array(entitySchema).default([]),
  endpoints: z.array(endpointSchema).default([]),
  flows: z.array(flowSchema).default([]),
  screens: z.array(documentedScreenSchema).default([]),
  gaps: z.array(gapSchema).default([]),
})

export type Analysis = z.infer<typeof analysisSchema>

/**
 * Models are inconsistent about what they call this field, and an empty array
 * here is catastrophic rather than cosmetic: a screen with no endpoints gets
 * generated as a static mockup with no data in it. So accept every spelling
 * that has shown up in practice, at both the section and screen level.
 */
const endpointRefs = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  const merged = new Set<string>()
  for (const alias of ['endpoints', 'endpointIds', 'operationIds', 'operations', 'apis']) {
    const candidate = record[alias]
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === 'string') {
          merged.add(item)
          continue
        }
        // Some replies wrap each reference as { operationId: '...' }.
        if (item && typeof item === 'object') {
          const nested = (item as Record<string, unknown>).operationId
          if (typeof nested === 'string') merged.add(nested)
        }
      }
    }
  }
  return { ...record, endpoints: [...merged] }
}, z.object({}).passthrough())

/** What the plan pass returns. */
export const planSchema = z.object({
  screens: z
    .array(
      z.preprocess(
        (v) => (endpointRefs.parse(v) as Record<string, unknown>),
        z.object({
          name: z.string(),
          route: z.string(),
          type: z
            .enum(['dashboard', 'list', 'detail', 'form', 'wizard', 'auth', 'settings', 'search', 'empty'])
            .default('list'),
          purpose: z.string().default(''),
          icon: z.string().default('Square'),
          showInNav: z.boolean().default(true),
          notes: z.string().optional(),
          /** Copy for the band that opens the screen. Absent means no band. */
          hero: nullable(
            z
              .object({
                eyebrow: z.string().optional(),
                headline: z.string(),
                sub: z.string().optional(),
              })
              .optional(),
          ),
          /** Heading for the running summary beside the screen, when it has one. */
          aside: nullable(
            z.object({ title: z.string(), headline: z.string().optional() }).optional(),
          ),
          /** Documented screens this one covers, when it covers more than its own. */
          covers: looseStrings.default([]),
          /** Screen-level references, merged with the per-section ones. */
          endpoints: looseStrings.default([]),
          sections: z
            .array(
              z.preprocess(
                (v) => (endpointRefs.parse(v) as Record<string, unknown>),
                z.object({
                  title: z.string(),
                  kind: z
                    .enum(['table', 'form', 'cards', 'stats', 'detail', 'timeline', 'chart', 'text'])
                    .default('text'),
                  description: z.string().default(''),
                  /** operationIds of endpoints this section uses. */
                  endpoints: looseStrings.default([]),
                }),
              ),
            )
            .default([]),
        }),
      ),
    )
    .min(1),
  theme: z
    .object({
      accent: z.string().default('#6C63FF'),
      mood: z.enum(['calm', 'vivid', 'corporate', 'playful']).default('calm'),
      density: z.enum(['comfortable', 'compact']).default('comfortable'),
    })
    .default({ accent: '#6C63FF', mood: 'calm', density: 'comfortable' }),
  /**
   * Whether the screens are steps of one process walked in order. Absent on
   * older replies; the pipeline then falls back to reading the screen graph.
   */
  journey: z.boolean().optional().catch(undefined),
  designNotes: looseStrings.default([]),
})

export type PlanResult = z.infer<typeof planSchema>

/** What the cross-document linking pass returns. */
export const linkSchema = z.object({
  links: z
    .array(
      z.object({
        flow: z.string(),
        step: z.coerce.number(),
        operationIds: looseStrings.default([]),
        why: z.string().optional(),
      }),
    )
    .default([]),
  actionLinks: z
    .array(
      z.object({
        screen: z.string(),
        action: z.string(),
        operationIds: looseStrings.default([]),
        why: z.string().optional(),
      }),
    )
    .default([]),
})

export type LinkResult = z.infer<typeof linkSchema>

/**
 * Where each value in a request body comes from, as the binding pass reads the
 * documents. Every entry is checked against the example afterwards, so this
 * only has to be well-formed, not right.
 */
const scalarText = z.union([z.string(), z.number(), z.boolean()]).transform(String)

export const bindSchema = z.object({
  bindings: z
    .array(
      z.object({
        operationId: z.string(),
        path: z.string(),
        field: z.string().nullish(),
        template: z.string().nullish(),
        responseOperationId: z.string().nullish(),
        generated: z.enum(['empty', 'now']).nullish().catch(undefined),
        responsePath: z.string().nullish(),
      }),
    )
    .default([]),
  options: z
    .array(
      z.object({
        field: z.string(),
        options: z.array(z.object({ value: scalarText, label: scalarText })).default([]),
      }),
    )
    .default([]),
  unclear: z.array(z.object({ field: z.string(), reason: z.string().default('') })).default([]),
})

export const resetSchema = z.object({
  reset: z
    .array(
      z.object({
        path: z.string(),
        as: z.enum(['empty', 'now']).catch('empty'),
        why: z.string().default(''),
      }),
    )
    .default([]),
})

/* ------------------------------------------------------------------ */
/* AI builder                                                        */
/* ------------------------------------------------------------------ */

/** Which endpoints are safe to call once for a real response, and with what. */
export const samplesSchema = z.object({
  endpoints: z
    .array(
      z.object({
        operationId: z.string(),
        /** True only when calling it cannot change data: a read, search, query or quotation. */
        readOnly: z.boolean().default(false),
        why: z.string().default(''),
        pathParams: nullable(z.record(z.unknown()).optional()),
        query: nullable(z.record(z.unknown()).optional()),
        body: z.unknown().optional(),
      }),
    )
    .default([]),
})

export type SamplesResult = z.infer<typeof samplesSchema>

/** The whole app as the AI designs it, before any screen is written. */
export const designSchema = z.object({
  /** True when the screens are one journey walked in order, e.g. search → review → submit. */
  journey: z.boolean().default(false),
  screens: z
    .array(
      z.object({
        name: z.string(),
        route: z.string(),
        type: z
          .enum(['dashboard', 'list', 'detail', 'form', 'wizard', 'auth', 'settings', 'search', 'empty'])
          .catch('form'),
        purpose: z.string().default(''),
        icon: z.string().default('Square'),
        showInNav: z.boolean().default(true),
        hero: nullable(
          z.object({ eyebrow: z.string().optional(), headline: z.string(), sub: z.string().optional() }).optional(),
        ),
        aside: nullable(z.object({ title: z.string(), headline: z.string().optional() }).optional()),
        /** API functions this screen calls itself. */
        calls: looseStrings.default([]),
        /**
         * TypeScript type of what arrives in router state, written over the
         * emitted types as `T.Name`, or empty when the screen receives nothing.
         */
        receives: z.string().default(''),
        /** Screens this one navigates to. */
        navigatesTo: looseStrings.default([]),
        /** The build brief: what it shows, every field and button, validation, what it passes on. */
        brief: z.string().default(''),
      }),
    )
    .min(1),
  theme: z
    .object({
      accent: z.string().default('#6C63FF'),
      mood: z.enum(['calm', 'vivid', 'corporate', 'playful']).catch('calm'),
      density: z.enum(['comfortable', 'compact']).catch('comfortable'),
    })
    .default({ accent: '#6C63FF', mood: 'calm', density: 'comfortable' }),
  designNotes: looseStrings.default([]),
})

export type DesignResult = z.infer<typeof designSchema>
