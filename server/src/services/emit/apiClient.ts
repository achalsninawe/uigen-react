import { bffBase } from './bff.js'
import { docComment, key, str, toIdentifier, toTsType } from './lang.js'
import type { AppSpec, BrandTheme, Endpoint, ParamSpec, ScreenLook } from '../../types.js'

export interface EmitContext {
  projectId: string
  /**
   * `direct` calls the documented URL from the page.
   * `proxy`  posts to the Spec2UI server, which forwards it.
   * `bridge` posts to the parent window, which then uses `proxy`. Needed for
   *          the in-browser preview: it runs on a public sandbox origin, and
   *          browsers block a public page from reaching localhost.
   * `bff`    posts to the app's own server, emitted beside it. For builds that
   *          leave the studio: same origin, so no CORS, and the credential
   *          stays on the server instead of shipping in the page.
   */
  transport: 'proxy' | 'direct' | 'bridge' | 'bff'
  /** The project's uploaded brand theme, applied to the plan before emitting. */
  brand?: BrandTheme
  /** The colour the person picked; wins over the planner's and the brand's. */
  accent?: string
  /** Root font size the person picked, in px. */
  rootSize?: number
  /** Per-screen looks by screen name, re-applied to a fresh plan. */
  screenLooks?: Record<string, ScreenLook>
  /** Absolute origin of the Spec2UI server, used by the proxy transport. */
  serverOrigin: string
  /** Sub-path the build is served from, e.g. `/p/abc123` for a published site. */
  basePath?: string
  /**
   * The host set in Connection settings, when the documents never stated one.
   *
   * Plenty of specifications describe every operation and no server — an
   * internal API doc, a Word file listing paths and bodies. Those endpoints are
   * real and callable the moment someone supplies the host, so the value has to
   * reach the planner, which otherwise writes the whole app off as
   * undemonstrable, and the emitted config, which otherwise ships a build that
   * can reach nothing.
   */
  baseUrlOverride?: string
}

/* ------------------------------------------------------------------ *
 * src/lib/config.ts — the only place a URL can be overridden at runtime
 * ------------------------------------------------------------------ */

export function emitConfig(appSpec: AppSpec, ctx: EmitContext): string {
  return `/**
 * Runtime configuration. Generated — edit the values, not the shape.
 *
 * Every base URL below was read from your specification. Setting
 * \`baseUrlOverride\` points the whole app at a different host without touching
 * the generated endpoint definitions.
 */
export const runtimeConfig = {
  /**
   * 'proxy'  — calls go through the Spec2UI server, which forwards them to the
   *            documented host. Avoids CORS and keeps credentials off the page.
   * 'direct' — calls go straight from the browser to the documented host. The
   *            API must send CORS headers allowing this origin.
   * 'bridge' — calls are handed to the parent window, which performs them.
   *            Used by the Spec2UI preview only.
   * 'bff'    — calls go to this app's own server in \`server/\`, which forwards
   *            them. Same origin, and the credential lives in the server's
   *            environment rather than here.
   */
  transport: ${str(ctx.transport)} as 'proxy' | 'direct' | 'bridge' | 'bff',
  proxyBase: ${str(`${ctx.serverOrigin}/api/proxy/${ctx.projectId}`)},

  /** Where the emitted server answers. Same origin, so a path is enough. */
  bffBase: ${str(bffBase(ctx))},

  /** Overrides every endpoint's documented base URL when non-empty. */
  baseUrlOverride: ${str(ctx.baseUrlOverride ?? '')},

  /** Credential value, e.g. the token for an \`Authorization: Bearer\` scheme.${
    ctx.transport === 'bff'
      ? `
   *
   *  Leave it empty. This build uses the 'bff' transport, so the credential
   *  belongs in the server's \`API_AUTH_VALUE\` and never has to reach the
   *  browser at all — a value set here is not sent.`
      : ''
  } */
  authValue: '',

  /** Sent with every request. */
  extraHeaders: {} as Record<string, string>,
}

/** Base URLs found in the specification, most authoritative first. */
export const documentedServers = ${JSON.stringify(appSpec.servers, null, 2)} as const
`
}

