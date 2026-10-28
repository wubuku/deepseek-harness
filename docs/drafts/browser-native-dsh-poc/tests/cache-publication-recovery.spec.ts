import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DownloadJournalError } from '../browser-native-download-journal.ts'
import type { DownloadIntent, DownloadJournal } from '../browser-native-download-journal.ts'
import type { WorkspaceChange } from '../browser-native-workspace.ts'
import {
  BrowserDurableWorkspaceStore,
  type DownloadPublicationStage,
  type DurableWorkspaceSnapshot,
} from '../browser-native-workspace-store.ts'

const workspaceId = '7cb327fe-f71a-4d54-ac91-17f0ab4fb163'
const otherWorkspaceId = 'a91d2bd5-e225-4d04-9a29-b49fb324ff11'
const chunkBytes = 1024 * 1024
const content = Uint8Array.from({ length: chunkBytes + 19 }, (_, index) => index % 251)
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const contentHash = hash(content)
const cleanSnapshot: DurableWorkspaceSnapshot = { version: 1, workspaceId, revision: 4, pending: [] }

function snapshotWithChanges(owner: 'pending' | 'retryBatch', changes: readonly WorkspaceChange[]): DurableWorkspaceSnapshot {
  return owner === 'pending' ? { ...cleanSnapshot, pending: changes } : {
    ...cleanSnapshot, retryBatch: { operationId: 'retry-operation', baseRevision: 4, changes },
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

class SerialLocks implements Pick<LockManager, 'request'> {
  readonly requests: Array<{ name: string; mode: LockMode }> = []
  readonly held = new Set<string>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly arrivals: Array<{ count: number; resolve: () => void }> = []

  async waitForRequests(count: number): Promise<void> {
    if (this.requests.length >= count) return
    await new Promise<void>(resolve => { this.arrivals.push({ count, resolve }) })
  }

  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<Awaited<T>>
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<Awaited<T>>
  async request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    optionalCallback?: LockGrantedCallback<T>,
  ): Promise<Awaited<T>> {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : optionalCallback
    if (callback === undefined) throw new Error('Missing lock callback')
    const mode = typeof optionsOrCallback === 'function' ? 'exclusive' : optionsOrCallback.mode ?? 'exclusive'
    this.requests.push({ name, mode })
    const previous = this.tails.get(name) ?? Promise.resolve()
    const released = deferred()
    this.tails.set(name, released.promise)
    for (const arrival of this.arrivals) if (this.requests.length >= arrival.count) arrival.resolve()
    await previous
    this.held.add(name)
    try {
      return await callback({ name, mode })
    } finally {
      this.held.delete(name)
      if (this.tails.get(name) === released.promise) this.tails.delete(name)
      released.resolve()
    }
  }
}

class MemoryJournal implements DownloadJournal {
  readonly intents = new Map<string, DownloadIntent>()
  readonly listWorkspaceIds = vi.fn(async (): Promise<readonly string[]> => {
    return [...new Set([...this.intents.values()].map(intent => intent.workspaceId))].sort()
  })
  readonly list = vi.fn(async (workspace: string): Promise<readonly DownloadIntent[]> => {
    this.trace.push('journal:list')
    return [...this.intents.values()].filter(intent => intent.workspaceId === workspace).map(intent => ({ ...intent }))
  })
  readonly put = vi.fn(async (intent: DownloadIntent): Promise<void> => {
    this.trace.push('journal:put')
    this.intents.set(`${intent.workspaceId}:${intent.hash}`, { ...intent })
  })
  readonly remove = vi.fn(async (workspace: string, digest: string): Promise<void> => {
    this.trace.push('journal:remove')
    this.intents.delete(`${workspace}:${digest}`)
  })

  constructor(private readonly trace: string[]) {}

  seed(bytes = content, workspace = workspaceId): DownloadIntent {
    const intent: DownloadIntent = {
      version: 1, workspaceId: workspace, hash: hash(bytes), bytes: bytes.byteLength,
      attemptId: '1ee1f36c-a560-4b05-8e5d-9a930d93e42b',
    }
    this.intents.set(`${workspace}:${intent.hash}`, intent)
    return intent
  }
}

class MetadataTransaction {
  error: DOMException | null = null
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  private pending = 0
  private settled = false
  private readonly writes: Array<() => void> = []

  constructor(private readonly records: Map<string, unknown>, private readonly trace: string[]) {}

  private request<T>(operation: () => T) {
    const request: { result: T | undefined; onsuccess: (() => void) | null } = { result: undefined, onsuccess: null }
    this.pending += 1
    queueMicrotask(() => {
      if (this.settled) return
      request.result = structuredClone(operation())
      request.onsuccess?.()
      this.pending -= 1
      queueMicrotask(() => {
        if (this.pending !== 0 || this.settled) return
        this.settled = true
        for (const write of this.writes) write()
        this.oncomplete?.()
      })
    })
    return request
  }

  objectStore(name: string) {
    expect(name).toBe('workspace')
    return {
      get: (workspace: string) => this.request(() => {
        this.trace.push('metadata:get')
        return this.records.get(workspace)
      }),
      getAllKeys: () => this.request(() => [...this.records.keys()]),
      put: (record: { workspaceId: string }) => this.request(() => {
        const stored = structuredClone(record)
        this.writes.push(() => { this.records.set(record.workspaceId, stored) })
        return record.workspaceId
      }),
      delete: (workspace: string) => this.request(() => {
        this.writes.push(() => { this.records.delete(workspace) })
      }),
    }
  }

  abort(): void {
    this.settled = true
    this.error = new DOMException('Metadata transaction aborted', 'AbortError')
    queueMicrotask(() => { this.onabort?.() })
  }
}

function storageFixture(options: { readonly metadata?: unknown; readonly missingMetadata?: boolean } = {}) {
  const trace: string[] = []
  const records = new Map<string, unknown>()
  if (options.missingMetadata !== true) records.set(workspaceId, structuredClone('metadata' in options ? options.metadata : cleanSnapshot))
  const locks = new SerialLocks()
  const journal = new MemoryJournal(trace)
  const directories = new Map<string, Map<string, Uint8Array>>()
  const files = new Map<string, Uint8Array>()
  directories.set(`dsh-workspace-blobs-${workspaceId}`, files)
  const create = vi.fn()
  const remove = vi.fn()
  const write = vi.fn(async (_command: { position: number; data: ArrayBuffer }): Promise<void> => {})
  const close = vi.fn()
  const abort = vi.fn()
  const directory = (name: string) => {
    const entries = directories.get(name)
    if (entries === undefined) throw new DOMException('Missing directory', 'NotFoundError')
    const fileHandle = (digest: string) => ({
      kind: 'file',
      name: digest,
      getFile: async () => {
        const bytes = entries.get(digest)
        if (bytes === undefined) throw new DOMException('Missing file', 'NotFoundError')
        return new File([new Uint8Array(bytes)], digest)
      },
      createWritable: async () => {
        let staging = new Uint8Array(0)
        let published = false
        return {
          write: async (command: { position: number; data: ArrayBuffer }) => {
            trace.push('opfs:write')
            await write(command)
            const next = new Uint8Array(Math.max(staging.byteLength, command.position + command.data.byteLength))
            next.set(staging)
            next.set(new Uint8Array(command.data), command.position)
            staging = next
          },
          close: async () => {
            trace.push('opfs:close')
            close()
            entries.set(digest, staging.slice())
            published = true
          },
          abort: async () => {
            trace.push('opfs:abort')
            abort()
            if (!published) staging = new Uint8Array(0)
          },
        }
      },
      createSyncAccessHandle: async () => ({
        getSize: () => entries.get(digest)!.byteLength,
        read: (output: Uint8Array, readOptions: { at: number }) => {
          const bytes = entries.get(digest)!.subarray(readOptions.at, readOptions.at + output.byteLength)
          output.set(bytes)
          return bytes.byteLength
        },
        close: () => {},
      }),
    })
    return {
      kind: 'directory', name,
      getFileHandle: async (digest: string, fileOptions?: { create?: boolean }) => {
        if (!entries.has(digest)) {
          if (fileOptions?.create !== true) throw new DOMException('Missing file', 'NotFoundError')
          create(digest)
          trace.push('opfs:create')
          entries.set(digest, new Uint8Array(0))
        }
        return fileHandle(digest)
      },
      removeEntry: async (digest: string) => {
        remove(digest)
        trace.push('opfs:remove')
        entries.delete(digest)
      },
      values: async function* () { for (const digest of entries.keys()) yield fileHandle(digest) },
    }
  }
  const database = {
    version: 1,
    close: vi.fn(),
    transaction: (name: string) => {
      expect(name).toBe('workspace')
      return new MetadataTransaction(records, trace)
    },
  }
  vi.stubGlobal('indexedDB', { open: () => {
    const request = { result: database, onsuccess: () => {} }
    queueMicrotask(() => { request.onsuccess() })
    return request
  } })
  vi.stubGlobal('navigator', {
    locks,
    storage: { getDirectory: async () => ({
      getDirectoryHandle: async (name: string) => {
        if (!directories.has(name)) directories.set(name, new Map())
        return directory(name)
      },
      removeEntry: async (name: string) => { directories.delete(name) },
      entries: async function* () { for (const name of directories.keys()) yield [name, directory(name)] },
    }) },
  })
  const store = (hooks?: ConstructorParameters<typeof BrowserDurableWorkspaceStore>[0]) => new BrowserDurableWorkspaceStore(hooks, journal)
  const read = vi.fn(async (offset: number, length: number) => content.slice(offset, offset + length))
  return { store, files, directories, records, journal, locks, create, remove, write, close, abort, trace, read }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('download publication recovery', () => {
  it.each([
    ['intent-durable', undefined],
    ['entry-created', new Uint8Array(0)],
    ['first-chunk-written', content.subarray(0, chunkBytes)],
    ['published', content],
  ] as const)('recovers persisted state at %s using a new store instance', async (stage, bytes) => {
    const local = storageFixture()
    local.journal.seed()
    if (bytes !== undefined) local.files.set(contentHash, bytes.slice())
    const originalMetadata = structuredClone(local.records.get(workspaceId))
    const unrelated = new Uint8Array([9, 8, 7])
    const unrelatedHash = hash(unrelated)
    local.files.set(unrelatedHash, unrelated)
    const fresh = local.store()

    await expect(fresh.load(workspaceId)).resolves.toEqual(cleanSnapshot)
    expect(local.journal.intents.size).toBe(0)
    expect(local.journal.remove).toHaveBeenCalledWith(workspaceId, contentHash)
    expect(local.records.get(workspaceId)).toEqual(originalMetadata)
    expect(local.files.get(unrelatedHash)).toEqual(unrelated)
    expect(local.trace.indexOf('journal:list')).toBeLessThan(local.trace.indexOf('metadata:get'))
    expect(local.remove).toHaveBeenCalledTimes(stage === 'entry-created' || stage === 'first-chunk-written' ? 1 : 0)
    expect(local.files.get(contentHash)).toEqual(stage === 'published' ? content : undefined)

    await expect(fresh.cacheBlobFromChunks(workspaceId, contentHash, content.byteLength, local.read)).resolves.toBe(true)
    expect(local.read).toHaveBeenCalledTimes(stage === 'published' ? 0 : 2)
    expect(local.files.get(contentHash)).toEqual(content)
    expect(local.journal.intents.size).toBe(0)
  })

  it('removes a same-size wrong-hash remnant only when an intent permits recovery', async () => {
    const local = storageFixture()
    local.journal.seed()
    local.files.set(contentHash, new Uint8Array(content.byteLength))
    await expect(local.store().load(workspaceId)).resolves.toEqual(cleanSnapshot)
    expect(local.remove).toHaveBeenCalledWith(contentHash)
    expect(local.files.has(contentHash)).toBe(false)
    expect(local.journal.intents.size).toBe(0)
  })

  it('keeps a verified empty published entry while clearing its intent', async () => {
    const local = storageFixture()
    const empty = new Uint8Array(0)
    const intent = local.journal.seed(empty)
    local.files.set(intent.hash, empty)
    await expect(local.store().load(workspaceId)).resolves.toEqual(cleanSnapshot)
    expect(local.files.get(intent.hash)).toEqual(empty)
    expect(local.remove).not.toHaveBeenCalled()
    expect(local.journal.intents.size).toBe(0)
  })

  it.each([false, true])('rejects missing metadata before clearing an intent with file=%s', async hasFile => {
    const local = storageFixture({ missingMetadata: true })
    const intent = local.journal.seed()
    if (hasFile) local.files.set(contentHash, new Uint8Array([1, 2]))
    await expect(local.store().load(workspaceId)).rejects.toMatchObject({ code: 'LOCAL_METADATA_MISSING' })
    expect(local.journal.intents.get(`${workspaceId}:${contentHash}`)).toEqual(intent)
    expect(local.files.get(contentHash)).toEqual(hasFile ? new Uint8Array([1, 2]) : undefined)
    expect(local.remove).not.toHaveBeenCalled()
    expect(local.journal.remove).not.toHaveBeenCalled()
  })

  it.each([
    null,
    { ...cleanSnapshot, version: 2 },
    { ...cleanSnapshot, pending: [{}] },
    { ...cleanSnapshot, retryBatch: { operationId: 'retry', baseRevision: 4, changes: [{}] } },
  ])('rejects invalid metadata before modifying remnants: %j', async metadata => {
    const local = storageFixture({ metadata })
    local.journal.seed()
    local.files.set(contentHash, new Uint8Array([1]))
    await expect(local.store().load(workspaceId)).rejects.toMatchObject({ code: 'LOCAL_METADATA_INVALID' })
    expect(local.records.get(workspaceId)).toEqual(metadata)
    expect(local.files.get(contentHash)).toEqual(new Uint8Array([1]))
    expect(local.remove).not.toHaveBeenCalled()
    expect(local.journal.remove).not.toHaveBeenCalled()
  })

  it('propagates an unknown journal version without reading or modifying OPFS', async () => {
    const local = storageFixture()
    local.journal.seed()
    local.files.set(contentHash, new Uint8Array([1]))
    const failure = new DownloadJournalError('LOCAL_DOWNLOAD_JOURNAL_INVALID', 'Unsupported download intent version: 2')
    local.journal.list.mockRejectedValue(failure)
    await expect(local.store().load(workspaceId)).rejects.toBe(failure)
    expect(local.files.get(contentHash)).toEqual(new Uint8Array([1]))
    expect(local.trace).not.toContain('metadata:get')
    expect(local.remove).not.toHaveBeenCalled()
    expect(local.journal.remove).not.toHaveBeenCalled()
    expect(local.journal.intents.size).toBe(1)
  })

  it.each(['pending', 'retry'] as const)('protects %s content for absent, partial and complete files', async owner => {
    for (const bytes of [undefined, new Uint8Array([1, 2]), content]) {
      const change = { path: 'draft.bin', kind: 'file', mode: 0o600, bytes: content.byteLength, contentHash }
      const metadata = { ...cleanSnapshot,
        pending: owner === 'pending' ? [change] : [],
        ...(owner === 'retry' ? { retryBatch: { operationId: 'retry-operation', baseRevision: 4, changes: [change] } } : {}),
      }
      const local = storageFixture({ metadata })
      local.journal.seed()
      if (bytes !== undefined) local.files.set(contentHash, bytes.slice())
      await expect(local.store().load(workspaceId)).rejects.toMatchObject({ code: 'LOCAL_DOWNLOAD_PROTECTED' })
      expect(local.records.get(workspaceId)).toEqual(metadata)
      expect(local.files.get(contentHash)).toEqual(bytes)
      expect(local.remove).not.toHaveBeenCalled()
      expect(local.journal.remove).not.toHaveBeenCalled()
      expect(local.journal.intents.size).toBe(1)
    }
  })

  it.each([
    ['size mismatch', new Uint8Array(0), 'LOCAL_BLOB_SIZE_MISMATCH'],
    ['hash mismatch', new Uint8Array(content.byteLength), 'LOCAL_BLOB_CORRUPT'],
  ] as const)('does not repair damaged bytes without an intent (%s)', async (_name, bytes, code) => {
    const local = storageFixture()
    local.files.set(contentHash, bytes)
    const store = local.store()
    await expect(store.load(workspaceId)).resolves.toEqual(cleanSnapshot)
    await expect(store.cacheBlobFromChunks(workspaceId, contentHash, content.byteLength, local.read)).rejects.toMatchObject({ code })
    expect(local.files.get(contentHash)).toEqual(bytes)
    expect(local.remove).not.toHaveBeenCalled()
    expect(local.journal.put).not.toHaveBeenCalled()
    expect(local.read).not.toHaveBeenCalled()
  })

  it('retains damaged unjournaled pending bytes and reports corruption', async () => {
    const metadata = { ...cleanSnapshot, pending: [{ path: 'draft.bin', kind: 'file', mode: 0o600,
      bytes: content.byteLength, contentHash }] }
    const local = storageFixture({ metadata })
    local.files.set(contentHash, new Uint8Array([1]))
    await expect(local.store().load(workspaceId)).rejects.toMatchObject({ code: 'LOCAL_BLOB_CORRUPT' })
    expect(local.files.get(contentHash)).toEqual(new Uint8Array([1]))
    expect(local.records.get(workspaceId)).toEqual(metadata)
    expect(local.remove).not.toHaveBeenCalled()
  })
})

describe('journaled download publication', () => {
  it('persists the intent before creation and reports stages around write, close and journal removal', async () => {
    const local = storageFixture()
    const stages: DownloadPublicationStage[] = []
    const store = local.store({ downloadStage: async stage => {
      stages.push(stage)
      local.trace.push(stage)
      const [intent] = [...local.journal.intents.values()]
      expect(intent).toMatchObject({ version: 1, workspaceId, hash: contentHash, bytes: content.byteLength,
        attemptId: expect.any(String) })
      expect(intent?.attemptId.length).toBeGreaterThan(0)
      expect(local.locks.held.has(`dsh-workspace-local-${workspaceId}`)).toBe(true)
      if (stage === 'intent-durable') expect(local.create).not.toHaveBeenCalled()
      if (stage === 'entry-created') expect(local.files.get(contentHash)).toEqual(new Uint8Array(0))
      if (stage === 'first-chunk-written') {
        expect(local.write).toHaveBeenCalledTimes(1)
        expect(local.close).not.toHaveBeenCalled()
      }
      if (stage === 'published') expect(local.files.get(contentHash)).toEqual(content)
      expect(local.journal.remove).not.toHaveBeenCalled()
    } })
    await expect(store.cacheBlobFromChunks(workspaceId, contentHash, content.byteLength, local.read)).resolves.toBe(true)
    expect(stages).toEqual(['intent-durable', 'entry-created', 'first-chunk-written', 'published'])
    expect(local.trace.filter(event => event !== 'journal:list' && event !== 'metadata:get')).toEqual([
      'journal:put', 'intent-durable', 'opfs:create', 'entry-created', 'opfs:write',
      'first-chunk-written', 'opfs:write', 'opfs:close', 'published', 'journal:remove',
    ])
    expect(local.journal.intents.size).toBe(0)
    expect(local.locks.held.size).toBe(0)
  })

  it('does not create an entry or read chunks when the intent cannot commit', async () => {
    const local = storageFixture()
    const failure = new DOMException('Intent transaction aborted', 'AbortError')
    local.journal.put.mockRejectedValue(failure)
    await expect(local.store().cacheBlobFromChunks(workspaceId, contentHash, content.byteLength, local.read)).rejects.toBe(failure)
    expect(local.create).not.toHaveBeenCalled()
    expect(local.write).not.toHaveBeenCalled()
    expect(local.read).not.toHaveBeenCalled()
    expect(local.files.size).toBe(0)
    expect(local.locks.held.size).toBe(0)
  })

  it('requires metadata before persisting an intent or creating a download entry', async () => {
    const local = storageFixture({ missingMetadata: true })
    await expect(local.store().cacheBlobFromChunks(workspaceId, contentHash, content.byteLength, local.read)).rejects.toMatchObject({ code: 'LOCAL_METADATA_MISSING' })
    expect(local.journal.put).not.toHaveBeenCalled()
    expect(local.create).not.toHaveBeenCalled()
    expect(local.read).not.toHaveBeenCalled()
  })

  it('recovers an interrupted entry before examining the existing cache', async () => {
    const local = storageFixture()
    local.journal.seed()
    local.files.set(contentHash, new Uint8Array([1]))
    await expect(local.store().cacheBlobFromChunks(workspaceId, contentHash, content.byteLength, local.read)).resolves.toBe(true)
    expect(local.trace.indexOf('opfs:remove')).toBeLessThan(local.trace.indexOf('journal:put'))
    expect(local.files.get(contentHash)).toEqual(content)
  })

  it('reuses verified existing bytes without a new intent or source reads', async () => {
    const local = storageFixture()
    local.files.set(contentHash, content)
    await expect(local.store().cacheBlobFromChunks(workspaceId, contentHash, content.byteLength, local.read)).resolves.toBe(true)
    expect(local.journal.put).not.toHaveBeenCalled()
    expect(local.create).not.toHaveBeenCalled()
    expect(local.read).not.toHaveBeenCalled()
  })

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects invalid byte length %s before durable writes', async bytes => {
    const local = storageFixture()
    await expect(local.store().cacheBlobFromChunks(workspaceId, contentHash, bytes, local.read)).rejects.toBeInstanceOf(RangeError)
    expect(local.journal.put).not.toHaveBeenCalled()
    expect(local.create).not.toHaveBeenCalled()
    expect(local.read).not.toHaveBeenCalled()
  })

  it.each(['', 'x'.repeat(64), contentHash.toUpperCase(), contentHash.slice(1), `${contentHash}0`, '../blob'])('rejects invalid hash %s before durable writes', async digest => {
    const local = storageFixture()
    await expect(local.store().cacheBlobFromChunks(workspaceId, digest, content.byteLength, local.read)).rejects.toBeInstanceOf(RangeError)
    expect(local.journal.put).not.toHaveBeenCalled()
    expect(local.create).not.toHaveBeenCalled()
    expect(local.read).not.toHaveBeenCalled()
  })

  it('checks empty-file EOF and retains verified empty bytes after rejecting excess source bytes', async () => {
    const local = storageFixture()
    const empty = new Uint8Array(0)
    const read = vi.fn(async () => new Uint8Array([1]))
    await expect(local.store().cacheBlobFromChunks(workspaceId, hash(empty), 0, read)).rejects.toThrow(/empty blob/)
    expect(read).toHaveBeenCalledExactlyOnceWith(0, 0)
    expect(local.close).not.toHaveBeenCalled()
    expect(local.files.get(hash(empty))).toEqual(empty)
    expect(local.journal.intents.size).toBe(0)
  })

  it('publishes a verified empty file only after reading its EOF', async () => {
    const local = storageFixture()
    const empty = new Uint8Array(0)
    const read = vi.fn(async () => empty)
    const stages: DownloadPublicationStage[] = []
    await expect(local.store({ downloadStage: async stage => { stages.push(stage) } })
      .cacheBlobFromChunks(workspaceId, hash(empty), 0, read)).resolves.toBe(true)
    expect(read).toHaveBeenCalledExactlyOnceWith(0, 0)
    expect(stages).toEqual(['intent-durable', 'entry-created', 'published'])
    expect(local.write).not.toHaveBeenCalled()
    expect(local.close).toHaveBeenCalledTimes(1)
    expect(local.files.get(hash(empty))).toEqual(empty)
    expect(local.journal.intents.size).toBe(0)
    expect(local.locks.requests).toEqual([{ name: `dsh-workspace-local-${workspaceId}`, mode: 'exclusive' }])
  })

  it.each(['source', 'source-after-first-chunk', 'short-chunk', 'hash', 'write', 'close', 'abort'] as const)('aborts and recovers only its new entry after %s failure', async fault => {
    const local = storageFixture()
    const original = new Uint8Array([5, 4, 3])
    const originalHash = hash(original)
    local.files.set(originalHash, original)
    const failure = new Error(`Injected ${fault} failure`)
    const read = vi.fn(async (offset: number, length: number) => {
      if (fault === 'source' || fault === 'abort' || (fault === 'source-after-first-chunk' && offset > 0)) throw failure
      if (fault === 'short-chunk') return new Uint8Array(0)
      return fault === 'hash' ? new Uint8Array(length) : content.slice(offset, offset + length)
    })
    if (fault === 'write') local.write.mockImplementationOnce(() => { throw failure })
    if (fault === 'close') local.close.mockImplementationOnce(() => { throw failure })
    if (fault === 'abort') local.abort.mockImplementationOnce(() => { throw new Error('Injected abort failure') })
    const download = local.store().cacheBlobFromChunks(workspaceId, contentHash, content.byteLength, read)
    if (fault === 'short-chunk') await expect(download).rejects.toThrow(/unexpected size/)
    else if (fault === 'hash') await expect(download).rejects.toMatchObject({ code: 'LOCAL_BLOB_CORRUPT' })
    else await expect(download).rejects.toBe(failure)
    expect(local.abort).toHaveBeenCalledTimes(1)
    expect(local.trace.indexOf('opfs:abort')).toBeLessThan(local.trace.lastIndexOf('journal:list'))
    expect(local.files.has(contentHash)).toBe(false)
    expect(local.files.get(originalHash)).toEqual(original)
    expect(local.records.get(workspaceId)).toEqual(cleanSnapshot)
    expect(local.journal.intents.size).toBe(0)
    expect(local.locks.held.size).toBe(0)
  })

  it('preserves a published complete file when journal removal fails after close', async () => {
    const local = storageFixture()
    const failure = new Error('Journal removal failed')
    local.journal.remove.mockRejectedValueOnce(failure)
    await expect(local.store().cacheBlobFromChunks(workspaceId, contentHash, content.byteLength, local.read)).rejects.toBe(failure)
    expect(local.files.get(contentHash)).toEqual(content)
    expect(local.remove).not.toHaveBeenCalled()
    expect(local.journal.intents.size).toBe(0)
  })

  it('preserves a remnant if failure cleanup discovers a dirty reference', async () => {
    const local = storageFixture()
    const readFailure = new Error('Source failed')
    const metadata = { ...cleanSnapshot, pending: [{ path: 'draft.bin', kind: 'file', mode: 0o600,
      bytes: content.byteLength, contentHash }] }
    const read = vi.fn(async (): Promise<Uint8Array> => {
      local.records.set(workspaceId, metadata)
      throw readFailure
    })
    const result = await local.store().cacheBlobFromChunks(workspaceId, contentHash, content.byteLength, read).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(AggregateError)
    if (!(result instanceof AggregateError)) throw new Error('Expected cleanup failure')
    expect(result.errors).toEqual([readFailure, expect.objectContaining({ code: 'LOCAL_DOWNLOAD_PROTECTED' })])
    expect(local.files.get(contentHash)).toEqual(new Uint8Array(0))
    expect(local.records.get(workspaceId)).toEqual(metadata)
    expect(local.journal.intents.size).toBe(1)
    expect(local.remove).not.toHaveBeenCalled()
    expect(local.locks.held.size).toBe(0)
  })
})

