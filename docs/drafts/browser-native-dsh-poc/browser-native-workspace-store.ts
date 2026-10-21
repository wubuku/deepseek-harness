import type { PendingBatch, WorkspaceChange } from './browser-native-workspace.ts'

const STORE_VERSION = 1
const DATABASE_NAME = 'dsh-browser-native-workspace-v1'
const METADATA_STORE = 'workspace'
const BLOB_DIRECTORY_PREFIX = 'dsh-workspace-blobs-'

/** Snapshot persisted locally while a Browser-Native Workspace operation is pending. */
export interface DurableWorkspaceSnapshot {
  readonly version: typeof STORE_VERSION
  readonly workspaceId: string
  readonly revision: number
  readonly pending: readonly WorkspaceChange[]
  readonly retryBatch?: PendingBatch
}

/** Local store used by the Workspace mirror to survive Worker reconstruction. */
export interface DurableWorkspaceStore {
  /** Read and verify one workspace snapshot. */
  load(workspaceId: string): Promise<DurableWorkspaceSnapshot | undefined>
  /** Persist one snapshot and all referenced content blobs. */
  save(snapshot: DurableWorkspaceSnapshot): Promise<void>
  /** Remove one workspace snapshot and its local content blobs. */
  clear(workspaceId: string): Promise<void>
}

interface StoredChange extends Omit<WorkspaceChange, 'content'> {
  readonly contentHash?: string
}

interface StoredBatch {
  readonly operationId: string
  readonly baseRevision: number
  readonly changes: readonly StoredChange[]
}

interface StoredSnapshot {
  readonly version: typeof STORE_VERSION
  readonly workspaceId: string
  readonly revision: number
  readonly pending: readonly StoredChange[]
  readonly retryBatch?: StoredBatch
}

interface WorkspaceDatabaseRecord extends StoredSnapshot {
  readonly workspaceId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneChange(change: WorkspaceChange): WorkspaceChange {
  return {
    ...change,
    ...(change.content === undefined ? {} : { content: change.content.slice() }),
  }
}

function cloneSnapshot(snapshot: DurableWorkspaceSnapshot): DurableWorkspaceSnapshot {
  return {
    version: STORE_VERSION,
    workspaceId: snapshot.workspaceId,
    revision: snapshot.revision,
    pending: snapshot.pending.map(cloneChange),
    ...(snapshot.retryBatch === undefined ? {} : {
      retryBatch: {
        operationId: snapshot.retryBatch.operationId,
        baseRevision: snapshot.retryBatch.baseRevision,
        changes: snapshot.retryBatch.changes.map(cloneChange),
      },
    }),
  }
}

/** In-memory implementation used by deterministic unit tests. */
export class MemoryDurableWorkspaceStore implements DurableWorkspaceStore {
  private readonly snapshots = new Map<string, DurableWorkspaceSnapshot>()

  async load(workspaceId: string): Promise<DurableWorkspaceSnapshot | undefined> {
    const snapshot = this.snapshots.get(workspaceId)
    return snapshot === undefined ? undefined : cloneSnapshot(snapshot)
  }

  async save(snapshot: DurableWorkspaceSnapshot): Promise<void> {
    this.snapshots.set(snapshot.workspaceId, cloneSnapshot(snapshot))
  }

  async clear(workspaceId: string): Promise<void> {
    this.snapshots.delete(workspaceId)
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('browser-native workspace: IndexedDB request failed')) }
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => { resolve() }
    transaction.onerror = () => { reject(transaction.error ?? new Error('browser-native workspace: IndexedDB transaction failed')) }
    transaction.onabort = () => { reject(transaction.error ?? new Error('browser-native workspace: IndexedDB transaction aborted')) }
  })
}

async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new Error('browser-native workspace: IndexedDB is unavailable')
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, STORE_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(METADATA_STORE)) request.result.createObjectStore(METADATA_STORE, { keyPath: 'workspaceId' })
    }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('browser-native workspace: IndexedDB open failed')) }
    request.onblocked = () => { reject(new Error('browser-native workspace: IndexedDB open was blocked')) }
  })
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(input).set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', input)
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}

function storedChange(change: WorkspaceChange, contentHash?: string): StoredChange {
  const metadata: Omit<WorkspaceChange, 'content'> = {
    path: change.path,
    ...(change.deleted === true ? { deleted: true } : {}),
    ...(change.kind === undefined ? {} : { kind: change.kind }),
    ...(change.mode === undefined ? {} : { mode: change.mode }),
    ...(change.hash === undefined ? {} : { hash: change.hash }),
    ...(change.bytes === undefined ? {} : { bytes: change.bytes }),
  }
  return {
    ...metadata,
    ...(contentHash === undefined ? {} : { contentHash }),
  }
}

