import { deriveOperationId, uniqueOperationId } from './openapi.js'
import { inferTypes } from '../infer.js'
import { toPascalCase } from '../emit/lang.js'
import type { Endpoint, Entity, ParamSpec } from '../../types.js'

/**
 * Structural reader for Postman collections.
 *
 * Postman is how most teams actually hold an API: a folder of real calls that
 * someone has run, with real headers, real bodies and real saved responses. Read
 * as generic JSON it was worse than useless — a collection stores a URL split
 * across `{ host: [...], path: [...] }` and a model asked to reassemble those
 * produces plausible addresses that 404. Everything here is copied, never
 * inferred, exactly as the OpenAPI reader works.
 */

type Doc = Record<string, any>

export interface PostmanExtraction {
  title: string
  description: string
  servers: string[]
  endpoints: Endpoint[]
  entities: Entity[]
}

/** Collection v2.x: `info.schema` names the format; v1 uses a `requests` array. */
export function looksLikePostman(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false
  const d = doc as Doc
  const schema = d.info?.schema
  if (typeof schema === 'string' && /getpostman\.com\/json\/collection/i.test(schema)) return true
  // Some exports drop the schema line; an info block beside items is enough.
  return Boolean(d.info && Array.isArray(d.item))
}

/**
 * Resolves `{{baseUrl}}` against the collection's own variables.
 *
 * A collection that never resolves its variables yields `{{host}}/orders` as a
 * base URL, which reaches nothing. Unresolved names are left alone rather than
 * blanked, so they surface as a gap instead of a silently broken address.
 */
function substitute(value: string, variables: Map<string, string>): string {
  return value.replace(/\{\{([^}]+)\}\}/g, (whole, name: string) => variables.get(name.trim()) ?? whole)
}

function collectVariables(doc: Doc): Map<string, string> {
  const variables = new Map<string, string>()
  for (const entry of Array.isArray(doc.variable) ? doc.variable : []) {
    if (entry?.key && typeof entry.value === 'string') variables.set(String(entry.key), entry.value)
  }
  // A variable may itself reference another; two passes settle the common case.
  for (const [key, value] of variables) variables.set(key, substitute(value, variables))
  return variables
}

/** Rebuilds the full URL from whichever representation the export used. */
function urlOf(url: unknown, variables: Map<string, string>): string {
  if (typeof url === 'string') return substitute(url, variables)
  if (!url || typeof url !== 'object') return ''

  const u = url as Doc
  if (typeof u.raw === 'string' && u.raw.trim()) {
    return substitute(u.raw.trim(), variables).split('?')[0]!
  }

  const protocol = u.protocol ? `${u.protocol}://` : ''
  const host = Array.isArray(u.host) ? u.host.join('.') : typeof u.host === 'string' ? u.host : ''
  const port = u.port ? `:${u.port}` : ''
  const segments = Array.isArray(u.path)
    ? u.path.map((p: unknown) => (typeof p === 'string' ? p : (p as Doc)?.value ?? '')).filter(Boolean)
    : []

  return substitute(`${protocol}${host}${port}/${segments.join('/')}`, variables)
}

/**
 * Splits a full URL into base and path at the last path segment.
 *
 * Postman records the whole address per request, so the split is ours to choose;
 * keeping every segment before the operation's own name on the base side is what
 * the OpenAPI reader and the prose extractor both do, and reconcile compares
 * full URLs anyway.
 */
function splitUrl(full: string): { baseUrl: string; path: string } {
  const match = full.match(/^(https?:\/\/[^/]+)(\/.*)?$/i)
  if (!match) return { baseUrl: '', path: full.startsWith('/') ? full : `/${full}` }

  const origin = match[1]!
  const rest = match[2] ?? '/'
  const segments = rest.split('/').filter(Boolean)
  if (segments.length === 0) return { baseUrl: origin, path: '/' }

  const last = segments.pop()!
  const prefix = segments.length ? `/${segments.join('/')}` : ''
  return { baseUrl: `${origin}${prefix}`, path: `/${last}` }
}

