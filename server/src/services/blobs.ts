import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob'
import { TableClient, TableServiceClient, odata } from '@azure/data-tables'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import type { ProjectSummary, User } from '../types.js'

/**
 * Logical buckets. Azure maps each to a container named `<prefix>-<bucket>`;
 * the local fallback maps each to a folder under WORK_DIR/storage.
 */
export type Bucket = 'specs' | 'artifacts' | 'generated' | 'exports'
const BUCKETS: Bucket[] = ['specs', 'artifacts', 'generated', 'exports']

export interface Storage {
  readonly kind: 'azure' | 'local'
  init(): Promise<void>
  put(bucket: Bucket, key: string, body: Buffer | string, contentType?: string): Promise<void>
  get(bucket: Bucket, key: string): Promise<Buffer | null>
  getText(bucket: Bucket, key: string): Promise<string | null>
  list(bucket: Bucket, prefix: string): Promise<string[]>
  remove(bucket: Bucket, key: string): Promise<void>
  removePrefix(bucket: Bucket, prefix: string): Promise<void>
  /** Project index — a Table in Azure, a JSON file locally. */
  upsertSummary(summary: ProjectSummary): Promise<void>
  /**
   * Projects belonging to one account.
   *
   * `ownerId` is required rather than optional on purpose: an unfiltered listing
   * would show every account's work to whoever asked first, and a parameter you
   * have to pass is one you cannot forget to pass.
   */
  listSummaries(ownerId: string): Promise<ProjectSummary[]>
  removeSummary(id: string): Promise<void>
  /** Accounts. Stored beside the project index, not in a blob. */
  putUser(user: User): Promise<void>
  getUser(id: string): Promise<User | null>
  getUserByEmail(email: string): Promise<User | null>
}

/** Email -> id, so a sign-in is a direct read rather than a table scan. */
const emailKey = (email: string) => Buffer.from(email, 'utf8').toString('base64url')

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
}

export function contentTypeFor(key: string): string {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] ?? 'application/octet-stream'
}

/* ------------------------------------------------------------------ */
/* Azure                                                               */
/* ------------------------------------------------------------------ */

class AzureStorage implements Storage {
  readonly kind = 'azure' as const
  private readonly blobService: BlobServiceClient
  private readonly containers = new Map<Bucket, ContainerClient>()
  private readonly tableName: string
  private table!: TableClient
  private ready?: Promise<void>

  constructor(
    private readonly connectionString: string,
    private readonly prefix: string,
  ) {
    this.blobService = BlobServiceClient.fromConnectionString(connectionString)
    // Table names must be alphanumeric, so the prefix's dashes are stripped.
    this.tableName = `${prefix.replace(/[^a-z0-9]/gi, '')}projects`
  }

  private containerName(bucket: Bucket) {
    return `${this.prefix}-${bucket}`
  }

  init(): Promise<void> {
    this.ready ??= (async () => {
      await Promise.all(
        BUCKETS.map(async (bucket) => {
          const client = this.blobService.getContainerClient(this.containerName(bucket))
          await client.createIfNotExists()
          this.containers.set(bucket, client)
        }),
      )
      const tableService = TableServiceClient.fromConnectionString(this.connectionString)
      await tableService.createTable(this.tableName).catch((err: { statusCode?: number }) => {
        if (err?.statusCode !== 409) throw err
      })
      this.table = TableClient.fromConnectionString(this.connectionString, this.tableName)
    })()
    return this.ready
  }

  private async container(bucket: Bucket): Promise<ContainerClient> {
    await this.init()
    const client = this.containers.get(bucket)
    if (!client) throw new Error(`unknown bucket ${bucket}`)
    return client
  }

  async put(bucket: Bucket, key: string, body: Buffer | string, contentType?: string) {
    const client = await this.container(bucket)
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    await client.getBlockBlobClient(key).uploadData(buf, {
      blobHTTPHeaders: { blobContentType: contentType ?? contentTypeFor(key) },
    })
  }

  async get(bucket: Bucket, key: string): Promise<Buffer | null> {
    const client = await this.container(bucket)
    try {
      return await client.getBlockBlobClient(key).downloadToBuffer()
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null
      throw err
    }
  }

  async getText(bucket: Bucket, key: string) {
    const buf = await this.get(bucket, key)
    return buf ? buf.toString('utf8') : null
  }

  async list(bucket: Bucket, prefix: string) {
    const client = await this.container(bucket)
    const keys: string[] = []
    for await (const blob of client.listBlobsFlat({ prefix })) keys.push(blob.name)
    return keys
  }

  async remove(bucket: Bucket, key: string) {
    const client = await this.container(bucket)
    await client.getBlockBlobClient(key).deleteIfExists()
  }

  async removePrefix(bucket: Bucket, prefix: string) {
    const client = await this.container(bucket)
    const keys = await this.list(bucket, prefix)
    await Promise.all(keys.map((k) => client.getBlockBlobClient(k).deleteIfExists()))
  }

  async upsertSummary(summary: ProjectSummary) {
    await this.init()
    await this.table.upsertEntity({ partitionKey: 'project', rowKey: summary.id, ...summary }, 'Replace')
  }

