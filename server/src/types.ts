/**
 * The domain model shared by every pipeline stage.
 *
 * `AppSpec` is the contract that makes the whole product trustworthy: the
 * analyze pass fills it in from the uploaded documents, the user may correct it,
 * and every downstream emitter reads endpoints from here rather than inventing
 * them. A mirror of these types lives in web/src/lib/types.ts.
 */

export type ProjectStatus =
  | 'draft'
  | 'parsing'
  | 'parsed'
  | 'analyzing'
  | 'analyzed'
  | 'planning'
  | 'generating'
  | 'ready'
  | 'failed'

export type SourceKind = 'openapi' | 'postman' | 'markdown' | 'pdf' | 'docx' | 'text' | 'json' | 'unknown'

/** An account. `passwordHash` never leaves the server. */
export interface User {
  id: string
  email: string
  name: string
  passwordHash: string
  createdAt: string
}

/** What the browser is told about the signed-in account. */
export interface PublicUser {
  id: string
  email: string
  name: string
  createdAt: string
}

/** A single uploaded document after parsing. */
export interface SpecDocument {
  id: string
  filename: string
  kind: SourceKind
  bytes: number
  /** Blob path of the original upload. */
  blobPath: string
  /** Normalised plain text handed to the model (or to the OpenAPI parser). */
  text: string
  /** Set when kind === 'openapi'; the dereferenced document. */
  openapi?: unknown
  /** Set when kind === 'postman'; the parsed collection. */
  postman?: unknown
  parseError?: string
  uploadedAt: string
}

export interface ParamSpec {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  type: string
  required: boolean
  description?: string
  example?: string
  enum?: string[]
}

export interface BodySpec {
  contentType: string
  /** JSON Schema-ish shape, as documented. */
  schema?: unknown
  example?: unknown
  description?: string
  /**
   * Named entity this shape refers to, resolved at extraction time. Object
   * identity from the dereferenced spec does not survive JSON storage, so the
   * name is captured here while it is still knowable.
   */
  typeName?: string
}

export interface ResponseSpec {
  status: string
  description?: string
  contentType?: string
  schema?: unknown
  example?: unknown
  /** Dotted field paths, when the document lists them rather than a body. */
  fields?: string[]
  /** Resolved TypeScript type for this response, e.g. `Order` or `Order[]`. */
  typeName?: string
}

export interface AuthSpec {
  type: 'none' | 'bearer' | 'apiKey' | 'basic' | 'oauth2' | 'custom'
  /** Header or query parameter carrying the credential, e.g. `Authorization`. */
  name?: string
  in?: 'header' | 'query' | 'cookie'
  scheme?: string
  description?: string
}

/**
 * An endpoint exactly as the documentation describes it. Nothing here is
 * inferred or prettified — `sourceQuote` is the excerpt it came from so a human
 * can audit any field in one glance.
 */
export interface Endpoint {
  id: string
  /** camelCase operation name used as the generated client function name. */
  operationId: string
  name: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
  /** Path template as documented, e.g. `/v1/users/{userId}`. */
  path: string
  /** Server/base URL as documented. Empty when the doc never states one. */
  baseUrl: string
  summary?: string
  description?: string
  tags: string[]
  auth: AuthSpec
  headers: ParamSpec[]
  pathParams: ParamSpec[]
  queryParams: ParamSpec[]
  requestBody?: BodySpec
  responses: ResponseSpec[]
  /** True when the verb was assumed because no document stated one. */
  methodAssumed?: boolean
  /** Verbatim excerpt from the source document. */
  sourceQuote?: string
  sourceDocumentId?: string
  /** True when a human edited this endpoint in the inspector. */
  edited?: boolean
}

export interface EntityField {
  name: string
  type: string
  required: boolean
  description?: string
}

export interface Entity {
  name: string
  description?: string
  fields: EntityField[]
}

export interface FlowStep {
  order: number
  actor?: string
  action: string
  screenHint?: string
  endpointIds: string[]
}

export interface Flow {
  id: string
  name: string
  description?: string
  steps: FlowStep[]
}

