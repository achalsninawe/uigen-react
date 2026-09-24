/**
 * Mirror of the server's domain model (server/src/types.ts).
 *
 * Kept as a copy rather than a shared package so the two builds stay
 * independent — if you change a shape on the server, change it here too.
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

export type SourceKind = 'openapi' | 'markdown' | 'pdf' | 'docx' | 'text' | 'json' | 'unknown'

export interface WireDocument {
  id: string
  filename: string
  kind: SourceKind
  bytes: number
  blobPath: string
  textLength: number
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
  schema?: unknown
  example?: unknown
  description?: string
  typeName?: string
}

export interface ResponseSpec {
  status: string
  description?: string
  contentType?: string
  schema?: unknown
  example?: unknown
  typeName?: string
}

export interface AuthSpec {
  type: 'none' | 'bearer' | 'apiKey' | 'basic' | 'oauth2' | 'custom'
  name?: string
  in?: 'header' | 'query' | 'cookie'
  scheme?: string
  description?: string
}

export interface Endpoint {
  id: string
  operationId: string
  name: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
  path: string
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
  sourceQuote?: string
  sourceDocumentId?: string
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

export interface Gap {
  severity: 'info' | 'warning'
  topic: string
  detail: string
  suggestion?: string
}

export interface AppSpec {
  appName: string
  description: string
  entities: Entity[]
  endpoints: Endpoint[]
  flows: Flow[]
  gaps: Gap[]
  servers: string[]
}

export type ScreenType =
  | 'dashboard' | 'list' | 'detail' | 'form' | 'wizard' | 'auth' | 'settings' | 'search' | 'empty'

export interface ScreenSection {
  title: string
  kind: 'table' | 'form' | 'cards' | 'stats' | 'detail' | 'timeline' | 'chart' | 'text'
  description: string
  endpointIds: string[]
}

export interface ScreenPlan {
  id: string
  name: string
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
   * Set when no endpoint and no upstream screen can feed this one, so it renders
   * sample data behind a visible notice rather than an empty shell.
   */
  demo?: { constName: string; typeName: string }
  /** Position in the journey, when the plan reads as a sequence. */
  step?: { index: number; total: number }
  /** Copy for the tinted band that opens the screen. */
  hero?: { eyebrow?: string; headline: string; sub?: string }
  /** Heading for the running summary panel beside the screen. */
  aside?: { title: string; headline?: string }
}

export interface AppPlan {
  screens: ScreenPlan[]
  navigation: { screenId: string; label: string; icon: string }[]
  theme: { accent: string; mood: string; density: string }
  designNotes: string[]
}

export interface GeneratedFile {
  path: string
  content: string
  origin: 'emitted' | 'model'
  screenId?: string
}

export interface ConnectionSettings {
  baseUrlOverride?: string
  authValue?: string
  extraHeaders: Record<string, string>
}

export interface Project {
  id: string
  ownerId: string
  name: string
  status: ProjectStatus
  createdAt: string
  updatedAt: string
  documents: WireDocument[]
  appSpec?: AppSpec
  plan?: AppPlan
  files: GeneratedFile[]
  connection: ConnectionSettings
  /** Screens no API can feed may show sample data. Absent or false: API-only. */
  sampleData?: boolean
  /** When the person pressed Save. Absent means never saved. */
  savedAt?: string
  publish?: { url: string; publishedAt: string; transport: 'direct' }
  error?: string
  mock?: boolean
}

/** The signed-in account. */
export interface PublicUser {
  id: string
  email: string
  name: string
  createdAt: string
}

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

export type PipelineEvent =
  | { type: 'status'; status: ProjectStatus; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'endpoint'; endpoint: Endpoint }
  | { type: 'appspec'; appSpec: AppSpec }
  | { type: 'plan'; plan: AppPlan }
  | { type: 'file'; file: GeneratedFile }
  | { type: 'screen-start'; screenId: string; name: string }
  | { type: 'screen-done'; screenId: string; path: string }
  | { type: 'done'; project: Project }
  | { type: 'error'; message: string }
