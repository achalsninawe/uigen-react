/**
 * Reading the API instead of only reading about it.
 *
 * A requirements document names its fields the way a person says them — "Project
 * Name", "Last Update" — and the API names them the way a programmer typed them
 * — `projectName`, `lastUpdate`. Types derived from the prose therefore describe
 * a payload that never arrives: the screen compiles, the call succeeds, the
 * table renders the right number of rows, and every cell is a dash, because
 * every field it asks for is absent.
 *
 * That was diagnosable only by noticing five columns of dashes and pressing a
 * button per endpoint. The information was never missing — the proxy had the
 * real response in hand and discarded it. So this calls each safe endpoint once,
 * before any screen is planned, and lets what came back win.
 *
 * Only GET, and never anything else. A probe that POSTs to find out what a
 * response looks like creates a record in someone's system, and there is no
 * response shape worth that. Endpoints that are skipped say why.
 */
import { inferTypes, markDateFields } from '../infer.js'
import { callUpstream } from '../upstream.js'
import { toPascalCase } from '../emit/lang.js'
import type { AppSpec, ConnectionSettings, Endpoint, Entity } from '../../types.js'

/** Merges inferred entities in, preferring whichever definition is richer. */
export function mergeEntities(existing: Entity[], inferred: Entity[]): Entity[] {
  const byName = new Map(existing.map((e) => [e.name, e]))

  for (const entity of inferred) {
    const current = byName.get(entity.name)
    if (!current) {
      byName.set(entity.name, entity)
      continue
    }
    // A shape observed in a real response is stronger evidence than one guessed
    // from prose, so its fields win on conflict.
    const fields = new Map(current.fields.map((f) => [f.name, f]))
    for (const field of entity.fields) fields.set(field.name, field)
    byName.set(entity.name, { ...current, fields: [...fields.values()] })
  }

  return [...byName.values()]
}

/**
 * As mergeEntities, but a live observation replaces the entity outright.
 *
 * Merging kept the fields guessed from prose alongside the real ones, so a
 * list type carried both `"Project Name"` (from a table heading) and
 * `projectName` (from the API). A screen that picked the guessed one compiled
 * and rendered an empty column. What the API returned is the whole truth.
 */
export function replaceEntities(existing: Entity[], observed: Entity[]): Entity[] {
  const byName = new Map(existing.map((e) => [e.name, e]))
  for (const entity of observed) {
    const current = byName.get(entity.name)
    byName.set(entity.name, current?.description ? { ...entity, description: current.description } : entity)
  }
  return [...byName.values()]
}

/** True when a 2xx body is not a success worth learning a shape from. */
export function looksLikeFailure(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return true
  if (Array.isArray(body) ? body.length === 0 : Object.keys(body).length === 0) return true
  // Flow APIs report failure inside a 200 — `result: 0` and a message. That is
  // an error's shape, not the success the screens need.
  const record = body as Record<string, unknown>
  return record.result === 0 || record.success === false || 'error' in record || 'errors' in record
}

/**
 * Records a real response against the endpoint that produced it.
 *
 * Shared with the Learn route so that pressing the button and probing
 * automatically cannot disagree about what was learned.
 */
export function applyObservedShape(
  appSpec: AppSpec,
  operationId: string,
  body: unknown,
  status: number,
): { rootTypeName: string; entities: Entity[] } {
  const rootName = `${toPascalCase(operationId, 'Operation')}Response`
  const { rootTypeName, entities } = inferTypes(body, rootName, undefined, { allOptional: true })
  markDateFields(body, entities)

  appSpec.entities = replaceEntities(appSpec.entities, entities)

  const endpoint = appSpec.endpoints.find((e) => e.operationId === operationId)
  if (endpoint) {
    const key = String(status)
    const response = endpoint.responses.find((r) => r.status === key)
    if (response) {
      response.typeName = rootTypeName
      response.contentType ??= 'application/json'
      response.example = body
    } else {
      endpoint.responses.push({
        status: key,
        description: 'Observed in a live call',
        contentType: 'application/json',
        typeName: rootTypeName,
        example: body,
      })
    }
  }

  return { rootTypeName, entities }
}

