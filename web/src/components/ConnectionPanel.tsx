import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, KeyRound, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { Field, Input } from '@/components/ui/Input'
import type { ConnectionSettings } from '@/lib/types'

/**
 * Where the preview points and what credential it sends.
 *
 * These values never reach the generated page — the proxy applies them
 * server-side, so a token pasted here is not sitting in browser JavaScript.
 */
export function ConnectionPanel({
  connection,
  documentedServers,
  authHint,
  onSave,
}: {
  connection: ConnectionSettings
  documentedServers: string[]
  authHint?: string
  onSave: (next: ConnectionSettings) => Promise<void>
}) {
  const [baseUrl, setBaseUrl] = useState(connection.baseUrlOverride ?? '')
  const [authValue, setAuthValue] = useState(connection.authValue ?? '')
  const [headers, setHeaders] = useState<[string, string][]>(Object.entries(connection.extraHeaders ?? {}))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function save() {
    setSaving(true)
    setSaved(false)
    try {
      await onSave({
        baseUrlOverride: baseUrl.trim(),
        authValue: authValue.trim(),
        extraHeaders: Object.fromEntries(headers.filter(([k]) => k.trim())),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2200)
    } finally {
      setSaving(false)
    }
  }

  const documented = documentedServers[0]

  return (
    <Card>
      <CardHeader
        icon={<KeyRound className="size-4" />}
        title="Connection"
        subtitle="Applied by the proxy — credentials never reach the previewed page"
      />

      <div className="space-y-4 px-5 pb-5">
        <Field
          label="Base URL"
          hint={documented ? `From your spec: ${documented}` : 'Your documents did not state one'}
        >
          {/*
            A text input followed by a password input is what a sign-in form
            looks like, so browsers offered this one the account saved for the
            API's own domain — filling the person's email in as the base URL and
            their password as the token. The names are deliberately not
            "username"/"password", the credential asks for `new-password` (the
            one value Chrome honours by not autofilling; it ignores "off" here),
            and the data- attributes opt out of 1Password and LastPass.
          */}
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={documented || 'https://api.example.com'}
            spellCheck={false}
            name="spec2ui-base-url"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
          />
        </Field>

        <Field label="Credential" hint={authHint ?? 'Sent using the scheme your spec describes'}>
          <Input
            type="password"
            value={authValue}
            onChange={(e) => setAuthValue(e.target.value)}
            placeholder="token or API key"
            spellCheck={false}
            name="spec2ui-credential"
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
          />
        </Field>

        <div>
          <span className="mb-1.5 block text-[12px] font-semibold text-ink-soft">Extra headers</span>
          <AnimatePresence initial={false}>
            {headers.map(([name, value], i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mb-2 flex gap-2"
              >
                <Input
                  value={name}
                  placeholder="Header"
                  spellCheck={false}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  onChange={(e) =>
                    setHeaders((prev) => prev.map((h, j) => (j === i ? [e.target.value, h[1]] : h)))
                  }
                  className="flex-1"
                />
                <Input
                  value={value}
                  placeholder="Value"
                  spellCheck={false}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  onChange={(e) =>
                    setHeaders((prev) => prev.map((h, j) => (j === i ? [h[0], e.target.value] : h)))
                  }
                  className="flex-1"
                />
                <button
                  type="button"
                  aria-label="Remove header"
                  onClick={() => setHeaders((prev) => prev.filter((_, j) => j !== i))}
                  className="grid size-10 shrink-0 place-items-center rounded-xl text-faint transition-colors hover:bg-rose-soft hover:text-rose"
                >
                  <Trash2 className="size-4" />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>

          <button
            type="button"
            onClick={() => setHeaders((prev) => [...prev, ['', '']])}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-primary transition-opacity hover:opacity-75"
          >
            <Plus className="size-3.5" />
            Add header
          </button>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button onClick={() => void save()} loading={saving} size="sm">
            Save
          </Button>
          <AnimatePresence>
            {saved && (
              <motion.span
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-mint"
              >
                <Check className="size-3.5" />
                Saved
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
    </Card>
  )
}
