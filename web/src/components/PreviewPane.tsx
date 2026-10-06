import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import {
  SandpackProvider,
  SandpackLayout,
  SandpackPreview,
  SandpackCodeEditor,
  SandpackFileExplorer,
} from '@codesandbox/sandpack-react'
import { Circle, Code2, Download, ExternalLink, Monitor, Play, RefreshCw, RotateCcw, Square, X } from 'lucide-react'
import { toSandpackBundle } from '@/lib/sandpack'
import { demoResponse, demoValues } from '@/lib/demo'
import { canRecord, recordThisTab, type Recording, type TabRecorder } from '@/lib/recorder'
import { RecordMenu } from '@/components/RecordDemo'
import { cn } from '@/lib/cn'
import type { AppSpec, GeneratedFile } from '@/lib/types'

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
function useCallBridge(projectId: string, demo: MutableRefObject<{ on: boolean; appSpec?: AppSpec }>) {
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

      /*
       * During a demo nothing real is called: every call succeeds with the best
       * sample on hand, after a pause long enough to see the loading state.
       */
      if (demo.current.on) {
        const endpoint = demo.current.appSpec?.endpoints.find((e) => e.operationId === data.operationId)
        await new Promise((r) => setTimeout(r, 650))
        reply({ status: 200, body: demoResponse(endpoint, demo.current.appSpec), url: `demo://${data.operationId}` })
        return
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
  }, [projectId, demo])
}

