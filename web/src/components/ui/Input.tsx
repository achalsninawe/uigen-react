import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

const base =
  'w-full rounded-xl bg-canvas px-3.5 text-sm text-ink placeholder:text-faint ' +
  'ring-1 ring-line transition-all duration-150 ' +
  'hover:ring-primary-ring focus:bg-surface focus:outline-none focus:ring-2 focus:ring-primary'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(base, 'h-10', className)} {...props} />
  },
)

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1.5 block text-[12px] font-semibold text-ink-soft">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-muted">{hint}</span>}
    </label>
  )
}
