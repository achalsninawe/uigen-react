/**
 * Downloads a real export and takes it apart.
 *
 * The ZIP route is the only way the emitted BFF reaches anyone, so this asks
 * the actual route over HTTP with a real session, unzips what comes back, and
 * then boots the server it finds inside. A route that type-checks and returns
 * 200 can still hand someone an archive that unpacks to nothing runnable.
 *
 *   npm run verify:export -w server
 */
import './local-env.js'

import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../src/config.js'
import { HttpError } from '../src/http.js'
import { authRouter, requireUser } from '../src/routes/auth.js'
import { exportRouter } from '../src/routes/export.js'
import { emitFoundation, type EmitContext } from '../src/services/emit/index.js'
import { storage } from '../src/services/blobs.js'
import { store } from '../src/services/store.js'
import type { AppPlan, AppSpec, Endpoint, ScreenPlan } from '../src/types.js'

const PORT = 5188
const APP_PORT = 8125
const origin = `http://127.0.0.1:${PORT}`
const outRoot = path.join(config.workDir, 'verify-export')

/* ---------------------------------------------------------------- *
 * A project to export
 * ---------------------------------------------------------------- */

const endpoint = (operationId: string, method: Endpoint['method'], p: string): Endpoint => ({
  id: operationId,
  operationId,
  name: operationId,
  method,
  path: p,
  baseUrl: 'https://jsonplaceholder.typicode.com',
  tags: [],
  auth: { type: 'bearer', name: 'Authorization', in: 'header', scheme: 'Bearer' },
  headers: [],
  pathParams: [],
  queryParams: [],
  responses: [{ status: '200', typeName: 'unknown' }],
})

const appSpec: AppSpec = {
  appName: 'Export Check',
  description: 'Synthetic project used to verify the export route.',
  entities: [],
  flows: [],
  gaps: [],
  documentedScreens: [],
  servers: ['https://jsonplaceholder.typicode.com'],
  endpoints: [endpoint('listPosts', 'GET', '/posts'), endpoint('getPost', 'GET', '/posts/{postId}')],
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

/* ---------------------------------------------------------------- *
 * Harness
 * ---------------------------------------------------------------- */

await fs.rm(outRoot, { recursive: true, force: true })
await fs.mkdir(outRoot, { recursive: true })
await storage().init()

const app = express()
app.use(express.json())
app.use('/api/auth', authRouter)
app.use('/api/projects', requireUser, exportRouter)
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500
  res.status(status).json({ error: err instanceof Error ? err.message : 'Unexpected error' })
})

const server = app.listen(PORT)
await new Promise<void>((resolve) => server.once('listening', resolve))

/** Registers an account and keeps its session cookie. */
async function signUp(email: string): Promise<{ id: string; cookie: string }> {
  const res = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'verify-password-1234', name: 'Verify' }),
  })
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`)
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  const body = (await res.json()) as { user: { id: string } }
  return { id: body.user.id, cookie }
}

interface Check {
  name: string
  ok: boolean
  detail: string
}
const checks: Check[] = []
const record = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

/** Downloads one export and unpacks it, returning the extracted root. */
async function download(
  projectId: string,
  cookie: string,
  transport: string,
  label: string,
): Promise<{ status: number; root?: string; files?: string[]; error?: string }> {
  const res = await fetch(`${origin}/api/projects/${projectId}/export?transport=${transport}`, {
    headers: { cookie },
  })

  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string }
    return { status: res.status, error: detail.error }
  }

  const zip = path.join(outRoot, `${label}.zip`)
  await fs.writeFile(zip, Buffer.from(await res.arrayBuffer()))

  const dest = path.join(outRoot, label)
  // PowerShell rather than a new dependency: this only has to unpack a ZIP
  // that was produced a second ago on the same machine.
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`,
  ])

  const entries = await fs.readdir(dest)
  const root = path.join(dest, entries[0]!)

  const files: string[] = []
  const walk = async (dir: string, prefix = '') => {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isDirectory()) await walk(path.join(dir, item.name), rel)
      else files.push(rel)
    }
  }
  await walk(root)

  return { status: res.status, root, files }
}

