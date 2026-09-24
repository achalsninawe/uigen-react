import { useEffect, useMemo, useState } from 'react'
import {
  SandpackProvider,
  SandpackLayout,
  SandpackPreview,
  SandpackCodeEditor,
  SandpackFileExplorer,
} from '@codesandbox/sandpack-react'
import { Code2, ExternalLink, Monitor, RefreshCw } from 'lucide-react'
import { toSandpackBundle } from '@/lib/sandpack'
import { cn } from '@/lib/cn'
import type { GeneratedFile } from '@/lib/types'

type Tab = 'preview' | 'code'

/**
 * Runs the generated app in the browser.
 *
 * `key` is derived from the file contents so that regenerating replaces the
 * whole Sandpack instance — it does not reconcile a changed file set cleanly,
 * and a stale bundler is far more confusing than a brief reload.
 */
/**
 * Relays API calls out of the preview iframe.
 *
 * The preview runs on a public sandbox origin, and browsers block a public page
 * from reaching localhost — Chrome reports it as
 * ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS. The generated app therefore posts
 * each call up to this window, which is itself on localhost and can make the
 * request, and posts the result back down.
 */
function useCallBridge(projectId: string) {
  useEffect(() => {
    async function onMessage(event: MessageEvent) {
      const data = event.data as
        | {
            __spec2ui?: string
            id?: number
            operationId?: string
            pathParams?: Record<string, unknown>
            query?: Record<string, unknown>
            body?: unknown
            headers?: Record<string, string>
          }
        | null

      if (!data || data.__spec2ui !== 'request' || typeof data.id !== 'number' || !data.operationId) return

      const reply = (payload: Record<string, unknown>) => {
        const target = event.source as Window | null
        target?.postMessage({ __spec2ui: 'response', id: data.id, ...payload }, '*')
      }

      try {
        const res = await fetch(`/api/proxy/${projectId}/${data.operationId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pathParams: data.pathParams ?? {},
            query: data.query ?? {},
            body: data.body,
            headers: data.headers ?? {},
          }),
        })
        const payload = (await res.json()) as { status?: number; body?: unknown; error?: string; url?: string }
        if (!res.ok) {
          reply({ error: payload.error ?? `${res.status} ${res.statusText}`, status: res.status, url: payload.url })
          return
        }
        reply({ status: payload.status ?? 200, body: payload.body, url: payload.url })
      } catch (err) {
        reply({ error: err instanceof Error ? err.message : 'Bridge request failed', status: 0 })
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [projectId])
}

export function PreviewPane({
  files,
  projectId,
  standalone,
}: {
  files: GeneratedFile[]
  projectId: string
  /** Set on the dedicated preview window, which fills the screen and cannot pop itself out again. */
  standalone?: boolean
}) {
  useCallBridge(projectId)
  const [tab, setTab] = useState<Tab>('preview')
  const [nonce, setNonce] = useState(0)

  // The pop-out window has the whole viewport; the panel in the studio sits
  // beside other cards and needs a fixed height to stay predictable.
  const paneHeight = standalone ? 'calc(100dvh - 112px)' : 620

  const bundle = useMemo(() => toSandpackBundle(files), [files])
  const signature = useMemo(
    () => `${files.length}:${files.reduce((sum, f) => sum + f.content.length, 0)}:${nonce}`,
    [files, nonce],
  )

  /*
   * A window of its own shows the app and nothing else.
   *
   * The tab bar, the reload button and the panel's frame all belong to the
   * studio; repeated around a full-screen app they only make it look like it is
   * still sitting in a tool. This is a real page, so the browser's own reload
   * and back already do what those controls did.
   */
  if (standalone) {
    return (
      <SandpackProvider
        key={signature}
        template="react-ts"
        files={bundle.files}
        customSetup={{ dependencies: bundle.dependencies, entry: bundle.entry }}
        options={{ recompileMode: 'delayed', recompileDelay: 400 }}
        theme={sandpackTheme}
      >
        <SandpackLayout style={{ border: 'none', borderRadius: 0, background: 'transparent' }}>
          <SandpackPreview
            showNavigator={false}
            showOpenInCodeSandbox={false}
            showRefreshButton={false}
            style={{ height: '100dvh', width: '100%' }}
          />
        </SandpackLayout>
      </SandpackProvider>
    )
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius-panel)] bg-surface ring-1 ring-line shadow-[var(--shadow-soft)]">
      <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <div className="flex items-center gap-1">
          {(
            [
              { key: 'preview' as const, label: 'Preview', Icon: Monitor },
              { key: 'code' as const, label: 'Code', Icon: Code2 },
            ]
          ).map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors',
                tab === key ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-canvas-deep hover:text-ink',
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          {/*
            The API bridge lives in whichever window hosts this component, so the
            popped-out window relays its own calls. Opening the built preview
            directly would leave it with nothing to relay through.
          */}
          {!standalone && (
            <button
              type="button"
              onClick={() =>
                window.open(
                  `/preview/${projectId}`,
                  `spec2ui-preview-${projectId}`,
                  'noopener,width=1280,height=900',
                )
              }
              title="Open the preview in its own window"
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold text-muted transition-colors hover:bg-canvas-deep hover:text-ink"
            >
              <ExternalLink className="size-3.5" />
              New window
            </button>
          )}

          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            title="Reload the preview"
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold text-muted transition-colors hover:bg-canvas-deep hover:text-ink"
          >
            <RefreshCw className="size-3.5" />
            Reload
          </button>
        </div>
      </div>

      <SandpackProvider
        key={signature}
        template="react-ts"
        files={bundle.files}
        customSetup={{ dependencies: bundle.dependencies, entry: bundle.entry }}
        options={{ activeFile: bundle.activeFile, recompileMode: 'delayed', recompileDelay: 400 }}
        theme={sandpackTheme}
      >
        <SandpackLayout style={{ border: 'none', borderRadius: 0, background: 'transparent' }}>
          {tab === 'preview' ? (
            <SandpackPreview
              showNavigator
              showOpenInCodeSandbox={false}
              showRefreshButton
              style={{ height: paneHeight }}
            />
          ) : (
            <>
              <SandpackFileExplorer style={{ height: paneHeight, minWidth: 210 }} />
              <SandpackCodeEditor
                showLineNumbers
                showTabs
                wrapContent
                closableTabs
                style={{ height: paneHeight }}
              />
            </>
          )}
        </SandpackLayout>
      </SandpackProvider>
    </div>
  )
}

/** Sandpack's own tokens, tuned to sit inside the studio's light palette. */
const sandpackTheme = {
  colors: {
    surface1: '#ffffff',
    surface2: '#fafaff',
    surface3: '#f4f4fd',
    clickable: '#7a7a96',
    base: '#1b1b2b',
    disabled: '#a9a9c2',
    hover: '#6c63ff',
    accent: '#6c63ff',
    error: '#f4718a',
    errorSurface: '#ffeef1',
  },
  syntax: {
    plain: '#1b1b2b',
    comment: { color: '#a9a9c2', fontStyle: 'italic' as const },
    keyword: '#6c63ff',
    tag: '#4ea8f5',
    punctuation: '#7a7a96',
    definition: '#1b1b2b',
    property: '#b39dff',
    static: '#34c99a',
    string: '#34c99a',
  },
  font: {
    body: "'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, Menlo, monospace",
    size: '13px',
    lineHeight: '1.6',
  },
}
