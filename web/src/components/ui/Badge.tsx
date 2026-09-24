import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'primary' | 'sky' | 'lilac' | 'mint' | 'amber' | 'rose' | 'neutral'

const tones: Record<Tone, string> = {
  primary: 'bg-primary-soft text-primary',
  sky: 'bg-sky-soft text-sky',
  lilac: 'bg-lilac-soft text-lilac',
  mint: 'bg-mint-soft text-mint',
  amber: 'bg-amber-soft text-amber',
  rose: 'bg-rose-soft text-rose',
  neutral: 'bg-canvas-deep text-muted',
}

export function Badge({
  tone = 'neutral',
  children,
  className,
  mono,
}: {
  tone?: Tone
  children: ReactNode
  className?: string
  mono?: boolean
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold tracking-wide',
        mono && 'font-mono tracking-normal',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** HTTP verbs get a stable colour so the eye can scan a long endpoint list. */
const methodTone: Record<string, Tone> = {
  GET: 'sky',
  POST: 'mint',
  PUT: 'amber',
  PATCH: 'amber',
  DELETE: 'rose',
  HEAD: 'neutral',
  OPTIONS: 'neutral',
}

export function MethodBadge({ method, className }: { method: string; className?: string }) {
  const m = method.toUpperCase()
  return (
    <Badge tone={methodTone[m] ?? 'neutral'} mono className={cn('min-w-[52px] justify-center', className)}>
      {m}
    </Badge>
  )
}
