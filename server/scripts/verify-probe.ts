/**
 * The probe that reads a real API instead of only reading about it.
 *
 * Uses the exact payload that produced a table of dashes — a list of projects
 * whose fields the documents called "Project Name" and the API calls
 * `projectName` — so the regression is the real one rather than a tidied
 * version of it.
 *
 * No network: the shape logic is tested directly, and the selection logic is
 * tested with endpoints that have no host, so nothing is ever called.
 */
import { applyObservedShape, probeEndpoints } from '../src/services/pipeline/probe.js'
import type { AppSpec, ConnectionSettings, Endpoint } from '../src/types.js'

let failures = 0

const ok = (label: string, detail?: string) => {
  console.log(`  ok    ${label}`)
  if (detail) console.log(`          ${detail}`)
}

const bad = (label: string, detail: string) => {
  failures++
  console.log(`  FAIL  ${label}`)
  console.log(`          ${detail}`)
}

/** What the live API actually returned. */
const LIVE_BODY = [
  {
    id: 'a522e333-dbba-4277-b3eb-beb5bb3e90c1',
    projectName: 'Claims Agent',
    owner: 'Achal',
    status: 'In Progress',
    startDate: '2026-01-01',
    endDate: '2026-12-01',
    lastUpdate: '2026-09-17',
    taskCount: 3,
  },
  {
    id: '33b444c3-ad8d-427c-a601-f22a46983afe',
    projectName: 'New Project',
    owner: 'Achal',
    status: 'Not Started',
    startDate: '2026-10-01',
    endDate: '2026-12-31',
    lastUpdate: null,
    taskCount: 0,
  },
]

const endpoint = (over: Partial<Endpoint> & Pick<Endpoint, 'operationId' | 'method' | 'path'>): Endpoint => ({
  id: over.operationId,
  name: over.operationId,
  baseUrl: '',
  tags: [],
  auth: { type: 'none' },
  headers: [],
  pathParams: [],
  queryParams: [],
  responses: [],
  ...over,
})

function specWithProseGuess(): AppSpec {
  return {
    appName: 'Project Tracker',
    description: '',
    // What the documents implied: labels turned into field names.
    entities: [
      {
        name: 'Project',
        fields: [
          { name: 'name', type: 'string', required: false },
          { name: 'projectOwner', type: 'string', required: false },
          { name: 'currentStatus', type: 'string', required: false },
        ],
      },
    ],
    endpoints: [
      endpoint({
        operationId: 'listProjects',
        method: 'GET',
        path: '/api/projects',
        responses: [{ status: '200', typeName: 'Project[]' }],
      }),
    ],
    flows: [],
    gaps: [],
    documentedScreens: [],
    servers: [],
  }
}

function checkObservedShapeWins() {
  const appSpec = specWithProseGuess()
  const { rootTypeName } = applyObservedShape(appSpec, 'listProjects', LIVE_BODY, 200)

  const declared = appSpec.entities.flatMap((e) => e.fields.map((f) => f.name))
  const wanted = ['projectName', 'owner', 'status', 'startDate', 'endDate', 'lastUpdate', 'taskCount', 'id']
  const missing = wanted.filter((f) => !declared.includes(f))

  if (missing.length === 0) ok('the real field names are declared', wanted.join(', '))
  else bad('the real field names are declared', `missing ${missing.join(', ')}`)

  const response = appSpec.endpoints[0]!.responses.find((r) => r.status === '200')
  if (response?.typeName === rootTypeName && /\[\]$/.test(rootTypeName)) {
    ok('a bare array response is typed as an array of the element', rootTypeName)
  } else {
    bad('a bare array response is typed as an array', `typeName=${response?.typeName}, root=${rootTypeName}`)
  }

  if (response?.example) ok('the observed payload is kept as the response example')
  else bad('the observed payload is kept', 'no example recorded')

  // A field that is null in one record and a string in another must survive as
  // optional rather than vanishing — `lastUpdate` is null on the second project.
  const learned = appSpec.entities.find((e) => e.fields.some((f) => f.name === 'lastUpdate'))
  if (learned) ok('a field that is null in one record still survives', 'lastUpdate')
  else bad('a null field survives', 'lastUpdate was dropped')
}

async function checkSelection() {
  const appSpec: AppSpec = {
    ...specWithProseGuess(),
    endpoints: [
      endpoint({ operationId: 'listProjects', method: 'GET', path: '/api/projects' }),
      endpoint({ operationId: 'getProject', method: 'GET', path: '/api/projects/{projectId}' }),
      endpoint({ operationId: 'createProject', method: 'POST', path: '/api/projects' }),
      endpoint({ operationId: 'deleteProject', method: 'DELETE', path: '/api/projects/{projectId}' }),
    ],
  }

  // No host anywhere, so nothing can be called and no request is ever made.
  const connection: ConnectionSettings = { extraHeaders: {} }
  const report = await probeEndpoints(appSpec, connection, () => {})

  const why = (id: string) => report.skipped.find((s) => s.operationId === id)?.why ?? '(not skipped)'

  const mutating = ['createProject', 'deleteProject']
  const refused = mutating.filter((id) => /only GET is probed/.test(why(id)))
  if (refused.length === mutating.length) {
    ok('POST and DELETE are never called', 'nothing is created or deleted to learn a shape')
  } else {
    bad('POST and DELETE are never called', mutating.map((id) => `${id}: ${why(id)}`).join(' · '))
  }

  if (report.probed.length === 0) ok('with no host, nothing is called')
  else bad('with no host, nothing is called', `probed ${report.probed.length}`)

  if (/no base URL/.test(why('listProjects'))) ok('a missing host is reported as the reason')
  else bad('a missing host is reported', why('listProjects'))
}

async function main() {
  console.log('')
  checkObservedShapeWins()
  await checkSelection()
  console.log('')
  console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
