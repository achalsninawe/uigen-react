import { useRef, useState } from 'react'
import { Palette, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { BrandTheme } from '@/lib/types'
import { cn } from '@/lib/cn'

/** File types a brand is usually described in. Anything text-like is read too. */
const ACCEPT = '.css,.scss,.sass,.less,.md,.markdown,.txt,.json,.yaml,.yml,.html,.htm,.pdf,.docx'

/**
 * Uploads style files — a stylesheet, design tokens, a brand guide — and reads
 * the theme out of them. The theme applies on the next generate.
 */
export function ThemeUploadButton({
  hasTheme,
  onUpload,
  disabled,
}: {
  hasTheme: boolean
  onUpload: (files: File[]) => Promise<void>
  disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length === 0) return
          setBusy(true)
          setError(null)
          try {
            await onUpload(files)
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not read the theme')
          } finally {
            setBusy(false)
          }
        }}
      />
      <Button
        size="lg"
        variant="outline"
        loading={busy}
        disabled={disabled}
        onClick={() => input.current?.click()}
        title="CSS, SCSS, design tokens, Markdown or text brand guide, HTML, PDF, DOCX"
      >
        <Palette className="size-4" />
        {busy ? 'Reading theme…' : hasTheme ? 'Replace theme' : 'Upload theme'}
      </Button>
      {error && <p className="w-full text-[12.5px] font-medium text-rose">{error}</p>}
    </>
  )
}

function Swatch({ label, color }: { label: string; color?: string }) {
  if (!color) return null
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2 py-1 text-[11.5px] font-medium text-ink-soft ring-1 ring-line">
      <span className="size-3.5 rounded-full ring-1 ring-black/10" style={{ background: color }} />
      {label}
      <code className="font-mono text-[10.5px] text-faint">{color}</code>
    </span>
  )
}

/** What was read from the uploaded theme, so a wrong reading is caught before generating. */
export function ThemePanel({
  theme,
  onRemove,
  disabled,
  className,
}: {
  theme: BrandTheme
  onRemove: () => Promise<void>
  disabled?: boolean
  className?: string
}) {
  const [removing, setRemoving] = useState(false)
  const { colors, font, radius, notes } = theme
  const type = [
    font?.body && `Body ${font.body}`,
    font?.heading && `Headings ${font.heading}`,
    font?.baseSize && `${font.baseSize}px base`,
    radius !== undefined && `${radius}px corners`,
  ].filter(Boolean)

  return (
    <div className={cn('rounded-2xl bg-surface px-4 py-3 ring-1 ring-line', disabled && 'opacity-60', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[13px] font-semibold text-ink">Brand theme</span>
          <span className="ml-2 text-[12px] text-muted">from {theme.sources.join(', ')} · applies on the next generate</span>
        </div>
        <button
          type="button"
          title="Remove theme"
          disabled={disabled || removing}
          onClick={async () => {
            setRemoving(true)
            try {
              await onRemove()
            } finally {
              setRemoving(false)
            }
          }}
          className="rounded-lg p-1 text-faint transition-colors hover:bg-canvas-deep hover:text-ink"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Swatch label="Primary" color={colors.primary} />
        <Swatch label="Background" color={colors.background} />
        <Swatch label="Text" color={colors.text} />
        <Swatch label="Muted" color={colors.muted} />
        <Swatch label="Border" color={colors.border} />
        <Swatch label="Danger" color={colors.danger} />
        <Swatch label="Success" color={colors.success} />
      </div>

      {type.length > 0 && <p className="mt-2 text-[12px] text-ink-soft">{type.join(' · ')}</p>}
      {notes.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[12px] text-muted">
          {notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
