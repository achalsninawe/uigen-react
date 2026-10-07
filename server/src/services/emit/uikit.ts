/**
 * The component vocabulary available to generated screens.
 *
 * This is a fixed, hand-written set rather than model output. Screens are
 * generated against it, which keeps every screen visually consistent, removes
 * whole classes of layout bugs, and keeps the generation prompt small — the
 * model composes from a known kit instead of inventing markup each time.
 */

export const UI_CN = `import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
`

export const UI_PRIMITIVES = `import { forwardRef, isValidElement, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from './cn'

/* ---------------------------------- Button --------------------------------- */

type ButtonVariant = 'primary' | 'soft' | 'outline' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white shadow-sm hover:brightness-110 active:translate-y-px',
  soft: 'bg-accent/10 text-accent hover:bg-accent/15 active:translate-y-px',
  outline: 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 hover:ring-slate-300',
  ghost: 'text-slate-500 hover:text-slate-900 hover:bg-slate-100',
  danger: 'bg-rose-500 text-white hover:bg-rose-600 active:translate-y-px',
}

const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-6 text-[15px] gap-2.5 rounded-xl',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  /** Rendered before the label; replaced by the spinner while loading. */
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', loading, icon, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center font-semibold whitespace-nowrap transition-all duration-150',
        'disabled:opacity-50 disabled:pointer-events-none',
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    >
      {loading ? (
        <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity=".25" />
          <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      ) : (
        icon
      )}
      {children}
    </button>
  )
})

/* --------------------------------- Actions --------------------------------- */

/**
 * Either a ready-made element, or a description of a button to render.
 *
 * Writing \`action={{ label: 'Retry', onClick: load }}\` is the natural way to
 * express an action, and React cannot render a plain object — it throws
 * "Objects are not valid as a React child". Accepting both forms removes a
 * whole class of runtime crash instead of insisting on one spelling.
 */
export type ActionLike =
  | ReactNode
  | {
      label: ReactNode
      onClick?: () => void
      variant?: ButtonVariant
      disabled?: boolean
      loading?: boolean
    }

export function renderAction(action: ActionLike): ReactNode {
  if (
    action &&
    typeof action === 'object' &&
    !isValidElement(action) &&
    !Array.isArray(action) &&
    'label' in action
  ) {
    const { label, onClick, variant = 'primary', disabled, loading } = action as Exclude<
      ActionLike,
      ReactNode
    >
    return (
      <Button size="sm" variant={variant} onClick={onClick} disabled={disabled} loading={loading}>
        {label}
      </Button>
    )
  }
  return action as ReactNode
}

/* ----------------------------------- Card ---------------------------------- */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        // overflow-hidden so a <Hero> dropped in as the first child is clipped to
        // the card's own corners instead of squaring off its top two.
        'overflow-hidden rounded-2xl bg-white ring-1 ring-line',
        'shadow-[0_1px_2px_rgba(15,23,42,0.04),0_10px_30px_-16px_rgba(15,23,42,0.18)]',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: ReactNode
  subtitle?: ReactNode
  action?: ActionLike
  className?: string
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 border-b border-line px-5 py-4', className)}>
      <div className="min-w-0">
        <h3 className="truncate text-[15px] font-semibold text-slate-900">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[13px] text-slate-500">{subtitle}</p>}
      </div>
      {renderAction(action)}
    </div>
  )
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('p-5', className)}>{children}</div>
}

/* ----------------------------------- Hero ---------------------------------- */

/**
 * The tinted band that opens a screen's first card.
 *
 * A page of white cards on a white page has nowhere for the eye to land, and
 * every screen reads as the same weight as every other. One gradient band at the
 * top says "this is where you are" before a single word is read — which is the
 * whole job, so it carries no data and nothing below it depends on it.
 *
 * Place it as the first child of a <Card>, before <CardBody>.
 */
export function Hero({
  eyebrow,
  headline,
  sub,
  icon,
  className,
}: {
  eyebrow?: ReactNode
  headline: ReactNode
  sub?: ReactNode
  /** Decoration only — shown large and faded on the trailing edge. */
  icon?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        // Written as an explicit gradient rather than from-*/via-*/to-* because
        // those utilities were renamed between Tailwind 3 and 4; the tokens are
        // the same in both, so this spelling survives either.
        'relative isolate overflow-hidden px-6 py-8 sm:px-8 sm:py-10',
        'bg-[linear-gradient(135deg,var(--color-accent-soft),var(--color-accent-tint)_48%,#fff)]',
        className,
      )}
    >
      <div className="relative z-10 max-w-xl">
        {eyebrow && (
          <span className="inline-flex items-center rounded-full bg-white/75 px-3 py-1 text-[11px] font-semibold tracking-[0.12em] text-accent uppercase ring-1 ring-white/70">
            {eyebrow}
          </span>
        )}
        <h2 className={cn('text-[26px] leading-tight font-bold tracking-tight text-slate-900 sm:text-[30px]', eyebrow && 'mt-4')}>
          {headline}
        </h2>
        {sub && <p className="mt-3 text-sm leading-relaxed text-slate-600">{sub}</p>}
      </div>
      {icon ? (
        <div className="pointer-events-none absolute inset-y-0 -right-4 z-0 hidden items-center text-accent/20 sm:flex [&>svg]:size-40">
          {icon}
        </div>
      ) : (
        // Two soft discs where a brand would put an illustration. Without them
        // the band is a flat wash and reads as an unfinished placeholder; with
        // them it has somewhere for the light to come from, and it needs no
        // artwork nobody has.
        <div aria-hidden className="pointer-events-none absolute inset-0 z-0 hidden overflow-hidden sm:block">
          <span className="absolute -top-20 -right-12 size-64 rounded-full bg-white/50 blur-2xl" />
          <span className="absolute -right-20 -bottom-24 size-56 rounded-full bg-accent/15 blur-3xl" />
        </div>
      )}
    </div>
  )
}

/* --------------------------------- SplitPage -------------------------------- */

/**
 * Main column with a summary column beside it, stacking on narrow screens.
 *
 * The aside sticks while the form scrolls, because its whole purpose is to keep
 * the running total in view — a summary that scrolls away with the field it
 * summarises may as well be at the bottom of the page.
 */
export function SplitPage({
  aside,
  className,
  children,
}: {
  aside?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]', className)}>
      <div className="min-w-0">{children}</div>
      {aside && <div className="xl:sticky xl:top-8">{aside}</div>}
    </div>
  )
}

/* ----------------------------------- Note ---------------------------------- */

type NoteTone = 'accent' | 'info' | 'success' | 'warning' | 'danger'

const noteTones: Record<NoteTone, string> = {
  accent: 'bg-accent-tint text-slate-700 ring-accent/15',
  info: 'bg-sky-50 text-sky-900 ring-sky-100',
  success: 'bg-emerald-50 text-emerald-900 ring-emerald-100',
  warning: 'bg-amber-50 text-amber-900 ring-amber-200',
  danger: 'bg-rose-50 text-rose-900 ring-rose-100',
}

/** A tinted aside: a caveat, a reassurance, a note about what happens next. */
export function Note({
  tone = 'accent',
  icon,
  className,
  children,
}: {
  tone?: NoteTone
  icon?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-xl px-4 py-3 text-[12.5px] leading-relaxed ring-1',
        // A note is nearly always a remark about what sits above it, so it
        // carries its own separation rather than relying on each screen.
        '[&:not(:first-child)]:mt-5',
        noteTones[tone],
        className,
      )}
    >
      {icon && <span className="mt-px shrink-0">{icon}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/**
 * A row of buttons closing a form or a card.
 *
 * Buttons emitted straight after the last input sat hard against it and against
 * the card edge, so the primary action read as part of the field above it. The
 * separation is the component's job, not something each screen should remember
 * to add.
 */
export function Actions({
  align = 'left',
  className,
  children,
}: {
  align?: 'left' | 'right' | 'between'
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'mt-6 flex flex-wrap items-center gap-2.5',
        align === 'right' && 'justify-end',
        align === 'between' && 'justify-between',
        className,
      )}
    >
      {children}
    </div>
  )
}

/* ---------------------------------- Inputs --------------------------------- */

const fieldBase =
  'w-full rounded-xl bg-white px-3.5 text-sm text-slate-900 placeholder:text-slate-400 ' +
  'ring-1 ring-line transition-shadow hover:ring-accent/35 ' +
  'focus:outline-none focus:ring-2 focus:ring-accent disabled:bg-accent-tint disabled:text-slate-400'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Rendered inside the field, on the leading edge. */
  icon?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, icon, ...props },
  ref,
) {
  const input = <input ref={ref} className={cn(fieldBase, 'h-10', icon && 'pl-9', className)} {...props} />
  if (!icon) return input
  return (
    <span className="relative block">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">{icon}</span>
      {input}
    </span>
  )
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(fieldBase, 'min-h-24 py-2.5', className)} {...props} />
  },
)

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select ref={ref} className={cn(fieldBase, 'h-10 pr-8', className)} {...props}>
      {children}
    </select>
  )
})

/**
 * How much of a <FormGrid> row one field occupies.
 *
 * A currency picker and a postal address are not the same size, and giving them
 * the same width is what makes a generated form look generated. The grid is six
 * columns, so a row can be two halves, three thirds, or any mix of those.
 */
export type FieldSpan = 'full' | 'twoThirds' | 'half' | 'third'

const fieldSpans: Record<FieldSpan, string> = {
  full: 'sm:col-span-2 lg:col-span-6',
  twoThirds: 'sm:col-span-2 lg:col-span-4',
  half: 'lg:col-span-3',
  third: 'lg:col-span-2',
}

/**
 * The container every group of <Field>s belongs in.
 *
 * One field per row is correct for a phone and wasteful on a laptop: a coverage
 * term and a currency read as a pair and should sit as one. Six columns is the
 * smallest base that divides by both two and three, so halves and thirds can
 * share a form without a second grid.
 *
 * The child-label rule cancels the bottom margin <Field> carries for standalone
 * use — the grid's own row gap does that job here, and both would double it.
 */
export function FormGrid({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-2 lg:grid-cols-6',
        '[&>label:not(:last-child)]:mb-0',
        // Whatever follows the fields — a note, a second grid, a result — sat
        // hard against the last input and read as part of the form.
        '[&:not(:last-child)]:mb-5',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function Field({
  label,
  hint,
  error,
  required,
  span = 'half',
  children,
  className,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  /** Width inside a <FormGrid>. Ignored when the field stands on its own. */
  span?: FieldSpan
  children: ReactNode
  className?: string
}) {
  return (
    // Carries its own bottom spacing: stacked straight into a card, one field's
    // label otherwise sits flush against the input above it, which reads as one
    // run-together block rather than a form. Last child drops it so the card
    // padding is not doubled.
    <label className={cn('block [&:not(:last-child)]:mb-4', fieldSpans[span], className)}>
      <span className="mb-1.5 flex items-center gap-1 text-[12px] font-semibold text-slate-700">
        {label}
        {required && <span className="text-rose-500">*</span>}
      </span>
      {children}
      {error ? (
        <span className="mt-1 block text-[11.5px] font-medium text-rose-600">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[11.5px] text-slate-500">{hint}</span>
      ) : null}
    </label>
  )
}

/* ---------------------------------- Badge ---------------------------------- */

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-600',
  accent: 'bg-accent/10 text-accent',
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-700',
  danger: 'bg-rose-50 text-rose-700',
  info: 'bg-sky-50 text-sky-700',
}

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: BadgeTone
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11.5px] font-semibold',
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/**
 * Maps a status string to a sensible tone. Unknown values stay neutral rather
 * than being colour-coded by guesswork.
 */
export function StatusBadge({ status }: { status: string }) {
  const value = String(status ?? '').toLowerCase()
  const tone: BadgeTone =
    /(active|success|succeeded|complete|completed|approved|paid|shipped|delivered|open|live|enabled|ok)/.test(value)
      ? 'success'
      : /(pending|processing|waiting|queued|draft|review|in_progress)/.test(value)
        ? 'warning'
        : /(failed|error|cancelled|canceled|rejected|declined|expired|closed|disabled|inactive)/.test(value)
          ? 'danger'
          : 'neutral'
  return <Badge tone={tone}>{String(status)}</Badge>
}

/* -------------------------------- PageHeader ------------------------------- */

export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  className,
}: {
  title: ReactNode
  /** Small tinted line above the title, e.g. "Step 02 / 05". */
  eyebrow?: ReactNode
  description?: ReactNode
  actions?: ActionLike | ActionLike[]
  className?: string
}) {
  const rendered = Array.isArray(actions) ? actions.map(renderAction) : renderAction(actions)
  return (
    <div className={cn('mb-6 flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-2 text-[11px] font-semibold tracking-[0.14em] text-accent uppercase">{eyebrow}</p>
        )}
        <h1 className="text-[28px] leading-tight font-bold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{rendered}</div>}
    </div>
  )
}
`

