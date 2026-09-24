/**
 * Guards what reconciliation is allowed to throw away.
 *
 * Merging is the one stage that deletes endpoints, so a mistake here is
 * invisible: the run reports success, the app is simply missing operations and
 * every screen built on them quietly has nowhere to read from. A project
 * tracker came back with only its writes — no way to list a project — because a
 * thinly described `GET /projects` was folded into the `POST /projects` beside
 * it.
 *
 *   npm run verify:reconcile -w server
 */
import { reconcileEndpoints } from '../src/services/pipeline/reconcile.js'
import type { Endpoint } from '../src/types.js'

const HOST = 'https://projtracker-api-2153.azurewebsites.net'

const make = (
  method: Endpoint['method'],
  path: string,
  extra: Partial<Endpoint> = {},
): Endpoint => ({
  id: `${method} ${path}`,
  operationId: `${method.toLowerCase()}${path.replace(/[^a-zA-Z]/g, '')}`,
  name: `${method} ${path}`,
  method,
  path,
  baseUrl: HOST,
  tags: [],
  auth: { type: 'none' },
  headers: [],
  pathParams: [],
  queryParams: [],
  responses: [],
  ...extra,
})

/** A write, described the way an API reference describes one. */
const documented = (method: Endpoint['method'], path: string) =>
  make(method, path, {
    requestBody: { contentType: 'application/json', example: { name: 'Apollo' } },
    responses: [{ status: '200', typeName: 'Project' }],
  })

interface Check {
  name: string
  ok: boolean
  detail: string
}
const checks: Check[] = []
const record = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

/* ---------------------------------------------------------------- *
 * The reported failure
 * ---------------------------------------------------------------- */

const tracker: Endpoint[] = [
  // Reads, as prose describes them: no body, no example, nothing to weigh.
  make('GET', '/api/projects'),
  make('GET', '/api/projects/{projectId}'),
  make('DELETE', '/api/projects/{projectId}'),
  make('GET', '/api/projects/{projectId}/tasks'),
  make('DELETE', '/api/projects/{projectId}/tasks/{taskId}'),
  // Writes, fully documented.
  documented('POST', '/api/projects'),
  documented('PUT', '/api/projects/{projectId}'),
  documented('POST', '/api/projects/{projectId}/tasks'),
  documented('PUT', '/api/projects/{projectId}/tasks/{taskId}'),
]

const result = reconcileEndpoints(tracker, [HOST])
const survived = new Set(result.endpoints.map((e) => `${e.method} ${e.path}`))

record(
  'every documented operation survives reconciliation',
  result.endpoints.length === tracker.length,
  `${result.endpoints.length} of ${tracker.length} kept${
    result.absorbed.length ? ` · absorbed ${result.absorbed.map((a) => a.dropped).join(', ')}` : ''
  }`,
)

record(
  'a list and a create on one path are two operations',
  survived.has('GET /api/projects') && survived.has('POST /api/projects'),
  [...survived].filter((s) => s.endsWith(' /api/projects')).join(' · '),
)

record(
  'read, replace and remove on one resource are three operations',
  ['GET', 'PUT', 'DELETE'].every((m) => survived.has(`${m} /api/projects/{projectId}`)),
  [...survived].filter((s) => s.endsWith('/api/projects/{projectId}')).join(' · '),
)

/* ---------------------------------------------------------------- *
 * What it must still collapse
 * ---------------------------------------------------------------- */

/* A requirements document naming a path, with the verb guessed for it. */
const withGhost: Endpoint[] = [
  documented('POST', '/claim/acceptance/v2/load'),
  { ...make('GET', '/claim/acceptance/v2/load', { methodAssumed: true }), baseUrl: '' },
]
const ghosted = reconcileEndpoints(withGhost, [HOST])
record(
  'a mention whose verb was guessed still folds into the documented call',
  ghosted.endpoints.length === 1 && ghosted.endpoints[0]!.method === 'POST',
  `${ghosted.endpoints.length} kept · absorbed ${ghosted.absorbed.length}`,
)

/* The same call split differently by two documents. */
const split: Endpoint[] = [
  { ...documented('POST', '/flow/Thing'), baseUrl: `${HOST}/1.0` },
  { ...documented('POST', '/Thing'), baseUrl: `${HOST}/1.0/flow` },
]
const joined = reconcileEndpoints(split, [`${HOST}/1.0`])
record(
  'one call split differently by two documents is still one call',
  joined.endpoints.length === 1,
  `${joined.endpoints.length} kept · merged ${joined.merged}`,
)

/* Two operations that merely share a last segment. */
const similar: Endpoint[] = [
  documented('POST', '/v1/claims/submit'),
  documented('POST', '/v2/appeals/submit'),
]
const kept = reconcileEndpoints(similar, [HOST])
record(
  'two paths sharing a last segment stay apart',
  kept.endpoints.length === 2,
  `${kept.endpoints.length} kept`,
)

/* A thin read next to a thin write: neither is evidence against the other. */
const bothThin = reconcileEndpoints(
  [make('GET', '/api/notes'), make('POST', '/api/notes')],
  [HOST],
)
record(
  'two thin operations on one path both survive',
  bothThin.endpoints.length === 2,
  `${bothThin.endpoints.length} kept`,
)

console.log()
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}\n          ${c.detail}`)

const failed = checks.filter((c) => !c.ok)
console.log()
if (failed.length > 0) {
  console.error(`${failed.length} of ${checks.length} checks failed`)
  process.exit(1)
}
console.log(`all ${checks.length} checks passed`)
