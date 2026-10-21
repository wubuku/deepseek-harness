import { MemoryVfs } from '../../../packages/experimental/webworker-runtime/src/storage/memory.ts'
import type {
  VfsMutation,
  VfsMutationSink,
  VfsSeedOptions,
} from '../../../packages/experimental/webworker-runtime/src/storage/types.ts'
import {
  publishBrowserNativeWorkspaceLease,
  publishBrowserNativeWorkspaceStatus,
  takeBrowserNativeResumeWorkspaceLease,
} from './browser-native-control.ts'
import {
  createBrowserDurableWorkspaceStore,
} from './browser-native-workspace-store.ts'
import type {
  DurableWorkspaceSnapshot,
  DurableWorkspaceStore,
} from './browser-native-workspace-store.ts'
import { DurableWorkspaceStoreError } from './browser-native-workspace-store.ts'

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

/** One coalesced change mirrored from the Browser-Native VFS. */
export interface WorkspaceChange {
  readonly path: string
  readonly deleted?: true
  readonly kind?: 'directory' | 'file'
  readonly mode?: number
  readonly hash?: string
  readonly bytes?: number
  readonly content?: Uint8Array
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

type WorkspaceStatus = 'loading' | 'synced' | 'dirty' | 'syncing' | 'error' | 'conflict' | 'local-corrupt'

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
  private localPersistFailure: Error | undefined
  private writerToken: string | undefined
  private fencingToken: number | undefined
  private activeOperation: WorkspaceToolOperation | undefined

  constructor(
    private readonly onStatus = statusMessage,
    private readonly store: DurableWorkspaceStore | undefined,
    private readonly useWriterLease = false,
  ) {}

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
      if (this.useWriterLease) await this.claimWriter()
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
      const localSnapshot = await this.store?.load(this.workspaceId)
      if (localSnapshot !== undefined) this.restoreLocalSnapshot(vfs, localSnapshot)
      this.ready = true
      const dirtyCount = this.pending.size + (this.retryBatch?.changes.length ?? 0)
      this.onStatus(dirtyCount === 0 ? 'synced' : 'dirty', this.workspaceId, this.revision, dirtyCount)
      if (dirtyCount > 0) this.schedule()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const state = error instanceof DurableWorkspaceStoreError && error.code !== 'LOCAL_STORE_UNAVAILABLE'
        ? 'local-corrupt'
        : 'error'
      this.failure = { state: state === 'local-corrupt' ? 'error' : state, message }
      this.onStatus(state, this.workspaceId, this.revision, this.pending.size, message)
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
    if (!this.ready || this.blocked) return []
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

  async runToolOperation<T>(operation: WorkspaceToolOperation, run: () => Promise<T>): Promise<T> {
    if (this.activeOperation !== undefined) throw new Error('browser-native workspace: overlapping file-tool operation context')
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

  async releaseWriter(): Promise<void> {
    if (!this.useWriterLease || this.workspaceId === undefined || this.writerToken === undefined || this.fencingToken === undefined) return
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
    this.localPersistFailure = undefined
    this.localPersistChain = this.localPersistChain.then(async () => {
      await this.store?.save(snapshot)
    }).catch(error => {
      this.setLocalPersistFailure(error)
    })
  }

  private async awaitLocalPersist(): Promise<void> {
    await this.localPersistChain
    if (this.localPersistFailure !== undefined) throw this.localPersistFailure
  }

  private setLocalPersistFailure(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error))
    this.localPersistFailure = failure
    this.failure = { state: 'error', message: failure.message }
    this.onStatus('error', this.workspaceId, this.revision, this.pending.size + (this.retryBatch?.changes.length ?? 0), failure.message)
  }

  private restoreLocalSnapshot(vfs: MemoryVfs, snapshot: DurableWorkspaceSnapshot): void {
    if (snapshot.workspaceId !== this.workspaceId) throw new Error('browser-native workspace: local snapshot workspace mismatch')
    const retryChanges = snapshot.retryBatch?.changes ?? []
    this.replayChanges(vfs, [...retryChanges, ...snapshot.pending])
    this.retryBatch = snapshot.retryBatch
    this.receiptOutbox.splice(0, this.receiptOutbox.length, ...(snapshot.receipts ?? []))
    for (const change of snapshot.pending) this.pending.set(change.path, change)
    if (this.retryBatch !== undefined) this.revision = this.retryBatch.baseRevision
    else if (snapshot.pending.length > 0) this.revision = snapshot.revision
  }

  private replayChanges(vfs: MemoryVfs, changes: readonly WorkspaceChange[]): void {
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
    for (const change of ordered) this.applyChange(vfs, change)
  }

  private applyChange(vfs: MemoryVfs, change: WorkspaceChange): void {
    const target = `${WORKSPACE_ROOT}/${change.path}`
    if (change.deleted === true) {
      vfs.rmSync(target, { recursive: true, force: true })
      return
    }
    if (change.kind === 'directory') {
      vfs.seedDirectory(target, { mode: change.mode })
      return
    }
    if (change.kind !== 'file' || change.content === undefined) {
      throw new Error(`browser-native workspace: local file change is incomplete for ${change.path}`)
    }
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
        const changes = await this.uploadChanges(batch.changes)
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
        this.onStatus(this.failure.state, this.workspaceId, this.revision, this.pending.size + batch.changes.length, message)
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
    if (this.writerToken === undefined || this.fencingToken === undefined) return await this.claimWriter()
    const response = await fetch(`${WORKSPACE_API}/lease`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        requestId: crypto.randomUUID(),
        workspaceId: this.workspaceId,
        operation: 'renew',
        writerToken: this.writerToken,
        fencingToken: this.fencingToken,
      }),
    })
    this.setWriterLease(await readJson(response))
  }

  private setWriterLease(value: Record<string, unknown>): void {
    if (typeof value.writerToken !== 'string' || !Number.isSafeInteger(value.fencingToken)) {
      throw new Error('browser-native workspace: backend returned an invalid writer lease')
    }
    this.writerToken = value.writerToken
    this.fencingToken = value.fencingToken
    if (this.workspaceId !== undefined) {
      publishBrowserNativeWorkspaceLease({
        type: 'workspace-lease',
        workspaceId: this.workspaceId,
        writerToken: this.writerToken,
        fencingToken: this.fencingToken,
      })
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
          body: new Uint8Array(toArrayBuffer(content)),
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
  /** Remove a receipt after its Session event is durable. */
  readonly acknowledgeReceipt: (operationId: string) => Promise<void>
  /** Wait until the local durable snapshot has been written. */
  readonly flushLocalWorkspace: () => Promise<void>
  /** Return the PoC writer lease for model-independent browser tests. */
  readonly getWriterLease: () => BrowserNativeWorkspaceWriterLease | undefined
  /** Release the PoC writer lease for model-independent browser tests. */
  readonly releaseWriter: () => Promise<void>
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
  /** Inject storage faults through the PoC-only Worker test port. */
  readonly testHooks?: { readonly abortNextMetadataTransaction?: () => boolean }
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
  const mirror = new BrowserNativeWorkspaceMirror(options.onStatus, store, options.writerLease === true)
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
    acknowledgeReceipt: async operationId => await mirror.acknowledgeReceipt(operationId),
    flushLocalWorkspace: async () => await mirror.flushLocalWorkspace(),
    getWriterLease: () => mirror.getWriterLease(),
    releaseWriter: async () => await mirror.releaseWriter(),
  }
}
