import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserNativeWorkspaceRuntime } from '../browser-native-workspace.ts'
import { MemoryDurableWorkspaceStore } from '../browser-native-workspace-store.ts'
import { CONTENT_UPLOAD_PARAMETERS, requireContentUploadCapability } from '../browser-native-content-upload.ts'
import { createWorkspaceBlobProtocolMock } from './workspace-blob-protocol-mock.ts'

const workspaceId = '7cb327fe-f71a-4d54-ac91-17f0ab4fb163'
const root = '/dsh/home/workspace'

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function syntheticBytes(length: number): Uint8Array {
  let state = 0x12345678
  return Uint8Array.from({ length }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state >>> 24
  })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('content-defined Workspace client', () => {
  it('rejects unsupported capability parameters before opening identity or mutating storage', async () => {
    for (const capability of [{}, { contentLayout: { ...CONTENT_UPLOAD_PARAMETERS, maxChunks: 2048, version: 2 } },
      { contentLayout: { ...CONTENT_UPLOAD_PARAMETERS, maxChunks: 32 } }]) {
      expect(() => requireContentUploadCapability(capability)).toThrow(/capability/)
    }
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return json({ error: { code: 'NOT_FOUND', message: 'old backend' } }, 404)
    }))
    const runtime = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true })
    await expect(runtime.prepareVfs(runtime.vfs)).rejects.toThrow('old backend')
    expect(calls).toEqual(['/api/browser-native/workspace/upload-capabilities'])
  })

  it('uploads shifted ranges and preserves the same plan and operation after a lost reuse response', async () => {
    const protocol = createWorkspaceBlobProtocolMock()
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = []
    const entries: Array<{ path: string; kind: string; hash: string; bytes: number; mode: number }> = []
    let revision = 0
    let loseReuse = true
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input)
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      requests.push({ path, body })
      const transfer = protocol.respond(input, init)
      if (path.endsWith('/reuse') && loseReuse) {
        loseReuse = false
        throw new TypeError('simulated lost reuse response')
      }
      if (transfer !== undefined) return transfer
      if (path.endsWith('/identity')) return json({ workspaceId })
      if (path.includes('/manifest?')) return json({ workspaceId, revision, entries })
      if (path.endsWith('/commit') && body !== undefined) {
        const changes = body.changes as Array<{ path: string; hash: string; bytes: number; mode: number }>
        for (const change of changes) {
          const bytes = protocol.completedBlobs.get(change.hash)
          if (bytes === undefined) throw new Error('commit before complete blob upload')
          protocol.registerBlob(change.hash, bytes)
          entries.splice(0, entries.length, { ...change, kind: 'file' })
        }
        revision += 1
        return json({ workspaceId, operationId: body.operationId, baseRevision: body.baseRevision,
          revision, manifestDigest: 'digest', paths: changes.map(change => change.path), replayed: false })
      }
      throw new Error(`unexpected request ${path}`)
    }))
    const store = new MemoryDurableWorkspaceStore()
    const runtime = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true, store, onStatus: () => {} })
    runtime.vfs.seedDirectory(root)
    await runtime.prepareVfs(runtime.vfs)
    const source = syntheticBytes(4 * 1024 * 1024)
    runtime.vfs.writeFileSync(`${root}/data.bin`, source)
    await runtime.flushWorkspace()
    const target = new Uint8Array(source.byteLength + 64 * 1024)
    target.set(source.subarray(0, 2 * 1024 * 1024))
    target.fill(0xa5, 2 * 1024 * 1024, 2 * 1024 * 1024 + 64 * 1024)
    target.set(source.subarray(2 * 1024 * 1024), 2 * 1024 * 1024 + 64 * 1024)
    runtime.vfs.writeFileSync(`${root}/data.bin`, target)
    await expect(runtime.flushWorkspace()).rejects.toThrow(/lost reuse response/)
    expect(revision).toBe(1)
    const pending = await store.load(workspaceId)
    expect(pending?.retryBatch?.operationId).toBeDefined()
    const incompatible = createBrowserNativeWorkspaceRuntime({ store, onStatus: () => {} })
    incompatible.vfs.seedDirectory(root)
    await incompatible.prepareVfs(incompatible.vfs)
    await expect(incompatible.flushWorkspace()).rejects.toThrow('upload id was reused with different metadata')
    expect(revision).toBe(1)
    expect((await store.load(workspaceId))?.retryBatch?.operationId).toBe(pending?.retryBatch?.operationId)
    const uploadsBeforeRetry = protocol.readonlyUploads.length
    const recovered = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true, store, onStatus: () => {} })
    recovered.vfs.seedDirectory(root)
    await recovered.prepareVfs(recovered.vfs)
    await recovered.flushWorkspace()
    expect(revision).toBe(2)
    const targetHash = createHash('sha256').update(target).digest('hex')
    expect(protocol.completedBlobs.get(targetHash)).toEqual(target)
    const uploadedBytes = protocol.readonlyUploads.slice(uploadsBeforeRetry).reduce((total, chunk) => total + chunk.bytes.byteLength, 0)
    expect(uploadedBytes).toBeLessThan(target.byteLength / 2)
    expect(requests.filter(request => request.path.endsWith('/reuse'))).toHaveLength(1)
    const starts = requests.filter(request => request.path.endsWith('/start') && request.body?.hash === targetHash
      && request.body.layout !== undefined)
    expect(starts.length).toBeGreaterThanOrEqual(2)
    expect(new Set(starts.map(request => request.body?.operationId))).toEqual(new Set([pending?.retryBatch?.operationId]))
    expect(starts[0]?.body?.layout).toEqual(starts[1]?.body?.layout)
    expect(await recovered.vfs.readFileSync(`${root}/data.bin`)).toEqual(target)
  })

  it('rejects duplicate or out-of-range missing indexes before sending any bytes', async () => {
    for (const missing of [[0, 0], [999_999], [-1]]) {
      const protocol = createWorkspaceBlobProtocolMock()
      let puts = 0
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        if (init?.method === 'PUT') puts += 1
        if (/\/blob-upload\/[0-9a-f-]+$/.test(path.split('?')[0] ?? '') && init?.method === undefined) {
          return json({ complete: false, missing })
        }
        const transfer = protocol.respond(input, init)
        if (transfer !== undefined) return transfer
        if (path.endsWith('/identity')) return json({ workspaceId })
        if (path.includes('/manifest?')) return json({ workspaceId, revision: 0, entries: [] })
        throw new Error(`unexpected request ${path}`)
      }))
      const runtime = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true, onStatus: () => {} })
      runtime.vfs.seedDirectory(root)
      await runtime.prepareVfs(runtime.vfs)
      runtime.vfs.writeFileSync(`${root}/test.txt`, 'bounded upload')
      await expect(runtime.flushWorkspace()).rejects.toThrow(/invalid blob upload status/)
      expect(puts).toBe(0)
    }
  })
})
