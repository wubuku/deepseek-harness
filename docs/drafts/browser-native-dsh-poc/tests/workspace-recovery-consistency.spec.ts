import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserNativeWorkspaceRuntime, type PendingBatch, type WorkspaceChange } from '../browser-native-workspace.ts'
import { MemoryDurableWorkspaceStore, type DurableWorkspaceSnapshot } from '../browser-native-workspace-store.ts'
import { createWorkspaceBlobProtocolMock } from './workspace-blob-protocol-mock.ts'
import { decodeWorkspaceOperation, workspaceRequestDigest } from '../browser-native-workspace-recovery.ts'

const workspaceId = '7cb327fe-f71a-4d54-ac91-17f0ab4fb163'
const operationId = 'efed1626-47e7-4b11-a19f-abaf8f119b2d'
const root = '/dsh/home/workspace'
const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')
const file = (path: string, value: string): WorkspaceChange => ({
  path, kind: 'file', mode: 0o600, bytes: encode(value).byteLength, content: encode(value),
})
const tool = { sessionId: 'recovery-session', turn: 1, step: 1, callId: 'original-call', toolName: 'write', toolCallSeq: 4 }

function wireChanges(changes: readonly WorkspaceChange[]) {
  return changes.map(change => change.deleted === true ? { path: change.path, deleted: true }
    : change.kind === 'directory' ? { path: change.path, kind: 'directory', mode: change.mode }
      : { path: change.path, kind: 'file', hash: change.contentReference?.hash ?? hash(change.content!), bytes: change.bytes, mode: change.mode })
    .sort((left, right) => left.path.localeCompare(right.path))
}

function receipt(batch: PendingBatch) {
  return { workspaceId, operationId: batch.operationId, revision: batch.baseRevision + 1,
    changedPaths: batch.changes.map(change => change.path).sort(), digest: 'a'.repeat(64) }
}

function committed(batch: PendingBatch) {
  return { workspaceId, operationId: batch.operationId, found: true, receipt: receipt(batch),
    requestDigest: hash(JSON.stringify({ baseRevision: batch.baseRevision, changes: wireChanges(batch.changes) })) }
}

function fixture(revision: number, entries: readonly { path: string; value: string }[] = [], status?: Record<string, unknown> | Error) {
  const requests: string[] = []
  const protocol = createWorkspaceBlobProtocolMock()
  for (const entry of entries) protocol.registerBlob(hash(entry.value), encode(entry.value))
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    requests.push(url)
    const transfer = protocol.respond(input)
    if (transfer !== undefined) return transfer
    let value: Record<string, unknown>
    if (url.endsWith('/identity')) value = { workspaceId }
    else if (url.includes('/manifest?')) value = { workspaceId, revision, entries: entries.map(entry => ({
      path: entry.path, kind: 'file', mode: 0o600, hash: hash(entry.value), bytes: encode(entry.value).byteLength,
    })) }
    else if (url.includes('/operation/')) {
      if (status instanceof Error) throw status
      value = status ?? { workspaceId, operationId, found: false }
    } else throw new Error(`unexpected request ${url}`)
    return Response.json(value)
  }))
  return requests
}