/* ------------------------------------------------------------------ *
 * src/lib/http.ts — one request implementation, shared by every call
 * ------------------------------------------------------------------ */

export function emitHttp(): string {
  return `import { runtimeConfig } from './config'

export interface RequestOptions {
  signal?: AbortSignal
  /** Merged over the headers this endpoint already defines. */
  headers?: Record<string, string>
}

export interface AuthSpec {
  type: 'none' | 'bearer' | 'apiKey' | 'basic' | 'oauth2' | 'custom'
  name?: string
  in?: 'header' | 'query' | 'cookie'
  scheme?: string
}

/** Everything about one documented operation. Generated per endpoint. */
export interface CallSpec {
  operationId: string
  method: string
  /** Path template exactly as documented, e.g. '/orders/{orderId}'. */
  path: string
  /** Base URL exactly as documented. */
  baseUrl: string
  pathParams?: Record<string, string | number | boolean>
  query?: Record<string, unknown>
  body?: unknown
  contentType?: string
  headers?: Record<string, string>
  /** Dotted paths in the body the API expects as numbers, e.g. items.[].qty */
  numericFields?: string[]
  /** Paths the documented example wrote as a plain date, not a timestamp. */
  dateFields?: string[]
  auth?: AuthSpec
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: unknown,
    readonly url: string,
  ) {
    super(\`\${status} \${statusText} — \${url}\`)
    this.name = 'ApiError'
  }
}

/** Both \`{braces}\` and \`:colon\` templates appear in real documentation. */
function fillPath(template: string, params: Record<string, string | number | boolean> = {}) {
  return template
    .replace(/\\{([^}]+)\\}/g, (_m, name: string) => encodeURIComponent(String(params[name] ?? '')))
    .replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) =>
      name in params ? encodeURIComponent(String(params[name])) : \`:\${name}\`,
    )
}

function buildQuery(query: Record<string, unknown> = {}) {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    // Repeat the key for arrays — the most widely accepted convention.
    if (Array.isArray(value)) for (const item of value) search.append(name, String(item))
    else search.append(name, String(value))
  }
  const qs = search.toString()
  return qs ? \`?\${qs}\` : ''
}

function joinUrl(base: string, path: string) {
  if (!base) return path
  return \`\${base.replace(/\\/+$/, '')}/\${path.replace(/^\\/+/, '')}\`
}

function authHeaders(auth?: AuthSpec): Record<string, string> {
  // Under 'bff' the emitted server holds the credential and applies it there.
  // Sending one from the page would defeat the point of having a server.
  if (runtimeConfig.transport === 'bff') return {}
  const value = runtimeConfig.authValue
  if (!auth || auth.type === 'none' || !value) return {}
  if (auth.in && auth.in !== 'header') return {}
  const name = auth.name || 'Authorization'
  // A token pasted with its scheme already attached should not get it twice.
  if (auth.scheme && !value.toLowerCase().startsWith(\`\${auth.scheme.toLowerCase()} \`)) {
    return { [name]: \`\${auth.scheme} \${value}\` }
  }
  return { [name]: value }
}

/**
 * Trims a timestamp back to the date the documentation showed.
 *
 * A screen reaches for new Date().toISOString() and sends
 * "2026-09-17T18:07:40.123Z" where the documented example was "2026-05-19".
 * Servers parsing a fixed pattern reject that on the millisecond separator —
 * IllegalArgumentException: Invalid char '.' at pos 19 — a 500 with nothing on
 * screen to explain it. The example says which fields are date-only, so the
 * client trims them rather than every screen having to remember the format.
 */
function coerceDates(value: unknown, paths: string[]): unknown {
  if (!paths.length || value === null || typeof value !== 'object') return value

  const apply = (node: unknown, segments: string[]): void => {
    if (node === null || typeof node !== 'object' || segments.length === 0) return

    const [head, ...rest] = segments

    if (head === '[]') {
      if (Array.isArray(node)) for (const item of node) apply(item, rest)
      return
    }

    const record = node as Record<string, unknown>

    if (rest.length > 0) {
      apply(record[head as string], rest)
      return
    }

    const current = record[head as string]
    if (typeof current !== 'string') return
    // Only a longer timestamp that starts with the same date is trimmed; a value
    // in some other shape is left for the server to judge.
    const match = current.match(/^(\d{4}-\d{2}-\d{2})[T ]/)
    if (match) record[head as string] = match[1]!
  }

  for (const path of paths) apply(value, path.split('.'))
  return value
}

/**
 * Applies a body's declared numeric fields before it is sent.
 *
 * A blank form input is an empty string, and posting that where the API expects
 * a number produces NumberFormatException: For input string: "" — a 500 with
 * nothing on screen to explain it. The generated client knows which fields are
 * numeric, so it converts them here rather than relying on every screen to
 * remember.
 */
function coerceNumbers(value: unknown, paths: string[]): unknown {
  if (!paths.length || value === null || typeof value !== 'object') return value

  const apply = (node: unknown, segments: string[]): void => {
    if (node === null || typeof node !== 'object' || segments.length === 0) return

    const [head, ...rest] = segments

    if (head === '[]') {
      if (Array.isArray(node)) for (const item of node) apply(item, rest)
      return
    }

    const record = node as Record<string, unknown>

    if (rest.length > 0) {
      apply(record[head as string], rest)
      return
    }

    const current = record[head as string]
    if (typeof current === 'number') return
    if (current === '' || current === undefined || current === null) {
      // A blank optional number is absent, not zero.
      delete record[head as string]
      return
    }
    if (typeof current === 'string') {
      const parsed = Number(current)
      if (!Number.isNaN(parsed)) record[head as string] = parsed
    }
  }

  // Work on a copy so a screen's state object is never mutated under it.
  const copy = JSON.parse(JSON.stringify(value)) as unknown
  for (const path of paths) apply(copy, path.split('.'))
  return copy
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return null
  const type = response.headers.get('content-type') ?? ''
  const text = await response.text()
  if (!text) return null
  if (type.includes('json')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

/* --------------------------- bridge transport ---------------------------- *
 * The preview runs on a public sandbox origin, and browsers refuse to let a
 * public page call localhost. So instead of making the request here, the call
 * is handed to the parent window — which is on localhost itself — and the
 * result comes back the same way.
 * -------------------------------------------------------------------------- */

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

const pending = new Map<number, Pending>()
let nextCallId = 1
let listening = false

function listenForBridgeReplies() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as
      | { __spec2ui?: string; id?: number; status?: number; body?: unknown; error?: string; url?: string }
      | null
    if (!data || data.__spec2ui !== 'response' || typeof data.id !== 'number') return

    const waiter = pending.get(data.id)
    if (!waiter) return
    pending.delete(data.id)

    if (data.error) {
      waiter.reject(new ApiError(data.status ?? 0, 'Request failed', data.error, data.url ?? ''))
    } else if ((data.status ?? 0) >= 400) {
      waiter.reject(new ApiError(data.status!, 'Upstream error', data.body, data.url ?? ''))
    } else {
      waiter.resolve(data.body)
    }
  })
}

function bridgeCall<T>(spec: CallSpec, headers: Record<string, string>, options: RequestOptions): Promise<T> {
  listenForBridgeReplies()

  if (typeof window === 'undefined' || window.parent === window) {
    return Promise.reject(
      new ApiError(0, 'No bridge', 'The bridge transport needs a parent window to relay through.', spec.path),
    )
  }

  const id = nextCallId++

  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })

    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(new ApiError(0, 'Timeout', 'The preview bridge did not respond within 35s.', spec.path))
      }
    }, 35_000)

    const settle = () => clearTimeout(timer)
    const waiter = pending.get(id)!
    pending.set(id, {
      resolve: (v) => {
        settle()
        waiter.resolve(v)
      },
      reject: (e) => {
        settle()
        waiter.reject(e)
      },
    })

    options.signal?.addEventListener('abort', () => {
      if (pending.delete(id)) {
        settle()
        reject(new ApiError(0, 'Aborted', 'The request was cancelled.', spec.path))
      }
    })

    window.parent.postMessage(
      {
        __spec2ui: 'request',
        id,
        operationId: spec.operationId,
        pathParams: spec.pathParams ?? {},
        query: spec.query ?? {},
        body: spec.body,
        headers,
      },
      '*',
    )
  })
}

/**
 * Issues one documented call.
 *
 * In 'direct' mode the URL is built from the documented base URL and path. In
 * 'proxy', 'bridge' and 'bff' modes the same spec travels to a server, which
 * rebuilds that identical URL — so the request that reaches the API is the same
 * whichever transport is in use.
 */
export async function call<T>(spec: CallSpec, options: RequestOptions = {}): Promise<T> {
  const body = coerceDates(coerceNumbers(spec.body, spec.numericFields ?? []), spec.dateFields ?? [])
  spec = { ...spec, body }

  const baseUrl = runtimeConfig.baseUrlOverride || spec.baseUrl
  const headers: Record<string, string> = {
    ...spec.headers,
    ...authHeaders(spec.auth),
    ...runtimeConfig.extraHeaders,
    ...options.headers,
  }
  if (spec.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = spec.contentType || 'application/json'
  }

  if (runtimeConfig.transport === 'bridge') {
    return bridgeCall<T>(spec, headers, options)
  }

  /*
   * 'proxy' and 'bff' speak the same envelope — one posts to the studio, the
   * other to this app's own server. Only the base differs.
   */
  if (runtimeConfig.transport === 'proxy' || runtimeConfig.transport === 'bff') {
    const forwarder = runtimeConfig.transport === 'bff' ? runtimeConfig.bffBase : runtimeConfig.proxyBase
    const response = await fetch(\`\${forwarder}/\${spec.operationId}\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        pathParams: spec.pathParams ?? {},
        query: spec.query ?? {},
        body: spec.body,
        headers,
        baseUrlOverride: runtimeConfig.baseUrlOverride || undefined,
      }),
    })
    const payload = (await readBody(response)) as { status?: number; body?: unknown; error?: string } | null
    if (!response.ok) {
      throw new ApiError(response.status, response.statusText, payload?.error ?? payload, spec.path)
    }
    // The proxy reports the upstream status inside its envelope.
    const status = payload?.status ?? 200
    if (status >= 400) throw new ApiError(status, 'Upstream error', payload?.body, spec.path)
    return payload?.body as T
  }

  const url = joinUrl(baseUrl, fillPath(spec.path, spec.pathParams)) + buildQuery(spec.query)
  const response = await fetch(url, {
    method: spec.method,
    headers,
    signal: options.signal,
    ...(spec.body !== undefined
      ? { body: typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body) }
      : {}),
  })

  const payload = await readBody(response)
  if (!response.ok) throw new ApiError(response.status, response.statusText, payload, url)
  return payload as T
}
`
}

