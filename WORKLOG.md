# Spec2UI — Work Log

## 16 September 2026

Built Spec2UI from nothing to a working pipeline: upload specification documents,
extract the API exactly as documented, generate a React app wired to it, preview
it against the live API.

---

### Foundation

| # | Task | Outcome |
|---|---|---|
| 1 | Repository scaffold | npm workspaces — `server/` (Express 5 + TypeScript), `web/` (React 19 + Vite + Tailwind v4) |
| 2 | Design system | Light, minimal: periwinkle `#6C63FF`, sky `#4EA8F5`, lilac `#B39DFF` on `#FAFAFF`, Plus Jakarta Sans |
| 3 | Azure Storage | Blob containers + Table index, with a local filesystem fallback when no connection string is set |
| 4 | Dependency audit | Pinned `tar`, regenerated the lockfile — `npm audit` reports 0 vulnerabilities |

### Ingest and analysis

| # | Task | Outcome |
|---|---|---|
| 5 | Document parsers | Markdown, text, JSON/YAML, PDF, DOCX |
| 6 | OpenAPI extraction | Fully structural — no model involved. Servers, auth schemes, parameters, schemas, `$ref` resolution |
| 7 | Azure OpenAI client | JSON mode, zod validation, self-repair on invalid output, backoff on rate limits |
| 8 | Analysis pipeline | Endpoints, entities, flows, gaps — each traceable to a verbatim source quote |
| 9 | Response-shape learning | One real API call infers the full nested type tree. 12 entities derived from a live response |

### Generation

| # | Task | Outcome |
|---|---|---|
| 10 | Deterministic emitters | `api.ts`, `types.ts`, UI kit and app shell are written by **code**, never by the model |
| 11 | Component kit | Button, Card, Field, Input, Select, DataTable, Dialog, Toast, EmptyState, ErrorState and more |
| 12 | Screen generation | The model writes only `src/screens/*.tsx`, composing from the emitted client and kit |
| 13 | Documented screens | When a document specifies screens with fields and buttons, those are reproduced as written |
| 14 | Cross-document linking | "Calls the Free Look Quotation API" in one file resolved to `postFreelookRefundQuotation` in another |
| 15 | Demo mode | No endpoint documented → sample data behind a mandatory, visible notice |

### Preview and testing

| # | Task | Outcome |
|---|---|---|
| 16 | Sandpack preview | The generated app runs in the browser, with a code view |
| 17 | Proxy | Calls reach the real API server-side — no CORS, credentials never enter the page |
| 18 | Bridge transport | Preview relays calls through the studio window, since browsers block a public origin from reaching localhost |
| 19 | Connection panel | Base URL override and credential, applied by the proxy |
| 20 | Network log | Every call with its real URL, status and timing |

### Quality gates

Three automatic checks, none specific to any document:

| Gate | Stage | Catches |
|---|---|---|
| **Flow validation** | before codegen | orphan screens, broken data chains, unwired buttons, duplicate routes |
| **Static checks** | per screen | invented data, hard-coded URLs, unimported components, bad props, hook-order violations, discarded responses |
| **Compile gate** | whole project | everything TypeScript can see — run in a warm `tsc` sandbox, with up to two repair rounds |

---

## Defects found and fixed

Most were found by testing against real documents rather than by reasoning.

### Correctness of the extracted API

| Defect | Cause | Fix |
|---|---|---|
| `404` — base URL missing `/flow` | Model shortened the documented prefix | Explicit split rule: keep every prefix segment |
| `401` — token rejected | `type: "bearer"` with no scheme, so the credential was sent raw | Scheme inferred: bearer → `Bearer`, basic → `Basic` |
| `Authorization` sent as a query parameter | Model omitted `in`, which defaulted to `query` | Location taken from the array the parameter arrived in |
| An endpoint silently disappeared | Four documents analysed in one call; one operation was dropped | One document per call, then merged |
| Same operation extracted 2–3 times | Each document split the URL differently | Reconciled on the full URL; dropped-prefix duplicates collapsed |
| 16 browser headers treated as API parameters | Captured from devtools (`sec-ch-ua`, `user-agent`, `referer`…) | Transport headers stripped |
| Request body typed `string` | Captured as escaped JSON text | Stringified bodies parsed before types are derived |
| `500 NumberFormatException: For input string: ""` | Blank form input posted into a numeric field | Client coerces declared numeric fields, through nesting and arrays |

### Correctness of the generated UI