export interface ProbeReport {
  probed: { operationId: string; status: number; typeName: string; fields: number }[]
  skipped: { operationId: string; why: string }[]
  /** Field names the documents claimed that the real response does not carry. */
  corrected: { operationId: string; documented: string[]; observed: string[] }[]
}

/** Path parameter names in a template, e.g. `/projects/{projectId}/updates`. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}|:([A-Za-z0-9_]+)/g)].map((m) => m[1] ?? m[2]!)
}

/**
 * Every scalar in a payload, keyed by the field that held it.
 *
 * A detail endpoint needs an id, and the list endpoint just returned five of
 * them. Harvesting is what lets `/projects/{projectId}` be probed at all — the
 * alternative is skipping every endpoint that takes a parameter, which is most
 * of the interesting ones.
 */
export function harvest(body: unknown, into: Map<string, string>, depth = 0): void {
  if (depth > 3 || body === null || typeof body !== 'object') return

  if (Array.isArray(body)) {
    for (const item of body.slice(0, 3)) harvest(item, into, depth + 1)
    return
  }

  for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value)
      // An id is short and non-empty; a description is neither.
      if (text.length > 0 && text.length <= 64 && !into.has(name)) into.set(name, text)
    } else {
      harvest(value, into, depth + 1)
    }
  }
}

/** A value for one path parameter, from the spec or from what we have seen. */
export function valueFor(name: string, endpoint: Endpoint, harvested: Map<string, string>): string | undefined {
  const documented = endpoint.pathParams.find((p) => p.name === name)
  if (documented?.example) return documented.example
  if (documented?.enum?.length) return documented.enum[0]

  const exact = harvested.get(name)
  if (exact) return exact

  /*
   * `/projects/{projectId}` is fed by a list whose records call it `id`. Match
   * on the resource rather than demanding the two documents agree on a spelling,
   * which they routinely do not.
   */
  const lower = name.toLowerCase()
  for (const [key, value] of harvested) {
    const candidate = key.toLowerCase()
    if (candidate === lower) return value
    if (lower.endsWith('id') && candidate === 'id') return value
    if (lower === `${candidate}id` || candidate === `${lower}id`) return value
  }

  return undefined
}

/** Field names a screen would have read, had we trusted the documents. */
function documentedFieldNames(appSpec: AppSpec, endpoint: Endpoint): string[] {
  const success = endpoint.responses.find((r) => /^2\d\d$/.test(r.status))
  const name = success?.typeName?.replace(/\[\]$/, '').trim()
  if (!name) return []
  return appSpec.entities.find((e) => e.name === name)?.fields.map((f) => f.name) ?? []
}

const MAX_CALLS = 12

/**
 * Calls every safely callable GET once and replaces guessed shapes with real
 * ones. Mutates `appSpec`; returns what happened so it can be reported.
 */
