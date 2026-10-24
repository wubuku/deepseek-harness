import type { PendingBatch, WorkspaceChange, WorkspaceReceipt, WorkspaceToolOperation } from './browser-native-workspace.ts'
import type { VfsFileBacking } from '../../../packages/experimental/webworker-runtime/src/storage/types.ts'

const STORE_VERSION = 1
const DATABASE_NAME = 'dsh-browser-native-workspace-v1'
const METADATA_STORE = 'workspace'
const BLOB_DIRECTORY_PREFIX = 'dsh-workspace-blobs-'
const BLOB_IO_CHUNK_BYTES = 1024 * 1024

/** Snapshot persisted locally while a Browser-Native Workspace operation is pending. */
export interface DurableWorkspaceSnapshot {
  readonly version: typeof STORE_VERSION
  readonly workspaceId: string
  readonly revision: number
  readonly pending: readonly WorkspaceChange[]
  readonly retryBatch?: PendingBatch
  readonly receipts?: readonly WorkspaceReceipt[]
}

/** Local store used by the Workspace mirror to survive Worker reconstruction. */
export interface DurableWorkspaceStore {
  /** Read and verify one workspace snapshot. */
  load(workspaceId: string): Promise<DurableWorkspaceSnapshot | undefined>
  /** Persist one snapshot and all referenced content blobs. */
  save(snapshot: DurableWorkspaceSnapshot): Promise<void>
  /** Remove one workspace snapshot and its local content blobs. */
  clear(workspaceId: string): Promise<void>
  /** Cache a verified immutable blob without changing the workspace snapshot. */
  cacheBlob(workspaceId: string, hash: string, content: Uint8Array): Promise<void>
  /** Open a verified immutable blob as a synchronous range backing when supported. */
  openBlob(workspaceId: string, hash: string, bytes: number): Promise<VfsFileBacking | undefined>
}

/** Failure raised when local durable Workspace state cannot be trusted. */
export class DurableWorkspaceStoreError extends Error {
  override readonly name = 'DurableWorkspaceStoreError'

  constructor(
    readonly code: 'LOCAL_STORE_UNAVAILABLE' | 'LOCAL_STORE_NEWER_VERSION' | 'LOCAL_METADATA_INVALID'
      | 'LOCAL_METADATA_MISSING' | 'LOCAL_BLOB_MISSING' | 'LOCAL_BLOB_CORRUPT' | 'LOCAL_BLOB_SIZE_MISMATCH',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

interface StoredChange extends Omit<WorkspaceChange, 'content'> {
  readonly contentHash?: string
}

interface StoredBatch {
  readonly operationId: string
  readonly baseRevision: number
  readonly changes: readonly StoredChange[]
  readonly operation?: WorkspaceToolOperation
}

interface StoredSnapshot {
  readonly version: typeof STORE_VERSION
  readonly workspaceId: string
  readonly revision: number
  readonly pending: readonly StoredChange[]
  readonly retryBatch?: StoredBatch
  readonly receipts?: readonly WorkspaceReceipt[]
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
        ...(snapshot.retryBatch.operation === undefined ? {} : { operation: snapshot.retryBatch.operation }),
      },
    }),
    ...(snapshot.receipts === undefined ? {} : { receipts: snapshot.receipts.map(receipt => ({ ...receipt, paths: [...receipt.paths] })) }),
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(output).set(bytes)
  return output
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

  async cacheBlob(_workspaceId: string, _hash: string, _content: Uint8Array): Promise<void> {}

  async openBlob(_workspaceId: string, _hash: string, _bytes: number): Promise<VfsFileBacking | undefined> {
    return undefined
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
    transaction.onerror = () => {
      if (transaction.error !== null) reject(transaction.error)
    }
    transaction.onabort = () => { reject(transaction.error ?? new Error('browser-native workspace: IndexedDB transaction aborted')) }
  })
}