describe('Workspace local Web Locks', () => {
  it('serializes competing stores so only one publisher reads and writes bytes', async () => {
    const local = storageFixture()
    const entered = deferred()
    const proceed = deferred()
    const first = local.store({ downloadStage: async stage => {
      if (stage !== 'intent-durable') return
      entered.resolve()
      await proceed.promise
    } }).cacheBlobFromChunks(workspaceId, contentHash, content.byteLength, local.read)
    const firstResult = expect(first).resolves.toBe(true)
    let secondResult: Promise<void> | undefined
    const secondRead = vi.fn(async (offset: number, length: number) => content.slice(offset, offset + length))
    try {
      await entered.promise
      secondResult = expect(local.store().cacheBlobFromChunks(workspaceId, contentHash, content.byteLength, secondRead)).resolves.toBe(true)
      await local.locks.waitForRequests(2)
      expect(local.journal.put).toHaveBeenCalledTimes(1)
      expect(local.journal.list).toHaveBeenCalledTimes(1)
      expect(local.create).not.toHaveBeenCalled()
      expect(secondRead).not.toHaveBeenCalled()
    } finally {
      proceed.resolve()
      await Promise.all([firstResult, secondResult])
    }
    expect(local.create).toHaveBeenCalledTimes(1)
    expect(local.journal.put).toHaveBeenCalledTimes(1)
    expect(local.read).toHaveBeenCalledTimes(2)
    expect(secondRead).not.toHaveBeenCalled()
    expect(local.files.get(contentHash)).toEqual(content)
    expect(local.locks.requests).toEqual(Array.from({ length: 2 }, () => ({ name: `dsh-workspace-local-${workspaceId}`, mode: 'exclusive' })))
    expect(local.locks.held.size).toBe(0)
  })

  it('releases a failed publisher lock so the queued store can recover and publish', async () => {
    const local = storageFixture()
    const entered = deferred()
    const proceed = deferred()
    const failure = new Error('Source interrupted')
    const first = local.store().cacheBlobFromChunks(workspaceId, contentHash, content.byteLength, async () => {
      entered.resolve()
      await proceed.promise
      throw failure
    })
    const firstResult = expect(first).rejects.toBe(failure)
    let secondResult: Promise<void> | undefined
    try {
      await entered.promise
      secondResult = expect(local.store().cacheBlobFromChunks(workspaceId, contentHash, content.byteLength, local.read)).resolves.toBe(true)
      await local.locks.waitForRequests(2)
      expect(local.read).not.toHaveBeenCalled()
    } finally {
      proceed.resolve()
      await Promise.all([firstResult, secondResult])
    }
    expect(local.abort).toHaveBeenCalledTimes(1)
    expect(local.create).toHaveBeenCalledTimes(2)
    expect(local.files.get(contentHash)).toEqual(content)
    expect(local.journal.intents.size).toBe(0)
    expect(local.locks.held.size).toBe(0)
  })

  it('allows another Workspace to progress while this Workspace is locked', async () => {
    const local = storageFixture()
    const entered = deferred()
    const proceed = deferred()
    const held = local.locks.request(`dsh-workspace-local-${workspaceId}`, { mode: 'exclusive' }, async () => {
      entered.resolve()
      await proceed.promise
    })
    try {
      await entered.promise
      await expect(local.store().save({ ...cleanSnapshot, workspaceId: otherWorkspaceId })).resolves.toBeUndefined()
      expect(local.records.get(otherWorkspaceId)).toEqual({ ...cleanSnapshot, workspaceId: otherWorkspaceId })
    } finally {
      proceed.resolve()
      await held
    }
  })

  it.each(['load', 'save', 'clear', 'cacheBlob', 'cacheBlobFromRanges', 'cacheBlobFromChunks', 'openBlob', 'reconcileBlobs'] as const)(
    'queues %s behind the shared exclusive Workspace lock', async operation => {
      const local = storageFixture()
      local.files.set(contentHash, content)
      const store = local.store()
      if (operation === 'save') {
        await store.load(workspaceId)
        local.trace.length = 0
        local.locks.requests.length = 0
      }
      const entered = deferred()
      const proceed = deferred()
      const held = local.locks.request(`dsh-workspace-local-${workspaceId}`, { mode: 'exclusive' }, async () => {
        entered.resolve()
        await proceed.promise
      })
      let pending: Promise<void> | undefined
      try {
        await entered.promise
        const run = async (): Promise<void> => {
          switch (operation) {
            case 'load': await store.load(workspaceId); return
            case 'save': await store.save(cleanSnapshot); return
            case 'clear': await store.clear(workspaceId); return
            case 'cacheBlob': await store.cacheBlob(workspaceId, contentHash, content); return
            case 'cacheBlobFromRanges': await store.cacheBlobFromRanges(workspaceId, contentHash, content.byteLength,
              (offset, length) => content.slice(offset, offset + length)); return
            case 'cacheBlobFromChunks': await store.cacheBlobFromChunks(workspaceId, contentHash, content.byteLength, local.read); return
            case 'openBlob': (await store.openBlob(workspaceId, contentHash, content.byteLength))?.close(); return
            case 'reconcileBlobs': await store.reconcileBlobs(workspaceId, [contentHash]); return
          }
        }
        pending = run()
        await local.locks.waitForRequests(2)
        expect(local.trace).toEqual([])
        expect(local.create).not.toHaveBeenCalled()
        expect(local.remove).not.toHaveBeenCalled()
      } finally {
        proceed.resolve()
        await Promise.all([held, pending])
      }
      expect(local.locks.requests[1]).toEqual({ name: `dsh-workspace-local-${workspaceId}`, mode: 'exclusive' })
      expect(local.locks.held.size).toBe(0)
    },
  )
})

