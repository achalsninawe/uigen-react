import type { ConnectionSettings, Endpoint } from '../types.js'

/**
 * Issues one documented call to the real API.
 *
 * Shared by the preview proxy and the response-shape learner so that both build
 * the identical URL and send the identical credentials — a shape learned from a
 * call the preview could not reproduce would be worse than none.
 */

/** Both `{braces}` and `:colon` templates appear in real documentation. */
export function fillPath(template: string, params: Record<string, unknown>): string {
  return template
    .replace(/\{([^}]+)\}/g, (_m, name: string) => encodeURIComponent(String(params[name] ?? '')))
    .replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) =>
      name in params ? encodeURIComponent(String(params[name])) : `:${name}`,
    )
}

export function buildQuery(query: Record<string, unknown>): string {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) for (const item of value) search.append(name, String(item))
    else search.append(name, String(value))
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}

export function joinUrl(base: string, path: string): string {
  if (!base) return path
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * Headers belonging to the hop between the generated app and this server rather
 * than to the upstream request. A stale content-length in particular makes most
 * servers hang or reject outright.
 */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'origin',
  'referer',
  'cookie',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'proxy-authorization',
])

export function cleanHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    if (typeof value === 'string' && value.length > 0) out[name] = value
  }
  return out
}

/** Applies the project's saved credential using whichever scheme was documented. */
export function applyAuth(
  endpoint: Endpoint,
  connection: ConnectionSettings,
  headers: Record<string, string>,
  query: Record<string, unknown>,
): void {
  const value = connection.authValue?.trim()
  if (value && endpoint.auth.type !== 'none') {
    const name = endpoint.auth.name || 'Authorization'
    if (endpoint.auth.in === 'query') {
      query[name] = value
    } else {
      const scheme = endpoint.auth.scheme
      const alreadyPrefixed = scheme && value.toLowerCase().startsWith(`${scheme.toLowerCase()} `)
      headers[name] = scheme && !alreadyPrefixed ? `${scheme} ${value}` : value
    }
  }
  for (const [name, headerValue] of Object.entries(connection.extraHeaders ?? {})) {
    if (headerValue) headers[name] = headerValue
  }
}

export interface CallPayload {
  pathParams?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
  headers?: Record<string, unknown>
  baseUrlOverride?: string
}

export interface CallOutcome {
  status: number
  statusText: string
  body: unknown
  durationMs: number
  url: string
  error?: string
}

export async function callUpstream(
  endpoint: Endpoint,
  connection: ConnectionSettings,
  payload: CallPayload,
  timeoutMs = 30_000,
): Promise<CallOutcome> {
  const baseUrl = payload.baseUrlOverride || connection.baseUrlOverride || endpoint.baseUrl
  if (!baseUrl) {
    throw new Error(
      `No base URL is known for ${endpoint.method} ${endpoint.path}. Set one in Connection settings.`,
    )
  }

  const query = { ...(payload.query ?? {}) }
  const headers = cleanHeaders(payload.headers ?? {})
  applyAuth(endpoint, connection, headers, query)

  const url = joinUrl(baseUrl, fillPath(endpoint.path, payload.pathParams ?? {})) + buildQuery(query)

  const hasBody = payload.body !== undefined && !['GET', 'HEAD'].includes(endpoint.method)
  if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = endpoint.requestBody?.contentType ?? 'application/json'
  }

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: endpoint.method,
      headers,
      signal: controller.signal,
      ...(hasBody
        ? { body: typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body) }
        : {}),
    })

    const contentType = response.headers.get('content-type') ?? ''
    const text = await response.text()
    let body: unknown = text || null
    if (text && contentType.includes('json')) {
      try {
        body = JSON.parse(text)
      } catch {
        // Leave it as text; a malformed body is the upstream's to explain.
      }
    }

    return {
      status: response.status,
      statusText: response.statusText,
      body,
      durationMs: Date.now() - started,
      url,
    }
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError'
    return {
      status: 0,
      statusText: 'Request failed',
      body: null,
      durationMs: Date.now() - started,
      url,
      error: aborted ? `Upstream request timed out after ${timeoutMs / 1000}s` : unreachable(err as Error, url),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Says why a request never reached the API, where Node only says "fetch failed".
 *
 * The usual cause is an API on a company network or VPN: it works in Postman,
 * which runs on the person's machine, and not from a server outside that
 * network. Saying so saves an hour of checking tokens and bodies that were fine.
 */
function unreachable(err: Error, url: string): string {
  const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause
  const code = cause?.code ?? ''
  const host = (() => {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  })()
  const network =
    `This server could not connect to ${host}. If the API is only reachable on your company network or VPN, ` +
    'it works in Postman because Postman runs on your PC; this server has to be on that network too.'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${host} could not be found from this server (${code}). ${network}`
  if (['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return `No connection (${code}). ${network}`
  }
  if (/certificate|CERT_|SELF_SIGNED/i.test(`${code} ${cause?.message ?? ''}`)) {
    return `The API's certificate was not trusted (${code || cause?.message}). Postman may have certificate checks turned off.`
  }
  return cause?.message ? `${err.message}: ${cause.message}` : err.message
}