export async function probeEndpoints(
  appSpec: AppSpec,
  connection: ConnectionSettings,
  log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
): Promise<ProbeReport> {
  const report: ProbeReport = { probed: [], skipped: [], corrected: [] }

  const reachable = (e: Endpoint) =>
    Boolean(connection.baseUrlOverride?.trim()) || Boolean(e.baseUrl.trim())

  for (const endpoint of appSpec.endpoints) {
    if (endpoint.method !== 'GET') {
      report.skipped.push({
        operationId: endpoint.operationId,
        why: `${endpoint.method} — only GET is probed, so nothing is created or deleted`,
      })
    } else if (!reachable(endpoint)) {
      report.skipped.push({ operationId: endpoint.operationId, why: 'no base URL' })
    }
  }

  /*
   * Lists before details. A detail endpoint needs an id it cannot invent, and
   * the list that returns one has to have run first for harvesting to have
   * anything in it.
   */
  const candidates = appSpec.endpoints
    .filter((e) => e.method === 'GET' && reachable(e))
    .sort((a, b) => pathParamNames(a.path).length - pathParamNames(b.path).length)

  if (candidates.length === 0) return report

  log(`Reading ${candidates.length} endpoint(s) to learn what they really return`)

  const harvested = new Map<string, string>()
  let calls = 0

  for (const endpoint of candidates) {
    if (calls >= MAX_CALLS) {
      report.skipped.push({ operationId: endpoint.operationId, why: `probe limit of ${MAX_CALLS} reached` })
      continue
    }

    const needed = pathParamNames(endpoint.path)
    const pathParams: Record<string, unknown> = {}
    const unfilled: string[] = []

    for (const name of needed) {
      const value = valueFor(name, endpoint, harvested)
      if (value === undefined) unfilled.push(name)
      else pathParams[name] = value
    }

    if (unfilled.length > 0) {
      report.skipped.push({
        operationId: endpoint.operationId,
        why: `no value for ${unfilled.join(', ')}`,
      })
      continue
    }

    // Required query parameters we cannot supply would only produce a 400.
    const missingQuery = endpoint.queryParams
      .filter((p) => p.required && !p.example && !p.enum?.length)
      .map((p) => p.name)
    if (missingQuery.length > 0) {
      report.skipped.push({
        operationId: endpoint.operationId,
        why: `required query parameter(s) ${missingQuery.join(', ')} have no documented value`,
      })
      continue
    }

    const query: Record<string, unknown> = {}
    for (const p of endpoint.queryParams) {
      const value = p.example ?? p.enum?.[0]
      if (value !== undefined) query[p.name] = value
    }

    calls++
    let outcome
    try {
      outcome = await callUpstream(endpoint, connection, { pathParams, query }, 15_000)
    } catch (err) {
      report.skipped.push({
        operationId: endpoint.operationId,
        why: err instanceof Error ? err.message : 'the request could not be built',
      })
      continue
    }

    if (outcome.error) {
      report.skipped.push({ operationId: endpoint.operationId, why: outcome.error })
      continue
    }
    if (outcome.status >= 400) {
      report.skipped.push({ operationId: endpoint.operationId, why: `returned ${outcome.status}` })
      continue
    }
    if (outcome.body === null || typeof outcome.body !== 'object') {
      report.skipped.push({ operationId: endpoint.operationId, why: 'the response was not JSON' })
      continue
    }

    const before = documentedFieldNames(appSpec, endpoint)
    const { rootTypeName, entities } = applyObservedShape(
      appSpec,
      endpoint.operationId,
      outcome.body,
      outcome.status,
    )

    harvest(outcome.body, harvested)

    const observed = entities.flatMap((e) => e.fields.map((f) => f.name))
    report.probed.push({
      operationId: endpoint.operationId,
      status: outcome.status,
      typeName: rootTypeName,
      fields: observed.length,
    })

    /*
     * Say when the documents were wrong, not merely that something was learned.
     * A silent correction is the same failure in a nicer costume: nobody finds
     * out their specification does not describe their API.
     */
    const wrong = before.filter((name) => !observed.includes(name))
    if (before.length > 0 && wrong.length > 0) {
      report.corrected.push({ operationId: endpoint.operationId, documented: before, observed })
      log(
        `${endpoint.operationId}: your documents name ${wrong.join(', ')}, which the API does not return. ` +
          `Using what it does return: ${observed.slice(0, 8).join(', ')}` +
          `${observed.length > 8 ? `, +${observed.length - 8} more` : ''}`,
        'warn',
      )
    } else {
      log(`${endpoint.operationId}: ${observed.length} field(s) confirmed against the live API`)
    }
  }

  for (const { operationId, why } of report.skipped) {
    // A non-GET being skipped is the design, not a problem worth a warning.
    if (/only GET is probed/.test(why)) continue
    log(`${operationId}: not read — ${why}`, 'warn')
  }

  return report
}
