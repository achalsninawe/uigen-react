/**
 * Calling each endpoint once and saying, per endpoint, whether it works.
 *
 * A screen built on an endpoint that answers 401, or 200 with `result: 0`, or
 * an empty list, renders "no data" and looks like a generation bug. Finding
 * that out in the preview costs a full generate; finding it here costs one
 * call, and the answer says what to fix — the credential, the URL, the body.
 *
 * Every 2xx that carries data also teaches the endpoint its real response
 * shape, through the same `applyObservedShape` the automatic probe and the
 * Learn button use, so the screens generated next are laid out against what
 * the API actually returns.
 *
 * Writes are only called when the person asks for them. A POST that "tests"
 * an endpoint also creates a record in someone's system.
 */
import { callUpstream, type CallPayload, type CallOutcome } from '../upstream.js'
import { applyObservedShape, harvest, pathParamNames, valueFor } from './probe.js'
import type { AppSpec, ConnectionSettings, Endpoint, EndpointTest } from '../../types.js'

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

/*
 * Flow APIs put reads behind POST — "Gry_QueryPolicyByNumber", a refund
 * quotation that "does not store data" — so the verb alone would skip every
 * endpoint such an app has. A POST whose name says it reads is treated as a
 * read; one that also says it changes something is not. Kept in step with the
 * copy in web/src/components/EndpointsSection.tsx.
 */
const READ_WORDS = /query|search|get|list|find|fetch|retriev|lookup|inquir|enquir|view|quot|calc|preview|estimat|validat|check|trial/i
const WRITE_WORDS = /create|save|execut|submit|updat|delet|remov|regist|issue|cancel|pay|approv|reject|insert|confirm|terminat/i

export const isWrite = (endpoint: Endpoint) => {
  if (READS.has(endpoint.method)) return false
  if (endpoint.method !== 'POST') return true
  // The operation id starts with the verb ("postX"), so only the name and path speak.
  const words = `${endpoint.name} ${endpoint.path} ${endpoint.summary ?? ''}`
  return !(READ_WORDS.test(words) && !WRITE_WORDS.test(words))
}

/** Points at the likely cause rather than making the person guess. */
function hintFor(status: number, url: string, connection: ConnectionSettings): string {
  if (status === 401 || status === 403) {
    return connection.authValue
      ? 'The saved credential was rejected; it may have expired. Paste a fresh one in Connection.'
      : 'No credential is saved. Add one in Connection.'
  }
  if (status === 404) return `Nothing is served at ${url}. Check the base URL and path.`
  if (status === 400 || status === 422) return 'The API rejected the request. Check the body and parameters.'
  if (status >= 500) return 'The API failed while handling the request. Its own logs will say why.'
  return 'Check the credential, URL and body.'
}

/**
 * A 200 that reports failure in its body — flow APIs do this — is a failed
 * call, not a passed one. Returns the API's own words when it gave any.
 */
function failureInBody(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const failed =
    record.result === 0 ||
    record.success === false ||
    (typeof record.status === 'string' && /^(fail|failed|error)$/i.test(record.status)) ||
    'error' in record ||
    (Array.isArray(record.errors) && record.errors.length > 0) ||
    (Array.isArray(record.Errors) && record.Errors.length > 0)
  if (!failed) return undefined

  const said = [record.message, record.error, record.errors, record.Errors]
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .map((v) => (typeof v === 'string' ? v : v && typeof v === 'object' && 'message' in v ? String(v.message) : ''))
    .filter(Boolean)
  return said.length > 0 ? said.slice(0, 3).join(' ') : 'the response body reports a failure'
}

/** Header values the documents give, sent the way the generated client sends them. */
function documentedHeaders(endpoint: Endpoint): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const header of endpoint.headers) if (header.example) headers[header.name] = header.example
  return headers
}

/** Turns one upstream outcome into a verdict, learning the shape when there is one. */
function judge(
  appSpec: AppSpec,
  endpoint: Endpoint,
  outcome: CallOutcome,
  connection: ConnectionSettings,
): EndpointTest {
  const base = { at: new Date().toISOString(), url: outcome.url, durationMs: outcome.durationMs }

  if (outcome.error) return { ...base, state: 'fail', message: `Could not reach the API: ${outcome.error}` }
  if (outcome.status >= 400) {
    return {
      ...base,
      state: 'fail',
      status: outcome.status,
      message: `Returned ${outcome.status}. ${hintFor(outcome.status, outcome.url, connection)}`,
    }
  }

  const failure = failureInBody(outcome.body)
  if (failure) {
    return { ...base, state: 'fail', status: outcome.status, message: `Returned ${outcome.status}, but ${failure}` }
  }

  const body = outcome.body
  if (body === null || typeof body !== 'object') {
    return { ...base, state: 'pass', status: outcome.status, message: `Returned ${outcome.status} with no JSON body` }
  }
  if (Array.isArray(body) ? body.length === 0 : Object.keys(body).length === 0) {
    return {
      ...base,
      state: 'pass',
      status: outcome.status,
      message: `Returned ${outcome.status}, but empty, so there was no shape to learn. Add data and test again.`,
    }
  }

  const { rootTypeName, entities } = applyObservedShape(appSpec, endpoint.operationId, body, outcome.status)
  const fields = entities.reduce((sum, e) => sum + e.fields.length, 0)
  return {
    ...base,
    state: 'pass',
    status: outcome.status,
    typeName: rootTypeName,
    fields,
    message: `Returned ${outcome.status}. Learned ${rootTypeName} (${fields} field${fields === 1 ? '' : 's'})`,
  }
}

