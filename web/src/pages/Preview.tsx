import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { PreviewPane } from '@/components/PreviewPane'
import { api } from '@/lib/api'
import type { Project } from '@/lib/types'

/**
 * The generated app, in a window of its own.
 *
 * A real page rather than a popup of the built bundle, because the preview
 * cannot reach the API by itself — it posts each call to whichever window hosts
 * it, and only a studio page knows how to relay that. Being a route also means
 * it is behind the same sign-in as everything else.
 */
export default function Preview() {
  const { id = '' } = useParams<{ id: string }>()
  // Opened by Run demo: play the journey with sample data, then close.
  const [params] = useSearchParams()
  const demo = params.get('demo') === '1'
  // Opened by Record demo: the same run, recorded to a video the window offers at the end.
  const record = demo && params.get('record') === '1'
  // Opened by Record myself: the person drives the app while the tab records.
  const recordSelf = params.get('record') === 'self'
  const [project, setProject] = useState<Project | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    api
      .getProject(id)
      .then(setProject)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the project'))
  }, [id])

  useEffect(() => {
    if (project) document.title = `${project.name} — ${demo ? 'demo' : 'preview'}`
  }, [project, demo])

  if (error) {
    return (
      <div className="grid min-h-dvh place-items-center p-6">
        <p className="text-[13.5px] text-muted">{error}</p>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <div className="size-5 animate-spin rounded-full border-2 border-line border-t-primary" />
      </div>
    )
  }

  if (project.files.length === 0) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div>
          <p className="text-[14px] font-semibold text-ink">Nothing generated yet</p>
          <p className="mt-1 text-[13px] text-muted">Generate the app in the studio, then reopen this window.</p>
        </div>
      </div>
    )
  }

  // Nothing around it: the window is the app. The project name is on the tab,
  // which is where a window's own label belongs.
  return <PreviewPane files={project.files} projectId={id} standalone appSpec={project.appSpec} autoDemo={demo} recordDemo={record} recordSelf={recordSelf} />
}
