import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserNativeWorkspaceRuntime } from '../browser-native-workspace.ts'
import { MemoryDurableWorkspaceStore } from '../browser-native-workspace-store.ts'
import { createWorkspaceBlobProtocolMock } from './workspace-blob-protocol-mock.ts'

const workspaceId = '7cb327fe-f71a-4d54-ac91-17f0ab4fb163'
const manifestBytes = new TextEncoder().encode('restored from cloud\n')
const manifestHash = createHash('sha256').update(manifestBytes).digest('hex')

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubWorkspaceFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  protocol = createWorkspaceBlobProtocolMock(),
  beforeChunk?: (bytes: Uint8Array, index: number, hash: string) => Response | undefined,
): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const transferResponse = protocol.respond(input, init, beforeChunk)
    if (transferResponse !== undefined) return transferResponse
    return await handler(input, init)
  }))
}

afterEach(() => { vi.unstubAllGlobals() })

describe('browser-native Workspace VFS sync', () => {
  it('hydrates a lease-conflict observer from committed blobs without reading or changing local pending state', async () => {
    const store = new MemoryDurableWorkspaceStore()
    const localContent = new TextEncoder().encode('local pending bytes')
    const originalSnapshot = {
      version: 1 as const,
      workspaceId,
      revision: 6,
      pending: [{ path: 'local-pending.txt', content: localContent }],
      retryBatch: {
        operationId: 'pending-operation',
        baseRevision: 6,
        changes: [{ path: 'retry-only.txt', content: localContent }],
      },
    }
    await store.save(originalSnapshot)
    const loadSnapshot = store.load.bind(store)
    const snapshotBefore = await loadSnapshot(workspaceId)
    const loadSpy = vi.spyOn(store, 'load')
    const blobSpy = vi.spyOn(store, 'openBlob')
    const cacheSpy = vi.spyOn(store, 'cacheBlob')
    const reconcileSpy = vi.spyOn(store, 'reconcileBlobs')
    const protocol = createWorkspaceBlobProtocolMock()
    protocol.registerBlob(manifestHash, manifestBytes)
    const requests: string[] = []
    let remoteRevision = 7
    const accessModes: string[] = []
    const statuses: string[] = []
    stubWorkspaceFetch(async input => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.endsWith('/lease')) return jsonResponse({
        error: { code: 'WORKSPACE_ALREADY_OWNED', message: 'owned', retryAfterMs: 1000 },
      }, 409)
      if (url.includes('/manifest?')) return jsonResponse({
        workspaceId,
        revision: remoteRevision,
        entries: [{ path: 'committed.txt', kind: 'file', hash: manifestHash, bytes: manifestBytes.byteLength, mode: 0o600 }],
      })
      if (url.includes('/revision?')) return jsonResponse({ workspaceId, revision: remoteRevision })
      throw new Error(`unexpected request ${url}`)
    }, protocol)

    const runtime = createBrowserNativeWorkspaceRuntime({
      store,
      writerLease: true,
      onAccessMode: mode => { accessModes.push(mode) },
      onStatus: state => { statuses.push(state) },
    })
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    await runtime.prepareVfs(runtime.vfs)

    expect(runtime.getAccessMode()).toBe('observer')
    expect(runtime.getRevision()).toBe(7)
    expect(runtime.vfs.readFileSync('/dsh/home/workspace/committed.txt', 'utf8')).toBe('restored from cloud\n')
    expect(runtime.vfs.existsSync('/dsh/home/workspace/local-pending.txt')).toBe(false)
    expect(runtime.vfs.existsSync('/dsh/home/workspace/retry-only.txt')).toBe(false)
    expect(loadSpy).not.toHaveBeenCalled()
    expect(blobSpy).not.toHaveBeenCalled()
    expect(cacheSpy).not.toHaveBeenCalled()
    expect(reconcileSpy).not.toHaveBeenCalled()
    expect(await loadSnapshot(workspaceId)).toEqual(snapshotBefore)
    expect(accessModes).toEqual(['observer'])
    expect(statuses).toContain('read-only')

    const statusCount = statuses.length
    const requestCount = requests.length
    expect(await runtime.flushWorkspace()).toEqual([])
    expect(statuses).toHaveLength(statusCount)
    expect(requests).toHaveLength(requestCount)

    const authorizedRevision = await runtime.authorizeFileTool('read')
    expect(authorizedRevision).toBe(7)
    await runtime.verifyFileToolRevision(authorizedRevision)
    await expect(runtime.authorizeFileTool('write')).rejects.toThrow('observer cannot execute')
    expect(requests.filter(url => url.includes('/manifest?'))).toHaveLength(1)
    expect(requests.filter(url => url.includes('/revision?'))).toHaveLength(2)

    remoteRevision = 8
    await expect(runtime.authorizeFileTool('glob')).rejects.toThrow('snapshot is stale')
    expect(runtime.getAccessMode()).toBe('stale')
    expect(accessModes).toEqual(['observer', 'stale'])
    expect(statuses).toContain('stale')
    const revisionChecks = requests.filter(url => url.includes('/revision?')).length
    const staleStatusCount = statuses.length
    expect(await runtime.flushWorkspace()).toEqual([])
    expect(statuses).toHaveLength(staleStatusCount)
    await expect(runtime.authorizeFileTool('read')).rejects.toThrow('snapshot is stale')
    expect(requests.filter(url => url.includes('/revision?'))).toHaveLength(revisionChecks)
    await expect(runtime.ensureWriterLease()).rejects.toThrow('cannot acquire writer access')
  })

  it('does not downgrade identity, transport, or unrelated lease failures to an observer', async () => {
    const requests: string[] = []
    stubWorkspaceFetch(async input => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.endsWith('/lease')) return jsonResponse({
        error: { code: 'WORKSPACE_OWNERSHIP_LOST', message: 'owner token was rejected' },
      }, 409)
      throw new Error(`unexpected request ${url}`)
    })
    const runtime = createBrowserNativeWorkspaceRuntime({ writerLease: true })
    runtime.vfs.seedDirectory('/dsh/home/workspace')

    await expect(runtime.prepareVfs(runtime.vfs)).rejects.toThrow('owner token was rejected')
    expect(requests.some(url => url.includes('/manifest?'))).toBe(false)
    expect(runtime.getAccessMode()).toBe('writer')
  })

  it('marks an observer stale when the remote revision changes during a file tool', async () => {
    let remoteRevision = 4
    const requests: string[] = []
    stubWorkspaceFetch(async input => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.endsWith('/lease')) return jsonResponse({
        error: { code: 'WORKSPACE_ALREADY_OWNED', message: 'owned', retryAfterMs: 1_000 },
      }, 409)
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 4, entries: [] })
      if (url.includes('/revision?')) return jsonResponse({ workspaceId, revision: remoteRevision })
      throw new Error(`unexpected request ${url}`)
    })
    const accessModes: string[] = []
    const runtime = createBrowserNativeWorkspaceRuntime({
      writerLease: true,
      onAccessMode: mode => { accessModes.push(mode) },
    })
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    await runtime.prepareVfs(runtime.vfs)

    const authorizedRevision = await runtime.authorizeFileTool('read')
    expect(authorizedRevision).toBe(4)
    runtime.vfs.seed('/dsh/home/workspace/read-during-race.txt', 'old snapshot secret')
    remoteRevision = 5
    await expect(runtime.verifyFileToolRevision(authorizedRevision)).rejects.toThrow('snapshot is stale')
    expect(runtime.getAccessMode()).toBe('stale')
    expect(accessModes).toEqual(['observer', 'stale'])
    expect(requests.filter(url => url.includes('/revision?'))).toHaveLength(2)
    await expect(runtime.authorizeFileTool('read')).rejects.toThrow('snapshot is stale')
    expect(requests.filter(url => url.includes('/revision?'))).toHaveLength(2)
  })

  it('rejects observer file output if the completion revision check fails', async () => {
    let revisionChecks = 0
    stubWorkspaceFetch(async input => {
      const url = String(input)
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.endsWith('/lease')) return jsonResponse({
        error: { code: 'WORKSPACE_ALREADY_OWNED', message: 'owned', retryAfterMs: 1_000 },
      }, 409)
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 4, entries: [] })
      if (url.includes('/revision?')) {
        revisionChecks += 1
        return revisionChecks === 1
          ? jsonResponse({ workspaceId, revision: 4 })
          : jsonResponse({ error: { code: 'TEMPORARY', message: 'revision unavailable' } }, 503)
      }
      throw new Error(`unexpected request ${url}`)
    })
    const runtime = createBrowserNativeWorkspaceRuntime({ writerLease: true })
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    await runtime.prepareVfs(runtime.vfs)

    const authorizedRevision = await runtime.authorizeFileTool('read')
    await expect(runtime.verifyFileToolRevision(authorizedRevision)).rejects.toThrow('revision unavailable')
    expect(runtime.getAccessMode()).toBe('observer')
  })

  it('rejects a delayed observer result after another concurrent check marks the snapshot stale', async () => {
    let revisionChecks = 0
    let releaseDelayedCheck: () => void = () => {}
    const delayedCheck = new Promise<void>(resolve => { releaseDelayedCheck = resolve })
    stubWorkspaceFetch(async input => {
      const url = String(input)
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.endsWith('/lease')) return jsonResponse({
        error: { code: 'WORKSPACE_ALREADY_OWNED', message: 'owned', retryAfterMs: 1_000 },
      }, 409)
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 4, entries: [] })
      if (url.includes('/revision?')) {
        revisionChecks += 1
        if (revisionChecks <= 2) return jsonResponse({ workspaceId, revision: 4 })
        if (revisionChecks === 3) {
          await delayedCheck
          return jsonResponse({ workspaceId, revision: 4 })
        }
        return jsonResponse({ workspaceId, revision: 5 })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const runtime = createBrowserNativeWorkspaceRuntime({ writerLease: true })
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    await runtime.prepareVfs(runtime.vfs)

    const earlierRevision = await runtime.authorizeFileTool('read')
    const laterRevision = await runtime.authorizeFileTool('grep')
    const earlierCompletion = runtime.verifyFileToolRevision(earlierRevision)
    await expect(runtime.verifyFileToolRevision(laterRevision)).rejects.toThrow('snapshot is stale')
    releaseDelayedCheck()
    await expect(earlierCompletion).rejects.toThrow('snapshot is stale')
    expect(runtime.getAccessMode()).toBe('stale')
    expect(revisionChecks).toBe(4)
  })

  it('rejects a delayed observer preflight after another check marks the snapshot stale', async () => {
    let revisionChecks = 0
    let releaseDelayedCheck: () => void = () => {}
    const delayedCheck = new Promise<void>(resolve => { releaseDelayedCheck = resolve })
    stubWorkspaceFetch(async input => {
      const url = String(input)
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.endsWith('/lease')) return jsonResponse({
        error: { code: 'WORKSPACE_ALREADY_OWNED', message: 'owned', retryAfterMs: 1_000 },
      }, 409)
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 4, entries: [] })
      if (url.includes('/revision?')) {
        revisionChecks += 1
        if (revisionChecks === 1) {
          await delayedCheck
          return jsonResponse({ workspaceId, revision: 4 })
        }
        return jsonResponse({ workspaceId, revision: 5 })
      }
      throw new Error(`unexpected request ${url}`)
    })
    const runtime = createBrowserNativeWorkspaceRuntime({ writerLease: true })
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    await runtime.prepareVfs(runtime.vfs)

    const earlierPreflight = runtime.authorizeFileTool('read')
    await expect(runtime.authorizeFileTool('grep')).rejects.toThrow('snapshot is stale')
    releaseDelayedCheck()
    await expect(earlierPreflight).rejects.toThrow('snapshot is stale')
    expect(runtime.getAccessMode()).toBe('stale')
    expect(revisionChecks).toBe(2)
  })

  it('restores before runtime writes, uploads changed content, and commits a revision', async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = []
    const protocol = createWorkspaceBlobProtocolMock()
    protocol.registerBlob(manifestHash, manifestBytes)
    stubWorkspaceFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ url, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) {
        return jsonResponse({
          workspaceId,
          revision: 4,
          digest: 'not-used-by-the-client',
          entries: [
            { path: 'notes', kind: 'directory', mode: 0o700 },
            { path: 'notes/old.txt', kind: 'file', hash: manifestHash, bytes: manifestBytes.byteLength, mode: 0o600 },
          ],
        })
      }
      if (url.endsWith('/commit')) return jsonResponse({ workspaceId, revision: 5, operationId: JSON.parse(String(init?.body)).operationId })
      throw new Error(`unexpected request ${method} ${url}`)
    }, protocol)

    const runtime = createBrowserNativeWorkspaceRuntime()
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    runtime.vfs.seed('/dsh/home/workspace/stale-default.txt', 'remove base-image data')
    await runtime.prepareVfs(runtime.vfs)
    expect(runtime.vfs.existsSync('/dsh/home/workspace/stale-default.txt')).toBe(false)
    expect(runtime.vfs.readFileSync('/dsh/home/workspace/notes/old.txt', 'utf8')).toBe('restored from cloud\n')

    runtime.vfs.writeFileSync('/dsh/home/workspace/notes/new.txt', 'created by the worker')
    await vi.waitFor(() => {
      expect(requests.some(request => request.url.endsWith('/commit'))).toBe(true)
    })
    const commit = requests.find(request => request.url.endsWith('/commit'))
    const payload = JSON.parse(commit?.body ?? '{}') as { baseRevision: number; changes: Array<{ path: string; hash: string }> }
    expect(payload.baseRevision).toBe(4)
    expect(payload.changes).toMatchObject([{ path: 'notes/new.txt', hash: expect.any(String) }])
    expect(requests.find(request => request.url.includes('/manifest?'))?.method).toBe('GET')
  })

  it('retains a stable operation id after an ambiguous commit failure and does not claim durability', async () => {
    const commits: Array<{ operationId: string; baseRevision: number }> = []
    let failCommit = true
    stubWorkspaceFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 2, entries: [], digest: '' })
      if (url.endsWith('/commit')) {
        const body = JSON.parse(String(init?.body)) as { operationId: string; baseRevision: number }
        commits.push(body)
        if (failCommit) return jsonResponse({ error: { code: 'TEMPORARY', message: 'commit response unavailable' } }, 503)
        return jsonResponse({ workspaceId, revision: 3, operationId: body.operationId })
      }
      throw new Error(`unexpected request ${method} ${url}`)
    })

    const runtime = createBrowserNativeWorkspaceRuntime()
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    await runtime.prepareVfs(runtime.vfs)
    runtime.vfs.writeFileSync('/dsh/home/workspace/retry.txt', 'same operation')
    await vi.waitFor(() => { expect(commits).toHaveLength(1) })
    await expect(runtime.flushWorkspace()).rejects.toThrow('commit response unavailable')
    expect(commits).toHaveLength(2)
    expect(commits[1]).toMatchObject({ operationId: commits[0]?.operationId, baseRevision: commits[0]?.baseRevision })
    failCommit = false
    await runtime.flushWorkspace()
    expect(commits).toHaveLength(3)
    expect(commits[2]).toMatchObject({ operationId: commits[0]?.operationId, baseRevision: commits[0]?.baseRevision })
  })

  it('does not auto-rebase a stale writer after a CAS conflict', async () => {
    const commits: unknown[] = []
    stubWorkspaceFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 8, entries: [], digest: '' })
      if (url.endsWith('/commit')) {
        commits.push(JSON.parse(String(init?.body)))
        return jsonResponse({
          error: { code: 'WORKSPACE_CONFLICT', message: 'workspace revision changed', details: { current: { revision: 9 } } },
        }, 409)
      }
      throw new Error(`unexpected request ${method} ${url}`)
    })
    const runtime = createBrowserNativeWorkspaceRuntime()
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    await runtime.prepareVfs(runtime.vfs)
    runtime.vfs.writeFileSync('/dsh/home/workspace/conflict.txt', 'keep locally')
    await vi.waitFor(() => { expect(commits).toHaveLength(1) })
    expect(runtime.vfs.readFileSync('/dsh/home/workspace/conflict.txt', 'utf8')).toBe('keep locally')
    await expect(runtime.flushWorkspace()).rejects.toThrow('workspace revision changed')
    expect(commits).toHaveLength(1)
  })

  it('uploads identical content only once per synchronization batch', async () => {
    let committed = false
    const protocol = createWorkspaceBlobProtocolMock()
    stubWorkspaceFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 0, entries: [], digest: '' })
      if (url.endsWith('/commit')) {
        committed = true
        const body = JSON.parse(String(init?.body)) as { changes: Array<{ path: string; hash: string }> }
        expect(body.changes.map(change => change.path)).toEqual(['first.txt', 'second.txt'])
        expect(body.changes[0]?.hash).toBe(body.changes[1]?.hash)
        return jsonResponse({ workspaceId, revision: 1 })
      }
      throw new Error(`unexpected request ${method} ${url}`)
    }, protocol)
    const runtime = createBrowserNativeWorkspaceRuntime()
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    await runtime.prepareVfs(runtime.vfs)
    runtime.vfs.writeFileSync('/dsh/home/workspace/first.txt', 'same bytes')
    runtime.vfs.writeFileSync('/dsh/home/workspace/second.txt', 'same bytes')
    await vi.waitFor(() => { expect(committed).toBe(true) })
    expect(protocol.readonlyUploads).toHaveLength(1)
  })

  it('uploads and restores an external reference without a content field', async () => {
    const store = new MemoryDurableWorkspaceStore()
    const protocol = createWorkspaceBlobProtocolMock()
    const source = new TextEncoder().encode('before\n' + 'x'.repeat(4096) + '\n')
    const target = new TextEncoder().encode('after\n' + 'x'.repeat(4096) + '\n')
    const hash = createHash('sha256').update(target).digest('hex')
    let manifest: { revision: number; entries: Array<Record<string, unknown>> } = { revision: 0, entries: [] }
    const commits: Array<Record<string, unknown>> = []
    stubWorkspaceFetch(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, ...manifest, digest: '' })
      if (url.endsWith('/commit')) {
        const body = JSON.parse(String(init?.body)) as { changes: Array<Record<string, unknown>> }
        commits.push(body)
        manifest = { revision: 1, entries: body.changes }
        return jsonResponse({ workspaceId, revision: 1 })
      }
      throw new Error(`unexpected request ${url}`)
    }, protocol)

    const runtime = createBrowserNativeWorkspaceRuntime({ store })
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    await runtime.prepareVfs(runtime.vfs)
    runtime.vfs.seedExternal('/dsh/home/workspace/reference.txt', {
      size: source.byteLength,
      read: (position, length) => source.subarray(position, position + length),
      close: () => {},
    })
    await runtime.runToolOperation({
      sessionId: 'session-reference', turn: 1, step: 1, callId: 'call-reference', toolName: 'browser_edit_ref', toolCallSeq: 1,
    }, async () => {
      runtime.vfs.replaceExternalSync('/dsh/home/workspace/reference.txt', {
        size: target.byteLength,
        read: (position, length) => target.subarray(position, position + length),
        close: () => {},
      }, { hash, bytes: target.byteLength })
    })
    await runtime.flushLocalWorkspace()
    const receipts = await runtime.flushWorkspace()
    protocol.registerBlob(hash, target)

    expect(receipts).toHaveLength(1)
    expect(commits).toHaveLength(1)
    expect(commits[0]?.changes).toEqual([{
      path: 'reference.txt', kind: 'file', hash, bytes: target.byteLength, mode: 0o644,
    }])
    expect(JSON.stringify(commits[0])).not.toContain('after')
    const cached = await store.openBlob(workspaceId, hash, target.byteLength)
    expect(cached?.read(0, 6)).toEqual(target.subarray(0, 6))
    cached?.close()

    const restored = createBrowserNativeWorkspaceRuntime({ store })
    restored.vfs.seedDirectory('/dsh/home/workspace')
    await restored.prepareVfs(restored.vfs)
    expect(restored.vfs.usage().residentBytes).toBe(0)
    expect(restored.vfs.readFileRangeSync('/dsh/home/workspace/reference.txt', 0, 6)).toEqual(target.subarray(0, 6))
    restored.vfs.close()
  })

  it('synchronizes append, rename, remove, chmod, empty, binary, and Unicode paths', async () => {
    const removedBytes = new TextEncoder().encode('remove from cloud')
    const removedHash = createHash('sha256').update(removedBytes).digest('hex')
    const protocol = createWorkspaceBlobProtocolMock()
    protocol.registerBlob(removedHash, removedBytes)
    let committed: { baseRevision: number; changes: Array<Record<string, unknown>> } | undefined
    stubWorkspaceFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) {
        return jsonResponse({
          workspaceId,
          revision: 3,
          entries: [
            { path: 'remove.txt', kind: 'file', hash: removedHash, bytes: removedBytes.byteLength, mode: 0o640 },
          ],
        })
      }
      if (url.endsWith('/commit')) {
        committed = JSON.parse(String(init?.body)) as typeof committed
        return jsonResponse({ workspaceId, revision: 4 })
      }
      throw new Error(`unexpected request ${method} ${url}`)
    }, protocol)

    const runtime = createBrowserNativeWorkspaceRuntime()
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    await runtime.prepareVfs(runtime.vfs)
    runtime.vfs.rmSync('/dsh/home/workspace/remove.txt')
    runtime.vfs.mkdirSync('/dsh/home/workspace/folder', { mode: 0o700 })
    runtime.vfs.mkdirSync('/dsh/home/workspace/目录')
    runtime.vfs.chmodSync('/dsh/home/workspace/目录', 0o750)
    runtime.vfs.writeFileSync('/dsh/home/workspace/folder/append.txt', 'alpha\n')
    runtime.vfs.appendFileSync('/dsh/home/workspace/folder/append.txt', 'beta\n')
    runtime.vfs.chmodSync('/dsh/home/workspace/folder/append.txt', 0o640)
    runtime.vfs.renameSync('/dsh/home/workspace/folder/append.txt', '/dsh/home/workspace/目录/合并.txt')
    runtime.vfs.writeFileSync('/dsh/home/workspace/empty.bin', new Uint8Array(), { mode: 0o600 })
    runtime.vfs.writeFileSync('/dsh/home/workspace/binary.dat', new Uint8Array([0, 255, 1, 128]), { mode: 0o600 })
    runtime.vfs.appendFileSync('/dsh/home/workspace/binary.dat', new Uint8Array([254]))
    runtime.vfs.writeFileSync('/dsh/home/workspace/transient.txt', 'discard before sync')
    runtime.vfs.rmSync('/dsh/home/workspace/transient.txt')

    await runtime.flushWorkspace()

    expect(committed?.baseRevision).toBe(3)
    const changes = new Map((committed?.changes ?? []).map(change => [change.path, change]))
    expect([...changes.keys()].sort()).toEqual([
      'binary.dat',
      'empty.bin',
      'folder',
      'remove.txt',
      '目录',
      '目录/合并.txt',
    ].sort())
    expect(changes.get('folder')).toMatchObject({ kind: 'directory', mode: 0o700 })
    expect(changes.get('目录')).toMatchObject({ kind: 'directory', mode: 0o750 })
    expect(changes.get('remove.txt')).toMatchObject({ deleted: true })
    expect(changes.get('empty.bin')).toMatchObject({ kind: 'file', bytes: 0, mode: 0o600 })
    expect(changes.get('binary.dat')).toMatchObject({ kind: 'file', bytes: 5, mode: 0o600 })
    expect(changes.get('目录/合并.txt')).toMatchObject({ kind: 'file', bytes: 11, mode: 0o640 })

    const emptyHash = changes.get('empty.bin')?.hash as string
    const binaryHash = changes.get('binary.dat')?.hash as string
    const renamedHash = changes.get('目录/合并.txt')?.hash as string
    expect(protocol.completedBlobs.get(emptyHash)).toEqual(new Uint8Array())
    expect(protocol.completedBlobs.get(binaryHash)).toEqual(new Uint8Array([0, 255, 1, 128, 254]))
    expect(protocol.completedBlobs.get(renamedHash)).toEqual(new TextEncoder().encode('alpha\nbeta\n'))
  })

  it('preserves a deletion recorded while the same file is being committed', async () => {
    const commits: Array<{ baseRevision: number; changes: Array<Record<string, unknown>> }> = []
    let releaseCommit: (() => void) | undefined
    const firstCommit = new Promise<void>(resolve => { releaseCommit = resolve })
    stubWorkspaceFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 0, entries: [] })
      if (url.endsWith('/commit')) {
        commits.push(JSON.parse(String(init?.body)) as typeof commits[number])
        const revision = commits.length
        if (revision === 1) await firstCommit
        return jsonResponse({ workspaceId, revision })
      }
      throw new Error(`unexpected request ${method} ${url}`)
    })
    const runtime = createBrowserNativeWorkspaceRuntime()
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    await runtime.prepareVfs(runtime.vfs)
    runtime.vfs.writeFileSync('/dsh/home/workspace/in-flight.txt', 'remove while commit waits')
    const flushed = runtime.flushWorkspace()
    try {
      await vi.waitFor(() => { expect(commits).toHaveLength(1) })
      runtime.vfs.rmSync('/dsh/home/workspace/in-flight.txt')
    } finally {
      releaseCommit?.()
      await flushed
    }
    expect(commits).toHaveLength(2)
    expect(commits[1]).toMatchObject({
      baseRevision: 1,
      changes: [{ path: 'in-flight.txt', deleted: true }],
    })
  })

  it('does not restore removed descendants when a directory is recreated before synchronization', async () => {
    let changes: Array<Record<string, unknown>> = []
    const protocol = createWorkspaceBlobProtocolMock()
    protocol.registerBlob(manifestHash, manifestBytes)
    stubWorkspaceFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 1, entries: [
        { path: 'folder', kind: 'directory', mode: 0o755 },
        { path: 'folder/old.txt', kind: 'file', hash: manifestHash, bytes: manifestBytes.byteLength, mode: 0o600 },
      ] })
      if (url.endsWith('/commit')) {
        changes = (JSON.parse(String(init?.body)) as { changes: typeof changes }).changes
        return jsonResponse({ workspaceId, revision: 2 })
      }
      throw new Error(`unexpected request ${method} ${url}`)
    }, protocol)
    const runtime = createBrowserNativeWorkspaceRuntime()
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    await runtime.prepareVfs(runtime.vfs)
    runtime.vfs.rmSync('/dsh/home/workspace/folder', { recursive: true })
    runtime.vfs.mkdirSync('/dsh/home/workspace/folder')
    await runtime.flushWorkspace()
    expect(changes).toEqual([
      { path: 'folder', kind: 'directory', mode: 0o755 },
      { path: 'folder/old.txt', deleted: true },
    ])
  })

  it('retries a failed blob upload without losing newer local content', async () => {
    let failUpload = true
    let uploadAttempts = 0
    const contents: string[] = []
    const commits: Array<{ baseRevision: number; operationId: string; changes: Array<{ hash: string }> }> = []
    const protocol = createWorkspaceBlobProtocolMock()
    stubWorkspaceFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 0, entries: [] })
      if (url.endsWith('/commit')) {
        commits.push(JSON.parse(String(init?.body)) as typeof commits[number])
        return jsonResponse({ workspaceId, revision: commits.length })
      }
      throw new Error(`unexpected request ${method} ${url}`)
    }, protocol, bytes => {
      uploadAttempts += 1
      if (failUpload) return jsonResponse({ error: { code: 'UPLOAD_FAILED', message: 'upload unavailable' } }, 503)
      contents.push(new TextDecoder().decode(bytes))
      return undefined
    })
    const runtime = createBrowserNativeWorkspaceRuntime()
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    await runtime.prepareVfs(runtime.vfs)
    runtime.vfs.writeFileSync('/dsh/home/workspace/retry.txt', 'first version')
    await expect(runtime.flushWorkspace()).rejects.toThrow('upload unavailable')
    expect(commits).toHaveLength(0)
    runtime.vfs.writeFileSync('/dsh/home/workspace/retry.txt', 'newer local version')
    expect(runtime.vfs.readFileSync('/dsh/home/workspace/retry.txt', 'utf8')).toBe('newer local version')
    failUpload = false
    await runtime.flushWorkspace()
    expect(uploadAttempts).toBe(3)
    expect(contents).toEqual(['first version', 'newer local version'])
    expect(commits.map(commit => commit.baseRevision)).toEqual([0, 1])
    expect(commits[0]?.operationId).not.toBe(commits[1]?.operationId)
  })

  it.each([
    { label: 'path traversal', entries: [{ path: '../outside', kind: 'directory', mode: 0o755 }], corruptBlob: false },
    { label: 'corrupt blob', entries: [{ path: 'bad.txt', kind: 'file', hash: manifestHash, bytes: manifestBytes.byteLength, mode: 0o600 }], corruptBlob: true },
  ])('refuses to boot from a manifest with $label', async ({ entries, corruptBlob }) => {
    stubWorkspaceFetch(async input => {
      const url = String(input)
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 1, entries })
      if (url.includes('/blob/') && corruptBlob) return new Response('corrupt payload')
      throw new Error(`unexpected request ${url}`)
    })
    const runtime = createBrowserNativeWorkspaceRuntime()
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    await expect(runtime.prepareVfs(runtime.vfs)).rejects.toThrow(/invalid manifest path|blob chunk verification failed/)
    expect(runtime.vfs.existsSync('/dsh/home/outside')).toBe(false)
    expect(runtime.vfs.existsSync('/dsh/home/workspace/bad.txt')).toBe(false)
  })

  it('syncs the final file, not DSH atomic-write staging artifacts', async () => {
    const committedChanges: Array<{ path: string; deleted?: boolean }> = []
    const commits: unknown[] = []
    stubWorkspaceFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/identity')) return jsonResponse({ workspaceId })
      if (url.includes('/manifest?')) return jsonResponse({ workspaceId, revision: 0, entries: [], digest: '' })
      if (url.endsWith('/commit')) {
        commits.push(JSON.parse(String(init?.body)))
        const body = JSON.parse(String(init?.body)) as { changes: Array<{ path: string; deleted?: boolean }> }
        committedChanges.push(...body.changes)
        return jsonResponse({ workspaceId, revision: 1 })
      }
      throw new Error(`unexpected request ${method} ${url}`)
    })
    const runtime = createBrowserNativeWorkspaceRuntime()
    runtime.vfs.seedDirectory('/dsh/home/workspace')
    await runtime.prepareVfs(runtime.vfs)
    const stagingDirectory = '/dsh/home/workspace/.result.txt.1.123e4567-e89b-12d3-a456-426614174000.tmpdir'
    runtime.vfs.mkdirSync(stagingDirectory)
    runtime.vfs.writeFileSync(`${stagingDirectory}/result.txt.tmp`, 'final')
    runtime.vfs.renameSync(`${stagingDirectory}/result.txt.tmp`, '/dsh/home/workspace/result.txt')
    runtime.vfs.rmSync(stagingDirectory, { recursive: true, force: true })
    await vi.waitFor(() => { expect(committedChanges.length).toBeGreaterThan(0) })
    expect(committedChanges.map(change => change.path)).toEqual(['result.txt'])
    expect(commits).toHaveLength(1)
  })
})
