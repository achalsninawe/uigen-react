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

/**
 * Recent proxied calls, per project.
 *
 * In memory and deliberately small: this exists so you can see what the preview
 * actually sent while you are looking at it. It is not an audit log, and it does
 * not survive a restart.
 */
const MAX_PER_PROJECT = 100
const log = new Map<string, CallRecord[]>()

export function recordCall(projectId: string, record: CallRecord): void {
  const existing = log.get(projectId) ?? []
  existing.unshift(record)
  if (existing.length > MAX_PER_PROJECT) existing.length = MAX_PER_PROJECT
  log.set(projectId, existing)
}

export function readCalls(projectId: string): CallRecord[] {
  return log.get(projectId) ?? []
}

export function clearCalls(projectId: string): void {
  log.delete(projectId)
}
