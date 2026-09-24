import { useState } from 'react'
import { BookOpen, Check, Copy, Download, Globe, Server } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'

type Target = 'bff' | 'direct'

interface Step {
  /** The command to run, when the step is one. */
  cmd?: string
  /** What it does, or what to do by hand when there is no command. */
  note: string
}

const options: {
  key: Target
  label: string
  Icon: typeof Server
  summary: string
  detail: string
  steps: Step[]
  readme: string
}[] = [
  {
    key: 'bff',
    label: 'With its own server',
    Icon: Server,
    summary: 'Runs anywhere Node runs',
    detail:
      'The ZIP includes a small server that serves the app and forwards its calls. One origin, so no CORS, and the credential lives in the server’s environment instead of the page. Emitted from the same endpoint list as the API client.',
    steps: [
      { note: 'Unzip it and open the folder in a terminal' },
      { cmd: 'npm install', note: 'once' },
      { cmd: 'cp .env.example .env', note: 'then put your token in API_AUTH_VALUE' },
      { cmd: 'npm run build', note: 'produces dist/' },
      { cmd: 'npm start', note: 'serves the app and its API on localhost:8080' },
    ],
    readme:
      'README.md in the ZIP lists every setting, every endpoint the server will forward, and how to deploy it.',
  },
  {
    key: 'direct',
    label: 'Static files only',
    Icon: Globe,
    summary: 'Any static host',
    detail:
      'The page calls the documented host itself. That only works where the API sends CORS headers for your origin, and any credential has to sit in the page — so keep this for public or open APIs.',
    steps: [
      { note: 'Unzip it and open the folder in a terminal' },
      { cmd: 'npm install', note: 'once' },
      { note: 'Set authValue in src/lib/config.ts if the API needs a credential' },
      { cmd: 'npm run dev', note: 'opens on localhost:5173' },
      { cmd: 'npm run build', note: 'when you are ready to host dist/ anywhere' },
    ],
    readme: 'README.md in the ZIP lists every setting and every endpoint the app calls.',
  },
]

/**
 * Taking the app away.
 *
 * The choice here is not a preference, it is whether the exported app can
 * reach its API at all: a page on a static host cannot call an API that does
 * not publish CORS headers for it, which most real ones do not. So the two
 * targets are described by what they can reach rather than by their shape, and
 * the server build is the default.
 *
 * The steps are shown before the download rather than after it. What someone
 * needs to know is whether they are about to receive something they can run —
 * finding that out from a README after unzipping is finding out too late.
 */
export function ExportPanel({ projectId, hasEndpoints }: { projectId: string; hasEndpoints: boolean }) {
  const [target, setTarget] = useState<Target>('bff')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const chosen = options.find((o) => o.key === (hasEndpoints ? target : 'direct'))!

  async function download() {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const { name, bytes } = await api.exportApp(projectId, chosen.key)
      setDone(`${name} · ${Math.max(1, Math.round(bytes / 1024))} KB`)
      window.setTimeout(() => setDone(null), 8000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export')
    } finally {
      setBusy(false)
    }
  }

  async function copySteps() {
    const commands = chosen.steps.filter((s) => s.cmd).map((s) => s.cmd!)
    try {
      await navigator.clipboard.writeText(commands.join('\n'))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2200)
    } catch {
      // A blocked clipboard is not worth an error message; the commands are
      // on screen and selectable.
    }
  }

  return (
    <Card className="mt-5">
      <CardHeader
        icon={<Download className="size-4" />}
        title="Export"
        subtitle={
          hasEndpoints
            ? 'A ZIP of the whole app — yours to run, commit and deploy'
            : 'A ZIP of the whole app. This one documents no endpoints, so it makes no API calls and needs no server.'
        }
      />

      <div className="px-5 pb-5">
        {hasEndpoints && (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              {options.map(({ key, label, Icon, summary }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTarget(key)}
                  aria-pressed={target === key}
                  className={cn(
                    'rounded-xl px-3.5 py-3 text-left transition-all duration-150',
                    target === key
                      ? 'bg-primary-soft ring-2 ring-primary'
                      : 'bg-canvas ring-1 ring-line hover:ring-primary-ring',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <Icon className={cn('size-3.5 shrink-0', target === key ? 'text-primary' : 'text-faint')} />
                    <span
                      className={cn(
                        'text-[13px] font-semibold',
                        target === key ? 'text-primary' : 'text-ink',
                      )}
                    >
                      {label}
                    </span>
                  </span>
                  <span className="mt-1 block text-[11.5px] text-muted">{summary}</span>
                </button>
              ))}
            </div>

            <p className="mt-3 text-[12px] leading-relaxed text-muted">{chosen.detail}</p>
          </>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => void download()} loading={busy}>
            {!busy && (done ? <Check className="size-4" /> : <Download className="size-4" />)}
            {busy ? 'Packing' : 'Download ZIP'}
          </Button>

          {done && <span className="text-[12.5px] font-medium text-mint">{done}</span>}
          {error && <span className="text-[12.5px] font-medium text-rose">{error}</span>}
        </div>

        {/* Running it */}
        <div className="mt-4 rounded-xl bg-canvas px-4 py-3.5 ring-1 ring-line-soft">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <span className="text-[12px] font-semibold text-ink">Once it downloads</span>
            <button
              type="button"
              onClick={() => void copySteps()}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] font-semibold text-muted transition-colors hover:bg-surface hover:text-ink"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? 'Copied' : 'Copy commands'}
            </button>
          </div>

          <ol className="space-y-1.5">
            {chosen.steps.map((step, i) => (
              <li key={i} className="flex items-baseline gap-2.5">
                <span className="grid size-[17px] shrink-0 translate-y-0.5 place-items-center rounded-full bg-primary-soft text-[9.5px] font-bold text-primary">
                  {i + 1}
                </span>
                <span className="min-w-0 text-[12px] leading-relaxed">
                  {step.cmd ? (
                    <>
                      <code className="font-mono text-[11.5px] font-semibold text-ink">{step.cmd}</code>
                      <span className="text-muted"> — {step.note}</span>
                    </>
                  ) : (
                    <span className="text-muted">{step.note}</span>
                  )}
                </span>
              </li>
            ))}
          </ol>

          <p className="mt-3 flex items-start gap-2 border-t border-line-soft pt-2.5 text-[11.5px] leading-relaxed text-faint">
            <BookOpen className="size-3.5 shrink-0 translate-y-px" />
            <span>{chosen.readme}</span>
          </p>
        </div>
      </div>
    </Card>
  )
}
