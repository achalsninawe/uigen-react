// Local reproduction of a Project Tracker generation. Throwaway local storage; no Azure projects touched.
import './local-env.js'
import fs from 'node:fs'
import { parseFile } from '../src/services/parsers/index.js'
import { analyze } from '../src/services/pipeline/analyze.js'
import { aiGenerate } from '../src/services/pipeline/aiGenerate.js'
import type { SpecDocument } from '../src/types.js'

const file = 'C:/Users/achal.ninawe/Downloads/# Project Tracker – UI Generation A.md'
const buffer = fs.readFileSync(file)
const parsed = await parseFile('Project Tracker.md', buffer)
const documents: SpecDocument[] = [
  { id: 'd1', filename: 'Project Tracker.md', kind: parsed.kind, bytes: buffer.length, blobPath: '', text: parsed.text, uploadedAt: '' },
]

const appSpec = await analyze(documents, { log: (m) => console.log('[analyze]', m) })
console.log('\nENDPOINTS')
for (const e of appSpec.endpoints) console.log(' ', e.method, e.baseUrl + e.path, e.operationId, 'resp:', e.responses.map((r) => `${r.status}/${r.typeName ?? '-'}`).join(','))

const result = await aiGenerate(
  appSpec,
  documents,
  { projectId: 'repro', transport: 'bridge', serverOrigin: 'http://localhost:5177' },
  { log: (m, l = 'info') => console.log(`[${l}]`, m) },
  { extraHeaders: {} },
  false,
)

console.log('\nSCREENS')
for (const s of result.plan.screens) console.log(' ', s.name, s.route, 'calls=', s.endpointIds.join(','), 'receives=', s.receives || '-')
console.log('compiles:', result.compiles)
const out = 'C:/Users/ACHAL~1.NIN/AppData/Local/Temp/claude/D--UI-GEN/fbd1b589-a538-48c8-8f7a-36639375f226/scratchpad/tracker-out'
for (const f of result.files) {
  if (!f.path.startsWith('src/screens/') && !f.path.startsWith('src/lib/')) continue
  const p = `${out}/${f.path}`
  fs.mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true })
  fs.writeFileSync(p, f.content)
}
console.log('written to', out)