| Defect | Cause | Fix |
|---|---|---|
| Screens were static mockups | Planner returned empty endpoint lists | Schema accepts every spelling; endpoints applied from documented buttons; warning if still empty |
| `StatusBadge is not defined` | Component used without importing it | Scope check added |
| `<Button icon=…>` failed to compile | Prop did not exist | `icon` implemented; prop registry generated from the same source as the prompt |
| "Objects are not valid as a React child" | `action={{ label, onClick }}` passed where a node was expected | Kit accepts both forms |
| Screens showed "John Doe", `$1,200.00` | Model invented data to fill a layout | Invented-data check; screens must source data or show an empty state |
| Policy data rendered as a JSON blob | Only one level of types reached the model | Full transitive type tree |
| "No policy selected" dead end | Third screen was never told it receives the first screen's result | Data carried through the whole chain; both sides given the same contract |
| Missing NEXT button | Navigation-only buttons never reached codegen | Whole screen specification passed through |
| Execute produced no visible result | Response awaited and discarded | Responses must be rendered |
| "Rendered more hooks than during the previous render" | `useCallback` after an early return | Hook-order check, tracking brace depth |
| Only 1 of 5 documented screens extracted | Prompt recognised one heading style | Format-agnostic extraction, plus a deterministic heading count |
| Stale gaps reported as open | Gaps recorded per document, never revisited | Gaps the finished analysis answers are cleared |

### Infrastructure and tooling

| Defect | Cause | Fix |
|---|---|---|
| Server died silently under `npm run dev` | `tsx watch` needs a TTY; `concurrently` pipes stdio | Switched to Node's own watcher |
| Vite silently moved to port 5174 | Port already in use | `strictPort` — fails loudly instead |
| `JSON.stringify` crash on cyclic schemas | Dereferencing produces cyclic graphs | Cycle-safe copies; `openapi` never persisted |
| Analysis aborted: "Expected string, received object" | Model returned validation rules as objects | Every model-supplied string list is tolerant of shape |
| Linking failed: "messages must contain the word 'json'" | Azure requirement not met by the prompt | Guaranteed in `chatJson`, so every JSON call is safe |
| `Invalid regular expression` crash | Operation id interpolated into a regex | Scanning without building a regex from input |
| Invalid `types.ts` | Entity names contained spaces | Names normalised once, before planning and emitting |
| A REST resource lost every read | `absorbGhosts` folded a same-URL pair across verbs whenever the thinner one had nothing recorded — and a read never has a request body, so `GET /projects` was absorbed into `POST /projects`. The app kept only its writes, and the planner had nothing to attach a list screen to | A cross-verb fold now requires `methodAssumed`: the one case where the pipeline guessed the verb itself. `npm run verify:reconcile -w server` |
| `api.ts` did not parse — "Compile errors in generated infrastructure" | Extraction copies a type as the document words it, and the emitters wrote it into a type position unchanged. A path parameter documented `UUID/String` emitted `projectId: UUID/String`; a response the analysis typed "Project List Response" emitted `Promise<Project List Response>`. Either misparses, and takes every function after it in the file with it | `toTsType` now passes through only what can stand where TypeScript expects a type; anything else reads as the primitive its words name, or falls back — `string` for a parameter, which is spelled into a URL, `unknown` elsewhere. Names are also resolved against the declared entities first, so a type naming nothing is `unknown` rather than a dangling reference. `npm run verify:emit-parses -w server`, and `npm run diagnose:api -w server -- <projectId>` to read it off a real project |
| `Interface_` one run, `InterfaceModel` the next | `toPascalCase` inherited the trailing underscore `toIdentifier` adds to a reserved word, then added its own `Model` suffix only if the result was still reserved | The identifier suffix is dropped before the type suffix is considered, so re-deriving a name returns the same name |
| Screens told to import `HTMLInputElement` from the component kit | The undefined-component scan matched `<Name>` anywhere, so `useRef<HTMLInputElement>(null)` and `ChangeEvent<HTMLInputElement>` read as JSX tags. A repair round was spent rewriting a screen around a problem it never had | The scan now ignores a `<` that follows an identifier or a dot, which a type argument always does and a tag never does. `npm run verify:screen-checks -w server` |
| A project generated before a transport existed exported a config naming it | `reemitForTarget` replaced the config but not `src/lib/http.ts`, which implements the transport — the client fell through to calling the documented host directly, silently | `http.ts` re-emitted on every target switch, and a legacy project is one of the export checks |

---

## Verified end to end

Against a live InsureMO API:

```
1055864001 → SEARCH → real policy data → NEXT → Free Look form
Policy Number   1055864001
Product Code    MRKT_TL_WAIVER
Inception Date  16/09/2026
no empty state · no runtime errors · project compiles
```

