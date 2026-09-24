/**
 * Emits a BFF build and runs it against a real API.
 *
 * The point of the emitted server is that a call verified in the studio behaves
 * identically once the app is on its own. That is only worth believing if the
 * emitted server has actually been started and actually forwarded something, so
 * this does both: emits from a synthetic spec, boots `server/index.js`, and
 * makes the same calls the studio proxy was verified with.
 *
 *   npm run verify:bff -w server
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { config } from '../src/config.js'
import { emitFoundation, reemitForTarget, type EmitContext } from '../src/services/emit/index.js'
import type { AppPlan, AppSpec, Endpoint, ScreenPlan } from '../src/types.js'

const BASE = 'https://jsonplaceholder.typicode.com'
const PORT = 8123

/** A stand-in API on localhost, so what the upstream received can be read back. */
const ECHO_PORT = 8124
const ECHO_BASE = `http://127.0.0.1:${ECHO_PORT}`

/** Never a real credential — but it must never appear in the emitted app either. */
const TOKEN = 'smoke-secret-token'

const endpoint = (partial: Partial<Endpoint> & Pick<Endpoint, 'operationId' | 'method' | 'path'>): Endpoint => ({
  id: partial.operationId,
  name: partial.operationId,
  baseUrl: BASE,
  tags: [],
  auth: { type: 'none' },
  headers: [],
  pathParams: [],
  queryParams: [],
  responses: [{ status: '200', typeName: 'unknown' }],
  ...partial,
})

const appSpec: AppSpec = {
  appName: 'BFF Smoke Test',
  description: 'Synthetic spec used to verify the emitted backend for frontend.',
  entities: [],
  flows: [],
  gaps: [],
  documentedScreens: [],
  servers: [BASE],
  endpoints: [
    endpoint({ operationId: 'listPosts', method: 'GET', path: '/posts' }),
    endpoint({ operationId: 'getPost', method: 'GET', path: '/posts/{postId}' }),
    endpoint({
      operationId: 'createPost',
      method: 'POST',
      path: '/posts',
      requestBody: { contentType: 'application/json' },
    }),
    endpoint({ operationId: 'listPostComments', method: 'GET', path: '/posts/{postId}/comments' }),
    // Documented without a base URL: the server must refuse it rather than
    // guess a host.
    endpoint({ operationId: 'noBaseUrl', method: 'GET', path: '/nowhere', baseUrl: '' }),
    // Documented as needing a bearer token, and pointed at the echo server so
    // the credential the upstream actually received can be inspected.
    endpoint({
      operationId: 'echoAuthed',
      method: 'GET',
      path: '/echo',
      baseUrl: ECHO_BASE,
      auth: { type: 'bearer', name: 'Authorization', in: 'header', scheme: 'Bearer' },
    }),
  ],
}

const screens: ScreenPlan[] = [
  {
    id: 'home',
    name: 'Posts',
    route: '/',
    type: 'list',
    purpose: 'Every post',
    icon: 'List',
    sections: [],
    endpointIds: ['listPosts'],
    showInNav: true,
  },
]

const plan: AppPlan = {
  screens,
  navigation: [{ screenId: 'home', label: 'Posts', icon: 'List' }],
  theme: { accent: '#6C63FF', mood: 'calm', density: 'comfortable' },
  designNotes: [],
}

const ctx: EmitContext = {
  projectId: 'verify-bff',
  transport: 'bff',
  serverOrigin: 'http://localhost:5177',
}

/* ---------------------------------------------------------------- *
 * Emit
 * ---------------------------------------------------------------- */

const outDir = path.join(config.workDir, 'verify-bff')
await fs.rm(outDir, { recursive: true, force: true })

const files = emitFoundation(appSpec, plan, ctx)
for (const f of files) {
  const target = path.join(outDir, f.path)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, f.content, 'utf8')
}

const emitted = files.map((f) => f.path)
for (const required of ['server/index.js', 'server/upstream.js', 'server/endpoints.json', '.env.example']) {
  if (!emitted.includes(required)) throw new Error(`emitFoundation did not emit ${required}`)
}
console.log(`emitted ${files.length} files to ${outDir}`)

