import { customAlphabet } from 'nanoid'
import { storage } from './blobs.js'
import { parseFile } from './parsers/index.js'
import type { GeneratedFile, Project, ProjectSummary, SpecDocument, User } from '../types.js'

/** URL-safe, lowercase, unambiguous — these ids end up in published URLs. */
export const newId = customAlphabet('23456789abcdefghijkmnpqrstuvwxyz', 12)

const projectKey = (id: string) => `${id}/project.json`
const fileKey = (id: string, path: string) => `${id}/${path}`

function summarise(project: Project): ProjectSummary {
  return {
    id: project.id,
    ownerId: project.ownerId,
    name: project.name,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    documentCount: project.documents.length,
    endpointCount: project.appSpec?.endpoints.length ?? 0,
    screenCount: project.plan?.screens.length ?? 0,
    ...(project.savedAt ? { savedAt: project.savedAt } : {}),
    ...(project.publish ? { published: project.publish.url } : {}),
  }
}

/**
 * Generated file contents live as individual blobs rather than inside
 * project.json — so a single regenerated screen is a one-blob write, and the
 * manifest stays small enough to read on every request.
 *
 * `documents[].openapi` is never persisted: dereferencing produces a cyclic
 * object graph that JSON.stringify cannot handle, and it is fully re-derivable
 * from the document text, which is stored. It is rehydrated on read.
 */
type StoredProject = Omit<Project, 'files' | 'documents'> & {
  files: Omit<GeneratedFile, 'content'>[]
  documents: Omit<SpecDocument, 'openapi'>[]
}

async function rehydrate(documents: Omit<SpecDocument, 'openapi'>[]): Promise<SpecDocument[]> {
  return Promise.all(
    documents.map(async (doc): Promise<SpecDocument> => {
      if (doc.kind !== 'openapi' || !doc.text) return doc
      const parsed = await parseFile(doc.filename, Buffer.from(doc.text, 'utf8'))
      return parsed.openapi ? { ...doc, openapi: parsed.openapi } : doc
    }),
  )
}

export const users = {
  async create(email: string, name: string, passwordHash: string): Promise<User> {
    const user: User = {
      id: newId(),
      email,
      name: name.trim() || email.split('@')[0]!,
      passwordHash,
      createdAt: new Date().toISOString(),
    }
    await storage().putUser(user)
    return user
  },

  byId: (id: string) => storage().getUser(id),
  byEmail: (email: string) => storage().getUserByEmail(email),
}

/** The account as the browser is allowed to see it — never the hash. */
export const publicUser = ({ id, email, name, createdAt }: User) => ({ id, email, name, createdAt })

export const store = {
  async create(name: string, ownerId: string): Promise<Project> {
    const now = new Date().toISOString()
    const project: Project = {
      id: newId(),
      ownerId,
      name,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      documents: [],
      files: [],
      connection: { extraHeaders: {} },
    }
    await store.save(project)
    return project
  },

  async save(project: Project): Promise<Project> {
    project.updatedAt = new Date().toISOString()
    const s = storage()

    // Split contents out of the manifest and write each file blob.
    const manifest: StoredProject = {
      ...project,
      files: project.files.map(({ content: _content, ...meta }) => meta),
      documents: project.documents.map(({ openapi: _openapi, ...doc }) => doc),
    }

    await Promise.all([
      s.put('artifacts', projectKey(project.id), JSON.stringify(manifest, null, 2)),
      ...project.files.map((f) => s.put('generated', fileKey(project.id, f.path), f.content)),
      s.upsertSummary(summarise(project)),
    ])

    return project
  },

  /** Persists one generated file without rewriting every other blob. */
  async saveFile(projectId: string, file: GeneratedFile): Promise<void> {
    await storage().put('generated', fileKey(projectId, file.path), file.content)
  },

  async get(id: string): Promise<Project | null> {
    const raw = await storage().getText('artifacts', projectKey(id))
    if (!raw) return null

    const manifest = JSON.parse(raw) as StoredProject
    const [files, documents] = await Promise.all([
      Promise.all(
        manifest.files.map(async (meta): Promise<GeneratedFile> => {
          const content = await storage().getText('generated', fileKey(id, meta.path))
          return { ...meta, content: content ?? '' }
        }),
      ),
      rehydrate(manifest.documents),
    ])
    return { ...manifest, files, documents }
  },

  /** Manifest only — skips downloading every generated file. */
  async getMeta(id: string): Promise<Project | null> {
    const raw = await storage().getText('artifacts', projectKey(id))
    if (!raw) return null
    const manifest = JSON.parse(raw) as StoredProject
    // Metadata callers never touch schemas, so skip the OpenAPI re-parse.
    return { ...manifest, files: manifest.files.map((m) => ({ ...m, content: '' })) }
  },

  /** Only what the person chose to save, most recently saved first. */
  async list(ownerId: string): Promise<ProjectSummary[]> {
    const rows = await storage().listSummaries(ownerId)
    return rows
      .filter((row) => Boolean(row.savedAt))
      .sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''))
  },

  /**
   * Whether this account already has a project under that name.
   *
   * Scoped to the owner: two people naming their own work "Claims" is not a
   * collision, and making it one would leak that the other name exists.
   */
  async nameTaken(ownerId: string, name: string, exceptId?: string): Promise<boolean> {
    const wanted = name.trim().toLowerCase()
    const rows = await storage().listSummaries(ownerId)
    return rows.some(
      (row) =>
        // Only saved projects hold a name. A draft nobody kept is invisible, and
        // being refused a name by something you cannot see is baffling.
        Boolean(row.savedAt) && row.id !== exceptId && row.name.trim().toLowerCase() === wanted,
    )
  },

  /**
   * A name nobody on this account is using yet.
   *
   * Uploading the same documents twice is normal, and two projects called
   * "Claims" are indistinguishable in a list, so the second becomes "Claims 2".
   */
  async availableName(ownerId: string, preferred: string): Promise<string> {
    const base = preferred.trim() || 'Untitled project'
    if (!(await store.nameTaken(ownerId, base))) return base
    for (let n = 2; n < 500; n++) {
      const candidate = `${base} ${n}`
      if (!(await store.nameTaken(ownerId, candidate))) return candidate
    }
    return `${base} ${Date.now()}`
  },

  async remove(id: string): Promise<void> {
    const s = storage()
    await Promise.all([
      s.removePrefix('artifacts', `${id}/`),
      s.removePrefix('generated', `${id}/`),
      s.removePrefix('specs', `${id}/`),
      s.removePrefix('exports', `${id}/`),
      s.removeSummary(id),
    ])
  },
}
