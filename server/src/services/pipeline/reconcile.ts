import type { Endpoint } from '../../types.js'

/**
 * Reconciles endpoints gathered from documents read independently.
 *
 * Each document is analysed on its own, which finds every operation but lets
 * each one split a URL where it likes. The same call then appears two or three
 * times — base ".../1.0" with path "/flow/Thing" alongside base ".../1.0/flow"
 * with path "/Thing" — and a dedup key of METHOD + path sees three operations
 * where there is one.
 *
 * Comparing the full URL instead collapses them, and re-splitting every
 * endpoint against one canonical server list means the generated client is
 * consistent regardless of which document a call came from.
 */

const trimTrailing = (url: string) => url.replace(/\/+$/, '')

/** Full address of an endpoint, however its base and path were divided. */
export function fullUrl(endpoint: { baseUrl: string; path: string }): string {
  const base = trimTrailing(endpoint.baseUrl.trim())
  const path = endpoint.path.trim()
  if (!base) return path
  return `${base}/${path.replace(/^\/+/, '')}`
}

/** Distinct servers, with trailing slashes removed so they compare equal. */
export function canonicalServers(servers: string[]): string[] {
  return [...new Set(servers.map((s) => trimTrailing(s.trim())).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  )
}

export interface ReconcileResult {
  endpoints: Endpoint[]
  servers: string[]
  merged: number
  /** Thin duplicates folded into the fuller description of the same call. */
  absorbed: { kept: string; dropped: string }[]
  /** Pairs that look like one operation but nothing says which is right. */
  ambiguous: { kept: string; dropped: string }[]
}

export function reconcileEndpoints(endpoints: Endpoint[], servers: string[]): ReconcileResult {
  const canonical = canonicalServers([...servers, ...endpoints.map((e) => e.baseUrl)])

  /** Re-splits a URL at the longest server prefix that matches it. */
  const split = (url: string): { baseUrl: string; path: string } => {
    for (const server of canonical) {
      if (url === server) return { baseUrl: server, path: '/' }
      if (url.startsWith(`${server}/`)) return { baseUrl: server, path: url.slice(server.length) }
    }
    return { baseUrl: '', path: url }
  }

  const byAddress = new Map<string, Endpoint>()
  let merged = 0

  for (const endpoint of endpoints) {
    const url = fullUrl(endpoint)
    const { baseUrl, path } = split(url)
    const address = `${endpoint.method} ${url}`

    const existing = byAddress.get(address)
    if (!existing) {
      byAddress.set(address, { ...endpoint, baseUrl, path })
      continue
    }

    merged++
    // Keep whichever description carries more, field by field, so nothing
    // documented in one file is lost because another file was terser.
    byAddress.set(address, {
      ...existing,
      summary: existing.summary || endpoint.summary,
      description: existing.description || endpoint.description,
      auth: existing.auth.type !== 'none' ? existing.auth : endpoint.auth,
      headers: existing.headers.length >= endpoint.headers.length ? existing.headers : endpoint.headers,
      pathParams:
        existing.pathParams.length >= endpoint.pathParams.length ? existing.pathParams : endpoint.pathParams,
      queryParams:
        existing.queryParams.length >= endpoint.queryParams.length
          ? existing.queryParams
          : endpoint.queryParams,
      requestBody: existing.requestBody ?? endpoint.requestBody,
      responses: existing.responses.length >= endpoint.responses.length ? existing.responses : endpoint.responses,
      sourceQuote: existing.sourceQuote || endpoint.sourceQuote,
    })
  }

  const collapsed = absorbGhosts([...byAddress.values()])

  return {
    endpoints: collapsed.endpoints,
    servers: canonical,
    merged: merged + collapsed.absorbed.length,
    absorbed: collapsed.absorbed,
    ambiguous: collapsed.ambiguous,
  }
}

/**
 * How completely an endpoint is described.
 *
 * This is what separates an operation from its ghost: the document that defines
 * a call states its payload and its result, the one that merely refers to it
 * states neither.
 */
function richness(endpoint: Endpoint): number {
  return (
    (endpoint.requestBody ? 2 : 0) +
    endpoint.responses.length +
    (endpoint.auth.type !== 'none' ? 1 : 0) +
    endpoint.headers.length +
    endpoint.queryParams.length
  )
}

/**
 * Absorbs an endpoint that is the same operation described more thinly.
 *
 * A requirements document says "call API: /claim/acceptance/v2/load" and stops
 * there — no host, no verb, no payload. An API reference describes that same
 * call completely. Read independently, the two become two endpoints: the real
 * one, and a ghost carrying a guessed method, a truncated base URL and no types.
 *
 * The ghost is not harmless clutter. The planner wires screens to it by name and
 * reports the real one as unreachable; the emitter gives it the signature
 * `(options?: RequestOptions): Promise<unknown>`; and the screen that needed to
 * send a case number then has nowhere to put it, so the project fails to
 * compile. Collapsing the pair is what makes the documented call reachable.
 *
 * A ghost is absorbed only when a strictly better-described endpoint's full URL
 * ends with the ghost's entire path. Two operations that merely share a last
 * segment — `/v1/claims/submit` and `/v2/appeals/submit` — never merge, because
 * neither path is a whole suffix of the other's URL.
 *
 * When two candidates are described equally well the pair is reported instead:
 * choosing between them would produce a call that fails in a way nobody can see.
 */
function absorbGhosts(endpoints: Endpoint[]): {
  endpoints: Endpoint[]
  absorbed: { kept: string; dropped: string }[]
  ambiguous: { kept: string; dropped: string }[]
} {
  const absorbed: { kept: string; dropped: string }[] = []
  const ambiguous: { kept: string; dropped: string }[] = []
  const removed = new Set<Endpoint>()

  /** True when `url` ends with the whole of `path`, on a segment boundary. */
  const endsWithPath = (url: string, path: string): boolean => {
    const suffix = (path.startsWith('/') ? path : `/${path}`).toLowerCase()
    if (suffix === '/') return false
    const lower = url.toLowerCase()
    return lower.endsWith(suffix) && lower.length > suffix.length
  }

  const describe = (endpoint: Endpoint) => `${endpoint.method} ${fullUrl(endpoint)}`

  for (const ghost of endpoints) {
    if (removed.has(ghost)) continue

    const candidates = endpoints.filter((other) => {
      if (other === ghost || removed.has(other)) return false
      if (!endsWithPath(fullUrl(other), ghost.path)) return false

      /*
       * A different verb on the same resource is a different operation.
       *
       * `GET /projects` and `POST /projects` are a list and a create; `GET`,
       * `PUT` and `DELETE` on `/projects/{id}` are three more. Folding one into
       * another deletes an operation the documents describe, and it is the
       * reads that go — they carry no request body, so they always look thinner
       * than the write beside them. An app left with only writes cannot show
       * anything, and the planner then has nothing to attach a list screen to.
       *
       * The single exception is a ghost whose verb nobody stated: `schemas.ts`
       * fills one in so the record is usable, and marks it `methodAssumed`
       * precisely because it is a guess rather than evidence.
       */
      if (other.method !== ghost.method && !ghost.methodAssumed) return false

      if (fullUrl(other).length > fullUrl(ghost).length) return true

      // Identical address: only a bare mention, with nothing recorded against
      // it at all, may be folded into the documented operation.
      return fullUrl(other) === fullUrl(ghost) && richness(ghost) === 0
    })
    if (candidates.length === 0) continue

    const best = candidates.reduce((a, b) => (richness(b) > richness(a) ? b : a))
    if (richness(best) <= richness(ghost)) {
      ambiguous.push({ kept: describe(best), dropped: describe(ghost) })
      continue
    }

    // Keep the fuller description, but take anything only the ghost carried.
    best.summary ||= ghost.summary
    best.description ||= ghost.description
    if (!best.requestBody && ghost.requestBody) best.requestBody = ghost.requestBody
    if (best.responses.length < ghost.responses.length) best.responses = ghost.responses
    if (best.auth.type === 'none' && ghost.auth.type !== 'none') best.auth = ghost.auth

    absorbed.push({ kept: describe(best), dropped: describe(ghost) })
    removed.add(ghost)
  }

  return { endpoints: endpoints.filter((e) => !removed.has(e)), absorbed, ambiguous }
}
