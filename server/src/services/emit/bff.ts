import type { AppSpec, GeneratedFile } from '../../types.js'
import type { EmitContext } from './apiClient.js'

/**
 * The backend-for-frontend emitted alongside the generated app.
 *
 * An exported build has no Spec2UI server to relay through, and calling a
 * documented host straight from the page fails twice over: the API has no
 * reason to send CORS headers for wherever the build is hosted, and the
 * credential would have to ship inside page JavaScript to be sent at all. So
 * the app is emitted with its own small server. It serves the built UI and
 * answers `POST /api/call/:operationId` by rebuilding the documented request —
 * same origin for the browser, credential only ever on the server.
 *
 * Like the rest of the foundation this is produced entirely by code, from the
 * same `appSpec.endpoints` list that produces `src/lib/api.ts`. The model never
 * writes a route here, so it cannot reach a URL the documents do not state.
 */

/** Node's default port for the emitted server. */
export const BFF_PORT = 8080

/** Where the BFF answers, accounting for a build served from a sub-path. */
export function bffBase(ctx: EmitContext): string {
  return `${ctx.basePath ?? ''}/api/call`
}

/* ------------------------------------------------------------------ *
 * server/endpoints.json — the closed list of calls the BFF will make
 * ------------------------------------------------------------------ */

/**
 * Only the fields needed to rebuild a request. The BFF deliberately has no
 * route that accepts a URL, so an operation absent from this file is
 * unreachable through it.
 */
export function emitBffEndpoints(appSpec: AppSpec): string {
  const rows = appSpec.endpoints.map((e) => ({
    operationId: e.operationId,
    method: e.method,
    path: e.path,
    baseUrl: e.baseUrl,
    auth: e.auth,
    ...(e.requestBody?.contentType ? { contentType: e.requestBody.contentType } : {}),
  }))
  return `${JSON.stringify(rows, null, 2)}\n`
}

/* ------------------------------------------------------------------ *
 * server/upstream.js — one request implementation
 * ------------------------------------------------------------------ */

/**
 * A port of the studio's own `services/upstream.ts`. Both build the identical
 * URL and send the identical credential, so a call verified in preview behaves
 * the same once the app runs on its own.
 */
export function emitBffUpstream(): string {
  return `/**
 * Issues one documented call to the real API. Generated — do not edit.
 */

/** Both \`{braces}\` and \`:colon\` templates appear in real documentation. */
export function fillPath(template, params) {
  return template
    .replace(/\\{([^}]+)\\}/g, (_m, name) => encodeURIComponent(String(params[name] ?? '')))
    .replace(/:([A-Za-z0-9_]+)/g, (_m, name) =>
      name in params ? encodeURIComponent(String(params[name])) : ':' + name,
    )
}

export function buildQuery(query) {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue
    // Repeat the key for arrays — the most widely accepted convention.
    if (Array.isArray(value)) for (const item of value) search.append(name, String(item))
    else search.append(name, String(value))
  }
  const qs = search.toString()
  return qs ? '?' + qs : ''
}

export function joinUrl(base, path) {
  if (!base) return path
  return base.replace(/\\/+$/, '') + '/' + path.replace(/^\\/+/, '')
}

/**
 * Headers belonging to the hop between the page and this server rather than to
 * the upstream request. A stale content-length in particular makes most servers
 * hang or reject outright.
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

export function cleanHeaders(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    if (typeof value === 'string' && value.length > 0) out[name] = value
  }
  return out
}

/**
 * Applies the configured credential using whichever scheme was documented.
 *
 * This runs on the server, reading the value from the environment. It is the
 * reason the token never has to exist in the browser.
 */
export function applyAuth(endpoint, connection, headers, query) {
  const value = (connection.authValue ?? '').trim()
  if (value && endpoint.auth && endpoint.auth.type !== 'none') {
    const name = endpoint.auth.name || 'Authorization'
    if (endpoint.auth.in === 'query') {
      query[name] = value
    } else {
      const scheme = endpoint.auth.scheme
      const alreadyPrefixed = scheme && value.toLowerCase().startsWith(scheme.toLowerCase() + ' ')
      headers[name] = scheme && !alreadyPrefixed ? scheme + ' ' + value : value
    }
  }
  for (const [name, headerValue] of Object.entries(connection.extraHeaders ?? {})) {
    if (headerValue) headers[name] = headerValue
  }
}

export async function callUpstream(endpoint, connection, payload, timeoutMs = 30000) {
  const baseUrl = connection.baseUrlOverride || endpoint.baseUrl
  if (!baseUrl) {
    throw new Error(
      'No base URL is known for ' +
        endpoint.method +
        ' ' +
        endpoint.path +
        '. Set API_BASE_URL in the environment.',
    )
  }

  const query = { ...(payload.query ?? {}) }
  const headers = cleanHeaders(payload.headers)
  applyAuth(endpoint, connection, headers, query)

  const url = joinUrl(baseUrl, fillPath(endpoint.path, payload.pathParams ?? {})) + buildQuery(query)

  const hasBody = payload.body !== undefined && !['GET', 'HEAD'].includes(endpoint.method)
  if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = endpoint.contentType ?? 'application/json'
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
    let body = text || null
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
    const aborted = err && err.name === 'AbortError'
    return {
      status: 0,
      statusText: 'Request failed',
      body: null,
      durationMs: Date.now() - started,
      url,
      error: aborted
        ? 'Upstream request timed out after ' + timeoutMs / 1000 + 's'
        : String((err && err.message) || err),
    }
  } finally {
    clearTimeout(timer)
  }
}
`
}

