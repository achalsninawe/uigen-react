import { useState } from 'react'
import { FlaskConical, Info, Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EndpointCard } from '@/components/EndpointCard'
import { EndpointEditor } from '@/components/EndpointEditor'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { AppSpec, Endpoint, Project } from '@/lib/types'

/** A function name for an endpoint someone added by hand, e.g. `getPoliciesById`. */
function operationIdFor(endpoint: Endpoint, taken: Set<string>): string {
  const words = endpoint.path
    .split(/[/{}:_\-.]+/)
    .filter(Boolean)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean)
  const base =
    endpoint.method.toLowerCase() + words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('') || 'callApi'
  let name = /^[A-Za-z]/.test(base) ? base : `call${base}`
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`
  return name
}

/*
 * Same rule the server tests by, in server/src/services/pipeline/testApis.ts:
 * flow APIs read through POST, so a POST named like a read counts as one.
 */
const READ_WORDS = /query|search|get|list|find|fetch|retriev|lookup|inquir|enquir|view|quot|calc|preview|estimat|validat|check|trial/i
const WRITE_WORDS = /create|save|execut|submit|updat|delet|remov|regist|issue|cancel|pay|approv|reject|insert|confirm|terminat/i

function isWrite(endpoint: Endpoint): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(endpoint.method)) return false
  if (endpoint.method !== 'POST') return true
  const words = `${endpoint.name} ${endpoint.path} ${endpoint.summary ?? ''}`
  return !(READ_WORDS.test(words) && !WRITE_WORDS.test(words))
}

/** One line on what a test run did, so a run that called nothing says so. */
function summarise(endpoints: Endpoint[]): { tone: 'mint' | 'rose' | 'amber'; text: string } {
  const tests = endpoints.map((e) => e.lastTest).filter((t) => t !== undefined)
  const pass = tests.filter((t) => t.state === 'pass').length
  const fail = tests.filter((t) => t.state === 'fail').length
  const skipped = tests.filter((t) => t.state === 'skipped')
  if (pass + fail === 0) {
    // Nothing was called; the most common reason is the one worth fixing first.
    const reasons = new Map<string, number>()
    for (const t of skipped) reasons.set(t.message, (reasons.get(t.message) ?? 0) + 1)
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    return { tone: 'amber', text: `No API was called. ${top ?? ''}` }
  }
  const parts = [`${pass} worked`, ...(fail ? [`${fail} failed`] : []), ...(skipped.length ? [`${skipped.length} not called`] : [])]
  return {
    tone: fail ? 'rose' : 'mint',
    text: `${parts.join(', ')}. Open a card to see why${pass ? '; working APIs taught the app their real response shape' : ''}.`,
  }
}

const blankEndpoint = (): Endpoint => ({
  id: `manual-${Date.now().toString(36)}`,
  operationId: '',
  name: '',
  method: 'GET',
  path: '/',
  baseUrl: '',
  tags: [],
  auth: { type: 'none' },
  headers: [],
  pathParams: [],
  queryParams: [],
  responses: [],
  edited: true,
})

/**
 * The extracted APIs, with the tools to check and correct them before any
 * screen is written against them: test them for real, edit what the analysis
 * got wrong, add what it missed, remove what it invented.
 */
export function EndpointsSection({
  projectId,
  appSpec,
  endpoints,
  busy,
  appIsStale,
  onProject,
}: {
  projectId: string
  appSpec: AppSpec | undefined
  endpoints: Endpoint[]
  /** True while the pipeline is running; the list must not change under it. */
  busy: boolean
  /** True when the APIs changed after the app was built. */
  appIsStale: boolean
  onProject: (project: Project) => void
}) {
  const [testing, setTesting] = useState(false)
  const [includeWrites, setIncludeWrites] = useState(false)
  const [draft, setDraft] = useState<Endpoint | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<ReturnType<typeof summarise> | null>(null)

  const counts = { pass: 0, fail: 0, skipped: 0 }
  for (const e of endpoints) if (e.lastTest) counts[e.lastTest.state]++
  const writes = endpoints.filter(isWrite).length

  async function saveAll(next: Endpoint[], extra: Partial<AppSpec> = {}) {
    if (!appSpec) return
    const project = await api.saveAppSpec(projectId, { ...appSpec, ...extra, endpoints: next })
    onProject(project)
  }

  /** Swaps an endpoint with its neighbour; from then on Test all follows this order. */
  async function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= endpoints.length) return
    const next = [...endpoints]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    setError(null)
    try {
      await saveAll(next, { callOrder: 'manual' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reorder')
    }
  }

  async function testAll() {
    setTesting(true)
    setError(null)
    setSummary(null)
    try {
      const project = await api.testAllEndpoints(projectId, includeWrites)
      onProject(project)
      setSummary(summarise(project.appSpec?.endpoints ?? []))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Testing failed')
    } finally {
      setTesting(false)
    }
  }

  if (!appSpec && endpoints.length === 0) return null

  return (
    <section className="mb-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[15px] font-bold text-ink">
            Endpoints <span className="ml-1 text-muted">{endpoints.length}</span>
          </h2>
          {counts.pass + counts.fail + counts.skipped > 0 && (
            <span className="flex gap-1.5">
              {counts.pass > 0 && <Badge tone="mint">{counts.pass} work</Badge>}
              {counts.fail > 0 && <Badge tone="rose">{counts.fail} failed</Badge>}
              {counts.skipped > 0 && <Badge tone="neutral">{counts.skipped} not called</Badge>}
            </span>
          )}
        </div>

        {appSpec && !busy && (
          <div className="flex flex-wrap items-center gap-2">
            {writes > 0 && (
              <label
                className="flex items-center gap-1.5 text-[12px] text-muted"
                title={`Calls that create or change records: ${endpoints.filter(isWrite).map((e) => e.name || e.operationId).join(', ')}`}
              >
                <input
                  type="checkbox"
                  checked={includeWrites}
                  onChange={(e) => setIncludeWrites(e.target.checked)}
                  className="accent-primary"
                />
                Include {writes} write call{writes === 1 ? '' : 's'}
              </label>
            )}
            <Button size="sm" variant="soft" onClick={() => void testAll()} loading={testing} disabled={endpoints.length === 0}>
              <FlaskConical className="size-3.5" />
              {testing ? 'Testing…' : 'Test all APIs'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDraft(blankEndpoint())} disabled={Boolean(draft) || testing}>
              <Plus className="size-3.5" />
              Add API
            </Button>
          </div>
        )}
      </div>

      {error && <p className="mb-3 text-[12.5px] text-rose">{error}</p>}

      {endpoints.length > 1 && appSpec && (
        <p className="mb-2 text-[12px] text-muted">
          {appSpec.callOrder === 'manual'
            ? 'Test all calls these in the order shown. Use the arrows to change it.'
            : 'Use the arrows to set the calling order. Until you do, Test all runs reads first, then writes.'}
        </p>
      )}

      {summary && !testing && (
        <div
          className={cn(
            'mb-3 rounded-xl px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink-soft',
            summary.tone === 'mint' ? 'bg-mint-soft' : summary.tone === 'rose' ? 'bg-rose-soft' : 'bg-amber-soft',
          )}
        >
          {summary.text}
        </div>
      )}

      {appIsStale && (
        <div className="mb-3 flex items-start gap-2 rounded-xl bg-sky-soft px-3.5 py-2.5 text-[12.5px] text-ink-soft">
          <Info className="mt-0.5 size-3.5 shrink-0 text-sky" />
          The APIs changed after the app was built. Regenerate the app to use the changes.
        </div>
      )}

      <div className="space-y-2">
        {draft && (
          <div className="rounded-2xl bg-surface p-3 ring-1 ring-primary-ring">
            <p className="mb-2 px-1 text-[13px] font-semibold text-ink">New API</p>
            <EndpointEditor
              endpoint={draft}
              onCancel={() => setDraft(null)}
              onSave={async (next) => {
                const taken = new Set(endpoints.map((e) => e.operationId))
                const operationId = operationIdFor(next, taken)
                await saveAll([...endpoints, { ...next, operationId, name: next.summary || operationId }])
                setDraft(null)
              }}
            />
          </div>
        )}

        {endpoints.map((endpoint, i) => (
          <EndpointCard
            key={endpoint.id}
            endpoint={endpoint}
            index={i}
            projectId={projectId}
            onTested={onProject}
            onSave={(next) => saveAll(endpoints.map((e) => (e.id === next.id ? next : e)))}
            onRemove={() => saveAll(endpoints.filter((e) => e.id !== endpoint.id))}
            {...(appSpec && !busy && !testing
              ? { onMove: (d: -1 | 1) => void move(i, d), canMoveUp: i > 0, canMoveDown: i < endpoints.length - 1 }
              : {})}
          />
        ))}
      </div>
    </section>
  )
}
