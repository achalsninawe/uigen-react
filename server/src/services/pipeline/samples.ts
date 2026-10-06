import { chatJson, aiAvailable } from '../azure.js'
import { samplesSchema } from '../../schemas.js'
import { SAMPLES_SYSTEM, samplesUser } from '../../prompts/aiBuild.js'
import { callUpstream } from '../upstream.js'
import { applyObservedShape, harvest, looksLikeFailure, pathParamNames, valueFor } from './probe.js'
import type { AppSpec, ConnectionSettings, Endpoint, SpecDocument } from '../../types.js'

/** A handful is enough to see every shape a small app reads, and bounds the time. */
const MAX_CALLS = 8
const TIMEOUT_MS = 20_000

type Log = (message: string, level?: 'info' | 'warn' | 'error') => void

function hasRealExample(endpoint: Endpoint): boolean {
  return endpoint.responses.some((r) => /^2\d\d$/.test(r.status) && r.example !== undefined)
}

/**
 * Calls each read-only endpoint once and records what it really returns.
 *
 * A documented response is often absent ("returns it as a Map") or wrong, and
 * every screen built on a guess of it shows dashes. One real call settles it.
 * The model decides which endpoints are read-only and supplies inputs from the
 * documents' own examples; anything that could change data is never called.
 *
 * Mutates `appSpec` in place, as the automatic probe and the Learn button do, so
 * the route's save keeps what was learned and the next run skips it.
 */
export async function collectSamples(
  appSpec: AppSpec,
  documents: SpecDocument[],
  connection: ConnectionSettings,
  log: Log,
): Promise<void> {
  const reachable = (e: Endpoint) => Boolean(connection.baseUrlOverride?.trim() || e.baseUrl.trim())
  // Lists before details: `/projects/{projectId}` needs an id only the list can give.
  const candidates = appSpec.endpoints
    .filter((e) => !hasRealExample(e) && reachable(e))
    .sort((a, b) => pathParamNames(a.path).length - pathParamNames(b.path).length)
  if (candidates.length === 0 || !aiAvailable()) return

  log(`Looking for real responses from ${candidates.length} endpoint(s)`)

  let decided
  try {
    decided = await chatJson({
      system: SAMPLES_SYSTEM,
      user: samplesUser(documents, candidates),
      schema: samplesSchema,
      temperature: 0,
    })
  } catch (err) {
    log(`Could not decide which endpoints are safe to call: ${err instanceof Error ? err.message : err}`, 'warn')
    return
  }

  // Real values seen so far, e.g. every `id` the list returned.
  const seen = new Map<string, string>()
  let calls = 0
  for (const endpoint of candidates) {
    const choice = decided.endpoints.find((d) => d.operationId === endpoint.operationId)

    if (!choice?.readOnly) {
      log(
        `Not calling ${endpoint.operationId} — it may change data${choice?.why ? ` (${choice.why})` : ''}. ` +
          'Use Learn shape on it, or add an example response to the docs.',
      )
      continue
    }
    if (endpoint.requestBody && choice.body === undefined) {
      log(`Not calling ${endpoint.operationId} — the documents give no example request to send`, 'warn')
      continue
    }
    /*
     * A real id from an earlier response beats one the model read in prose:
     * the documents' sample rows ("Claims AI Agent") are rarely records that
     * exist, and a 404 teaches nothing.
     */
    const pathParams: Record<string, unknown> = { ...(choice.pathParams ?? {}) }
    for (const name of pathParamNames(endpoint.path)) {
      const real = valueFor(name, endpoint, seen)
      if (real !== undefined) pathParams[name] = real
    }
    const missing = pathParamNames(endpoint.path).filter((n) => pathParams[n] === undefined || pathParams[n] === '')
    if (missing.length > 0) {
      log(`Not calling ${endpoint.operationId} — no real value for ${missing.join(', ')}`, 'warn')
      continue
    }

    if (calls >= MAX_CALLS) break
    calls++

    const outcome = await callUpstream(
      endpoint,
      connection,
      {
        ...(Object.keys(pathParams).length > 0 ? { pathParams } : {}),
        ...(choice.query ? { query: choice.query } : {}),
        ...(choice.body !== undefined ? { body: choice.body } : {}),
      },
      TIMEOUT_MS,
    ).catch((err: unknown) => ({ status: 0, body: undefined, error: String(err) }))

    if ('error' in outcome && outcome.error) {
      log(`${endpoint.operationId}: could not reach the API — ${outcome.error}`, 'warn')
      continue
    }
    if (outcome.status < 200 || outcome.status >= 300 || looksLikeFailure(outcome.body)) {
      log(`${endpoint.operationId}: returned ${outcome.status} without usable data — built from the docs instead`, 'warn')
      continue
    }

    harvest(outcome.body, seen)
    const { rootTypeName, entities } = applyObservedShape(appSpec, endpoint.operationId, outcome.body, outcome.status)
    const fields = entities.reduce((n, e) => n + e.fields.length, 0)
    log(`Read a real response from ${endpoint.operationId}: ${rootTypeName}, ${fields} fields`)
  }
}