async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new Error('browser-native workspace: IndexedDB is unavailable')
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(METADATA_STORE)) request.result.createObjectStore(METADATA_STORE, { keyPath: 'workspaceId' })
    }
    request.onsuccess = () => {
      const database = request.result
      if (database.version > STORE_VERSION) {
        const version = database.version
        database.close()
        reject(new DurableWorkspaceStoreError(
          'LOCAL_STORE_NEWER_VERSION',
          `browser-native workspace: local database version ${String(version)} is newer than supported version ${String(STORE_VERSION)}`,
        ))
        return
      }
      resolve(database)
    }
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
    ...(change.operation === undefined ? {} : { operation: change.operation }),
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
    ...(change.operation === undefined ? {} : { operation: change.operation }),
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
  if (value.operation !== undefined) assertStoredOperation(value.operation)
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

function assertStoredOperation(value: unknown): asserts value is WorkspaceToolOperation {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId.length === 0
    || !Number.isSafeInteger(value.turn) || !Number.isSafeInteger(value.step)
    || typeof value.callId !== 'string' || value.callId.length === 0
    || typeof value.toolName !== 'string' || value.toolName.length === 0
    || !Number.isSafeInteger(value.toolCallSeq) || value.toolCallSeq < 0) {
    throw new Error('browser-native workspace: local tool operation is invalid')
  }
}

function assertStoredReceipt(value: unknown): asserts value is WorkspaceReceipt {
  if (!isRecord(value) || typeof value.operationId !== 'string' || value.operationId.length === 0
    || typeof value.workspaceId !== 'string' || !Number.isSafeInteger(value.baseRevision)
    || !Number.isSafeInteger(value.revision) || typeof value.manifestDigest !== 'string'
    || !Array.isArray(value.paths) || value.paths.some(path => typeof path !== 'string')
    || typeof value.replayed !== 'boolean') {
    throw new Error('browser-native workspace: local receipt is invalid')
  }
  if (value.operation !== undefined) assertStoredOperation(value.operation)
}

function assertStoredSnapshot(value: unknown): asserts value is WorkspaceDatabaseRecord {
  if (!isRecord(value) || value.version !== STORE_VERSION || typeof value.workspaceId !== 'string'
    || !Number.isSafeInteger(value.revision) || !Array.isArray(value.pending)) {
    throw new Error('browser-native workspace: local snapshot is invalid')
  }
  for (const change of value.pending) assertStoredChange(change)
  if (value.receipts !== undefined) {
    if (!Array.isArray(value.receipts)) throw new Error('browser-native workspace: local receipt outbox is invalid')
    for (const receipt of value.receipts) assertStoredReceipt(receipt)
  }
  if (value.retryBatch !== undefined) {
    if (!isRecord(value.retryBatch) || typeof value.retryBatch.operationId !== 'string'
      || value.retryBatch.operationId.length === 0 || !Number.isSafeInteger(value.retryBatch.baseRevision)
      || !Array.isArray(value.retryBatch.changes)) {
      throw new Error('browser-native workspace: local retry batch is invalid')
    }
    for (const change of value.retryBatch.changes) assertStoredChange(change)
    if (value.retryBatch.operation !== undefined) assertStoredOperation(value.retryBatch.operation)
  }
}

/** OPFS bytes plus IndexedDB metadata implementation used by the browser Worker. */
export class BrowserDurableWorkspaceStore implements DurableWorkspaceStore {
  private database: IDBDatabase | undefined
  private opfsRoot: FileSystemDirectoryHandle | undefined
  private readonly blobDirectories = new Map<string, FileSystemDirectoryHandle>()

