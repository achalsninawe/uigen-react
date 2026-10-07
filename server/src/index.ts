import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { HttpError } from './http.js'
import { authRouter, requireUser } from './routes/auth.js'
import { projectsRouter } from './routes/projects.js'
import { analyzeRouter } from './routes/analyze.js'
import { generateRouter } from './routes/generate.js'
import { exportRouter } from './routes/export.js'
import { proxyRouter } from './routes/proxy.js'
import { learnRouter } from './routes/learn.js'
import { storage } from './services/blobs.js'

const app = express()

// The studio runs on a different port in development, so the session cookie
// only travels if the origin is reflected and credentials are allowed.
app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '25mb' }))

app.use('/api/auth', authRouter)

/*
 * Everything below the mount is private.
 *
 * Guarding the mount rather than each route means a new endpoint is private
 * before it is written; the alternative is remembering to add a guard, which is
 * how an endpoint ends up public.
 */
app.use('/api/projects', requireUser, projectsRouter)
app.use('/api/projects', requireUser, analyzeRouter)
app.use('/api/projects', requireUser, generateRouter)
app.use('/api/projects', requireUser, exportRouter)
app.use('/api/projects', requireUser, learnRouter)
app.use('/api/proxy', requireUser, proxyRouter)

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'spec2ui',
    ai: config.azureOpenAI.isConfigured ? 'ready' : 'mock',
    storage: config.storage.isConfigured ? 'azure' : 'local',
    deployment: config.azureOpenAI.deployment,
  })
})

/*
 * The studio itself, when it has been built.
 *
 * In development Vite serves it and proxies /api here. Deployed as one
 * container there is no Vite, so this serves web/dist and answers every
 * non-API route with index.html, which is what lets a refresh on
 * /projects/abc land on the app instead of a 404.
 */
const webDist = path.join(config.repoRoot, 'web', 'dist')
if (fs.existsSync(path.join(webDist, 'index.html'))) {
  app.use(express.static(webDist, { index: false }))
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')))
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500
  const message = err instanceof Error ? err.message : 'Unexpected error'
  if (status >= 500) console.error('[spec2ui]', err)
  res.status(status).json({ error: message })
})

// Fail loudly at boot rather than on the first upload if the account is wrong.
storage()
  .init()
  .catch((err: unknown) => {
    console.error('[spec2ui] storage init failed:', err instanceof Error ? err.message : err)
  })

app.listen(config.port, () => {
  console.log(`\n  spec2ui server  http://localhost:${config.port}`)
  console.log(`  ai              ${config.azureOpenAI.isConfigured ? 'azure openai · ' + config.azureOpenAI.deployment :'MOCK (set AZURE_OPENAI_API_KEY)'}`)
  console.log(`  storage         ${config.storage.isConfigured ? 'azure blob + table' : 'local filesystem (' + config.workDir + ')'}\n`)
})
