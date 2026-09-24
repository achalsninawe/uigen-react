/**
 * Proves that emitted infrastructure parses, whatever the analysis produced.
 *
 * `src/lib/api.ts` and `src/lib/types.ts` are written by code, never by a
 * model — that is the guarantee the whole product rests on, and it is worth
 * nothing if the code can emit a file TypeScript cannot read. A project tracker
 * hit exactly that: a response typed "Project List Response" in prose reached
 * the emitter untouched and produced `Promise<Project List Response>`, which
 * misparsed every function after it.
 *
 * So the hostile names go in deliberately, and what comes out is parsed.
 *
 *   npm run verify:emit-parses -w server
 */
import { execFileSync } from 'node:child_process'
import esbuild from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../src/config.js'
import { emitApiClient, emitConfig, emitHttp } from '../src/services/emit/apiClient.js'
import { emitTypes } from '../src/services/emit/types.js'
import { withSafeTypeNames } from '../src/services/emit/normalise.js'
import { toTsType } from '../src/services/emit/lang.js'
import type { AppSpec, Endpoint, Entity } from '../src/types.js'

const HOST = 'https://projtracker-api-2153.azurewebsites.net'

const endpoint = (
  operationId: string,
  method: Endpoint['method'],
  path: string,
  extra: Partial<Endpoint> = {},
): Endpoint => ({
  id: operationId,
  operationId,
  name: operationId,
  method,
  path,
  baseUrl: HOST,
  tags: [],
  auth: { type: 'none' },
  headers: [],
  /*
   * `UUID/String` is not a stray: it is how the project tracker's reference
   * documented every id, and it emitted `projectId: UUID/String`.
   */
  pathParams: path.includes('{projectId}')
    ? [{ name: 'projectId', in: 'path', type: 'String', required: true }]
    : [],
  queryParams: [],
  responses: [],
  ...extra,
})

const entity = (name: string, fields: [string, string][]): Entity => ({
  name,
  fields: fields.map(([f, t]) => ({ name: f, type: t, required: false })),
})

/**
 * Everything prose analysis has actually produced, in one spec: type names with
 * spaces, names nothing declares, reserved words, names starting with a digit,
 * punctuation, and entity names that collide once tidied.
 */
const appSpec: AppSpec = {
  appName: 'Project Tracker',
  description: '',
  entities: [
    entity('Project', [['id', 'string'], ['owner', 'Project Owner']]),
    entity('Project Owner', [['name', 'string']]),
    entity('project owner', [['name', 'string']]),
    entity('interface', [['value', 'string']]),
    entity('2fa token', [['value', 'string']]),
  ],
  flows: [],
  gaps: [],
  documentedScreens: [],
  servers: [HOST],
  endpoints: [
    // The reported failure: a response type named in words.
    endpoint('getApiProjects', 'GET', '/api/projects', {
      responses: [{ status: '200', typeName: 'Project List Response' }],
    }),
    // A name nothing declares — valid identifier, no interface behind it.
    endpoint('getApiProjectsByProjectId', 'GET', '/api/projects/{projectId}', {
      responses: [{ status: '200', typeName: 'ProjectSummary' }],
    }),
    // An array of a multi-word type.
    endpoint('getApiProjectsTasks', 'GET', '/api/projects/{projectId}/tasks', {
      responses: [{ status: '200', typeName: 'Task List Item[]' }],
    }),
    // A declared entity whose own name needed tidying.
    endpoint('getOwner', 'GET', '/api/projects/{projectId}/owner', {
      responses: [{ status: '200', typeName: 'Project Owner' }],
    }),
    // A request body typed in words, plus awkward parameter names.
    endpoint('postApiProjects', 'POST', '/api/projects', {
      requestBody: { contentType: 'application/json', typeName: 'Create Project Request' },
      queryParams: [
        { name: 'sort-by', in: 'query', type: 'string', required: false },
        { name: '2fa', in: 'query', type: 'string', required: false },
        { name: 'class', in: 'query', type: 'string', required: false },
        { name: 'status', in: 'query', type: 'Status Value', required: false },
        { name: 'since', in: 'query', type: 'ISO 8601 date (string)', required: false },
        { name: 'limit', in: 'query', type: 'Integer (max 100)', required: false },
        { name: 'archived', in: 'query', type: 'Boolean / true|false', required: false },
        { name: 'cursor', in: 'query', type: '', required: false },
        // Boxed wrappers: real types, and unusable where the value is spelled
        // into a URL. This is how field tables are normally written.
        { name: 'owner', in: 'query', type: 'String', required: false },
        { name: 'page', in: 'query', type: 'Number', required: false },
        { name: 'active', in: 'query', type: 'Boolean', required: false },
      ],
      responses: [{ status: '201', typeName: 'Project' }],
    }),
    // Shapes that must survive untouched.
    endpoint('getMixed', 'GET', '/api/mixed', {
      responses: [{ status: '200', typeName: 'Record<string, unknown>' }],
    }),
    endpoint('getUnion', 'GET', '/api/union', {
      responses: [{ status: '200', typeName: 'Project | Project Owner' }],
    }),
    endpoint('getNothing', 'GET', '/api/nothing', { responses: [{ status: '204' }] }),
  ],
}

