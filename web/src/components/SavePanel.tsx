import { useState } from 'react'
import { Check, Save } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'

/**
 * Keeping a generated app, deliberately.
 *
 * Uploading and generating already write to storage — a run takes minutes and
 * losing it would be worse than the alternative — but that is bookkeeping, not
 * a decision. Nothing reaches "Your projects" until someone names it and presses
 * this, so the list stays the things they meant to keep rather than every
 * experiment they ever ran.
 */
export function SavePanel({
  name,
  savedAt,
  onSave,
}: {
  name: string
  savedAt?: string
  onSave: (name: string) => Promise<void>
}) {
  const [draft, setDraft] = useState(name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)

  const dirty = draft.trim() !== name.trim()

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const wanted = draft.trim()
    if (!wanted) {
      setError('Give the project a name')
      return
    }

    setBusy(true)
    setError(null)
    try {
      await onSave(wanted)
      setJustSaved(true)
      // Long enough to register, short enough not to look stuck.
      window.setTimeout(() => setJustSaved(false), 2400)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mt-5">
      <form onSubmit={submit} className="p-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1">
            <span className="mb-1.5 block text-[12px] font-semibold text-ink">Save this app as</span>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={busy}
              maxLength={120}
              placeholder="Freelook"
              className="h-10 w-full rounded-xl bg-white px-3.5 text-sm text-ink ring-1 ring-line transition-shadow placeholder:text-faint focus:ring-2 focus:ring-primary focus:outline-none disabled:bg-surface"
            />
          </label>

          <Button type="submit" loading={busy}>
            {!busy &&
              (justSaved ? <Check className="size-4" /> : <Save className="size-4" />)}
            {justSaved ? 'Saved' : savedAt && !dirty ? 'Save again' : 'Save'}
          </Button>
        </div>

        {error ? (
          <p className="mt-3 text-[12.5px] font-medium text-rose">{error}</p>
        ) : (
          <p className="mt-3 text-[12px] text-muted">
            {savedAt
              ? `Saved ${new Date(savedAt).toLocaleString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}`
              : 'Not saved yet — it will not appear in Your projects until you do.'}
          </p>
        )}
      </form>
    </Card>
  )
}
