import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronRight, Lock, Quote } from 'lucide-react'
import { Badge, MethodBadge } from '@/components/ui/Badge'
import { LearnShape } from '@/components/LearnShape'
import { cn } from '@/lib/cn'
import type { Endpoint, ParamSpec } from '@/lib/types'

function ParamRow({ param }: { param: ParamSpec }) {
  return (
    <div className="flex items-baseline gap-2 py-1">
      <code className="font-mono text-[12px] font-semibold text-ink">{param.name}</code>
      {param.required && <span className="text-[10px] font-bold text-rose">required</span>}
      <code className="font-mono text-[11.5px] text-lilac">{param.type}</code>
      {param.description && <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{param.description}</span>}
    </div>
  )
}

function ParamGroup({ title, params }: { title: string; params: ParamSpec[] }) {
  if (params.length === 0) return null
  return (
    <div>
      <p className="mb-1 text-[10.5px] font-bold uppercase tracking-wider text-faint">{title}</p>
      <div className="space-y-0.5">
        {params.map((p) => (
          <ParamRow key={`${p.in}:${p.name}`} param={p} />
        ))}
      </div>
    </div>
  )
}

/**
 * One extracted endpoint. Collapsed it reads as a scannable row; expanded it
 * shows every field that was pulled from the document, plus the verbatim
 * excerpt it came from — so the extraction can be audited, not just trusted.
 */
export function EndpointCard({
  endpoint,
  index,
  projectId,
  onLearned,
}: {
  endpoint: Endpoint
  index: number
  projectId: string
  onLearned: () => void
}) {
  const [open, setOpen] = useState(false)

  const successType = endpoint.responses.find((r) => /^2\d\d$/.test(r.status))?.typeName
  const paramCount =
    endpoint.pathParams.length + endpoint.queryParams.length + endpoint.headers.length

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.035, 0.5), duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden rounded-2xl bg-surface ring-1 ring-line transition-shadow hover:shadow-[var(--shadow-soft)]"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 text-faint transition-transform duration-200', open && 'rotate-90')}
        />
        <MethodBadge method={endpoint.method} />
        <code className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium text-ink">{endpoint.path}</code>

        {endpoint.auth.type !== 'none' && (
          <span title={`Requires ${endpoint.auth.type} auth`}>
            <Lock className="size-3.5 shrink-0 text-faint" />
          </span>
        )}
        {successType && (
          <code className="hidden shrink-0 font-mono text-[11.5px] text-lilac sm:inline">{successType}</code>
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-4 border-t border-line-soft px-4 py-4">
              {endpoint.summary && <p className="text-[13px] text-ink-soft">{endpoint.summary}</p>}

              <div className="grid gap-1 text-[12px]">
                <div className="flex gap-2">
                  <span className="w-20 shrink-0 font-semibold text-faint">Base URL</span>
                  <code className="min-w-0 font-mono break-all text-ink-soft">
                    {endpoint.baseUrl || <span className="text-rose">not documented</span>}
                  </code>
                </div>
                <div className="flex gap-2">
                  <span className="w-20 shrink-0 font-semibold text-faint">Function</span>
                  <code className="font-mono text-primary">{endpoint.operationId}()</code>
                </div>
                {endpoint.auth.type !== 'none' && (
                  <div className="flex gap-2">
                    <span className="w-20 shrink-0 font-semibold text-faint">Auth</span>
                    <span className="text-ink-soft">
                      {endpoint.auth.type}
                      {endpoint.auth.name && ` · ${endpoint.auth.name}`}
                      {endpoint.auth.in && ` (${endpoint.auth.in})`}
                    </span>
                  </div>
                )}
              </div>

              <ParamGroup title="Path parameters" params={endpoint.pathParams} />
              <ParamGroup title="Query parameters" params={endpoint.queryParams} />
              <ParamGroup title="Headers" params={endpoint.headers} />

              {endpoint.requestBody && (
                <div>
                  <p className="mb-1 text-[10.5px] font-bold uppercase tracking-wider text-faint">Request body</p>
                  <div className="flex items-baseline gap-2 text-[12px]">
                    <code className="font-mono text-lilac">{endpoint.requestBody.typeName ?? 'unknown'}</code>
                    <span className="text-muted">{endpoint.requestBody.contentType}</span>
                  </div>
                </div>
              )}

              {endpoint.responses.length > 0 && (
                <div>
                  <p className="mb-1 text-[10.5px] font-bold uppercase tracking-wider text-faint">Responses</p>
                  <div className="flex flex-wrap gap-1.5">
                    {endpoint.responses.map((r) => (
                      <Badge
                        key={r.status}
                        tone={/^2/.test(r.status) ? 'mint' : /^4|^5/.test(r.status) ? 'rose' : 'neutral'}
                        mono
                      >
                        {r.status}
                        {r.typeName && ` → ${r.typeName}`}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <p className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-faint">
                  Response shape
                </p>
                {successType ? (
                  <p className="mb-2 text-[12px] text-muted">
                    Known: <code className="font-mono text-lilac">{successType}</code>
                  </p>
                ) : (
                  <p className="mb-2 text-[12px] text-amber">
                    Not documented — screens cannot lay this data out until it is known.
                  </p>
                )}
                <LearnShape projectId={projectId} endpoint={endpoint} onLearned={onLearned} />
              </div>

              {endpoint.sourceQuote && (
                <div className="flex gap-2 rounded-xl bg-canvas-deep px-3 py-2.5">
                  <Quote className="mt-0.5 size-3 shrink-0 text-faint" />
                  <p className="min-w-0 font-mono text-[11.5px] leading-relaxed break-words text-muted">
                    {endpoint.sourceQuote}
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