/* ------------------------------------------------------------------ *
 * server/index.js — the server itself
 * ------------------------------------------------------------------ */

export function emitBffServer(appSpec: AppSpec, ctx: EmitContext): string {
  const basePath = ctx.basePath ?? ''
  const staticMount = basePath || '/'
  const count = appSpec.endpoints.length

  return `/**
 * ${appSpec.appName} — backend for frontend. Generated, do not edit.
 *
 * Serves the built UI and forwards the ${count} documented call${count === 1 ? '' : 's'}
 * to the real API. The browser only ever talks to this origin, so there is no
 * CORS to negotiate and no credential in page JavaScript.
 *
 *   npm install
 *   cp .env.example .env
 *   npm run build     # produces dist/
 *   npm start         # serves dist/ and the API on http://localhost:${BFF_PORT}
 *
 * Configuration comes from \`.env\` beside package.json, or from the real
 * environment, which takes precedence. All optional except the credential your
 * API requires:
 *
 *   API_AUTH_VALUE      the token or key, sent using the documented scheme
 *   API_BASE_URL        overrides every endpoint's documented base URL
 *   API_EXTRA_HEADERS   JSON object merged into every upstream request
 *   PORT                defaults to ${BFF_PORT}
 */

import express from 'express'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callUpstream } from './upstream.js'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, '..', 'dist')

/*
 * Configuration from \`.env\`, when there is one.
 *
 * Node reads this format itself, so the app needs no dependency for it. Values
 * already in the environment win, which is what a container or App Service
 * setting should do.
 */
const envFile = join(here, '..', '.env')
if (existsSync(envFile)) {
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envFile)
    } catch (err) {
      console.warn('Could not read .env —', (err && err.message) || err)
    }
  } else {
    console.warn('Found .env, but this Node is too old to read it. Node 20.12+, or run:')
    console.warn('  node --env-file=.env server/index.js')
  }
}

/** The closed list of calls this server will make. Emitted from the spec. */
const endpoints = JSON.parse(readFileSync(join(here, 'endpoints.json'), 'utf8'))
const byOperationId = new Map(endpoints.map((e) => [e.operationId, e]))

function parseExtraHeaders(raw) {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    console.warn('API_EXTRA_HEADERS is not valid JSON — ignoring it')
    return {}
  }
}

const connection = {
  baseUrlOverride: process.env.API_BASE_URL ?? '',
  authValue: process.env.API_AUTH_VALUE ?? '',
  extraHeaders: parseExtraHeaders(process.env.API_EXTRA_HEADERS),
}

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '4mb' }))

app.get('${basePath}/api/health', (_req, res) => {
  res.json({
    ok: true,
    operations: endpoints.length,
    // Whether a credential is configured, never the credential itself.
    credentialConfigured: connection.authValue.length > 0,
  })
})

/**
 * Forwards one documented call.
 *
 * The upstream status rides inside the envelope so a 404 from the API is
 * distinguishable from a 404 from this server — the generated client in
 * \`src/lib/http.ts\` reads it from \`status\`.
 */
app.post('${basePath}/api/call/:operationId', async (req, res) => {
  const endpoint = byOperationId.get(req.params.operationId)
  if (!endpoint) {
    res.status(404).json({ error: 'No endpoint named "' + req.params.operationId + '" in this app' })
    return
  }

  let outcome
  try {
    outcome = await callUpstream(endpoint, connection, req.body ?? {})
  } catch (err) {
    res.status(400).json({ error: String((err && err.message) || err) })
    return
  }

  if (outcome.error) {
    res
      .status(502)
      .json({ error: 'Could not reach ' + outcome.url + ' — ' + outcome.error, url: outcome.url })
    return
  }

  res.json({
    status: outcome.status,
    statusText: outcome.statusText,
    body: outcome.body,
    durationMs: outcome.durationMs,
    url: outcome.url,
  })
})

/*
 * Anything else under /api is a mistake and should say so as JSON. Without
 * this it would fall through to the single-page app, and a fetch() expecting
 * data would receive the whole HTML document instead.
 */
app.use('${basePath}/api', (_req, res) => {
  res.status(404).json({ error: 'Not an API route on this server' })
})

app.use('${staticMount}', express.static(dist))

// Client-side routing: every other path renders the app.
app.use((_req, res) => {
  res.sendFile(join(dist, 'index.html'), (err) => {
    if (err) {
      res.status(500).type('text/plain').send('dist/index.html is missing. Run "npm run build" first.')
    }
  })
})

const port = Number(process.env.PORT) || ${BFF_PORT}
app.listen(port, () => {
  console.log('${appSpec.appName.replace(/'/g, "\\'")} listening on http://localhost:' + port)
  if (!connection.authValue) {
    console.log('No API_AUTH_VALUE set — calls go out unauthenticated.')
    console.log('Put it in .env beside package.json, then restart.')
  }
})
`
}

