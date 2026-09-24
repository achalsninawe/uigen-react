import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Activity, Trash2 } from 'lucide-react'
import { Card, CardHeader } from '@/components/ui/Card'
import { Badge, MethodBadge } from '@/components/ui/Badge'
import { api } from '@/lib/api'
import type { CallRecord } from '@/lib/api'

function statusTone(status: number) {
  if (status === 0) return 'rose' as const
  if (status < 300) return 'mint' as const
  if (status < 400) return 'sky' as const
  if (status < 500) return 'amber' as const
  return 'rose' as const
}

/**
 * What the preview actually sent.
 *
 * Polled rather than streamed: calls originate inside the Sandpack iframe, so
 * the studio has no direct visibility into them, and a short poll is far
 * simpler than plumbing a second event stream for something this small.
 */
export function NetworkLog({ projectId, active }: { projectId: string; active: boolean }) {
  const [calls, setCalls] = useState<CallRecord[]>([])

  const refresh = useCallback(() => {
    api.getCalls(projectId).then(setCalls).catch(() => {})
  }, [projectId])

  useEffect(() => {
    if (!active) return
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [active, refresh])

  return (
    <Card>
      <CardHeader
        icon={<Activity className="size-4" />}
        title="Network"
        subtitle={calls.length ? `${calls.length} call${calls.length === 1 ? '' : 's'}` : 'Nothing yet'}
        action={
          calls.length > 0 ? (
            <button
              type="button"
              onClick={() => void api.clearCalls(projectId).then(() => setCalls([]))}
              className="grid size-7 place-items-center rounded-lg text-faint transition-colors hover:bg-rose-soft hover:text-rose"
              aria-label="Clear network log"
            >
              <Trash2 className="size-3.5" />
            </button>
          ) : undefined
        }
      />

      {calls.length === 0 ? (
        <p className="px-5 pb-5 text-[12.5px] leading-relaxed text-muted">
          Interact with the preview and the requests it makes will appear here, with the real URL the proxy
          sent them to.
        </p>
      ) : (
        <ul className="max-h-72 divide-y divide-line-soft overflow-y-auto">
          <AnimatePresence initial={false}>
            {calls.map((call, i) => (
              <motion.li
                key={`${call.at}-${i}`}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="px-5 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <MethodBadge method={call.method} />
                  <Badge tone={statusTone(call.status)} mono>
                    {call.status || 'failed'}
                  </Badge>
                  <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-soft" title={call.url}>
                    {call.url}
                  </code>
                  <span className="shrink-0 text-[11px] tabular-nums text-faint">{call.durationMs}ms</span>
                </div>
                {call.error && <p className="mt-1 text-[11.5px] text-rose">{call.error}</p>}
                {call.learned && <p className="mt-1 text-[11.5px] text-primary">{call.learned}</p>}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </Card>
  )
}
