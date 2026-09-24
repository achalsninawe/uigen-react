import { z } from 'zod'
import { aiAvailable, chatJson } from '../azure.js'
import { analysisSchema, documentedScreenSchema, linkSchema, type Analysis } from '../../schemas.js'
import {
  ANALYZE_SYSTEM,
  MERGE_SYSTEM,
  SCREENS_SYSTEM,
  analyzeChunkUser,
  analyzeUser,
  screensUser,
} from '../../prompts/analyze.js'
import { LINK_SYSTEM, applyLinks, linkUser } from '../../prompts/link.js'
import { deriveOperationId, extractFromOpenApi, uniqueOperationId } from '../parsers/openapi.js'
import { extractFromPostman } from '../parsers/postman.js'
import { toPascalCase } from '../emit/lang.js'
import { inferTypes } from '../infer.js'
import { reconcileEndpoints } from './reconcile.js'
import { compareScreenCounts } from './screenCount.js'
import { config } from '../../config.js'
import { cleanEndpoints } from './clean.js'
import type { AppSpec, DocumentedScreen, Endpoint, Entity, Flow, Gap, SpecDocument } from '../../types.js'

/** Roughly 25k tokens of input per analysis call, leaving room for the reply. */
const CHARS_PER_CHUNK = 90_000

export interface AnalyzeHooks {
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void
  onEndpoint?: (endpoint: Endpoint) => void
}

/** Splits a long document on paragraph boundaries so sentences stay intact. */
function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const paragraphs = text.split(/\n{2,}/)
  const chunks: string[] = []
  let current = ''
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > limit) {
      chunks.push(current)
      current = ''
    }
    // A single paragraph longer than the limit gets hard-split as a last resort.
    if (paragraph.length > limit) {
      if (current) {
        chunks.push(current)
        current = ''
      }
      for (let i = 0; i < paragraph.length; i += limit) chunks.push(paragraph.slice(i, i + limit))
      continue
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph
  }
  if (current) chunks.push(current)
  return chunks
}

type PromptDoc = { filename: string; kind: string; text: string }

/**
 * One batch per document, splitting only documents too large for a single call.
 *
 * Packing several documents into one call loses endpoints: asked to read four
 * API references at once, the model reliably summarised three of them and
 * dropped an operation from the fourth. One document per call costs more
 * requests and finds everything, which is the right trade for the field the
 * whole product depends on.
 */
function chunkDocuments(documents: SpecDocument[]): PromptDoc[][] {
  const batches: PromptDoc[][] = []

  for (const doc of documents) {
    const parts = splitText(doc.text, CHARS_PER_CHUNK)
    for (const [i, text] of parts.entries()) {
      batches.push([
        {
          filename: parts.length > 1 ? `${doc.filename} (part ${i + 1}/${parts.length})` : doc.filename,
          kind: doc.kind,
          text,
        },
      ])
    }
  }

  return batches
}

const endpointKey = (method: string, path: string) => `${method.toUpperCase()} ${path.trim()}`

/**
 * A base URL is an address or it is nothing.
 *
 * Pressed for one when the document gives none, models answer with a fragment
 * of the instruction instead — a bare `"url:"` reached the server list, was
 * joined to four paths, and produced requests to `url:/claim/acceptance/v2/...`.
 * Anything that is not an absolute http(s) address is discarded so the normal
 * "no base URL documented" handling applies.
 */
const absoluteUrl = (value: string): string =>
  /^https?:\/\/[^/\s]+/i.test(value.trim()) ? value.trim() : ''

/**
 * The base URL to assume for a path the document gave no host for.
 *
 * Taking the first server found meant taking the shortest — a platform root
 * like `https://host/api/platform/1.0` — while the documents also named
 * `.../1.0/v1/flow` as where the calls actually go. Every recovered path then
 * lost two segments and 404ed. The most specific server is the better
 * assumption, except where the path already carries those segments itself, in
 * which case using it would repeat them.
 */
