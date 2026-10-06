import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileCode2,
  FileText,
  Info,
  Pencil,
  Route as RouteIcon,
  Sparkles,
  Wrench,
} from 'lucide-react'
import { TopBar } from '@/components/TopBar'
import { PreviewPane } from '@/components/PreviewPane'
import { SavePanel } from '@/components/SavePanel'
import { ExportPanel } from '@/components/ExportPanel'
import { ConnectionPanel } from '@/components/ConnectionPanel'
import { SampleDataToggle } from '@/components/SampleDataToggle'
import { GeneratorToggle, type Generator } from '@/components/GeneratorToggle'
import { ThemePanel, ThemeUploadButton } from '@/components/ThemePanel'
import { NetworkLog } from '@/components/NetworkLog'
import { StepRail, type StepKey } from '@/components/StepRail'
import { ActivityLog, type LogLine } from '@/components/ActivityLog'
import { EndpointsSection } from '@/components/EndpointsSection'
import { AppColorPicker, TextSizePicker } from '@/components/AppColorPicker'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { analyzeUrl, api, generateUrl, repairUrl, streamPipeline } from '@/lib/api'
import { generatorFor, type ConnectionSettings, type Endpoint, type Gap, type PipelineEvent, type Project as ProjectType } from '@/lib/types'
import { cn } from '@/lib/cn'

/** One finished run: what it was, what it produced, when. */
interface DoneTask {
  id: number
  label: string
  detail: string
  at: string
}

function GapRow({ gap }: { gap: Gap }) {
  const Icon = gap.severity === 'warning' ? AlertTriangle : Info
  return (
    <li className="flex gap-2.5 px-5 py-3">
      <Icon className={cn('mt-0.5 size-4 shrink-0', gap.severity === 'warning' ? 'text-amber' : 'text-faint')} />
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-ink">{gap.topic}</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{gap.detail}</p>
        {gap.suggestion && <p className="mt-1 text-[12px] text-primary">{gap.suggestion}</p>}
      </div>
    </li>
  )
}

/**
 * The title, editable in place.
 *
 * A rename that opens a dialog is a rename nobody does, and the name matters
 * here — it is the only thing distinguishing two projects built from similar
 * documents. A refused name keeps what was typed, so the fix is one edit away
 * rather than a retype.
 */
function ProjectTitle({
  name,
  onRename,
}: {
  name?: string
  onRename: (next: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(name ?? '')
          setError(null)
          setEditing(true)
        }}
        title="Rename"
        className="group mt-1.5 flex max-w-full items-center gap-2 text-left"
      >
        <h1 className="truncate text-[26px] font-bold tracking-tight text-ink">{name ?? 'Loading…'}</h1>
        <Pencil className="size-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    )
  }

  const commit = async () => {
    const next = draft.trim()
    if (!next || next === name) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      await onRename(next)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-1.5">
      <input
        autoFocus
        value={draft}
        disabled={busy}
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="w-full max-w-lg rounded-xl bg-white px-3 py-1 text-[26px] font-bold tracking-tight text-ink ring-1 ring-line focus:ring-2 focus:ring-primary focus:outline-none"
      />
      {error && <p className="mt-1.5 text-[12.5px] font-medium text-rose">{error}</p>}
    </div>
  )
}