/* ------------------------------------------------------------------ *
 * .env.example — what to configure, without values
 * ------------------------------------------------------------------ */

export function emitBffEnvExample(appSpec: AppSpec): string {
  const documented = appSpec.servers?.[0] ?? ''
  const scheme = appSpec.endpoints.find((e) => e.auth.type !== 'none')?.auth

  const credentialNote = scheme
    ? `, sent as ${scheme.in === 'query' ? 'query parameter' : 'header'} "${
        scheme.name || 'Authorization'
      }"${scheme.scheme ? ` with the "${scheme.scheme}" scheme` : ''}.`
    : '. Your specification documented no authentication, so this can stay empty.'

  return `# Configuration for the emitted server. Copy to .env and fill in.
# Read by the server only — nothing here is bundled into the page.

# The credential for your API${credentialNote}
API_AUTH_VALUE=

# Overrides every endpoint's documented base URL.${documented ? ` Documented: ${documented}` : ''}
API_BASE_URL=

# Merged into every upstream request, e.g. {"X-Tenant":"acme"}
API_EXTRA_HEADERS=

PORT=${BFF_PORT}
`
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

/** Paths this module owns, so switching target can clear them. */
export const BFF_PATHS = [
  'server/index.js',
  'server/upstream.js',
  'server/endpoints.json',
  '.env.example',
]

/**
 * True when this build should carry a BFF: the transport asks for one, and
 * there is at least one documented call for it to forward.
 */
export function wantsBff(appSpec: AppSpec, ctx: EmitContext): boolean {
  return ctx.transport === 'bff' && appSpec.endpoints.length > 0
}

export function emitBffFiles(appSpec: AppSpec, ctx: EmitContext): GeneratedFile[] {
  if (!wantsBff(appSpec, ctx)) return []
  const file = (path: string, content: string): GeneratedFile => ({
    path,
    content,
    origin: 'emitted',
  })

  return [
    file('server/index.js', emitBffServer(appSpec, ctx)),
    file('server/upstream.js', emitBffUpstream()),
    file('server/endpoints.json', emitBffEndpoints(appSpec)),
    file('.env.example', emitBffEnvExample(appSpec)),
  ]
}
