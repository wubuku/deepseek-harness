import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBrowserNativeWorkspaceRuntime,
} from '../browser-native-workspace.ts'
import {
  MemoryDurableWorkspaceStore,
} from '../browser-native-workspace-store.ts'

const workspaceId = '7cb327fe-f71a-4d54-ac91-17f0ab4fb163'
const remoteBytes = new TextEncoder().encode('remote value')
const remoteHash = createHash('sha256').update(remoteBytes).digest('hex')

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubRemoteManifest(revision: number, entries: readonly Record<string, unknown>[] = []): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
    if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision, entries })
    if (url.includes('/blob/') && url.includes(remoteHash)) return new Response(remoteBytes)
    throw new Error(`unexpected request ${url}`)
  }))
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
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 2, entries: [] })
      if (url.includes('/blob/') && method === 'PUT') return jsonResponse({ ok: true })
      if (url.endsWith('/commit')) {
        const body = JSON.parse(String(init?.body)) as { operationId: string; baseRevision: number }
        commits.push(body)
        return jsonResponse({ error: { code: 'TEMPORARY', message: 'commit unavailable' } }, 503)
      }
      throw new Error(`unexpected request ${method} ${url}`)
    }))

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
})