  /** @param testHooks - Optional fault injection used only by Browser-Native PoC tests. */
  constructor(private readonly testHooks?: {
    readonly abortNextMetadataTransaction?: () => boolean
    readonly quotaNextOpfsWrite?: () => boolean
  }) {}

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
    try {
      assertStoredSnapshot(result)
    } catch (error) {
      throw new DurableWorkspaceStoreError(
        'LOCAL_METADATA_INVALID',
        'browser-native workspace: local durable snapshot is invalid',
        { cause: error },
      )
    }
    if (result.workspaceId !== workspaceId) throw new Error('browser-native workspace: local snapshot workspace mismatch')
    return result
  }

  private async writeBlob(directory: FileSystemDirectoryHandle, hash: string, content: Uint8Array): Promise<void> {
    const handle = await directory.getFileHandle(hash, { create: true })
    try {
      const existing = await handle.getFile()
      if (existing.size === content.byteLength) {
        let matches = true
        for (let offset = 0; offset < content.byteLength; offset += BLOB_IO_CHUNK_BYTES) {
          const end = Math.min(offset + BLOB_IO_CHUNK_BYTES, content.byteLength)
          const stored = new Uint8Array(await existing.slice(offset, end).arrayBuffer())
          if (!equalBytes(stored, content.subarray(offset, end))) {
            matches = false
            break
          }
        }
        if (matches) return
      }
    } catch (error) {
      // Rewrite a missing or unreadable local blob below.
      void error
    }
    if (this.testHooks?.quotaNextOpfsWrite?.() === true) {
      throw new DOMException('browser-native workspace: injected OPFS quota failure', 'QuotaExceededError')
    }
    const writable = await handle.createWritable()
    try {
      for (let offset = 0; offset < content.byteLength; offset += BLOB_IO_CHUNK_BYTES) {
        await writable.write({
          type: 'write',
          position: offset,
          data: toArrayBuffer(content.subarray(offset, Math.min(offset + BLOB_IO_CHUNK_BYTES, content.byteLength))),
        })
      }
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
      throw new DurableWorkspaceStoreError(
        'LOCAL_BLOB_MISSING',
        `browser-native workspace: local blob is missing (${hash})`,
        { cause: error },
      )
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (await sha256(bytes) !== hash) {
      throw new DurableWorkspaceStoreError(
        'LOCAL_BLOB_CORRUPT',
        `browser-native workspace: local blob hash mismatch (${hash})`,
      )
    }
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
    const content = await this.readBlob(directory, change.contentHash)
    if (change.bytes !== undefined && change.bytes !== content.byteLength) {
      throw new DurableWorkspaceStoreError(
        'LOCAL_BLOB_SIZE_MISMATCH',
        `browser-native workspace: local blob size mismatch for ${change.path}`,
      )
    }
    return restoreChange(change, content)
  }

  async load(workspaceId: string): Promise<DurableWorkspaceSnapshot | undefined> {
    const { blobDirectory } = await this.resources(workspaceId)
    const record = await this.readRecord(workspaceId)
    if (record === undefined) {
      for await (const entry of blobDirectory.values()) {
        if (entry.kind === 'file') {
          throw new DurableWorkspaceStoreError(
            'LOCAL_METADATA_MISSING',
            'browser-native workspace: local OPFS blobs exist without IndexedDB metadata',
          )
        }
      }
      return undefined
    }
    const pending: WorkspaceChange[] = []
    for (const change of record.pending) pending.push(await this.decodeChange(blobDirectory, change))
    const retryBatch = record.retryBatch === undefined ? undefined : {
      operationId: record.retryBatch.operationId,
      baseRevision: record.retryBatch.baseRevision,
      changes: await this.decodeChanges(blobDirectory, record.retryBatch.changes),
      ...(record.retryBatch.operation === undefined ? {} : { operation: record.retryBatch.operation }),
    }
    return {
      version: STORE_VERSION,
      workspaceId: record.workspaceId,
      revision: record.revision,
      pending,
      ...(retryBatch === undefined ? {} : { retryBatch }),
      ...(record.receipts === undefined ? {} : { receipts: record.receipts }),
    }
  }

  private async decodeChanges(directory: FileSystemDirectoryHandle, changes: readonly StoredChange[]): Promise<WorkspaceChange[]> {
    const decoded: WorkspaceChange[] = []
    for (const change of changes) decoded.push(await this.decodeChange(directory, change))
    return decoded
  }

  async save(snapshot: DurableWorkspaceSnapshot): Promise<void> {
    const { database, blobDirectory } = await this.resources(snapshot.workspaceId)
    const pending = await Promise.all(snapshot.pending.map(change => this.encodeChange(blobDirectory, change)))
    const retryBatch = snapshot.retryBatch === undefined ? undefined : {
      operationId: snapshot.retryBatch.operationId,
      baseRevision: snapshot.retryBatch.baseRevision,
      changes: await Promise.all(snapshot.retryBatch.changes.map(change => this.encodeChange(blobDirectory, change))),
      ...(snapshot.retryBatch.operation === undefined ? {} : { operation: snapshot.retryBatch.operation }),
    }
    const record: WorkspaceDatabaseRecord = {
      version: STORE_VERSION,
      workspaceId: snapshot.workspaceId,
      revision: snapshot.revision,
      pending,
      ...(retryBatch === undefined ? {} : { retryBatch }),
      ...(snapshot.receipts === undefined ? {} : { receipts: snapshot.receipts }),
    }
    const transaction = database.transaction(METADATA_STORE, 'readwrite')
    const committed = transactionDone(transaction)
    transaction.objectStore(METADATA_STORE).put(record)
    if (this.testHooks?.abortNextMetadataTransaction?.() === true) transaction.abort()
    await committed
  }

  async clear(workspaceId: string): Promise<void> {
    const { database } = await this.resources(workspaceId)
    await this.opfsRoot?.removeEntry(`${BLOB_DIRECTORY_PREFIX}${workspaceId}`, { recursive: true })
    this.blobDirectories.delete(workspaceId)
    const transaction = database.transaction(METADATA_STORE, 'readwrite')
    transaction.objectStore(METADATA_STORE).delete(workspaceId)
    await transactionDone(transaction)
  }

  async cacheBlob(workspaceId: string, hash: string, content: Uint8Array): Promise<void> {
    const { blobDirectory } = await this.resources(workspaceId)
    if (await sha256(content) !== hash) {
      throw new DurableWorkspaceStoreError('LOCAL_BLOB_CORRUPT', `browser-native workspace: blob hash mismatch (${hash})`)
    }
    await this.writeBlob(blobDirectory, hash, content)
  }

  async openBlob(workspaceId: string, hash: string, bytes: number): Promise<VfsFileBacking | undefined> {
    const { blobDirectory } = await this.resources(workspaceId)
    let handle: FileSystemFileHandle
    try {
      handle = await blobDirectory.getFileHandle(hash)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return undefined
      throw new DurableWorkspaceStoreError('LOCAL_BLOB_MISSING', `browser-native workspace: local blob is missing (${hash})`, { cause: error })
    }
    const file = await handle.getFile()
    if (file.size !== bytes) {
      throw new DurableWorkspaceStoreError('LOCAL_BLOB_SIZE_MISMATCH', `browser-native workspace: local blob size mismatch (${hash})`)
    }
    const content = new Uint8Array(await file.arrayBuffer())
    if (await sha256(content) !== hash) {
      throw new DurableWorkspaceStoreError('LOCAL_BLOB_CORRUPT', `browser-native workspace: local blob hash mismatch (${hash})`)
    }
    const sync = await handle.createSyncAccessHandle()
    if (sync.getSize() !== bytes) {
      sync.close()
      throw new DurableWorkspaceStoreError('LOCAL_BLOB_SIZE_MISMATCH', `browser-native workspace: local blob size mismatch (${hash})`)
    }
    return {
      size: bytes,
      read: (position, length) => {
        if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0) {
          throw new RangeError('browser-native workspace: invalid external blob read range')
        }
        const output = new Uint8Array(Math.min(length, Math.max(0, bytes - position)))
        const read = sync.read(output, { at: position })
        return output.subarray(0, read)
      },
      close: () => { sync.close() },
    }
  }
}

/**
 * Create the browser implementation explicitly at the opt-in integration seam.
 * @param testHooks - Optional fault injection used only by Browser-Native PoC tests.
 * @returns The OPFS and IndexedDB Workspace store.
 */
export function createBrowserDurableWorkspaceStore(
  testHooks?: {
    readonly abortNextMetadataTransaction?: () => boolean
    readonly quotaNextOpfsWrite?: () => boolean
  },
): DurableWorkspaceStore {
  return new BrowserDurableWorkspaceStore(testHooks)
}