function chooseBaseUrl(path: string, servers: string[]): string {
  const ordered = [...new Set(servers.map(absoluteUrl).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  )
  const segments = path.split('/').filter(Boolean).map((s) => s.toLowerCase())

  for (const server of ordered) {
    const tail = server
      .replace(/^https?:\/\/[^/]+/i, '')
      .split('/')
      .filter(Boolean)
      .map((s) => s.toLowerCase())

    /*
     * The overlap is between the END of the server and the START of the path:
     * base ".../1.0/v1/flow" joined to "/v1/flow/Thing" gives ".../v1/flow/v1/
     * flow/Thing". Compare every suffix of the server against the path's
     * opening segments, not the server's leading segments, which never match.
     */
    const repeats = [...Array(tail.length).keys()].some((i) => {
      const suffix = tail.slice(i)
      return suffix.length <= segments.length && suffix.every((seg, j) => segments[j] === seg)
    })
    if (!repeats) return server
  }

  return ordered[0] ?? ''
}

/**
 * Converts a model-authored endpoint into the domain shape. Note that ids are
 * assigned here, not by the model — the model has no business naming things the
 * generated code will import.
 */
function toEndpoint(raw: Analysis['endpoints'][number], taken: Set<string>, fallbackBaseUrl: string): Endpoint {
  const operationId = uniqueOperationId(deriveOperationId(raw.method, raw.path), taken)
  return {
    id: operationId,
    operationId,
    name: raw.name,
    method: raw.method,
    path: raw.path,
    baseUrl: absoluteUrl(raw.baseUrl) || fallbackBaseUrl,
    ...(raw.summary ? { summary: raw.summary } : {}),
    ...(raw.description ? { description: raw.description } : {}),
    tags: raw.tags,
    auth: raw.auth,
    headers: raw.headers,
    pathParams: raw.pathParams,
    queryParams: raw.queryParams,
    ...(raw.requestBody ? { requestBody: raw.requestBody } : {}),
    responses: raw.responses,
    ...(raw.methodAssumed ? { methodAssumed: true } : {}),
    ...(raw.sourceQuote ? { sourceQuote: raw.sourceQuote } : {}),
  }
}

/**
 * Works out where each button goes, from what the document says it does.
 *
 * Asked for a button's destination as its own field the model returns nothing,
 * yet writes the answer in the very next sentence: "Moves the user to Policy /
 * Product Detail", "Returns user to Basic Case Info". Those name real screens,
 * so matching them is reading the document rather than guessing at it.
 *
 * Three passes, most certain first: a screen named outright in the button's
 * description, then the screen's own stated destination, then — only for a
 * button that calls nothing and clearly says it moves forward — the next screen
 * in the documented order, which is what "Next" means. Everything resolved is
 * logged, because a wrong destination is worth seeing.
 */
function resolveButtonDestinations(
  screens: DocumentedScreen[],
  log: (message: string, level?: 'info' | 'warn' | 'error') => void,
): void {
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  // Longest first, so "Policy / Product Detail" wins over a shorter screen name
  // that happens to be contained in it.
  const named = [...screens].sort((a, b) => b.name.length - a.name.length)
  const ordered = [...screens].sort((a, b) => a.order - b.order)

  let resolved = 0

  for (const screen of screens) {
    for (const action of screen.actions) {
      if (action.navigatesTo) continue

      const text = normalise(`${action.does} ${action.label}`)
      const mentioned = named.find(
        (other) => other.name !== screen.name && text.includes(normalise(other.name)),
      )

      let destination = mentioned?.name ?? screen.navigatesTo

      if (!destination && action.endpointIds.length === 0 && /\b(move|moves|proceed|continue|go|takes|next)\b/.test(text)) {
        const index = ordered.findIndex((s) => s.name === screen.name)
        const next = index >= 0 ? ordered[index + 1] : undefined
        // "Back" and "Return" move the other way; never read them as forward.
        if (next && !/\b(back|return|returns|previous|exit|cancel)\b/.test(text)) destination = next.name
      }

      if (!destination || destination === screen.name) continue
      action.navigatesTo = destination
      resolved++
      log(`${screen.name}: the "${action.label}" button goes to "${destination}"`)
    }
  }

  if (resolved > 0) log(`Resolved ${resolved} button destination(s) from the documented behaviour`)
}

/**
 * Renames entities to valid TypeScript identifiers and rewrites every reference.
 *
 * Documents name their data in prose — "Policy Information", "Refund Summary" —
 * and those names flow straight into `export interface ...`, which then does not
 * parse. Normalising here rather than at emit time keeps one spelling in the
 * AppSpec, so the emitters, the prompts and the inspector all agree.
 */
function normaliseEntityNames(appSpec: {
  entities: Entity[]
  endpoints: Endpoint[]
}): { renamed: number } {
  const taken = new Set<string>()
  const rename = new Map<string, string>()

  for (const entity of appSpec.entities) {
    const safe = uniqueOperationId(toPascalCase(entity.name, 'Model'), taken)
    if (safe !== entity.name) rename.set(entity.name, safe)
    entity.name = safe
  }

  if (rename.size === 0) return { renamed: 0 }

  /** Rewrites a type expression, preserving `[]`, unions and intersections. */
  const rewrite = (type: string | undefined): string | undefined => {
    if (!type) return type
    return type.replace(/[A-Za-z_$][\w $]*/g, (token) => {
      const trimmed = token.trim()
      const replacement = rename.get(trimmed)
      return replacement ? token.replace(trimmed, replacement) : token
    })
  }

  for (const entity of appSpec.entities) {
    for (const field of entity.fields) field.type = rewrite(field.type) ?? field.type
  }

  for (const endpoint of appSpec.endpoints) {
    if (endpoint.requestBody?.typeName) {
      endpoint.requestBody.typeName = rewrite(endpoint.requestBody.typeName)
    }
    for (const response of endpoint.responses) {
      if (response.typeName) response.typeName = rewrite(response.typeName)
    }
  }

  return { renamed: rename.size }
}

/**
 * Builds proper nested types from the example payloads the documents show.
 *
 * Reference docs describe a body as a flat table of dotted paths —
 * `freelookInput.freelookReason` — and a type with dotted keys produces a flat
 * request the API rejects with "policyNumber is required". The same documents
 * almost always include a real example alongside, which states the nesting
 * exactly. That example is the better source, so it is used when one exists.
 */
function deriveTypesFromExamples(
  endpoints: Endpoint[],
  entities: Entity[],
  log: (message: string, level?: 'info' | 'warn' | 'error') => void,
): Entity[] {
  const derived: Entity[] = []
  const reserved = new Set(entities.map((e) => e.name))
  let count = 0

  for (const endpoint of endpoints) {
    const base = toPascalCase(endpoint.operationId, 'Operation')

    if (endpoint.requestBody && !endpoint.requestBody.typeName) {
      const sample = endpoint.requestBody.example ?? exampleFromJsonSchema(endpoint.requestBody.schema)
      if (sample && typeof sample === 'object') {
        const { rootTypeName, entities: inferred } = inferTypes(sample, `${base}Request`, reserved)
        endpoint.requestBody.typeName = rootTypeName
        derived.push(...inferred)
        count++
      }
    }

    for (const response of endpoint.responses) {
      if (response.typeName || !/^2\d\d$/.test(response.status)) continue

      /*
       * A response the document describes by naming its fields.
       *
       * Plenty of specifications never show a body and instead list what to read
       * from it — "policyBasicInfo.policyNumber", "coverages[0].productName".
       * Those paths ARE the shape, but nothing used to read them, so the
       * endpoint ended up with no response type at all: the screen meant to
       * display it had nothing to receive and fell back to sample data behind a
       * notice, which is how a documented screen comes out invented.
       */
      const sample =
        response.example ??
        exampleFromJsonSchema(response.schema) ??
        (response.fields?.length ? shapeFromPaths(response.fields) : undefined)

      if (sample && typeof sample === 'object') {
        const { rootTypeName, entities: inferred } = inferTypes(sample, `${base}Response`, reserved, {
          allOptional: true,
        })
        response.typeName = rootTypeName
        derived.push(...inferred)
        count++
      }
    }
  }

  if (count > 0) log(`Derived ${count} request/response type(s) from documented examples`)
  return derived
}

/**
 * Builds an object from a list of dotted field paths.
 *
 * `policyBasicInfo.policyNumber` and `coverages[0].productName` describe a
 * payload as precisely as an example body does, and reconstructing one lets the
 * existing type inference do the rest. Every leaf is a string, because a path
 * says where a value lives and not what it is — and a string is the one type
 * every value can be rendered as.
 */
function shapeFromPaths(paths: string[]): Record<string, unknown> | undefined {
  const root: Record<string, unknown> = {}
  let used = 0

  for (const raw of paths) {
    // Tolerates "data.items[0].name", "data[].name" and plain "name".
    const steps = raw
      .trim()
      .replace(/\[\s*\d*\s*\]/g, '[]')
      .split('.')
      .map((s) => s.trim())
      .filter(Boolean)
    if (steps.length === 0) continue

    let node: Record<string, unknown> = root
    steps.forEach((step, index) => {
      const isArray = step.endsWith('[]')
      const key = isArray ? step.slice(0, -2) : step
      if (!key) return

      if (index === steps.length - 1) {
        if (node[key] === undefined) node[key] = isArray ? [''] : ''
        return
      }

      if (isArray) {
        const existing = Array.isArray(node[key]) ? (node[key] as unknown[]) : undefined
        const item = (existing?.[0] as Record<string, unknown>) ?? {}
        node[key] = [item]
        node = item
      } else {
        const existing = node[key]
        const child =
          existing && typeof existing === 'object' && !Array.isArray(existing)
            ? (existing as Record<string, unknown>)
            : {}
        node[key] = child
        node = child
      }
    })
    used++
  }

  return used > 0 ? root : undefined
}

/**
 * Turns a JSON Schema into a representative value, so one inference path serves
 * both documented schemas and documented examples.
 */
function exampleFromJsonSchema(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 8) return undefined
  const node = schema as Record<string, any>

  if (node.example !== undefined) return node.example
  if (node.enum?.length) return node.enum[0]

  switch (node.type) {
    case 'object': {
      const properties = node.properties as Record<string, unknown> | undefined
      if (!properties) return undefined
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(properties)) {
        const child = exampleFromJsonSchema(value, depth + 1)
        out[key] = child === undefined ? null : child
      }
      return out
    }
    case 'array': {
      const item = exampleFromJsonSchema(node.items, depth + 1)
      return item === undefined ? [] : [item]
    }
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'string':
      return node.format === 'date-time' || node.format === 'date' ? '1970-01-01T00:00:00' : ''
    default:
      return undefined
  }
}