  async listSummaries(ownerId: string): Promise<ProjectSummary[]> {
    await this.init()
    const rows: ProjectSummary[] = []
    const iter = this.table.listEntities<ProjectSummary & { partitionKey: string; rowKey: string }>({
      queryOptions: { filter: odata`PartitionKey eq 'project' and ownerId eq ${ownerId}` },
    })
    for await (const row of iter) {
      const { partitionKey: _p, rowKey: _r, ...rest } = row
      rows.push(rest as unknown as ProjectSummary)
    }
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async removeSummary(id: string) {
    await this.init()
    await this.table.deleteEntity('project', id).catch((err: { statusCode?: number }) => {
      if (err?.statusCode !== 404) throw err
    })
  }

  async putUser(user: User) {
    await this.init()
    await Promise.all([
      this.table.upsertEntity({ partitionKey: 'user', rowKey: user.id, ...user }, 'Replace'),
      this.table.upsertEntity(
        { partitionKey: 'useremail', rowKey: emailKey(user.email), userId: user.id },
        'Replace',
      ),
    ])
  }

  async getUser(id: string): Promise<User | null> {
    await this.init()
    try {
      const row = await this.table.getEntity<User & { partitionKey: string; rowKey: string }>('user', id)
      const { partitionKey: _p, rowKey: _r, ...rest } = row
      return rest as unknown as User
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode === 404) return null
      throw err
    }
  }

  async getUserByEmail(email: string): Promise<User | null> {
    await this.init()
    try {
      const row = await this.table.getEntity<{ userId: string }>('useremail', emailKey(email))
      return row.userId ? this.getUser(row.userId) : null
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode === 404) return null
      throw err
    }
  }
}

/* ------------------------------------------------------------------ */
/* Local filesystem fallback — keeps the app usable with no cloud creds */
/* ------------------------------------------------------------------ */

class LocalStorage implements Storage {
  readonly kind = 'local' as const
  private readonly root = path.join(config.workDir, 'storage')
  private readonly indexPath = path.join(config.workDir, 'storage', 'projects.json')

  private file(bucket: Bucket, key: string) {
    return path.join(this.root, bucket, key)
  }

  async init() {
    await Promise.all(BUCKETS.map((b) => fs.mkdir(path.join(this.root, b), { recursive: true })))
  }

  async put(bucket: Bucket, key: string, body: Buffer | string) {
    const target = this.file(bucket, key)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, typeof body === 'string' ? Buffer.from(body, 'utf8') : body)
  }

  async get(bucket: Bucket, key: string) {
    return fs.readFile(this.file(bucket, key)).catch(() => null)
  }

  async getText(bucket: Bucket, key: string) {
    const buf = await this.get(bucket, key)
    return buf ? buf.toString('utf8') : null
  }

  async list(bucket: Bucket, prefix: string) {
    const base = path.join(this.root, bucket)
    const out: string[] = []
    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else out.push(path.relative(base, full).split(path.sep).join('/'))
      }
    }
    await walk(base)
    return out.filter((k) => k.startsWith(prefix))
  }

  async remove(bucket: Bucket, key: string) {
    await fs.rm(this.file(bucket, key), { force: true })
  }

  async removePrefix(bucket: Bucket, prefix: string) {
    for (const key of await this.list(bucket, prefix)) await this.remove(bucket, key)
  }

  private async readIndex(): Promise<ProjectSummary[]> {
    const raw = await fs.readFile(this.indexPath, 'utf8').catch(() => null)
    if (!raw) return []
    try {
      return JSON.parse(raw) as ProjectSummary[]
    } catch {
      return []
    }
  }

  async upsertSummary(summary: ProjectSummary) {
    await this.init()
    const rows = (await this.readIndex()).filter((r) => r.id !== summary.id)
    rows.push(summary)
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    await fs.writeFile(this.indexPath, JSON.stringify(rows, null, 2))
  }

  async listSummaries(ownerId: string) {
    return (await this.readIndex()).filter((row) => row.ownerId === ownerId)
  }

  async removeSummary(id: string) {
    const rows = (await this.readIndex()).filter((r) => r.id !== id)
    await fs.writeFile(this.indexPath, JSON.stringify(rows, null, 2))
  }

  private get usersPath() {
    return path.join(this.root, 'users.json')
  }

  private async readUsers(): Promise<User[]> {
    try {
      return JSON.parse(await fs.readFile(this.usersPath, 'utf8')) as User[]
    } catch {
      return []
    }
  }

  async putUser(user: User) {
    await this.init()
    const users = (await this.readUsers()).filter((u) => u.id !== user.id && u.email !== user.email)
    users.push(user)
    await fs.writeFile(this.usersPath, JSON.stringify(users, null, 2), { mode: 0o600 })
  }

  async getUser(id: string) {
    return (await this.readUsers()).find((u) => u.id === id) ?? null
  }

  async getUserByEmail(email: string) {
    return (await this.readUsers()).find((u) => u.email === email) ?? null
  }
}

let instance: Storage | null = null

export function storage(): Storage {
  instance ??= config.storage.isConfigured
    ? new AzureStorage(config.storage.connectionString, config.storage.prefix)
    : new LocalStorage()
  return instance
}

/** Exposed for the publish flow, which needs the raw blob service. */
export function blobService(): BlobServiceClient {
  if (!config.storage.isConfigured) throw new Error('Azure Storage is not configured')
  return BlobServiceClient.fromConnectionString(config.storage.connectionString)
}