export default function Project() {
  const { id = '' } = useParams<{ id: string }>()

  const [project, setProject] = useState<ProjectType | null>(null)
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [logs, setLogs] = useState<LogLine[]>([])
  const [running, setRunning] = useState<'analyze' | 'generate' | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [health, setHealth] = useState<{ ai: 'ready' | 'mock' } | null>(null)
  const [fixing, setFixing] = useState(false)
  const [fixNote, setFixNote] = useState('')
  const [fixMode, setFixMode] = useState<'fix' | 'refine'>('fix')
  // Empty means every screen gets a look; otherwise only this one is changed.
  const [fixScreen, setFixScreen] = useState('')

  /*
   * What has finished, kept after the log scrolls on.
   *
   * The activity log answers "what is happening"; once a run ends it answers
   * nothing, because the line that mattered has scrolled away under fifty
   * others. These stay put, so you can see at a glance that the documents were
   * read and the app was built, and what each one produced.
   */
  const [done, setDone] = useState<DoneTask[]>([])
  const lastStatus = useRef('')

  const logId = useRef(0)
  // Guards against React 18 double-mounting kicking off two analyses.
  const startedRef = useRef(false)

  const addLog = useCallback((message: string, level: LogLine['level'] = 'info') => {
    setLogs((prev) => [...prev, { id: logId.current++, level, message }])
  }, [])

  const handleEvent = useCallback(
    (event: PipelineEvent) => {
      switch (event.type) {
        case 'log':
          addLog(event.message, event.level)
          break
        case 'status':
          addLog(event.message)
          // The closing status of a run is its summary — "Found 12 endpoints",
          // "25 files generated and the project compiles".
          lastStatus.current = event.message
          break
        case 'endpoint':
          setEndpoints((prev) => [...prev, event.endpoint])
          break
        case 'appspec':
          setEndpoints(event.appSpec.endpoints)
          setProject((prev) => (prev ? { ...prev, appSpec: event.appSpec } : prev))
          break
        case 'screen-start':
          addLog(`Writing ${event.name}`)
          break
        case 'done':
          setProject(event.project)
          setEndpoints(event.project.appSpec?.endpoints ?? [])
          break
        case 'error':
          addLog(event.message, 'error')
          break
      }
    },
    [addLog],
  )

  const finish = useCallback((label: string) => {
    setDone((prev) =>
      [
        ...prev,
        {
          id: Date.now(),
          label,
          detail: lastStatus.current,
          at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ].slice(-6),
    )
  }, [])

  const runAnalyze = useCallback(async () => {
    setRunning('analyze')
    setLogs([])
    setEndpoints([])
    setFatal(null)
    const stream = streamPipeline(analyzeUrl(id), handleEvent)
    try {
      await stream.promise
      finish('Documents read')
    } catch (err) {
      setFatal(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setRunning(null)
    }
  }, [id, handleEvent, finish])

  const runGenerate = useCallback(
    async (replan = false) => {
      setRunning('generate')
      setFatal(null)
      const stream = streamPipeline(generateUrl(id, replan), handleEvent)
      try {
        await stream.promise
        finish(replan ? 'App rebuilt' : 'App built')
      } catch (err) {
        setFatal(err instanceof Error ? err.message : 'Generation failed')
      } finally {
        setRunning(null)
      }
    },
    [id, handleEvent, finish],
  )

  const runRepair = useCallback(
    async (note: string, mode: 'fix' | 'refine' = 'fix', screenId?: string) => {
      setRunning('generate')
      setFatal(null)
      const stream = streamPipeline(repairUrl(id, note || undefined, mode, screenId), handleEvent)
      const screen = screenId ? project?.plan?.screens.find((s) => s.id === screenId)?.name : undefined
      try {
        await stream.promise
        finish(
          screen
            ? `${screen} ${mode === 'refine' ? 'refined' : 'fixed'}`
            : mode === 'refine'
              ? 'Screens refined'
              : 'Screens fixed',
        )
      } catch (err) {
        setFatal(err instanceof Error ? err.message : 'Could not change the screens')
      } finally {
        setRunning(null)
      }
    },
    [id, handleEvent, finish, project?.plan],
  )

  /** Takes a project the server sent back after an edit or a test. */
  const takeProject = useCallback((next: ProjectType) => {
    setProject(next)
    setEndpoints(next.appSpec?.endpoints ?? [])
  }, [])

  /** Opens the fix dialog, optionally already pointed at one screen. */
  const openFix = useCallback((screenId = '', mode: 'fix' | 'refine' = 'fix') => {
    setFixScreen(screenId)
    setFixMode(mode)
    setFixing(true)
  }, [])

  const saveConnection = useCallback(
    async (next: ConnectionSettings) => {
      const updated = await api.saveConnection(id, next)
      // Keep the locally streamed appSpec; PATCH only touches connection settings.
      setProject((prev) => (prev ? { ...prev, connection: updated.connection } : updated))
    },
    [id],
  )

  const saveSampleData = useCallback(
    async (next: boolean) => {
      setProject((prev) => (prev ? { ...prev, sampleData: next } : prev))
      try {
        const updated = await api.setSampleData(id, next)
        setProject((prev) => (prev ? { ...prev, sampleData: updated.sampleData } : updated))
      } catch {
        setProject((prev) => (prev ? { ...prev, sampleData: !next } : prev))
      }
    },
    [id],
  )

  const saveGenerator = useCallback(
    async (next: Generator) => {
      let previous: Generator | undefined
      setProject((prev) => {
        // The stored value, not the resolved one: a failed save must put back "not chosen".
        previous = prev?.generator
        return prev ? { ...prev, generator: next } : prev
      })
      try {
        const updated = await api.setGenerator(id, next)
        setProject((prev) => (prev ? { ...prev, generator: updated.generator } : updated))
      } catch {
        setProject((prev) => (prev ? { ...prev, generator: previous } : prev))
      }
    },
    [id],
  )

  // Only the theme is taken from the reply, like the other settings above.
  const uploadTheme = useCallback(
    async (files: File[]) => {
      const updated = await api.uploadTheme(id, files)
      setProject((prev) => (prev ? { ...prev, brandTheme: updated.brandTheme } : updated))
    },
    [id],
  )

  const removeTheme = useCallback(async () => {
    await api.removeTheme(id)
    setProject((prev) => {
      if (!prev) return prev
      const { brandTheme: _removed, ...rest } = prev
      return rest
    })
  }, [id])

  useEffect(() => {
    api.health().then(setHealth).catch(() => {})
  }, [])

  useEffect(() => {
    if (!id || startedRef.current) return
    startedRef.current = true

    api
      .getProject(id)
      .then((loaded) => {
        setProject(loaded)
        setEndpoints(loaded.appSpec?.endpoints ?? [])
        // A freshly uploaded project has been parsed but not read yet.
        if (loaded.status === 'parsed') void runAnalyze()
      })
      .catch((err: unknown) => setFatal(err instanceof Error ? err.message : 'Could not load project'))
  }, [id, runAnalyze])

  const appSpec = project?.appSpec
  const hasSpec = Boolean(appSpec)
  const hasApp = (project?.files.length ?? 0) > 0

  const step: StepKey = running === 'generate' ? 'generate' : hasApp ? 'preview' : hasSpec ? 'generate' : 'analyze'
  const doneSteps: StepKey[] = ['upload', ...(hasSpec ? (['analyze'] as StepKey[]) : []), ...(hasApp ? (['generate'] as StepKey[]) : [])]

  const warnings = appSpec?.gaps.filter((g) => g.severity === 'warning').length ?? 0

  // Every endpoint usually shares one scheme; describe the first non-trivial one.
  const secured = appSpec?.endpoints.find((e) => e.auth.type !== 'none')?.auth
  const authHint = secured
    ? `Sent as ${secured.name ?? 'Authorization'}${secured.scheme ? `: ${secured.scheme} <value>` : ''}`
    : undefined

  return (
    <div className="min-h-dvh">
      <TopBar />

      <main className={cn('mx-auto px-6 pt-10 pb-24 transition-[max-width] duration-500', hasApp ? 'max-w-[1280px]' : 'max-w-4xl')}>
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-muted transition-colors hover:text-primary"
            >
              <ArrowLeft className="size-3.5" />
              New project
            </Link>
            {/*
              The project's own name, not the app name the documents suggested.
              This is what the saved-projects list shows, so it is the thing
              worth being able to correct.
            */}
            <ProjectTitle
              name={project?.name}
              onRename={async (next) => {
                const updated = await api.renameProject(id, next)
                setProject((prev) => (prev ? { ...prev, name: updated.name } : prev))
              }}
            />
            {appSpec?.description && (
              <p className="mt-1 max-w-xl text-[13.5px] leading-relaxed text-muted">{appSpec.description}</p>
            )}
          </div>
          <StepRail current={step} done={doneSteps} />
        </div>

        {fatal && (
          <Card className="mb-6 ring-rose/30">
            <div className="flex items-start gap-3 px-5 py-4">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose" />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-semibold text-ink">Something went wrong</p>
                <p className="mt-0.5 text-[13px] break-words text-muted">{fatal}</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => void runAnalyze()}>
                Retry
              </Button>
            </div>
          </Card>
        )}

        {/* Sources */}
        {project && project.documents.length > 0 && (
          <div className="mb-6 flex flex-wrap gap-2">
            {project.documents.map((doc) => (
              <span
                key={doc.id}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-[12px] font-medium ring-1',
                  doc.parseError ? 'text-amber ring-amber/30' : 'text-ink-soft ring-line',
                )}
                title={doc.parseError}
              >
                <FileText className="size-3.5 text-faint" />
                {doc.filename}
                <span className="text-faint">{doc.kind}</span>
              </span>
            ))}
          </div>
        )}

        {/* Activity */}
        {(logs.length > 0 || running || done.length > 0) && (
          <Card className="mb-6 overflow-hidden">
            <CardHeader
              icon={<Sparkles className="size-4" />}
              title={running === 'generate' ? 'Building your app' : running ? 'Reading your documents' : 'Activity'}
              subtitle={running ? 'This can take a minute' : undefined}
            />

            {/*
              Finished work, above the live log rather than inside it — the log
              scrolls and these should not.
            */}
            {done.length > 0 && (
              <ul className="border-b border-line-soft bg-mint-soft/40 px-5 py-3">
                <AnimatePresence initial={false}>
                  {done.map((task) => (
                    <motion.li
                      key={task.id}
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-start gap-2.5 py-1"
                    >
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-mint" />
                      <div className="min-w-0 flex-1">
                        <span className="text-[13px] font-semibold text-ink">{task.label}</span>
                        {task.detail && (
                          <span className="ml-2 text-[12.5px] text-muted">{task.detail}</span>
                        )}
                      </div>
                      <span className="shrink-0 text-[11.5px] text-faint tabular-nums">{task.at}</span>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}

            <ActivityLog lines={logs} running={Boolean(running)} />
          </Card>
        )}

        {/* Connection — needed before any call, including learning a shape */}
        {hasSpec && !hasApp && project && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 max-w-xl"
          >
            <ConnectionPanel
              connection={project.connection}
              documentedServers={appSpec?.servers ?? []}
              authHint={authHint}
              onSave={saveConnection}
            />
          </motion.div>
        )}

        {/* Endpoints: test, edit, add and remove before any screen is written */}
        <EndpointsSection
          projectId={id}
          appSpec={appSpec}
          endpoints={endpoints}
          busy={Boolean(running)}
          appIsStale={hasApp && project?.status === 'analyzed'}
          onProject={takeProject}
        />

        {/*
         * Data shapes and user flows are not shown.
         *
         * A real payload produces thirty-odd derived interfaces — FreelookResult,
         * Policy2, CoverageExtend2 — and a list of their field counts tells you
         * nothing you can act on while pushing the endpoints and the gaps, which
         * you can, off the screen. They are still in the AppSpec and still drive
         * generation.
         */}

        {/* Gaps */}
        {appSpec && appSpec.gaps.length > 0 && (
          <Card className="mb-6">
            <CardHeader
              icon={<AlertTriangle className="size-4" />}
              title="What your documents left open"
              subtitle="Reported rather than invented"
              action={warnings > 0 ? <Badge tone="amber">{warnings} to review</Badge> : undefined}
            />
            <ul className="divide-y divide-line-soft">
              {appSpec.gaps.map((gap, i) => (
                <GapRow key={i} gap={gap} />
              ))}
            </ul>
          </Card>
        )}

        {/* Generated files */}
        <AnimatePresence>
          {hasApp && project && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <Card className="mb-6">
                <CardHeader
                  icon={<FileCode2 className="size-4" />}
                  title="Your app"
                  subtitle={`${project.files.length} files · ${project.plan?.screens.length ?? 0} screens`}
                />
                {project.plan && (
                  <ul className="px-5 pb-2">
                    {project.plan.screens.map((screen) => (
                      <li key={screen.id} className="group flex items-center gap-2.5 py-1.5">
                        <RouteIcon className="size-3.5 shrink-0 text-faint" />
                        <span className="text-[13px] font-medium text-ink">{screen.name}</span>
                        <code className="font-mono text-[11.5px] text-muted">{screen.route}</code>
                        {screen.look && (
                          <span
                            title="This screen has its own style"
                            className="inline-flex items-center gap-1 rounded-full bg-canvas-deep px-2 py-0.5 text-[10.5px] font-semibold text-muted"
                          >
                            {screen.look.accent && (
                              <span className="size-2 rounded-full" style={{ background: screen.look.accent }} />
                            )}
                            {screen.look.textSize ? `${screen.look.textSize} text` : 'own color'}
                          </span>
                        )}
                        {!running && health?.ai !== 'mock' && (
                          <button
                            type="button"
                            onClick={() => openFix(screen.id, 'refine')}
                            className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11.5px] font-semibold text-primary opacity-60 transition-opacity group-hover:opacity-100 hover:bg-primary-soft"
                          >
                            <Pencil className="size-3" /> Edit this screen
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {project.plan && (
                  <AppColorPicker
                    value={project.plan.theme.accent}
                    disabled={Boolean(running)}
                    onChange={async (hex) => takeProject(await api.setAccent(id, hex))}
                  />
                )}
                {project.plan && (
                  <TextSizePicker
                    value={project.textSize}
                    disabled={Boolean(running)}
                    onChange={async (next) => takeProject(await api.setTextSize(id, next))}
                  />
                )}
                <div className="max-h-48 overflow-y-auto border-t border-line-soft px-5 py-3">
                  {project.files.map((f) => (
                    <div key={f.path} className="flex items-center gap-2 py-0.5">
                      <span
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          f.origin === 'emitted' ? 'bg-sky' : 'bg-lilac',
                        )}
                        title={f.origin === 'emitted' ? 'generated by code' : 'written by the model'}
                      />
                      <code className="font-mono text-[11.5px] text-muted">{f.path}</code>
                    </div>
                  ))}
                </div>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Preview */}
        {hasApp && project && (
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="mb-6"
          >
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-[15px] font-bold text-ink">Your app, running</h2>
              <p className="text-[12px] text-muted">calls go through the proxy to the real API</p>
            </div>

            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0">
                <PreviewPane files={project.files} projectId={id} appSpec={appSpec} />
                <SavePanel
                  name={project.name}
                  savedAt={project.savedAt}
                  onSave={async (next) => {
                    const updated = await api.saveProject(id, next)
                    setProject((prev) =>
                      prev ? { ...prev, name: updated.name, savedAt: updated.savedAt } : prev,
                    )
                  }}
                />
                <ExportPanel projectId={id} hasEndpoints={(appSpec?.endpoints.length ?? 0) > 0} />
              </div>
              <div className="space-y-5">
                <ConnectionPanel
                  connection={project.connection}
                  documentedServers={appSpec?.servers ?? []}
                  authHint={authHint}
                  onSave={saveConnection}
                />
                <NetworkLog projectId={id} active={hasApp} />
              </div>
            </div>
          </motion.section>
        )}

        {/* Actions */}
        {hasSpec && !running && project && (
          <div className="mb-3 grid max-w-3xl gap-3 md:grid-cols-2">
            <GeneratorToggle
              value={generatorFor(project)}
              onChange={(next) => void saveGenerator(next)}
            />
            <SampleDataToggle
              checked={project.sampleData === true}
              onChange={(next) => void saveSampleData(next)}
            />
            {project.brandTheme && (
              <ThemePanel theme={project.brandTheme} onRemove={removeTheme} className="md:col-span-2" />
            )}
          </div>
        )}
        {hasSpec && !running && (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={() => void runGenerate(!hasApp ? false : true)} disabled={health?.ai === 'mock'}>
              <Sparkles className="size-4" />
              {hasApp ? 'Regenerate app' : 'Generate the app'}
            </Button>
            {/* Style files are not specification, so they are uploaded here, not with the documents. */}
            <ThemeUploadButton
              hasTheme={Boolean(project?.brandTheme)}
              onUpload={uploadTheme}
              disabled={health?.ai === 'mock'}
            />
            {/*
              Fixing is not regenerating. Regenerate re-rolls every screen and
              loses the ones that were already right; this keeps them and works
              on what is broken.
            */}
            {hasApp && (
              <Button size="lg" variant="outline" onClick={() => openFix()} disabled={health?.ai === 'mock'}>
                <Wrench className="size-4" />
                Fix or refine
              </Button>
            )}
            <Button size="lg" variant="ghost" onClick={() => void runAnalyze()}>
              Re-read documents
            </Button>
            {health?.ai === 'mock' && (
              <p className="text-[12.5px] text-amber">
                Set AZURE_OPENAI_API_KEY in .env and restart to enable generation
              </p>
            )}
          </div>
        )}

        {/*
          The note is the point of this dialog.
          A screen that compiles is a screen the compiler has no opinion about,
          so what the person watched go wrong is the only thing that makes it
          fixable. Skipping it still runs the type check, which is worth
          something but rarely what they came for.
        */}
        <AnimatePresence>
          {fixing && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 grid place-items-center bg-ink/20 p-6 backdrop-blur-sm"
              onClick={() => setFixing(false)}
            >
              <motion.div
                initial={{ opacity: 0, y: 12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.98 }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-lg rounded-2xl bg-white p-6 ring-1 ring-line"
              >
                <h2 className="text-[17px] font-semibold text-ink">
                  {fixMode === 'fix' ? 'What is wrong with it?' : 'What should change?'}
                </h2>

                {/*
                  One dialog, two intents, because the instruction they differ on
                  is invisible from the text: "the total is empty" wants the
                  smallest possible change, "group the amounts together" wants
                  the layout moved. Asked to do both at once the model does
                  neither well, so the choice is explicit.
                */}
                <div className="mt-4 flex gap-2 rounded-xl bg-surface p-1">
                  {(
                    [
                      ['fix', 'Fix a problem'],
                      ['refine', 'Refine the design'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setFixMode(value)}
                      className={cn(
                        'flex-1 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors',
                        fixMode === value ? 'bg-white text-ink shadow-sm' : 'text-muted hover:text-ink',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/*
                  Naming the screen is what keeps the rest of the app as it is:
                  without it every screen is shown the note and may change.
                */}
                {project?.plan && (
                  <label className="mt-4 block">
                    <span className="mb-1 block text-[12px] font-semibold text-ink-soft">Which screen?</span>
                    <select
                      value={fixScreen}
                      onChange={(e) => setFixScreen(e.target.value)}
                      className="h-10 w-full rounded-xl bg-white px-3 text-sm text-ink ring-1 ring-line focus:ring-2 focus:ring-primary focus:outline-none"
                    >
                      <option value="">All screens (it finds the right one)</option>
                      {project.plan.screens.map((screen) => (
                        <option key={screen.id} value={screen.id}>
                          {screen.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <p className="mt-3 text-[13px] leading-relaxed text-muted">
                  {fixScreen ? 'Only this screen will change. ' : ''}
                  {fixMode === 'fix'
                    ? 'Describe what you saw — an error, an empty field, a button that does nothing. Changes stay as small as possible.'
                    : 'Say how it should look — reorder fields, group them, widen a table, change wording. Layout may be restructured; the data it reads cannot. Colour and text size requests ("make it blue", "smaller font") change the screen you picked, or the whole app when none is picked.'}
                </p>

                <textarea
                  autoFocus
                  value={fixNote}
                  onChange={(e) => setFixNote(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  placeholder={
                    fixMode === 'fix'
                      ? 'Total Refund Amount shows an error instead of the value'
                      : 'Make it blue, smaller font, and show the policy dates side by side'
                  }
                  className="mt-3 w-full resize-y rounded-xl bg-white px-3.5 py-2.5 text-sm text-ink ring-1 ring-line transition-shadow placeholder:text-faint focus:ring-2 focus:ring-primary focus:outline-none"
                />

                <div className="mt-5 flex items-center justify-end gap-2.5">
                  <Button variant="ghost" onClick={() => setFixing(false)}>
                    Cancel
                  </Button>
                  <Button
                    disabled={!fixNote.trim() && (fixMode === 'refine' || Boolean(fixScreen))}
                    onClick={() => {
                      setFixing(false)
                      void runRepair(fixNote.trim(), fixMode, fixScreen || undefined)
                    }}
                  >
                    <Wrench className="size-4" />
                    {fixMode === 'fix' ? 'Fix it' : 'Refine it'}
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  )
}
