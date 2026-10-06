import { Check, CircleSlash, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { EndpointTest } from '@/lib/types'

const tone = {
  pass: { dot: 'bg-mint', text: 'text-mint', label: 'Works' },
  fail: { dot: 'bg-rose', text: 'text-rose', label: 'Failed' },
  skipped: { dot: 'bg-amber', text: 'text-amber', label: 'Not called' },
} as const

/** The compact form on an endpoint row: a dot and the status code. */
export function TestDot({ test }: { test?: EndpointTest }) {
  if (!test) return null
  const t = tone[test.state]
  return (
    <span
      title={test.message}
      className={cn('inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold', t.text)}
    >
      <span className={cn('size-2 rounded-full', t.dot)} />
      {test.status ?? t.label}
    </span>
  )
}

/** The full sentence: what happened and what to do about it. */
export function TestVerdict({ test, className }: { test: EndpointTest; className?: string }) {
  const t = tone[test.state]
  const Icon = test.state === 'pass' ? Check : test.state === 'fail' ? TriangleAlert : CircleSlash
  return (
    <div className={cn('flex items-start gap-1.5 text-[12px] leading-relaxed', t.text, className)}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <p className="min-w-0 break-words">
        {test.message}
        {test.durationMs !== undefined && <span className="text-faint"> · {test.durationMs}ms</span>}
      </p>
    </div>
  )
}
