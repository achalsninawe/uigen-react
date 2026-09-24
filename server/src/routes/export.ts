import archiver from 'archiver'
import { Router } from 'express'
import { asyncRoute, badRequest, param, serverOrigin } from '../http.js'
import { ownedProject } from './auth.js'
import { reemitForTarget, type EmitContext } from '../services/emit/index.js'

export const exportRouter = Router()

/** A filename someone can find again, from whatever they named the project. */
function zipName(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'app'
  return `${slug}.zip`
}

/**
 * Downloads the generated app as a ZIP.
 *
 * The files in storage were emitted for the preview, which relays its calls
 * through this server. A build that leaves has no such relay, so the
 * transport-dependent files are re-emitted for the chosen target before they
 * are archived — including, for `bff`, the app's own small server.
 *
 * Screens are never regenerated here: re-emitting touches only the files whose
 * content depends on the target, so an export is deterministic and costs
 * nothing.
 */
exportRouter.get(
  '/:id/export',
  asyncRoute(async (req, res) => {
    const project = await ownedProject(req, param(req, 'id'))

    if (!project.appSpec) throw badRequest('Run the analysis before exporting')
    if (!project.plan || project.files.length === 0) throw badRequest('Generate the app before exporting')

    const wanted = req.query.transport
    if (wanted !== undefined && wanted !== 'bff' && wanted !== 'direct') {
      throw badRequest('transport must be "bff" or "direct"')
    }

    /*
     * An app with no documented endpoints makes no calls, so there is nothing
     * for a server to forward and asking for one would only emit a server that
     * sits idle.
     */
    const transport: EmitContext['transport'] =
      project.appSpec.endpoints.length === 0 ? 'direct' : ((wanted as 'bff' | 'direct' | undefined) ?? 'bff')

    const files = reemitForTarget(project.files, project.appSpec, project.plan, {
      projectId: project.id,
      transport,
      serverOrigin: serverOrigin(req as never),
      // Carried into the exported config, or a build made from a document that
      // never named a host would leave the studio unable to reach anything.
      ...(project.connection.baseUrlOverride
        ? { baseUrlOverride: project.connection.baseUrlOverride }
        : {}),
    })

    const root = zipName(project.name).replace(/\.zip$/, '')

    /*
     * Nothing is written to disk and nothing is buffered whole: the archive
     * streams straight to the response. Failures are therefore only reportable
     * before the first byte leaves, which is why the checks above come first.
     */
    const archive = archiver('zip', { zlib: { level: 9 } })

    archive.on('warning', (err) => {
      console.warn('[spec2ui] export warning:', err.message)
    })
    archive.on('error', (err: Error) => {
      console.error('[spec2ui] export failed:', err)
      // The headers are already out by now, so the only honest signal left is
      // an incomplete download rather than a ZIP that unpacks to nonsense.
      res.destroy(err)
    })

    res.attachment(zipName(project.name))
    archive.pipe(res)

    for (const file of files) {
      archive.append(file.content, { name: `${root}/${file.path}` })
    }

    await archive.finalize()
  }),
)
