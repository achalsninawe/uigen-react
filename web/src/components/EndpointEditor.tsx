import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'
import type { AuthSpec, Endpoint, ParamSpec } from '@/lib/types'

const METHODS: Endpoint['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const AUTH_TYPES: AuthSpec['type'][] = ['none', 'bearer', 'apiKey', 'basic', 'oauth2', 'custom']

const input =
  'h-8 w-full rounded-lg bg-surface px-2.5 font-mono text-[12px] ring-1 ring-line focus:ring-2 focus:ring-primary focus:outline-none'
const label = 'mb-1 block text-[11px] font-semibold text-ink-soft'

/** Path parameter names in a template, e.g. `/projects/{projectId}`. */
function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}|:([A-Za-z0-9_]+)/g)].map((m) => m[1] ?? m[2]!)
}

interface Row {
  name: string
  value: string
  required: boolean
}

const toRows = (params: ParamSpec[]): Row[] =>
  params.map((p) => ({ name: p.name, value: p.example ?? '', required: p.required }))

/** Rows back to params, keeping whatever the documents said about each one. */
function toParams(rows: Row[], previous: ParamSpec[], where: ParamSpec['in']): ParamSpec[] {
  return rows
    .filter((r) => r.name.trim())
    .map((r) => {
      const before = previous.find((p) => p.name === r.name.trim())
      return {
        ...(before ?? { type: 'string' }),
        name: r.name.trim(),
        in: where,
        required: r.required,
        ...(r.value.trim() ? { example: r.value.trim() } : { example: undefined }),
      }
    })
}

