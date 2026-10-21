import { MemoryVfs } from '../../../packages/experimental/webworker-runtime/src/storage/memory.ts'
import type {
  VfsMutation,
  VfsMutationSink,
  VfsSeedOptions,
} from '../../../packages/experimental/webworker-runtime/src/storage/types.ts'
import { publishBrowserNativeWorkspaceStatus } from './browser-native-control.ts'

const PROTOCOL_VERSION = 1
const WORKSPACE_ROOT = '/dsh/home/workspace'
const WORKSPACE_API = '/api/browser-native/workspace'
const SYNC_DEBOUNCE_MS = 100

interface WorkspaceEntry {
  readonly path: string
  readonly kind: 'directory' | 'file'
  readonly mode: number
  readonly hash?: string
  readonly bytes?: number
}

interface WorkspaceManifest {
  readonly workspaceId: string
  readonly revision: number
  readonly entries: readonly WorkspaceEntry[]
}

interface WorkspaceChange {
  readonly path: string
  readonly deleted?: true
  readonly kind?: 'directory' | 'file'
  readonly mode?: number
  readonly hash?: string
  readonly bytes?: number
  readonly content?: Uint8Array
}

interface PendingBatch {
  readonly operationId: string
  readonly baseRevision: number
  readonly changes: readonly WorkspaceChange[]
}

type WorkspaceStatus = 'loading' | 'synced' | 'dirty' | 'syncing' | 'error' | 'conflict'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertWorkspacePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512
    || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error('browser-native workspace: invalid manifest path')
  }
  if (value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('browser-native workspace: invalid manifest path segment')
  }
  return value
}

function isAtomicWriteStagingPath(path: string): boolean {
  return path.split('/').some(segment => /^\..+\.\d+\.[0-9a-f-]{36}\.tmpdir$/i.test(segment))
}

function manifestEntries(value: unknown): WorkspaceEntry[] {
  if (!Array.isArray(value)) throw new Error('browser-native workspace: manifest entries must be an array')
  const paths = new Set<string>()
  return value.map((item: unknown): WorkspaceEntry => {
    if (!isRecord(item)) throw new Error('browser-native workspace: manifest entry must be an object')
    const path = assertWorkspacePath(item.path)
    if (paths.has(path)) throw new Error(`browser-native workspace: duplicate manifest path ${path}`)
    paths.add(path)
    if (!Number.isSafeInteger(item.mode) || typeof item.mode !== 'number' || item.mode < 0 || item.mode > 0o777) {
      throw new Error(`browser-native workspace: invalid mode for ${path}`)
    }
    if (item.kind === 'directory') return { path, kind: 'directory', mode: item.mode }
    if (item.kind !== 'file' || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)
      || typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 0) {
      throw new Error(`browser-native workspace: invalid file entry for ${path}`)
    }
    return { path, kind: 'file', mode: item.mode, hash: item.hash, bytes: item.bytes }
  }).sort((left, right) => left.path.localeCompare(right.path))
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json()
  if (!isRecord(value)) throw new Error('browser-native workspace: backend returned a non-object response')
  if (!response.ok) {
    const error = isRecord(value.error) ? value.error : {}
    throw Object.assign(new Error(typeof error.message === 'string' ? error.message : 'Workspace request failed'), {
      code: typeof error.code === 'string' ? error.code : 'WORKSPACE_REQUEST_FAILED',
      details: error.details,
    })
  }
  return value
}

function statusMessage(
  state: WorkspaceStatus,
  workspaceId: string | undefined,
  revision: number | undefined,
  dirtyCount: number,
  message?: string,
): void {
  publishBrowserNativeWorkspaceStatus({
    type: 'workspace',
    state,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(revision === undefined ? {} : { revision }),
    dirtyCount,
    ...(message === undefined ? {} : { message }),
  })
}