/**
 * Removes gaps that the finished analysis answers.
 *
 * Documents are read one at a time, so a flow document saying "the SEARCH button
 * calls the Policy Search API" honestly reports "no path given" — it has none.
 * By the end, a sibling document has supplied the path and the linking pass has
 * connected the two. Leaving the original complaint standing tells the reader
 * something is missing when it is not, which is worse than saying nothing.
 *
 * A gap is only dropped where the evidence is concrete: the very thing it says
 * is absent is present in the finished spec.
 */
export function pruneResolvedGaps(appSpec: {
  gaps: Gap[]
  endpoints: Endpoint[]
  documentedScreens: DocumentedScreen[]
  flows: Flow[]
  servers: string[]
}): number {
  if (appSpec.endpoints.length === 0) return 0

  const everyEndpointHasBaseUrl = appSpec.endpoints.every((e) => e.baseUrl)
  const everyEndpointHasPath = appSpec.endpoints.every((e) => e.path.trim().length > 1)
  const authIsKnown = appSpec.endpoints.some((e) => e.auth.type !== 'none')
  const responsesAreTyped = appSpec.endpoints.some((e) => e.responses.some((r) => r.typeName))

  // Prose the linking pass resolved: "Calls Free Look Quotation API" -> linked.
  const resolvedPhrases = [
    ...appSpec.documentedScreens.flatMap((s) =>
      s.actions.filter((a) => a.endpointIds.length > 0).map((a) => `${a.label} ${a.does}`),
    ),
    ...appSpec.flows.flatMap((f) => f.steps.filter((s) => s.endpointIds.length > 0).map((s) => s.action)),
  ]
    .join(' ')
    .toLowerCase()

  const before = appSpec.gaps.length

  appSpec.gaps = appSpec.gaps.filter((gap) => {
    const text = `${gap.topic} ${gap.detail}`.toLowerCase()

    if (everyEndpointHasBaseUrl && /base ?url|host|server|domain/.test(text)) return false
    if (everyEndpointHasPath && /\bpath|\bendpoint|\bmethod|\broute/.test(text) && !/response/.test(text)) {
      return false
    }
    if (authIsKnown && /auth|token|credential|bearer/.test(text)) return false
    if (responsesAreTyped && /response (structure|shape|format|schema)/.test(text)) return false

    // "Policy Search" is answered when a linked button's text mentions it.
    const topic = gap.topic.toLowerCase().replace(/\s+api$/, '').trim()
    if (topic.length > 4 && resolvedPhrases.includes(topic)) return false

    return true
  })

  return before - appSpec.gaps.length
}