export const UI_FEEDBACK = `import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { cn } from './cn'
import { renderAction, type ActionLike } from './primitives'

/* --------------------------------- Loading --------------------------------- */

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('size-5 animate-spin text-accent', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity=".2" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-slate-100', className)} />
}

/** Placeholder rows matching a table's column count. */
export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="divide-y divide-slate-100">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-5 py-3.5">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className={cn('h-4 flex-1', c === 0 && 'max-w-[30%]')} />
          ))}
        </div>
      ))}
    </div>
  )
}

/* ---------------------------------- States --------------------------------- */

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ActionLike
  icon?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="grid size-12 place-items-center rounded-2xl bg-accent/10 text-accent">
        {icon ?? (
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 7h16M4 12h10M4 17h7" strokeLinecap="round" />
          </svg>
        )}
      </div>
      <p className="mt-4 text-[15px] font-semibold text-slate-900">{title}</p>
      {description && <p className="mt-1.5 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-5">{renderAction(action)}</div>}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong'
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="grid size-12 place-items-center rounded-2xl bg-rose-50 text-rose-500">
        <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 8v5M12 16.5v.5" strokeLinecap="round" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      </div>
      <p className="mt-4 text-[15px] font-semibold text-slate-900">Request failed</p>
      <p className="mt-1.5 max-w-md text-sm break-words text-slate-500">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-5 inline-flex h-9 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-white transition hover:brightness-110"
        >
          Try again
        </button>
      )}
    </div>
  )
}

/**
 * Why a submit failed, in the API's own words, next to the button that sent it.
 * Renders nothing until there is an error.
 */
export function FormError({ error, title }: { error: unknown; title?: ReactNode }) {
  if (!error) return null
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'The request failed'
  return (
    <div role="alert" className="mt-4 flex gap-3 rounded-xl bg-rose-50 px-4 py-3 text-sm ring-1 ring-rose-200">
      <svg viewBox="0 0 24 24" className="mt-0.5 size-4 shrink-0 text-rose-500" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 8v5M12 16.5v.5" strokeLinecap="round" />
        <circle cx="12" cy="12" r="9" />
      </svg>
      <div className="min-w-0">
        <p className="font-semibold text-rose-800">{title ?? 'The request was not accepted'}</p>
        <p className="mt-0.5 break-words text-rose-700">{message}</p>
      </div>
    </div>
  )
}

/* ---------------------------------- Toasts --------------------------------- */

interface Toast {
  id: number
  message: string
  tone: 'success' | 'error' | 'info'
}

const ToastContext = createContext<{ push: (message: string, tone?: Toast['tone']) => void }>({
  push: () => {},
})

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((prev) => [...prev, { id, message, tone }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000)
  }, [])

  const value = useMemo(() => ({ push }), [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-80 flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto rounded-xl px-4 py-3 text-sm font-medium shadow-lg ring-1',
              toast.tone === 'success' && 'bg-white text-emerald-700 ring-emerald-100',
              toast.tone === 'error' && 'bg-white text-rose-700 ring-rose-100',
              toast.tone === 'info' && 'bg-white text-slate-700 ring-slate-200',
            )}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
`

