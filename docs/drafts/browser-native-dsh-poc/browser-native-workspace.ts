import { MemoryVfs } from '../../../packages/experimental/webworker-runtime/src/storage/memory.ts'
import type {
  VfsMutation,
  VfsMutationSink,
  VfsSeedOptions,
} from '../../../packages/experimental/webworker-runtime/src/storage/types.ts'
import type { ChunkEditStage } from './browser-native-chunk-editor.ts'
import {
  publishBrowserNativeWorkspaceLease,
  publishBrowserNativeWorkspaceStatus,
  takeBrowserNativeResumeWorkspaceLease,
} from './browser-native-control.ts'
import {
  createBrowserDurableWorkspaceStore,
} from './browser-native-workspace-store.ts'
import { cleanupAbandonedBrowserNativeEdits } from './browser-native-file-tools.ts'
import type {
  DurableWorkspaceSnapshot,
  DurableWorkspaceStore,
} from './browser-native-workspace-store.ts'
import { DurableWorkspaceStoreError } from './browser-native-workspace-store.ts'

const PROTOCOL_VERSION = 1
const WORKSPACE_ROOT = '/dsh/home/workspace'
const WORKSPACE_API = '/api/browser-native/workspace'
const SYNC_DEBOUNCE_MS = 100
const WORKSPACE_BLOB_CHUNK_BYTES = 1024 * 1024

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

/** One coalesced change mirrored from the Browser-Native VFS. */
export interface WorkspaceChange {
  readonly path: string
  readonly deleted?: true
  readonly kind?: 'directory' | 'file'
  readonly mode?: number
  readonly hash?: string
  readonly bytes?: number
  readonly content?: Uint8Array
  readonly contentReference?: { readonly hash: string; readonly bytes: number }
  readonly operation?: WorkspaceToolOperation
}

/** DSH tool call that caused one or more Workspace mutations. */
export interface WorkspaceToolOperation {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly toolName: string
  readonly toolCallSeq: number
}

/** One cloud commit retained locally until its receipt is known. */
export interface PendingBatch {
  readonly operationId: string
  readonly baseRevision: number
  readonly changes: readonly WorkspaceChange[]
  readonly operation?: WorkspaceToolOperation
}

/** Durable acknowledgement returned by one Workspace commit. */
export interface WorkspaceReceipt {
  readonly operationId: string
  readonly workspaceId: string
  readonly baseRevision: number
  readonly revision: number
  readonly manifestDigest: string
  readonly paths: readonly string[]
  readonly replayed: boolean
  readonly operation?: WorkspaceToolOperation
}

export interface BrowserNativeWorkspaceWriterLease {
  readonly writerToken: string
  readonly fencingToken: number
}

/** A file-tool checkpoint observable through the PoC Worker test channel. */
export type BrowserNativeFileToolStage = 'grep-match' | ChunkEditStage

type WorkspaceStatus = 'loading' | 'synced' | 'dirty' | 'syncing' | 'error' | 'conflict'
  | 'local-corrupt' | 'local-newer-version' | 'lease-conflict' | 'identity-missing' | 'identity-mismatch'
  | 'read-only' | 'stale'

type WorkspaceAccessMode = 'writer' | 'observer' | 'stale'

const READ_ONLY_FILE_TOOLS = new Set(['read', 'grep', 'glob'])