/* ------------------------------------------------------------------ *
 * src/lib/api.ts — one typed function per documented endpoint
 * ------------------------------------------------------------------ */

/** Chooses the type a call resolves to, from its documented 2xx response. */
function successType(endpoint: Endpoint): string {
  const success = endpoint.responses.find((r) => /^2\d\d$/.test(r.status))
  if (!success) return 'unknown'
  if (success.status === '204' || success.status === '205') return 'void'
  return toTsType(success.typeName)
}

function paramType(param: ParamSpec): string {
  if (param.enum?.length) return param.enum.map((v) => JSON.stringify(v)).join(' | ')
  /*
   * `string` rather than `unknown` when the documented type is unusable.
   *
   * A path or query parameter is spelled into a URL, so a string is what it
   * always becomes. `unknown` would compile here and then fail at every call
   * site instead — the error moved into the screens rather than removed.
   */
  return toTsType(param.type, 'string')
}

/** `{ status?: 'a' | 'b'; limit?: number }` for an endpoint's query parameters. */
function queryShape(params: ParamSpec[]): string {
  const fields = params.map((p) => `${key(p.name)}${p.required ? '' : '?'}: ${paramType(p)}`)
  return `{ ${fields.join('; ')} }`
}

function emitFunction(endpoint: Endpoint, appSpec: AppSpec): string {
  const args: string[] = []
  const callFields: string[] = []

  // Path parameters become positional arguments, in the order they appear in
  // the path template rather than the order the document happened to list them.
  const orderedPathParams = orderPathParams(endpoint)
  if (orderedPathParams.length > 0) {
    const entries: string[] = []
    for (const p of orderedPathParams) {
      const argName = toIdentifier(p.name, 'param')
      args.push(`${argName}: ${paramType(p)}`)
      entries.push(argName === p.name ? argName : `${key(p.name)}: ${argName}`)
    }
    callFields.push(`pathParams: { ${entries.join(', ')} }`)
  }

  if (endpoint.requestBody) {
    args.push(`body: ${toTsType(endpoint.requestBody.typeName)}`)
    callFields.push('body')

    // Blank inputs arrive as '', which a numeric field rejects at the server.
    const numeric = numericPaths(endpoint.requestBody.typeName, appSpec)
    if (numeric.length > 0) callFields.push(`numericFields: ${JSON.stringify(numeric)}`)

    // The example is the only place the date format is stated.
    const dates = dateOnlyPaths(endpoint.requestBody.example)
    if (dates.length > 0) callFields.push(`dateFields: ${JSON.stringify(dates)}`)
  }

  if (endpoint.queryParams.length > 0) {
    const anyRequired = endpoint.queryParams.some((p) => p.required)
    args.push(`query${anyRequired ? '' : '?'}: ${queryShape(endpoint.queryParams)}`)
    callFields.push('query')
  }

  args.push('options?: RequestOptions')

  const staticHeaders = endpoint.headers.filter((h) => h.example)
  if (staticHeaders.length > 0) {
    const entries = staticHeaders.map((h) => `${key(h.name)}: ${str(h.example!)}`)
    callFields.push(`headers: { ${entries.join(', ')} }`)
  }

  const returns = successType(endpoint)
  const spec = [
    `operationId: ${str(endpoint.operationId)}`,
    `method: ${str(endpoint.method)}`,
    `path: ${str(endpoint.path)}`,
    `baseUrl: ${str(endpoint.baseUrl)}`,
    ...callFields,
    ...(endpoint.requestBody?.contentType && endpoint.requestBody.contentType !== 'application/json'
      ? [`contentType: ${str(endpoint.requestBody.contentType)}`]
      : []),
    ...(endpoint.auth.type !== 'none' ? [`auth: ${JSON.stringify(runtimeAuth(endpoint))}`] : []),
  ]

  const doc = docComment(
    [
      endpoint.summary || endpoint.name,
      endpoint.description && endpoint.description !== endpoint.summary ? endpoint.description : undefined,
      '',
      `${endpoint.method} ${endpoint.baseUrl}${endpoint.path}`,
      endpoint.sourceQuote ? `From the specification: ${endpoint.sourceQuote.replace(/\s+/g, ' ').slice(0, 200)}` : undefined,
    ],
  )

  return `${doc}export async function ${endpoint.operationId}(${args.join(', ')}): Promise<${returns}> {
  return call<${returns}>({
    ${spec.join(',\n    ')},
  }, options)
}`
}