/**
 * Tests one endpoint with what the person typed. Mutates `appSpec`: the result
 * lands on the endpoint, and a successful shape on its responses and entities.
 */
export async function testEndpoint(
  appSpec: AppSpec,
  endpoint: Endpoint,
  connection: ConnectionSettings,
  payload: CallPayload,
): Promise<EndpointTest> {
  let test: EndpointTest
  try {
    const outcome = await callUpstream(
      endpoint,
      connection,
      { ...payload, headers: { ...documentedHeaders(endpoint), ...(payload.headers ?? {}) } },
      30_000,
    )
    test = judge(appSpec, endpoint, outcome, connection)
  } catch (err) {
    test = {
      state: 'fail',
      at: new Date().toISOString(),
      message: err instanceof Error ? err.message : 'The request could not be built',
    }
  }
  endpoint.lastTest = test
  return test
}

const skipped = (message: string): EndpointTest => ({ state: 'skipped', message, at: new Date().toISOString() })

/**
 * Tests every endpoint it can, reads before writes, lists before details.
 *
 * A detail endpoint needs an id that only the list returns, so values from
 * each response are harvested and fed to the path parameters of the next.
 * Writes run last, with their documented example body, and only when asked.
 */
export async function testAllEndpoints(
  appSpec: AppSpec,
  connection: ConnectionSettings,
  options: { includeWrites: boolean },
  onResult: (endpoint: Endpoint, test: EndpointTest) => void = () => {},
): Promise<void> {
  const hasBase = (e: Endpoint) => Boolean(connection.baseUrlOverride?.trim() || e.baseUrl.trim())

  // The person's order when they set one: they know the journey — search,
  // then quote, then execute — better than any rule about verbs.
  const ordered =
    appSpec.callOrder === 'manual'
      ? [...appSpec.endpoints]
      : [...appSpec.endpoints].sort(
          (a, b) =>
            Number(isWrite(a)) - Number(isWrite(b)) || pathParamNames(a.path).length - pathParamNames(b.path).length,
        )

  const harvested = new Map<string, string>()

  for (const endpoint of ordered) {
    const record = (test: EndpointTest) => {
      endpoint.lastTest = test
      onResult(endpoint, test)
    }

    if (isWrite(endpoint) && !options.includeWrites) {
      record(skipped(`${endpoint.method} not called. Writes only run when you allow them, since they can create or change records.`))
      continue
    }
    if (!hasBase(endpoint)) {
      record(skipped('No base URL. Set one in Connection or edit this API.'))
      continue
    }
    // Calling a secured API without a credential only proves it is secured.
    if (endpoint.auth.type !== 'none' && !connection.authValue?.trim()) {
      record(skipped(`Needs a ${endpoint.auth.type} credential and none is saved. Paste your token in Connection, then test again.`))
      continue
    }

    // What the person typed when testing this one on its own beats any example.
    const typed = endpoint.lastTestInput
    const pathParams: Record<string, string> = {}
    const unfilled: string[] = []
    for (const name of pathParamNames(endpoint.path)) {
      const own = typed?.pathParams?.[name]
      const value = own !== undefined && own !== '' ? String(own) : valueFor(name, endpoint, harvested)
      if (value === undefined) unfilled.push(name)
      else pathParams[name] = value
    }
    if (unfilled.length > 0) {
      record(skipped(`No value for ${unfilled.join(', ')}. Test it on its own and type one in.`))
      continue
    }

    const missingQuery = endpoint.queryParams
      .filter((p) => p.required && !p.example && !p.enum?.length && typed?.query?.[p.name] === undefined)
      .map((p) => p.name)
    if (missingQuery.length > 0) {
      record(skipped(`Required query ${missingQuery.join(', ')} has no example value. Add one by editing this API.`))
      continue
    }
    const query: Record<string, unknown> = {}
    for (const p of endpoint.queryParams) {
      const value = p.example ?? p.enum?.[0]
      if (value !== undefined) query[p.name] = value
    }
    Object.assign(query, typed?.query ?? {})

    let body: unknown
    let fromDocs = false
    if (endpoint.requestBody && !['GET', 'HEAD'].includes(endpoint.method)) {
      if (typed?.body !== undefined) {
        body = typed.body
      } else {
        body = endpoint.requestBody.example
        fromDocs = body !== undefined
      }
      if (body === undefined) {
        record(skipped('No request body to send. Test it on its own with a body once; Test all reuses it after that.'))
        continue
      }
    }

    const test = await testEndpoint(appSpec, endpoint, connection, {
      pathParams,
      query,
      ...(body !== undefined ? { body } : {}),
    })
    // The likeliest cause of a failure on the documents' own example is the example.
    if (test.state === 'fail' && fromDocs && test.status !== undefined && test.status !== 401 && test.status !== 403) {
      test.message +=
        ' This used the example body from your documents, which often holds values your system does not have. Test this API on its own with real values; Test all reuses them after that.'
    }
    if (test.state === 'pass') {
      const response = endpoint.responses.find((r) => r.status === String(test.status))
      if (response?.example !== undefined) harvest(response.example, harvested)
    }
    onResult(endpoint, test)
  }
}