/** Something the docs left open. Surfaced to the user instead of invented. */
export interface Gap {
  severity: 'info' | 'warning'
  topic: string
  detail: string
  suggestion?: string
}

/** A field a document says a screen shows or collects. */
export interface DocumentedField {
  label: string
  type?: string
  required?: boolean
  readOnly?: boolean
  notes?: string
  /** Values listed for a dropdown. */
  options?: string[]
}

/** A button a document says a screen has, and what it does. */
export interface DocumentedAction {
  label: string
  does: string
  /** Resolved operationIds, filled in by the linking pass. */
  endpointIds: string[]
  /** e.g. "disabled until quotation succeeds". */
  enabledWhen?: string
  /**
   * Screen this button leads to, named as the document names it.
   *
   * Destinations used to live only on the screen, one between all its buttons,
   * so a screen offering Save / Next / Exit could express a single one and the
   * rest generated as dead controls. A button is the thing that navigates, so
   * the destination belongs on the button.
   */
  navigatesTo?: string
}

/**
 * A screen the documentation specifies directly.
 *
 * When a document says "UI 2 - Policy Search Result Screen" and lists its
 * fields and buttons, that is a specification, not a hint. These are reproduced
 * as written rather than redesigned.
 */
export interface DocumentedScreen {
  id: string
  name: string
  purpose: string
  order: number
  fields: DocumentedField[]
  actions: DocumentedAction[]
  navigatesTo?: string
  validation: string[]
  sourceDocumentId?: string
}

export interface AppSpec {
  appName: string
  description: string
  entities: Entity[]
  endpoints: Endpoint[]
  flows: Flow[]
  gaps: Gap[]
  /** Screens the documents specify outright; empty when they only describe flows. */
  documentedScreens: DocumentedScreen[]
  /** Base URLs mentioned anywhere in the docs, most common first. */
  servers: string[]
}

export type ScreenType =
  | 'dashboard'
  | 'list'
  | 'detail'
  | 'form'
  | 'wizard'
  | 'auth'
  | 'settings'
  | 'search'
  | 'empty'

export interface ScreenSection {
  title: string
  kind: 'table' | 'form' | 'cards' | 'stats' | 'detail' | 'timeline' | 'chart' | 'text'
  description: string
  endpointIds: string[]
}

export interface ScreenPlan {
  id: string
  name: string
  /** React Router path, e.g. `/users/:userId`. */
  route: string
  type: ScreenType
  purpose: string
  icon: string
  sections: ScreenSection[]
  endpointIds: string[]
  showInNav: boolean
  notes?: string
  /**
   * Type this screen receives through router state, when it has no endpoints of
   * its own and displays what a previous screen fetched.
   */
  incomingType?: string
  /** Name of the screen that supplies `incomingType`. */
  incomingFrom?: string
  /**
   * Type of the values the user types on THIS screen, when a later screen has to
   * show them back.
   *
   * A registration form asks for thirteen things and the API returns four, so
   * the nine that never reach the server exist only in the browser. Carrying
   * them forward is the only way the next screen can display what the
   * documentation says it displays.
   */
  formType?: string
  /** Form values arriving through router state, from an earlier screen. */
  incomingFormType?: string
  /**
   * Set when no endpoint and no upstream screen can feed this one, so it renders
   * sample data behind a visible notice rather than an empty shell.
   */
  /**
   * Set when the app keeps its own data in the browser, because the documents
   * describe a data model and no API. The screen reads and writes the store
   * rather than calling anything — and rather than rendering sample values it
   * cannot change.
   */
  local?: boolean
  demo?: { constName: string; typeName: string }
  /**
   * Set instead of `demo`/`local` when the project is API-only: nothing can
   * feed this screen, and invented values are not allowed, so it says so.
   */
  unsourced?: boolean
  /**
   * Where this screen sits in the journey, when the plan reads as a sequence
   * rather than a set of destinations.
   *
   * Assigned after planning rather than asked of the model: the order is
   * already decided by then, and a model asked to number its own screens
   * numbers them inconsistently with the array it just returned.
   */
  step?: { index: number; total: number }
  /**
   * Copy for the tinted band that opens the screen.
   *
   * Orientation, not data — nothing below it reads from it, and it is the one
   * place a generated app is allowed prose of its own, because a heading that
   * says what this step is for cannot be mistaken for a record.
   */
  hero?: { eyebrow?: string; headline: string; sub?: string }
  /** Heading for the running summary panel beside this screen. */
  aside?: { title: string; headline?: string }
  /**
   * The documented screens this one covers, named as the documents name them.
   *
   * A requirements document describes interfaces at whatever granularity its
   * author found natural, and "Date-wise Updates section" is a table on the
   * project page, not a page. Reproducing each heading as a route produced
   * screens nothing could link to — the parameter in `/projects/:projectId/updates`
   * has no value in a navigation bar — and then a chain of repairs that made a
   * dead link look like a fixed one.
   *
   * So the planner decides how many screens there are, and says which parts of
   * the documentation each one is answering for. The fields and buttons still
   * come from the document; only the mapping is a judgement.
   *
   * Empty means the screen's own name is the documented screen it covers, which
   * is the common case.
   */
  covers?: string[]
}