/** Only the fields the runtime actually uses — `description` is documentation. */
function runtimeAuth(endpoint: Endpoint) {
  const { type, name, in: location, scheme } = endpoint.auth
  return {
    type,
    ...(name ? { name } : {}),
    ...(location ? { in: location } : {}),
    ...(scheme ? { scheme } : {}),
  }
}

/**
 * Dotted paths of every numeric field in a request body type.
 *
 * Walked from the entity graph, so nesting and arrays are covered:
 * `freelookInput.alteredCoverages.[].coverageId`. Cycles are guarded by the
 * visited set — a self-referencing type would otherwise recurse for ever.
 */
/**
 * Fields the documented example wrote as a plain date.
 *
 * Read from the example rather than the type, because a type only says
 * "string" — the format lives in what the document actually sent. A value of
 * "2026-05-19" is a statement that this field takes a date, not a timestamp.
 */
function dateOnlyPaths(example: unknown): string[] {
  const paths: string[] = []

  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return

    if (Array.isArray(node)) {
      walk(node[0], `${prefix}.[]`, depth + 1)
      return
    }

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) paths.push(path)
      else if (value && typeof value === 'object') walk(value, path, depth + 1)
    }
  }

  walk(example, '', 0)
  return paths
}

function numericPaths(typeName: string | undefined, appSpec: AppSpec): string[] {
  if (!typeName) return []

  const byName = new Map(appSpec.entities.map((e) => [e.name, e]))
  const paths: string[] = []

  const walk = (name: string, prefix: string, visited: Set<string>): void => {
    const base = name.replace(/\[\]$/, '').trim()
    if (visited.has(base)) return

    const entity = byName.get(base)
    if (!entity) return

    const seen = new Set(visited).add(base)

    for (const field of entity.fields) {
      const isArray = /\[\]$/.test(field.type)
      const fieldType = field.type.replace(/\[\]$/, '').trim()
      const path = prefix ? `${prefix}.${field.name}` : field.name

      if (fieldType === 'number') {
        paths.push(isArray ? `${path}.[]` : path)
        continue
      }
      if (byName.has(fieldType)) {
        walk(fieldType, isArray ? `${path}.[]` : path, seen)
      }
    }
  }

  walk(typeName, '', new Set())
  return paths
}