export const UI_DATA = `import type { ReactNode } from 'react'
import { cn } from './cn'
import type { ActionLike } from './primitives'
import { EmptyState, ErrorState, TableSkeleton } from './feedback'

export interface Column<T> {
  /** Column heading. */
  header: ReactNode
  /** Cell renderer. Keep it pure — it runs for every row. */
  cell: (row: T, index: number) => ReactNode
  /** Extra classes for this column's cells, e.g. 'text-right tabular-nums'. */
  className?: string
  width?: string
}

/**
 * A table that handles its own loading, error and empty states so screens do
 * not each reinvent them.
 */
export function DataTable<T>({
  rows,
  columns,
  loading,
  error,
  onRetry,
  onRowClick,
  empty,
  getRowKey,
}: {
  rows: T[] | undefined
  columns: Column<T>[]
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  onRowClick?: (row: T) => void
  empty?: { title: string; description?: string; action?: ActionLike }
  getRowKey?: (row: T, index: number) => string | number
}) {
  if (loading) return <TableSkeleton columns={columns.length} />
  if (error) return <ErrorState error={error} onRetry={onRetry} />
  if (!rows || rows.length === 0) {
    return (
      <EmptyState
        title={empty?.title ?? 'Nothing here yet'}
        description={empty?.description}
        action={empty?.action}
      />
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-accent-tint">
          <tr className="border-b border-line">
            {columns.map((column, i) => (
              <th
                key={i}
                style={column.width ? { width: column.width } : undefined}
                className={cn(
                  'px-5 py-3 text-left text-[11.5px] font-semibold uppercase tracking-wide text-slate-500',
                  column.className,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.map((row, rowIndex) => (
            <tr
              key={getRowKey ? getRowKey(row, rowIndex) : rowIndex}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                'transition-colors',
                onRowClick && 'cursor-pointer hover:bg-accent-tint',
              )}
            >
              {columns.map((column, i) => (
                <td key={i} className={cn('px-5 py-3.5 text-slate-700', column.className)}>
                  {column.cell(row, rowIndex)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A single headline number. */
export function Stat({
  label,
  value,
  hint,
  icon,
}: {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="rounded-2xl bg-white p-5 ring-1 ring-line shadow-[0_1px_2px_rgba(15,23,42,0.04),0_10px_30px_-16px_rgba(15,23,42,0.18)]">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
        {icon && <span className="grid size-8 place-items-center rounded-lg bg-accent-soft text-accent">{icon}</span>}
      </div>
      <p className="mt-2 text-2xl font-bold tabular-nums text-slate-900">{value}</p>
      {hint && <p className="mt-1 text-[12px] text-slate-500">{hint}</p>}
    </div>
  )
}

/**
 * The dark summary column beside a form.
 *
 * Every row may be empty, and an empty one shows a dash rather than
 * disappearing: the point of the panel is to show what is still outstanding, so
 * a blank "Sum assured" is information. Never fill one with a plausible value to
 * make the panel look complete.
 */
export function SummaryPanel({
  title,
  headline,
  items,
  footer,
  className,
}: {
  /** Small uppercase label at the top, e.g. "Your cover at a glance". */
  title: ReactNode
  /** Optional larger line under it. */
  headline?: ReactNode
  items: { label: ReactNode; value?: ReactNode }[]
  footer?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('overflow-hidden rounded-2xl bg-accent-deep text-white shadow-lg', className)}>
      <div className="px-5 pt-5 pb-4">
        <p className="text-[10.5px] font-semibold tracking-[0.16em] text-white/55 uppercase">{title}</p>
        {headline && <p className="mt-2.5 text-[19px] leading-snug font-bold">{headline}</p>}
      </div>
      <dl className="divide-y divide-white/10 border-t border-white/10">
        {items.map((item, i) => (
          <div key={i} className="flex items-baseline justify-between gap-4 px-5 py-2.5">
            <dt className="text-[12.5px] text-white/60">{item.label}</dt>
            <dd className="min-w-0 text-right text-[13px] font-semibold tabular-nums">
              {item.value === undefined || item.value === null || item.value === '' ? (
                <span className="text-white/35">—</span>
              ) : (
                item.value
              )}
            </dd>
          </div>
        ))}
      </dl>
      {footer && (
        <div className="border-t border-white/10 px-5 py-4 text-[12.5px] leading-relaxed text-white/70">
          {footer}
        </div>
      )}
    </div>
  )
}

/** Label/value pairs for a detail screen. */
export function DetailList({ items }: { items: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="divide-y divide-slate-50">
      {items.map((item, i) => (
        <div key={i} className="flex gap-4 px-5 py-3">
          <dt className="w-44 shrink-0 text-[13px] font-medium text-slate-500">{item.label}</dt>
          <dd className="min-w-0 flex-1 text-[13px] break-words text-slate-900">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Renders any unknown value readably — useful for undocumented response fields. */
export function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="text-slate-300">—</span>
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>
  if (typeof value === 'object') {
    return (
      <pre className="overflow-x-auto rounded-lg bg-slate-50 p-2.5 font-mono text-[11.5px] text-slate-600">
        {JSON.stringify(value, null, 2)}
      </pre>
    )
  }
  return <span>{String(value)}</span>
}
`

