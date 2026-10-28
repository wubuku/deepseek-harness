/** Durable download publication intents and browser-owned Workspace storage locks. */

const DATABASE_NAME = 'dsh-browser-native-downloads-v1'
const DATABASE_VERSION = 1
const STORE_NAME = 'downloads'

/** Evidence that one download may have left an incomplete canonical cache file. */
export interface DownloadIntent {
  readonly version: 1
  readonly workspaceId: string
  readonly hash: string
  readonly bytes: number
  readonly attemptId: string
}

/** Persistent download intents; callers own recovery decisions and Workspace locking. */
export interface DownloadJournal {
  /**
   * Enumerate Workspace identities from validated intents without consulting metadata or cached files.
   * Malformed records or keys anywhere in the journal reject the entire operation.
   * @returns Unique, sorted Workspace UUIDs after the read transaction completes.
   */
  listWorkspaceIds(): Promise<readonly string[]>
  /**
   * Read one Workspace's intents, rejecting malformed records or keys anywhere in the journal.
   * @param workspaceId - UUID of the Workspace whose intents are returned.
   * @returns Validated intents after the read transaction completes.
   */
  list(workspaceId: string): Promise<readonly DownloadIntent[]>
  /**
   * Add an intent using strict write durability; an existing key rejects without replacement.
   * Callers must recover unresolved intents under the same Workspace lock before adding another.
   * @param intent - Version-one intent with UUID identities, a full lowercase SHA-256, and a nonnegative safe byte count.
   * @returns Resolves only after transaction completion; failure never authorizes file creation.
   */
  put(intent: DownloadIntent): Promise<void>
  /**
   * Delete one intent using strict write durability; an absent key is harmless.
   * @param workspaceId - UUID of the Workspace owning the intent.
   * @param hash - Full lowercase SHA-256 identifying the intent.
   * @returns Resolves only after transaction completion.
   */
  remove(workspaceId: string, hash: string): Promise<void>
}

/** Storage failures that require the caller to stop dependent cache publication or recovery. */
export class DownloadJournalError extends Error {
  override readonly name = 'DownloadJournalError'

  constructor(
    readonly code: 'LOCAL_DOWNLOAD_JOURNAL_INVALID' | 'LOCAL_DOWNLOAD_JOURNAL_UNAVAILABLE'
      | 'LOCAL_STORAGE_LOCK_UNAVAILABLE',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

function invalid(message: string): DownloadJournalError {
  return new DownloadJournalError('LOCAL_DOWNLOAD_JOURNAL_INVALID', `browser-native download journal: ${message}`)
}

function unavailable(cause: unknown): DownloadJournalError {
  if (cause instanceof DownloadJournalError) return cause
  return new DownloadJournalError(
    'LOCAL_DOWNLOAD_JOURNAL_UNAVAILABLE',
    'browser-native download journal: IndexedDB operation failed; stop cache recovery and retain local files',
    { cause },
  )
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function validateWorkspaceId(workspaceId: string): void {
  if (!isUuid(workspaceId)) throw invalid('Workspace identity must be a version 1–8 UUID with the RFC variant')
}

function parseIntent(value: unknown): DownloadIntent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('version' in value) || value.version !== 1
    || !('workspaceId' in value) || !isUuid(value.workspaceId)
    || !('hash' in value) || !isHash(value.hash)
    || !('bytes' in value) || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0
    || !('attemptId' in value) || !isUuid(value.attemptId)) {
    throw invalid('unsupported or malformed download intent; retain local files for explicit recovery')
  }
  return { version: 1, workspaceId: value.workspaceId, hash: value.hash, bytes: value.bytes, attemptId: value.attemptId }
}

function isCompoundKey(value: unknown): value is readonly [string, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string'
}

/**
 * Independent IndexedDB journal. Each operation opens and closes its own connection.
 * Unknown database versions, unexpected store schemas, and invalid records reject without repair.
 * Failed writes do not establish durability; callers retain files and reconcile before continuing.
 * Strict durability requests browser persistence; it does not guarantee survival of an OS crash or power loss.
 * The constructor accepts an IndexedDB factory for isolated tests; omission uses the browser factory.
 */
export class BrowserDownloadJournal implements DownloadJournal {
  constructor(private readonly factory?: Pick<IDBFactory, 'open'>) {}

  async listWorkspaceIds(): Promise<readonly string[]> {
    const intents = await this.listAll()
    return [...new Set(intents.map(intent => intent.workspaceId))].sort()
  }

  async list(workspaceId: string): Promise<readonly DownloadIntent[]> {
    validateWorkspaceId(workspaceId)
    return (await this.listAll()).filter(intent => intent.workspaceId === workspaceId)
  }

  private async listAll(): Promise<readonly DownloadIntent[]> {
    return await this.transact<readonly DownloadIntent[]>('readonly', (store, complete, fail) => {
      const intents: DownloadIntent[] = []
      const request = store.openCursor()
      request.onerror = () => fail(request.error)
      request.onsuccess = () => {
        try {
          const cursor = request.result
          if (cursor === null) {
            complete(intents)
            return
          }
          const intent = parseIntent(cursor.value)
          const key: unknown = cursor.primaryKey
          if (!isCompoundKey(key) || key[0] !== intent.workspaceId || key[1] !== intent.hash) {
            throw invalid('download intent key does not match its Workspace and hash; retain local files')
          }
          intents.push(intent)
          cursor.continue()
        } catch (error) {
          fail(error)
        }
      }
    })
  }