function mergeEntities(groups: Entity[][]): Entity[] {
  const byName = new Map<string, Entity>()
  for (const group of groups) {
    for (const entity of group) {
      const existing = byName.get(entity.name)
      if (!existing) {
        byName.set(entity.name, { ...entity, fields: [...entity.fields] })
        continue
      }
      const seen = new Set(existing.fields.map((f) => f.name))
      for (const field of entity.fields) if (!seen.has(field.name)) existing.fields.push(field)
      existing.description ??= entity.description
    }
  }
  return [...byName.values()]
}

/** Merges chunk analyses locally. Cheaper and more predictable than a merge call. */
function mergeAnalyses(parts: Analysis[]): Analysis {
  const merged: Analysis = {
    appName: parts.find((p) => p.appName && p.appName !== 'Generated App')?.appName ?? 'Generated App',
    description: parts.find((p) => p.description)?.description ?? '',
    servers: [...new Set(parts.flatMap((p) => p.servers).filter(Boolean))],
    entities: mergeEntities(parts.map((p) => p.entities)),
    endpoints: [],
    flows: parts.flatMap((p) => p.flows),
    screens: [],
    gaps: [],
  }

  const byKey = new Map<string, Analysis['endpoints'][number]>()
  for (const part of parts) {
    for (const endpoint of part.endpoints) {
      const key = endpointKey(endpoint.method, endpoint.path)
      const existing = byKey.get(key)
      // Keep whichever description is richer rather than first-wins.
      if (!existing || JSON.stringify(endpoint).length > JSON.stringify(existing).length) {
        byKey.set(key, endpoint)
      }
    }
  }
  merged.endpoints = [...byKey.values()]

  const screensByName = new Map<string, Analysis['screens'][number]>()
  for (const part of parts) {
    for (const screen of part.screens) {
      const key = screen.name.toLowerCase().trim()
      const existing = screensByName.get(key)
      // Prefer whichever definition carries more detail.
      if (!existing || screen.fields.length + screen.actions.length > existing.fields.length + existing.actions.length) {
        screensByName.set(key, screen)
      }
    }
  }
  merged.screens = [...screensByName.values()].sort((a, b) => a.order - b.order)

  const gapSeen = new Set<string>()
  for (const part of parts) {
    for (const gap of part.gaps) {
      const key = `${gap.topic}::${gap.detail}`
      if (!gapSeen.has(key)) {
        gapSeen.add(key)
        merged.gaps.push(gap)
      }
    }
  }

  return merged
}

function toFlows(raw: Analysis['flows'], endpoints: Endpoint[]): Flow[] {
  const byKey = new Map(endpoints.map((e) => [endpointKey(e.method, e.path), e.id]))
  const byOperationId = new Map(endpoints.map((e) => [e.operationId, e.id]))

  /** A step may cite either an operationId or a "METHOD /path" pair. */
  const resolveRef = (ref: string): string | undefined => {
    const trimmed = ref.trim()
    const direct = byOperationId.get(trimmed)
    if (direct) return direct

    const match = trimmed.match(/^([A-Za-z]+)\s+(\S+)/)
    if (match) {
      const viaPath = byKey.get(endpointKey(match[1]!, match[2]!))
      if (viaPath) return viaPath
    }
    // Tolerate a trailing "()" on an operationId reference.
    return byOperationId.get(trimmed.replace(/\(\)$/, ''))
  }

  return raw.map((flow, i) => ({
    id: `flow-${i + 1}`,
    name: flow.name,
    ...(flow.description ? { description: flow.description } : {}),
    steps: flow.steps.map((step, j) => ({
      order: step.order || j + 1,
      ...(step.actor ? { actor: step.actor } : {}),
      action: step.action,
      ...(step.screenHint ? { screenHint: step.screenHint } : {}),
      endpointIds: step.endpointRefs
        .map(resolveRef)
        .filter((id): id is string => Boolean(id)),
    })),
  }))
}