export const UI_OVERLAY = `import { useEffect, type ReactNode } from 'react'
import { Button, renderAction, type ActionLike } from './primitives'

/** A centred modal. Closes on Escape and on backdrop click. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ActionLike | ActionLike[]
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Stop the page behind the dialog from scrolling.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl ring-1 ring-slate-200"
      >
        <h2 className="text-lg font-bold text-slate-900">{title}</h2>
        {description && <p className="mt-1.5 text-sm text-slate-500">{description}</p>}
        {children && <div className="mt-5">{children}</div>}
        {footer && (
          <div className="mt-6 flex justify-end gap-2">
            {Array.isArray(footer) ? footer.map(renderAction) : renderAction(footer)}
          </div>
        )}
      </div>
    </div>
  )
}

/** Confirmation for a destructive action. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  loading,
  danger = true,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: ReactNode
  description?: ReactNode
  confirmLabel?: string
  loading?: boolean
  danger?: boolean
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  )
}
`

export const UI_INDEX = `export { cn } from './cn'
export * from './primitives'
export * from './feedback'
export * from './data'
export * from './overlay'
`

/**
 * The kit summary handed to the model at generation time. Keeping this in sync
 * with the files above is what stops screens importing things that do not exist.
 */
export const UI_KIT_REFERENCE_INTRO = `Import everything from '../components/ui':

LAYOUT & TEXT
  <PageHeader title eyebrow? description? actions? />
      eyebrow is the small tinted line above the title — use it for "Step 02 / 05".
  <Card className?>  <CardHeader title subtitle? action? />  <CardBody className?>
  <Hero eyebrow? headline sub? icon? />   the tinted gradient band that opens a
      screen. It goes INSIDE a <Card>, as the first child, before <CardBody>.
      Decoration and orientation only — never put data in it.
  <SplitPage aside={...}>{main}</SplitPage>
      main column with a sticky summary column beside it, stacking on narrow
      screens. Put <SummaryPanel> in aside.
  <Note tone?="accent|info|success|warning|danger" icon?>{text}</Note>
      the tinted box for a caveat, a reassurance, or what happens next.
  cn(...classes)                      merge Tailwind classes

ACTIONS
  <Button variant="primary|soft|outline|ghost|danger" size="sm|md|lg" loading? disabled? onClick>

FORMS
  <FormGrid>                            the container EVERY group of fields goes
                                        in. Six columns, so one row can hold two
                                        halves, three thirds, or a mix.
  <Field label span? hint? error? required?>   wraps one control
      span="full"      the whole row      — addresses, descriptions, long names
      span="twoThirds" two thirds of a row
      span="half"      half a row         — the default, two fields side by side
      span="third"     a third of a row   — short numbers, dates, currencies
      Inside <FormGrid> the grid owns the spacing; do not add gap-* or space-y-*.
  <Actions align?="left|right|between">  the row of buttons that closes a form or
                                        card; it provides the separation above
  <Input />  <Textarea />  <Select><option/></Select>

DATA
  <DataTable rows={T[]|undefined} columns={Column<T>[]} loading? error? onRetry? onRowClick? getRowKey? empty={{title,description?,action?}} />
      Column<T> = { header: ReactNode; cell: (row: T, i: number) => ReactNode; className?: string; width?: string }
      DataTable renders its own loading, error and empty states — do not wrap it in your own.
  <Stat label value hint? icon? />
  <DetailList items={{ label, value }[]} />
  <SummaryPanel title headline? items={{ label, value? }[]} footer? />
      the dark panel that runs beside a form. A row whose value is undefined
      renders a dash by itself — that is what it is for, so pass the value
      straight through and never substitute a placeholder to fill a row.
  <Value value={unknown} />           safely renders any value, including objects

STATUS & FEEDBACK
  <Badge tone="neutral|accent|success|warning|danger|info">
  <StatusBadge status={string} />     picks a tone from the status text
  <Spinner />  <Skeleton className />  <TableSkeleton rows? columns? />
  <EmptyState title description? action? icon? />
  <ErrorState error onRetry? />
  <FormError error title? />          under a form's <Actions>: why the submit failed, in the
                                        API's own words. Renders nothing while error is unset.
  useToast() -> { push(message, 'success'|'error'|'info') }

OVERLAYS
  <Dialog open onClose title description? footer?>{children}</Dialog>
  <ConfirmDialog open onClose onConfirm title description? confirmLabel? loading? danger? />

ICONS
  lucide-react is available: import { Search, Plus, ... } from 'lucide-react'

STYLING
  Tailwind utility classes. The theme is built from one accent colour, and these
  tokens are derived from it. Prefer them over slate-*, so the app reads as
  tinted rather than grey:
      accent        the colour itself     bg-accent, text-accent, ring-accent
      accent-soft   a light wash of it    bg-accent-soft
      accent-tint   a very light wash     bg-accent-tint
      accent-deep   a dark version        bg-accent-deep (white text on it)
      line          the hairline border   ring-line, border-line
      canvas        the page background   already applied to <body>
  Text stays slate-900 / slate-600 / slate-500, on white cards over the canvas.`

