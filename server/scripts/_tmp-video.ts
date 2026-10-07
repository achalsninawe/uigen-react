import fs from 'node:fs'
import { storage } from '../src/services/blobs.js'
import { signSession, SESSION_COOKIE } from '../src/services/auth.js'
const user = await storage().getUserByEmail('achal.ninawe@insuremo.com')
const { token } = signSession(user!.id)
const base = 'http://localhost:5173'
const headers = { Cookie: `${SESSION_COOKIE}=${token}`, Origin: base, 'Content-Type': 'application/json' }
const p = `${base}/api/projects/nxm5zwtytjcc/demo-video`
const { jobId } = (await (await fetch(p, { method: 'POST', headers, body: '{}' })).json()) as { jobId: string }
const seen: string[] = []
let prev = 0, changes = 0
for (let i = 0; ; i++) {
  await new Promise((r) => setTimeout(r, 500))
  const f = await fetch(`${p}/${jobId}/frame`, { headers })
  let size = 0
  if (f.status === 200) { const b = Buffer.from(await f.arrayBuffer()); size = b.length; if (size !== prev) changes++; prev = size
    if (i === 40) fs.writeFileSync('C:/Users/ACHAL~1.NIN/AppData/Local/Temp/claude/D--UI-GEN/9a0af9fa-0545-4ad7-b02c-841581601e52/scratchpad/frame.jpg', b) }
  seen.push(f.status === 200 ? 'F' : '.')
  const s = (await (await fetch(`${p}/${jobId}`, { headers })).json()) as Record<string, unknown>
  if (s.state !== 'running') break
}
console.log(seen.join(''), '\nframe changes:', changes)