describe('Workspace snapshot compare-and-swap', () => {
  it.each(['pending', 'retryBatch'] as const)('rejects stale saves after another store persists %s at the same revision', async owner => {
    const local = storageFixture()
    const first = local.store()
    const second = local.store()
    const stale = await first.load(workspaceId)
    await expect(second.load(workspaceId)).resolves.toEqual(cleanSnapshot)
    const bytes = new Uint8Array([1, 2, 3])
    const change: WorkspaceChange = { path: 'draft.bin', kind: 'file', mode: 0o600, bytes: bytes.byteLength, content: bytes }
    const latest = snapshotWithChanges(owner, [change])
    await second.save(latest)
    const stored = structuredClone(local.records.get(workspaceId))
    expect(stored).toMatchObject({ version: 1, workspaceId, revision: cleanSnapshot.revision })

    await expect(first.save(stale!)).rejects.toMatchObject({ code: 'LOCAL_SNAPSHOT_CONFLICT' })
    expect(local.records.get(workspaceId)).toEqual(stored)
    expect(local.files.get(hash(bytes))).toEqual(bytes)
    await expect(local.store().load(workspaceId)).resolves.toEqual(latest)
    expect(local.locks.held.size).toBe(0)
  })

  it('requires an initial load before saving an existing snapshot', async () => {
    const local = storageFixture()
    await expect(local.store().save(cleanSnapshot)).rejects.toMatchObject({ code: 'LOCAL_SNAPSHOT_CONFLICT' })
    expect(local.records.get(workspaceId)).toEqual(cleanSnapshot)
    expect(local.create).not.toHaveBeenCalled()
  })

  it('allows first creation without a load and observes each successful own save', async () => {
    const local = storageFixture({ missingMetadata: true })
    const store = local.store()
    await expect(store.save(cleanSnapshot)).resolves.toBeUndefined()
    const next = { ...cleanSnapshot, revision: 5 }
    await expect(store.save(next)).resolves.toBeUndefined()
    await expect(store.save({ ...next, revision: 6 })).resolves.toBeUndefined()
    expect(local.records.get(workspaceId)).toEqual({ ...next, revision: 6 })
  })

  it('requires a reload after conflict before preserving and updating another store changes', async () => {
    const local = storageFixture()
    const first = local.store()
    const second = local.store()
    await first.load(workspaceId)
    await second.load(workspaceId)
    await second.save({ ...cleanSnapshot, revision: 5 })
    await expect(first.save(cleanSnapshot)).rejects.toMatchObject({ code: 'LOCAL_SNAPSHOT_CONFLICT' })
    const current = await first.load(workspaceId)
    await expect(first.save({ ...current!, revision: 6 })).resolves.toBeUndefined()
    expect(local.records.get(workspaceId)).toEqual({ ...cleanSnapshot, revision: 6 })
  })

  it('keeps the previous observation when a metadata transaction aborts', async () => {
    const local = storageFixture()
    let shouldAbort = true
    const store = local.store({ abortNextMetadataTransaction: () => {
      const abort = shouldAbort
      shouldAbort = false
      return abort
    } })
    await store.load(workspaceId)
    await expect(store.save({ ...cleanSnapshot, revision: 5 })).rejects.toMatchObject({ name: 'AbortError' })
    expect(local.records.get(workspaceId)).toEqual(cleanSnapshot)
    await expect(store.save({ ...cleanSnapshot, revision: 6 })).resolves.toBeUndefined()
    expect(local.records.get(workspaceId)).toEqual({ ...cleanSnapshot, revision: 6 })
  })

  it('does not authorize a save when loading pending bytes failed verification', async () => {
    const metadata = { ...cleanSnapshot, pending: [{ path: 'draft.bin', kind: 'file', mode: 0o600,
      bytes: content.byteLength, contentHash }] }
    const local = storageFixture({ metadata })
    const store = local.store()
    await expect(store.load(workspaceId)).rejects.toMatchObject({ code: 'LOCAL_BLOB_MISSING' })
    await expect(store.save(cleanSnapshot)).rejects.toMatchObject({ code: 'LOCAL_SNAPSHOT_CONFLICT' })
    expect(local.records.get(workspaceId)).toEqual(metadata)
  })

  it('forgets the previous observation after clearing and permits a new first save', async () => {
    const local = storageFixture()
    const store = local.store()
    await store.load(workspaceId)
    await store.clear(workspaceId)
    await expect(store.save({ ...cleanSnapshot, revision: 0 })).resolves.toBeUndefined()
    expect(local.records.get(workspaceId)).toEqual({ ...cleanSnapshot, revision: 0 })
  })
})