/** `:orderId` in a Postman path is the same idea as `{orderId}` in OpenAPI. */
function pathParamsOf(path: string, url: unknown): ParamSpec[] {
  const names = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!)
  const declared = new Map<string, string>()
  const variables = (url as Doc)?.variable
  for (const entry of Array.isArray(variables) ? variables : []) {
    if (entry?.key) declared.set(String(entry.key), String(entry.value ?? ''))
  }

  return names.map((name) => ({
    name,
    in: 'path' as const,
    type: 'string',
    required: true,
    ...(declared.get(name) ? { example: declared.get(name)! } : {}),
  }))
}

function queryParamsOf(url: unknown, variables: Map<string, string>): ParamSpec[] {
  const raw = (url as Doc)?.query
  const entries: ParamSpec[] = []

  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry?.key || entry.disabled) continue
    entries.push({
      name: String(entry.key),
      in: 'query',
      type: 'string',
      required: false,
      ...(entry.value ? { example: substitute(String(entry.value), variables) } : {}),
      ...(entry.description ? { description: String(entry.description) } : {}),
    })
  }

  return entries
}

/**
 * Transport headers a browser or Postman adds are not API parameters.
 *
 * Kept in step with the same list the prose pipeline strips, so a collection and
 * a devtools capture of the same call produce the same endpoint.
 */
const TRANSPORT_HEADERS = new Set([
  'accept', 'accept-encoding', 'accept-language', 'cache-control', 'connection',
  'content-length', 'cookie', 'host', 'origin', 'pragma', 'referer', 'user-agent',
  'postman-token', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
])

/** Reads Postman's `auth` block, which folders and the collection also carry. */
function authBlock(declared: Doc | undefined): Endpoint['auth'] | undefined {
  if (!declared?.type) return undefined
  if (declared.type === 'bearer') {
    return { type: 'bearer', name: 'Authorization', in: 'header', scheme: 'Bearer' }
  }
  if (declared.type === 'basic') {
    return { type: 'basic', name: 'Authorization', in: 'header', scheme: 'Basic' }
  }
  if (declared.type === 'apikey') {
    const entries = Array.isArray(declared.apikey) ? declared.apikey : []
    const key = entries.find((e: Doc) => e?.key === 'key')?.value
    const inQuery = entries.find((e: Doc) => e?.key === 'in')?.value === 'query'
    return { type: 'apiKey', name: key ? String(key) : 'X-API-Key', in: inQuery ? 'query' : 'header' }
  }
  if (declared.type === 'oauth2') {
    return { type: 'oauth2', name: 'Authorization', in: 'header', scheme: 'Bearer' }
  }
  return undefined
}

/**
 * @param inherited Auth declared on the collection or an enclosing folder.
 *
 * Collections normally state credentials once at the top and leave every request
 * to inherit them, so reading only the request block reported `auth: none` for
 * most of a collection — and an endpoint emitted without auth sends no
 * credential and comes back 401.
 */
function headersOf(request: Doc, inherited: Endpoint['auth']): { headers: ParamSpec[]; auth: Endpoint['auth'] } {
  const headers: ParamSpec[] = []
  let auth: Endpoint['auth'] = inherited

  for (const entry of Array.isArray(request.header) ? request.header : []) {
    if (!entry?.key || entry.disabled) continue
    const name = String(entry.key)
    const lower = name.toLowerCase()
    if (TRANSPORT_HEADERS.has(lower)) continue

    if (lower === 'authorization') {
      const value = String(entry.value ?? '')
      const scheme = value.split(/\s+/)[0] ?? ''
      auth = /^bearer$/i.test(scheme)
        ? { type: 'bearer', name, in: 'header', scheme: 'Bearer' }
        : /^basic$/i.test(scheme)
          ? { type: 'basic', name, in: 'header', scheme: 'Basic' }
          : { type: 'apiKey', name, in: 'header' }
      continue
    }
    if (lower === 'content-type') continue

    headers.push({ name, in: 'header', type: 'string', required: false })
  }

  // An auth block on the request itself outranks both the header and the
  // collection default.
  const own = authBlock(request.auth as Doc | undefined)
  if (own) auth = own

  return { headers, auth }
}

/** Postman stores a JSON body as a string; types come from the parsed object. */
function parseBody(request: Doc): unknown {
  const body = request.body as Doc | undefined
  if (!body) return undefined

  if (body.mode === 'raw' && typeof body.raw === 'string' && body.raw.trim()) {
    try {
      return JSON.parse(body.raw)
    } catch {
      return body.raw
    }
  }

  if (body.mode === 'urlencoded' || body.mode === 'formdata') {
    const entries = Array.isArray(body[body.mode]) ? body[body.mode] : []
    const object: Record<string, unknown> = {}
    for (const entry of entries) {
      if (entry?.key && !entry.disabled) object[String(entry.key)] = entry.value ?? ''
    }
    return Object.keys(object).length ? object : undefined
  }

  return undefined
}

