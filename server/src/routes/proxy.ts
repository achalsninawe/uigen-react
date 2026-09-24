import { Router } from 'express'
import { asyncRoute, badRequest, notFound, param } from '../http.js'
import { ownedProject, ownedProjectMeta } from './auth.js'
import { store } from '../services/store.js'
import { recordCall } from '../services/netlog.js'
import { callUpstream, type CallPayload } from '../services/upstream.js'
import { applyObservedShape } from '../services/pipeline/probe.js'

export const proxyRouter = Router()

/**
 * Forwards one documented call to the real API.
 *
 * The generated app cannot reach most APIs directly from a browser — CORS
 * blocks it, and putting a token in page JavaScript is worse. So the app posts
 * the call here and this rebuilds the exact same URL server-side, from the
 * endpoint definition that was extracted from the specification.
 */
proxyRouter.post(
  '/:projectId/:operationId',
  asyncRoute(async (req, res) => {
    const projectId = param(req, 'projectId')
    const operationId = param(req, 'operationId')

    const project = await ownedProjectMeta(req, projectId)

    const endpoint = project.appSpec?.endpoints.find((e) => e.operationId === operationId)
    if (!endpoint) throw notFound(`No endpoint named "${operationId}" in this project`)

    let outcome
    try {
      outcome = await callUpstream(endpoint, project.connection, (req.body ?? {}) as CallPayload)
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : 'Could not build the request')
    }

    const learned = outcome.error ? undefined : await learnFromCall(req, projectId, operationId, outcome)

    recordCall(projectId, {
      operationId,
      method: endpoint.method,
      url: outcome.url,
      status: outcome.status,
      durationMs: outcome.durationMs,
      at: new Date().toISOString(),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(learned ? { learned } : {}),
    })

    if (outcome.error) {
      res.status(502).json({ error: `Could not reach ${outcome.url} — ${outcome.error}`, url: outcome.url })
      return
    }

    // The upstream status rides inside the envelope so a 404 from the API is
    // distinguishable from a 404 from this proxy.
    res.json({
      status: outcome.status,
      statusText: outcome.statusText,
      body: outcome.body,
      durationMs: outcome.durationMs,
      url: outcome.url,
    })
  }),
)

/**
 * Learns a response shape the documents never gave, from a call the preview
 * made anyway.
 *
 * "Returns it as a Map" leaves a screen guessing key names, and a guessed
 * `policyNumber` against a real `PolicyNo` renders a dash. The same answer the
 * Learn button gets is already passing through here, so keep it — once, for an
 * endpoint with no documented success type, and only from a success. The next
 * generate then types the screens against what the API really returns.
 */
async function learnFromCall(
  req: Parameters<typeof ownedProject>[0],
  projectId: string,
  operationId: string,
  outcome: { status: number; body: unknown },
): Promise<string | undefined> {
  if (outcome.status < 200 || outcome.status >= 300) return undefined
  const body = outcome.body
  if (body === null || typeof body !== 'object') return undefined
  if (Array.isArray(body) ? body.length === 0 : Object.keys(body).length === 0) return undefined

  // Flow APIs report failure inside a 200 — `result: 0` and a message. That is
  // an error's shape, not the success the screens need.
  const record = body as Record<string, unknown>
  if (record.result === 0 || record.success === false || 'error' in record || 'errors' in record) return undefined

  try {
    // The full project: saving the file-less meta copy would drop the app.
    const project = await ownedProject(req, projectId)
    const endpoint = project.appSpec?.endpoints.find((e) => e.operationId === operationId)
    if (!project.appSpec || !endpoint) return undefined
    if (endpoint.responses.some((r) => /^2\d\d$/.test(r.status) && r.typeName)) return undefined

    const { rootTypeName, entities } = applyObservedShape(project.appSpec, operationId, body, outcome.status)
    await store.save(project)

    const fields = entities.reduce((n, e) => n + e.fields.length, 0)
    return `Learned ${rootTypeName} (${fields} fields) from this response — regenerate to use the real field names`
  } catch (err) {
    // Learning is a bonus; the call itself already succeeded.
    console.warn(`[spec2ui] could not learn ${operationId}'s shape:`, err)
    return undefined
  }
}