try {
  const owner = await signUp(`export-${Date.now()}@verify.local`)
  const stranger = await signUp(`stranger-${Date.now()}@verify.local`)

  /* Nothing analysed yet: the refusal should name the step that is missing. */
  const empty = await store.create('Empty Project', owner.id)
  const emptyRes = await download(empty.id, owner.cookie, 'bff', 'empty')
  record(
    'an unanalysed project is told to analyse first',
    emptyRes.status === 400 && (emptyRes.error ?? '').includes('Run the analysis'),
    `HTTP ${emptyRes.status} — ${String(emptyRes.error)}`,
  )

  /* Analysed but never generated: a different missing step, a different answer. */
  const analysed = await store.create('Analysed Only', owner.id)
  analysed.appSpec = appSpec
  analysed.status = 'analyzed'
  await store.save(analysed)
  const analysedRes = await download(analysed.id, owner.cookie, 'bff', 'analysed')
  record(
    'an ungenerated project is told to generate first',
    analysedRes.status === 400 && (analysedRes.error ?? '').includes('Generate the app'),
    `HTTP ${analysedRes.status} — ${String(analysedRes.error)}`,
  )

  /* A generated project, stored the way the studio stores one. */
  const project = await store.create('Export Check', owner.id)
  const studioCtx: EmitContext = {
    projectId: project.id,
    transport: 'bridge',
    serverOrigin: `http://localhost:${config.port}`,
  }
  project.appSpec = appSpec
  project.plan = plan
  project.status = 'ready'
  project.files = [
    ...emitFoundation(appSpec, plan, studioCtx),
    { path: 'src/screens/Posts.tsx', content: 'export default function Posts() { return null }\n', origin: 'model' },
  ]
  await store.save(project)

  /*
   * A project generated before the bff transport existed: its stored client
   * has no branch for it. Exporting must not hand someone a config naming a
   * transport their client cannot perform.
   */
  const legacy = await store.create('Legacy Project', owner.id)
  legacy.appSpec = appSpec
  legacy.plan = plan
  legacy.status = 'ready'
  legacy.files = project.files.map((f) =>
    f.path === 'src/lib/http.ts'
      ? { ...f, content: f.content.replace(/runtimeConfig\.transport === 'bff'/g, "'never' === 'bff'") }
      : f,
  )
  await store.save(legacy)

  const bad = await download(project.id, owner.cookie, 'nonsense', 'bad')
  record(
    'an unknown transport is rejected',
    bad.status === 400 && (bad.error ?? '').includes('transport must be'),
    `HTTP ${bad.status} — ${String(bad.error)}`,
  )

  const unauth = await fetch(`${origin}/api/projects/${project.id}/export`)
  record('an export needs a session', unauth.status === 401, `HTTP ${unauth.status}`)

  const notMine = await download(project.id, stranger.cookie, 'bff', 'not-mine')
  record(
    "someone else's project is not found, not forbidden",
    notMine.status === 404,
    `HTTP ${notMine.status} — ${String(notMine.error)}`,
  )

  /* The BFF build. */
  const bff = await download(project.id, owner.cookie, 'bff', 'bff')
  const bffFiles = bff.files ?? []
  record(
    'the ZIP unpacks into one folder named after the project',
    bff.status === 200 && path.basename(bff.root ?? '') === 'export-check',
    `root ${path.basename(bff.root ?? '(none)')} · ${bffFiles.length} files`,
  )

  record(
    'the BFF export carries its server',
    ['server/index.js', 'server/upstream.js', 'server/endpoints.json', '.env.example'].every((f) =>
      bffFiles.includes(f),
    ),
    bffFiles.filter((f) => f.startsWith('server/') || f === '.env.example').join(', ') || '(none)',
  )

  record(
    'the screens the model wrote are in there too',
    bffFiles.includes('src/screens/Posts.tsx') && bffFiles.includes('src/lib/api.ts'),
    `${bffFiles.filter((f) => f.startsWith('src/')).length} src files`,
  )

  const bffConfig = await fs.readFile(path.join(bff.root!, 'src/lib/config.ts'), 'utf8')
  record(
    'the export was re-emitted for the target, not left on the preview transport',
    bffConfig.includes(`transport: "bff"`) && !bffConfig.includes(`transport: "bridge"`),
    bffConfig.split('\n').find((l) => l.includes('transport:'))?.trim() ?? '(not found)',
  )

  const bffPkg = JSON.parse(await fs.readFile(path.join(bff.root!, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
    dependencies: Record<string, string>
  }
  record(
    'the BFF export can be started',
    bffPkg.scripts.start === 'node server/index.js' && Boolean(bffPkg.dependencies.express),
    `start=${String(bffPkg.scripts.start)} express=${String(bffPkg.dependencies.express)}`,
  )

  const storedEndpoints = JSON.parse(
    await fs.readFile(path.join(bff.root!, 'server/endpoints.json'), 'utf8'),
  ) as { operationId: string }[]
  record(
    'the emitted server knows exactly the documented operations',
    storedEndpoints.length === appSpec.endpoints.length &&
      storedEndpoints.every((e) => appSpec.endpoints.some((d) => d.operationId === e.operationId)),
    storedEndpoints.map((e) => e.operationId).join(', '),
  )

  /* The exported server, actually running. */
  const child = spawn(process.execPath, [path.join(bff.root!, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(APP_PORT), API_AUTH_VALUE: 'from-the-environment' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let childLog = ''
  child.stdout.on('data', (d: Buffer) => (childLog += d.toString()))
  child.stderr.on('data', (d: Buffer) => (childLog += d.toString()))

  try {
    let health: { operations?: number; credentialConfigured?: boolean } | null = null
    for (let i = 0; i < 40 && !health; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)
        if (res.ok) health = (await res.json()) as typeof health
      } catch {
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    record(
      'the downloaded server boots and reports itself',
      health?.operations === appSpec.endpoints.length && health?.credentialConfigured === true,
      health ? `operations=${health.operations} credentialConfigured=${health.credentialConfigured}` : childLog.slice(0, 200),
    )

    const call = await fetch(`http://127.0.0.1:${APP_PORT}/api/call/listPosts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { _limit: 2 } }),
    })
    const payload = (await call.json()) as { status?: number; body?: unknown; url?: string }
    record(
      'the downloaded server forwards a real call',
      payload.status === 200 && Array.isArray(payload.body) && payload.body.length === 2,
      `${payload.status} ${String(payload.url)} → ${
        Array.isArray(payload.body) ? `${payload.body.length} rows` : typeof payload.body
      }`,
    )
  } finally {
    child.kill()
  }

  const legacyExport = await download(legacy.id, owner.cookie, 'bff', 'legacy')
  const legacyHttp = await fs.readFile(path.join(legacyExport.root!, 'src/lib/http.ts'), 'utf8')
  record(
    'a project generated before the transport existed gets a client that knows it',
    legacyExport.status === 200 && legacyHttp.includes(`runtimeConfig.transport === 'bff'`),
    legacyHttp.includes(`runtimeConfig.transport === 'bff'`)
      ? 'http.ts re-emitted with the bff branch'
      : 'exported a config naming bff to a client that cannot do it',
  )

  /* The static build. */
  const direct = await download(project.id, owner.cookie, 'direct', 'direct')
  const directFiles = direct.files ?? []
  const directConfig = await fs.readFile(path.join(direct.root!, 'src/lib/config.ts'), 'utf8')
  const directPkg = JSON.parse(await fs.readFile(path.join(direct.root!, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
    dependencies: Record<string, string>
  }
  record(
    'the static export carries no server at all',
    !directFiles.some((f) => f.startsWith('server/') || f === '.env.example') &&
      !directPkg.scripts.start &&
      !directPkg.dependencies.express &&
      directConfig.includes(`transport: "direct"`),
    `${directFiles.length} files, start=${String(directPkg.scripts.start)}`,
  )

  record(
    'exporting does not disturb what is stored',
    (await store.get(project.id))!.files.some((f) => f.content.includes(`transport: "bridge"`)),
    'stored files still on the preview transport',
  )
  // The work directory is throwaway, but repeated runs should not pile up
  // projects in it.
  for (const id of [empty.id, analysed.id, legacy.id, project.id]) await store.remove(id)
} finally {
  server.close()
}

console.log()
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}\n          ${c.detail}`)

const failed = checks.filter((c) => !c.ok)
console.log()
if (failed.length > 0) {
  console.error(`${failed.length} of ${checks.length} checks failed`)
  process.exit(1)
}
console.log(`all ${checks.length} checks passed`)
process.exit(0)
