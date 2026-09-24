import type { AuthSpec, BodySpec, Endpoint, Entity, EntityField, ParamSpec, ResponseSpec } from '../../types.js'

/**
 * Converts a dereferenced OpenAPI document into our domain model.
 *
 * This runs instead of the model, not alongside it: when a spec is machine
 * readable there is no reason to let an LLM paraphrase it. Everything here is a
 * direct structural read of the document.
 */

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const
type Method = (typeof METHODS)[number]

type Doc = Record<string, any>

/**
 * Maps schema objects back to their component names.
 *
 * SwaggerParser.dereference() replaces every `$ref` with the *same object
 * instance* it points at, so identity comparison recovers the name that the
 * `$ref` string used to carry. This has to happen during extraction: the
 * AppSpec is stored as JSON, and identity does not survive that trip.
 */
type SchemaNames = Map<object, string>

function buildSchemaNames(doc: Doc): SchemaNames {
  const names: SchemaNames = new Map()
  const schemas = (doc.components?.schemas ?? doc.definitions ?? {}) as Doc
  for (const [name, schema] of Object.entries(schemas)) {
    if (schema && typeof schema === 'object') names.set(schema as object, name)
  }
  return names
}

/**
 * Produces a JSON-safe copy of a dereferenced schema.
 *
 * Dereferencing turns a self-referencing type (`Comment.replies: Comment[]`)
 * into a genuinely cyclic object graph, which JSON.stringify refuses to
 * serialise — and every AppSpec is stored as JSON. Cycles become a named
 * marker the inspector can render, and depth is capped so a deeply nested
 * schema cannot bloat the stored document.
 */
function safeSchema(schema: unknown, names: SchemaNames, depth = 0, seen: Set<object> = new Set()): unknown {
  if (schema === null || typeof schema !== 'object') return schema
  const node = schema as object

  if (seen.has(node)) return { $circular: names.get(node) ?? true }
  if (depth > 8) return { $truncated: names.get(node) ?? true }

  const nextSeen = new Set(seen).add(node)

  if (Array.isArray(schema)) {
    return schema.map((item) => safeSchema(item, names, depth + 1, nextSeen))
  }

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    out[key] = safeSchema(value, names, depth + 1, nextSeen)
  }
  return out
}

function schemaTypeName(schema: any, names?: SchemaNames): string {
  if (!schema || typeof schema !== 'object') return 'unknown'

  const named = names?.get(schema as object)
  if (named) return named

  if (schema.$ref) return String(schema.$ref).split('/').pop() ?? 'unknown'
  if (schema.enum) return schema.enum.map((v: unknown) => JSON.stringify(v)).join(' | ')
  if (schema.oneOf) return schema.oneOf.map((s: unknown) => schemaTypeName(s, names)).join(' | ')
  if (schema.anyOf) return schema.anyOf.map((s: unknown) => schemaTypeName(s, names)).join(' | ')
  if (schema.allOf) return schema.allOf.map((s: unknown) => schemaTypeName(s, names)).join(' & ')
  if (schema.type === 'array') return `${schemaTypeName(schema.items, names)}[]`
  if (schema.format === 'date-time' || schema.format === 'date') return 'string'
  if (schema.type === 'integer') return 'number'
  return String(schema.type ?? 'unknown')
}

function toParam(p: Doc, names?: SchemaNames): ParamSpec {
  const location = ['path', 'query', 'header', 'cookie'].includes(p.in) ? p.in : 'query'
  return {
    name: String(p.name ?? ''),
    in: location,
    type: schemaTypeName(p.schema, names),
    required: Boolean(p.required) || location === 'path',
    ...(p.description ? { description: String(p.description) } : {}),
    ...(p.example !== undefined ? { example: String(p.example) } : {}),
    ...(Array.isArray(p.schema?.enum) ? { enum: p.schema.enum.map(String) } : {}),
  }
}