export function PreviewPane({
  files,
  projectId,
  standalone,
  appSpec,
  autoDemo,
  recordDemo,
  recordSelf,
}: {
  files: GeneratedFile[]
  projectId: string
  /** Set on the dedicated preview window, which fills the screen and cannot pop itself out again. */
  standalone?: boolean
  /** The endpoints a demo run answers for and takes its typed values from. */
  appSpec?: AppSpec
  /** Set on the demo window: plays the journey as soon as the app loads, then closes. */
  autoDemo?: boolean
  /** With autoDemo: records the run to a video instead of closing at the end. */
  recordDemo?: boolean
  /** Records the person using the app themselves; no demo is played. */
  recordSelf?: boolean
}) {
  // A recorded demo waits for the person to start recording; a plain one starts at once.
  const demo = useRef<{ on: boolean; pending: boolean; appSpec?: AppSpec }>({
    on: false,
    pending: Boolean(autoDemo && !recordDemo),
  })
  demo.current.appSpec = appSpec
  useCallBridge(projectId, demo)
  const [tab, setTab] = useState<Tab>('preview')
  const [nonce, setNonce] = useState(0)
  const [demoState, setDemoState] = useState<{ running: boolean; text?: string }>({ running: Boolean(autoDemo) })
  const frame = useRef<HTMLDivElement>(null)
  const player = useRef<Window | null>(null)
  // What Esc does right now, kept current each render so the message handler never holds a stale one.
  const onEscape = useRef<(() => void) | null>(null)
  const recorder = useRef<TabRecorder | null>(null)
  // True once the app has mounted; recording waits for it so the video opens on the app, not its loader.
  const [appReady, setAppReady] = useState(false)
  const [rec, setRec] = useState<{
    phase: 'ready' | 'asking' | 'recording' | 'saving' | 'done' | 'error'
    video?: Recording
    error?: string
  }>({ phase: 'ready' })

  /*
   * A demo starts from a fresh preview, so it begins on the first screen with
   * nothing typed. The player announces itself once the app has loaded, and
   * only then is it told to start.
   */
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as { __spec2ui?: string; text?: string; error?: string } | null
      if (!data?.__spec2ui) return
      if (data.__spec2ui === 'demo-ready') {
        player.current = event.source as Window | null
        setAppReady(true)
      }
      if (data.__spec2ui === 'demo-ready' && demo.current.pending) {
        demo.current.pending = false
        demo.current.on = true
        const source = event.source as Window | null
        source?.postMessage({ __spec2ui: 'demo-start', values: demoValues(demo.current.appSpec?.endpoints ?? []) }, '*')
      } else if (data.__spec2ui === 'demo-escape') {
        onEscape.current?.()
      } else if (data.__spec2ui === 'demo-progress') {
        setDemoState({ running: true, text: data.text })
      } else if (data.__spec2ui === 'demo-done') {
        demo.current.on = false
        setDemoState({ running: false, text: data.error ? `Demo stopped: ${data.error}` : undefined })
        if (recorder.current) void finishRecording()
        // The demo window exists for the run alone; the player has already lingered on the end.
        else if (autoDemo && !recordDemo && !data.error) window.setTimeout(() => window.close(), 600)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDemo, recordDemo, recordSelf])

  /** A demo plays in a window of its own, which closes itself when the journey ends. */
  function startDemo(record: false | 'demo' | 'self' = false) {
    window.open(
      record === 'self'
        ? `/preview/${projectId}?record=self`
        : `/preview/${projectId}?demo=1${record ? '&record=1' : ''}`,
      `spec2ui-demo-${projectId}`,
      'width=1280,height=900',
    )
  }

  /**
   * Asks to share this tab, then plays the demo while it records. The run
   * starts only once recording has, so the video opens on the first screen.
   */
  async function startRecording() {
    setRec({ phase: 'asking' })
    try {
      recorder.current = await recordThisTab()
    } catch (err) {
      recorder.current = null
      const denied = err instanceof DOMException && err.name === 'NotAllowedError'
      const message = denied ? 'Recording was not allowed. Choose this tab when the browser asks.' : String(err)
      setRec({ phase: 'error', error: message })
      return
    }
    // Sharing stopped from the browser's own bar ends the run, and still keeps what was recorded.
    recorder.current.onEnded(() => stopDemo())
    setRec({ phase: 'recording' })
    // Recording yourself: the app is yours to drive, with its real API.
    if (recordSelf) return
    // Lets the share prompt clear before the first frame worth keeping.
    await new Promise((r) => setTimeout(r, 800))
    // The app may still be loading; the player says when it is listening.
    for (let i = 0; i < 300 && !player.current; i++) await new Promise((r) => setTimeout(r, 200))
    demo.current.on = true
    setDemoState({ running: true })
    player.current?.postMessage({ __spec2ui: 'demo-start', values: demoValues(demo.current.appSpec?.endpoints ?? []) }, '*')
  }

  async function finishRecording() {
    const active = recorder.current
    if (!active) return
    recorder.current = null
    setRec({ phase: 'saving' })
    await new Promise((r) => setTimeout(r, 400))
    const video = await active.finish()
    setRec({ phase: 'done', video })
  }

  function downloadVideo(video: Recording) {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
    const name = (document.title.replace(/\s+—.*$/, '') || 'app').replace(/[^\w-]+/g, '-').toLowerCase()
    const link = document.createElement('a')
    link.href = video.url
    link.download = `${name}-demo-${stamp}.${video.extension}`
    link.click()
  }

  // Esc stops a recording or a running demo, whether it is pressed in the app or around it.
  onEscape.current = rec.phase === 'recording' || (autoDemo && demoState.running) ? () => stopDemo() : null

  useEffect(() => {
    if (rec.phase !== 'recording') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stopDemo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.phase])

  function stopDemo() {
    const target = frame.current?.querySelector('iframe')?.contentWindow
    target?.postMessage({ __spec2ui: 'demo-stop' }, '*')
    demo.current.on = false
    demo.current.pending = false
    setDemoState({ running: false })
    if (recordSelf) {
      void finishRecording()
      return
    }
    // A recording keeps the window open for its video; the stop reaches finishRecording via demo-done.
    if (recordDemo) {
      if (recorder.current) window.setTimeout(() => void finishRecording(), 1500)
      return
    }
    if (autoDemo) window.close()
  }

  // The pop-out window has the whole viewport; the panel in the studio sits
  // beside other cards and needs a fixed height to stay predictable.
  const paneHeight = standalone ? 'calc(100dvh - 112px)' : 620

  const bundle = useMemo(() => toSandpackBundle(files), [files])
  // A hash of the contents, not their length: recolouring swaps one hex code
  // for another of the same length, and the preview must still remount.
  const signature = useMemo(() => {
    let hash = 5381
    for (const f of files) {
      for (let i = 0; i < f.content.length; i++) hash = ((hash << 5) + hash + f.content.charCodeAt(i)) | 0
    }
    return `${files.length}:${hash >>> 0}:${nonce}`
  }, [files, nonce])

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
        {(recordDemo || recordSelf) && (
          <RecordOverlay
            rec={rec}
            appReady={appReady}
            self={Boolean(recordSelf)}
            onStart={() => void startRecording()}
            onDownload={downloadVideo}
          />
        )}
        {autoDemo && !recordDemo && (
          <div className="fixed top-3 right-3 z-50 flex items-center gap-2">
            <span className="rounded-full bg-amber-soft px-3 py-1.5 text-[12px] font-semibold text-amber shadow-sm">
              {demoState.running ? 'Demo · sample data, no real API calls' : demoState.text ?? 'Demo finished'}
            </span>
            <button
              type="button"
              onClick={stopDemo}
              className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[12px] font-semibold text-rose shadow-sm ring-1 ring-line hover:bg-rose-soft"
            >
              <Square className="size-3.5" />
              {demoState.running ? 'Stop demo' : 'Close'}
            </button>
          </div>
        )}
        <div ref={frame}>
        <SandpackLayout style={{ border: 'none', borderRadius: 0, background: 'transparent' }}>
          <SandpackPreview
            showNavigator={false}
            showOpenInCodeSandbox={false}
            showRefreshButton={false}
            style={{ height: '100dvh', width: '100%' }}
          />
        </SandpackLayout>
        </div>
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
          <RecordMenu
            onDemo={() => startDemo('demo')}
            onSelf={() => startDemo('self')}
          />
          <button
            type="button"
            onClick={() => startDemo()}
            title="Play the journey on its own in a new window, with sample data"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary-soft px-2.5 py-1.5 text-[12px] font-semibold text-primary transition-colors hover:opacity-80"
          >
            <Play className="size-3.5" />
            Run demo
          </button>
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

      <div ref={frame}>
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

