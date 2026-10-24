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

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('durable Browser-Native Workspace state', () => {
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