describe('external content verification before snapshot publication', () => {
  it.each(['pending', 'retryBatch'] as const)('rejects %s references collected after range caching', async owner => {
    const local = storageFixture()
    const writer = local.store()
    const collector = local.store()
    await writer.load(workspaceId)
    await collector.load(workspaceId)
    const bytes = new Uint8Array([3, 4, 5])
    const digest = hash(bytes)
    await writer.cacheBlobFromRanges(workspaceId, digest, bytes.byteLength, (offset, length) => bytes.slice(offset, offset + length))
    expect(local.files.get(digest)).toEqual(bytes)
    await expect(collector.reconcileBlobs(workspaceId, [])).resolves.toEqual({ removedFiles: 1, removedBytes: bytes.byteLength, retainedFiles: 0 })
    const snapshot = snapshotWithChanges(owner, [{ path: 'external.bin', kind: 'file', mode: 0o600,
      bytes: bytes.byteLength, contentReference: { hash: digest, bytes: bytes.byteLength } }])

    await expect(writer.save(snapshot)).rejects.toMatchObject({ code: 'LOCAL_BLOB_MISSING' })
    expect(local.records.get(workspaceId)).toEqual(cleanSnapshot)
    expect(local.files.has(digest)).toBe(false)
    await expect(local.store().load(workspaceId)).resolves.toEqual(cleanSnapshot)
    expect(local.locks.held.size).toBe(0)
  })

  it.each([
    ['pending', 'size', 'LOCAL_BLOB_SIZE_MISMATCH'],
    ['pending', 'hash', 'LOCAL_BLOB_CORRUPT'],
    ['retryBatch', 'size', 'LOCAL_BLOB_SIZE_MISMATCH'],
    ['retryBatch', 'hash', 'LOCAL_BLOB_CORRUPT'],
  ] as const)('rejects %s external references with invalid %s before writing metadata', async (owner, fault, code) => {
    const local = storageFixture()
    const store = local.store()
    await store.load(workspaceId)
    const bytes = new Uint8Array([1, 2, 3])
    const digest = hash(bytes)
    const damaged = fault === 'size' ? bytes.slice(0, 1) : new Uint8Array(bytes.byteLength)
    local.files.set(digest, damaged)
    const snapshot = snapshotWithChanges(owner, [{ path: 'external.bin', kind: 'file', mode: 0o600,
      bytes: bytes.byteLength, contentReference: { hash: digest, bytes: bytes.byteLength } }])

    await expect(store.save(snapshot)).rejects.toMatchObject({ code })
    expect(local.records.get(workspaceId)).toEqual(cleanSnapshot)
    expect(local.files.get(digest)).toEqual(damaged)
    expect(local.remove).not.toHaveBeenCalled()
    expect(local.locks.held.size).toBe(0)
  })

  it.each(['pending', 'retryBatch'] as const)('persists verified %s content references without changing their stored fields', async owner => {
    const local = storageFixture()
    const store = local.store()
    await store.load(workspaceId)
    const bytes = new Uint8Array([1, 2, 3])
    const digest = hash(bytes)
    await store.cacheBlobFromRanges(workspaceId, digest, bytes.byteLength, (offset, length) => bytes.slice(offset, offset + length))
    const snapshot = snapshotWithChanges(owner, [{ path: 'external.bin', kind: 'file', mode: 0o600,
      bytes: bytes.byteLength, contentReference: { hash: digest, bytes: bytes.byteLength } }])
    await expect(store.save(snapshot)).resolves.toBeUndefined()
    const storedChange = { path: 'external.bin', kind: 'file', mode: 0o600, bytes: bytes.byteLength,
      contentHash: digest, externalContent: true }
    expect(local.records.get(workspaceId)).toEqual(owner === 'pending' ? { ...cleanSnapshot, pending: [storedChange] } : {
      ...cleanSnapshot, retryBatch: { operationId: 'retry-operation', baseRevision: 4, changes: [storedChange] },
    })
    await expect(local.store().load(workspaceId)).resolves.toEqual(snapshot)
  })
})

