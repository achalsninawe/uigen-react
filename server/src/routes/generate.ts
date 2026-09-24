import { Router } from 'express'
import { asyncRoute, badRequest, notFound, openEventStream, param, serverOrigin } from '../http.js'
import { ownedProject } from './auth.js'
import { store } from '../services/store.js'
import { aiAvailable } from '../services/azure.js'
import { generate, repairApp } from '../services/pipeline/generate.js'
import { toWireProject } from '../serialize.js'
import { clearCalls, readCalls } from '../services/netlog.js'
import type { EmitContext } from '../services/emit/index.js'
import type { PipelineEvent } from '../types.js'

export const generateRouter = Router()

generateRouter.get(
  '/:id/generate',
  asyncRoute(async (req, res) => {
    const id = param(req, 'id')
    const project = await ownedProject(req, id)
    if (!project.appSpec) throw badRequest('Run the analysis before generating')
    if (!aiAvailable()) {
      throw badRequest('Generating screens needs Azure OpenAI — set AZURE_OPENAI_API_KEY in .env')
    }

    const sampleData = project.sampleData === true
    // `replan=1` throws away the previous screen architecture and starts over.
    // So does flipping the sample-data setting: which screens get invented
    // values is decided while planning, and an old plan carries the old answer.
    const replan =
      req.query.replan === '1' || !project.plan || (project.plan.sampleData ?? true) !== sampleData

    const stream = openEventStream(res)
    const send = (event: PipelineEvent) => stream.send(event)

    const ctx: EmitContext = {
      projectId: project.id,
      // The preview runs on a public sandbox origin and cannot reach localhost
      // directly, so it relays through the studio window.
      transport: 'bridge',
      serverOrigin: serverOrigin(req as never),
      // Documents routinely describe every operation and no server. Without
      // this the planner sees endpoints it believes nothing can call and gives
      // every screen sample data, so setting the host in Connection and
      // regenerating changed nothing.
      ...(project.connection.baseUrlOverride
        ? { baseUrlOverride: project.connection.baseUrlOverride }
        : {}),
    }

    try {
      project.status = replan ? 'planning' : 'generating'
      project.files = []
      await store.save(project)
      send({ type: 'status', status: project.status, message: 'Designing your app' })

      const result = await generate(
        project.appSpec,
        ctx,
        {
          log: (message, level = 'info') => send({ type: 'log', level, message }),
          onPlan: (plan) => {
            send({ type: 'plan', plan })
            send({ type: 'status', status: 'generating', message: `Building ${plan.screens.length} screens` })
          },
          onFile: (file) => send({ type: 'file', file }),
          onScreenStart: (screen) => send({ type: 'screen-start', screenId: screen.id, name: screen.name }),
          onScreenDone: (screen, path) => send({ type: 'screen-done', screenId: screen.id, path }),
        },
        replan ? undefined : project.plan,
        project.connection,
        sampleData,
      )

      project.plan = result.plan
      project.files = result.files
      project.status = 'ready'
      delete project.error
      await store.save(project)

      for (const { screen, violations } of result.violations) {
        for (const violation of violations) {
          send({ type: 'log', level: 'warn', message: `${screen}: ${violation.message}` })
        }
      }

      // Compile failures are the honest headline: a project that does not build
      // is not ready, however good the screens look in a listing.
      for (const error of result.typeErrors.slice(0, 15)) {
        send({
          type: 'log',
          level: 'error',
          message: `${error.file}:${error.line} — ${error.message}`,
        })
      }

      send({
        type: 'status',
        status: 'ready',
        message: result.compiles
          ? `${result.files.length} files generated and the project compiles`
          : `${result.files.length} files generated, but ${result.typeErrors.length} compile error(s) remain`,
      })
      send({ type: 'done', project: toWireProject(project) })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Generation failed'
      project.status = 'failed'
      project.error = message
      await store.save(project).catch(() => {})
      send({ type: 'error', message })
    } finally {
      stream.close()
    }
  }),
)

/**
 * Another attempt at the screens already generated.
 *
 * GET because it streams, like analyze and generate. `note` carries what the
 * person saw go wrong — the compiler cannot find a bug in a file that compiles,
 * so without it this can only fix what type-checking catches.
 */
generateRouter.get(
  '/:id/repair',
  asyncRoute(async (req, res) => {
    const project = await ownedProject(req, param(req, 'id'))
    if (!project.appSpec || !project.plan) throw badRequest('Generate the app before fixing it')
    if (!aiAvailable()) throw badRequest('Fixing screens needs Azure OpenAI — set AZURE_OPENAI_API_KEY in .env')

    const note = typeof req.query.note === 'string' ? req.query.note.slice(0, 2000) : undefined
    const mode = req.query.mode === 'refine' ? 'refine' : 'fix'
    const stream = openEventStream(res)
    const send = (event: PipelineEvent) => stream.send(event)

    try {
      project.status = 'generating'
      await store.save(project)
      send({
        type: 'status',
        status: 'generating',
        message: mode === 'refine' ? 'Refining the screens' : 'Looking at the generated screens',
      })

      const result = await repairApp(
        project.appSpec,
        project.plan,
        project.files,
        { note, mode },
        {
          log: (message, level = 'info') => send({ type: 'log', level, message }),
          onFile: (file) => send({ type: 'file', file }),
        },
      )

      project.files = result.files
      project.status = 'ready'
      delete project.error
      await store.save(project)

      send({
        type: 'status',
        status: 'ready',
        message: result.compiles
          ? 'The project compiles'
          : `${result.typeErrors.length} compile error(s) remain`,
      })
      send({ type: 'done', project: toWireProject(project) })
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : 'Could not fix the screens' })
    } finally {
      stream.close()
    }
  }),
)

/** Returns the generated file tree with contents, for the preview and editor. */
generateRouter.get(
  '/:id/files',
  asyncRoute(async (req, res) => {
    const project = await ownedProject(req, param(req, 'id'))
    res.json({ files: project.files, plan: project.plan ?? null })
  }),
)

/** Saves a hand-edit from the in-studio editor. */
generateRouter.put(
  '/:id/files',
  asyncRoute(async (req, res) => {
    const project = await ownedProject(req, param(req, 'id'))

    const body = req.body as { path?: string; content?: string }
    if (!body.path || typeof body.content !== 'string') throw badRequest('Provide path and content')

    const existing = project.files.find((f) => f.path === body.path)
    if (existing) existing.content = body.content
    else project.files.push({ path: body.path, content: body.content, origin: 'model' })

    await store.save(project)
    res.json({ ok: true })
  }),
)

/** Recent calls the preview made through the proxy. */
generateRouter.get(
  '/:id/calls',
  asyncRoute(async (req, res) => {
    res.json({ calls: readCalls(param(req, 'id')) })
  }),
)

generateRouter.delete(
  '/:id/calls',
  asyncRoute(async (req, res) => {
    clearCalls(param(req, 'id'))
    res.status(204).end()
  }),
)
