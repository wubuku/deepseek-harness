import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBrowserNativeWorkspaceRuntime,
} from '../browser-native-workspace.ts'
import {
  MemoryDurableWorkspaceStore,
} from '../browser-native-workspace-store.ts'
import { DurableWorkspaceStoreError } from '../browser-native-workspace-store.ts'
import { createWorkspaceBlobProtocolMock } from './workspace-blob-protocol-mock.ts'

const workspaceId = '7cb327fe-f71a-4d54-ac91-17f0ab4fb163'
const remoteBytes = new TextEncoder().encode('remote value')
const remoteHash = createHash('sha256').update(remoteBytes).digest('hex')

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubWorkspaceFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  const protocol = createWorkspaceBlobProtocolMock()
  protocol.registerBlob(remoteHash, remoteBytes)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const transferResponse = protocol.respond(input, init)
    if (transferResponse !== undefined) return transferResponse
    return await handler(input, init)
  }))
}

function stubRemoteManifest(revision: number, entries: readonly Record<string, unknown>[] = []): void {
  stubWorkspaceFetch(async input => {
    const url = String(input)
    if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
    if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision, entries })
    throw new Error(`unexpected request ${url}`)
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('durable Browser-Native Workspace state', () => {
  it('acquires local write access before recovering the snapshot', async () => {
    const store = new MemoryDurableWorkspaceStore()
    const acquired = deferred()
    const proceed = deferred()
    const acquire = vi.spyOn(store, 'acquireWriter').mockImplementation(async () => {
      acquired.resolve()
      await proceed.promise
    })
    const load = vi.spyOn(store, 'load')
    const invalidated = vi.spyOn(store, 'invalidateWriter')
    stubRemoteManifest(0)
    const runtime = createBrowserNativeWorkspaceRuntime({ store, onStatus: () => {} })
    const preparing = runtime.prepareVfs(runtime.vfs)
    const prepared = expect(preparing).resolves.toBeUndefined()
    try {
      await acquired.promise
      expect(acquire).toHaveBeenCalledExactlyOnceWith(workspaceId, undefined)
      expect(load).not.toHaveBeenCalled()
    } finally {
      proceed.resolve()
      await prepared
    }
    expect(load).toHaveBeenCalledExactlyOnceWith(workspaceId)
    expect(invalidated).not.toHaveBeenCalled()
  })

  it.each(['ensureWriterLease', 'authorizeFileTool', 'verifyFileToolRevision', 'flushLocalWorkspace', 'runToolOperation'] as const)(
    'invalidates a stale mirror when %s loses local write access', async entry => {
      const store = new MemoryDurableWorkspaceStore()
      const snapshot = { version: 1 as const, workspaceId, revision: 4, pending: [] }
      await store.save(snapshot)
      stubRemoteManifest(4)
      const statuses: string[] = []
      const runtime = createBrowserNativeWorkspaceRuntime({ store, onStatus: status => { statuses.push(status) } })
      await runtime.prepareVfs(runtime.vfs)
      const failure = new DurableWorkspaceStoreError('LOCAL_WRITER_LOST', 'local writer was superseded')
      const assert = vi.spyOn(store, 'assertWriter').mockRejectedValue(failure)
      const invalidate = vi.spyOn(store, 'invalidateWriter')
      const save = vi.spyOn(store, 'save')
      const run = vi.fn(async () => {})
      const entries = {
        ensureWriterLease: () => runtime.ensureWriterLease(),
        authorizeFileTool: () => runtime.authorizeFileTool('read'),
        verifyFileToolRevision: () => runtime.verifyFileToolRevision(undefined),
        flushLocalWorkspace: () => runtime.flushLocalWorkspace(),
        runToolOperation: () => runtime.runToolOperation({ sessionId: 'stale-session', turn: 1, step: 1,
          callId: 'stale-call', toolName: 'write', toolCallSeq: 1 }, run),
      }

      await expect(entries[entry]()).rejects.toBe(failure)
      expect(assert).toHaveBeenCalledExactlyOnceWith(workspaceId)
      expect(invalidate).toHaveBeenCalledExactlyOnceWith(workspaceId)
      expect(() => runtime.assertLocalWorkspaceUsable()).toThrow(/local writer was invalidated/)
      await expect(runtime.ensureWriterLease()).rejects.toThrow(/local writer was invalidated/)
      expect(assert).toHaveBeenCalledTimes(1)
      expect(run).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(statuses.at(-1)).toBe('error')
      expect(statuses).not.toContain('local-corrupt')
      await expect(store.load(workspaceId)).resolves.toEqual(snapshot)
      expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/commit'))).toBe(false)
    },
  )

  it('invalidates before a queued local save resumes after release', async () => {
    vi.useFakeTimers()
    const store = new MemoryDurableWorkspaceStore()
    const snapshot = { version: 1 as const, workspaceId, revision: 4, pending: [] }
    await store.save(snapshot)
    stubRemoteManifest(4)
    const entered = deferred()
    const proceed = deferred()
    const statuses: string[] = []
    const runtime = createBrowserNativeWorkspaceRuntime({ store, onStatus: status => { statuses.push(status) },
      testHooks: { beforeLocalPersist: async () => {
        entered.resolve()
        await proceed.promise
      } } })
    await runtime.prepareVfs(runtime.vfs)
    const save = vi.spyOn(store, 'save')
    const invalidate = vi.spyOn(store, 'invalidateWriter')
    runtime.vfs.writeFileSync('/dsh/home/workspace/queued.txt', 'queued local change')
    try {
      await entered.promise
      expect(save).not.toHaveBeenCalled()
      await runtime.releaseWriter()
      expect(invalidate).toHaveBeenCalledExactlyOnceWith(workspaceId)
      expect(save).not.toHaveBeenCalled()
    } finally {
      proceed.resolve()
      await expect(runtime.flushWorkspace()).rejects.toThrow(/local writer was invalidated/)
    }
    expect(save).not.toHaveBeenCalled()
    await expect(store.load(workspaceId)).resolves.toEqual(snapshot)
    expect(runtime.vfs.readFileSync('/dsh/home/workspace/queued.txt', 'utf8')).toBe('queued local change')
    expect(() => runtime.assertLocalWorkspaceUsable()).toThrow(/local writer was invalidated/)
    expect(statuses.at(-1)).toBe('error')
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/commit'))).toBe(false)
  })

  it('rejects a tool operation when its in-flight local writer check completes after release', async () => {
    vi.useFakeTimers()
    const store = new MemoryDurableWorkspaceStore()
    const snapshot = { version: 1 as const, workspaceId, revision: 4, pending: [] }
    await store.save(snapshot)
    stubRemoteManifest(4)
    const runtime = createBrowserNativeWorkspaceRuntime({ store, onStatus: () => {} })
    await runtime.prepareVfs(runtime.vfs)
    const entered = deferred()
    const proceed = deferred()
    const assert = vi.spyOn(store, 'assertWriter').mockImplementationOnce(async () => {
      entered.resolve()
      await proceed.promise
    })
    const invalidate = vi.spyOn(store, 'invalidateWriter')
    const save = vi.spyOn(store, 'save')
    const run = vi.fn(async () => {})
    const operation = runtime.runToolOperation({ sessionId: 'released-session', turn: 1, step: 1,
      callId: 'released-call', toolName: 'write', toolCallSeq: 1 }, run)
    const rejected = expect(operation).rejects.toThrow(/local writer was invalidated/)

    try {
      await entered.promise
      expect(assert).toHaveBeenCalledExactlyOnceWith(workspaceId)
      expect(run).not.toHaveBeenCalled()
      await runtime.releaseWriter()
      expect(invalidate).toHaveBeenCalledExactlyOnceWith(workspaceId)
      expect(run).not.toHaveBeenCalled()
    } finally {
      proceed.resolve()
      await rejected
    }
    expect(run).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    await expect(store.load(workspaceId)).resolves.toEqual(snapshot)
    expect(() => runtime.assertLocalWorkspaceUsable()).toThrow(/local writer was invalidated/)
  })

  it('persists local changes after a failed renewal while the writer lease remains valid', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const store = new MemoryDurableWorkspaceStore()
    let offline = false
    stubWorkspaceFetch(async input => {
      if (offline) throw new TypeError('Failed to fetch: offline')
      const url = String(input)
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 0, entries: [] })
      if (url.endsWith('/lease')) return jsonResponse({
        writerToken: 'writer', fencingToken: 1, leaseDurationMs: 60_000, renewAfterMs: 1_000,
      })
      throw new Error(`unexpected request ${url}`)
    })
    const runtime = createBrowserNativeWorkspaceRuntime({ store, writerLease: true, onStatus: () => {} })

    try {
      await runtime.prepareVfs(runtime.vfs)
      await runtime.authorizeFileTool('write')
      const requestsBeforeRenewal = vi.mocked(fetch).mock.calls.length
      offline = true
      await vi.advanceTimersByTimeAsync(1_500)
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(requestsBeforeRenewal + 1)
      expect(runtime.getWriterLeaseTestState()).toMatchObject({ state: 'active', deadlineRemainingMs: 58_500 })
      const requestsBeforePersist = vi.mocked(fetch).mock.calls.length
      const content = new TextEncoder().encode('offline local change')
      runtime.vfs.writeFileSync('/dsh/home/workspace/offline.txt', content)

      await expect(runtime.flushLocalWorkspace()).resolves.toBeUndefined()

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(requestsBeforePersist)
      await expect(store.load(workspaceId)).resolves.toMatchObject({
        workspaceId, revision: 0, pending: [{ path: 'offline.txt', bytes: content.byteLength, content }],
      })
      expect(() => runtime.assertLocalWorkspaceUsable()).not.toThrow()
    } finally {
      offline = false
      await runtime.releaseWriter()
      vi.clearAllTimers()
    }
  })

  it('registers clean remote metadata before caching the first downloaded blob', async () => {
    const store = new MemoryDurableWorkspaceStore()
    const load = store.load.bind(store)
    const cache = store.cacheBlob.bind(store)
    vi.spyOn(store, 'load').mockImplementation(async workspace => {
      const snapshot = await load(workspace)
      if (snapshot === undefined && (await store.listWorkspaceIds()).includes(workspace)) {
        throw new DurableWorkspaceStoreError('LOCAL_METADATA_MISSING', 'local OPFS blobs exist without IndexedDB metadata')
      }
      return snapshot
    })
    vi.spyOn(store, 'cacheBlob').mockImplementation(async (workspace, hash, bytes) => {
      expect(await load(workspace)).toMatchObject({ revision: 9, pending: [] })
      await cache(workspace, hash, bytes)
    })
    stubRemoteManifest(9, [{ path: 'restored.txt', kind: 'file', hash: remoteHash, bytes: remoteBytes.byteLength, mode: 0o600 }])
    const runtime = createBrowserNativeWorkspaceRuntime({ store, onStatus: () => {} })
    await runtime.prepareVfs(runtime.vfs)
    expect(runtime.vfs.readFileSync('/dsh/home/workspace/restored.txt')).toEqual(remoteBytes)
    expect(await load(workspaceId)).toMatchObject({ revision: 9, pending: [] })
    const resumed = createBrowserNativeWorkspaceRuntime({ store, onStatus: () => {} })
    await resumed.prepareVfs(resumed.vfs)
    expect(resumed.vfs.readFileSync('/dsh/home/workspace/restored.txt')).toEqual(remoteBytes)
    expect(await resumed.flushWorkspace()).toEqual([])
    expect(store.cacheBlob).toHaveBeenCalledTimes(1)
  })

  it('does not download remote bytes when clean metadata registration fails', async () => {
    const store = new MemoryDurableWorkspaceStore()
    vi.spyOn(store, 'save').mockRejectedValue(new DOMException('metadata transaction aborted', 'AbortError'))
    const cache = vi.spyOn(store, 'cacheBlob')
    const streamed = vi.spyOn(store, 'cacheBlobFromChunks')
    stubRemoteManifest(9, [{ path: 'restored.txt', kind: 'file', hash: remoteHash, bytes: remoteBytes.byteLength, mode: 0o600 }])
    const runtime = createBrowserNativeWorkspaceRuntime({ store, onStatus: () => {} })
    await expect(runtime.prepareVfs(runtime.vfs)).rejects.toThrow('metadata transaction aborted')
    expect(cache).not.toHaveBeenCalled()
    expect(streamed).not.toHaveBeenCalled()
    expect(runtime.vfs.existsSync('/dsh/home/workspace/restored.txt')).toBe(false)
  })

  it('round-trips pending bytes and clones content', async () => {
    const store = new MemoryDurableWorkspaceStore()
    const content = new Uint8Array([1, 2, 3])
    await store.save({
      version: 1,
      workspaceId,
      revision: 4,
      pending: [{ path: 'notes/new.bin', kind: 'file', mode: 0o600, bytes: content.byteLength, content }],
    })
    content[0] = 9

    const restored = await store.load(workspaceId)
    expect(restored?.pending[0]).toMatchObject({ path: 'notes/new.bin', bytes: 3 })
    expect(restored?.pending[0]?.content).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('enumerates Workspace IDs from metadata and content-only remnants', async () => {
    const store = new MemoryDurableWorkspaceStore()
    const orphanWorkspaceId = 'a91d2bd5-e225-4d04-9a29-b49fb324ff11'
    await store.save({ version: 1, workspaceId, revision: 0, pending: [] })
    await store.cacheBlob(orphanWorkspaceId, remoteHash, remoteBytes)

    await expect(store.listWorkspaceIds()).resolves.toEqual([orphanWorkspaceId, workspaceId].sort())
  })

  it('does not create a new identity when local Workspace data remains but the identity cookie is unavailable', async () => {
    const store = new MemoryDurableWorkspaceStore()
    await store.save({
      version: 1,
      workspaceId,
      revision: 2,
      pending: [{ path: 'draft.txt', kind: 'file', mode: 0o600, bytes: 5, content: new TextEncoder().encode('draft') }],
    })
    const requests: Array<{ readonly url: string; readonly headers?: HeadersInit }> = []
    const statuses: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      requests.push({ url, headers: init?.headers })
      if (url.endsWith('/identity')) return jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'identity missing' } }, 401)
      throw new Error(`unexpected request ${url}`)
    }))

    const runtime = createBrowserNativeWorkspaceRuntime({ store, onStatus: status => { statuses.push(status) } })
    await expect(runtime.prepareVfs(runtime.vfs)).rejects.toThrow('cannot be matched')

    expect(requests).toHaveLength(1)
    expect(new Headers(requests[0]?.headers).get('x-browser-native-identity-mode')).toBe('existing')
    expect(requests.some(request => request.url.includes('/manifest?'))).toBe(false)
    expect(runtime.getWorkspaceId()).toBeUndefined()
    expect(statuses).toContain('identity-missing')
    await expect(store.load(workspaceId)).resolves.toMatchObject({ revision: 2, pending: [{ path: 'draft.txt' }] })
  })

  it('stops when the current browser identity does not match retained Workspace data', async () => {
    const store = new MemoryDurableWorkspaceStore()
    await store.save({ version: 1, workspaceId, revision: 0, pending: [] })
    const statuses: string[] = []
    stubWorkspaceFetch(async input => {
      if (String(input).endsWith('/identity')) return jsonResponse({ workspaceId: 'a91d2bd5-e225-4d04-9a29-b49fb324ff11' })
      throw new Error(`unexpected request ${String(input)}`)
    })
    const runtime = createBrowserNativeWorkspaceRuntime({ store, onStatus: status => { statuses.push(status) } })

    await expect(runtime.prepareVfs(runtime.vfs)).rejects.toThrow('different browser identity')

    expect(statuses).toContain('identity-mismatch')
    expect(runtime.getWorkspaceId()).toBeUndefined()
  })

  it('replays local pending content over the remote manifest after Worker reconstruction', async () => {
    vi.useFakeTimers()
    const store = new MemoryDurableWorkspaceStore()
    stubRemoteManifest(3, [{ path: 'notes', kind: 'directory', mode: 0o755 }, {
      path: 'notes/today.txt', kind: 'file', hash: remoteHash, bytes: remoteBytes.byteLength, mode: 0o600,
    }])
    await store.save({
      version: 1,
      workspaceId,
      revision: 3,
      pending: [{
        path: 'notes/today.txt',
        kind: 'file',
        mode: 0o600,
        bytes: 12,
        content: new TextEncoder().encode('local value'),
      }],
    })

    const runtime = createBrowserNativeWorkspaceRuntime({ store })
    await runtime.prepareVfs(runtime.vfs)

    expect(runtime.vfs.readFileSync('/dsh/home/workspace/notes/today.txt', 'utf8')).toBe('local value')
    expect((await store.load(workspaceId))?.pending).toHaveLength(1)
  })

  it('keeps one operation id and retry content after a failed commit and reconstruction', async () => {
    vi.useFakeTimers()
    const store = new MemoryDurableWorkspaceStore()
    const commits: Array<{ operationId: string; baseRevision: number }> = []
    stubWorkspaceFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 2, entries: [] })
      if (url.endsWith('/commit')) {
        const body = JSON.parse(String(init?.body)) as { operationId: string; baseRevision: number }
        commits.push(body)
        return jsonResponse({ error: { code: 'TEMPORARY', message: 'commit unavailable' } }, 503)
      }
      throw new Error(`unexpected request ${method} ${url}`)
    })

    const first = createBrowserNativeWorkspaceRuntime({ store })
    await first.prepareVfs(first.vfs)
    first.vfs.writeFileSync('/dsh/home/workspace/retry.txt', 'retry me')
    await expect(first.flushWorkspace()).rejects.toThrow('commit unavailable')

    const persisted = await store.load(workspaceId)
    expect(persisted?.retryBatch?.operationId).toBe(commits[0]?.operationId)
    expect(persisted?.retryBatch?.baseRevision).toBe(2)

    const second = createBrowserNativeWorkspaceRuntime({ store })
    await second.prepareVfs(second.vfs)
    expect(second.vfs.readFileSync('/dsh/home/workspace/retry.txt', 'utf8')).toBe('retry me')
    expect((await store.load(workspaceId))?.retryBatch?.operationId).toBe(commits[0]?.operationId)
  })

  it('does not treat an empty remote workspace as clean when a local snapshot is dirty', async () => {
    vi.useFakeTimers()
    const store = new MemoryDurableWorkspaceStore()
    stubRemoteManifest(8)
    await store.save({
      version: 1,
      workspaceId,
      revision: 8,
      pending: [{ path: 'draft.txt', kind: 'file', mode: 0o600, bytes: 5, content: new TextEncoder().encode('draft') }],
    })
    const statuses: string[] = []
    const runtime = createBrowserNativeWorkspaceRuntime({
      store,
      onStatus: status => { statuses.push(status) },
    })
    await runtime.prepareVfs(runtime.vfs)
    expect(runtime.vfs.readFileSync('/dsh/home/workspace/draft.txt', 'utf8')).toBe('draft')
    expect(statuses).toContain('dirty')
  })

  it('publishes a durable receipt instead of only returning a successful flush', async () => {
    vi.useFakeTimers()
    const store = new MemoryDurableWorkspaceStore()
    const requests: string[] = []
    stubWorkspaceFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push(`${method} ${url}`)
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 0, entries: [] })
      if (url.endsWith('/commit')) {
        const body = JSON.parse(String(init?.body)) as { operationId: string; baseRevision: number; changes: Array<{ path: string }> }
        return jsonResponse({
          workspaceId,
          revision: 1,
          operationId: body.operationId,
          changedPaths: body.changes.map(change => change.path),
          digest: 'a'.repeat(64),
          replayed: false,
        })
      }
      throw new Error(`unexpected request ${method} ${url}`)
    })

    const runtime = createBrowserNativeWorkspaceRuntime({ store })
    await runtime.prepareVfs(runtime.vfs)
    runtime.vfs.writeFileSync('/dsh/home/workspace/receipt.txt', 'receipt')
    const receipts = await runtime.flushWorkspace()

    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      workspaceId,
      baseRevision: 0,
      revision: 1,
      manifestDigest: 'a'.repeat(64),
      paths: ['receipt.txt'],
      replayed: false,
    })
    expect(requests.some(request => request.startsWith('POST /api/browser-native/workspace/commit'))).toBe(true)
  })

  it('keeps the DSH tool-call link in the durable retry batch and receipt outbox', async () => {
    vi.useFakeTimers()
    const store = new MemoryDurableWorkspaceStore()
    const operation = {
      sessionId: 'session-linked-receipt',
      turn: 2,
      step: 1,
      callId: 'tool-call-linked-receipt',
      toolName: 'write',
      toolCallSeq: 7,
    }
    const commits: Array<{ operationId: string; baseRevision: number }> = []
    let failFirstCommit = true
    stubWorkspaceFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 0, entries: [] })
      if (url.endsWith('/commit')) {
        const body = JSON.parse(String(init?.body)) as { operationId: string; baseRevision: number; changes: Array<{ path: string }> }
        commits.push({ operationId: body.operationId, baseRevision: body.baseRevision })
        if (failFirstCommit) {
          failFirstCommit = false
          return jsonResponse({ error: { code: 'TEMPORARY', message: 'commit response unavailable' } }, 503)
        }
        return jsonResponse({
          workspaceId,
          revision: body.baseRevision + 1,
          operationId: body.operationId,
          changedPaths: body.changes.map(change => change.path),
          digest: 'b'.repeat(64),
          replayed: true,
        })
      }
      if (url.includes('/operation/')) return jsonResponse({ found: false })
      throw new Error(`unexpected request ${method} ${url}`)
    })

    const first = createBrowserNativeWorkspaceRuntime({ store })
    await first.prepareVfs(first.vfs)
    await first.runToolOperation(operation, async () => {
      first.vfs.writeFileSync('/dsh/home/workspace/linked.txt', 'linked receipt')
    })
    await expect(first.flushWorkspace()).rejects.toThrow('commit response unavailable')
    const interrupted = await store.load(workspaceId)
    expect(interrupted?.retryBatch?.operation).toEqual(operation)
    const operationId = interrupted?.retryBatch?.operationId
    expect(typeof operationId).toBe('string')

    const second = createBrowserNativeWorkspaceRuntime({ store })
    await second.prepareVfs(second.vfs)
    const receipts = await second.flushWorkspace()
    expect(commits.map(commit => commit.operationId)).toEqual([operationId, operationId])
    expect(receipts[0]).toMatchObject({ operationId, operation, replayed: true })
    expect(second.pendingReceipts(operation.sessionId)).toEqual([receipts[0]])
    expect((await store.load(workspaceId))?.receipts).toEqual([receipts[0]])

    await second.acknowledgeReceipt(operationId as string)
    expect((await store.load(workspaceId))?.receipts).toBeUndefined()
  })

  it('does not publish synced when the local durable snapshot is corrupt', async () => {
    const statuses: string[] = []
    stubRemoteManifest(0)
    const store = {
      acquireWriter: async () => {},
      assertWriter: async () => {},
      invalidateWriter: () => {},
      listWorkspaceIds: async () => [],
      load: async () => {
        throw new DurableWorkspaceStoreError('LOCAL_BLOB_MISSING', 'browser-native workspace: local blob is missing (test)')
      },
      save: async () => {},
      clear: async () => {},
    }
    const runtime = createBrowserNativeWorkspaceRuntime({
      store,
      onStatus: status => { statuses.push(status) },
    })

    await expect(runtime.prepareVfs(runtime.vfs)).rejects.toMatchObject({ code: 'LOCAL_BLOB_MISSING' })
    expect(statuses).toContain('local-corrupt')
    expect(statuses).not.toContain('synced')
  })

  it('does not claim local durability when the metadata transaction aborts', async () => {
    const statuses: string[] = []
    stubRemoteManifest(0)
    const store = {
      acquireWriter: async () => {},
      assertWriter: async () => {},
      invalidateWriter: () => {},
      listWorkspaceIds: async () => [],
      load: async () => undefined,
      save: async () => {
        throw new DurableWorkspaceStoreError('LOCAL_STORE_UNAVAILABLE', 'browser-native workspace: IndexedDB transaction aborted')
      },
      clear: async () => {},
    }
    const runtime = createBrowserNativeWorkspaceRuntime({
      store,
      onStatus: status => { statuses.push(status) },
    })
    await runtime.prepareVfs(runtime.vfs)
    runtime.vfs.writeFileSync('/dsh/home/workspace/aborted.txt', 'not durable')

    await expect(runtime.flushLocalWorkspace()).rejects.toThrow('IndexedDB transaction aborted')
    expect(() => runtime.assertLocalWorkspaceUsable()).toThrow(/local Workspace persistence is unresolved/)
    expect(statuses).toContain('error')
    expect(statuses.at(-1)).toBe('error')
  })

  it('rejects Agent Workspace access until an in-flight local snapshot commits', async () => {
    stubRemoteManifest(0)
    let completeSave: () => void = () => { throw new Error('save was not started') }
    const pendingSave = new Promise<void>(resolve => { completeSave = resolve })
    const store = {
      acquireWriter: async () => {},
      assertWriter: async () => {},
      invalidateWriter: () => {},
      listWorkspaceIds: async () => [],
      load: async () => undefined,
      save: async () => await pendingSave,
      clear: async () => {},
    }
    const runtime = createBrowserNativeWorkspaceRuntime({ store })
    await runtime.prepareVfs(runtime.vfs)
    runtime.vfs.writeFileSync('/dsh/home/workspace/pending.txt', 'pending')

    expect(() => runtime.assertLocalWorkspaceUsable()).toThrow(/local Workspace persistence is unresolved/)
    completeSave()
    await runtime.flushLocalWorkspace()
    expect(() => runtime.assertLocalWorkspaceUsable()).not.toThrow()
  })

  it('waits for snapshots queued while a local durability wait is in flight', async () => {
    vi.useFakeTimers()
    stubRemoteManifest(0)
    let releaseFirstSave: () => void = () => { throw new Error('first save was not started') }
    let notifyFirstSaveStarted: () => void = () => { throw new Error('first save start was not observed') }
    const firstSave = new Promise<void>(resolve => { releaseFirstSave = resolve })
    const firstSaveStarted = new Promise<void>(resolve => { notifyFirstSaveStarted = resolve })
    const snapshots: Array<{ pending: readonly { path: string }[] }> = []
    const store = {
      acquireWriter: async () => {},
      assertWriter: async () => {},
      invalidateWriter: () => {},
      listWorkspaceIds: async () => [],
      load: async () => undefined,
      save: async (snapshot: { pending: readonly { path: string }[] }) => {
        snapshots.push(snapshot)
        if (snapshots.length === 1) {
          notifyFirstSaveStarted()
          await firstSave
        }
      },
      clear: async () => {},
    }
    const runtime = createBrowserNativeWorkspaceRuntime({ store })
    await runtime.prepareVfs(runtime.vfs)
    runtime.vfs.writeFileSync('/dsh/home/workspace/first.txt', 'first')
    const flush = runtime.flushLocalWorkspace()
    await firstSaveStarted
    runtime.vfs.writeFileSync('/dsh/home/workspace/second.txt', 'second')
    releaseFirstSave()

    await expect(flush).resolves.toBeUndefined()
    expect(snapshots).toHaveLength(2)
    expect(snapshots.at(-1)?.pending.map(change => change.path).sort()).toEqual(['first.txt', 'second.txt'])
  })

  it('coalesces a burst of Workspace mutations into one latest durable snapshot', async () => {
    stubRemoteManifest(0)
    const snapshots: Array<{ pending: readonly { path: string }[] }> = []
    const store = {
      acquireWriter: async () => {},
      assertWriter: async () => {},
      invalidateWriter: () => {},
      listWorkspaceIds: async () => [],
      load: async () => undefined,
      save: async (snapshot: { pending: readonly { path: string }[] }) => { snapshots.push(snapshot) },
      clear: async () => {},
    }
    const runtime = createBrowserNativeWorkspaceRuntime({ store })
    await runtime.prepareVfs(runtime.vfs)
    for (let index = 0; index < 1_000; index += 1) {
      runtime.vfs.writeFileSync(`/dsh/home/workspace/burst-${String(index).padStart(4, '0')}.txt`, 'small file')
    }

    await runtime.flushLocalWorkspace()

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.pending).toHaveLength(1_000)
    expect(snapshots[0]?.pending[0]?.path).toBe('burst-0000.txt')
    expect(snapshots[0]?.pending.at(-1)?.path).toBe('burst-0999.txt')
  })

  it('rejects Agent Workspace access after local persistence fails', async () => {
    stubRemoteManifest(0)
    const store = {
      acquireWriter: async () => {},
      assertWriter: async () => {},
      invalidateWriter: () => {},
      listWorkspaceIds: async () => [],
      load: async () => undefined,
      save: async () => {
        throw new DurableWorkspaceStoreError('LOCAL_STORE_UNAVAILABLE', 'browser-native workspace: IndexedDB transaction aborted')
      },
      clear: async () => {},
    }
    const runtime = createBrowserNativeWorkspaceRuntime({ store })
    await runtime.prepareVfs(runtime.vfs)
    runtime.vfs.writeFileSync('/dsh/home/workspace/volatile.txt', 'not durable')

    await expect(runtime.flushLocalWorkspace()).rejects.toThrow('IndexedDB transaction aborted')
    expect(() => runtime.assertLocalWorkspaceUsable()).toThrow(/local Workspace persistence is unresolved/)
  })
})
