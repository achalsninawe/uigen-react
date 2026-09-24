import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, FlaskConical, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { api } from '@/lib/api'
import type { Endpoint } from '@/lib/types'
import { cn } from '@/lib/cn'

/**
 * Learns an endpoint's response shape by calling it once, for real.
 *
 * Documentation that omits response schemas is the norm, and it leaves screens
 * unable to lay data out — they know a call succeeds but not what a success
 * contains. One real call settles it, and unlike a guess it cannot be wrong.
 */
export function LearnShape({
  projectId,
  endpoint,
  onLearned,
}: {
  projectId: string
  endpoint: Endpoint
  onLearned: () => void
}) {
  const needsBody = !['GET', 'HEAD', 'DELETE'].includes(endpoint.method)
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState(() =>
    endpoint.requestBody?.example ? JSON.stringify(endpoint.requestBody.example, null, 2) : '{\n  \n}',
  )
  const [pathParams, setPathParams] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const known = endpoint.responses.find((r) => /^2\d\d$/.test(r.status))?.typeName

  async function run() {
    setBusy(true)
    setResult(null)
    try {
      let parsed: unknown
      if (needsBody) {
        try {
          parsed = JSON.parse(body)
        } catch {
          setResult({ ok: false, message: 'That request body is not valid JSON.' })
          return
        }
      }

      const res = await api.learnShape(projectId, endpoint.operationId, {
        ...(needsBody ? { body: parsed } : {}),
        ...(Object.keys(pathParams).length ? { pathParams } : {}),
      })

      setResult({
        ok: true,
        message: `Learned ${res.rootTypeName} — ${res.learned.length} shape${
          res.learned.length === 1 ? '' : 's'
        } from a ${res.status} in ${res.durationMs}ms`,
      })
      onLearned()
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'The call failed' })
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
        {known ? 'Re-learn response shape' : 'Learn response shape'}
      </button>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      className="overflow-hidden rounded-xl bg-canvas-deep p-3"
    >
      <p className="text-[12px] leading-relaxed text-muted">
        Calls <code className="font-mono text-ink">{endpoint.method}</code> once with your saved credentials and
        records the shape of the response, so screens can lay the data out properly.
      </p>

      {endpoint.pathParams.length > 0 && (
        <div className="mt-2.5 space-y-2">
          {endpoint.pathParams.map((p) => (
            <label key={p.name} className="block">
              <span className="mb-1 block text-[11px] font-semibold text-ink-soft">{p.name}</span>
              <input
                value={pathParams[p.name] ?? ''}
                onChange={(e) => setPathParams((prev) => ({ ...prev, [p.name]: e.target.value }))}
                placeholder={p.example ?? p.type}
                className="h-8 w-full rounded-lg bg-surface px-2.5 font-mono text-[12px] ring-1 ring-line focus:ring-2 focus:ring-primary focus:outline-none"
              />
            </label>
          ))}
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
          Cancel
        </Button>
      </div>

      <AnimatePresence>
        {result && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className={cn(
              'mt-2.5 flex items-start gap-1.5 text-[12px] leading-relaxed',
              result.ok ? 'text-mint' : 'text-rose',
            )}
          >
            {result.ok ? (
              <Check className="mt-0.5 size-3.5 shrink-0" />
            ) : (
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            )}
            {result.message}
          </motion.p>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
