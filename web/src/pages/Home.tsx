import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Trash2 } from 'lucide-react'
import { TopBar } from '@/components/TopBar'
import { Dropzone } from '@/components/Dropzone'
import { api } from '@/lib/api'
import type { ProjectSummary } from '@/lib/types'

const rise = {
  hidden: { opacity: 0, y: 14 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 0.06 * i, duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
  }),
}

export default function Home() {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(files: File[], name: string, sampleData: boolean) {
    setBusy(true)
    setError(null)
    try {
      const project = await api.createProject(files, name, sampleData)
      // The project page starts the analysis itself, so the upload returns fast.
      navigate(`/p/${project.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
      setBusy(false)
    }
  }

  return (
    <div className="min-h-dvh">
      <TopBar />

      <main className="mx-auto max-w-2xl px-6 pt-20 pb-24">
        <motion.div initial="hidden" animate="show" className="text-center">
          <motion.span
            variants={rise}
            custom={0}
            className="inline-flex items-center gap-2 rounded-full bg-surface px-3.5 py-1.5 text-[12px] font-semibold text-muted ring-1 ring-line"
          >
            <span className="size-1.5 rounded-full bg-mint" />
            reads your docs, writes the real thing
          </motion.span>

          <motion.h1
            variants={rise}
            custom={1}
            className="mt-6 text-[40px] leading-[1.1] font-bold tracking-tight text-ink"
          >
            Turn specs into
            <br />
            <span className="gradient-text">real interfaces</span>
          </motion.h1>

          <motion.p variants={rise} custom={2} className="mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-muted">
            Drop in your user flows and API docs. Spec2UI reads them, pulls out every endpoint exactly as written, and
            builds a React app wired to them.
          </motion.p>
        </motion.div>

        <motion.div variants={rise} custom={3} initial="hidden" animate="show" className="mt-12">
          <Dropzone busy={busy} onSubmit={handleSubmit} />

          {error && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 rounded-xl bg-rose-soft px-4 py-3 text-center text-[13px] font-medium text-rose"
            >
              {error}
            </motion.p>
          )}
        </motion.div>

        <SavedProjects />
      </main>
    </div>
  )
}

/** Relative for anything recent, absolute once "3 days ago" stops helping. */
function when(iso: string): string {
  const then = new Date(iso)
  const minutes = Math.round((Date.now() - then.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / (60 * 24))}d ago`
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * The account's own saved projects.
 *
 * Generating an app takes minutes, so the work is worth returning to — and
 * before this list existed the only way back was a URL nobody had kept.
 */
function SavedProjects() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .listProjects()
      .then(setProjects)
      .catch(() => setProjects([]))
  }, [])

  useEffect(() => load(), [load])

  async function remove(id: string, name: string) {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return
    setRemoving(id)
    try {
      await api.deleteProject(id)
      setProjects((prev) => prev?.filter((p) => p.id !== id) ?? null)
    } finally {
      setRemoving(null)
    }
  }

  if (!projects || projects.length === 0) return null

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.25, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="mt-14"
    >
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold text-ink">Your projects</h2>
        <span className="text-[12px] text-muted">{projects.length} saved</span>
      </div>

      <ul className="divide-y divide-line-soft overflow-hidden rounded-2xl bg-white ring-1 ring-line">
        {projects.map((project) => (
          <li key={project.id} className="group flex items-center gap-3 px-4 py-3">
            <button
              type="button"
              onClick={() => navigate(`/p/${project.id}`)}
              className="min-w-0 flex-1 text-left"
            >
              <p className="truncate text-[13.5px] font-semibold text-ink group-hover:text-primary">
                {project.name}
              </p>
              <p className="mt-0.5 text-[12px] text-muted">
                {when(project.savedAt ?? project.updatedAt)}
                {project.screenCount > 0 && ` · ${project.screenCount} screens`}
                {project.endpointCount > 0 && ` · ${project.endpointCount} endpoints`}
              </p>
            </button>

            <button
              type="button"
              onClick={() => void remove(project.id, project.name)}
              disabled={removing === project.id}
              aria-label={`Delete ${project.name}`}
              className="rounded-lg p-2 text-faint opacity-0 transition-all group-hover:opacity-100 hover:bg-rose-soft hover:text-rose focus-visible:opacity-100 disabled:opacity-40"
            >
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
      </ul>
    </motion.section>
  )
}