class WorkspaceIdentityError extends Error {
  constructor(readonly state: 'identity-missing' | 'identity-mismatch', message: string) {
    super(message)
  }
}

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
  const input = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(input).set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', input)
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
      retryAfterMs: typeof error.retryAfterMs === 'number' && Number.isSafeInteger(error.retryAfterMs)
        ? error.retryAfterMs
        : isRecord(error.details) && typeof error.details.retryAfterMs === 'number' && Number.isSafeInteger(error.details.retryAfterMs)
          ? error.details.retryAfterMs
          : undefined,
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
  retryAfterMs?: number,
): void {
  publishBrowserNativeWorkspaceStatus({
    type: 'workspace',
    state,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(revision === undefined ? {} : { revision }),
    dirtyCount,
    ...(message === undefined ? {} : { message }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  })
}

class BrowserNativeWorkspaceMirror implements VfsMutationSink {
  private readonly pending = new Map<string, WorkspaceChange>()
  private readonly committedReceipts: WorkspaceReceipt[] = []
  private readonly receiptOutbox: WorkspaceReceipt[] = []
  private readonly knownBlobHashes = new Set<string>()
  private readonly knownPaths = new Set<string>()
  private vfs: MemoryVfs | undefined
  private workspaceId: string | undefined
  private revision: number | undefined
  private ready = false
  private blocked = false
  private failure: { readonly state: 'error' | 'conflict'; readonly message: string } | undefined
  private retryBatch: PendingBatch | undefined
  private running: Promise<readonly WorkspaceReceipt[]> | undefined
  private scheduleTimer: ReturnType<typeof setTimeout> | undefined
  private localPersistChain: Promise<void> = Promise.resolve()
  private localPersistScheduled = false
  private latestLocalSnapshot: DurableWorkspaceSnapshot | undefined
  private localPersistVersion = 0
  private localPersistedVersion = 0
  private localPersistFailure: Error | undefined
  private writerToken: string | undefined
  private fencingToken: number | undefined
  private writerLeaseState: 'unclaimed' | 'active' | 'lost' | 'released' = 'unclaimed'
  private writerLeaseFailure: Error | undefined
  private writerRenewAfterMs: number | undefined
  private writerLeaseRenewAt = 0
  private writerLeaseDeadline = 0
  private writerHeartbeatTimer: ReturnType<typeof setTimeout> | undefined
  private writerRenewal: Promise<void> | undefined
  private writerClaim: Promise<void> | undefined
  private activeOperation: WorkspaceToolOperation | undefined
  private accessMode: WorkspaceAccessMode = 'writer'

  constructor(
    private readonly onStatus = statusMessage,
    private readonly store: DurableWorkspaceStore | undefined,
    private readonly useWriterLease = false,
    private readonly testHooks?: BrowserNativeWorkspaceRuntimeOptions['testHooks'],
    private readonly onAccessMode?: (mode: WorkspaceAccessMode) => void,
  ) {}

  async prepare(vfs: MemoryVfs): Promise<void> {
    this.vfs = vfs
    this.onStatus('loading', undefined, undefined, 0)
    try {
      const localWorkspaceIds = await this.store?.listWorkspaceIds() ?? []
      const hasLocalWorkspaceData = localWorkspaceIds.length > 0
      const identityResponse = await fetch(`${WORKSPACE_API}/identity`, {
        credentials: 'same-origin',
        ...(hasLocalWorkspaceData ? { headers: { 'x-browser-native-identity-mode': 'existing' } } : {}),
      })
      let identity: Record<string, unknown>
      try {
        identity = await readJson(identityResponse)
      } catch (error) {
        if (hasLocalWorkspaceData && isRecord(error) && error.code === 'UNAUTHENTICATED') {
          throw new WorkspaceIdentityError('identity-missing', 'The local Workspace cache cannot be matched to a signed-in browser identity')
        }
        throw error
      }
      if (typeof identity.workspaceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(identity.workspaceId)) {
        throw new Error('browser-native workspace: identity response omitted a workspace id')
      }
      if (hasLocalWorkspaceData && !localWorkspaceIds.includes(identity.workspaceId)) {
        throw new WorkspaceIdentityError('identity-mismatch', 'The local Workspace cache belongs to a different browser identity')
      }
      this.workspaceId = identity.workspaceId
      if (this.useWriterLease) {
        try {
          await this.claimWriter()
        } catch (error) {
          if (!isRecord(error) || error.code !== 'WORKSPACE_ALREADY_OWNED') throw error
          this.accessMode = 'observer'
          this.onAccessMode?.(this.accessMode)
        }
      }
      if (this.useWriterLease && this.accessMode === 'writer') await cleanupAbandonedBrowserNativeEdits(this.workspaceId)
      const manifest = await this.loadManifest()
      this.knownPaths.clear()
      this.knownBlobHashes.clear()
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
        if (this.accessMode === 'observer') {
          vfs.seed(`${WORKSPACE_ROOT}/${path}`, await this.downloadBlob(entry.hash, entry.bytes), { mode: entry.mode })
          this.knownBlobHashes.add(entry.hash)
          continue
        }
        const backing = await this.store?.openBlob(this.workspaceId, entry.hash, entry.bytes)
        if (backing !== undefined) {
          vfs.seedExternal(`${WORKSPACE_ROOT}/${path}`, backing, { mode: entry.mode })
        } else {
          const streamed = this.store !== undefined && typeof this.store.cacheBlobFromChunks === 'function'
            ? await this.store.cacheBlobFromChunks(
              this.workspaceId,
              entry.hash,
              entry.bytes,
              async (offset, length) => await this.downloadBlobChunk(entry.hash!, entry.bytes!, offset, length),
            )
            : false
          if (streamed === true) {
            const cached = await this.store?.openBlob(this.workspaceId, entry.hash, entry.bytes)
            if (cached === undefined) throw new Error(`browser-native workspace: streamed blob was not available for ${path}`)
            vfs.seedExternal(`${WORKSPACE_ROOT}/${path}`, cached, { mode: entry.mode })
          } else {
            const bytes = await this.downloadBlob(entry.hash, entry.bytes)
            await this.store?.cacheBlob(this.workspaceId, entry.hash, bytes)
            const cached = await this.store?.openBlob(this.workspaceId, entry.hash, entry.bytes)
            if (cached === undefined) vfs.seed(`${WORKSPACE_ROOT}/${path}`, bytes, { mode: entry.mode })
            else vfs.seedExternal(`${WORKSPACE_ROOT}/${path}`, cached, { mode: entry.mode })
          }
        }
        this.knownBlobHashes.add(entry.hash)
      }
      this.revision = manifest.revision
      if (this.accessMode === 'writer') {
        const localSnapshot = await this.store?.load(this.workspaceId)
        if (this.store !== undefined && typeof this.store.reconcileBlobs === 'function') {
          await this.store.reconcileBlobs(this.workspaceId, files.flatMap(entry => entry.hash === undefined ? [] : [entry.hash]))
        }
        if (localSnapshot !== undefined) await this.restoreLocalSnapshot(vfs, localSnapshot)
      }
      this.ready = true
      const dirtyCount = this.pending.size + (this.retryBatch?.changes.length ?? 0)
      this.onStatus(this.accessMode === 'observer' ? 'read-only' : dirtyCount === 0 ? 'synced' : 'dirty', this.workspaceId, this.revision, dirtyCount)
      if (this.accessMode === 'writer' && dirtyCount > 0) this.schedule()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.abandonWriterLease()
      const state = error instanceof WorkspaceIdentityError
        ? error.state
        : error instanceof DurableWorkspaceStoreError && error.code === 'LOCAL_STORE_NEWER_VERSION'
          ? 'local-newer-version'
          : error instanceof DurableWorkspaceStoreError && error.code !== 'LOCAL_STORE_UNAVAILABLE'
            ? 'local-corrupt'
            : 'error'
      const retryAfterMs = isRecord(error) && error.code === 'WORKSPACE_ALREADY_OWNED'
        && Number.isSafeInteger(error.retryAfterMs)
        ? Number(error.retryAfterMs)
        : undefined
      this.failure = { state: 'error', message }
      this.onStatus(
        retryAfterMs === undefined ? state : 'lease-conflict',
        this.workspaceId,
        this.revision,
        this.pending.size,
        message,
        retryAfterMs,
      )
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
    if (this.activeOperation !== undefined) change = { ...change, operation: this.activeOperation }
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
        if (removed(path)) this.pending.set(path, {
          path,
          deleted: true,
          ...(this.activeOperation === undefined ? {} : { operation: this.activeOperation }),
        })
      }
    } else {
      this.pending.set(change.path, change)
    }
    if (this.blocked) {
      this.onStatus('conflict', this.workspaceId, this.revision, this.pending.size + (this.retryBatch?.changes.length ?? 0), this.failure?.message)
      this.queueLocalPersist()
      return
    }
    this.onStatus('dirty', this.workspaceId, this.revision, this.pending.size)
    this.queueLocalPersist()
    this.schedule()
  }

  async flush(): Promise<readonly WorkspaceReceipt[]> {
    if (!this.ready || this.blocked || this.accessMode !== 'writer') return []
    if (this.scheduleTimer !== undefined) {
      clearTimeout(this.scheduleTimer)
      this.scheduleTimer = undefined
    }
    if (this.failure !== undefined) this.failure = undefined
    try {
      await this.awaitLocalPersist()
    } catch (error) {
      this.setLocalPersistFailure(error)
      return []
    }
    await this.drain()
    try {
      await this.awaitLocalPersist()
    } catch (error) {
      this.setLocalPersistFailure(error)
      return []
    }
    return this.committedReceipts.splice(0)
  }

  async flushAndRequireDurable(): Promise<readonly WorkspaceReceipt[]> {
    const receipts = await this.flush()
    await this.awaitLocalPersist()
    if (this.failure !== undefined) throw new Error(this.failure.message)
    if (this.pending.size > 0 || this.retryBatch !== undefined) {
      throw new Error('browser-native workspace: mutations remain uncommitted')
    }
    return receipts
  }

  async flushLocalWorkspace(): Promise<void> {
    await this.awaitLocalPersist()
  }

  assertLocalWorkspaceUsable(): void {
    if (this.localPersistFailure !== undefined || this.localPersistedVersion < this.localPersistVersion) {
      throw new Error(
        `browser-native local Workspace persistence is unresolved; reload before using Workspace files (${this.localPersistFailure?.message ?? 'save is pending'})`,
      )
    }
    this.assertWriterLeaseUsable()
  }

  async authorizeFileTool(name: string): Promise<void> {
    if (!this.ready) throw new Error('browser-native workspace: Workspace is not ready')
    if (this.accessMode === 'stale') throw new Error('browser-native workspace: observer snapshot is stale; refresh before reading Workspace files')
    if (this.accessMode === 'observer') {
      if (!READ_ONLY_FILE_TOOLS.has(name)) {
        throw new Error(`browser-native workspace: observer cannot execute Workspace tool "${name}"`)
      }
      const revision = await this.loadManifestRevision()
      if (revision !== this.revision) {
        this.accessMode = 'stale'
        this.onAccessMode?.(this.accessMode)
        this.onStatus('stale', this.workspaceId, this.revision, 0, 'Workspace changed; refresh to load the committed revision')
        throw new Error('browser-native workspace: observer snapshot is stale; refresh before reading Workspace files')
      }
      return
    }
    this.assertLocalWorkspaceUsable()
    await this.ensureWriterLease()
  }

  async ensureWriterLease(): Promise<void> {
    if (this.accessMode !== 'writer') throw new Error('browser-native workspace: read-only observer cannot acquire writer access without a page reload')
    if (!this.useWriterLease) return
    if (this.writerLeaseState === 'unclaimed') await this.claimWriter()
    this.assertWriterLeaseUsable()
    if (performance.now() >= this.writerLeaseRenewAt) {
      await this.renewWriter()
    }
    this.assertWriterLeaseUsable()
  }

  async runToolOperation<T>(operation: WorkspaceToolOperation, run: () => Promise<T>): Promise<T> {
    if (this.activeOperation !== undefined) throw new Error('browser-native workspace: overlapping file-tool operation context')
    await this.ensureWriterLease()
    this.activeOperation = operation
    try {
      return await run()
    } finally {
      this.activeOperation = undefined
    }
  }

  pendingReceipts(sessionId: string): readonly WorkspaceReceipt[] {
    return this.receiptOutbox.filter(receipt => receipt.operation?.sessionId === sessionId)
  }

  get pendingReceiptCount(): number {
    return this.receiptOutbox.length
  }

  async acknowledgeReceipt(operationId: string): Promise<void> {
    const index = this.receiptOutbox.findIndex(receipt => receipt.operationId === operationId)
    if (index < 0) return
    this.receiptOutbox.splice(index, 1)
    this.queueLocalPersist()
    await this.awaitLocalPersist()
  }

  getWriterLease(): BrowserNativeWorkspaceWriterLease | undefined {
    if (this.writerToken === undefined || this.fencingToken === undefined) return undefined
    return { writerToken: this.writerToken, fencingToken: this.fencingToken }
  }

  getWorkspaceId(): string | undefined {
    return this.workspaceId
  }

  getRevision(): number | undefined {
    return this.revision
  }

  getAccessMode(): WorkspaceAccessMode {
    return this.accessMode
  }

  isDurableWorkspace(): boolean {
    return this.store !== undefined
  }

  getWriterLeaseTestState(): {
    readonly state: 'unclaimed' | 'active' | 'lost' | 'released'
    readonly renewalScheduled: boolean
    readonly renewalPending: boolean
    readonly renewAfterMs?: number
    readonly deadlineRemainingMs: number
  } {
    return {
      state: this.writerLeaseState,
      renewalScheduled: this.writerHeartbeatTimer !== undefined,
      renewalPending: this.writerRenewal !== undefined,
      ...(this.writerRenewAfterMs === undefined ? {} : { renewAfterMs: this.writerRenewAfterMs }),
      deadlineRemainingMs: Math.max(0, this.writerLeaseDeadline - performance.now()),
    }
  }

  async releaseWriter(): Promise<void> {
    if (!this.useWriterLease || this.workspaceId === undefined || this.writerToken === undefined || this.fencingToken === undefined) return
    this.clearWriterHeartbeat()
    await this.writerRenewal?.catch(() => {})
    if (this.writerToken === undefined || this.fencingToken === undefined) return
    const response = await fetch(`${WORKSPACE_API}/lease`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        requestId: crypto.randomUUID(),
        workspaceId: this.workspaceId,
        operation: 'release',
        writerToken: this.writerToken,
        fencingToken: this.fencingToken,
      }),
    })
    await readJson(response)
    this.clearWriterHeartbeat()
    this.writerLeaseState = 'released'
    this.writerLeaseDeadline = 0
    this.writerLeaseFailure = new Error('Workspace writer lease was released; reload before using Workspace files')
    this.writerToken = undefined
    this.fencingToken = undefined
    publishBrowserNativeWorkspaceLease({ type: 'workspace-lease-released', workspaceId: this.workspaceId })
  }

  private snapshot(): DurableWorkspaceSnapshot | undefined {
    if (this.workspaceId === undefined || this.revision === undefined) return undefined
    return {
      version: 1,
      workspaceId: this.workspaceId,
      revision: this.revision,
      pending: [...this.pending.values()],
      ...(this.receiptOutbox.length === 0 ? {} : { receipts: [...this.receiptOutbox] }),
      ...(this.retryBatch === undefined ? {} : { retryBatch: this.retryBatch }),
    }
  }

  private queueLocalPersist(): void {
    if (this.store === undefined) return
    const snapshot = this.snapshot()
    if (snapshot === undefined) return
    this.localPersistVersion += 1
    this.latestLocalSnapshot = snapshot
    this.scheduleLocalPersist()
  }

  private scheduleLocalPersist(): void {
    if (this.localPersistScheduled) return
    this.localPersistScheduled = true
    this.localPersistChain = this.localPersistChain.then(async () => {
      while (this.localPersistedVersion < this.localPersistVersion) {
        const version = this.localPersistVersion
        const snapshot = this.latestLocalSnapshot
        if (snapshot === undefined) throw new Error('browser-native workspace: pending local snapshot is missing')
        this.latestLocalSnapshot = undefined
        try {
          await this.testHooks?.beforeLocalPersist?.()
          await this.persistReferencedBlobs(snapshot)
          await this.store?.save(snapshot)
          await this.testHooks?.afterLocalPersist?.()
          this.localPersistedVersion = version
          if (version === this.localPersistVersion) this.localPersistFailure = undefined
        } catch (error) {
          this.setLocalPersistFailure(error)
          if (version === this.localPersistVersion) return
        }
      }
    }).catch(error => {
      this.setLocalPersistFailure(error)
    }).finally(() => {
      this.localPersistScheduled = false
      if (this.localPersistedVersion < this.localPersistVersion && this.latestLocalSnapshot !== undefined) {
        this.scheduleLocalPersist()
      }
    })
  }

  private async awaitLocalPersist(): Promise<void> {
    while (this.localPersistedVersion < this.localPersistVersion) {
      const version = this.localPersistVersion
      await this.localPersistChain
      if (this.localPersistFailure !== undefined) throw this.localPersistFailure
      if (this.localPersistedVersion < version && this.localPersistVersion === version) {
        throw new Error('browser-native workspace: local persistence is still pending')
      }
    }
    if (this.localPersistFailure !== undefined) throw this.localPersistFailure
  }

  private async persistReferencedBlobs(snapshot: DurableWorkspaceSnapshot): Promise<void> {
    if (this.store === undefined || this.vfs === undefined || this.workspaceId === undefined) return
    const references = [...snapshot.pending, ...(snapshot.retryBatch?.changes ?? [])]
      .flatMap(change => change.contentReference === undefined ? [] : [{ change, reference: change.contentReference }])
    const cached = new Set<string>()
    for (const { change, reference } of references) {
      if (cached.has(reference.hash)) continue
      if (typeof this.store.cacheBlobFromRanges !== 'function') {
        throw new Error('browser-native workspace: durable store does not support external range references')
      }
      await this.store.cacheBlobFromRanges(
        this.workspaceId,
        reference.hash,
        reference.bytes,
        (offset, length) => this.vfs!.readFileRangeSync(`${WORKSPACE_ROOT}/${change.path}`, offset, length),
      )
      cached.add(reference.hash)
    }
  }

  private setLocalPersistFailure(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error))
    this.localPersistFailure = failure
    this.failure = { state: 'error', message: failure.message }
    this.onStatus('error', this.workspaceId, this.revision, this.pending.size + (this.retryBatch?.changes.length ?? 0), failure.message)
  }

  private async restoreLocalSnapshot(vfs: MemoryVfs, snapshot: DurableWorkspaceSnapshot): Promise<void> {
    if (snapshot.workspaceId !== this.workspaceId) throw new Error('browser-native workspace: local snapshot workspace mismatch')
    const retryChanges = snapshot.retryBatch?.changes ?? []
    await this.replayChanges(vfs, [...retryChanges, ...snapshot.pending])
    this.retryBatch = snapshot.retryBatch
    this.receiptOutbox.splice(0, this.receiptOutbox.length, ...(snapshot.receipts ?? []))
    for (const change of snapshot.pending) this.pending.set(change.path, change)
    if (this.retryBatch !== undefined) this.revision = this.retryBatch.baseRevision
    else if (snapshot.pending.length > 0) this.revision = snapshot.revision
  }

  private async replayChanges(vfs: MemoryVfs, changes: readonly WorkspaceChange[]): Promise<void> {
    const ordered = [...changes].sort((left, right) => {
      const leftDeleted = left.deleted === true
      const rightDeleted = right.deleted === true
      if (leftDeleted !== rightDeleted) return leftDeleted ? -1 : 1
      if (leftDeleted) return right.path.split('/').length - left.path.split('/').length
      const leftDirectory = left.kind === 'directory'
      const rightDirectory = right.kind === 'directory'
      if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1
      return left.path.localeCompare(right.path)
    })
    for (const change of ordered) await this.applyChange(vfs, change)
  }

  private async applyChange(vfs: MemoryVfs, change: WorkspaceChange): Promise<void> {
    const target = `${WORKSPACE_ROOT}/${change.path}`
    if (change.deleted === true) {
      vfs.rmSync(target, { recursive: true, force: true })
      return
    }
    if (change.kind === 'directory') {
      vfs.seedDirectory(target, { mode: change.mode })
      return
    }
    if (change.kind !== 'file') {
      throw new Error(`browser-native workspace: local file change is incomplete for ${change.path}`)
    }
    if (change.contentReference !== undefined) {
      const backing = await this.store?.openBlob(this.workspaceId!, change.contentReference.hash, change.contentReference.bytes)
      if (backing === undefined) throw new Error(`browser-native workspace: local reference blob is missing for ${change.path}`)
      vfs.seedExternal(target, backing, { mode: change.mode })
      return
    }
    if (change.content === undefined) throw new Error(`browser-native workspace: local file change is incomplete for ${change.path}`)
    vfs.seed(target, change.content, { mode: change.mode })
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
    if (mutation.kind === 'write-reference') {
      return {
        path,
        kind: 'file',
        mode: mutation.mode,
        bytes: mutation.bytes,
        hash: mutation.hash,
        contentReference: { hash: mutation.hash, bytes: mutation.bytes },
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

  private async drain(): Promise<readonly WorkspaceReceipt[]> {
    if (this.running !== undefined) return await this.running
    if (!this.ready || this.blocked || this.workspaceId === undefined || this.revision === undefined) return []
    this.running = this.performDrain()
    try {
      return await this.running
    } finally {
      this.running = undefined
    }
  }

  private async performDrain(): Promise<readonly WorkspaceReceipt[]> {
    const receipts: WorkspaceReceipt[] = []
    while (this.retryBatch !== undefined || this.pending.size > 0) {
      const batch = this.retryBatch ?? this.takeBatch()
      this.retryBatch = batch
      this.queueLocalPersist()
      try {
        await this.awaitLocalPersist()
      } catch (error) {
        this.setLocalPersistFailure(error)
        return receipts
      }
      this.onStatus('syncing', this.workspaceId, this.revision, this.pending.size + batch.changes.length)
      try {
        const changes = await this.uploadChanges(batch.operationId, batch.changes)
        if (this.useWriterLease) await this.renewWriter()
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
            ...(this.writerToken === undefined ? {} : { writerToken: this.writerToken }),
            ...(this.fencingToken === undefined ? {} : { fencingToken: this.fencingToken }),
          }),
        })
        const receipt = await readJson(response)
        receipts.push(this.applyReceipt(batch, receipt))
      } catch (error) {
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
        const receipt = await this.lookupOperation(batch)
        if (receipt !== undefined) {
          receipts.push(this.applyReceipt(batch, receipt))
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        this.retryBatch = batch
        this.failure = { state: code === 'WORKSPACE_CONFLICT' ? 'conflict' : 'error', message }
        this.blocked = code === 'WORKSPACE_CONFLICT'
        const state = code === 'WORKSPACE_ALREADY_OWNED' ? 'lease-conflict' : this.failure.state
        const retryAfterMs = isRecord(error) && Number.isSafeInteger(error.retryAfterMs)
          ? Number(error.retryAfterMs)
          : undefined
        this.onStatus(state, this.workspaceId, this.revision, this.pending.size + batch.changes.length, message, retryAfterMs)
        return receipts
      }
    }
    try {
      await this.awaitLocalPersist()
    } catch (error) {
      this.setLocalPersistFailure(error)
      return receipts
    }
    this.onStatus('synced', this.workspaceId, this.revision, 0)
    return receipts
  }

  private async claimWriter(): Promise<void> {
    if (this.writerLeaseState === 'active') return
    if (this.writerClaim !== undefined) return await this.writerClaim
    const claim = this.acquireWriterLease()
    this.writerClaim = claim
    try {
      await claim
    } catch (error) {
      const retryAfterMs = isRecord(error) && Number.isSafeInteger(error.retryAfterMs)
        ? Number(error.retryAfterMs)
        : undefined
      if (isRecord(error) && error.code === 'WORKSPACE_ALREADY_OWNED') {
        this.onStatus('lease-conflict', this.workspaceId, this.revision, this.pending.size, error.message,
          retryAfterMs)
      }
      throw error
    } finally {
      if (this.writerClaim === claim) this.writerClaim = undefined
    }
  }

  private async acquireWriterLease(): Promise<void> {
    if (this.workspaceId === undefined) throw new Error('browser-native workspace: cannot claim writer before identity')
    const resumeLease = takeBrowserNativeResumeWorkspaceLease(this.workspaceId)
    if (resumeLease !== undefined) {
      try {
        await this.requestWriterLease('resume', resumeLease)
        return
      } catch (error) {
        if (isRecord(error) && error.code === 'WORKSPACE_OWNERSHIP_LOST') {
          publishBrowserNativeWorkspaceLease({ type: 'workspace-lease-released', workspaceId: this.workspaceId })
        } else if (error instanceof TypeError) {
          await this.requestWriterLease('resume', resumeLease)
          return
        } else {
          throw error
        }
      }
    }
    await this.requestWriterLease('claim')
  }

  private async requestWriterLease(
    operation: 'claim' | 'resume',
    previous?: { readonly writerToken: string; readonly fencingToken: number; readonly resumeId: string },
  ): Promise<void> {
    if (this.workspaceId === undefined) throw new Error('browser-native workspace: cannot claim writer before identity')
    const response = await fetch(`${WORKSPACE_API}/lease`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        requestId: crypto.randomUUID(),
        workspaceId: this.workspaceId,
        operation,
        ...(previous === undefined ? {} : {
          writerToken: previous.writerToken,
          fencingToken: previous.fencingToken,
          resumeId: previous.resumeId,
        }),
      }),
    })
    const lease = await readJson(response)
    this.setWriterLease(lease)
  }

  private async renewWriter(): Promise<void> {
    if (!this.useWriterLease || this.workspaceId === undefined) return
    if (this.writerLeaseState === 'unclaimed') {
      await this.claimWriter()
      return
    }
    this.assertWriterLeaseUsable()
    if (this.writerRenewal !== undefined) return await this.writerRenewal
    const writerToken = this.writerToken
    const fencingToken = this.fencingToken
    if (writerToken === undefined || fencingToken === undefined) {
      throw this.writerLeaseFailure ?? new Error('browser-native workspace: writer lease is unavailable')
    }
    const renewal = (async (): Promise<void> => {
      const response = await fetch(`${WORKSPACE_API}/lease`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          requestId: crypto.randomUUID(),
          workspaceId: this.workspaceId,
          operation: 'renew',
          writerToken,
          fencingToken,
        }),
      })
      const lease = await readJson(response)
      if (this.writerLeaseState !== 'active' || this.writerToken !== writerToken
        || this.fencingToken !== fencingToken) return
      this.setWriterLease(lease)
    })()
    this.writerRenewal = renewal
    try {
      await renewal
    } catch (error) {
      if (this.isOwnershipLost(error) || performance.now() >= this.writerLeaseDeadline) {
        this.markWriterLeaseLost(error)
      }
      throw error
    } finally {
      if (this.writerRenewal === renewal) this.writerRenewal = undefined
    }
  }

  private setWriterLease(value: Record<string, unknown>): void {
    if (typeof value.writerToken !== 'string' || !Number.isSafeInteger(value.fencingToken)
      || !Number.isSafeInteger(value.leaseDurationMs) || Number(value.leaseDurationMs) < 300
      || !Number.isSafeInteger(value.renewAfterMs) || Number(value.renewAfterMs) < 1
      || Number(value.renewAfterMs) >= Number(value.leaseDurationMs)) {
      throw new Error('browser-native workspace: backend returned an invalid writer lease')
    }
    const changed = this.writerToken !== value.writerToken || this.fencingToken !== value.fencingToken
    this.writerToken = value.writerToken
    this.fencingToken = value.fencingToken
    this.writerLeaseState = 'active'
    this.writerLeaseFailure = undefined
    this.writerRenewAfterMs = Number(value.renewAfterMs)
    this.writerLeaseRenewAt = performance.now() + this.writerRenewAfterMs
    this.writerLeaseDeadline = performance.now() + Number(value.leaseDurationMs)
    this.scheduleWriterHeartbeat(this.writerRenewAfterMs)
    if (changed && this.workspaceId !== undefined) {
      publishBrowserNativeWorkspaceLease({
        type: 'workspace-lease',
        workspaceId: this.workspaceId,
        writerToken: this.writerToken,
        fencingToken: this.fencingToken,
      })
    }
  }

  private scheduleWriterHeartbeat(delayMs: number): void {
    this.clearWriterHeartbeat()
    if (!this.useWriterLease || this.writerLeaseState !== 'active') return
    const remainingMs = this.writerLeaseDeadline - performance.now()
    if (remainingMs <= 0) {
      this.markWriterLeaseLost(new Error('Workspace writer lease expired before renewal'))
      return
    }
    this.writerHeartbeatTimer = setTimeout(() => {
      this.writerHeartbeatTimer = undefined
      void this.renewWriterInBackground()
    }, Math.max(1, Math.min(delayMs, remainingMs)))
  }

  private async renewWriterInBackground(): Promise<void> {
    try {
      await this.renewWriter()
    } catch (error) {
      if (this.writerLeaseState !== 'active') return
      const remainingMs = this.writerLeaseDeadline - performance.now()
      if (remainingMs <= 0) {
        this.markWriterLeaseLost(error)
        return
      }
      const retryDelay = Math.min(this.writerRenewAfterMs ?? remainingMs, Math.max(50, Math.floor(remainingMs / 3)))
      this.scheduleWriterHeartbeat(retryDelay)
    }
  }

  private clearWriterHeartbeat(): void {
    if (this.writerHeartbeatTimer === undefined) return
    clearTimeout(this.writerHeartbeatTimer)
    this.writerHeartbeatTimer = undefined
  }

  private assertWriterLeaseUsable(): void {
    if (!this.useWriterLease) return
    if (this.writerLeaseState === 'unclaimed') return
    if (this.writerLeaseState === 'active' && performance.now() < this.writerLeaseDeadline) return
    const error = this.writerLeaseFailure ?? new Error('Workspace writer lease is unavailable; reload to reacquire write access')
    if (this.writerLeaseState === 'active') this.markWriterLeaseLost(error)
    throw this.writerLeaseFailure ?? error
  }

  private markWriterLeaseLost(cause: unknown): void {
    if (this.writerLeaseState !== 'active') return
    this.clearWriterHeartbeat()
    this.writerLeaseState = 'lost'
    const detail = cause instanceof Error ? cause.message : String(cause)
    this.writerLeaseFailure = new Error(`Workspace writer lease was lost; reload before using Workspace files (${detail})`, { cause })
    this.writerToken = undefined
    this.fencingToken = undefined
    this.failure = { state: 'error', message: this.writerLeaseFailure.message }
    this.onStatus('error', this.workspaceId, this.revision, this.pending.size + (this.retryBatch?.changes.length ?? 0), this.writerLeaseFailure.message)
    if (this.workspaceId !== undefined) {
      publishBrowserNativeWorkspaceLease({ type: 'workspace-lease-released', workspaceId: this.workspaceId })
    }
  }

  private isOwnershipLost(error: unknown): boolean {
    return isRecord(error) && error.code === 'WORKSPACE_OWNERSHIP_LOST'
  }

  private abandonWriterLease(): void {
    if (this.writerLeaseState !== 'active') return
    this.clearWriterHeartbeat()
    this.writerLeaseState = 'lost'
    this.writerLeaseFailure = new Error('Workspace startup failed; reload before using Workspace files')
    this.writerToken = undefined
    this.fencingToken = undefined
    if (this.workspaceId !== undefined) {
      publishBrowserNativeWorkspaceLease({ type: 'workspace-lease-released', workspaceId: this.workspaceId })
    }
  }

  private async lookupOperation(batch: PendingBatch): Promise<Record<string, unknown> | undefined> {
    if (this.workspaceId === undefined) return undefined
    try {
      const response = await fetch(
        `${WORKSPACE_API}/operation/${batch.operationId}?protocolVersion=${String(PROTOCOL_VERSION)}&workspaceId=${encodeURIComponent(this.workspaceId)}`,
        { credentials: 'same-origin' },
      )
      const value = await readJson(response)
      if (value.found !== true || !isRecord(value.receipt)) return undefined
      return value.receipt
    } catch {
      return undefined
    }
  }

  private applyReceipt(batch: PendingBatch, receipt: Record<string, unknown>): WorkspaceReceipt {
    if ((receipt.operationId !== undefined && receipt.operationId !== batch.operationId) || typeof receipt.revision !== 'number'
      || !Number.isSafeInteger(receipt.revision) || receipt.revision !== batch.baseRevision + 1
      || (receipt.workspaceId !== undefined && typeof receipt.workspaceId !== 'string')
      || (receipt.digest !== undefined && typeof receipt.digest !== 'string')
      || (receipt.changedPaths !== undefined && (!Array.isArray(receipt.changedPaths)
        || receipt.changedPaths.some(path => typeof path !== 'string')))) {
      throw new Error('browser-native workspace: commit receipt does not match the pending operation')
    }
    const revision = receipt.revision
    this.revision = revision
    for (const change of batch.changes) {
      if (change.deleted === true) {
        for (const path of this.knownPaths) {
          if (path === change.path || path.startsWith(`${change.path}/`)) this.knownPaths.delete(path)
        }
      } else {
        this.knownPaths.add(change.path)
      }
    }
    const result: WorkspaceReceipt = {
      operationId: batch.operationId,
      workspaceId: typeof receipt.workspaceId === 'string' ? receipt.workspaceId : this.workspaceId ?? '',
      baseRevision: batch.baseRevision,
      revision,
      manifestDigest: typeof receipt.digest === 'string' ? receipt.digest : '',
      paths: receipt.changedPaths === undefined ? batch.changes.map(change => change.path) : receipt.changedPaths,
      replayed: receipt.replayed === true,
      ...(batch.operation === undefined ? {} : { operation: batch.operation }),
    }
    this.retryBatch = undefined
    this.failure = undefined
    this.committedReceipts.push(result)
    if (result.operation !== undefined && !this.receiptOutbox.some(item => item.operationId === result.operationId)) {
      this.receiptOutbox.push(result)
    }
    this.queueLocalPersist()
    return result
  }

  private takeBatch(): PendingBatch {
    const ordered = [...this.pending.values()].sort((left, right) => left.path.localeCompare(right.path))
    const operation = ordered[0]?.operation
    const operationKey = operation === undefined ? undefined : JSON.stringify(operation)
    const changes = ordered.filter(change => {
      const changeKey = change.operation === undefined ? undefined : JSON.stringify(change.operation)
      return changeKey === operationKey
    })
    for (const change of changes) this.pending.delete(change.path)
    return {
      operationId: crypto.randomUUID(),
      baseRevision: this.revision ?? 0,
      changes,
      ...(operation === undefined ? {} : { operation }),
    }
  }

  private async uploadChanges(operationId: string, changes: readonly WorkspaceChange[]): Promise<readonly Record<string, unknown>[]> {
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
      if (change.contentReference !== undefined) {
        const reference = change.contentReference
        if (reference.bytes !== change.bytes) throw new Error(`browser-native workspace: reference size mismatch for ${change.path}`)
        if (!this.knownBlobHashes.has(reference.hash) && !uploadedHashes.has(reference.hash)) {
          await this.uploadBlobFromRanges(
            operationId,
            reference.hash,
            reference.bytes,
            (offset, length) => this.vfs!.readFileRangeSync(`${WORKSPACE_ROOT}/${change.path}`, offset, length),
          )
          this.knownBlobHashes.add(reference.hash)
          uploadedHashes.add(reference.hash)
        }
        output.push({ path: change.path, kind: 'file', hash: reference.hash, bytes: reference.bytes, mode: change.mode })
        continue
      }
      const content = change.content
      if (content === undefined) throw new Error(`browser-native workspace: pending file ${change.path} has no content`)
      const hash = await sha256(content)
      if (!this.knownBlobHashes.has(hash) && !uploadedHashes.has(hash)) {
        await this.uploadBlob(operationId, hash, content)
        this.knownBlobHashes.add(hash)
        uploadedHashes.add(hash)
      }
      output.push({ path: change.path, kind: 'file', hash, bytes: content.byteLength, mode: change.mode })
    }
    return output
  }

  private async uploadBlob(operationId: string, hash: string, content: Uint8Array): Promise<void> {
    await this.uploadBlobFromRanges(operationId, hash, content.byteLength,
      (offset, length) => content.subarray(offset, offset + length))
  }

  private async uploadBlobFromRanges(
    operationId: string,
    hash: string,
    totalBytes: number,
    readRange: (offset: number, length: number) => Uint8Array,
  ): Promise<void> {
    if (this.workspaceId === undefined) {
      throw new Error('browser-native workspace: blob upload has no durable operation identity')
    }
    const uploadId = `${operationId}-${hash}`
    const uploadPath = `${WORKSPACE_API}/blob-upload/${uploadId}`
    const startResponse = await fetch(`${WORKSPACE_API}/blob-upload/start`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        requestId: crypto.randomUUID(),
        workspaceId: this.workspaceId,
        operationId,
        hash,
        totalBytes,
        chunkBytes: WORKSPACE_BLOB_CHUNK_BYTES,
      }),
    })
    const started = await readJson(startResponse)
    if (started.complete === true) return

    const statusResponse = await fetch(
      `${uploadPath}?protocolVersion=${String(PROTOCOL_VERSION)}&workspaceId=${encodeURIComponent(this.workspaceId)}`,
      { credentials: 'same-origin' },
    )
    const status = await readJson(statusResponse)
    if (status.complete === true) return
    if (!Array.isArray(status.missing) || status.missing.some(index => !Number.isSafeInteger(index))) {
      throw new Error('browser-native workspace: backend returned an invalid blob upload status')
    }
    for (const index of status.missing) {
      const offset = index * WORKSPACE_BLOB_CHUNK_BYTES
      const chunk = readRange(offset, Math.min(WORKSPACE_BLOB_CHUNK_BYTES, totalBytes - offset))
      if (chunk.byteLength === 0) throw new Error('browser-native workspace: backend requested an empty upload chunk')
      const chunkHash = await sha256(chunk)
      const response = await fetch(`${uploadPath}/${String(index)}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/octet-stream',
          'x-browser-native-protocol': String(PROTOCOL_VERSION),
          'x-request-id': crypto.randomUUID(),
          'x-workspace-id': this.workspaceId,
          'x-chunk-sha256': chunkHash,
        },
        body: toArrayBuffer(chunk),
      })
      await readJson(response)
    }
    const completeResponse = await fetch(`${uploadPath}/complete`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        requestId: crypto.randomUUID(),
        workspaceId: this.workspaceId,
      }),
    })
    const completed = await readJson(completeResponse)
    if (completed.complete !== true) throw new Error('browser-native workspace: backend did not complete blob upload')
  }

  private async downloadBlobChunk(hash: string, totalBytes: number, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
      || offset + length > totalBytes) throw new RangeError('browser-native workspace: invalid blob chunk range')
    const index = Math.floor(offset / WORKSPACE_BLOB_CHUNK_BYTES)
    const response = await fetch(
      `${WORKSPACE_API}/blob/${hash}/chunk/${String(index)}?protocolVersion=${String(PROTOCOL_VERSION)}&workspaceId=${encodeURIComponent(this.workspaceId ?? '')}`,
      { credentials: 'same-origin' },
    )
    if (!response.ok) throw new Error(`browser-native workspace: blob chunk download failed with HTTP ${String(response.status)}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const expectedBytes = Math.min(WORKSPACE_BLOB_CHUNK_BYTES, totalBytes - index * WORKSPACE_BLOB_CHUNK_BYTES)
    if (bytes.byteLength !== expectedBytes || response.headers.get('x-chunk-index') !== String(index)
      || response.headers.get('x-chunk-count') !== String(Math.ceil(totalBytes / WORKSPACE_BLOB_CHUNK_BYTES))
      || response.headers.get('x-total-bytes') !== String(totalBytes)
      || response.headers.get('x-content-sha256') !== await sha256(bytes)) {
      throw new Error(`browser-native workspace: blob chunk verification failed for index ${String(index)}`)
    }
    const chunkOffset = offset - index * WORKSPACE_BLOB_CHUNK_BYTES
    return bytes.subarray(chunkOffset, chunkOffset + length)
  }

  private async downloadBlob(hash: string, totalBytes: number): Promise<Uint8Array> {
    const output = new Uint8Array(totalBytes)
    const chunkCount = Math.ceil(totalBytes / WORKSPACE_BLOB_CHUNK_BYTES)
    for (let index = 0; index < chunkCount; index += 1) {
      const offset = index * WORKSPACE_BLOB_CHUNK_BYTES
      const length = Math.min(WORKSPACE_BLOB_CHUNK_BYTES, totalBytes - offset)
      const bytes = await this.downloadBlobChunk(hash, totalBytes, offset, length)
      output.set(bytes, index * WORKSPACE_BLOB_CHUNK_BYTES)
    }
    if (await sha256(output) !== hash) throw new Error('browser-native workspace: downloaded blob failed full SHA-256 verification')
    return output
  }

  private async loadManifest(): Promise<WorkspaceManifest> {
    if (this.workspaceId === undefined) throw new Error('browser-native workspace: cannot load a manifest before identity')
    const response = await fetch(
      `${WORKSPACE_API}/manifest?protocolVersion=${String(PROTOCOL_VERSION)}&workspaceId=${encodeURIComponent(this.workspaceId)}`,
      { credentials: 'same-origin' },
    )
    const raw = await readJson(response)
    if (raw.workspaceId !== this.workspaceId || !Number.isSafeInteger(raw.revision)
      || typeof raw.revision !== 'number' || raw.revision < 0) {
      throw new Error('browser-native workspace: backend returned an invalid manifest')
    }
    return { workspaceId: this.workspaceId, revision: raw.revision, entries: manifestEntries(raw.entries) }
  }

  private async loadManifestRevision(): Promise<number> {
    if (this.workspaceId === undefined) throw new Error('browser-native workspace: cannot check a manifest before identity')
    const response = await fetch(
      `${WORKSPACE_API}/manifest?protocolVersion=${String(PROTOCOL_VERSION)}&workspaceId=${encodeURIComponent(this.workspaceId)}`,
      { credentials: 'same-origin', cache: 'no-store' },
    )
    const manifest = await readJson(response)
    if (manifest.workspaceId !== this.workspaceId || !Number.isSafeInteger(manifest.revision)
      || typeof manifest.revision !== 'number' || manifest.revision < 0) {
      throw new Error('browser-native workspace: backend returned an invalid manifest revision')
    }
    return manifest.revision
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(output).set(bytes)
  return output
}

export interface BrowserNativeWorkspaceRuntime {
  /** VFS shared with the Worker Host and VFS mutation mirror. */
  readonly vfs: MemoryVfs
  /** Restore the authorized remote Workspace before the Worker Host boots. */
  readonly prepareVfs: (vfs: MemoryVfs) => Promise<void>
  /** Retry pending writes and reject unless the current changes have receipts. */
  readonly flushWorkspace: () => Promise<readonly WorkspaceReceipt[]>
  /** Tag VFS mutations made by one DSH file-tool execution. */
  readonly runToolOperation: <T>(operation: WorkspaceToolOperation, run: () => Promise<T>) => Promise<T>
  /** Read unacknowledged receipts belonging to one DSH Session. */
  readonly pendingReceipts: (sessionId: string) => readonly WorkspaceReceipt[]
  /** Return the number of unacknowledged receipts across all Sessions. */
  readonly pendingReceiptCount: () => number
  /** Remove a receipt after its Session event is durable. */
  readonly acknowledgeReceipt: (operationId: string) => Promise<void>
  /** Wait until the local durable snapshot has been written. */
  readonly flushLocalWorkspace: () => Promise<void>
  /** Reject Agent file tools while a local VFS mutation is not durably recorded. */
  readonly assertLocalWorkspaceUsable: () => void
  /** Renew an enabled writer lease before a file tool starts. */
  readonly ensureWriterLease: () => Promise<void>
  /** Check Workspace access and the remote revision before executing a file tool. */
  readonly authorizeFileTool: (name: string) => Promise<void>
  /** Return the PoC writer lease for model-independent browser tests. */
  readonly getWriterLease: () => BrowserNativeWorkspaceWriterLease | undefined
  /** Return Worker-local lease timing for model-independent browser tests. */
  readonly getWriterLeaseTestState: () => {
    readonly state: 'unclaimed' | 'active' | 'lost' | 'released'
    readonly renewalScheduled: boolean
    readonly renewalPending: boolean
    readonly renewAfterMs?: number
    readonly deadlineRemainingMs: number
  }
  /** Release the PoC writer lease for model-independent browser tests. */
  readonly releaseWriter: () => Promise<void>
  /** Return the PoC-only delay inserted at cooperative file-search yields. */
  readonly getFileToolYieldDelayMs: () => number
  /** Report a file-tool checkpoint to an enabled PoC test observer. */
  readonly reportFileToolStage: (stage: BrowserNativeFileToolStage) => void
  /** Return the current Workspace identity after preparation. */
  readonly getWorkspaceId: () => string | undefined
  /** Return the current remote manifest revision after preparation. */
  readonly getRevision: () => number | undefined
  /** Return whether this Worker owns writes, observes read-only, or has a stale snapshot. */
  readonly getAccessMode: () => WorkspaceAccessMode
  /** Whether this runtime has a local durable store for external file backing. */
  readonly isDurableWorkspace: () => boolean
}

/** Optional local persistence for the Browser-Native Workspace PoC. */
export interface BrowserNativeWorkspaceRuntimeOptions {
  /** Enable OPFS/IndexedDB persistence instead of the default memory-only mirror. */
  readonly durable?: boolean
  /** Inject a deterministic store for tests or a host-specific implementation. */
  readonly store?: DurableWorkspaceStore
  /** Publish status updates to a test observer instead of the page control channel. */
  readonly onStatus?: typeof statusMessage
  /** Claim a backend writer lease before mirroring Workspace mutations. */
  readonly writerLease?: boolean
  /** Notify tool publication when this Worker becomes a read-only observer or stale. */
  readonly onAccessMode?: (mode: WorkspaceAccessMode) => void
  /** Inject storage faults through the PoC-only Worker test port. */
  readonly testHooks?: {
    readonly abortNextMetadataTransaction?: () => boolean
    readonly quotaNextOpfsWrite?: () => boolean
    readonly beforeLocalPersist?: () => Promise<void>
    readonly afterLocalPersist?: () => Promise<void>
    readonly fileToolYieldDelayMs?: () => number
    readonly onFileToolStage?: (stage: BrowserNativeFileToolStage) => void
  }
}

/**
 * Create the VFS and synchronization hooks for the Browser-Native Workspace PoC.
 * @returns The shared VFS, pre-boot hydrator, and explicit durability check.
 */
export function createBrowserNativeWorkspaceRuntime(
  options: BrowserNativeWorkspaceRuntimeOptions = {},
): BrowserNativeWorkspaceRuntime {
  let vfs: MemoryVfs
  const store = options.store ?? (options.durable === true ? createBrowserDurableWorkspaceStore(options.testHooks) : undefined)
  const mirror = new BrowserNativeWorkspaceMirror(
    options.onStatus,
    store,
    options.writerLease === true,
    options.testHooks,
    options.onAccessMode,
  )
  vfs = new MemoryVfs({ sink: mirror })
  return {
    vfs,
    prepareVfs: async mounted => {
      if (mounted !== vfs) throw new Error('browser-native workspace: Worker Host mounted a different VFS')
      await mirror.prepare(mounted)
    },
    flushWorkspace: async () => await mirror.flushAndRequireDurable(),
    runToolOperation: async (operation, run) => await mirror.runToolOperation(operation, run),
    pendingReceipts: sessionId => mirror.pendingReceipts(sessionId),
    pendingReceiptCount: () => mirror.pendingReceiptCount,
    acknowledgeReceipt: async operationId => await mirror.acknowledgeReceipt(operationId),
    flushLocalWorkspace: async () => await mirror.flushLocalWorkspace(),
    assertLocalWorkspaceUsable: () => mirror.assertLocalWorkspaceUsable(),
    ensureWriterLease: async () => await mirror.ensureWriterLease(),
    authorizeFileTool: async name => await mirror.authorizeFileTool(name),
    getWriterLease: () => mirror.getWriterLease(),
    getWriterLeaseTestState: () => mirror.getWriterLeaseTestState(),
    releaseWriter: async () => await mirror.releaseWriter(),
    getFileToolYieldDelayMs: () => options.testHooks?.fileToolYieldDelayMs?.() ?? 0,
    reportFileToolStage: stage => options.testHooks?.onFileToolStage?.(stage),
    getWorkspaceId: () => mirror.getWorkspaceId(),
    getRevision: () => mirror.getRevision(),
    getAccessMode: () => mirror.getAccessMode(),
    isDurableWorkspace: () => mirror.isDurableWorkspace(),
  }
}
