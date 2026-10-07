import { cn } from '@/lib/cn'

export type Generator = 'classic' | 'ai'

const OPTIONS: { value: Generator; label: string; hint: string }[] = [
  { value: 'classic', label: 'Classic', hint: 'The step-by-step pipeline.' },
  {
    value: 'ai',
    label: 'AI builder',
    hint: 'The AI reads your docs and real API responses, then designs and builds the whole app.',
  },
]

/** Which generator builds the app. Applies on the next generate. */
export function GeneratorToggle({
  value,
  onChange,
  disabled,
  className,
}: {
  value: Generator
  onChange: (next: Generator) => void
  disabled?: boolean
  className?: string
}) {
  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0]!
  return (
    <div className={cn('rounded-2xl bg-surface px-4 py-3 ring-1 ring-line', disabled && 'opacity-60', className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-semibold text-ink">Generator</span>
        <div role="radiogroup" aria-label="Generator" className="flex rounded-xl bg-canvas-deep p-0.5">
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={value === option.value}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={cn(
                'rounded-[10px] px-3 py-1 text-[12.5px] font-semibold transition-colors',
                value === option.value ? 'bg-white text-primary shadow-sm' : 'text-muted hover:text-ink',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-[12px] text-muted">{current.hint}</p>
    </div>
  )
}