async function prepare(snapshot: DurableWorkspaceSnapshot) {
  const store = new MemoryDurableWorkspaceStore()
  await store.save(snapshot)
  const save = vi.spyOn(store, 'save')
  const reconcile = vi.spyOn(store, 'reconcileBlobs')
  const statuses: string[] = []
  const runtime = createBrowserNativeWorkspaceRuntime({ store, onStatus: state => { statuses.push(state) } })
  return { store, save, reconcile, statuses, runtime }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Workspace recovery consistency before Host boot', () => {
  it('replays a later deletion after the earlier retry write', async () => {
    fixture(3)
    const state = await prepare({ version: 1, workspaceId, revision: 3,
      retryBatch: { operationId, baseRevision: 3, changes: [file('gone.txt', 'old')] },
      pending: [{ path: 'gone.txt', deleted: true }] })
    await state.runtime.prepareVfs(state.runtime.vfs)
    expect(state.runtime.vfs.existsSync(`${root}/gone.txt`)).toBe(false)
  })

  it('rejects a newer remote baseline before downloading or changing local data', async () => {
    const requests = fixture(4, [{ path: 'remote.txt', value: 'remote new' }])
    const snapshot: DurableWorkspaceSnapshot = { version: 1, workspaceId, revision: 3, pending: [file('draft.txt', 'local old')] }
    const state = await prepare(snapshot)
    await expect(state.runtime.prepareVfs(state.runtime.vfs)).rejects.toMatchObject({ code: 'WORKSPACE_RECOVERY_CONFLICT' })
    expect(requests.some(url => url.includes('/blob/'))).toBe(false)
    expect(state.save).not.toHaveBeenCalled()
    expect(state.reconcile).not.toHaveBeenCalled()
    expect(await state.store.load(workspaceId)).toEqual(snapshot)
    expect(state.statuses.at(-1)).toBe('conflict')
    await expect(state.runtime.authorizeFileTool('read')).rejects.toThrow(/not ready/)
  })

  it('does not replay an acknowledged retry over a later remote edit', async () => {
    const batch: PendingBatch = { operationId, baseRevision: 3, changes: [file('same.txt', 'old retry')], operation: tool }
    const requests = fixture(5, [{ path: 'same.txt', value: 'newer remote' }], committed(batch))
    const state = await prepare({ version: 1, workspaceId, revision: 3, retryBatch: batch, pending: [] })
    await state.runtime.prepareVfs(state.runtime.vfs)
    expect(state.runtime.vfs.readFileSync(`${root}/same.txt`, 'utf8')).toBe('newer remote')
    expect((await state.store.load(workspaceId))?.retryBatch).toBeUndefined()
    expect(state.runtime.pendingReceipts(tool.sessionId)).toEqual([expect.objectContaining({ operationId, operation: tool,
      baseRevision: 3, revision: 4, replayed: true })])
    expect(requests.some(url => url.endsWith('/commit'))).toBe(false)
    expect(state.statuses.at(-1)).toBe('synced')
  })

  it('replays a later rename and subtree removal after retry creation', async () => {
    fixture(3)
    const state = await prepare({ version: 1, workspaceId, revision: 3,
      retryBatch: { operationId, baseRevision: 3, changes: [
        { path: 'old', kind: 'directory', mode: 0o755 }, file('old/a.txt', 'before rename'),
      ] }, pending: [{ path: 'old/a.txt', deleted: true }, { path: 'old', deleted: true },
        { path: 'new', kind: 'directory', mode: 0o755 }, file('new/a.txt', 'after rename')] })
    await state.runtime.prepareVfs(state.runtime.vfs)
    expect(state.runtime.vfs.existsSync(`${root}/old`)).toBe(false)
    expect(state.runtime.vfs.readFileSync(`${root}/new/a.txt`, 'utf8')).toBe('after rename')
  })

  it('keeps later pending changes only on their acknowledged direct baseline', async () => {
    const batch: PendingBatch = { operationId, baseRevision: 3, changes: [file('same.txt', 'retry')], operation: tool }
    fixture(4, [{ path: 'same.txt', value: 'retry' }], committed(batch))
    const state = await prepare({ version: 1, workspaceId, revision: 3, retryBatch: batch, pending: [file('same.txt', 'later local')] })
    await state.runtime.prepareVfs(state.runtime.vfs)
    expect(state.runtime.vfs.readFileSync(`${root}/same.txt`, 'utf8')).toBe('later local')
    const saved = await state.store.load(workspaceId)
    expect(saved?.revision).toBe(4)
    expect(saved?.retryBatch).toBeUndefined()
    expect(saved?.pending).toHaveLength(1)
    expect(saved?.receipts).toHaveLength(1)
    expect(state.statuses.at(-1)).toBe('dirty')
  })

  it.each([
    { name: 'uncommitted retry with newer remote', remote: 5, acknowledged: false, pending: false },
    { name: 'committed retry with later pending and newer remote', remote: 5, acknowledged: true, pending: true },
    { name: 'remote older than committed receipt', remote: 3, acknowledged: true, pending: false },
    { name: 'remote older than retry baseline', remote: 2, acknowledged: false, pending: false },
  ])('preserves the entire snapshot for $name', async ({ remote, acknowledged, pending }) => {
    const batch: PendingBatch = { operationId, baseRevision: 3, changes: [file('same.txt', 'retry')], operation: tool }
    fixture(remote, [], acknowledged ? committed(batch) : undefined)
    const snapshot: DurableWorkspaceSnapshot = { version: 1, workspaceId, revision: 3, retryBatch: batch,
      pending: pending ? [file('later.txt', 'do not lose')] : [] }
    const state = await prepare(snapshot)
    await expect(state.runtime.prepareVfs(state.runtime.vfs)).rejects.toMatchObject({ code: 'WORKSPACE_RECOVERY_CONFLICT' })
    expect(await state.store.load(workspaceId)).toEqual(snapshot)
    expect(state.save).not.toHaveBeenCalled()
    expect(state.reconcile).not.toHaveBeenCalled()
  })

  it('distinguishes unavailable operation status from confirmed absence', async () => {
    fixture(3, [], new TypeError('network unavailable'))
    const snapshot: DurableWorkspaceSnapshot = { version: 1, workspaceId, revision: 3, pending: [],
      retryBatch: { operationId, baseRevision: 3, changes: [file('draft.txt', 'retain')] } }
    const state = await prepare(snapshot)
    await expect(state.runtime.prepareVfs(state.runtime.vfs)).rejects.toMatchObject({ code: 'WORKSPACE_RECOVERY_UNKNOWN' })
    expect(state.statuses.at(-1)).toBe('error')
    expect(await state.store.load(workspaceId)).toEqual(snapshot)
    expect(state.runtime.vfs.existsSync(`${root}/draft.txt`)).toBe(false)
  })

  it.each(['workspace', 'operation', 'request digest', 'receipt workspace', 'receipt operation', 'receipt revision', 'receipt paths', 'manifest digest', 'missing found'])(
    'rejects an invalid %s in the operation status response', async field => {
      const batch: PendingBatch = { operationId, baseRevision: 3, changes: [file('draft.txt', 'retain')] }
      const response: Record<string, unknown> = committed(batch)
      const responseReceipt = response.receipt as Record<string, unknown>
      if (field === 'workspace') response.workspaceId = crypto.randomUUID()
      if (field === 'operation') response.operationId = crypto.randomUUID()
      if (field === 'request digest') response.requestDigest = 'b'.repeat(64)
      if (field === 'receipt workspace') responseReceipt.workspaceId = crypto.randomUUID()
      if (field === 'receipt operation') responseReceipt.operationId = crypto.randomUUID()
      if (field === 'receipt revision') responseReceipt.revision = 6
      if (field === 'receipt paths') responseReceipt.changedPaths = ['other.txt']
      if (field === 'manifest digest') responseReceipt.digest = 'not-a-hash'
      if (field === 'missing found') delete response.found
      fixture(4, [], response)
      const snapshot: DurableWorkspaceSnapshot = { version: 1, workspaceId, revision: 3, retryBatch: batch, pending: [] }
      const state = await prepare(snapshot)
      await expect(state.runtime.prepareVfs(state.runtime.vfs)).rejects.toMatchObject({ code: 'WORKSPACE_RECOVERY_INVALID' })
      expect(await state.store.load(workspaceId)).toEqual(snapshot)
      expect(state.save).not.toHaveBeenCalled()
    },
  )

  it('rejects remote rollback even when local metadata has no pending changes', async () => {
    fixture(2)
    const state = await prepare({ version: 1, workspaceId, revision: 3, pending: [] })
    await expect(state.runtime.prepareVfs(state.runtime.vfs)).rejects.toMatchObject({ code: 'WORKSPACE_RECOVERY_CONFLICT' })
  })

  it('advances clean snapshots without overlaying old content', async () => {
    fixture(5, [{ path: 'new.txt', value: 'current' }])
    const state = await prepare({ version: 1, workspaceId, revision: 3, pending: [] })
    await state.runtime.prepareVfs(state.runtime.vfs)
    expect(state.runtime.vfs.readFileSync(`${root}/new.txt`, 'utf8')).toBe('current')
    expect(state.statuses.at(-1)).toBe('synced')
  })

  it('retains one linked receipt across repeated boots and deletes it only on acknowledgement', async () => {
    const batch: PendingBatch = { operationId, baseRevision: 3, changes: [file('same.txt', 'retry')], operation: tool }
    fixture(4, [{ path: 'same.txt', value: 'retry' }], committed(batch))
    const state = await prepare({ version: 1, workspaceId, revision: 3, retryBatch: batch, pending: [] })
    await state.runtime.prepareVfs(state.runtime.vfs)
    const second = createBrowserNativeWorkspaceRuntime({ store: state.store, onStatus: () => {} })
    await second.prepareVfs(second.vfs)
    expect(second.pendingReceipts(tool.sessionId)).toHaveLength(1)
    await second.acknowledgeReceipt(operationId)
    expect((await state.store.load(workspaceId))?.receipts).toBeUndefined()
  })

  it('hashes retained content references independently of current file bytes', () => {
    const change = file('value.txt', 'original')
    const batch: PendingBatch = { operationId, baseRevision: 3, changes: [
      { path: 'z', deleted: true }, change, { path: 'directory', kind: 'directory', mode: 0o755 },
    ] }
    const referenced: PendingBatch = { ...batch, changes: batch.changes.map(item => item === change
      ? { path: change.path, kind: 'file', mode: 0o600, bytes: encode('original').byteLength,
        contentReference: { hash: hash('original'), bytes: encode('original').byteLength } } : item) }
    expect(workspaceRequestDigest(referenced)).toBe(workspaceRequestDigest(batch))
    expect(decodeWorkspaceOperation(committed(batch), workspaceId, referenced).state).toBe('committed')
  })

  it('retains the original retry if saving the recovered receipt fails', async () => {
    const batch: PendingBatch = { operationId, baseRevision: 3, changes: [file('same.txt', 'retry')], operation: tool }
    fixture(4, [{ path: 'same.txt', value: 'retry' }], committed(batch))
    const snapshot: DurableWorkspaceSnapshot = { version: 1, workspaceId, revision: 3, retryBatch: batch, pending: [] }
    const state = await prepare(snapshot)
    state.save.mockRejectedValue(new Error('metadata save failed'))
    await expect(state.runtime.prepareVfs(state.runtime.vfs)).rejects.toThrow('metadata save failed')
    expect(await state.store.load(workspaceId)).toEqual(snapshot)
    expect(state.statuses).not.toContain('synced')
    await expect(state.runtime.authorizeFileTool('read')).rejects.toThrow(/not ready/)
  })
})