const pkg = JSON.parse(await fs.readFile(path.join(outDir, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  dependencies: Record<string, string>
}
if (!pkg.scripts.start) throw new Error('package.json has no start script')
if (!pkg.dependencies.express) throw new Error('package.json does not depend on express')

/*
 * The credential is configured on the server and nowhere else. If it can be
 * found anywhere in the app's own source, the whole point has been lost.
 */
const leaked = files.filter((f) => !f.path.startsWith('server/') && f.content.includes(TOKEN))
if (leaked.length > 0) {
  throw new Error(`the credential appears in ${leaked.map((f) => f.path).join(', ')}`)
}

/* ---------------------------------------------------------------- *
 * Boot
 * ---------------------------------------------------------------- */

/** Records what the upstream was sent, so the server's own work can be read. */
let lastUpstreamRequest: { headers: Record<string, string | string[] | undefined>; url: string } | undefined

/*
 * The credential goes in a `.env` file, exactly as the README tells someone to
 * put it there — not into this process's environment. A server that ignores
 * that file is a server that quietly makes unauthenticated calls.
 */
await fs.writeFile(
  path.join(outDir, '.env'),
  `API_AUTH_VALUE=${TOKEN}\nAPI_EXTRA_HEADERS={"X-Tenant":"acme"}\n`,
  'utf8',
)

const echo = http.createServer((req, res) => {
  lastUpstreamRequest = { headers: req.headers, url: req.url ?? '' }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ saw: req.url }))
})
await new Promise<void>((resolve) => echo.listen(ECHO_PORT, '127.0.0.1', resolve))

