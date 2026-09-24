import type { Request, Response } from 'express'
import { config } from './config.js'

/**
 * The origin a generated app should use to reach this server.
 *
 * Shared by generate and export so a build's `proxyBase` points at the same
 * host whichever route emitted it.
 */
export function serverOrigin(req: { headers: Record<string, unknown> }): string {
  const forwarded = req.headers['x-forwarded-host']
  const host = typeof forwarded === 'string' ? forwarded : undefined
  return host ? `http://${host}` : `http://localhost:${config.port}`
}

/** Wraps an async handler so rejections reach Express' error middleware. */
export function asyncRoute<T extends Request>(
  fn: (req: T, res: Response) => Promise<unknown>,
) {
  return (req: T, res: Response, next: (err?: unknown) => void) => {
    fn(req, res).catch(next)
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export const badRequest = (m: string) => new HttpError(400, m)
export const notFound = (m: string) => new HttpError(404, m)

/**
 * Opens a server-sent event stream. Long pipeline runs push progress through
 * this so the UI can show work as it happens rather than spinning for a minute.
 */
export function openEventStream(res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  // Comment frames keep intermediaries from closing an idle stream.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
  let closed = false

  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    res.end()
  }

  res.on('close', () => {
    closed = true
    clearInterval(heartbeat)
  })

  return {
    send(event: unknown) {
      if (closed) return
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    },
    get closed() {
      return closed
    },
    close,
  }
}

export type EventStream = ReturnType<typeof openEventStream>

/** Express 5 types route params as `string | string[]`; every route here wants one. */
export function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name]
  const single = Array.isArray(value) ? value[0] : value
  if (!single) throw new HttpError(400, `Missing route parameter "${name}"`)
  return single
}
