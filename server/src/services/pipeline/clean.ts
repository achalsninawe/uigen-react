import type { Endpoint } from '../../types.js'

/**
 * Removes transport noise from endpoints captured out of a browser.
 *
 * API documentation increasingly arrives as a devtools capture or a Postman
 * export, which records every header the browser happened to send. Those are
 * not parameters of the API — they describe one client on one day — and
 * emitting them into a generated client sends `sec-ch-ua` and a stale
 * `user-agent` with every request while burying the two headers that matter.
 */

/** Headers the browser or the transport adds, never part of an API contract. */
const TRANSPORT_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'content-length',
  'cookie',
  'dnt',
  'host',
  'origin',
  'pragma',
  'priority',
  'referer',
  'te',
  'upgrade-insecure-requests',
  'user-agent',
  'via',
  'postman-token',
])

const isTransportHeader = (name: string) => {
  const lower = name.toLowerCase().trim()
  return TRANSPORT_HEADERS.has(lower) || lower.startsWith('sec-') || lower.startsWith(':')
}

/** A string that is really a JSON document, as devtools exports bodies. */
function parseIfJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!/^[[{]/.test(trimmed)) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

export interface CleanResult {
  removedHeaders: number
  parsedBodies: number
}

export function cleanEndpoints(endpoints: Endpoint[]): CleanResult {
  let removedHeaders = 0
  let parsedBodies = 0

  for (const endpoint of endpoints) {
    const before = endpoint.headers.length

    endpoint.headers = endpoint.headers.filter((header) => {
      if (isTransportHeader(header.name)) return false

      // The credential is described by `auth`; listing it again as a parameter
      // makes the generated signature ask the caller for it twice.
      const name = header.name.toLowerCase().trim()
      if (endpoint.auth.type !== 'none' && name === (endpoint.auth.name ?? 'authorization').toLowerCase()) {
        return false
      }

      // Content-Type is set from the body's declared content type.
      if (name === 'content-type' && endpoint.requestBody) return false

      return true
    })

    removedHeaders += before - endpoint.headers.length

    if (endpoint.requestBody) {
      const parsed = parseIfJsonString(endpoint.requestBody.example)
      if (parsed !== endpoint.requestBody.example) {
        endpoint.requestBody.example = parsed
        parsedBodies++
      }
    }

    for (const response of endpoint.responses) {
      response.example = parseIfJsonString(response.example)
    }
  }

  return { removedHeaders, parsedBodies }
}
