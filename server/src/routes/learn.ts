import { Router } from 'express'
import { asyncRoute, badRequest, notFound, param } from '../http.js'
import { ownedProject } from './auth.js'
import { store } from '../services/store.js'
import { recordCall } from '../services/netlog.js'
import { callUpstream, type CallPayload } from '../services/upstream.js'
import { applyObservedShape } from '../services/pipeline/probe.js'
import { toWireProject } from '../serialize.js'

export const learnRouter = Router()

/**
 * Calls an endpoint for real and learns the shape of what comes back.
 *
 * Documentation that describes an operation but not its response is the norm,
 * and it leaves generated screens unable to render anything — they know a call
 * succeeds but not what a success contains. One real call answers that
 * definitively, and unlike a guess it cannot be wrong.
 */
learnRouter.post(
  '/:id/endpoints/:operationId/learn',
  asyncRoute(async (req, res) => {
    const id = param(req, 'id')
    const operationId = param(req, 'operationId')

    const project = await ownedProject(req, id)

    const endpoint = project.appSpec?.endpoints.find((e) => e.operationId === operationId)
    if (!endpoint || !project.appSpec) throw notFound(`No endpoint named "${operationId}"`)

    let outcome
    try {
      outcome = await callUpstream(endpoint, project.connection, (req.body ?? {}) as CallPayload)
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : 'Could not build the request')
    }

    recordCall(id, {
      operationId,
      method: endpoint.method,
      url: outcome.url,
      status: outcome.status,
      durationMs: outcome.durationMs,
      at: new Date().toISOString(),
      ...(outcome.error ? { error: outcome.error } : {}),
    })

    if (outcome.error) {
      throw badRequest(`Could not reach ${outcome.url} — ${outcome.error}`)
    }
    if (outcome.status >= 400) {
      // Point at the likely cause rather than making the user guess which of
      // credentials, URL or body was wrong.
      const hint =
        outcome.status === 401 || outcome.status === 403
          ? project.connection.authValue
            ? 'The saved credential was rejected — it may have expired. Paste a fresh one in Connection.'
            : 'No credential is saved. Add one in Connection, then try again.'
          : outcome.status === 404
            ? `Nothing is served at ${outcome.url}. Check the base URL in Connection.`
            : outcome.status === 422 || outcome.status === 400
              ? 'The API rejected the request body. Adjust it above and try again.'
              : 'Check the credentials, base URL and body, then try again.'

      throw badRequest(`The API returned ${outcome.status}. ${hint} Nothing was learned from an error response.`)
    }
    if (outcome.body === null || typeof outcome.body !== 'object') {
      throw badRequest('The response was not a JSON object or array, so there is no shape to learn.')
    }

    // Shared with the automatic probe, so pressing the button and generating
    // cannot disagree about what a response contains.
    const { rootTypeName, entities } = applyObservedShape(
      project.appSpec,
      operationId,
      outcome.body,
      outcome.status,
    )

    // The screens were generated against the old, empty shape.
    if (project.status === 'ready') project.status = 'analyzed'
    await store.save(project)

    res.json({
      rootTypeName,
      learned: entities.map((e) => ({ name: e.name, fields: e.fields.length })),
      status: outcome.status,
      url: outcome.url,
      durationMs: outcome.durationMs,
      project: toWireProject(project),
    })
  }),
)
