import { useState } from 'react'
import { motion } from 'framer-motion'
import { FlaskConical } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { TestVerdict } from '@/components/TestStatus'
import { api } from '@/lib/api'
import type { Endpoint, Project } from '@/lib/types'

const input =
  'h-8 w-full rounded-lg bg-surface px-2.5 font-mono text-[12px] ring-1 ring-line focus:ring-2 focus:ring-primary focus:outline-none'

/**
 * Calls one endpoint for real, with values the person types.
 *
 * "Test all" can only fill what the documents or an earlier response supply;
 * this is for everything else — a policy number only you know, a body the
 * documents never showed. A 2xx with data teaches the endpoint its response
 * shape, so the next generate lays the screen out against it.
 */
export function TestEndpoint({
  projectId,
  endpoint,
  onTested,
}: {
  projectId: string
  endpoint: Endpoint
  onTested: (project: Project) => void
}) {
  const needsBody = !['GET', 'HEAD', 'DELETE'].includes(endpoint.method)
  const [open, setOpen] = useState(false)
  // Starts from what was typed last time, so a real policy number is not retyped.
  const typed = endpoint.lastTestInput
  const [body, setBody] = useState(() => {
    const start = typed?.body !== undefined ? typed.body : endpoint.requestBody?.example
    return start !== undefined ? JSON.stringify(start, null, 2) : '{\n  \n}'
  })
  const [pathParams, setPathParams] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(endpoint.pathParams.filter((p) => p.example).map((p) => [p.name, p.example!])),
    ...Object.fromEntries(Object.entries(typed?.pathParams ?? {}).map(([k, v]) => [k, String(v)])),
  }))
  const [query, setQuery] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(endpoint.queryParams.filter((p) => p.example).map((p) => [p.name, p.example!])),
    ...Object.fromEntries(Object.entries(typed?.query ?? {}).map(([k, v]) => [k, String(v)])),
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      let parsed: unknown
      if (needsBody) {
        try {
          parsed = JSON.parse(body)
        } catch {
          setError('That request body is not valid JSON.')
          return
        }
      }
      const res = await api.testEndpoint(projectId, endpoint.operationId, {
        ...(needsBody ? { body: parsed } : {}),
        ...(Object.keys(pathParams).length ? { pathParams } : {}),
        ...(Object.keys(query).length ? { query } : {}),
      })
      onTested(res.project)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The call failed')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-lilac-soft px-2.5 py-1.5 text-[11.5px] font-semibold text-lilac transition-opacity hover:opacity-80"
      >
        <FlaskConical className="size-3.5" />
        {endpoint.lastTest ? 'Test again' : 'Test this API'}
      </button>
    )
  }

  const fields = (
    params: Endpoint['pathParams'],
    values: Record<string, string>,
    set: (next: Record<string, string>) => void,
  ) =>
    params.map((p) => (
      <label key={p.name} className="block">
        <span className="mb-1 block text-[11px] font-semibold text-ink-soft">
          {p.name}
          {p.required && <span className="ml-1 text-rose">*</span>}
        </span>
        <input
          value={values[p.name] ?? ''}
          onChange={(e) => set({ ...values, [p.name]: e.target.value })}
          placeholder={p.type}
          className={input}
        />
      </label>
    ))

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      className="overflow-hidden rounded-xl bg-canvas-deep p-3"
    >
      <p className="text-[12px] leading-relaxed text-muted">
        Calls <code className="font-mono text-ink">{endpoint.method}</code> once with your saved credentials.
        {needsBody && endpoint.method !== 'PUT' && ' This may create a record in the real system.'}
      </p>

      {(endpoint.pathParams.length > 0 || endpoint.queryParams.length > 0) && (
        <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
          {fields(endpoint.pathParams, pathParams, setPathParams)}
          {fields(endpoint.queryParams, query, setQuery)}
        </div>
      )}

      {needsBody && (
        <label className="mt-2.5 block">
          <span className="mb-1 block text-[11px] font-semibold text-ink-soft">Request body</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            rows={6}
            className="w-full rounded-lg bg-surface p-2.5 font-mono text-[11.5px] leading-relaxed ring-1 ring-line focus:ring-2 focus:ring-primary focus:outline-none"
          />
        </label>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" onClick={() => void run()} loading={busy}>
          Call it
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Close
        </Button>
      </div>

      {error && <p className="mt-2.5 text-[12px] leading-relaxed text-rose">{error}</p>}
      {!error && endpoint.lastTest && !busy && <TestVerdict test={endpoint.lastTest} className="mt-2.5" />}
    </motion.div>
  )
}
