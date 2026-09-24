import { cn } from '@/lib/cn'

/** Three dots breathing in sequence — quieter than a spinning ring. */
export function Dots({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 rounded-full bg-current opacity-30"
          style={{ animation: `s2u-pulse 1.1s ${i * 0.16}s ease-in-out infinite` }}
        />
      ))}
    </span>
  )
}