function RowsEditor({
  title,
  rows,
  onChange,
  valueHint,
}: {
  title: string
  rows: Row[]
  onChange: (rows: Row[]) => void
  valueHint: string
}) {
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10.5px] font-bold uppercase tracking-wider text-faint">{title}</span>
        <button
          type="button"
          onClick={() => onChange([...rows, { name: '', value: '', required: false }])}
          className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-primary hover:opacity-80"
        >
          <Plus className="size-3" /> Add
        </button>
      </div>
      {rows.length === 0 && <p className="text-[12px] text-faint">None</p>}
      <div className="space-y-1.5">
        {rows.map((row, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto_auto] items-center gap-1.5">
            <input
              value={row.name}
              onChange={(e) => set(i, { name: e.target.value })}
              placeholder="name"
              className={input}
            />
            <input
              value={row.value}
              onChange={(e) => set(i, { value: e.target.value })}
              placeholder={valueHint}
              className={input}
            />
            <label className="flex items-center gap-1 text-[11px] text-muted" title="Required">
              <input
                type="checkbox"
                checked={row.required}
                onChange={(e) => set(i, { required: e.target.checked })}
                className="accent-primary"
              />
              req
            </label>
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              className="grid size-7 place-items-center rounded-lg text-faint hover:bg-rose-soft hover:text-rose"
              title="Remove"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Corrects what the analysis extracted, before any code is written against it.
 *
 * The generated API client is emitted from these fields verbatim, so a wrong
 * path here is a wrong URL in every screen. The operation name is kept: screens
 * call the function by that name, and renaming it would break them silently.
 */
export function EndpointEditor({
  endpoint,
  onSave,
  onCancel,
}: {
  endpoint: Endpoint
  onSave: (next: Endpoint) => Promise<void>
  onCancel: () => void
}) {
  const [method, setMethod] = useState(endpoint.method)
  const [baseUrl, setBaseUrl] = useState(endpoint.baseUrl)
  const [path, setPath] = useState(endpoint.path)
  const [summary, setSummary] = useState(endpoint.summary ?? '')
  const [auth, setAuth] = useState<AuthSpec>(endpoint.auth)
  const [headers, setHeaders] = useState(() => toRows(endpoint.headers))
  const [query, setQuery] = useState(() => toRows(endpoint.queryParams))
  const [pathValues, setPathValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(endpoint.pathParams.map((p) => [p.name, p.example ?? ''])),
  )
  const [body, setBody] = useState(() =>
    endpoint.requestBody?.example !== undefined ? JSON.stringify(endpoint.requestBody.example, null, 2) : '',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const takesBody = !['GET', 'HEAD', 'DELETE'].includes(method)
  const names = pathParamNames(path)

  async function save() {
    setError(null)
    if (!path.trim().startsWith('/')) return setError('The path should start with /')

    let example: unknown
    if (takesBody && body.trim()) {
      try {
        example = JSON.parse(body)
      } catch {
        return setError('The example body is not valid JSON.')
      }
    }

    const next: Endpoint = {
      ...endpoint,
      method,
      baseUrl: baseUrl.trim(),
      path: path.trim(),
      ...(summary.trim() ? { summary: summary.trim() } : { summary: undefined }),
      auth,
      headers: toParams(headers, endpoint.headers, 'header'),
      queryParams: toParams(query, endpoint.queryParams, 'query'),
      // Derived from the path, so the two can never disagree.
      pathParams: names.map((name) => {
        const before = endpoint.pathParams.find((p) => p.name === name)
        const value = pathValues[name]?.trim()
        return {
          ...(before ?? { type: 'string' }),
          name,
          in: 'path' as const,
          required: true,
          ...(value ? { example: value } : { example: undefined }),
        }
      }),
      requestBody: takesBody
        ? {
            ...(endpoint.requestBody ?? { contentType: 'application/json' }),
            ...(example !== undefined ? { example } : { example: undefined }),
          }
        : undefined,
      methodAssumed: false,
      edited: true,
      // A test of the old definition says nothing about this one.
      lastTest: undefined,
    }

    setBusy(true)
    try {
      await onSave(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 rounded-xl bg-canvas-deep p-3.5">
      <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-2">
        <label>
          <span className={label}>Method</span>
          <select value={method} onChange={(e) => setMethod(e.target.value as Endpoint['method'])} className={input}>
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          <span className={label}>Path</span>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/v1/policies/{policyId}" className={input} />
        </label>
      </div>

      <label className="block">
        <span className={label}>Base URL</span>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com"
          className={input}
        />
      </label>

      <label className="block">
        <span className={label}>What it does</span>
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Search policies by number"
          className={cn(input, 'font-sans')}
        />
      </label>

      <div className="grid gap-2 sm:grid-cols-3">
        <label>
          <span className={label}>Auth</span>
          <select
            value={auth.type}
            onChange={(e) => setAuth({ ...auth, type: e.target.value as AuthSpec['type'] })}
            className={input}
          >
            {AUTH_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        {auth.type !== 'none' && (
          <>
            <label>
              <span className={label}>Sent as</span>
              <input
                value={auth.name ?? ''}
                onChange={(e) => setAuth({ ...auth, name: e.target.value || undefined })}
                placeholder="Authorization"
                className={input}
              />
            </label>
            <label>
              <span className={label}>Scheme</span>
              <input
                value={auth.scheme ?? ''}
                onChange={(e) => setAuth({ ...auth, scheme: e.target.value || undefined })}
                placeholder="Bearer"
                className={input}
              />
            </label>
          </>
        )}
      </div>

      {names.length > 0 && (
        <div>
          <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-faint">
            Path parameters <span className="normal-case tracking-normal">(from the path)</span>
          </span>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {names.map((name) => (
              <label key={name} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
                <code className="font-mono text-[12px] font-semibold text-ink">{name}</code>
                <input
                  value={pathValues[name] ?? ''}
                  onChange={(e) => setPathValues({ ...pathValues, [name]: e.target.value })}
                  placeholder="example value"
                  className={input}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      <RowsEditor title="Headers" rows={headers} onChange={setHeaders} valueHint="value sent every call" />
      <RowsEditor title="Query parameters" rows={query} onChange={setQuery} valueHint="example value" />

      {takesBody && (
        <label className="block">
          <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-faint">
            Example request body
          </span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            rows={7}
            placeholder={'{\n  "policyNo": "1055864001"\n}'}
            className="w-full rounded-lg bg-surface p-2.5 font-mono text-[11.5px] leading-relaxed ring-1 ring-line focus:ring-2 focus:ring-primary focus:outline-none"
          />
          <span className="mt-1 block text-[11px] text-muted">Used by Test all, and as the shape of the form.</span>
        </label>
      )}

      {error && <p className="text-[12px] text-rose">{error}</p>}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void save()} loading={busy}>
          Save changes
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <code className="ml-auto font-mono text-[11px] text-faint">{endpoint.operationId}()</code>
      </div>
    </div>
  )
}
