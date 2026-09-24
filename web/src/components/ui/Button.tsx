import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'soft' | 'ghost' | 'outline' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary:
    'bg-primary text-white shadow-[0_6px_18px_-6px_rgb(108_99_255/0.6)] hover:bg-primary-hover active:translate-y-px',
  soft: 'bg-primary-soft text-primary hover:bg-primary-ring active:translate-y-px',
  ghost: 'text-muted hover:text-ink hover:bg-canvas-deep',
  outline: 'bg-surface text-ink ring-1 ring-line hover:ring-primary-ring hover:bg-canvas',
  danger: 'bg-rose-soft text-rose hover:bg-rose hover:text-white',
}

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-6 text-[15px] gap-2.5 rounded-2xl',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', loading, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center font-semibold whitespace-nowrap',
        'transition-all duration-150 ease-[var(--ease-out-soft)]',
        'disabled:opacity-45 disabled:pointer-events-none',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  )
})
