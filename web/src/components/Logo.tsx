import { cn } from '@/lib/cn'

export function Logo({ className, size = 32 }: { className?: string; size?: number }) {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-[10px]',
        'bg-gradient-to-br from-primary to-sky text-white',
        'shadow-[0_6px_16px_-6px_rgb(108_99_255/0.7)]',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 24 24" width={size * 0.6} height={size * 0.6} fill="currentColor" aria-hidden>
        <path d="M12 2.5l1.9 5.1 5.1 1.9-5.1 1.9L12 16.5l-1.9-5.1L5 9.5l5.1-1.9z" />
        <circle cx="18.5" cy="17.5" r="2" opacity=".75" />
        <circle cx="6" cy="18" r="1.25" opacity=".55" />
      </svg>
    </span>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <Logo />
      <span className="text-[17px] font-bold tracking-tight text-ink">
        Spec<span className="gradient-text">2</span>UI
      </span>
    </span>
  )
}