class BrowserNativeWorkspaceMirror implements VfsMutationSink {
  private readonly pending = new Map<string, WorkspaceChange>()
  private readonly knownBlobHashes = new Set<string>()
  private readonly knownPaths = new Set<string>()
  private vfs: MemoryVfs | undefined
  private workspaceId: string | undefined
  private revision: number | undefined
  private ready = false
  private blocked = false
  private failure: { readonly state: 'error' | 'conflict'; readonly message: string } | undefined
  private retryBatch: PendingBatch | undefined
  private running: Promise<void> | undefined
  private scheduleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly onStatus = statusMessage) {}

  async prepare(vfs: MemoryVfs): Promise<void> {
    this.vfs = vfs
    this.onStatus('loading', undefined, undefined, 0)
    try {
      const identityResponse = await fetch(`${WORKSPACE_API}/identity`, { credentials: 'same-origin' })
      const identity = await readJson(identityResponse)
      if (typeof identity.workspaceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(identity.workspaceId)) {
        throw new Error('browser-native workspace: identity response omitted a workspace id')
      }
      this.workspaceId = identity.workspaceId
      const manifestResponse = await fetch(
        `${WORKSPACE_API}/manifest?protocolVersion=${String(PROTOCOL_VERSION)}&workspaceId=${encodeURIComponent(this.workspaceId)}`,
        { credentials: 'same-origin' },
      )
      const rawManifest = await readJson(manifestResponse)
      if (rawManifest.workspaceId !== this.workspaceId || !Number.isSafeInteger(rawManifest.revision)
        || typeof rawManifest.revision !== 'number' || rawManifest.revision < 0) {
        throw new Error('browser-native workspace: backend returned an invalid manifest')
      }
      const manifest: WorkspaceManifest = {
        workspaceId: this.workspaceId,
        revision: rawManifest.revision,
        entries: manifestEntries(rawManifest.entries),
      }
      this.knownPaths.clear()
      for (const entry of manifest.entries) this.knownPaths.add(entry.path)
      this.clearWorkspace(vfs)
      const directories = manifest.entries.filter(entry => entry.kind === 'directory')
        .map(entry => ({ entry, path: assertWorkspacePath(entry.path) }))
        .sort((left, right) => left.path.split('/').length - right.path.split('/').length)
      for (const { entry, path } of directories) {
        const seedOptions: VfsSeedOptions = { mode: entry.mode }
        vfs.seedDirectory(`${WORKSPACE_ROOT}/${path}`, seedOptions)
      }
      const files = manifest.entries.filter(entry => entry.kind === 'file')
      for (const entry of files) {
        const path = assertWorkspacePath(entry.path)
        if (entry.hash === undefined || entry.bytes === undefined) throw new Error(`browser-native workspace: invalid file metadata for ${path}`)
        const response = await fetch(
          `${WORKSPACE_API}/blob/${entry.hash}?protocolVersion=${String(PROTOCOL_VERSION)}&workspaceId=${encodeURIComponent(this.workspaceId)}`,
          { credentials: 'same-origin' },
        )
        if (!response.ok) throw new Error(`browser-native workspace: blob download failed with HTTP ${String(response.status)}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength !== entry.bytes || await sha256(bytes) !== entry.hash) {
          throw new Error(`browser-native workspace: blob verification failed for ${path}`)
        }
        vfs.seed(`${WORKSPACE_ROOT}/${path}`, bytes, { mode: entry.mode })
        this.knownBlobHashes.add(entry.hash)
      }
      this.revision = manifest.revision
      this.ready = true
      this.onStatus('synced', this.workspaceId, this.revision, 0)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failure = { state: 'error', message }
      this.onStatus('error', this.workspaceId, this.revision, 0, message)
      throw error
    }
  }

  record(mutation: VfsMutation): void {
    if (!this.ready || this.vfs === undefined) return
    let change: WorkspaceChange | undefined
    try {
      change = this.changeFromMutation(mutation)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failure = { state: 'error', message }
      this.onStatus('error', this.workspaceId, this.revision, this.pending.size, message)
      return
    }
    if (change === undefined) return
    if (change.deleted === true) {
      const removed = (path: string): boolean => path === change.path || path.startsWith(`${change.path}/`)
      for (const path of this.pending.keys()) {
        if (removed(path)) this.pending.delete(path)
      }
      const remotePaths = new Set([
        ...this.knownPaths,
        ...(this.retryBatch?.changes.filter(item => item.deleted !== true).map(item => item.path) ?? []),
      ])
      for (const path of remotePaths) {
        if (removed(path)) this.pending.set(path, { path, deleted: true })
      }
    } else {
      this.pending.set(change.path, change)
    }
    if (this.blocked) {
      this.onStatus('conflict', this.workspaceId, this.revision, this.pending.size + (this.retryBatch?.changes.length ?? 0), this.failure?.message)
      return
    }
    this.onStatus('dirty', this.workspaceId, this.revision, this.pending.size)
    this.schedule()
  }

  async flush(): Promise<void> {
    if (!this.ready || this.blocked) return
    if (this.scheduleTimer !== undefined) {
      clearTimeout(this.scheduleTimer)
      this.scheduleTimer = undefined
    }
    if (this.failure !== undefined) this.failure = undefined
    await this.drain()
  }

  async flushAndRequireDurable(): Promise<void> {
    await this.flush()
    if (this.failure !== undefined) throw new Error(this.failure.message)
    if (this.pending.size > 0 || this.retryBatch !== undefined) {
      throw new Error('browser-native workspace: mutations remain uncommitted')
    }
  }

  private clearWorkspace(vfs: MemoryVfs): void {
    vfs.seedDirectory(WORKSPACE_ROOT)
    const clear = (path: string): void => {
      for (const name of vfs.readdirSync(path)) {
        const child = `${path}/${name}`
        if (vfs.statSync(child).isDirectory()) vfs.rmSync(child, { recursive: true, force: true })
        else vfs.unlinkSync(child)
      }
    }
    clear(WORKSPACE_ROOT)
  }

  private changeFromMutation(mutation: VfsMutation): WorkspaceChange | undefined {
    if (mutation.path === WORKSPACE_ROOT) return undefined
    if (!mutation.path.startsWith(`${WORKSPACE_ROOT}/`)) return undefined
    const path = mutation.path.slice(WORKSPACE_ROOT.length + 1)
    if (isAtomicWriteStagingPath(path)) return undefined
    if (mutation.kind === 'remove') return { path, deleted: true }
    if (mutation.kind === 'mkdir') return { path, kind: 'directory', mode: mutation.mode }
    if (mutation.kind === 'write') {
      return {
        path,
        kind: 'file',
        mode: mutation.mode,
        bytes: mutation.bytes.byteLength,
        content: mutation.bytes.slice(),
      }
    }
    const stats = this.vfs?.statSync(mutation.path)
    if (stats === undefined) return { path, deleted: true }
    if (stats.isDirectory()) return { path, kind: 'directory', mode: mutation.mode }
    const content = this.vfs?.readFileSync(mutation.path)
    if (!(content instanceof Uint8Array)) throw new Error('browser-native workspace: file content was not bytes')
    return { path, kind: 'file', mode: mutation.mode, bytes: content.byteLength, content: content.slice() }
  }

  private schedule(): void {
    if (this.running !== undefined || this.blocked) return
    if (this.scheduleTimer !== undefined) clearTimeout(this.scheduleTimer)
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = undefined
      void this.drain()
    }, SYNC_DEBOUNCE_MS)
  }

  private async drain(): Promise<void> {
    if (this.running !== undefined) return await this.running
    if (!this.ready || this.blocked || this.workspaceId === undefined || this.revision === undefined) return
    this.running = this.performDrain()
    try {
      await this.running
    } finally {
      this.running = undefined
    }
  }

  private async performDrain(): Promise<void> {
    while (this.retryBatch !== undefined || this.pending.size > 0) {
      const batch = this.retryBatch ?? this.takeBatch()
      this.retryBatch = batch
      this.onStatus('syncing', this.workspaceId, this.revision, this.pending.size + batch.changes.length)
      try {
        const changes = await this.uploadChanges(batch.changes)
        const response = await fetch(`${WORKSPACE_API}/commit`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            requestId: crypto.randomUUID(),
            workspaceId: this.workspaceId,
            baseRevision: batch.baseRevision,
            operationId: batch.operationId,
            changes,
          }),
        })
        const receipt = await readJson(response)
        if (!Number.isSafeInteger(receipt.revision) || receipt.revision !== batch.baseRevision + 1) {
          throw new Error('browser-native workspace: commit response has an invalid revision')
        }
        this.revision = receipt.revision
        for (const change of batch.changes) {
          if (change.deleted === true) {
            for (const path of this.knownPaths) {
              if (path === change.path || path.startsWith(`${change.path}/`)) this.knownPaths.delete(path)
            }
          } else {
            this.knownPaths.add(change.path)
          }
        }
        this.retryBatch = undefined
        this.failure = undefined
      } catch (error) {
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
        const message = error instanceof Error ? error.message : String(error)
        this.retryBatch = batch
        this.failure = { state: code === 'WORKSPACE_CONFLICT' ? 'conflict' : 'error', message }
        this.blocked = code === 'WORKSPACE_CONFLICT'
        this.onStatus(this.failure.state, this.workspaceId, this.revision, this.pending.size + batch.changes.length, message)
        return
      }
    }
    this.onStatus('synced', this.workspaceId, this.revision, 0)
  }

  private takeBatch(): PendingBatch {
    const changes = [...this.pending.values()].sort((left, right) => left.path.localeCompare(right.path))
    this.pending.clear()
    return { operationId: crypto.randomUUID(), baseRevision: this.revision ?? 0, changes }
  }

  private async uploadChanges(changes: readonly WorkspaceChange[]): Promise<readonly Record<string, unknown>[]> {
    const output: Record<string, unknown>[] = []
    const uploadedHashes = new Set<string>()
    for (const change of changes) {
      if (change.deleted === true) {
        output.push({ path: change.path, deleted: true })
        continue
      }
      if (change.kind === 'directory') {
        output.push({ path: change.path, kind: 'directory', mode: change.mode })
        continue
      }
      const content = change.content
      if (content === undefined) throw new Error(`browser-native workspace: pending file ${change.path} has no content`)
      const hash = await sha256(content)
      if (!this.knownBlobHashes.has(hash) && !uploadedHashes.has(hash)) {
        const response = await fetch(`${WORKSPACE_API}/blob/${hash}`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/octet-stream',
            'x-browser-native-protocol': String(PROTOCOL_VERSION),
            'x-request-id': crypto.randomUUID(),
            'x-workspace-id': this.workspaceId ?? '',
          },
          body: content,
        })
        await readJson(response)
        this.knownBlobHashes.add(hash)
        uploadedHashes.add(hash)
      }
      output.push({ path: change.path, kind: 'file', hash, bytes: content.byteLength, mode: change.mode })
    }
    return output
  }
}

export interface BrowserNativeWorkspaceRuntime {
  /** VFS shared with the Worker Host and VFS mutation mirror. */
  readonly vfs: MemoryVfs
  /** Restore the authorized remote Workspace before the Worker Host boots. */
  readonly prepareVfs: (vfs: MemoryVfs) => Promise<void>
  /** Retry pending writes and reject unless the current changes have receipts. */
  readonly flushWorkspace: () => Promise<void>
}

/**
 * Create the VFS and synchronization hooks for the Browser-Native Workspace PoC.
 * @returns The shared VFS, pre-boot hydrator, and explicit durability check.
 */
export function createBrowserNativeWorkspaceRuntime(): BrowserNativeWorkspaceRuntime {
  let vfs: MemoryVfs
  const mirror = new BrowserNativeWorkspaceMirror()
  vfs = new MemoryVfs({ sink: mirror })
  return {
    vfs,
    prepareVfs: async mounted => {
      if (mounted !== vfs) throw new Error('browser-native workspace: Worker Host mounted a different VFS')
      await mirror.prepare(mounted)
    },
    flushWorkspace: async () => await mirror.flushAndRequireDurable(),
  }
}
