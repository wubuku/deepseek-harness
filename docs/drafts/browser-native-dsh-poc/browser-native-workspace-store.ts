import type { PendingBatch, WorkspaceChange, WorkspaceReceipt, WorkspaceToolOperation } from './browser-native-workspace.ts'
import type { VfsFileBacking } from '../../../packages/experimental/webworker-runtime/src/storage/types.ts'
import { Sha256 } from './browser-native-sha256.ts'
import { BrowserDownloadJournal, withWorkspaceStorageLock } from './browser-native-download-journal.ts'
import type { DownloadJournal } from './browser-native-download-journal.ts'

const STORE_VERSION = 1
const DATABASE_NAME = 'dsh-browser-native-workspace-v1'
const DATABASE_VERSION = 2
const METADATA_STORE = 'workspace'
const CONTROL_STORE = 'control'
const BLOB_DIRECTORY_PREFIX = 'dsh-workspace-blobs-'
const BLOB_IO_CHUNK_BYTES = 1024 * 1024
const OPFS_ACCESS_HANDLE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const

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
  /**
   * Bind this instance once to a new local writer epoch, superseding previous instances.
   * Browser stores await optional authorization under the Workspace lock and run its synchronous
   * validity check immediately before writing control metadata. Callers own fresh authorization;
   * omitting it acquires only local write access without consulting a backend lease.
   * @param workspaceId - Workspace whose writer is acquired before recovery.
   * @param authorize - Optional authorization returning a synchronous check that throws if authority expired.
   * @returns Resolves after the writer identity commits; authorization failure preserves shared metadata
   * and permanently invalidates this Browser store's binding, requiring a new instance.
   */
  acquireWriter(workspaceId: string, authorize?: () => Promise<() => void>): Promise<void>
  /**
   * Verify that this instance still owns its acquired local writer epoch.
   * @param workspaceId - Workspace whose writer must remain usable.
   * @returns Rejects after invalidation or takeover; loading never restores write access.
   */
  assertWriter(workspaceId: string): Promise<void>
  /**
   * Permanently revoke this instance's writer eligibility, including queued operations.
   * @param workspaceId - Workspace whose local binding is invalidated without changing shared data.
   */
  invalidateWriter(workspaceId: string): void
  /** List Workspace IDs that still have IndexedDB metadata or OPFS bytes. */
  listWorkspaceIds(): Promise<readonly string[]>
  /** Read and verify one workspace snapshot. */
  load(workspaceId: string): Promise<DurableWorkspaceSnapshot | undefined>
  /** Persist one snapshot and all referenced content blobs. */
  save(snapshot: DurableWorkspaceSnapshot): Promise<void>
  /** Remove one workspace snapshot and its local content blobs. */
  clear(workspaceId: string): Promise<void>
  /** Cache a verified immutable blob without changing the workspace snapshot. */
  cacheBlob(workspaceId: string, hash: string, content: Uint8Array): Promise<void>
  /** Cache bytes from a synchronous range source without assembling the file in JS memory. */
  cacheBlobFromRanges(
    workspaceId: string,
    hash: string,
    bytes: number,
    readRange: (offset: number, length: number) => Uint8Array,
  ): Promise<void>
  /** Open a verified immutable blob as a synchronous range backing when supported. */
  openBlob(workspaceId: string, hash: string, bytes: number): Promise<VfsFileBacking | undefined>
  /** Stream a remote blob into local durable storage without assembling the whole file in JS memory. */
  cacheBlobFromChunks(
    workspaceId: string,
    hash: string,
    bytes: number,
    readChunk: (offset: number, length: number) => Promise<Uint8Array>,
  ): Promise<boolean>
  /** Remove local blobs that are not referenced by the remote manifest or pending metadata. */
  reconcileBlobs(workspaceId: string, retainedHashes: readonly string[]): Promise<BlobReconciliation>
}

/** Result of conservative local content-addressed blob reconciliation. */
export interface BlobReconciliation {
  readonly removedFiles: number
  readonly removedBytes: number
  readonly retainedFiles: number
  readonly skipped?: 'metadata-missing'
}

/** Failure raised when local durable Workspace state cannot be trusted. */
export class DurableWorkspaceStoreError extends Error {
  override readonly name = 'DurableWorkspaceStoreError'

  constructor(
    readonly code: 'LOCAL_STORE_UNAVAILABLE' | 'LOCAL_STORE_NEWER_VERSION' | 'LOCAL_METADATA_INVALID'
      | 'LOCAL_METADATA_MISSING' | 'LOCAL_BLOB_MISSING' | 'LOCAL_BLOB_CORRUPT' | 'LOCAL_BLOB_SIZE_MISMATCH'
      | 'LOCAL_DOWNLOAD_PROTECTED' | 'LOCAL_SNAPSHOT_CONFLICT' | 'LOCAL_WRITER_LOST' | 'LOCAL_CONTROL_INVALID',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

interface StoredChange extends Omit<WorkspaceChange, 'content' | 'contentReference'> {
  readonly contentHash?: string
  readonly externalContent?: boolean
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

interface WorkspaceControlRecord {
  readonly version: 1
  readonly workspaceId: string
  readonly writerEpoch: number
  readonly generation: number
  readonly writerId?: string
}

interface LocalWriterBinding {
  readonly writerId: string
  writerEpoch: number | undefined
  invalidated: boolean
}

function emptyControl(workspaceId: string): WorkspaceControlRecord {
  return { version: 1, workspaceId, writerEpoch: 0, generation: 0 }
}

function invalidControl(message: string): DurableWorkspaceStoreError {
  return new DurableWorkspaceStoreError('LOCAL_CONTROL_INVALID', `browser-native workspace: ${message}; retain local data and reload`)
}

function assertControl(value: unknown, workspaceId: string): asserts value is WorkspaceControlRecord {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)
    || !isRecord(value) || value.version !== 1 || value.workspaceId !== workspaceId
    || typeof value.writerEpoch !== 'number' || !Number.isSafeInteger(value.writerEpoch) || value.writerEpoch < 0
    || typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation < 0
    || (value.writerEpoch === 0 ? value.writerId !== undefined
      : typeof value.writerId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.writerId))) {
    throw invalidControl('local writer control is invalid or unsupported')
  }
}