const slugify = (value: string, fallback: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback

function toDocumentedScreens(raw: Analysis['screens']): DocumentedScreen[] {
  const used = new Set<string>()
  return raw.map((screen, i) => {
    let id = slugify(screen.name, `screen-${i + 1}`)
    while (used.has(id)) id = `${id}-${i + 1}`
    used.add(id)

    return {
      id,
      name: screen.name,
      purpose: screen.purpose,
      order: screen.order || i + 1,
      fields: screen.fields.map((f) => ({
        label: f.label,
        ...(f.type ? { type: f.type } : {}),
        required: f.required,
        readOnly: f.readOnly,
        ...(f.notes ? { notes: f.notes } : {}),
        ...(f.options.length ? { options: f.options } : {}),
      })),
      actions: screen.actions.map((a) => ({
        label: a.label,
        does: a.does || a.calls || '',
        // Prose like "Free Look Quotation API"; the linking pass resolves it.
        endpointIds: [],
        ...(a.enabledWhen ? { enabledWhen: a.enabledWhen } : {}),
        // Only what this button itself states. The screen-level destination is
        // applied later, and only to a button that has nowhere else to go —
        // inheriting it here would make Save and Exit navigate as well.
        ...(a.navigatesTo ? { navigatesTo: a.navigatesTo } : {}),
      })),
      ...(screen.navigatesTo ? { navigatesTo: screen.navigatesTo } : {}),
      validation: screen.validation,
    }
  })
}

export async function analyze(documents: SpecDocument[], hooks: AnalyzeHooks = {}): Promise<AppSpec> {
  const log = hooks.log ?? (() => {})

  const openApiDocs = documents.filter((d) => d.kind === 'openapi' && d.openapi)
  const postmanDocs = documents.filter((d) => d.kind === 'postman' && d.postman)
  const structuralIds = new Set([...openApiDocs, ...postmanDocs].map((d) => d.id))
  const proseDocs = documents.filter((d) => !structuralIds.has(d.id) && d.text.trim())

  const takenIds = new Set<string>()
  const endpoints: Endpoint[] = []
  const entityGroups: Entity[][] = []
  const gaps: Gap[] = []
  const servers: string[] = []
  let appName = ''
  let description = ''

  /* ---- machine-readable specs: read structurally, no model involved ---- */
  for (const doc of openApiDocs) {
    log(`Reading ${doc.filename} as OpenAPI`)
    const extracted = extractFromOpenApi(doc.openapi, doc.id)

    appName ||= extracted.title
    description ||= extracted.description
    servers.push(...extracted.servers)
    entityGroups.push(extracted.entities)

    for (const endpoint of extracted.endpoints) {
      const operationId = uniqueOperationId(endpoint.operationId, takenIds)
      const resolved: Endpoint = { ...endpoint, id: operationId, operationId }
      endpoints.push(resolved)
      hooks.onEndpoint?.(resolved)
    }
    log(`${doc.filename}: ${extracted.endpoints.length} endpoints, ${extracted.entities.length} schemas`)

    if (extracted.servers.length === 0) {
      gaps.push({
        severity: 'warning',
        topic: 'Base URL',
        detail: `${doc.filename} declares no servers, so no base URL is known for its endpoints.`,
        suggestion: 'Set a base URL in Connection settings before running the generated app.',
      })
    }
  }

  /*
   * Postman collections, read the same way.
   *
   * A collection is machine-readable — real URLs, real headers, real bodies and
   * often real saved responses — so none of it goes near the model. Handing one
   * to the prose pass instead produced addresses reassembled from
   * `{ host: [...], path: [...] }`, which is guesswork dressed as extraction.
   */
  for (const doc of postmanDocs) {
    log(`Reading ${doc.filename} as a Postman collection`)
    const extracted = extractFromPostman(doc.postman, doc.id)

    appName ||= extracted.title
    description ||= extracted.description
    servers.push(...extracted.servers)
    entityGroups.push(extracted.entities)

    for (const endpoint of extracted.endpoints) {
      const operationId = uniqueOperationId(endpoint.operationId, takenIds)
      const resolved: Endpoint = { ...endpoint, id: operationId, operationId }
      endpoints.push(resolved)
      hooks.onEndpoint?.(resolved)
    }

    const withResponses = extracted.endpoints.filter((e) => e.responses.length > 0).length
    log(
      `${doc.filename}: ${extracted.endpoints.length} request(s)` +
        `, ${withResponses} with a saved response` +
        `, ${extracted.entities.length} shape(s) derived`,
    )

    if (withResponses === 0 && extracted.endpoints.length > 0) {
      gaps.push({
        severity: 'info',
        topic: 'No saved responses',
        detail:
          `${doc.filename} records requests but no example responses, so the shape of what each ` +
          'call returns is unknown and screens cannot render its fields.',
        suggestion: 'Send the requests in Postman and save a response on each, then re-upload.',
      })
    }

    const unresolved = extracted.endpoints.filter((e) => /\{\{|\}\}/.test(e.baseUrl + e.path))
    if (unresolved.length > 0) {
      gaps.push({
        severity: 'warning',
        topic: 'Unresolved collection variables',
        detail:
          `${unresolved.length} request(s) still contain {{variables}} the collection never defines, ` +
          'so their addresses are incomplete.',
        suggestion: 'Export the collection with its environment, or set the values as collection variables.',
      })
    }
  }

  /* ---- prose: the model reads it, constrained by the analyze prompt ---- */
  let proseAnalysis: Analysis | null = null

  if (proseDocs.length > 0) {
    if (!aiAvailable()) {
      log('Azure OpenAI is not configured — skipping prose analysis', 'warn')
      gaps.push({
        severity: 'warning',
        topic: 'Analysis skipped',
        detail: `${proseDocs.length} document(s) were not analysed because no Azure OpenAI key is configured.`,
        suggestion: 'Set AZURE_OPENAI_API_KEY and re-run the analysis.',
      })
    } else {
      const batches = chunkDocuments(proseDocs)
      log(
        batches.length > 1
          ? `Reading ${proseDocs.length} document(s) one at a time`
          : `Reading ${proseDocs[0]?.filename ?? 'document'}`,
      )

      // Hand the structurally-extracted endpoints to the prose pass so it can
      // link flow steps to them and stop reporting gaps they already answer.
      const knownEndpoints = endpoints.map((e) => ({
        operationId: e.operationId,
        method: e.method,
        path: e.path,
        ...(e.summary ? { summary: e.summary } : {}),
      }))

      const results: Analysis[] = []
      for (const [index, batch] of batches.entries()) {
        if (batches.length > 1) log(`  ${batch[0]?.filename ?? `part ${index + 1}`}`)
        const result = await chatJson({
          system: ANALYZE_SYSTEM,
          user:
            batches.length > 1
              ? analyzeChunkUser(batch, index, batches.length, knownEndpoints, servers)
              : analyzeUser(batch, knownEndpoints, servers),
          schema: analysisSchema,
          temperature: 0.1,
        })
        results.push(result)
      }

      proseAnalysis = results.length === 1 ? results[0]! : mergeAnalyses(results)

      appName ||= proseAnalysis.appName
      description ||= proseAnalysis.description
      servers.push(...proseAnalysis.servers.map(absoluteUrl).filter(Boolean))
      entityGroups.push(
        proseAnalysis.entities.map((e) => ({
          name: e.name,
          ...(e.description ? { description: e.description } : {}),
          fields: e.fields,
        })),
      )
      gaps.push(...proseAnalysis.gaps)

      // OpenAPI wins on conflict: a structured spec beats a prose reading of it.
      const known = new Set(endpoints.map((e) => endpointKey(e.method, e.path)))
      // Chosen per endpoint: the right prefix depends on what the path already carries.
      let added = 0
      let skipped = 0
      for (const raw of proseAnalysis.endpoints) {
        /*
         * A document that says "the SEARCH button calls the Policy Search API"
         * names a real dependency but never gives its path. That is a gap, not
         * an endpoint: keeping it would generate a call to the bare base URL
         * under a name like `get`, which fails at runtime and hides the fact
         * that something is genuinely missing from the documentation.
         */
        if (!raw.path.trim() || raw.path.trim() === '/') {
          gaps.push({
            severity: 'warning',
            topic: raw.name || `${raw.method} (path not documented)`,
            detail: `The documentation mentions this call but never states its path, so it cannot be generated.${
              raw.sourceQuote ? ` It says: "${raw.sourceQuote.trim().slice(0, 160)}"` : ''
            }`,
            suggestion: 'Add the path to your documentation, or add it in Connection settings and re-analyse.',
          })
          continue
        }

        if (known.has(endpointKey(raw.method, raw.path))) {
          skipped++
          continue
        }
        /*
         * Deliberately not added to `known`.
         *
         * `known` exists so a machine-readable spec wins over prose describing
         * the same call. Letting prose endpoints join it makes the FIRST
         * document to mention a path suppress every later one — so a
         * requirements document saying "on Save, call /v2/submit" beat the API
         * reference that defined that call completely, and the operation kept
         * its guessed verb, its missing prefix and no types at all. Reconcile
         * compares full URLs and keeps whichever is better described, which is
         * the decision this line was making badly.
         */
        const endpoint = toEndpoint(raw, takenIds, chooseBaseUrl(raw.path, servers))
        endpoints.push(endpoint)
        hooks.onEndpoint?.(endpoint)
        added++
      }
      log(
        `Prose analysis: ${added} new endpoint(s)` +
          (skipped ? `, ${skipped} already covered by the OpenAPI spec` : ''),
      )
    }
  }

  /*
   * Honour a verb the documents state once for a whole group.
   *
   * "All requests are POST to https://host/api/1.0/v1/flow/" settles the method
   * for every operation under that prefix, but a requirements document
   * describing one of them as "call API: /…/copyPolicies and fetch below fields"
   * reads as a lookup, so the model returns GET. The live API answers that with
   * 422 — the address is right and the verb is not, which is the kind of failure
   * nobody sees until a button does nothing. The sentence is in the document
   * verbatim, so applying it is reading, not guessing.
   */
  const declaredMethods = [
    ...proseDocs
      .map((d) => d.text)
      .join('\n')
      .matchAll(/all\s+(?:the\s+)?requests?\s+(?:are|use|go)\s+`?(GET|POST|PUT|PATCH|DELETE)`?\s+to\s+`?(https?:\/\/[^\s`,)]+)/gi),
  ].map((m) => ({ method: m[1]!.toUpperCase(), prefix: m[2]!.replace(/\/+$/, '') }))

  for (const declared of declaredMethods) {
    for (const endpoint of endpoints) {
      const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/${endpoint.path.replace(/^\/+/, '')}`
      if (!url.startsWith(`${declared.prefix}/`)) continue
      if (endpoint.method === declared.method) continue
      log(
        `${endpoint.method} ${endpoint.path} → ${declared.method}: the documentation states ` +
          `every request under ${declared.prefix} uses ${declared.method}`,
      )
      endpoint.method = declared.method as Endpoint['method']
    }
  }

  /*
   * Documents were read independently, so the same call can appear several
   * times split differently. Reconcile before anything downstream sees them.
   */
  const reconciled = reconcileEndpoints(endpoints, servers)
  if (reconciled.merged > 0) {
    log(`Merged ${reconciled.merged} duplicate endpoint(s) described in more than one document`)
  }
  // Name each collapse. A reference the documents describe two ways is exactly
  // the kind of thing worth seeing resolved, rather than resolved silently.
  for (const pair of reconciled.absorbed) {
    log(`${pair.dropped} is ${pair.kept} referred to in passing — kept the documented one`)
  }
  for (const pair of reconciled.ambiguous) {
    gaps.push({
      severity: 'warning',
      topic: 'Possible duplicate endpoint',
      detail:
        `"${pair.dropped}" looks like the same operation as "${pair.kept}" with its prefix dropped, ` +
        'but neither document describes it more fully, so both were kept.',
      suggestion: 'Confirm which is correct and correct the documentation.',
    })
  }
  endpoints.length = 0
  endpoints.push(...reconciled.endpoints)

  const uniqueServers = reconciled.servers

  // Endpoints with no base URL anywhere are unrunnable — say so once, clearly.
  const missingBase = endpoints.filter((e) => !e.baseUrl)
  if (missingBase.length > 0 && uniqueServers.length > 0) {
    for (const endpoint of missingBase) endpoint.baseUrl = chooseBaseUrl(endpoint.path, uniqueServers)
  } else if (missingBase.length > 0) {
    gaps.push({
      severity: 'warning',
      topic: 'Base URL',
      detail: `${missingBase.length} endpoint(s) have no base URL in the documentation.`,
      suggestion: 'Set a base URL in Connection settings so the generated app can reach the API.',
    })
  }

  if (endpoints.length === 0) {
    gaps.push({
      severity: 'warning',
      topic: 'No endpoints found',
      detail: 'The documents did not describe any HTTP operations, so the generated UI will have no live data.',
      suggestion: 'Add an OpenAPI spec or API reference describing the endpoints.',
    })
  }

  /*
   * Captures from a browser carry the whole request, transport headers and all.
   * Strip those before types are derived, so a JSON body recorded as a string
   * becomes an object rather than a string type.
   */
  // An assumed verb is a real risk — the address can be right and the call still
  // rejected — so it is named rather than left to look documented.
  const assumed = endpoints.filter((e) => e.methodAssumed)
  if (assumed.length > 0) {
    log(
      `${assumed.length} endpoint(s) had no HTTP method in the documentation; assumed ` +
        assumed.map((e) => `${e.method} ${e.path}`).join(', '),
      'warn',
    )
    gaps.push({
      severity: 'warning',
      topic: 'HTTP method not documented',
      detail:
        `${assumed.length} call(s) are named without a verb: ` +
        `${assumed.map((e) => e.path).join(', ')}. A verb was assumed from whether a body is shown.`,
      suggestion: 'State the method in your documentation so the generated client cannot be wrong.',
    })
  }

  const cleaned = cleanEndpoints(endpoints)
  if (cleaned.removedHeaders > 0) {
    log(`Dropped ${cleaned.removedHeaders} browser/transport header(s) that are not API parameters`)
  }
  if (cleaned.parsedBodies > 0) {
    log(`Parsed ${cleaned.parsedBodies} request body example(s) that were captured as text`)
  }

  const entities = mergeEntities(entityGroups)
  entities.push(...deriveTypesFromExamples(endpoints, entities, log))
  const { renamed } = normaliseEntityNames({ entities, endpoints })
  if (renamed > 0) log(`Renamed ${renamed} data shape(s) to valid type names`)

  let flows = proseAnalysis ? toFlows(proseAnalysis.flows, endpoints) : []
  const documentedScreens = proseAnalysis ? toDocumentedScreens(proseAnalysis.screens) : []
  if (documentedScreens.length > 0) {
    log(`Your documents define ${documentedScreens.length} screen(s): ${documentedScreens.map((s) => s.name).join(', ')}`)
  }

  /*
   * Check that against the headings actually present. Extraction returning one
   * screen from a document that names five is invisible otherwise — the plan
   * simply looks like a small app.
   */
  let { expected, missing } = compareScreenCounts(
    proseDocs.map((d) => d.text).join('\n'),
    documentedScreens.map((s) => s.name),
  )

  /*
   * A detector that only reports is worth little when the omission is the whole
   * point of the document. Ask again, for screens alone, naming the ones known
   * to be absent — the first pass is juggling endpoints, entities, flows and
   * gaps in the same reply, and it is screens it drops when it drops anything.
   */
  if (missing.length > 0 && aiAvailable() && !config.analysis.recoverMissingScreens) {
    log(
      `${missing.length} screen heading(s) did not match the extraction. Not re-reading — ` +
        'set RECOVER_MISSING_SCREENS=1 in .env to have a second pass look for them.',
    )
  }

  if (missing.length > 0 && aiAvailable() && config.analysis.recoverMissingScreens) {
    log(`Re-reading for ${missing.length} screen(s) the first pass missed`, 'warn')
    const relevant = proseDocs.filter((doc) => missing.some((m) => doc.text.includes(m.raw)))
    const target = (relevant.length > 0 ? relevant : proseDocs).map((doc) => ({
      filename: doc.filename,
      kind: doc.kind,
      text: doc.text,
    }))

    try {
      const recovered = await chatJson({
        system: SCREENS_SYSTEM,
        user: screensUser(target, missing.map((m) => m.title)),
        schema: z.object({ screens: z.array(documentedScreenSchema).default([]) }),
        temperature: 0.1,
      })

      const seen = new Set(documentedScreens.map((s) => s.name.toLowerCase().trim()))
      const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      const wanted = missing.map((m) => normalise(m.title))

      /*
       * Only the screens the counter named. Pointed at an API reference, this
       * pass happily returns its sections as screens — "Save Case Info",
       * "Reject", "Reset" — and those become routes in the generated app. The
       * recovery exists to close a known gap, not to open a new one.
       */
      const added = toDocumentedScreens(recovered.screens).filter((screen) => {
        if (seen.has(screen.name.toLowerCase().trim())) return false
        const name = normalise(screen.name)
        return wanted.some((title) => name.includes(title) || title.includes(name))
      })

      if (added.length > 0) {
        documentedScreens.push(...added)
        documentedScreens.sort((a, b) => a.order - b.order)
        // Both passes slug ids independently, so collisions are possible.
        const usedIds = new Set<string>()
        for (const [index, screen] of documentedScreens.entries()) {
          let id = slugify(screen.name, `screen-${index + 1}`)
          while (usedIds.has(id)) id = `${id}-${index + 1}`
          usedIds.add(id)
          screen.id = id
        }
        log(`Recovered ${added.length} screen(s): ${added.map((s) => s.name).join(', ')}`)
      }
    } catch (err) {
      log(`Screen recovery failed: ${err instanceof Error ? err.message : 'unknown error'}`, 'warn')
    }

    ;({ expected, missing } = compareScreenCounts(
      proseDocs.map((d) => d.text).join('\n'),
      documentedScreens.map((s) => s.name),
    ))
  }

  resolveButtonDestinations(documentedScreens, log)

  if (missing.length > 0) {
    log(
      `${missing.length} screen heading(s) in your documents were not extracted: ` +
        missing.map((m) => m.title).join(', '),
      'warn',
    )
    gaps.push({
      severity: 'warning',
      topic: 'Screens not extracted',
      detail:
        `Your documents name ${expected.length} screens but only ${documentedScreens.length} were captured. ` +
        `Missing: ${missing.map((m) => m.title).join(', ')}.`,
      suggestion: 'Re-run the analysis, or give those sections clearer headings and field lists.',
    })
  }

  /*
   * Documents are read one at a time, which finds every endpoint but leaves each
   * document blind to its siblings. A flow saying "calls the Free Look Quotation
   * API" cannot know that operation is defined in another file under a different
   * name, so the connection is made here, once everything is known.
   */
  const unlinkedSteps = flows.reduce((n, f) => n + f.steps.filter((s) => s.endpointIds.length === 0).length, 0)

  /*
   * Screen buttons need linking just as much as flow steps do — and a document
   * that defines screens without a numbered journey has no steps at all, so
   * keying this on steps alone meant every button stayed unlinked and every
   * screen was generated with nothing to call.
   */
  const unlinkedActions = documentedScreens.reduce(
    (n, screen) => n + screen.actions.filter((a) => a.endpointIds.length === 0).length,
    0,
  )

  if (aiAvailable() && endpoints.length > 0 && unlinkedSteps + unlinkedActions > 0) {
    const draft: AppSpec = {
      appName: appName || 'Generated App',
      description,
      entities,
      endpoints,
      flows,
      documentedScreens,
      gaps,
      servers: uniqueServers,
    }

    try {
      log('Matching flow steps to the endpoints they call')
      const result = await chatJson({
        system: LINK_SYSTEM,
        user: linkUser(draft),
        schema: linkSchema,
        temperature: 0.1,
      })

      const validIds = new Set(endpoints.map((e) => e.operationId))
      const applied = applyLinks(flows, documentedScreens, result, validIds)

      if (applied.linked > 0) {
        log(`Linked ${applied.linked} flow step(s) and screen button(s) to endpoints`)
      } else {
        log('No flow step or button could be matched to an endpoint', 'warn')
      }
    } catch (err) {
      // Linking is an enhancement; losing it should not fail the analysis.
      log(`Could not match flow steps to endpoints: ${(err as Error).message}`, 'warn')
    }
  }

  const pruned = pruneResolvedGaps({
    gaps,
    endpoints,
    documentedScreens,
    flows,
    servers: uniqueServers,
  })
  if (pruned > 0) {
    log(`Cleared ${pruned} gap(s) that other documents answered`)
  }

  return {
    appName: appName || 'Generated App',
    description,
    entities,
    endpoints,
    flows,
    documentedScreens,
    gaps,
    servers: uniqueServers,
  }
}
