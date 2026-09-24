import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'bg-surface rounded-[var(--radius-card)] ring-1 ring-line shadow-[var(--shadow-soft)]',
        className,
      )}
      {...props}
    />
  )
}

export function CardHeader({
  title,
  subtitle,
  icon,
  action,
  className,
}: {
  title: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-start gap-3 px-5 pt-5 pb-4', className)}>
      {icon && (
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary">
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[15px] font-semibold text-ink">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}