/**
 * The full reference handed to the model, with an exact prop list per
 * component generated from COMPONENT_PROPS so the prompt and the validator can
 * never disagree about what is allowed.
 */
/**
 * The full reference handed to the model, with an exact prop list per component
 * generated from COMPONENT_PROPS — so the prompt and the validator can never
 * disagree about what is allowed.
 *
 * A function rather than a const: COMPONENT_PROPS is declared further down this
 * module, and a top-level const would read it before initialisation.
 */
export function uiKitReference(): string {
  return `${UI_KIT_REFERENCE_INTRO}

EXACT PROPS — these components accept NO other props. Adding one that is not
listed here will not compile, so check this table before writing a tag.
${componentPropsReference()}`
}

/**
 * The exact props each kit component accepts.
 *
 * Generated screens are validated against this, because a model that invents
 * `icon` or `className` on a component that has no such prop produces code that
 * parses fine and fails to compile. Syntax checking cannot see it; this can.
 *
 * Keep in sync with the component definitions above — the prompt reference is
 * generated from this table, so the two can never drift apart.
 */
export const COMPONENT_PROPS: Record<string, string[]> = {
  Button: ['variant', 'size', 'loading', 'icon', 'disabled', 'onClick', 'type', 'children'],
  Card: ['className', 'children'],
  CardHeader: ['title', 'subtitle', 'action', 'className'],
  CardBody: ['className', 'children'],
  Input: ['icon', 'value', 'defaultValue', 'onChange', 'placeholder', 'type', 'disabled', 'required', 'name', 'min', 'max', 'step', 'autoFocus', 'readOnly', 'className'],
  Textarea: ['value', 'defaultValue', 'onChange', 'placeholder', 'disabled', 'required', 'name', 'rows', 'className'],
  Select: ['value', 'defaultValue', 'onChange', 'disabled', 'required', 'name', 'children', 'className'],
  Field: ['label', 'hint', 'error', 'required', 'span', 'children', 'className'],
  FormGrid: ['className', 'children'],
  Hero: ['eyebrow', 'headline', 'sub', 'icon', 'className'],
  SplitPage: ['aside', 'className', 'children'],
  Note: ['tone', 'icon', 'className', 'children'],
  SummaryPanel: ['title', 'headline', 'items', 'footer', 'className'],
  Actions: ['align', 'className', 'children'],
  Badge: ['tone', 'children', 'className'],
  StatusBadge: ['status'],
  PageHeader: ['title', 'eyebrow', 'description', 'actions', 'className'],
  Spinner: ['className'],
  Skeleton: ['className'],
  TableSkeleton: ['rows', 'columns'],
  EmptyState: ['title', 'description', 'action', 'icon'],
  ErrorState: ['error', 'onRetry'],
  FormError: ['error', 'title'],
  DataTable: ['rows', 'columns', 'loading', 'error', 'onRetry', 'onRowClick', 'empty', 'getRowKey'],
  Stat: ['label', 'value', 'hint', 'icon'],
  DetailList: ['items'],
  Value: ['value'],
  Dialog: ['open', 'onClose', 'title', 'description', 'children', 'footer'],
  ConfirmDialog: ['open', 'onClose', 'onConfirm', 'title', 'description', 'confirmLabel', 'loading', 'danger'],
}

/** Props React itself handles, valid on any component. */
export const UNIVERSAL_PROPS = new Set(['key', 'ref'])

/** Renders the prop table into the exact form the codegen prompt shows. */
export function componentPropsReference(): string {
  return Object.entries(COMPONENT_PROPS)
    .map(([name, props]) => `  <${name} ${props.join(' ')} />`)
    .join('\n')
}