function restoreChange(change: StoredChange, content: Uint8Array | undefined): WorkspaceChange {
  const metadata: WorkspaceChange = {
    path: change.path,
    ...(change.deleted === true ? { deleted: true } : {}),
    ...(change.kind === undefined ? {} : { kind: change.kind }),
    ...(change.mode === undefined ? {} : { mode: change.mode }),
    ...(change.hash === undefined ? {} : { hash: change.hash }),
    ...(change.bytes === undefined ? {} : { bytes: change.bytes }),
  }
  if (change.deleted === true || change.kind === 'directory') return metadata
  if (change.contentHash === undefined || content === undefined) throw new Error(`browser-native workspace: local blob is missing for ${change.path}`)
  if (change.bytes !== undefined && change.bytes !== content.byteLength) throw new Error(`browser-native workspace: local blob size mismatch for ${change.path}`)
  return { ...metadata, content }
}

function assertStoredChange(value: unknown): asserts value is StoredChange {
  if (!isRecord(value) || typeof value.path !== 'string') {
    throw new Error('browser-native workspace: local change is invalid')
  }
  if (value.deleted === true) return
  if (value.kind === 'directory') {
    if (value.contentHash !== undefined || !Number.isSafeInteger(value.mode)) {
      throw new Error(`browser-native workspace: local directory change is invalid for ${value.path}`)
    }
    return
  }
  if (value.kind !== 'file' || typeof value.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentHash)
    || !Number.isSafeInteger(value.mode) || typeof value.bytes !== 'number'
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new Error(`browser-native workspace: local file change is invalid for ${value.path}`)
  }
}

function assertStoredSnapshot(value: unknown): asserts value is WorkspaceDatabaseRecord {
  if (!isRecord(value) || value.version !== STORE_VERSION || typeof value.workspaceId !== 'string'
    || !Number.isSafeInteger(value.revision) || !Array.isArray(value.pending)) {
    throw new Error('browser-native workspace: local snapshot is invalid')
  }
  for (const change of value.pending) assertStoredChange(change)
  if (value.retryBatch !== undefined) {
    if (!isRecord(value.retryBatch) || typeof value.retryBatch.operationId !== 'string'
      || value.retryBatch.operationId.length === 0 || !Number.isSafeInteger(value.retryBatch.baseRevision)
      || !Array.isArray(value.retryBatch.changes)) {
      throw new Error('browser-native workspace: local retry batch is invalid')
    }
    for (const change of value.retryBatch.changes) assertStoredChange(change)
  }
}

/** OPFS bytes plus IndexedDB metadata implementation used by the browser Worker. */
export class BrowserDurableWorkspaceStore implements DurableWorkspaceStore {
  private database: IDBDatabase | undefined
  private opfsRoot: FileSystemDirectoryHandle | undefined
  private readonly blobDirectories = new Map<string, FileSystemDirectoryHandle>()

  private async resources(workspaceId: string): Promise<{ database: IDBDatabase; blobDirectory: FileSystemDirectoryHandle }> {
    this.database ??= await openDatabase()
    let blobDirectory = this.blobDirectories.get(workspaceId)
    if (blobDirectory === undefined) {
      const storage = globalThis.navigator?.storage
      if (storage === undefined || typeof storage.getDirectory !== 'function') {
        throw new Error('browser-native workspace: OPFS is unavailable')
      }
      const root = await storage.getDirectory()
      this.opfsRoot = root
      blobDirectory = await root.getDirectoryHandle(`${BLOB_DIRECTORY_PREFIX}${workspaceId}`, { create: true })
      this.blobDirectories.set(workspaceId, blobDirectory)
    }
    return { database: this.database, blobDirectory }
  }

  private async readRecord(workspaceId: string): Promise<WorkspaceDatabaseRecord | undefined> {
    const { database } = await this.resources(workspaceId)
    const transaction = database.transaction(METADATA_STORE, 'readonly')
    const result = await requestResult(transaction.objectStore(METADATA_STORE).get(workspaceId))
    await transactionDone(transaction)
    if (result === undefined) return undefined
    assertStoredSnapshot(result)
    if (result.workspaceId !== workspaceId) throw new Error('browser-native workspace: local snapshot workspace mismatch')
    return result
  }