interface Check {
  name: string
  ok: boolean
  detail: string
}
const checks: Check[] = []
const record = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

/** What a parameter of this documented type is emitted as. */
const toTsTypeCheck = (documented: string) => toTsType(documented, 'string')

const safe = withSafeTypeNames(appSpec)
const api = emitApiClient(safe)
const types = emitTypes(safe)

/** Parses one emitted file, reporting the first failure in full. */
function parses(label: string, code: string): { ok: boolean; detail: string } {
  try {
    esbuild.transformSync(code, { loader: 'ts' })
    return { ok: true, detail: `${code.split('\n').length} lines` }
  } catch (err) {
    const first = (err as { errors?: { text: string; location?: { line: number; lineText: string } }[] })
      .errors?.[0]
    return {
      ok: false,
      detail: first
        ? `line ${first.location?.line}: ${first.text} — ${first.location?.lineText.trim()}`
        : String(err),
    }
  }
}

const apiParse = parses('api.ts', api)
record('src/lib/api.ts parses', apiParse.ok, apiParse.detail)

const typesParse = parses('types.ts', types)
record('src/lib/types.ts parses', typesParse.ok, typesParse.detail)

/* Every type api.ts mentions must be one types.ts declares, or a built-in. */
const declared = new Set(
  [...types.matchAll(/^export interface (\w+)/gm)].map((m) => m[1]!),
)
const referenced = [...api.matchAll(/Promise<([^>]*)>/g)]
  .map((m) => m[1]!.replace(/\[\]/g, '').trim())
  .flatMap((t) => t.split('|').map((s) => s.trim()))
  .filter((t) => t && !['unknown', 'void', 'string', 'number', 'boolean', 'Record<string, unknown>'].includes(t))

const dangling = referenced.filter((t) => !declared.has(t) && !t.startsWith('Record<'))
record(
  'every type api.ts returns is one types.ts declares',
  dangling.length === 0,
  dangling.length ? `undeclared: ${[...new Set(dangling)].join(', ')}` : `${declared.size} interfaces declared`,
)

record(
  'a type named in words resolves to the entity it names',
  api.includes('Promise<ProjectOwner>'),
  api.split('\n').find((l) => l.includes('getOwner('))?.trim() ?? '(not emitted)',
)

record(
  'a type nothing declares becomes unknown, not a dangling reference',
  api.includes('Promise<unknown>') && !api.includes('ProjectSummary'),
  api.split('\n').find((l) => l.includes('getApiProjectsByProjectId('))?.trim() ?? '(not emitted)',
)

record(
  'a parameter documented String gets the primitive, not the boxed wrapper',
  api.includes('projectId: string') && !/\b(String|Number|Boolean)\b/.test(api),
  api.split('\n').find((l) => l.includes('getApiProjectsByProjectId('))?.trim() ?? '(not emitted)',
)

