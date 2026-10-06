/**
 * Read-only: prints what a stored project holds, to diagnose a generation.
 *   npx tsx scripts/inspect-project.ts <email> <name fragment>
 */
import { storage } from '../src/services/blobs.js'
import { store } from '../src/services/store.js'

const [email, fragment = ''] = process.argv.slice(2)
const user = await storage().getUserByEmail(email!)
if (!user) throw new Error('no such user')
const rows = (await storage().listSummaries(user.id)).filter((r) =>
  r.name.toLowerCase().includes(fragment.toLowerCase()),
)
rows.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
console.log(rows.map((r) => `${r.id}  ${r.name}  ${r.updatedAt}  saved=${Boolean(r.savedAt)}`).join('\n'))

const project = rows[0] ? await store.get(rows[0].id) : null
if (!project) process.exit(0)

console.log('\ngenerator:', project.generator ?? 'classic', ' plan.builder:', project.plan?.builder, ' sampleData:', project.sampleData)
console.log('connection base:', project.connection.baseUrlOverride || '(none)', ' auth set:', Boolean(project.connection.authValue))
console.log('documents:', project.documents.map((d) => `${d.filename} (${d.text.length} chars)`).join(', '))
console.log('\nENDPOINTS')
for (const e of project.appSpec?.endpoints ?? []) {
  const ok = e.responses.find((r) => /^2\d\d$/.test(r.status))
  console.log(
    `  ${e.method} ${e.baseUrl || '(no base)'}${e.path}  ${e.operationId}  resp=${ok?.typeName ?? '-'} example=${ok?.example !== undefined}`,
  )
}
console.log('\nGAPS')
for (const g of project.appSpec?.gaps ?? []) console.log(`  [${g.severity}] ${g.topic}: ${g.detail}`)
console.log('\nSCREENS')
for (const s of project.plan?.screens ?? []) {
  console.log(`  ${s.name} ${s.route} calls=${s.endpointIds.join(',') || '-'} receives=${s.receives || s.incomingType || '-'}`)
  if (s.brief) console.log(`    brief: ${s.brief.slice(0, 400).replace(/\n/g, ' ')}`)
}