function incrementControl(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) throw invalidControl('local writer counter is exhausted')
  return value + 1
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
  private readonly blobs = new Map<string, Uint8Array>()

  async acquireWriter(_workspaceId: string, authorize?: () => Promise<() => void>): Promise<void> {
    const assertAuthorized = await authorize?.()
    assertAuthorized?.()
  }

  async assertWriter(_workspaceId: string): Promise<void> {}

  invalidateWriter(_workspaceId: string): void {}

  async listWorkspaceIds(): Promise<readonly string[]> {
    const workspaceIds = new Set(this.snapshots.keys())
    for (const key of this.blobs.keys()) {
      const separator = key.indexOf(':')
      if (separator > 0) workspaceIds.add(key.slice(0, separator))
    }
    return [...workspaceIds].sort()
  }

  async load(workspaceId: string): Promise<DurableWorkspaceSnapshot | undefined> {
    const snapshot = this.snapshots.get(workspaceId)
    return snapshot === undefined ? undefined : cloneSnapshot(snapshot)
  }

  async save(snapshot: DurableWorkspaceSnapshot): Promise<void> {
    this.snapshots.set(snapshot.workspaceId, cloneSnapshot(snapshot))
  }

  async clear(workspaceId: string): Promise<void> {
    this.snapshots.delete(workspaceId)
    for (const key of this.blobs.keys()) if (key.startsWith(`${workspaceId}:`)) this.blobs.delete(key)
  }

  async cacheBlob(workspaceId: string, hash: string, content: Uint8Array): Promise<void> {
    if (await sha256(content) !== hash) throw new Error(`browser-native workspace: memory blob hash mismatch (${hash})`)
    this.blobs.set(`${workspaceId}:${hash}`, content.slice())
  }

  async cacheBlobFromRanges(
    workspaceId: string,
    hash: string,
    bytes: number,
    readRange: (offset: number, length: number) => Uint8Array,
  ): Promise<void> {
    const output = new Uint8Array(bytes)
    for (let offset = 0; offset < bytes; offset += BLOB_IO_CHUNK_BYTES) {
      const length = Math.min(BLOB_IO_CHUNK_BYTES, bytes - offset)
      const chunk = readRange(offset, length)
      if (chunk.byteLength !== length) throw new Error(`browser-native workspace: range source returned a short chunk for ${hash}`)
      output.set(chunk, offset)
    }
    await this.cacheBlob(workspaceId, hash, output)
  }

  async openBlob(workspaceId: string, hash: string, bytes: number): Promise<VfsFileBacking | undefined> {
    const content = this.blobs.get(`${workspaceId}:${hash}`)
    if (content === undefined || content.byteLength !== bytes) return undefined
    let closed = false
    return {
      size: bytes,
      reference: { hash, bytes },
      read: (position, length) => {
        if (closed) throw new Error('browser-native workspace: memory blob is closed')
        return content.slice(position, Math.min(position + length, bytes))
      },
      close: () => { closed = true },
    }
  }

  async cacheBlobFromChunks(
    _workspaceId: string,
    _hash: string,
    _bytes: number,
    _readChunk: (offset: number, length: number) => Promise<Uint8Array>,
  ): Promise<boolean> {
    return false
  }

  async reconcileBlobs(_workspaceId: string, _retainedHashes: readonly string[]): Promise<BlobReconciliation> {
    return { removedFiles: 0, removedBytes: 0, retainedFiles: 0 }
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
    transaction.onabort = () => { reject(transaction.error ?? new Error('browser-native workspace: IndexedDB transaction aborted')) }
  })
}

function assertDatabaseSchema(database: IDBDatabase, transaction: IDBTransaction, legacy = false): void {
  if (database.objectStoreNames.length !== (legacy ? 1 : 2)
    || !database.objectStoreNames.contains(METADATA_STORE)
    || (!legacy && !database.objectStoreNames.contains(CONTROL_STORE))) {
    throw invalidControl('local database stores are unsupported')
  }
  for (const name of legacy ? [METADATA_STORE] : [METADATA_STORE, CONTROL_STORE]) {
    const store = transaction.objectStore(name)
    if (store.keyPath !== 'workspaceId' || store.autoIncrement || store.indexNames.length !== 0) {
      throw invalidControl('local database store schema is unsupported')
    }
  }
}