record(
  'a parameter typed in prose becomes the primitive it names',
  toTsTypeCheck('UUID/String') === 'string' && toTsTypeCheck('Integer (max 100)') === 'number',
  `UUID/String → ${toTsTypeCheck('UUID/String')} · Integer (max 100) → ${toTsTypeCheck(
    'Integer (max 100)',
  )}`,
)

record(
  'prose query types read as the primitives they name, never as unknown',
  /since\?: string/.test(api) && /limit\?: number/.test(api) && /archived\?: boolean/.test(api),
  api.split('\n').find((l) => l.includes('since?'))?.trim().slice(0, 150) ?? '(not emitted)',
)

record(
  'a parameter with no documented type is still usable in a URL',
  /cursor\?: string/.test(api),
  api.includes('cursor?: string') ? 'cursor?: string' : '(not string)',
)

record(
  'generics and unions are left intact',
  api.includes('Promise<Record<string, unknown>>'),
  api.split('\n').find((l) => l.includes('getMixed('))?.trim() ?? '(not emitted)',
)

record(
  'a 204 still returns void',
  api.includes('Promise<void>'),
  api.split('\n').find((l) => l.includes('getNothing('))?.trim() ?? '(not emitted)',
)

record(
  'entity names that collide once tidied stay distinct',
  declared.has('ProjectOwner') && declared.has('ProjectOwner2'),
  [...declared].join(', '),
)

/* Normalising an already-normalised spec must change nothing. */
const twice = withSafeTypeNames(safe)
record(
  'normalising twice changes nothing',
  JSON.stringify(twice) === JSON.stringify(safe),
  'idempotent',
)

/* ---------------------------------------------------------------- *
 * Type-checking, not just parsing
 * ---------------------------------------------------------------- */

/*
 * Parsing is not enough, and this is the case that proved it: a parameter
 * documented `String` emits `projectId: String`, which parses perfectly — the
 * boxed wrapper is a real type — and then fails where the value is spelled
 * into a URL. The error lands in emitted infrastructure either way, so the
 * whole lib/ directory is compiled here the way the generated app compiles it.
 */
const libDir = path.join(config.workDir, 'verify-emit-parses', 'src', 'lib')
await fs.rm(path.join(config.workDir, 'verify-emit-parses'), { recursive: true, force: true })
await fs.mkdir(libDir, { recursive: true })

await fs.writeFile(path.join(libDir, 'api.ts'), api, 'utf8')
await fs.writeFile(path.join(libDir, 'types.ts'), types, 'utf8')
await fs.writeFile(path.join(libDir, 'http.ts'), emitHttp(), 'utf8')
await fs.writeFile(
  path.join(libDir, 'config.ts'),
  emitConfig(safe, { projectId: 'verify', transport: 'bff', serverOrigin: 'http://localhost:5177' }),
  'utf8',
)

let tsc: { ok: boolean; detail: string }
try {
  execFileSync(
    process.execPath,
    [
      path.join(config.repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'ESNext',
      '--moduleResolution',
      'bundler',
      '--skipLibCheck',
      '--lib',
      'ES2023,DOM',
      path.join(libDir, 'api.ts'),
      path.join(libDir, 'http.ts'),
      path.join(libDir, 'types.ts'),
      path.join(libDir, 'config.ts'),
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  tsc = { ok: true, detail: 'api.ts, http.ts, types.ts, config.ts compile under --strict' }
} catch (err) {
  const output = String((err as { stdout?: string }).stdout ?? err)
  tsc = {
    ok: false,
    detail: output
      .split('\n')
      .filter((l) => l.includes('error'))
      .slice(0, 6)
      .map((l) => l.replace(libDir + path.sep, ''))
      .join('\n          '),
  }
}
record('emitted src/lib/ type-checks, not merely parses', tsc.ok, tsc.detail)

console.log()
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}\n          ${c.detail}`)

const failed = checks.filter((c) => !c.ok)
console.log()
if (failed.length > 0) {
  console.error(`${failed.length} of ${checks.length} checks failed`)
  process.exit(1)
}
console.log(`all ${checks.length} checks passed`)
