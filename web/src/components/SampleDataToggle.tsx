import { cn } from '@/lib/cn'

/**
 * Whether screens no API can feed may show sample (or browser-kept) data.
 *
 * Off is the default and means API-only: every value on screen comes from a
 * real call, and a screen with no API says so rather than looking finished.
 */
export function SampleDataToggle({
  checked,
  onChange,
  disabled,
  className,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  className?: string
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-2xl bg-surface px-4 py-3 ring-1 ring-line',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors duration-200',
          checked ? 'bg-primary' : 'bg-canvas-deep ring-1 ring-line',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform duration-200',
            checked && 'translate-x-4',
          )}
        />
      </button>
      <span className="min-w-0 text-left">
        <span className="block text-[13px] font-semibold text-ink">
          {checked ? 'Sample data allowed' : 'API only'}
        </span>
        <span className="block text-[12px] text-muted">
          {checked
            ? 'Screens with no API show labelled sample data, or keep their own data in the browser when no API is documented.'
            : 'Every value comes from a real API call. A screen with no API says so instead of showing invented data.'}
        </span>
      </span>
    </label>
  )
}