/** Path params in template order; any the template does not mention come last. */
function orderPathParams(endpoint: Endpoint): ParamSpec[] {
  const names = [...endpoint.path.matchAll(/\{([^}]+)\}|:([A-Za-z0-9_]+)/g)].map((m) => m[1] ?? m[2]!)
  const byName = new Map(endpoint.pathParams.map((p) => [p.name, p]))
  const ordered: ParamSpec[] = []

  for (const name of names) {
    const found = byName.get(name)
    if (found) {
      ordered.push(found)
      byName.delete(name)
    } else {
      // Documented in the path but never described — still required to call it.
      ordered.push({ name, in: 'path', type: 'string', required: true })
    }
  }
  ordered.push(...byName.values())
  return ordered
}

export function emitApiClient(appSpec: AppSpec): string {
  const typeNames = new Set(appSpec.entities.map((e) => e.name))
  const used = new Set<string>()

  for (const endpoint of appSpec.endpoints) {
    for (const candidate of [endpoint.requestBody?.typeName, ...endpoint.responses.map((r) => r.typeName)]) {
      // Strip array suffixes so `Order[]` still imports `Order`.
      const base = (candidate ?? '').replace(/\[\]$/, '').trim()
      if (typeNames.has(base)) used.add(base)
    }
  }

  const header = `/**
 * Generated API client — one function per endpoint found in your specification.
 *
 * This file is written by Spec2UI directly from the extracted endpoint list,
 * not by a language model. Every URL, method, parameter name and header below
 * is a literal copy of what your documentation states.
 *
 * Do not hand-edit: regenerate from the endpoint inspector instead.
 */
import { call, type RequestOptions } from './http'
${used.size > 0 ? `import type { ${[...used].sort().join(', ')} } from './types'\n` : ''}
export { ApiError } from './http'
export type { RequestOptions } from './http'
`

  if (appSpec.endpoints.length === 0) {
    return `${header}
// Your specification did not describe any HTTP operations, so there is nothing
// to call yet. Add an API reference and re-run the analysis.
export {}
`
  }

  return `${header}\n${appSpec.endpoints.map((endpoint) => emitFunction(endpoint, appSpec)).join('\n\n')}\n`
}