// Deliberately no credential in the environment: it has to come from `.env`.
const { API_AUTH_VALUE: _drop, API_EXTRA_HEADERS: _dropToo, ...cleanEnv } = process.env
const child = spawn(process.execPath, [path.join(outDir, 'server', 'index.js')], {
  env: { ...cleanEnv, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverLog = ''
child.stdout.on('data', (d: Buffer) => (serverLog += d.toString()))
child.stderr.on('data', (d: Buffer) => (serverLog += d.toString()))
child.on('exit', (code) => {
  if (code !== null && code !== 0) console.error(`server exited early with ${code}\n${serverLog}`)
})

const origin = `http://127.0.0.1:${PORT}`

/** The server needs a moment to bind; poll rather than guess a delay. */
async function waitForHealth(attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${origin}/api/health`)
      if (res.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`server never became healthy\n${serverLog}`)
}

/* ---------------------------------------------------------------- *
 * Check
 * ---------------------------------------------------------------- */

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
const record = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail })
}

/** Posts one call the way the emitted client in `src/lib/http.ts` does. */
async function call(operationId: string, payload: unknown = {}) {
  const res = await fetch(`${origin}/api/call/${operationId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { httpStatus: res.status, body }
}

try {
  await waitForHealth()

  const health = (await (await fetch(`${origin}/api/health`)).json()) as {
    operations: number
    credentialConfigured: boolean
  }
  record(
    'health reports the emitted operations',
    health.operations === appSpec.endpoints.length && health.credentialConfigured === true,
    `operations=${health.operations} credentialConfigured=${health.credentialConfigured}`,
  )

  const list = await call('listPosts', { query: { userId: 1, _limit: 3 } })
  record(
    'GET with query forwards',
    list.httpStatus === 200 && list.body?.status === 200 && Array.isArray(list.body.body) &&
      (list.body.body as unknown[]).length === 3,
    `${list.body?.status} ${String(list.body?.url)} → ${
      Array.isArray(list.body?.body) ? `${(list.body.body as unknown[]).length} rows` : typeof list.body?.body
    }`,
  )

  const one = await call('getPost', { pathParams: { postId: 2 } })
  record(
    'path parameter is filled',
    one.body?.status === 200 && (one.body.body as { id?: number } | null)?.id === 2,
    `${one.body?.status} ${String(one.body?.url)}`,
  )

  const created = await call('createPost', { body: { title: 'bff', body: 'smoke', userId: 1 } })
  record(
    'POST body is forwarded',
    created.body?.status === 201 && (created.body.body as { title?: string } | null)?.title === 'bff',
    `${created.body?.status} ${String(created.body?.url)}`,
  )

  const comments = await call('listPostComments', { pathParams: { postId: 1 } })
  record(
    'nested path forwards',
    comments.body?.status === 200 && Array.isArray(comments.body.body),
    `${comments.body?.status} ${String(comments.body?.url)}`,
  )

  const upstream404 = await call('getPost', { pathParams: { postId: 999999 } })
  record(
    'an upstream 404 arrives as 404, not as a server error',
    upstream404.httpStatus === 200 && upstream404.body?.status === 404,
    `envelope status ${upstream404.body?.status} over HTTP ${upstream404.httpStatus}`,
  )

  const unknown = await call('deleteEverything')
  record(
    'an operation absent from the spec is rejected',
    unknown.httpStatus === 404,
    `HTTP ${unknown.httpStatus} — ${String(unknown.body?.error)}`,
  )

  const noBase = await call('noBaseUrl')
  record(
    'an endpoint with no documented host is refused, not guessed',
    noBase.httpStatus === 400 && String(noBase.body?.error).includes('No base URL'),
    `HTTP ${noBase.httpStatus} — ${String(noBase.body?.error)}`,
  )

  /*
   * The call the page makes carries no credential at all. What the upstream
   * received is the server's own work — which is the entire argument for
   * emitting one.
   */
  lastUpstreamRequest = undefined
  const echoed = await call('echoAuthed', {
    query: { q: 'hello' },
    headers: { 'X-Keep': 'yes', host: 'evil.example.com', 'content-length': '999' },
  })
  const sawHeaders = lastUpstreamRequest?.headers ?? {}

  record(
    'the credential is read from .env and applied, though the page never had it',
    echoed.body?.status === 200 && sawHeaders.authorization === `Bearer ${TOKEN}`,
    `upstream saw authorization: ${String(sawHeaders.authorization)}`,
  )

  record(
    'configured extra headers are merged in',
    sawHeaders['x-tenant'] === 'acme',
    `upstream saw x-tenant: ${String(sawHeaders['x-tenant'])}`,
  )

  record(
    'headers from the page pass through, hop-by-hop ones do not',
    sawHeaders['x-keep'] === 'yes' && sawHeaders.host === `127.0.0.1:${ECHO_PORT}`,
    `x-keep=${String(sawHeaders['x-keep'])} host=${String(sawHeaders.host)}`,
  )

  record(
    'query parameters reach the upstream',
    lastUpstreamRequest?.url === '/echo?q=hello',
    `upstream path ${String(lastUpstreamRequest?.url)}`,
  )

  const strayApi = await fetch(`${origin}/api/nonsense`)
  record(
    'an unknown /api path answers JSON, not the app HTML',
    strayApi.status === 404 && (strayApi.headers.get('content-type') ?? '').includes('json'),
    `HTTP ${strayApi.status} ${strayApi.headers.get('content-type')}`,
  )

  // No `npm run build` has run here, so the fallback should say so plainly
  // rather than returning an empty 200.
  const page = await fetch(`${origin}/`)
  const pageText = await page.text()
  record(
    'a missing build explains itself',
    page.status === 500 && pageText.includes('npm run build'),
    `HTTP ${page.status} — ${pageText.slice(0, 60)}`,
  )

  /*
   * The server belongs to the target, not to the app. Switching a build to a
   * transport that does not use it must leave nothing behind for someone to
   * deploy by mistake.
   */
  const asDirect = reemitForTarget(files, appSpec, plan, { ...ctx, transport: 'direct' })
  const directPkg = JSON.parse(asDirect.find((f) => f.path === 'package.json')!.content) as {
    scripts: Record<string, string>
    dependencies: Record<string, string>
  }
  record(
    'switching away from bff removes the server it emitted',
    !asDirect.some((f) => f.path.startsWith('server/') || f.path === '.env.example') &&
      !directPkg.scripts.start &&
      !directPkg.dependencies.express,
    `${asDirect.length} files, start=${String(directPkg.scripts.start)} express=${String(
      directPkg.dependencies.express,
    )}`,
  )

  const backToBff = reemitForTarget(asDirect, appSpec, plan, ctx)
  record(
    'switching back to bff restores it',
    ['server/index.js', 'server/upstream.js', 'server/endpoints.json', '.env.example'].every((p) =>
      backToBff.some((f) => f.path === p),
    ) && backToBff.length === files.length,
    `${backToBff.length} files (emitted ${files.length})`,
  )
} finally {
  child.kill()
  echo.close()
}

/* ---------------------------------------------------------------- *
 * Report
 * ---------------------------------------------------------------- */

console.log()
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}\n          ${c.detail}`)

const failed = checks.filter((c) => !c.ok)
console.log()
if (failed.length > 0) {
  console.error(`${failed.length} of ${checks.length} checks failed`)
  if (serverLog.trim()) console.error(`\nserver output:\n${serverLog}`)
  process.exit(1)
}
console.log(`all ${checks.length} checks passed`)
