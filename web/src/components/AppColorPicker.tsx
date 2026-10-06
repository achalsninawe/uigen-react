import { useRef, useState } from 'react'
import { Check, Palette, Type } from 'lucide-react'
import { cn } from '@/lib/cn'

const SWATCHES: { name: string; hex: string }[] = [
  { name: 'Blue', hex: '#2563EB' },
  { name: 'Sky', hex: '#0EA5E9' },
  { name: 'Indigo', hex: '#4F46E5' },
  { name: 'Purple', hex: '#7C3AED' },
  { name: 'Teal', hex: '#0D9488' },
  { name: 'Green', hex: '#16A34A' },
  { name: 'Orange', hex: '#EA580C' },
  { name: 'Rose', hex: '#E11D48' },
  { name: 'Slate', hex: '#475569' },
]

/**
 * The app's colour, changed in place.
 *
 * Every colour in a generated app is mixed from one accent token, so this
 * recolours buttons, headers, washes and lines on every screen at once —
 * which no edit to a single screen can do.
 */
export function AppColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: string | undefined
  onChange: (hex: string) => Promise<void>
  disabled?: boolean
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = value?.toUpperCase()
  // The native picker reports every step of a drag; only where it settles is saved.
  const settle = useRef<number | undefined>(undefined)

  async function pick(hex: string) {
    setBusy(hex)
    setError(null)
    try {
      await onChange(hex.toUpperCase())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the colour')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="border-t border-line-soft px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-soft">
          <Palette className="size-3.5 text-faint" /> App color
        </span>
        {SWATCHES.map((s) => (
          <button
            key={s.hex}
            type="button"
            title={s.name}
            disabled={disabled || busy !== null}
            onClick={() => void pick(s.hex)}
            className={cn(
              'grid size-6 place-items-center rounded-full ring-2 ring-offset-2 ring-offset-white transition-transform hover:scale-110 disabled:opacity-50',
              current === s.hex ? 'ring-ink/40' : 'ring-transparent',
            )}
            style={{ background: s.hex }}
          >
            {current === s.hex && <Check className="size-3.5 text-white" />}
          </button>
        ))}
        <label
          title="Any colour"
          className="relative grid size-6 cursor-pointer place-items-center overflow-hidden rounded-full ring-1 ring-line"
          style={{ background: 'conic-gradient(#f43f5e,#f59e0b,#22c55e,#0ea5e9,#6366f1,#f43f5e)' }}
        >
          <input
            type="color"
            // Uncontrolled while dragging; re-keyed so a saved colour resyncs it.
            key={value}
            defaultValue={value ?? '#6C63FF'}
            disabled={disabled || busy !== null}
            onChange={(e) => {
              const hex = e.target.value
              window.clearTimeout(settle.current)
              settle.current = window.setTimeout(() => void pick(hex), 450)
            }}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
        {current && <code className="ml-1 font-mono text-[11.5px] text-muted">{current}</code>}
      </div>
      {error && <p className="mt-1.5 text-[12px] text-rose">{error}</p>}
    </div>
  )
}

const SIZES: { value: 'small' | 'default' | 'large'; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' },
]

/**
 * The app's text size, changed in place. Every size in the kit is relative to
 * one root size, so this scales all text on every screen together.
 */
export function TextSizePicker({
  value = 'default',
  onChange,
  disabled,
}: {
  value: 'small' | 'default' | 'large' | undefined
  onChange: (next: 'small' | 'default' | 'large') => Promise<void>
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function pick(next: 'small' | 'default' | 'large') {
    if (next === value) return
    setBusy(true)
    setError(null)
    try {
      await onChange(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the text size')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-t border-line-soft px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-soft">
          <Type className="size-3.5 text-faint" /> Text size
        </span>
        <div className="flex gap-1 rounded-lg bg-canvas-deep p-0.5">
          {SIZES.map((s) => (
            <button
              key={s.value}
              type="button"
              disabled={disabled || busy}
              onClick={() => void pick(s.value)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors disabled:opacity-60',
                value === s.value ? 'bg-white text-ink shadow-sm' : 'text-muted hover:text-ink',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="mt-1.5 text-[12px] text-rose">{error}</p>}
    </div>
  )
}