async function openDatabase(onVersionChange?: () => void): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new Error('browser-native workspace: IndexedDB is unavailable')
  return await new Promise<IDBDatabase>((resolve, reject) => {
    let failed = false
    let upgradeFailure: unknown
    const fail = (error: unknown): void => {
      failed = true
      reject(error)
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = event => {
      const database = request.result
      const transaction = request.transaction
      if (transaction === null) return fail(invalidControl('local database upgrade has no transaction'))
      try {
        if (failed) throw new Error('browser-native workspace: blocked database upgrade was cancelled')
        if (event.oldVersion === 0) {
          database.createObjectStore(METADATA_STORE, { keyPath: 'workspaceId' })
          database.createObjectStore(CONTROL_STORE, { keyPath: 'workspaceId' })
        } else if (event.oldVersion === 1) {
          assertDatabaseSchema(database, transaction, true)
          const controls = database.createObjectStore(CONTROL_STORE, { keyPath: 'workspaceId' })
          const cursorRequest = transaction.objectStore(METADATA_STORE).openCursor()
          cursorRequest.onsuccess = () => {
            try {
              const cursor = cursorRequest.result
              if (cursor === null) return
              const snapshot: unknown = cursor.value
              assertStoredSnapshot(snapshot)
              if (cursor.primaryKey !== snapshot.workspaceId) throw invalidControl('legacy snapshot key does not match its Workspace')
              const control = emptyControl(snapshot.workspaceId)
              assertControl(control, snapshot.workspaceId)
              controls.put(control)
              cursor.continue()
            } catch (error) {
              upgradeFailure = error
              transaction.abort()
            }
          }
        } else {
          throw invalidControl('local database upgrade version is unsupported')
        }
      } catch (error) {
        upgradeFailure = error
        transaction.abort()
      }
    }
    request.onsuccess = () => {
      const database = request.result
      if (failed) {
        database.close()
        return
      }
      try {
        if (database.version !== DATABASE_VERSION) throw invalidControl('local database version is unsupported')
        assertDatabaseSchema(database, database.transaction([METADATA_STORE, CONTROL_STORE], 'readonly'))
      } catch (error) {
        database.close()
        fail(error)
        return
      }
      database.onversionchange = () => {
        database.close()
        onVersionChange?.()
      }
      resolve(database)
    }
    request.onerror = () => {
      fail(upgradeFailure ?? (request.error?.name === 'VersionError'
        ? new DurableWorkspaceStoreError('LOCAL_STORE_NEWER_VERSION', 'browser-native workspace: local database is newer than supported version 2; retain local data and update this page')
        : request.error ?? new Error('browser-native workspace: IndexedDB open failed')))
    }
    request.onblocked = () => { fail(new DurableWorkspaceStoreError('LOCAL_STORE_UNAVAILABLE', 'browser-native workspace: database upgrade is blocked; close older pages and reload')) }
  })
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return new Sha256().update(bytes).digestHex()
}

async function sha256File(file: File): Promise<string> {
  const digest = new Sha256()
  for (let offset = 0; offset < file.size; offset += BLOB_IO_CHUNK_BYTES) {
    const bytes = new Uint8Array(await file.slice(offset, Math.min(offset + BLOB_IO_CHUNK_BYTES, file.size)).arrayBuffer())
    digest.update(bytes)
  }
  return digest.digestHex()
}

