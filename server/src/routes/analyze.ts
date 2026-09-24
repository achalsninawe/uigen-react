import { Router } from 'express'
import { asyncRoute, notFound, openEventStream, param } from '../http.js'
import { ownedProject } from './auth.js'
import { store } from '../services/store.js'
import { analyze } from '../services/pipeline/analyze.js'
import { aiAvailable } from '../services/azure.js'
import { toWireProject } from '../serialize.js'
import type { PipelineEvent } from '../types.js'

export const analyzeRouter = Router()

/**
 * Streams the analysis so the UI can reveal endpoints as they are found.
 * GET rather than POST because EventSource only speaks GET.
 */
analyzeRouter.get(
  '/:id/analyze',
  asyncRoute(async (req, res) => {
    const id = param(req, 'id')
    const project = await ownedProject(req, id)

    const stream = openEventStream(res)
    const send = (event: PipelineEvent) => stream.send(event)

    try {
      project.status = 'analyzing'
      project.mock = !aiAvailable()
      await store.save(project)
      send({ type: 'status', status: 'analyzing', message: 'Reading your documents' })

      if (!aiAvailable()) {
        send({
          type: 'log',
          level: 'warn',
          message: 'No Azure OpenAI key configured — only machine-readable specs will be analysed.',
        })
      }

      const appSpec = await analyze(project.documents, {
        log: (message, level = 'info') => send({ type: 'log', level, message }),
        onEndpoint: (endpoint) => send({ type: 'endpoint', endpoint }),
      })

      project.appSpec = appSpec
      project.status = 'analyzed'
      delete project.error
      await store.save(project)

      send({ type: 'appspec', appSpec })
      send({ type: 'status', status: 'analyzed', message: `Found ${appSpec.endpoints.length} endpoints` })
      send({ type: 'done', project: toWireProject(project) })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Analysis failed'
      project.status = 'failed'
      project.error = message
      await store.save(project).catch(() => {})
      send({ type: 'error', message })
    } finally {
      stream.close()
    }
  }),
)

/** Lets a human correct the extraction before any code is generated. */
analyzeRouter.put(
  '/:id/appspec',
  asyncRoute(async (req, res) => {
    const project = await ownedProject(req, param(req, 'id'))

    const body = req.body as { appSpec?: unknown }
    if (!body.appSpec || typeof body.appSpec !== 'object') {
      throw notFound('Request must include an appSpec object')
    }

    project.appSpec = body.appSpec as typeof project.appSpec
    if (project.status === 'analyzed' || project.status === 'ready') project.status = 'analyzed'
    await store.save(project)
    res.json({ project: toWireProject(project) })
  }),
)