Against a public API (jsonplaceholder), through the proxy:

```
listPosts         200  /posts?userId=1&_limit=3      3 rows
getPost           200  /posts/2
createPost        201  /posts                        echoed back
listPostComments  200  /posts/1/comments             5 comments
unknown operation 404  rejected
```

---

## The emitted BFF

A build that leaves the studio has no proxy to relay through, and calling a
documented host from the page fails twice over: the API has no reason to allow
that origin, and the credential would have to ship inside page JavaScript to be
sent at all. Direct fetch only ever works against a CORS-permissive public API —
not against the kind verified above.

So `transport: 'bff'` emits the app its own server beside it:

| File | What it is |
|---|---|
| `server/index.js` | Serves `dist/` and answers `POST /api/call/:operationId` |
| `server/upstream.js` | A port of `services/upstream.ts`, so preview and production build the same request |
| `server/endpoints.json` | The closed list of calls it will forward |
| `.env.example` | `API_AUTH_VALUE`, `API_BASE_URL`, `API_EXTRA_HEADERS`, `PORT` |

The guarantee is unchanged: every one of those files is emitted from the same
`appSpec.endpoints` that produces `src/lib/api.ts`. No route accepts a URL, so
the server can only reach hosts the documents named. Aggregation was left out
deliberately — a screen-shaped composite route is where judgment would creep
back onto the server.

The credential never enters the browser. `authHeaders()` in the emitted client
returns nothing under this transport, and the server applies the documented
scheme from its own environment.

`npm run verify:bff -w server` proves it rather than asserting it: it emits a
build, boots `server/index.js`, and runs 16 checks — real calls to
jsonplaceholder, and a local echo upstream that reads back what was actually
sent.

```
operations=6 credentialConfigured=true
listPosts         200  /posts?userId=1&_limit=3      3 rows
getPost           200  /posts/2
createPost        201  /posts
listPostComments  200  /posts/1/comments
getPost           404  upstream 404, inside a 200 envelope
deleteEverything  404  absent from the spec, refused
noBaseUrl         400  no documented host, refused rather than guessed
echoAuthed        200  upstream saw  authorization: Bearer <token>
                       and           x-tenant: acme
                       host rewritten, content-length dropped
switching target  ok   server/ removed for direct, restored for bff

all 16 checks passed
```

A static-only host cannot serve a BFF build. Deploy it as one unit on anything
that runs Node — container, App Service, Container Apps.

---

## Taking it away

`GET /api/projects/:id/export?transport=bff|direct` streams the app as a ZIP.
Storage holds the files as the preview needed them, so the export re-emits the
target-dependent ones on the way out — `reemitForTarget` — and screens are
never regenerated. `bff` is the default; `direct` is offered for a static host
and only reaches an API that publishes CORS headers.

In the studio it is a panel under the running app: two choices described by what
they can reach, not by their shape.

`npm run verify:export -w server` asks the real route over HTTP with a real
session, unzips what comes back, and boots what it finds:

```
unanalysed project      400  told to analyse first
ungenerated project     400  told to generate first
transport=nonsense      400  rejected
no session              401
someone else's project  404  not found, not forbidden
bff export              200  export-check/ · 24 files, server/ + .env.example
                             config.ts re-emitted to "bff", not left on "bridge"
downloaded server       ok   boots, operations=2, credentialConfigured=true
                             listPosts → 200, 2 rows from the real API
direct export           200  20 files, no server/, no express, "direct"
storage                 ok   still holds the preview build, untouched

all 15 checks passed
```

It runs against a throwaway local store — `scripts/local-env.ts` forces it, so a
verification never writes into the real Azure account.

---

## Known gaps

| Gap | Note |
|---|---|
| HAR captures | Read as generic JSON. Postman collections have a structural reader; a browser HAR does not |
| Fixture suite | No automated test across document shapes, so a change that helps one document set can silently break another |
| Smoke test in the pipeline | The browser walk-through is run by hand, not automatically |
| Publish | The ZIP export is built and verified. Azure publish is not: static website hosting cannot run a BFF build, so publishing one needs a host decision first |
| Editable endpoint inspector | Extraction cannot yet be corrected in the UI |

---

## Notes

- `.env` is read only at startup — restart after changing it.
- The type-check sandbox at `.work/typecheck/` installs once, then each check takes a few seconds.
- Storage account `dynamicuistorage` holds every project; static website hosting is currently disabled.
- The Azure Storage key and the OpenAI key were both shared in plain text during this session and are worth rotating.