/** Walks folders, which nest arbitrarily deep, carrying auth down as it goes. */
function* eachRequest(
  items: unknown,
  trail: string[] = [],
  inherited: Endpoint['auth'] = { type: 'none' },
): Generator<{ item: Doc; trail: string[]; auth: Endpoint['auth'] }> {
  for (const raw of Array.isArray(items) ? items : []) {
    const item = raw as Doc
    if (!item || typeof item !== 'object') continue

    const scoped = authBlock(item.auth as Doc | undefined) ?? inherited
    if (Array.isArray(item.item)) {
      yield* eachRequest(item.item, [...trail, String(item.name ?? '')], scoped)
      continue
    }
    if (item.request) yield { item, trail, auth: scoped }
  }
}

export function extractFromPostman(rawDoc: unknown, documentId: string): PostmanExtraction {
  const doc = rawDoc as Doc
  const variables = collectVariables(doc)
  const endpoints: Endpoint[] = []
  const entities: Entity[] = []
  const servers = new Set<string>()
  const taken = new Set<string>()

  const collectionAuth = authBlock(doc.auth as Doc | undefined) ?? ({ type: 'none' } as Endpoint['auth'])

  for (const { item, trail, auth: inherited } of eachRequest(doc.item, [], collectionAuth)) {
    const request = (typeof item.request === 'string' ? { url: item.request } : item.request) as Doc
    const method = String(request.method ?? 'GET').toUpperCase()
    const full = urlOf(request.url, variables)
    if (!full) continue

    const { baseUrl, path } = splitUrl(full)
    if (baseUrl) servers.add(baseUrl)

    const operationId = uniqueOperationId(deriveOperationId(method, path), taken)
    const { headers, auth } = headersOf(request, inherited)
    const name = String(item.name ?? operationId)

    const endpoint: Endpoint = {
      id: operationId,
      operationId,
      name,
      method: method as Endpoint['method'],
      path,
      baseUrl,
      ...(trail.filter(Boolean).length ? { summary: trail.filter(Boolean).join(' / ') } : {}),
      ...(typeof request.description === 'string' ? { description: request.description } : {}),
      tags: trail.filter(Boolean),
      auth,
      headers,
      pathParams: pathParamsOf(path, request.url),
      queryParams: queryParamsOf(request.url, variables),
      responses: [],
      sourceQuote: `${method} ${full}`,
    }

    const body = parseBody(request)
    if (body !== undefined) {
      const typeName = `${toPascalCase(operationId, 'Request')}Request`
      endpoint.requestBody = { contentType: 'application/json', example: body, typeName }
      if (body && typeof body === 'object') {
        entities.push(...inferTypes(body, typeName).entities)
      }
    }

    /*
     * Saved responses are the best part of a collection: a real payload, already
     * returned by the real server. They give the generated screens their types
     * without anyone having to describe a schema by hand.
     */
    for (const saved of Array.isArray(item.response) ? item.response : []) {
      const response = saved as Doc
      const status = String(response.code ?? response.status ?? 200)
      if (!/^\d{3}$/.test(status)) continue

      let parsed: unknown
      try {
        parsed = typeof response.body === 'string' ? JSON.parse(response.body) : response.body
      } catch {
        parsed = undefined
      }
      if (parsed === undefined || parsed === null) continue

      const typeName = `${toPascalCase(operationId, 'Response')}Response`
      if (endpoint.responses.some((r) => r.status === status)) continue

      endpoint.responses.push({
        status,
        contentType: 'application/json',
        example: parsed,
        typeName,
        ...(response.name ? { description: String(response.name) } : {}),
      })
      if (typeof parsed === 'object') {
        entities.push(...inferTypes(parsed, typeName, undefined, { allOptional: true }).entities)
      }
    }

    endpoints.push(endpoint)
  }

  return {
    title: String(doc.info?.name ?? 'API'),
    description: String(doc.info?.description?.content ?? doc.info?.description ?? ''),
    servers: [...servers],
    endpoints,
    entities,
  }
}
