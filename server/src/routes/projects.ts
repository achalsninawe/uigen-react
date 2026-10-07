import { Router } from 'express'
import { reemitStyle } from '../services/emit/index.js'
import multer from 'multer'
import path from 'node:path'
import { asyncRoute, badRequest, notFound, param } from '../http.js'
import { ownedProject, ownedProjectMeta, ownerOf } from './auth.js'
import { storage } from '../services/blobs.js'
import { newId, store } from '../services/store.js'
import { parseFile } from '../services/parsers/index.js'
import { aiAvailable } from '../services/azure.js'
import { extractBrandTheme } from '../services/brand.js'
import { toWireProject } from '../serialize.js'
import { ROOT_SIZE, type SpecDocument, type TextSize } from '../types.js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
})

export const projectsRouter = Router()

/** Derives a friendly project name from the uploaded filenames. */
function deriveName(filenames: string[]): string {
  const first = filenames[0]
  if (!first) return 'Untitled project'
  const base = path
    .basename(first, path.extname(first))
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
  const label = base || 'Untitled project'
  return filenames.length > 1 ? `${label} +${filenames.length - 1}` : label
}

projectsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    res.json({ projects: await store.list(ownerOf(req)) })
  }),
)

projectsRouter.post(
  '/',
  upload.array('files', 20),
  asyncRoute(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    if (files.length === 0) throw badRequest('Upload at least one spec file')

    await storage().init()
    const owner = ownerOf(req)

    /*
     * A name the person chose is honoured or refused, never altered.
     *
     * Silently saving their "Freelook" as "Freelook 2" is how you end up unable
     * to find either. Where no name was given there is no intent to contradict,
     * so the name derived from the filenames gets a suffix instead of an error.
     */
    const chosen = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (chosen && (await store.nameTaken(owner, chosen))) {
      throw badRequest(`You already have a project called "${chosen}". Pick another name.`)
    }

    const name = chosen || (await store.availableName(owner, deriveName(files.map((f) => f.originalname))))
    const project = await store.create(name, owner)
    project.status = 'parsing'
    // Multipart fields arrive as strings.
    project.sampleData = req.body?.sampleData === 'true'

    const documents: SpecDocument[] = []
    for (const file of files) {
      const id = newId()
      const blobPath = `${project.id}/${id}-${file.originalname}`
      await storage().put('specs', blobPath, file.buffer)

      const parsed = await parseFile(file.originalname, file.buffer)
      documents.push({
        id,
        filename: file.originalname,
        kind: parsed.kind,
        bytes: file.size,
        blobPath,
        text: parsed.text,
        ...(parsed.openapi ? { openapi: parsed.openapi } : {}),
        ...(parsed.postman ? { postman: parsed.postman } : {}),
        ...(parsed.error ? { parseError: parsed.error } : {}),
        uploadedAt: new Date().toISOString(),
      })
    }

    project.documents = documents
    project.status = documents.every((d) => d.parseError && !d.text) ? 'failed' : 'parsed'
    if (project.status === 'failed') project.error = 'None of the uploaded files could be read'

    await store.save(project)
    res.status(201).json({ project: toWireProject(project) })
  }),
)

projectsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const project = await ownedProject(req, param(req, 'id'))
    res.json({ project: toWireProject(project) })
  }),
)

/** Returns the parsed text of one uploaded document. */
projectsRouter.get(
  '/:id/documents/:docId',
  asyncRoute(async (req, res) => {
    const project = await ownedProjectMeta(req, param(req, 'id'))
    const doc = project.documents.find((d) => d.id === param(req, 'docId'))
    if (!doc) throw notFound('Document not found')
    res.json({ document: doc })
  }),
)

projectsRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const project = await ownedProject(req, param(req, 'id'))

    const body = req.body as {
      name?: string
      connection?: Partial<typeof project.connection>
      sampleData?: boolean
      generator?: 'classic' | 'ai'
      accent?: string
      textSize?: TextSize
    }
    if (typeof body.name === 'string' && body.name.trim()) {
      const wanted = body.name.trim()
      if (await store.nameTaken(project.ownerId, wanted, project.id)) {
        throw badRequest('You already have a project with that name')
      }
      project.name = wanted
    }
    if (body.connection) project.connection = { ...project.connection, ...body.connection }
    if (typeof body.sampleData === 'boolean') project.sampleData = body.sampleData
    if (body.generator === 'classic' || body.generator === 'ai') project.generator = body.generator
    if (body.accent !== undefined) {
      if (typeof body.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(body.accent)) {
        throw badRequest('The colour must look like #2563EB')
      }
      project.accent = body.accent
      if (project.plan) project.plan.theme.accent = body.accent
    }
    if (body.textSize !== undefined) {
      if (!(body.textSize in ROOT_SIZE)) throw badRequest('Text size must be small, default or large')
      project.textSize = body.textSize
      if (project.plan) {
        if (body.textSize === 'default') delete project.plan.theme.rootSize
        else project.plan.theme.rootSize = ROOT_SIZE[body.textSize]
      }
    }
    /*
     * Every colour is mixed from one token and every size is relative to one
     * root, so re-emitting the style files restyles every screen without
     * touching any of them.
     */
    if ((body.accent !== undefined || body.textSize !== undefined) && project.plan && project.appSpec) {
      project.files = reemitStyle(project.files, project.appSpec, project.plan)
    }

    await store.save(project)
    res.json({ project: toWireProject(project) })
  }),
)

/**
 * Reads a brand theme out of uploaded style files — CSS, SCSS, design tokens,
 * a Markdown or text brand guide, HTML, PDF, DOCX.
 *
 * Only the extracted theme is kept, not the files: they are style, not
 * specification, and must never reach the analysis as if they described the
 * app. Applies on the next generate.
 */
projectsRouter.post(
  '/:id/theme',
  upload.array('files', 5),
  asyncRoute(async (req, res) => {
    const project = await ownedProject(req, param(req, 'id'))
    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    if (files.length === 0) throw badRequest('Upload a theme file')
    if (!aiAvailable()) throw badRequest('Reading a theme needs Azure OpenAI — set AZURE_OPENAI_API_KEY in .env')

    const documents = []
    for (const file of files) {
      const parsed = await parseFile(file.originalname, file.buffer)
      if (parsed.text.trim()) documents.push({ filename: file.originalname, text: parsed.text })
    }
    if (documents.length === 0) throw badRequest('Could not read any text from the theme file')

    try {
      project.brandTheme = await extractBrandTheme(documents)
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : 'Could not read a theme from that file')
    }
    await store.save(project)
    res.json({ project: toWireProject(project) })
  }),
)

projectsRouter.delete(
  '/:id/theme',
  asyncRoute(async (req, res) => {
    const project = await ownedProject(req, param(req, 'id'))
    delete project.brandTheme
    await store.save(project)
    res.json({ project: toWireProject(project) })
  }),
)

/**
 * Keeps this project, under a name, dated now.
 *
 * Separate from PATCH because it is a different act: PATCH adjusts a project
 * that already exists in someone's list, while this is the moment they decide
 * it belongs there at all. Saving again re-stamps the date, so the list orders
 * by when you last chose to keep something.
 */
projectsRouter.post(
  '/:id/save',
  asyncRoute(async (req, res) => {
    const project = await ownedProject(req, param(req, 'id'))

    const body = (req.body ?? {}) as { name?: string }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw badRequest('Give the project a name')
    if (name.length > 120) throw badRequest('That name is too long')

    if (await store.nameTaken(project.ownerId, name, project.id)) {
      throw badRequest(`You already have a project called "${name}". Pick another name.`)
    }

    project.name = name
    project.savedAt = new Date().toISOString()
    await store.save(project)

    res.json({ project: toWireProject(project) })
  }),
)

projectsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    // Proves ownership before deleting; an unguarded delete by id would let
    // anyone remove anyone's work.
    const project = await ownedProjectMeta(req, param(req, 'id'))
    await store.remove(project.id)
    res.status(204).end()
  }),
)