describe('snapshot encoding holds the Workspace lock to completion', () => {
  it.each(['pending', 'retryBatch'] as const)('settles the first %s encoding before a later quota failure releases the lock', async owner => {
    const local = storageFixture()
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (_algorithm, data) => {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)
      return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer
    })
    const entered = deferred()
    const proceed = deferred()
    const events: string[] = []
    let quotaChecks = 0
    const store = local.store({ quotaNextOpfsWrite: () => {
      quotaChecks += 1
      events.push(`quota:${quotaChecks}`)
      return quotaChecks === 2
    } })
    await store.load(workspaceId)
    local.write.mockImplementationOnce(async () => {
      entered.resolve()
      await proceed.promise
      events.push('first:written')
    })
    local.close.mockImplementationOnce(() => { events.push('first:closed') })
    const first = new Uint8Array([1, 2, 3])
    const second = new Uint8Array([4, 5, 6])
    const snapshot = snapshotWithChanges(owner, [
      { path: 'first.bin', kind: 'file', mode: 0o600, bytes: first.byteLength, content: first },
      { path: 'second.bin', kind: 'file', mode: 0o600, bytes: second.byteLength, content: second },
    ])
    let saveSettled = false
    const saving = store.save(snapshot).finally(() => {
      saveSettled = true
      events.push('save:settled')
    })
    const saved = expect(saving).rejects.toMatchObject({ name: 'QuotaExceededError' })
    let collected: Promise<void> | undefined
    let collectorEntered = false
    try {
      await entered.promise
      const requests = local.locks.requests.length
      collected = local.locks.request(`dsh-workspace-local-${workspaceId}`, { mode: 'exclusive' }, async () => {
        collectorEntered = true
        events.push('collector:entered')
      })
      await local.locks.waitForRequests(requests + 1)
      expect(quotaChecks).toBe(1)
      expect(saveSettled).toBe(false)
      expect(collectorEntered).toBe(false)
      expect(local.locks.held.has(`dsh-workspace-local-${workspaceId}`)).toBe(true)
      expect(local.records.get(workspaceId)).toEqual(cleanSnapshot)
    } finally {
      proceed.resolve()
      await Promise.all([saved, collected])
    }
    expect(events.slice(0, 4)).toEqual(['quota:1', 'first:written', 'first:closed', 'quota:2'])
    expect(events.indexOf('collector:entered')).toBeGreaterThan(events.indexOf('quota:2'))
    expect(events.indexOf('save:settled')).toBeGreaterThan(events.indexOf('quota:2'))
    expect(local.records.get(workspaceId)).toEqual(cleanSnapshot)
    expect(local.files.get(hash(first))).toEqual(first)
    expect(local.files.get(hash(second))).toEqual(new Uint8Array(0))
    expect(local.write).toHaveBeenCalledTimes(1)
    expect(local.locks.held.size).toBe(0)
  })
})