export interface AppPlan {
  screens: ScreenPlan[]
  navigation: { screenId: string; label: string; icon: string }[]
  theme: {
    accent: string
    mood: 'calm' | 'vivid' | 'corporate' | 'playful'
    density: 'comfortable' | 'compact'
  }
  designNotes: string[]
  /** The project's `sampleData` setting this plan was made under. */
  sampleData?: boolean
}

/** A file in the generated app. */
export interface GeneratedFile {
  path: string
  content: string
  /** `emitted` files are produced by code, `model` files are written by the AI. */
  origin: 'emitted' | 'model'
  screenId?: string
}

export interface ConnectionSettings {
  /** Overrides every endpoint's documented baseUrl when set. */
  baseUrlOverride?: string
  authValue?: string
  extraHeaders: Record<string, string>
}

export interface PublishInfo {
  url: string
  publishedAt: string
  transport: 'direct'
}

export interface Project {
  id: string
  /** Account that created it. Only its owner may read or change it. */
  ownerId: string
  name: string
  status: ProjectStatus
  createdAt: string
  updatedAt: string
  documents: SpecDocument[]
  appSpec?: AppSpec
  plan?: AppPlan
  files: GeneratedFile[]
  connection: ConnectionSettings
  /**
   * Whether a screen no API can feed may fall back to sample data, or — when
   * the documents describe no API at all — keep its own data in the browser.
   * Off (or absent) means API-only: such a screen shows that no API supplies it.
   */
  sampleData?: boolean
  /**
   * When the person pressed Save.
   *
   * Absent means never saved. Uploading and generating write to storage as
   * they go — they have to, the run is long and losing it would be worse — but
   * that is not the same as the person deciding this one is worth keeping, and
   * only the ones they kept belong in their list.
   */
  savedAt?: string
  publish?: PublishInfo
  error?: string
  /** True when generated without a live Azure OpenAI key. */
  mock?: boolean
}

/** Summary row stored in Table Storage for fast listing. */
export interface ProjectSummary {
  id: string
  ownerId: string
  name: string
  status: ProjectStatus
  createdAt: string
  updatedAt: string
  documentCount: number
  endpointCount: number
  screenCount: number
  savedAt?: string
  published?: string
}

/** Server-sent event payload used by the analyze/generate streams. */
export type PipelineEvent =
  | { type: 'status'; status: ProjectStatus; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'endpoint'; endpoint: Endpoint }
  | { type: 'appspec'; appSpec: AppSpec }
  | { type: 'plan'; plan: AppPlan }
  | { type: 'file'; file: GeneratedFile }
  | { type: 'screen-start'; screenId: string; name: string }
  | { type: 'screen-done'; screenId: string; path: string }
  | { type: 'done'; project: unknown }
  | { type: 'error'; message: string }