/**
 * Everything the record window shows around the app: the start button, the
 * finished video and what to do with it. Nothing is drawn while recording, so
 * nothing but the app ends up in the video.
 */
function RecordOverlay({
  rec,
  self,
  appReady,
  onStart,
  onDownload,
}: {
  rec: { phase: 'ready' | 'asking' | 'recording' | 'saving' | 'done' | 'error'; video?: Recording; error?: string }
  self: boolean
  appReady: boolean
  onStart: () => void
  onDownload: (video: Recording) => void
}) {
  /*
   * Nothing is drawn over the app while recording, so nothing but the app is in
   * the video. Stopping is Esc, or the browser's own Stop sharing bar, which
   * sits outside the page and is never captured.
   */
  if (rec.phase === 'recording') return null

  const card = 'w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-xl ring-1 ring-line'
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-6 backdrop-blur-sm">
      {rec.phase === 'done' && rec.video ? (
        <div className="w-full max-w-3xl rounded-2xl bg-white p-5 shadow-xl ring-1 ring-line">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[15px] font-semibold text-ink">Your demo video</p>
            <span className="text-[12px] text-muted">
              {rec.video.seconds}s · {(rec.video.blob.size / 1_048_576).toFixed(1)} MB · {rec.video.extension.toUpperCase()}
            </span>
          </div>
          <video src={rec.video.url} controls autoPlay className="w-full rounded-xl bg-black" />
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => window.close()}
              className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-[13px] font-semibold text-muted hover:bg-canvas-deep hover:text-ink"
            >
              <X className="size-4" /> Close
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-surface px-4 py-2 text-[13px] font-semibold text-ink ring-1 ring-line hover:bg-canvas"
            >
              <RotateCcw className="size-4" /> Record again
            </button>
            <button
              type="button"
              onClick={() => onDownload(rec.video!)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[13px] font-semibold text-white hover:bg-primary-hover"
            >
              <Download className="size-4" /> Download video
            </button>
          </div>
        </div>
      ) : rec.phase === 'saving' ? (
        <div className={card}>
          <p className="text-[14px] font-semibold text-ink">Preparing your video…</p>
        </div>
      ) : (
        <div className={card}>
          <span className="mx-auto mb-3 grid size-12 place-items-center rounded-full bg-rose-soft text-rose">
            <Circle className="size-5 fill-current" />
          </span>
          <p className="text-[16px] font-semibold text-ink">{self ? 'Record yourself' : 'Record the demo'}</p>
          {self ? (
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              The browser will ask to share a tab. Choose <b>this tab</b>, then use the app as you normally would. It calls
              the real APIs. When you are done, press{' '}
              <kbd className="rounded bg-canvas-deep px-1.5 py-0.5 font-mono text-[11px]">Esc</kbd> or <b>Stop sharing</b> in
              the browser's bar.
            </p>
          ) : (
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              The browser will ask to share a tab. Choose <b>this tab</b>, and the demo plays while it records. Press{' '}
              <kbd className="rounded bg-canvas-deep px-1.5 py-0.5 font-mono text-[11px]">Esc</kbd> to stop early. Sample
              data only, no real API calls.
            </p>
          )}
          {rec.phase === 'error' && <p className="mt-3 text-[12.5px] text-rose">{rec.error}</p>}
          {!canRecord() && (
            <p className="mt-3 text-[12.5px] text-rose">This browser cannot record a tab. Use Chrome or Edge.</p>
          )}
          <div className="mt-5 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => window.close()}
              className="rounded-xl px-4 py-2 text-[13px] font-semibold text-muted hover:bg-canvas-deep hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onStart}
              disabled={rec.phase === 'asking' || !canRecord() || !appReady}
              className="inline-flex items-center gap-1.5 rounded-xl bg-rose px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
            >
              <Circle className="size-3 fill-current" />
              {!appReady
                ? 'Loading the app…'
                : rec.phase === 'asking'
                  ? 'Waiting for the browser…'
                  : rec.phase === 'error'
                    ? 'Try again'
                    : 'Start recording'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