function toBody(requestBody: Doc | undefined, names: SchemaNames): BodySpec | undefined {
  const content = requestBody?.content
  if (!content || typeof content !== 'object') return undefined
  // Prefer JSON; fall back to whatever the doc offers first.
  const contentType = Object.keys(content).find((c) => c.includes('json')) ?? Object.keys(content)[0]
  if (!contentType) return undefined
  const media = content[contentType]
  return {
    contentType,
    ...(media?.schema
      ? { schema: safeSchema(media.schema, names), typeName: schemaTypeName(media.schema, names) }
      : {}),
    ...(media?.example !== undefined ? { example: safeSchema(media.example, names) } : {}),
    ...(requestBody?.description ? { description: String(requestBody.description) } : {}),
  }
}

function toResponses(responses: Doc | undefined, names: SchemaNames): ResponseSpec[] {
  if (!responses || typeof responses !== 'object') return []
  return Object.entries(responses).map(([status, value]) => {
    const res = value as Doc
    const content = res?.content ?? {}
    const contentType = Object.keys(content).find((c) => c.includes('json')) ?? Object.keys(content)[0]
    const media = contentType ? content[contentType] : undefined
    return {
      status,
      ...(res?.description ? { description: String(res.description) } : {}),
      ...(contentType ? { contentType } : {}),
      ...(media?.schema
        ? { schema: safeSchema(media.schema, names), typeName: schemaTypeName(media.schema, names) }
        : {}),
      ...(media?.example !== undefined ? { example: safeSchema(media.example, names) } : {}),
    }
  })
}

/** Resolves the security scheme that applies to an operation. */
function resolveAuth(doc: Doc, operation: Doc): AuthSpec {
  const requirement = operation.security ?? doc.security
  if (!Array.isArray(requirement) || requirement.length === 0) return { type: 'none' }

  const first = requirement[0]
  const schemeName = first && typeof first === 'object' ? Object.keys(first)[0] : undefined
  if (!schemeName) return { type: 'none' }

  const schemes = doc.components?.securitySchemes ?? doc.securityDefinitions ?? {}
  const scheme = schemes[schemeName] as Doc | undefined
  if (!scheme) return { type: 'custom', name: schemeName }

  const description = scheme.description ? String(scheme.description) : undefined

  if (scheme.type === 'http') {
    const httpScheme = String(scheme.scheme ?? '').toLowerCase()
    if (httpScheme === 'bearer') {
      return {
        type: 'bearer',
        name: 'Authorization',
        in: 'header',
        scheme: 'Bearer',
        ...(description ? { description } : {}),
      }
    }
    if (httpScheme === 'basic') {
      return {
        type: 'basic',
        name: 'Authorization',
        in: 'header',
        scheme: 'Basic',
        ...(description ? { description } : {}),
      }
    }
  }
  if (scheme.type === 'apiKey') {
    return {
      type: 'apiKey',
      name: String(scheme.name ?? 'X-API-Key'),
      in: (['header', 'query', 'cookie'] as const).find((l) => l === scheme.in) ?? 'header',
      ...(description ? { description } : {}),
    }
  }
  if (scheme.type === 'oauth2') {
    return {
      type: 'oauth2',
      name: 'Authorization',
      in: 'header',
      scheme: 'Bearer',
      ...(description ? { description } : {}),
    }
  }
  return { type: 'custom', name: schemeName, ...(description ? { description } : {}) }
}

/** `/v1/users/{userId}` + GET -> `getV1UsersByUserId`, deduped by the caller. */
export function deriveOperationId(method: string, path: string): string {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      const param = seg.match(/^[{:](.+?)\}?$/)
      return param?.[1] ? `by-${param[1]}` : seg
    })
  const words = [method.toLowerCase(), ...segments]
    .join('-')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
  const [head = 'call', ...rest] = words
  return head.toLowerCase() + rest.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('')
}

export function uniqueOperationId(candidate: string, taken: Set<string>): string {
  let name = candidate || 'call'
  let n = 2
  while (taken.has(name)) name = `${candidate}${n++}`
  taken.add(name)
  return name
}

