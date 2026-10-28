/** Deterministic IndexedDB events exercise journal durability, validation, and lock ownership. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserDownloadJournal,
  DownloadJournalError,
  withWorkspaceStorageLock,
  type DownloadIntent,
  type DownloadJournal,
} from '../browser-native-download-journal.ts'

const workspaceA = '11111111-1111-4111-8111-111111111111'
const workspaceB = '22222222-2222-4222-8222-222222222222'
const workspaceEmpty = '33333333-3333-4333-8333-333333333333'
const attemptA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const attemptNext = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

function intent(overrides: Partial<DownloadIntent> = {}): DownloadIntent {
  return { version: 1, workspaceId: workspaceA, hash: 'a'.repeat(64), bytes: 128, attemptId: attemptA, ...overrides }
}

function requestFixture<T>(result: T) {
  const state = {
    result,
    error: null as DOMException | null,
    onsuccess: null as IDBRequest<T>['onsuccess'],
    onerror: null as IDBRequest<T>['onerror'],
  }
  const request = state as IDBRequest<T>
  return {
    state,
    request,
    succeed: () => state.onsuccess?.call(request, new Event('success')),
    fail: (error: DOMException) => {
      state.error = error
      state.onerror?.call(request, new Event('error'))
    },
  }
}

interface StoredRow {
  key: unknown
  value: unknown
}

class TransactionFixture {
  private readonly cursor = requestFixture<IDBCursorWithValue | null>(null)
  private readonly lookup = requestFixture<IDBValidKey | undefined>(undefined)
  private readonly write = requestFixture<IDBValidKey>('unused')
  private readonly deletion = requestFixture<undefined>(undefined)
  private staged: StoredRow[]
  private active = true
  readonly state: Pick<IDBTransaction, 'oncomplete' | 'onerror' | 'onabort' | 'abort' | 'objectStore'> & { error: DOMException | null } = {
    error: null as DOMException | null,
    oncomplete: null as IDBTransaction['oncomplete'],
    onerror: null as IDBTransaction['onerror'],
    onabort: null as IDBTransaction['onabort'],
    abort: vi.fn(() => this.abort()),
    objectStore: vi.fn((name: string) => {
      expect(name).toBe('downloads')
      return this.store
    }),
  }
  readonly transaction = this.state as IDBTransaction
  readonly store: IDBObjectStore

  constructor(private readonly rows: StoredRow[], keyPath: string | string[] | null, autoIncrement: boolean) {
    this.staged = rows.slice()
    this.store = {
      keyPath,
      autoIncrement,
      openCursor: () => this.cursor.request,
      getKey: (key: IDBValidKey) => {
        const existing = this.staged.find(row => JSON.stringify(row.key) === JSON.stringify(key))
        this.lookup.state.result = existing?.key as IDBValidKey | undefined
        return this.lookup.request
      },
      add: (record: DownloadIntent) => {
        const key = [record.workspaceId, record.hash]
        this.staged = this.staged.filter(row => JSON.stringify(row.key) !== JSON.stringify(key))
        this.staged.push({ key, value: structuredClone(record) })
        return this.write.request
      },
      delete: (key: IDBValidKey) => {
        this.staged = this.staged.filter(row => JSON.stringify(row.key) !== JSON.stringify(key))
        return this.deletion.request
      },
    } as IDBObjectStore
  }

  readAll(): void {
    let offset = 0
    const advance = () => {
      if (!this.active) return
      const row = this.rows[offset++]
      this.cursor.state.result = row === undefined ? null : {
        primaryKey: row.key,
        value: structuredClone(row.value),
        continue: advance,
      } as IDBCursorWithValue
      this.cursor.succeed()
    }
    advance()
  }

  requestSuccess(): void {
    this.lookup.succeed()
    this.write.succeed()
    this.deletion.succeed()
  }

  requestError(operation: 'list' | 'put' | 'remove', error: DOMException): void {
    if (operation === 'list') this.cursor.fail(error)
    else if (operation === 'put') this.lookup.fail(error)
    else this.deletion.fail(error)
  }

  addError(error: DOMException): void {
    this.lookup.succeed()
    this.write.fail(error)
  }

  complete(): void {
    if (!this.active) return
    this.active = false
    this.rows.splice(0, this.rows.length, ...this.staged)
    this.state.oncomplete?.call(this.transaction, new Event('complete'))
  }

  error(error: DOMException): void {
    this.state.error = error
    this.state.onerror?.call(this.transaction, new Event('error'))
  }

  abort(): void {
    if (!this.active) return
    this.active = false
    this.state.onabort?.call(this.transaction, new Event('abort'))
  }
}

class DatabaseFixture {
  readonly rows: StoredRow[] = []
  readonly close = vi.fn()
  readonly createObjectStore = vi.fn()
  version = 1
  keyPath: string | string[] | null = ['workspaceId', 'hash']
  autoIncrement = false
  missingStore = false
  fresh = false
  blocked = false
  openError: DOMException | undefined
  transactionError: Error | undefined
  private ready = deferred<TransactionFixture>()
  private lateSuccess: (() => void) | undefined
  readonly transaction = vi.fn((_name: string, _mode?: IDBTransactionMode, _options?: IDBTransactionOptions) => {
    if (this.transactionError !== undefined) throw this.transactionError
    const transaction = new TransactionFixture(this.rows, this.keyPath, this.autoIncrement)
    this.ready.resolve(transaction)
    return transaction.transaction
  })
  readonly factory: Pick<IDBFactory, 'open'> = { open: vi.fn(() => this.open()) }
  readonly journal: DownloadJournal = new BrowserDownloadJournal(this.factory)

  async nextTransaction(): Promise<TransactionFixture> {
    const transaction = await this.ready.promise
    this.ready = deferred<TransactionFixture>()
    return transaction
  }

  finishBlockedOpen(): void {
    this.lateSuccess?.()
  }

  private open(): IDBOpenDBRequest {
    const database: Pick<IDBDatabase, 'version' | 'transaction' | 'close' | 'onversionchange'> = Object.assign(new EventTarget(), {
      version: this.version,
      objectStoreNames: { contains: (name: string) => name === 'downloads' && !this.missingStore },
      createObjectStore: this.createObjectStore,
      transaction: this.transaction,
      close: this.close,
      onversionchange: null,
    })
    const opened = requestFixture(database as IDBDatabase)
    const state = Object.assign(opened.state, {
      onblocked: null as IDBOpenDBRequest['onblocked'],
      onupgradeneeded: null as IDBOpenDBRequest['onupgradeneeded'],
      transaction: null,
    })
    const request = state as IDBOpenDBRequest
    this.lateSuccess = () => opened.succeed()
    queueMicrotask(() => {
      if (this.openError !== undefined) opened.fail(this.openError)
      else if (this.blocked) state.onblocked?.call(request, new Event('blocked') as IDBVersionChangeEvent)
      else {
        if (this.fresh) {
          state.onupgradeneeded?.call(request, Object.assign(new Event('upgradeneeded'), {
            oldVersion: 0, newVersion: 1,
          }) as IDBVersionChangeEvent)
          this.fresh = false
        }
        opened.succeed()
      }
    })
    return request
  }
}

async function write(database: DatabaseFixture, record: DownloadIntent): Promise<void> {
  const operation = database.journal.put(record)
  const transaction = await database.nextTransaction()
  transaction.requestSuccess()
  transaction.complete()
  await operation
}

async function list(database: DatabaseFixture, workspaceId: string): Promise<readonly DownloadIntent[]> {
  const operation = database.journal.list(workspaceId)
  const transaction = await database.nextTransaction()
  transaction.readAll()
  transaction.complete()
  return await operation
}

async function listWorkspaceIds(database: DatabaseFixture): Promise<readonly string[]> {
  const operation = database.journal.listWorkspaceIds()
  const transaction = await database.nextTransaction()
  transaction.readAll()
  transaction.complete()
  return await operation
}

afterEach(() => { vi.unstubAllGlobals() })

describe('BrowserDownloadJournal', () => {
  it('creates an independent version-one database with compound keys and closes every connection', async () => {
    const database = new DatabaseFixture()
    database.fresh = true
    await write(database, intent())
    expect(await list(database, workspaceA)).toEqual([intent()])
    expect(database.factory.open).toHaveBeenNthCalledWith(1, 'dsh-browser-native-downloads-v1', 1)
    expect(database.factory.open).toHaveBeenCalledTimes(2)
    expect(database.createObjectStore).toHaveBeenCalledExactlyOnceWith('downloads', { keyPath: ['workspaceId', 'hash'] })
    expect(database.close).toHaveBeenCalledTimes(2)
  })

  it('uses the browser factory when no factory is injected', async () => {
    const database = new DatabaseFixture()
    vi.stubGlobal('indexedDB', database.factory)
    const operation = new BrowserDownloadJournal().list(workspaceA)
    const transaction = await database.nextTransaction()
    transaction.readAll()
    transaction.complete()
    await expect(operation).resolves.toEqual([])
    expect(database.close).toHaveBeenCalledOnce()
  })

  it('lists unique sorted Workspace IDs from intents alone across multiple Workspaces and hashes', async () => {
    const database = new DatabaseFixture()
    await write(database, intent({ workspaceId: workspaceB, hash: 'b'.repeat(64) }))
    await write(database, intent())
    await write(database, intent({ workspaceId: workspaceB }))
    expect(await listWorkspaceIds(database)).toEqual([workspaceA, workspaceB])
    expect(database.close).toHaveBeenCalledTimes(4)
  })

  it('returns no Workspace IDs for an empty journal only after transaction completion', async () => {
    const database = new DatabaseFixture()
    const operation = database.journal.listWorkspaceIds()
    const settled = vi.fn()
    const observed = operation.then(settled)
    const transaction = await database.nextTransaction()
    transaction.readAll()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).not.toHaveBeenCalled()
    expect(database.close).not.toHaveBeenCalled()
    transaction.complete()
    await observed
    expect(settled).toHaveBeenCalledExactlyOnceWith([])
    expect(database.close).toHaveBeenCalledOnce()
  })

  it.each([
    ['future intent version', { key: [workspaceB, intent().hash], value: { ...intent({ workspaceId: workspaceB }), version: 2 } }],
    ['null record', { key: [workspaceB, intent().hash], value: null }],
    ['malformed Workspace UUID', { key: ['bad-id', intent().hash], value: intent({ workspaceId: 'bad-id' }) }],
    ['malformed attempt UUID', { key: [workspaceB, intent().hash], value: intent({ workspaceId: workspaceB, attemptId: 'bad-id' }) }],
    ['malformed key', { key: workspaceB, value: intent({ workspaceId: workspaceB }) }],
    ['mismatched key', { key: [workspaceB, intent().hash], value: intent() }],
  ])('rejects Workspace identity enumeration with a %s instead of returning partial IDs', async (_name, row) => {
    const database = new DatabaseFixture()
    await write(database, intent())
    database.rows.push(row)
    const before = structuredClone(database.rows)
    await expect(listWorkspaceIds(database)).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_INVALID' })
    expect(database.rows).toEqual(before)
    expect(database.close).toHaveBeenCalledTimes(2)
  })

  it.each(['request-error', 'transaction-error', 'abort'] as const)('rejects Workspace identity enumeration on %s', async failure => {
    const database = new DatabaseFixture()
    const operation = database.journal.listWorkspaceIds()
    const rejection = expect(operation).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_UNAVAILABLE' })
    const transaction = await database.nextTransaction()
    const error = new DOMException('read failed', 'UnknownError')
    if (failure === 'request-error') transaction.requestError('list', error)
    else {
      if (failure === 'transaction-error') transaction.error(error)
      transaction.abort()
    }
    await rejection
    expect(database.close).toHaveBeenCalledOnce()
  })

  it('isolates list and remove by Workspace/hash and permits a new attempt after removal', async () => {
    const database = new DatabaseFixture()
    const first = intent()
    const second = intent({ workspaceId: workspaceB })
    const third = intent({ hash: 'b'.repeat(64), bytes: 0 })
    await write(database, first)
    await write(database, second)
    await write(database, third)
    expect(await list(database, first.workspaceId)).toEqual([first, third])
    expect(await list(database, second.workspaceId)).toEqual([second])
    expect(await list(database, workspaceEmpty)).toEqual([])
    for (let attempt = 0; attempt < 2; attempt++) {
      const operation = database.journal.remove(first.workspaceId, first.hash)
      const transaction = await database.nextTransaction()
      transaction.complete()
      await operation
    }
    expect(await list(database, first.workspaceId)).toEqual([third])
    expect(await list(database, second.workspaceId)).toEqual([second])
    const replacement = intent({ attemptId: attemptNext })
    await write(database, replacement)
    expect(await list(database, first.workspaceId)).toEqual([third, replacement])
  })

  it.each([attemptA, attemptNext])('retains an unresolved intent when a duplicate is added with attempt %s', async attemptId => {
    const database = new DatabaseFixture()
    const original = intent()
    await write(database, original)
    const operation = database.journal.put(intent({ attemptId, bytes: original.bytes + 1 }))
    const rejection = expect(operation).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_INVALID' })
    const transaction = await database.nextTransaction()
    transaction.requestSuccess()
    await rejection
    expect(transaction.state.abort).toHaveBeenCalledOnce()
    expect(await list(database, workspaceA)).toEqual([original])
    expect(database.close).toHaveBeenCalledTimes(3)
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('accepts UUID version %i and RFC variant identities', async version => {
    const database = new DatabaseFixture()
    for (const variant of ['8', '9', 'a', 'b']) {
      const record = intent({
        workspaceId: `12345678-ABCD-${version}abc-${variant}123-123456789abc`,
        attemptId: `ABCDEF12-ABCD-${version}abc-${variant}123-123456789abc`,
      })
      await write(database, record)
      expect(await list(database, record.workspaceId)).toEqual([record])
    }
  })

  it.each(['', 'workspace-a', '11111111-1111-0111-8111-111111111111', '11111111-1111-4111-c111-111111111111'])
    ('rejects invalid Workspace input %s before opening IndexedDB', async workspaceId => {
      const database = new DatabaseFixture()
      await expect(database.journal.list(workspaceId)).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_INVALID' })
      await expect(database.journal.remove(workspaceId, intent().hash)).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_INVALID' })
      await expect(database.journal.put(intent({ workspaceId }))).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_INVALID' })
      expect(database.factory.open).not.toHaveBeenCalled()
    })

  it.each(['', 'attempt-a', 'aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa'])
    ('rejects invalid attempt input %s before opening IndexedDB', async attemptId => {
      const database = new DatabaseFixture()
      await expect(database.journal.put(intent({ attemptId }))).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_INVALID' })
      expect(database.factory.open).not.toHaveBeenCalled()
    })

  it.each(['', 'short', 'A'.repeat(64), 'g'.repeat(64)])('rejects invalid hash input %s before opening IndexedDB', async hash => {
    const database = new DatabaseFixture()
    await expect(database.journal.remove(workspaceA, hash)).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_INVALID' })
    await expect(database.journal.put(intent({ hash }))).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_INVALID' })
    expect(database.factory.open).not.toHaveBeenCalled()
  })

  it.each(['put', 'remove'] as const)('requires strict durability and waits beyond %s request success', async operationName => {
    const database = new DatabaseFixture()
    const operation = operationName === 'put' ? database.journal.put(intent()) : database.journal.remove(workspaceA, intent().hash)
    const settled = vi.fn()
    const observed = operation.then(settled)
    const transaction = await database.nextTransaction()
    transaction.requestSuccess()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(database.transaction).toHaveBeenCalledExactlyOnceWith('downloads', 'readwrite', { durability: 'strict' })
    expect(settled).not.toHaveBeenCalled()
    expect(database.close).not.toHaveBeenCalled()
    expect(database.rows).toEqual([])
    transaction.complete()
    await observed
    expect(settled).toHaveBeenCalledOnce()
    expect(database.close).toHaveBeenCalledOnce()
  })

  it.each(['list', 'put', 'remove'] as const)('rejects an aborted %s transaction without publishing staged changes', async operationName => {
    const database = new DatabaseFixture()
    const record = intent()
    database.rows.push({ key: [record.workspaceId, record.hash], value: record })
    const operation = operationName === 'list' ? database.journal.list(record.workspaceId)
      : operationName === 'put' ? database.journal.put(intent({ hash: 'b'.repeat(64) }))
        : database.journal.remove(record.workspaceId, record.hash)
    const rejection = expect(operation).rejects.toMatchObject({ name: 'DownloadJournalError', code: 'LOCAL_DOWNLOAD_JOURNAL_UNAVAILABLE' })
    const transaction = await database.nextTransaction()
    if (operationName === 'list') transaction.readAll()
    else transaction.requestSuccess()
    transaction.abort()
    await rejection
    expect(database.rows).toEqual([{ key: [record.workspaceId, record.hash], value: record }])
    expect(database.close).toHaveBeenCalledOnce()
  })

  it.each(['list', 'put', 'remove'] as const)('preserves the cause of a %s request error and closes the connection', async operationName => {
    const database = new DatabaseFixture()
    const operation = operationName === 'list' ? database.journal.list(workspaceA)
      : operationName === 'put' ? database.journal.put(intent()) : database.journal.remove(workspaceA, intent().hash)
    const error = new DOMException('request failed', 'QuotaExceededError')
    const rejection = expect(operation).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_UNAVAILABLE', cause: error })
    const transaction = await database.nextTransaction()
    transaction.requestError(operationName, error)
    await rejection
    expect(transaction.state.abort).toHaveBeenCalledOnce()
    expect(database.rows).toEqual([])
    expect(database.close).toHaveBeenCalledOnce()
  })

  it('waits for transaction abort after an error event', async () => {
    const database = new DatabaseFixture()
    const operation = database.journal.put(intent())
    const error = new DOMException('transaction failed', 'UnknownError')
    const rejection = expect(operation).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_UNAVAILABLE', cause: error })
    const transaction = await database.nextTransaction()
    transaction.error(error)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(database.close).not.toHaveBeenCalled()
    transaction.abort()
    await rejection
    expect(database.rows).toEqual([])
    expect(database.close).toHaveBeenCalledOnce()
  })

  it('aborts and reports an add error after the key lookup succeeded', async () => {
    const database = new DatabaseFixture()
    const error = new DOMException('add failed', 'QuotaExceededError')
    const operation = database.journal.put(intent())
    const rejection = expect(operation).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_UNAVAILABLE', cause: error })
    const transaction = await database.nextTransaction()
    transaction.addError(error)
    await rejection
    expect(database.rows).toEqual([])
    expect(database.close).toHaveBeenCalledOnce()
  })

  it.each([
    ['future intent version', { ...intent(), version: 2 }],
    ['missing intent version', { workspaceId: workspaceA, hash: intent().hash, bytes: 128, attemptId: attemptA }],
    ['null record', null],
    ['array record', []],
    ['short hash', { ...intent(), hash: 'abc' }],
    ['uppercase hash', { ...intent(), hash: 'A'.repeat(64) }],
    ['negative bytes', { ...intent(), bytes: -1 }],
    ['fractional bytes', { ...intent(), bytes: 1.5 }],
    ['unsafe bytes', { ...intent(), bytes: Number.MAX_SAFE_INTEGER + 1 }],
    ['NaN bytes', { ...intent(), bytes: Number.NaN }],
    ['empty Workspace', { ...intent(), workspaceId: '' }],
    ['empty attempt', { ...intent(), attemptId: '' }],
    ['missing attempt', { version: 1, workspaceId: workspaceA, hash: intent().hash, bytes: 128 }],
    ['non-UUID Workspace', { ...intent(), workspaceId: 'workspace-a' }],
    ['non-UUID attempt', { ...intent(), attemptId: 'attempt-a' }],
    ['unsupported Workspace UUID version', { ...intent(), workspaceId: '11111111-1111-9111-8111-111111111111' }],
    ['unsupported attempt UUID version', { ...intent(), attemptId: 'aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa' }],
    ['wrong Workspace UUID variant', { ...intent(), workspaceId: '11111111-1111-4111-7111-111111111111' }],
    ['wrong attempt UUID variant', { ...intent(), attemptId: 'aaaaaaaa-aaaa-4aaa-caaa-aaaaaaaaaaaa' }],
  ])('rejects %s without deleting its record', async (_name, value) => {
    const database = new DatabaseFixture()
    database.rows.push({ key: [workspaceA, intent().hash], value })
    const before = structuredClone(database.rows)
    await expect(list(database, workspaceA)).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_INVALID' })
    expect(database.rows).toEqual(before)
    expect(database.close).toHaveBeenCalledOnce()
  })

  it.each([
    ['string key', 'workspace-a/hash'],
    ['numeric key', 42],
    ['empty key', []],
    ['short compound key', [workspaceA]],
    ['long compound key', [workspaceA, intent().hash, 'extra']],
    ['non-string key component', [workspaceA, 42]],
    ['Workspace mismatch', [workspaceB, intent().hash]],
    ['hash mismatch', [workspaceA, 'b'.repeat(64)]],
  ])('rejects a tampered %s', async (_name, key) => {
    const database = new DatabaseFixture()
    database.rows.push({ key, value: intent() })
    await expect(list(database, workspaceA)).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_INVALID' })
    expect(database.rows).toHaveLength(1)
    expect(database.close).toHaveBeenCalledOnce()
  })

  it('does not silently skip malformed intents belonging to another Workspace', async () => {
    const database = new DatabaseFixture()
    database.rows.push({ key: [workspaceB, intent().hash], value: { ...intent({ workspaceId: workspaceB }), version: 2 } })
    await expect(list(database, workspaceA)).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_INVALID' })
    expect(database.rows).toHaveLength(1)
  })

  it.each(['future database', 'missing store', 'wrong key path', 'auto-increment'] as const)('rejects %s without repair', async scenario => {
    const database = new DatabaseFixture()
    if (scenario === 'future database') database.version = 2
    else if (scenario === 'missing store') database.missingStore = true
    else if (scenario === 'wrong key path') database.keyPath = 'hash'
    else database.autoIncrement = true
    await expect(database.journal.list(workspaceA)).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_INVALID' })
    expect(database.createObjectStore).not.toHaveBeenCalled()
    expect(database.close).toHaveBeenCalledOnce()
  })

  it.each([
    ['VersionError', 'LOCAL_DOWNLOAD_JOURNAL_INVALID'],
    ['SecurityError', 'LOCAL_DOWNLOAD_JOURNAL_UNAVAILABLE'],
  ])('reports %s from open explicitly', async (name, code) => {
    const database = new DatabaseFixture()
    database.openError = new DOMException('open failed', name)
    await expect(database.journal.list(workspaceA)).rejects.toMatchObject({ name: 'DownloadJournalError', code })
    expect(database.transaction).not.toHaveBeenCalled()
  })

  it('closes a late connection after blocked open has already failed', async () => {
    const database = new DatabaseFixture()
    database.blocked = true
    await expect(database.journal.list(workspaceA)).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_UNAVAILABLE' })
    database.finishBlockedOpen()
    expect(database.close).toHaveBeenCalledOnce()
    expect(database.transaction).not.toHaveBeenCalled()
  })

  it('wraps synchronous transaction setup failures and closes the connection', async () => {
    const database = new DatabaseFixture()
    database.transactionError = new DOMException('cannot transact', 'InvalidStateError')
    await expect(database.journal.put(intent())).rejects.toMatchObject({
      code: 'LOCAL_DOWNLOAD_JOURNAL_UNAVAILABLE', cause: database.transactionError,
    })
    expect(database.close).toHaveBeenCalledOnce()
    expect(database.rows).toEqual([])
  })

  it('reports missing IndexedDB explicitly', async () => {
    vi.stubGlobal('indexedDB', undefined)
    await expect(new BrowserDownloadJournal().list(workspaceA)).rejects.toBeInstanceOf(DownloadJournalError)
    await expect(new BrowserDownloadJournal().list(workspaceA)).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_JOURNAL_UNAVAILABLE' })
  })
})

describe('withWorkspaceStorageLock', () => {
  it('requests the exact exclusive Workspace lock and holds it until the action settles', async () => {
    const gate = deferred<number>()
    const actionStarted = deferred<void>()
    const released = vi.fn()
    const request = vi.fn(async (name: string, _options: LockOptions, action: (lock: Lock) => Promise<unknown>) => {
      try {
        return await action({ name, mode: 'exclusive' })
      } finally {
        released()
      }
    })
    vi.stubGlobal('navigator', { locks: { request } })
    const result = withWorkspaceStorageLock('workspace/a', async () => {
      actionStarted.resolve()
      return await gate.promise
    })
    await actionStarted.promise
    expect(request).toHaveBeenCalledExactlyOnceWith('dsh-workspace-local-workspace/a', { mode: 'exclusive' }, expect.any(Function))
    expect(released).not.toHaveBeenCalled()
    gate.resolve(42)
    await expect(result).resolves.toBe(42)
    expect(released).toHaveBeenCalledOnce()
  })

  it.each([undefined, {}, { locks: {} }])('rejects missing lock capability without running the action', async navigatorValue => {
    vi.stubGlobal('navigator', navigatorValue)
    const action = vi.fn(async () => 'unexpected')
    await expect(withWorkspaceStorageLock('workspace-a', action)).rejects.toMatchObject({ code: 'LOCAL_STORAGE_LOCK_UNAVAILABLE' })
    expect(action).not.toHaveBeenCalled()
  })

  it('wraps failed acquisition without running the action', async () => {
    const error = new DOMException('locks disallowed', 'SecurityError')
    vi.stubGlobal('navigator', { locks: { request: vi.fn(async () => { throw error }) } })
    const action = vi.fn(async () => 'unexpected')
    await expect(withWorkspaceStorageLock('workspace-a', action)).rejects.toMatchObject({ code: 'LOCAL_STORAGE_LOCK_UNAVAILABLE', cause: error })
    expect(action).not.toHaveBeenCalled()
  })

  it('rejects an ungranted lock without running the action', async () => {
    vi.stubGlobal('navigator', {
      locks: { request: async (_name: string, _options: LockOptions, action: (lock: null) => Promise<unknown>) => await action(null) },
    })
    const action = vi.fn(async () => 'unexpected')
    await expect(withWorkspaceStorageLock('workspace-a', action)).rejects.toMatchObject({ code: 'LOCAL_STORAGE_LOCK_UNAVAILABLE' })
    expect(action).not.toHaveBeenCalled()
  })

  it('preserves action failures and lets Web Locks release the lock', async () => {
    const released = vi.fn()
    vi.stubGlobal('navigator', {
      locks: { request: async (name: string, _options: LockOptions, action: (lock: Lock) => Promise<unknown>) => {
        try {
          return await action({ name, mode: 'exclusive' })
        } finally {
          released()
        }
      } },
    })
    const error = new Error('download failed')
    await expect(withWorkspaceStorageLock('workspace-a', async () => { throw error })).rejects.toBe(error)
    expect(released).toHaveBeenCalledOnce()
  })
})