  async put(intent: DownloadIntent): Promise<void> {
    const record = parseIntent(intent)
    await this.transact<void>('readwrite', (store, complete, fail) => {
      const request = store.getKey([record.workspaceId, record.hash])
      request.onerror = () => fail(request.error)
      request.onsuccess = () => {
        try {
          if (request.result !== undefined) {
            throw invalid('unresolved download intent already exists; recover it under the Workspace lock before retrying')
          }
          const addition = store.add(record)
          addition.onerror = () => fail(addition.error)
          complete(undefined)
        } catch (error) {
          fail(error)
        }
      }
    })
  }

  async remove(workspaceId: string, hash: string): Promise<void> {
    validateWorkspaceId(workspaceId)
    if (!isHash(hash)) throw invalid('intent removal requires a full lowercase SHA-256')
    await this.transact<void>('readwrite', (store, complete, fail) => {
      const request = store.delete([workspaceId, hash])
      request.onerror = () => fail(request.error)
      complete(undefined)
    })
  }

  private async open(): Promise<IDBDatabase> {
    try {
      const factory = this.factory ?? globalThis.indexedDB
      if (factory === undefined) throw unavailable(new Error('IndexedDB is unavailable'))
      return await new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(DATABASE_NAME, DATABASE_VERSION)
        let settled = false
        const fail = (error: unknown) => {
          settled = true
          reject(unavailable(error))
        }
        request.onblocked = () => fail(new Error('IndexedDB open was blocked'))
        request.onerror = () => {
          fail(request.error?.name === 'VersionError' ? invalid('unsupported IndexedDB database version') : request.error)
        }
        request.onupgradeneeded = event => {
          try {
            if (settled) {
              request.transaction?.abort()
              return
            }
            if (event.oldVersion !== 0 || request.result.version !== DATABASE_VERSION) {
              throw invalid('unsupported IndexedDB upgrade')
            }
            request.result.createObjectStore(STORE_NAME, { keyPath: ['workspaceId', 'hash'] })
          } catch (error) {
            fail(error)
            request.transaction?.abort()
          }
        }
        request.onsuccess = () => {
          const database = request.result
          if (settled) {
            database.close()
            return
          }
          if (database.version !== DATABASE_VERSION || !database.objectStoreNames.contains(STORE_NAME)) {
            database.close()
            fail(invalid('unsupported IndexedDB version or missing downloads store'))
            return
          }
          settled = true
          database.onversionchange = () => database.close()
          resolve(database)
        }
      })
    } catch (error) {
      throw unavailable(error)
    }
  }

  private async transact<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore, complete: (value: T) => void, fail: (error: unknown) => void) => void,
  ): Promise<T> {
    const database = await this.open()
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined)
        let failure: DownloadJournalError | undefined
        let result: { value: T } | undefined
        transaction.oncomplete = () => {
          if (failure !== undefined) reject(failure)
          else if (result !== undefined) resolve(result.value)
          else reject(unavailable(new Error('IndexedDB transaction completed without a result')))
        }
        transaction.onerror = () => { failure ??= unavailable(transaction.error) }
        transaction.onabort = () => reject(failure ?? unavailable(transaction.error))
        const fail = (error: unknown) => {
          failure ??= unavailable(error)
          try {
            transaction.abort()
          } catch (abortError) {
            reject(new DownloadJournalError(failure.code, failure.message, {
              cause: new AggregateError([failure, abortError], 'IndexedDB abort failed'),
            }))
          }
        }
        try {
          const store = transaction.objectStore(STORE_NAME)
          const keyPath: unknown = store.keyPath
          if (!isCompoundKey(keyPath) || keyPath[0] !== 'workspaceId' || keyPath[1] !== 'hash' || store.autoIncrement) {
            throw invalid('downloads store must use the compound Workspace/hash key without auto-increment')
          }
          action(store, value => { result = { value } }, fail)
        } catch (error) {
          fail(error)
        }
      })
    } catch (error) {
      throw unavailable(error)
    } finally {
      database.close()
    }
  }
}

/**
 * Hold the browser's exclusive Workspace storage lock until the action settles.
 * @param workspaceId - Workspace shared by every local storage participant.
 * @param action - Work performed only after acquiring the lock; its rejection is preserved.
 * @returns The action's result; unavailable or rejected lock acquisition fails explicitly.
 */
export async function withWorkspaceStorageLock<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
  let entered = false
  try {
    if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function') {
      throw new Error('Web Locks is unavailable')
    }
    return await navigator.locks.request(`dsh-workspace-local-${workspaceId}`, { mode: 'exclusive' }, async lock => {
      if (lock === null) throw new Error('Exclusive Workspace lock was not granted')
      entered = true
      return await action()
    })
  } catch (error) {
    if (entered) throw error
    throw new DownloadJournalError(
      'LOCAL_STORAGE_LOCK_UNAVAILABLE',
      'browser-native Workspace storage: exclusive Web Lock unavailable; stop local storage operations',
      { cause: error },
    )
  }
}