  private async writeBlob(directory: FileSystemDirectoryHandle, hash: string, content: Uint8Array): Promise<void> {
    const handle = await directory.getFileHandle(hash, { create: true })
    try {
      const existing = await handle.getFile()
      if (existing.size === content.byteLength && await sha256(new Uint8Array(await existing.arrayBuffer())) === hash) return
    } catch (error) {
      // Rewrite a missing or unreadable local blob below.
      void error
    }
    const writable = await handle.createWritable()
    try {
      await writable.write(toArrayBuffer(content))
      await writable.close()
    } catch (error) {
      try {
        await writable.abort()
      } catch (abortError) {
        // The original write error is more useful to the caller.
        void abortError
      }
      throw error
    }
  }

  private async readBlob(directory: FileSystemDirectoryHandle, hash: string): Promise<Uint8Array> {
    let file: File
    try {
      file = await (await directory.getFileHandle(hash)).getFile()
    } catch (error) {
      throw new Error(`browser-native workspace: local blob is missing (${hash})`, { cause: error })
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (await sha256(bytes) !== hash) throw new Error(`browser-native workspace: local blob hash mismatch (${hash})`)
    return bytes
  }

  private async encodeChange(directory: FileSystemDirectoryHandle, change: WorkspaceChange): Promise<StoredChange> {
    if (change.content === undefined) return storedChange(change)
    const contentHash = await sha256(change.content)
    await this.writeBlob(directory, contentHash, change.content)
    return storedChange(change, contentHash)
  }

  private async decodeChange(directory: FileSystemDirectoryHandle, change: StoredChange): Promise<WorkspaceChange> {
    if (change.contentHash === undefined) return restoreChange(change, undefined)
    return restoreChange(change, await this.readBlob(directory, change.contentHash))
  }

  async load(workspaceId: string): Promise<DurableWorkspaceSnapshot | undefined> {
    const { blobDirectory } = await this.resources(workspaceId)
    const record = await this.readRecord(workspaceId)
    if (record === undefined) return undefined
    const pending = await Promise.all(record.pending.map(change => this.decodeChange(blobDirectory, change)))
    const retryBatch = record.retryBatch === undefined ? undefined : {
      operationId: record.retryBatch.operationId,
      baseRevision: record.retryBatch.baseRevision,
      changes: await Promise.all(record.retryBatch.changes.map(change => this.decodeChange(blobDirectory, change))),
    }
    return {
      version: STORE_VERSION,
      workspaceId: record.workspaceId,
      revision: record.revision,
      pending,
      ...(retryBatch === undefined ? {} : { retryBatch }),
    }
  }

  async save(snapshot: DurableWorkspaceSnapshot): Promise<void> {
    const { database, blobDirectory } = await this.resources(snapshot.workspaceId)
    const pending = await Promise.all(snapshot.pending.map(change => this.encodeChange(blobDirectory, change)))
    const retryBatch = snapshot.retryBatch === undefined ? undefined : {
      operationId: snapshot.retryBatch.operationId,
      baseRevision: snapshot.retryBatch.baseRevision,
      changes: await Promise.all(snapshot.retryBatch.changes.map(change => this.encodeChange(blobDirectory, change))),
    }
    const record: WorkspaceDatabaseRecord = {
      version: STORE_VERSION,
      workspaceId: snapshot.workspaceId,
      revision: snapshot.revision,
      pending,
      ...(retryBatch === undefined ? {} : { retryBatch }),
    }
    const transaction = database.transaction(METADATA_STORE, 'readwrite')
    transaction.objectStore(METADATA_STORE).put(record)
    await transactionDone(transaction)
  }

  async clear(workspaceId: string): Promise<void> {
    const { database } = await this.resources(workspaceId)
    await this.opfsRoot?.removeEntry(`${BLOB_DIRECTORY_PREFIX}${workspaceId}`, { recursive: true })
    this.blobDirectories.delete(workspaceId)
    const transaction = database.transaction(METADATA_STORE, 'readwrite')
    transaction.objectStore(METADATA_STORE).delete(workspaceId)
    await transactionDone(transaction)
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(output).set(bytes)
  return output
}

/** Create the browser implementation explicitly at the opt-in integration seam. */
export function createBrowserDurableWorkspaceStore(): DurableWorkspaceStore {
  return new BrowserDurableWorkspaceStore()
}