function serversOf(doc: Doc): string[] {
  if (Array.isArray(doc.servers)) {
    return doc.servers
      .map((s: Doc) => {
        let url = String(s.url ?? '')
        // OpenAPI 3 server variables: substitute documented defaults.
        for (const [key, variable] of Object.entries((s.variables ?? {}) as Doc)) {
          if ((variable as Doc)?.default !== undefined) {
            url = url.replace(`{${key}}`, String((variable as Doc).default))
          }
        }
        return url
      })
      .filter(Boolean)
  }
  // Swagger 2
  if (doc.host) {
    const scheme = Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes[0] : 'https'
    return [`${scheme}://${doc.host}${doc.basePath ?? ''}`]
  }
  return []
}

function entitiesOf(doc: Doc, names: SchemaNames): Entity[] {
  const schemas = (doc.components?.schemas ?? doc.definitions ?? {}) as Doc
  return Object.entries(schemas)
    .filter(([, schema]) => (schema as Doc)?.type === 'object' || (schema as Doc)?.properties)
    .map(([name, schema]) => {
      const s = schema as Doc
      const required = new Set<string>(Array.isArray(s.required) ? s.required.map(String) : [])
      const fields: EntityField[] = Object.entries((s.properties ?? {}) as Doc).map(([fieldName, fieldSchema]) => {
        const f = fieldSchema as Doc
        // A property that *is* this schema would name itself; that is correct
        // for a self-referencing type and the emitter handles the recursion.
        return {
          name: fieldName,
          type: schemaTypeName(f, names),
          required: required.has(fieldName),
          ...(f?.description ? { description: String(f.description) } : {}),
        }
      })
      return {
        name,
        ...(s.description ? { description: String(s.description) } : {}),
        fields,
      }
    })
}

export interface OpenApiExtraction {
  title: string
  description: string
  servers: string[]
  endpoints: Endpoint[]
  entities: Entity[]
}

export function extractFromOpenApi(rawDoc: unknown, documentId: string): OpenApiExtraction {
  const doc = rawDoc as Doc
  const names = buildSchemaNames(doc)
  const servers = serversOf(doc)
  const baseUrl = servers[0] ?? ''
  const endpoints: Endpoint[] = []
  const taken = new Set<string>()

  for (const [pathTemplate, pathItemRaw] of Object.entries((doc.paths ?? {}) as Doc)) {
    const pathItem = pathItemRaw as Doc
    if (!pathItem || typeof pathItem !== 'object') continue

    // Parameters declared at path level apply to every operation beneath it.
    const sharedParams: Doc[] = Array.isArray(pathItem.parameters) ? pathItem.parameters : []

    for (const method of METHODS) {
      const operation = pathItem[method as Method] as Doc | undefined
      if (!operation || typeof operation !== 'object') continue

      const allParams = [...sharedParams, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]
        .filter((p) => p && typeof p === 'object')
        .map((p) => toParam(p, names))

      const operationId = uniqueOperationId(
        typeof operation.operationId === 'string' && operation.operationId
          ? operation.operationId.replace(/[^a-zA-Z0-9]+(.)/g, (_m, c: string) => c.toUpperCase())
          : deriveOperationId(method, pathTemplate),
        taken,
      )

      const requestBody = toBody(operation.requestBody as Doc | undefined, names)

      endpoints.push({
        id: operationId,
        operationId,
        name: String(operation.summary ?? `${method.toUpperCase()} ${pathTemplate}`),
        method: method.toUpperCase() as Endpoint['method'],
        path: pathTemplate,
        baseUrl,
        ...(operation.summary ? { summary: String(operation.summary) } : {}),
        ...(operation.description ? { description: String(operation.description) } : {}),
        tags: Array.isArray(operation.tags) ? operation.tags.map(String) : [],
        auth: resolveAuth(doc, operation),
        headers: allParams.filter((p) => p.in === 'header'),
        pathParams: allParams.filter((p) => p.in === 'path'),
        queryParams: allParams.filter((p) => p.in === 'query'),
        ...(requestBody ? { requestBody } : {}),
        responses: toResponses(operation.responses as Doc | undefined, names),
        sourceDocumentId: documentId,
        sourceQuote: `${method.toUpperCase()} ${pathTemplate}`,
      })
    }
  }

  return {
    title: String(doc.info?.title ?? 'API'),
    description: String(doc.info?.description ?? ''),
    servers,
    endpoints,
    entities: entitiesOf(doc, names),
  }
}
