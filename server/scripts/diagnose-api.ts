/**
 * Emits `src/lib/api.ts` for a real stored project and reports why it will not
 * parse, if it will not.
 *
 * Reads storage, writes nothing. Run it with the project id from the studio
 * URL — `/p/<id>` — or with an email to list the ids first:
 *
 *   npm run diagnose:api -w server -- <projectId>
 *   npm run diagnose:api -w server -- --email you@example.com
 */
import esbuild from 'esbuild'
import { storage } from '../src/services/blobs.js'
import { store, users } from '../src/services/store.js'
import { emitApiClient } from '../src/services/emit/apiClient.js'
import { emitTypes } from '../src/services/emit/types.js'
import { withSafeTypeNames } from '../src/services/emit/normalise.js'

const args = process.argv.slice(2)
const emailFlag = args.indexOf('--email')

if (emailFlag !== -1) {
  const email = args[emailFlag + 1]
  if (!email) throw new Error('usage: --email you@example.com')
  const user = await users.byEmail(email.trim().toLowerCase())
  if (!user) throw new Error(`No account for ${email}`)
  const rows = await storage().listSummaries(user.id)
  console.log(`${rows.length} project(s) for ${email}:\n`)
  for (const row of rows) {
    console.log(`  ${row.id}  ${row.status.padEnd(10)} ${row.endpointCount} endpoints  ${row.name}`)
  }
  process.exit(0)
}

const id = args[0]
if (!id) throw new Error('usage: npm run diagnose:api -w server -- <projectId>')

const project = await store.getMeta(id)
if (!project) throw new Error(`No project ${id}`)
if (!project.appSpec) throw new Error('That project has no appSpec — run the analysis first')

console.log(`project  ${project.name}  (${project.appSpec.endpoints.length} endpoints)\n`)

/* ---- what the analysis produced, before any normalising ---- */

console.log('type names as stored:')
for (const endpoint of project.appSpec.endpoints) {
  const parts: string[] = []
  if (endpoint.requestBody?.typeName) parts.push(`body=${JSON.stringify(endpoint.requestBody.typeName)}`)
  for (const r of endpoint.responses) {
    if (r.typeName) parts.push(`${r.status}=${JSON.stringify(r.typeName)}`)
  }
  console.log(`  ${endpoint.operationId.padEnd(34)} ${parts.join('  ') || '(none)'}`)
}

console.log('\nentities as stored:')
console.log(
  '  ' + (project.appSpec.entities.map((e) => JSON.stringify(e.name)).join(', ') || '(none)'),
)

/* ---- what the emitters make of it ---- */

const safe = withSafeTypeNames(project.appSpec)
const api = emitApiClient(safe)
const types = emitTypes(safe)

console.log('\nemitted signatures:')
for (const line of api.split('\n')) {
  if (line.startsWith('export async function')) console.log('  ' + line.trim())
}

const report = (label: string, code: string) => {
  try {
    esbuild.transformSync(code, { loader: 'ts' })
    console.log(`\n${label}: parses (${code.split('\n').length} lines)`)
    return true
  } catch (err) {
    const errors = (err as { errors?: { text: string; location?: { line: number; lineText: string } }[] })
      .errors ?? []
    console.log(`\n${label}: DOES NOT PARSE`)
    for (const e of errors.slice(0, 5)) {
      console.log(`  line ${e.location?.line}: ${e.text}`)
      console.log(`    ${e.location?.lineText}`)
    }
    return false
  }
}

const apiOk = report('src/lib/api.ts', api)
const typesOk = report('src/lib/types.ts', types)

/* ---- the lines the studio complained about ---- */

if (!apiOk) {
  const lines = api.split('\n')
  console.log('\nlines 45-100 of the emitted api.ts:')
  for (let i = 44; i < Math.min(100, lines.length); i++) {
    console.log(`  ${String(i + 1).padStart(3)} | ${lines[i]}`)
  }
}

/* ---- and what is stored, which is what the studio actually compiled ---- */

const stored = (await store.get(id)).files?.find((f) => f.path === 'src/lib/api.ts')
if (stored) {
  const storedOk = report('stored src/lib/api.ts (what was compiled)', stored.content)
  if (!storedOk && apiOk) {
    console.log('\n  The stored file is stale: emitting now produces a file that parses.')
    console.log('  Restart the studio server and generate again.')
  }
}

process.exit(apiOk && typesOk ? 0 : 1)