function storedChange(change: WorkspaceChange, contentHash?: string, externalContent = false): StoredChange {
  const metadata: Omit<WorkspaceChange, 'content' | 'contentReference'> = {
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
    ...(externalContent ? { externalContent: true } : {}),
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
  if (change.externalContent === true) {
    if (change.contentHash === undefined || change.bytes === undefined) {
      throw new Error(`browser-native workspace: external local blob metadata is incomplete for ${change.path}`)
    }
    return { ...metadata, contentReference: { hash: change.contentHash, bytes: change.bytes } }
  }
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
  if (value.externalContent !== undefined && value.externalContent !== true) {
    throw new Error(`browser-native workspace: local external content flag is invalid for ${value.path}`)
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

/** Deterministic publication points exposed only through the PoC test port. */
export type DownloadPublicationStage = 'intent-durable' | 'entry-created' | 'first-chunk-written' | 'published'

/**
 * OPFS bytes and IndexedDB metadata, serialized across Workers by a Workspace Web Lock.
 * Acquired writer identities fence every storage operation; invalidation is permanent for this instance.
 * Snapshot writes atomically advance a separate control generation, including identical writes and clear.
 * Existing snapshots require a successful load; changed generations reject with LOCAL_SNAPSHOT_CONFLICT.
 * Unclaimed control records permit low-level CAS use until the first explicit acquisition.
 * Strict IndexedDB durability requests persistence without guaranteeing survival of an OS crash.
 */
export class BrowserDurableWorkspaceStore implements DurableWorkspaceStore {
  private database: IDBDatabase | undefined
  private opfsRoot: FileSystemDirectoryHandle | undefined
  private readonly blobDirectories = new Map<string, FileSystemDirectoryHandle>()
  private readonly observedGenerations = new Map<string, number>()
  private readonly writerBindings = new Map<string, LocalWriterBinding>()
  private readonly invalidatedWorkspaces = new Set<string>()
  private readonly activeWrites = new Map<string, Set<IDBTransaction>>()
  private databaseInvalidated = false

  /**
   * @param testHooks - Optional fault injection used only by Browser-Native PoC tests.
   * @param journal - Download intents committed before creating new cache entries.
   */
  constructor(private readonly testHooks?: {
    readonly abortNextMetadataTransaction?: () => boolean
    readonly quotaNextOpfsWrite?: () => boolean
    readonly downloadStage?: (stage: DownloadPublicationStage) => Promise<void>
  }, private readonly journal: DownloadJournal = new BrowserDownloadJournal()) {}

  private lostWriter(): DurableWorkspaceStoreError {
    return new DurableWorkspaceStoreError('LOCAL_WRITER_LOST', 'browser-native workspace: local writer was invalidated or superseded; reload before using Workspace files')
  }

  private assertNotInvalidated(workspaceId: string): void {
    if (this.databaseInvalidated) {
      throw new DurableWorkspaceStoreError('LOCAL_STORE_UNAVAILABLE', 'browser-native workspace: local database version changed; reload this page')
    }
    if (this.invalidatedWorkspaces.has(workspaceId)) throw this.lostWriter()
  }

  private async getDatabase(): Promise<IDBDatabase> {
    if (this.databaseInvalidated) {
      throw new DurableWorkspaceStoreError('LOCAL_STORE_UNAVAILABLE', 'browser-native workspace: local database version changed; reload this page')
    }
    this.database ??= await openDatabase(() => {
      this.databaseInvalidated = true
      for (const workspaceId of this.activeWrites.keys()) this.invalidateWriter(workspaceId)
    })
    return this.database
  }

  private async metadata<T>(
    workspaceId: string,
    mode: IDBTransactionMode,
    operation: (snapshot: WorkspaceDatabaseRecord | undefined, control: WorkspaceControlRecord, transaction: IDBTransaction) => T,
  ): Promise<T> {
    const database = await this.getDatabase()
    this.assertNotInvalidated(workspaceId)
    const transaction = database.transaction([METADATA_STORE, CONTROL_STORE], mode, mode === 'readwrite' ? { durability: 'strict' } : undefined)
    const committed = transactionDone(transaction)
    if (mode === 'readwrite') {
      let writes = this.activeWrites.get(workspaceId)
      if (writes === undefined) this.activeWrites.set(workspaceId, writes = new Set())
      writes.add(transaction)
    }
    try {
      const [snapshot, storedControl]: [unknown, unknown] = await Promise.all([
        requestResult(transaction.objectStore(METADATA_STORE).get(workspaceId)),
        requestResult(transaction.objectStore(CONTROL_STORE).get(workspaceId)),
      ])
      if (snapshot !== undefined) {
        try {
          assertStoredSnapshot(snapshot)
          if (snapshot.workspaceId !== workspaceId) throw new Error('local snapshot Workspace does not match its key')
        } catch (error) {
          throw new DurableWorkspaceStoreError('LOCAL_METADATA_INVALID', 'browser-native workspace: local durable snapshot is invalid', { cause: error })
        }
      }
      if (storedControl === undefined && snapshot !== undefined) throw invalidControl('local snapshot has no writer control')
      const control: unknown = storedControl === undefined ? emptyControl(workspaceId) : storedControl
      assertControl(control, workspaceId)
      const result = operation(snapshot, control, transaction)
      await committed
      return result
    } catch (error) {
      try {
        transaction.abort()
      } catch (abortError) {
        void abortError
      }
      await committed.catch(() => {})
      if (this.invalidatedWorkspaces.has(workspaceId)) throw this.lostWriter()
      throw error
    } finally {
      this.activeWrites.get(workspaceId)?.delete(transaction)
    }
  }

  private checkWriter(workspaceId: string, control: WorkspaceControlRecord, requireBinding = false): void {
    this.assertNotInvalidated(workspaceId)
    const binding = this.writerBindings.get(workspaceId)
    if (!requireBinding && binding === undefined && control.writerEpoch === 0) return
    if (binding === undefined || binding.invalidated || binding.writerEpoch === undefined
      || binding.writerId !== control.writerId || binding.writerEpoch !== control.writerEpoch) {
      this.invalidateWriter(workspaceId)
      throw this.lostWriter()
    }
  }

  private async checkStorageWriter(workspaceId: string): Promise<void> {
    this.assertNotInvalidated(workspaceId)
    await this.metadata(workspaceId, 'readonly', (_snapshot, control) => { this.checkWriter(workspaceId, control) })
  }

  private async withStorageWriter<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    this.assertNotInvalidated(workspaceId)
    return await withWorkspaceStorageLock(workspaceId, async () => {
      await this.checkStorageWriter(workspaceId)
      this.assertNotInvalidated(workspaceId)
      const result = await action()
      this.assertNotInvalidated(workspaceId)
      return result
    })
  }

  async acquireWriter(workspaceId: string, authorize?: () => Promise<() => void>): Promise<void> {
    this.assertNotInvalidated(workspaceId)
    if (this.writerBindings.has(workspaceId)) throw this.lostWriter()
    const binding: LocalWriterBinding = { writerId: crypto.randomUUID(), writerEpoch: undefined, invalidated: false }
    this.writerBindings.set(workspaceId, binding)
    try {
      await withWorkspaceStorageLock(workspaceId, async () => {
        this.assertNotInvalidated(workspaceId)
        const assertAuthorized = await authorize?.()
        this.assertNotInvalidated(workspaceId)
        const writerEpoch = await this.metadata(workspaceId, 'readwrite', (_snapshot, control, transaction) => {
          this.assertNotInvalidated(workspaceId)
          const next = { ...control, writerId: binding.writerId, writerEpoch: incrementControl(control.writerEpoch) }
          assertAuthorized?.()
          this.assertNotInvalidated(workspaceId)
          transaction.objectStore(CONTROL_STORE).put(next)
          return next.writerEpoch
        })
        binding.writerEpoch = writerEpoch
        this.assertNotInvalidated(workspaceId)
      })
    } catch (error) {
      this.invalidateWriter(workspaceId)
      throw error
    }
  }

  async assertWriter(workspaceId: string): Promise<void> {
    this.assertNotInvalidated(workspaceId)
    await withWorkspaceStorageLock(workspaceId, async () => {
      await this.metadata(workspaceId, 'readonly', (_snapshot, control) => { this.checkWriter(workspaceId, control, true) })
    })
    this.assertNotInvalidated(workspaceId)
  }

  invalidateWriter(workspaceId: string): void {
    this.invalidatedWorkspaces.add(workspaceId)
    const binding = this.writerBindings.get(workspaceId)
    if (binding !== undefined) binding.invalidated = true
    for (const transaction of this.activeWrites.get(workspaceId) ?? []) {
      try {
        transaction.abort()
      } catch (abortError) {
        void abortError
      }
    }
  }

  private async recoverDownloads(workspaceId: string): Promise<void> {
    const intents = await this.journal.list(workspaceId)
    if (intents.length === 0) return
    const record = await this.readRecord(workspaceId)
    if (record === undefined) {
      throw new DurableWorkspaceStoreError('LOCAL_METADATA_MISSING', 'browser-native workspace: download intents exist without Workspace metadata')
    }
    const protectedHashes = new Set<string>()
    for (const change of [...record.pending, ...(record.retryBatch?.changes ?? [])]) {
      if (change.contentHash !== undefined) protectedHashes.add(change.contentHash)
    }
    const { blobDirectory } = await this.resources(workspaceId)
    for (const intent of intents) {
      let handle: FileSystemFileHandle | undefined
      try {
        handle = await blobDirectory.getFileHandle(intent.hash)
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
      }
      if (protectedHashes.has(intent.hash)) {
        throw new DurableWorkspaceStoreError('LOCAL_DOWNLOAD_PROTECTED', `browser-native workspace: download recovery cannot modify a pending or retry blob (${intent.hash})`)
      }
      if (handle !== undefined) {
        const file = await handle.getFile()
        if (file.size !== intent.bytes || await sha256File(file) !== intent.hash) {
          this.assertNotInvalidated(workspaceId)
          await blobDirectory.removeEntry(intent.hash)
        }
      }
      this.assertNotInvalidated(workspaceId)
      await this.journal.remove(workspaceId, intent.hash)
    }
  }

  async listWorkspaceIds(): Promise<readonly string[]> {
    const workspaceIds = new Set(await this.journal.listWorkspaceIds())
    const database = await openDatabase()
    try {
      const transaction = database.transaction(METADATA_STORE, 'readonly')
      const keys = await requestResult(transaction.objectStore(METADATA_STORE).getAllKeys())
      await transactionDone(transaction)
      for (const key of keys) {
        if (typeof key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
          throw new DurableWorkspaceStoreError('LOCAL_METADATA_INVALID', 'browser-native workspace: local Workspace metadata has an invalid id')
        }
        workspaceIds.add(key)
      }
    } finally {
      database.close()
    }

    const storage = globalThis.navigator?.storage
    if (storage === undefined || typeof storage.getDirectory !== 'function') {
      throw new DurableWorkspaceStoreError('LOCAL_STORE_UNAVAILABLE', 'browser-native workspace: OPFS is unavailable')
    }
    const root = await storage.getDirectory()
    for await (const [name, entry] of root.entries()) {
      if (entry.kind !== 'directory' || !name.startsWith(BLOB_DIRECTORY_PREFIX)) continue
      let containsBytes = false
      for await (const child of (entry as FileSystemDirectoryHandle).values()) {
        if (child.kind !== 'file' && child.kind !== 'directory') continue
        containsBytes = true
        break
      }
      if (!containsBytes) continue
      const workspaceId = name.slice(BLOB_DIRECTORY_PREFIX.length)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
        throw new DurableWorkspaceStoreError('LOCAL_METADATA_INVALID', 'browser-native workspace: local OPFS data has an invalid Workspace id')
      }
      workspaceIds.add(workspaceId)
    }
    return [...workspaceIds].sort()
  }

  private async resources(workspaceId: string): Promise<{ database: IDBDatabase; blobDirectory: FileSystemDirectoryHandle }> {
    const database = await this.getDatabase()
    let blobDirectory = this.blobDirectories.get(workspaceId)
    if (blobDirectory === undefined) {
      const storage = globalThis.navigator?.storage
      if (storage === undefined || typeof storage.getDirectory !== 'function') {
        throw new Error('browser-native workspace: OPFS is unavailable')
      }
      const root = await storage.getDirectory()
      this.opfsRoot = root
      this.assertNotInvalidated(workspaceId)
      blobDirectory = await root.getDirectoryHandle(`${BLOB_DIRECTORY_PREFIX}${workspaceId}`, { create: true })
      this.blobDirectories.set(workspaceId, blobDirectory)
    }
    return { database, blobDirectory }
  }

  private async readRecord(workspaceId: string): Promise<WorkspaceDatabaseRecord | undefined> {
    return await this.metadata(workspaceId, 'readonly', snapshot => snapshot)
  }

  private async writeBlob(workspaceId: string, directory: FileSystemDirectoryHandle, hash: string, content: Uint8Array): Promise<void> {
    this.assertNotInvalidated(workspaceId)
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
    this.assertNotInvalidated(workspaceId)
    const writable = await handle.createWritable()
    try {
      for (let offset = 0; offset < content.byteLength; offset += BLOB_IO_CHUNK_BYTES) {
        this.assertNotInvalidated(workspaceId)
        await writable.write({
          type: 'write',
          position: offset,
          data: toArrayBuffer(content.subarray(offset, Math.min(offset + BLOB_IO_CHUNK_BYTES, content.byteLength))),
        })
      }
      this.assertNotInvalidated(workspaceId)
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

  private async createSyncAccessHandle(workspaceId: string, handle: FileSystemFileHandle): Promise<FileSystemSyncAccessHandle> {
    for (const delay of [0, ...OPFS_ACCESS_HANDLE_RETRY_DELAYS_MS]) {
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      this.assertNotInvalidated(workspaceId)
      try {
        return await handle.createSyncAccessHandle()
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'NoModificationAllowedError' || delay === OPFS_ACCESS_HANDLE_RETRY_DELAYS_MS.at(-1)) throw error
      }
    }
    throw new Error('browser-native workspace: OPFS access handle retry exhausted')
  }

  private async encodeChange(workspaceId: string, directory: FileSystemDirectoryHandle, change: WorkspaceChange): Promise<StoredChange> {
    if (change.contentReference !== undefined) {
      let file: File
      try {
        file = await (await directory.getFileHandle(change.contentReference.hash)).getFile()
      } catch (error) {
        throw new DurableWorkspaceStoreError('LOCAL_BLOB_MISSING', `browser-native workspace: referenced blob is missing (${change.contentReference.hash})`, { cause: error })
      }
      if (file.size !== change.contentReference.bytes) {
        throw new DurableWorkspaceStoreError('LOCAL_BLOB_SIZE_MISMATCH', `browser-native workspace: referenced blob size mismatch (${change.contentReference.hash})`)
      }
      if (await sha256File(file) !== change.contentReference.hash) {
        throw new DurableWorkspaceStoreError('LOCAL_BLOB_CORRUPT', `browser-native workspace: referenced blob hash mismatch (${change.contentReference.hash})`)
      }
      return storedChange(change, change.contentReference.hash, true)
    }
    if (change.content === undefined) return storedChange(change)
    const contentHash = await sha256(change.content)
    await this.writeBlob(workspaceId, directory, contentHash, change.content)
    return storedChange(change, contentHash)
  }

  private async decodeChange(directory: FileSystemDirectoryHandle, change: StoredChange): Promise<WorkspaceChange> {
    if (change.externalContent === true) return restoreChange(change, undefined)
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
    return this.withStorageWriter(workspaceId, async () => {
      await this.recoverDownloads(workspaceId)
      return this.loadSnapshot(workspaceId)
    })
  }

  private async loadSnapshot(workspaceId: string): Promise<DurableWorkspaceSnapshot | undefined> {
    const { blobDirectory } = await this.resources(workspaceId)
    const { record, generation } = await this.metadata(workspaceId, 'readonly', (record, control) => ({ record, generation: control.generation }))
    if (record === undefined) {
      for await (const entry of blobDirectory.values()) {
        if (entry.kind === 'file') {
          throw new DurableWorkspaceStoreError(
            'LOCAL_METADATA_MISSING',
            'browser-native workspace: local OPFS blobs exist without IndexedDB metadata',
          )
        }
      }
      this.assertNotInvalidated(workspaceId)
      this.observedGenerations.set(workspaceId, generation)
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
    this.assertNotInvalidated(workspaceId)
    this.observedGenerations.set(workspaceId, generation)
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
    return this.withStorageWriter(snapshot.workspaceId, async () => {
      await this.recoverDownloads(snapshot.workspaceId)
      await this.saveSnapshot(snapshot)
    })
  }

  private async saveSnapshot(snapshot: DurableWorkspaceSnapshot): Promise<void> {
    const initial = await this.metadata(snapshot.workspaceId, 'readonly', (current, control) => {
      this.checkSnapshotGeneration(snapshot.workspaceId, current, control)
      return control.generation
    })
    const { blobDirectory } = await this.resources(snapshot.workspaceId)
    const pending: StoredChange[] = []
    for (const change of snapshot.pending) pending.push(await this.encodeChange(snapshot.workspaceId, blobDirectory, change))
    const retryChanges: StoredChange[] = []
    for (const change of snapshot.retryBatch?.changes ?? []) retryChanges.push(await this.encodeChange(snapshot.workspaceId, blobDirectory, change))
    const retryBatch = snapshot.retryBatch === undefined ? undefined : {
      operationId: snapshot.retryBatch.operationId,
      baseRevision: snapshot.retryBatch.baseRevision,
      changes: retryChanges,
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
    const generation = await this.metadata(snapshot.workspaceId, 'readwrite', (current, control, transaction) => {
      this.checkWriter(snapshot.workspaceId, control)
      this.checkSnapshotGeneration(snapshot.workspaceId, current, control)
      if (control.generation !== initial) throw this.snapshotConflict()
      const next = { ...control, generation: incrementControl(control.generation) }
      transaction.objectStore(METADATA_STORE).put(record)
      transaction.objectStore(CONTROL_STORE).put(next)
      if (this.testHooks?.abortNextMetadataTransaction?.() === true) transaction.abort()
      return next.generation
    })
    this.observedGenerations.set(snapshot.workspaceId, generation)
  }

  private snapshotConflict(): DurableWorkspaceStoreError {
    return new DurableWorkspaceStoreError('LOCAL_SNAPSHOT_CONFLICT', 'browser-native workspace: local snapshot changed since load; retain local changes and reload before writing')
  }

  private checkSnapshotGeneration(workspaceId: string, current: WorkspaceDatabaseRecord | undefined, control: WorkspaceControlRecord): void {
    const expected = this.observedGenerations.get(workspaceId)
    if (expected === undefined ? current !== undefined || control.generation !== 0 : control.generation !== expected) {
      throw this.snapshotConflict()
    }
  }

  async clear(workspaceId: string): Promise<void> {
    return this.withStorageWriter(workspaceId, async () => {
      const intents = await this.journal.list(workspaceId)
      await this.resources(workspaceId)
      const generation = await this.metadata(workspaceId, 'readwrite', (_snapshot, control, transaction) => {
        this.checkWriter(workspaceId, control)
        const next = { ...control, generation: incrementControl(control.generation) }
        transaction.objectStore(METADATA_STORE).delete(workspaceId)
        transaction.objectStore(CONTROL_STORE).put(next)
        if (this.testHooks?.abortNextMetadataTransaction?.() === true) transaction.abort()
        return next.generation
      })
      this.observedGenerations.set(workspaceId, generation)
      this.assertNotInvalidated(workspaceId)
      this.blobDirectories.delete(workspaceId)
      await this.opfsRoot?.removeEntry(`${BLOB_DIRECTORY_PREFIX}${workspaceId}`, { recursive: true })
      for (const intent of intents) {
        this.assertNotInvalidated(workspaceId)
        await this.journal.remove(workspaceId, intent.hash)
      }
    })
  }

  private async cacheVerifiedBytes(workspaceId: string, hash: string, content: Uint8Array): Promise<void> {
    const { blobDirectory } = await this.resources(workspaceId)
    if (await sha256(content) !== hash) {
      throw new DurableWorkspaceStoreError('LOCAL_BLOB_CORRUPT', `browser-native workspace: blob hash mismatch (${hash})`)
    }
    await this.writeBlob(workspaceId, blobDirectory, hash, content)
  }

  async cacheBlob(workspaceId: string, hash: string, content: Uint8Array): Promise<void> {
    return this.withStorageWriter(workspaceId, async () => {
      await this.recoverDownloads(workspaceId)
      await this.cacheVerifiedBytes(workspaceId, hash, content)
    })
  }

  async cacheBlobFromRanges(
    workspaceId: string,
    hash: string,
    bytes: number,
    readRange: (offset: number, length: number) => Uint8Array,
  ): Promise<void> {
    return this.withStorageWriter(workspaceId, async () => {
      await this.recoverDownloads(workspaceId)
      await this.cacheRanges(workspaceId, hash, bytes, readRange)
    })
  }

  private async cacheRanges(
    workspaceId: string,
    hash: string,
    bytes: number,
    readRange: (offset: number, length: number) => Uint8Array,
  ): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('browser-native workspace: invalid blob byte length')
    const { blobDirectory } = await this.resources(workspaceId)
    this.assertNotInvalidated(workspaceId)
    const handle = await blobDirectory.getFileHandle(hash, { create: true })
    const existing = await handle.getFile()
    if (existing.size === bytes && await sha256File(existing) === hash) return
    if (this.testHooks?.quotaNextOpfsWrite?.() === true) {
      throw new DOMException('browser-native workspace: injected OPFS quota failure', 'QuotaExceededError')
    }
    this.assertNotInvalidated(workspaceId)
    const writable = await handle.createWritable()
    const digest = new Sha256()
    try {
      for (let offset = 0; offset < bytes; offset += BLOB_IO_CHUNK_BYTES) {
        this.assertNotInvalidated(workspaceId)
        const length = Math.min(BLOB_IO_CHUNK_BYTES, bytes - offset)
        const chunk = readRange(offset, length)
        if (chunk.byteLength !== length) throw new Error('browser-native workspace: local range source returned an unexpected size')
        digest.update(chunk)
        this.assertNotInvalidated(workspaceId)
        await writable.write({ type: 'write', position: offset, data: toArrayBuffer(chunk) })
      }
      if (digest.digestHex() !== hash) {
        throw new DurableWorkspaceStoreError('LOCAL_BLOB_CORRUPT', `browser-native workspace: local range blob hash mismatch (${hash})`)
      }
      this.assertNotInvalidated(workspaceId)
      await writable.close()
    } catch (error) {
      try {
        await writable.abort()
      } catch (abortError) {
        void abortError
      }
      throw error
    }
  }

  async openBlob(workspaceId: string, hash: string, bytes: number): Promise<VfsFileBacking | undefined> {
    this.assertNotInvalidated(workspaceId)
    return withWorkspaceStorageLock(workspaceId, async () => {
      await this.checkStorageWriter(workspaceId)
      await this.recoverDownloads(workspaceId)
      const backing = await this.openVerifiedBlob(workspaceId, hash, bytes)
      try {
        this.assertNotInvalidated(workspaceId)
        return backing
      } catch (error) {
        backing?.close()
        throw error
      }
    })
  }

  private async openVerifiedBlob(workspaceId: string, hash: string, bytes: number): Promise<VfsFileBacking | undefined> {
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
    if (await sha256File(file) !== hash) {
      throw new DurableWorkspaceStoreError('LOCAL_BLOB_CORRUPT', `browser-native workspace: local blob hash mismatch (${hash})`)
    }
    let sync: FileSystemSyncAccessHandle | undefined
    try {
      this.assertNotInvalidated(workspaceId)
      sync = await this.createSyncAccessHandle(workspaceId, handle)
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NoModificationAllowedError') throw error
      const resident = new Uint8Array(await file.arrayBuffer())
      this.assertNotInvalidated(workspaceId)
      return {
        size: bytes,
        reference: { hash, bytes },
        read: (position: number, length: number): Uint8Array => {
          if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0) {
            throw new RangeError('browser-native workspace: invalid external blob read range')
          }
          return resident.slice(position, Math.min(position + length, bytes))
        },
        close: (): void => {},
      }
    }
    try {
      this.assertNotInvalidated(workspaceId)
    } catch (error) {
      sync.close()
      throw error
    }
    if (sync.getSize() !== bytes) {
      sync.close()
      throw new DurableWorkspaceStoreError('LOCAL_BLOB_SIZE_MISMATCH', `browser-native workspace: local blob size mismatch (${hash})`)
    }
    return {
      size: bytes,
      reference: { hash, bytes },
      read: (position, length) => {
        if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0) {
          throw new RangeError('browser-native workspace: invalid external blob read range')
        }
        const output = new Uint8Array(Math.min(length, Math.max(0, bytes - position)))
        const read = sync.read(output, { at: position })
        return output.subarray(0, read)
      },
      close: () => { sync!.close() },
    }
  }

  /**
   * Commit an intent before creating OPFS bytes; interrupted publication is reconciled under a Web Lock.
   * @param workspaceId - Workspace owning the local cache.
   * @param hash - Expected full SHA-256; existing damaged entries remain fail-closed.
   * @param bytes - Expected byte length.
   * @param readChunk - Sequential range source, responsible for checking EOF before its final return.
   * @returns True after verification and publication, or when a verified cache entry already exists.
   */
  async cacheBlobFromChunks(
    workspaceId: string,
    hash: string,
    bytes: number,
    readChunk: (offset: number, length: number) => Promise<Uint8Array>,
  ): Promise<boolean> {
    return this.withStorageWriter(workspaceId, async () => {
      await this.recoverDownloads(workspaceId)
      return this.cacheRemoteChunks(workspaceId, hash, bytes, readChunk)
    })
  }

  private async cacheRemoteChunks(
    workspaceId: string,
    hash: string,
    bytes: number,
    readChunk: (offset: number, length: number) => Promise<Uint8Array>,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('browser-native workspace: invalid blob byte length')
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new RangeError('browser-native workspace: invalid blob hash')
    const { blobDirectory } = await this.resources(workspaceId)
    let handle: FileSystemFileHandle | undefined
    try {
      handle = await blobDirectory.getFileHandle(hash)
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
    }
    if (handle !== undefined) {
      const existing = await handle.getFile()
      if (existing.size !== bytes) {
        throw new DurableWorkspaceStoreError('LOCAL_BLOB_SIZE_MISMATCH', `browser-native workspace: local blob size mismatch (${hash})`)
      }
      if (await sha256File(existing) !== hash) {
        throw new DurableWorkspaceStoreError('LOCAL_BLOB_CORRUPT', `browser-native workspace: local blob hash mismatch (${hash})`)
      }
      return true
    }
    if (await this.readRecord(workspaceId) === undefined) {
      throw new DurableWorkspaceStoreError('LOCAL_METADATA_MISSING', 'browser-native workspace: download publication requires Workspace metadata')
    }
    this.assertNotInvalidated(workspaceId)
    await this.journal.put({ version: 1, workspaceId, hash, bytes, attemptId: crypto.randomUUID() })
    await this.testHooks?.downloadStage?.('intent-durable')
    let writable: FileSystemWritableFileStream | undefined
    try {
      this.assertNotInvalidated(workspaceId)
      handle = await blobDirectory.getFileHandle(hash, { create: true })
      await this.testHooks?.downloadStage?.('entry-created')
      if (this.testHooks?.quotaNextOpfsWrite?.() === true) {
        throw new DOMException('browser-native workspace: injected OPFS quota failure', 'QuotaExceededError')
      }
      this.assertNotInvalidated(workspaceId)
      writable = await handle.createWritable()
      const digest = new Sha256()
      let offset = 0
      if (bytes === 0 && (await readChunk(0, 0)).byteLength !== 0) {
        throw new Error('browser-native workspace: remote empty blob returned bytes')
      }
      while (offset < bytes) {
        this.assertNotInvalidated(workspaceId)
        const length = Math.min(BLOB_IO_CHUNK_BYTES, bytes - offset)
        const chunk = await readChunk(offset, length)
        if (chunk.byteLength !== length) throw new Error('browser-native workspace: remote blob chunk has an unexpected size')
        digest.update(chunk)
        this.assertNotInvalidated(workspaceId)
        await writable.write({ type: 'write', position: offset, data: toArrayBuffer(chunk) })
        if (offset === 0) await this.testHooks?.downloadStage?.('first-chunk-written')
        offset += chunk.byteLength
      }
      if (digest.digestHex() !== hash) throw new DurableWorkspaceStoreError('LOCAL_BLOB_CORRUPT', `browser-native workspace: downloaded blob hash mismatch (${hash})`)
      this.assertNotInvalidated(workspaceId)
      await writable.close()
      await this.testHooks?.downloadStage?.('published')
      this.assertNotInvalidated(workspaceId)
      await this.journal.remove(workspaceId, hash)
      return true
    } catch (error) {
      try {
        await writable?.abort()
      } catch (abortError) {
        void abortError
      }
      if (this.invalidatedWorkspaces.has(workspaceId)) throw this.lostWriter()
      try {
        await this.recoverDownloads(workspaceId)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'browser-native workspace: failed download requires publication recovery')
      }
      throw error
    }
  }

  async reconcileBlobs(workspaceId: string, retainedHashes: readonly string[]): Promise<BlobReconciliation> {
    return this.withStorageWriter(workspaceId, async () => {
      await this.recoverDownloads(workspaceId)
      return this.reconcileVerifiedBlobs(workspaceId, retainedHashes)
    })
  }

  private async reconcileVerifiedBlobs(workspaceId: string, retainedHashes: readonly string[]): Promise<BlobReconciliation> {
    const { blobDirectory } = await this.resources(workspaceId)
    const record = await this.readRecord(workspaceId)
    if (record === undefined) return { removedFiles: 0, removedBytes: 0, retainedFiles: 0, skipped: 'metadata-missing' }
    const retained = new Set(retainedHashes)
    const retainChange = (change: StoredChange): void => {
      if (change.contentHash !== undefined) retained.add(change.contentHash)
    }
    for (const change of record.pending) retainChange(change)
    for (const change of record.retryBatch?.changes ?? []) retainChange(change)
    let removedFiles = 0
    let removedBytes = 0
    let retainedFiles = 0
    for await (const entry of blobDirectory.values()) {
      if (entry.kind !== 'file' || !/^[a-f0-9]{64}$/.test(entry.name)) continue
      const file = await entry.getFile()
      if (retained.has(entry.name)) {
        retainedFiles += 1
        continue
      }
      removedFiles += 1
      removedBytes += file.size
      this.assertNotInvalidated(workspaceId)
      await blobDirectory.removeEntry(entry.name)
    }
    return { removedFiles, removedBytes, retainedFiles }
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
    readonly downloadStage?: (stage: DownloadPublicationStage) => Promise<void>
  },
): DurableWorkspaceStore {
  return new BrowserDurableWorkspaceStore(testHooks)
}
