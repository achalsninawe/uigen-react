import type { AppSpec, ConnectionSettings, PipelineEvent, Project, ProjectSummary, PublicUser } from './types'

export interface CallRecord {
  operationId: string
  method: string
  url: string
  /** 0 when the request never reached the upstream. */
  status: number
  durationMs: number
  at: string
  error?: string
  /** Set when this call's response taught the project a shape it lacked. */
  learned?: string
}

export interface HealthInfo {
  ok: boolean
  service: string
  ai: 'ready' | 'mock'
  storage: 'azure' | 'local'
  deployment: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData
  const res = await fetch(path, {
    ...init,
    // The session lives in a cookie, and the studio talks to the API across
    // origins in development, where cookies are not sent unless asked for.
    credentials: 'include',
    headers: isFormData ? init?.headers : { 'Content-Type': 'application/json', ...init?.headers },
  })

  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string }
    const error = new Error(detail.error ?? `${res.status} ${res.statusText}`) as Error & { status?: number }
    error.status = res.status
    throw error
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  health: () => request<HealthInfo>('/api/health'),

  me: () => request<{ user: PublicUser | null }>('/api/auth/me').then((r) => r.user),

  register: (body: { email: string; password: string; name?: string }) =>
    request<{ user: PublicUser }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((r) => r.user),

  login: (body: { email: string; password: string }) =>
    request<{ user: PublicUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((r) => r.user),

  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),

  listProjects: () => request<{ projects: ProjectSummary[] }>('/api/projects').then((r) => r.projects),

  createProject: (files: File[], name?: string, sampleData = false) => {
    const form = new FormData()
    for (const file of files) form.append('files', file)
    // Appended after the files so multer has parsed the fields by the time the
    // route reads req.body.name.
    if (name) form.append('name', name)
    form.append('sampleData', String(sampleData))
    return request<{ project: Project }>('/api/projects', { method: 'POST', body: form }).then(
      (r) => r.project,
    )
  },

  getProject: (id: string) =>
    request<{ project: Project }>(`/api/projects/${id}`).then((r) => r.project),

  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  saveAppSpec: (id: string, appSpec: AppSpec) =>
    request<{ project: Project }>(`/api/projects/${id}/appspec`, {
      method: 'PUT',
      body: JSON.stringify({ appSpec }),
    }).then((r) => r.project),

  /** Keeps the project under a name, stamped now. */
  saveProject: (id: string, name: string) =>
    request<{ project: Project }>(`/api/projects/${id}/save`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }).then((r) => r.project),

  renameProject: (id: string, name: string) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }).then((r) => r.project),

  /** Whether screens no API can feed may use sample data. Applies on the next generate. */
  setSampleData: (id: string, sampleData: boolean) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ sampleData }),
    }).then((r) => r.project),

  saveConnection: (id: string, connection: ConnectionSettings) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ connection }),
    }).then((r) => r.project),

  getCalls: (id: string) => request<{ calls: CallRecord[] }>(`/api/projects/${id}/calls`).then((r) => r.calls),

  clearCalls: (id: string) => request<void>(`/api/projects/${id}/calls`, { method: 'DELETE' }),

  /** Calls an endpoint for real and records the shape of what comes back. */
  learnShape: (
    id: string,
    operationId: string,
    payload: { pathParams?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown },
  ) =>
    request<{
      rootTypeName: string
      learned: { name: string; fields: number }[]
      status: number
      url: string
      durationMs: number
      project: Project
    }>(`/api/projects/${id}/endpoints/${operationId}/learn`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  saveFile: (id: string, path: string, content: string) =>
    request<{ ok: true }>(`/api/projects/${id}/files`, {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),

  /**
   * Downloads the generated app as a ZIP.
   *
   * Fetched rather than linked so a refusal arrives as a message instead of a
   * browser download that turns out to be a JSON error.
   */
  exportApp: async (id: string, transport: 'bff' | 'direct') => {
    const res = await fetch(`/api/projects/${id}/export?transport=${transport}`, {
      credentials: 'include',
    })

    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(detail.error ?? `${res.status} ${res.statusText}`)
    }

    const blob = await res.blob()
    const name =
      /filename="?([^"]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'app.zip'

    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    // Revoked on the next tick: Safari never starts the download if the object
    // URL is released synchronously after the click.
    window.setTimeout(() => URL.revokeObjectURL(url), 0)

    return { name, bytes: blob.size }
  },
}

/**
 * Consumes one of the pipeline's server-sent event streams.
 *
 * Resolves when the run finishes, rejects if it fails. EventSource retries on
 * its own by design, which would silently restart an expensive pipeline — so
 * the connection is closed explicitly at every terminal point.
 */
/** Stream URL for another pass at the screens already generated. */
export const repairUrl = (id: string, note?: string, mode: 'fix' | 'refine' = 'fix') => {
  const query = new URLSearchParams({ mode })
  if (note) query.set('note', note)
  return `/api/projects/${id}/repair?${query.toString()}`
}

export function streamPipeline(
  url: string,
  onEvent: (event: PipelineEvent) => void,
): { promise: Promise<void>; cancel: () => void } {
  let source: EventSource | null = null
  let settled = false

  const promise = new Promise<void>((resolve, reject) => {
    source = new EventSource(url, { withCredentials: true })

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      source?.close()
      if (err) reject(err)
      else resolve()
    }

    source.onmessage = (message) => {
      let event: PipelineEvent
      try {
        event = JSON.parse(message.data) as PipelineEvent
      } catch {
        return
      }

      onEvent(event)
      if (event.type === 'done') finish()
      else if (event.type === 'error') finish(new Error(event.message))
    }

    source.onerror = () => {
      // Fires both on a dropped connection and on the normal server close that
      // follows a 'done' event; by then `settled` is already true.
      finish(new Error('Lost connection to the server'))
    }
  })

  return {
    promise,
    cancel: () => {
      settled = true
      source?.close()
    },
  }
}

export const analyzeUrl = (id: string) => `/api/projects/${id}/analyze`
export const generateUrl = (id: string, replan = false) =>
  `/api/projects/${id}/generate${replan ? '?replan=1' : ''}`
