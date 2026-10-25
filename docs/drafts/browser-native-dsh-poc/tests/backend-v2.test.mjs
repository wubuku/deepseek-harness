import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { WORKSPACE_BLOB_CHUNK_BYTES } from '../workspace-v2.mjs'

const liveApps = new Set()
const temporaryDirectories = new Set()

async function temporaryDirectory(prefix = 'browser-native-v2-test-') {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.add(directory)
  return directory
}

async function start(options) {
  const app = await createBrowserNativeV2Server({ port: 0, ...options })
  const origin = await app.listen()
  liveApps.add(app)
  return { app, origin }
}

function envelope(requestId, extra = {}) {
  return { protocolVersion: 1, requestId, ...extra }
}

async function post(origin, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const value = await response.json()
  if (!response.ok) {
    const error = new Error(value.error?.message ?? `HTTP ${response.status}`)
    error.code = value.error?.code
    error.status = response.status
    error.retryAfterMs = value.error?.retryAfterMs
    throw error
  }
  return value
}

async function failure(origin, path, body) {
  try {
    await post(origin, path, body)
  } catch (error) {
    return error
  }
  assert.fail(`expected ${path} to fail`)
}

function header(id) {
  return { id, version: 1, createdAt: 1_700_000_000_000, cwd: '/workspace' }
}

async function readNdjson(response) {
  const body = await response.text()
  assert.equal(response.ok, true, body)
  return body
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  return `http://127.0.0.1:${address.port}`
}

async function close(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function waitUntil(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  assert.fail(`Timed out waiting for ${label}`)
}

async function openWorkspaceIdentity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  const setCookie = response.headers.get('set-cookie')
  assert.equal(typeof setCookie, 'string')
  assert.match(setCookie, /Max-Age=31536000/)
  return { workspaceId: body.workspaceId, cookie: setCookie.split(';', 1)[0] }
}

async function postWorkspace(origin, identity, operation, body) {
  const response = await fetch(`${origin}/api/browser-native/workspace/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: identity.cookie },
    body: JSON.stringify(envelope(`workspace-${randomUUID()}`, { workspaceId: identity.workspaceId, ...body })),
  })
  const value = await response.json()
  return { response, value }
}

async function postAuthenticatedWorkspace(origin, identity, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: identity.cookie },
    body: JSON.stringify(body),
  })
  const value = await response.json()
  if (!response.ok) {
    const error = new Error(value.error?.message ?? `HTTP ${response.status}`)
    error.code = value.error?.code
    error.status = response.status
    throw error
  }
  return value
}

async function uploadWorkspaceBlob(origin, identity, bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex')
  const response = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}`, {
    method: 'PUT',
    headers: {
      cookie: identity.cookie,
      'content-type': 'application/octet-stream',
      'x-browser-native-protocol': '1',
      'x-request-id': randomUUID(),
      'x-workspace-id': identity.workspaceId,
    },
    body: bytes,
  })
  const value = await response.json()
  assert.equal(response.ok, true, JSON.stringify(value))
  return { hash, bytes: bytes.byteLength, reused: value.reused }
}

async function uploadWorkspaceChunk(origin, identity, operationId, hash, index, bytes, chunkHash = createHash('sha256').update(bytes).digest('hex')) {
  const response = await fetch(`${origin}/api/browser-native/workspace/blob-upload/${operationId}-${hash}/${String(index)}`, {
    method: 'PUT',
    headers: {
      cookie: identity.cookie,
      'content-type': 'application/octet-stream',
      'x-browser-native-protocol': '1',
      'x-request-id': randomUUID(),
      'x-workspace-id': identity.workspaceId,
      'x-chunk-sha256': chunkHash,
    },
    body: bytes,
  })
  return { response, value: await response.json() }
}

afterEach(async () => {
  for (const app of liveApps) {
    await app.close()
    liveApps.delete(app)
  }
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true })
    temporaryDirectories.delete(directory)
  }
})

describe('browser-native DSH v2 backend', () => {
  it('returns the allocated port when listening on port zero', async () => {
    const dataDir = await temporaryDirectory()
    const { origin, app } = await start({ dataDir, port: 0, llmMode: 'scripted' })
    assert.equal(Number(new URL(origin).port), app.server.address().port)
    assert.notEqual(new URL(origin).port, '0')
    const response = await fetch(`${origin}/api/browser-native/health`)
    assert.equal(response.ok, true)
  })

  it('creates, lists, reads, appends, and rejects a stale sequence', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const id = 'contract-session'
    const created = await post(origin, '/api/browser-native/session/create', envelope('create', {
      sessionId: id,
      header: header(id),
      inheritedEventCount: 3,
    }))
    assert.equal(created.sessionId, id)
    assert.equal(created.inheritedEventCount, 3)
    assert.equal(created.nextSeq, 0)
    assert.equal(typeof created.owner.ownerToken, 'string')

    const listed = await post(origin, '/api/browser-native/session/list', envelope('list'))
    assert.deepEqual(listed.snapshots.map(snapshot => snapshot.header.id), [id])
    assert.equal(listed.snapshots[0].eventCount, 0)
    assert.deepEqual(listed.items, [{
      agentAvailable: false,
      sessionId: id,
      updatedAt: 1_700_000_000_000,
      running: false,
      blank: true,
      cwd: '/workspace',
    }])

    const event = { seq: 0, type: 'user/message', payload: { content: 'hello' }, at: '2026-10-03T00:00:00.000Z' }
    const appended = await post(origin, '/api/browser-native/session/append', envelope('append', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      expectedNextSeq: 0,
      events: [event],
    }))
    assert.equal(appended.acceptedCount, 1)
    assert.equal(appended.nextSeq, 1)

    const stale = await failure(origin, '/api/browser-native/session/append', envelope('append-stale', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      expectedNextSeq: 0,
      events: [event],
    }))
    assert.equal(stale.code, 'SEQ_CONFLICT')

    const read = await post(origin, '/api/browser-native/session/read', envelope('read', {
      sessionId: id,
      offset: 0,
      length: 10,
    }))
    assert.deepEqual(read.events, [event])
    assert.equal(read.eventState, 'shared-frozen')
  })

  it('hands Session ownership to a new execution owner and fences the old owner', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const id = 'handoff-session'
    const created = await post(origin, '/api/browser-native/session/create', envelope('handoff-create', {
      sessionId: id,
      header: header(id),
      inheritedEventCount: 0,
    }))
    const oldOwner = created.owner
    assert.equal(oldOwner.ownerEpoch, 1)
    await post(origin, '/api/browser-native/session/append', envelope('handoff-append', {
      sessionId: id,
      ownerToken: oldOwner.ownerToken,
      ownerEpoch: oldOwner.ownerEpoch,
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'user/message', payload: { content: 'continue in cloud' } }],
    }))

    const handoff = await post(origin, '/api/browser-native/session/handoff', envelope('handoff-1', {
      sessionId: id,
      ownerToken: oldOwner.ownerToken,
      ownerEpoch: oldOwner.ownerEpoch,
      handoffId: 'handoff-1',
      checkpoint: {
        sessionId: id,
        ownerId: 'browser-worker-1',
        epoch: oldOwner.ownerEpoch,
        nextSessionSeq: 1,
        workspaceRevision: 3,
        pendingOperationIds: ['workspace-op-1'],
        pendingExecutionIds: ['tool-1'],
      },
    }))
    assert.equal(handoff.handoffId, 'handoff-1')
    assert.equal(handoff.durabilityReceipt, `durable-${id}-0`)
    assert.notEqual(handoff.owner.ownerToken, oldOwner.ownerToken)
    assert.equal(handoff.owner.ownerEpoch, 2)

    const staleAppend = await failure(origin, '/api/browser-native/session/append', envelope('handoff-stale-append', {
      sessionId: id,
      ownerToken: oldOwner.ownerToken,
      ownerEpoch: oldOwner.ownerEpoch,
      expectedNextSeq: 1,
      events: [{ seq: 1, type: 'assistant/message', payload: { content: 'stale' } }],
    }))
    assert.equal(staleAppend.code, 'SESSION_OWNERSHIP_LOST')
    const staleLlm = await failure(origin, '/api/browser-native/llm', envelope('handoff-stale-llm', {
      sessionId: id,
      ownerToken: oldOwner.ownerToken,
      ownerEpoch: oldOwner.ownerEpoch,
      messages: [],
    }))
    assert.equal(staleLlm.code, 'SESSION_OWNERSHIP_LOST')

    const accepted = await post(origin, '/api/browser-native/session/append', envelope('handoff-cloud-append', {
      sessionId: id,
      ownerToken: handoff.owner.ownerToken,
      ownerEpoch: handoff.owner.ownerEpoch,
      expectedNextSeq: 1,
      events: [{ seq: 1, type: 'assistant/message', payload: { content: 'cloud continued' } }],
    }))
    assert.equal(accepted.nextSeq, 2)
    const flushed = await post(origin, '/api/browser-native/session/flush', envelope('handoff-cloud-flush', {
      sessionId: id,
      ownerToken: handoff.owner.ownerToken,
      ownerEpoch: handoff.owner.ownerEpoch,
    }))
    assert.equal(flushed.durable, true)
  })

  it('replays one handoff receipt without advancing the owner epoch', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const id = 'handoff-idempotent-session'
    const created = await post(origin, '/api/browser-native/session/create', envelope('handoff-idempotent-create', {
      sessionId: id,
      header: header(id),
      inheritedEventCount: 0,
    }))
    const checkpoint = {
      sessionId: id,
      ownerId: 'browser-worker-1',
      epoch: created.owner.ownerEpoch,
      nextSessionSeq: 0,
      workspaceRevision: 0,
      pendingOperationIds: [],
      pendingExecutionIds: [],
    }
    const first = await post(origin, '/api/browser-native/session/handoff', envelope('handoff-idempotent-first', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'same-handoff',
      checkpoint,
    }))
    await post(origin, '/api/browser-native/session/append', envelope('handoff-idempotent-after', {
      sessionId: id,
      ownerToken: first.owner.ownerToken,
      ownerEpoch: first.owner.ownerEpoch,
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'assistant/message', payload: { content: 'new owner continued' } }],
    }))
    const replay = await post(origin, '/api/browser-native/session/handoff', envelope('handoff-idempotent-replay', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'same-handoff',
      checkpoint,
    }))
    assert.equal(first.replayed, false)
    assert.equal(replay.replayed, true)
    assert.equal(replay.owner.ownerEpoch, first.owner.ownerEpoch)
    assert.equal(replay.owner.ownerToken, first.owner.ownerToken)

    const conflict = await failure(origin, '/api/browser-native/session/handoff', envelope('handoff-idempotent-conflict', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'same-handoff',
      checkpoint: { ...checkpoint, workspaceRevision: 1 },
    }))
    assert.equal(conflict.code, 'HANDOFF_CONFLICT')
  })

  it('keeps the old owner when handoff durability fails before publish', async () => {
    const dataDir = await temporaryDirectory()
    let failFlush = true
    const first = await start({
      dataDir,
      llmMode: 'scripted',
      testHooks: { failSessionFlush: () => failFlush },
    })
    const id = 'handoff-flush-failure-session'
    const created = await post(first.origin, '/api/browser-native/session/create', envelope('handoff-failure-create', {
      sessionId: id,
      header: header(id),
      inheritedEventCount: 0,
    }))
    const failed = await failure(first.origin, '/api/browser-native/session/handoff', envelope('handoff-failure', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'failed-handoff',
      checkpoint: {
        sessionId: id,
        ownerId: 'browser-worker-1',
        epoch: created.owner.ownerEpoch,
        nextSessionSeq: 0,
        workspaceRevision: 0,
        pendingOperationIds: [],
        pendingExecutionIds: [],
      },
    }))
    assert.equal(failed.code, 'DURABILITY_FAILED')
    failFlush = false
    const appended = await post(first.origin, '/api/browser-native/session/append', envelope('handoff-failure-recovery', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'user/message', payload: { content: 'old owner retained' } }],
    }))
    assert.equal(appended.nextSeq, 1)
  })

  it('returns bounded Session catalog pages without granting write ownership', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    for (const id of ['catalog-c', 'catalog-a', 'catalog-b']) {
      await post(origin, '/api/browser-native/session/create', envelope(`create-${id}`, {
        sessionId: id,
        header: header(id),
        inheritedEventCount: 0,
      }))
    }
    const first = await post(origin, '/api/browser-native/session/list', envelope('catalog-page-one', { limit: 2 }))
    assert.deepEqual(first.items.map(item => item.sessionId), ['catalog-a', 'catalog-b'])
    assert.equal(first.hasMore, true)
    assert.equal(typeof first.nextCursor, 'string')
    assert.equal(first.items.every(item => item.ownerToken === undefined), true)
    const second = await post(origin, '/api/browser-native/session/list', envelope('catalog-page-two', {
      limit: 2,
      cursor: first.nextCursor,
    }))
    assert.deepEqual(second.items.map(item => item.sessionId), ['catalog-c'])
    assert.equal(second.hasMore, false)
    const invalid = await failure(origin, '/api/browser-native/session/list', envelope('catalog-invalid', {
      limit: 2,
      cursor: 'not-a-cursor',
    }))
    assert.equal(invalid.code, 'INVALID_REQUEST')
  })

  it('rejects over-budget Session append and read requests explicitly', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const id = 'session-payload-budget'
    const created = await post(origin, '/api/browser-native/session/create', envelope('budget-create', {
      sessionId: id,
      header: header(id),
      inheritedEventCount: 0,
    }))
    const oversized = await failure(origin, '/api/browser-native/session/append', envelope('budget-append', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'tool/result', payload: { text: 'x'.repeat(1_049_000) } }],
    }))
    assert.equal(oversized.code, 'REQUEST_TOO_LARGE')
    const invalidRead = await failure(origin, '/api/browser-native/session/read', envelope('budget-read', {
      sessionId: id,
      offset: 0,
      length: 2_049,
    }))
    assert.equal(invalidRead.code, 'INVALID_REQUEST')
  })

  it('persists the handoff epoch before a backend restart', async () => {
    const dataDir = await temporaryDirectory()
    const first = await start({ dataDir, llmMode: 'scripted' })
    const id = 'handoff-restart-session'
    const created = await post(first.origin, '/api/browser-native/session/create', envelope('handoff-restart-create', {
      sessionId: id,
      header: header(id),
      inheritedEventCount: 0,
    }))
    const handedOff = await post(first.origin, '/api/browser-native/session/handoff', envelope('handoff-restart', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'handoff-restart-1',
      checkpoint: {
        sessionId: id,
        ownerId: 'browser-worker-1',
        epoch: created.owner.ownerEpoch,
        nextSessionSeq: 0,
        workspaceRevision: 0,
        pendingOperationIds: [],
        pendingExecutionIds: [],
      },
    }))
    assert.equal(handedOff.owner.ownerEpoch, 2)
    await first.app.close()
    liveApps.delete(first.app)

    const second = await start({ dataDir, llmMode: 'scripted' })
    const replayed = await post(second.origin, '/api/browser-native/session/handoff', envelope('handoff-restart-replay', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'handoff-restart-1',
      checkpoint: {
        sessionId: id,
        ownerId: 'browser-worker-1',
        epoch: created.owner.ownerEpoch,
        nextSessionSeq: 0,
        workspaceRevision: 0,
        pendingOperationIds: [],
        pendingExecutionIds: [],
      },
    }))
    assert.equal(replayed.replayed, true)
    assert.equal(replayed.owner.ownerEpoch, handedOff.owner.ownerEpoch)
    assert.equal(replayed.owner.ownerToken, handedOff.owner.ownerToken)
    const reopened = await post(second.origin, '/api/browser-native/session/open', envelope('handoff-restart-open', {
      sessionId: id,
      access: 'write',
    }))
    assert.equal(reopened.owner.ownerEpoch, 3)
    assert.notEqual(reopened.owner.ownerToken, handedOff.owner.ownerToken)
  })

  it('persists workspace blobs and commits revisions idempotently with compare-and-swap', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const initialResponse = await fetch(`${origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    const initial = await initialResponse.json()
    assert.equal(initial.revision, 0)
    assert.deepEqual(initial.entries, [])

    const bytes = Buffer.from('cloud workspace ✓\n')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const uploaded = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}`, {
      method: 'PUT',
      headers: {
        cookie: identity.cookie,
        'content-type': 'application/octet-stream',
        'x-browser-native-protocol': '1',
        'x-request-id': 'blob-upload-one',
        'x-workspace-id': identity.workspaceId,
      },
      body: bytes,
    })
    const uploadedBody = await uploaded.json()
    assert.equal(uploaded.ok, true, JSON.stringify(uploadedBody))
    assert.equal(uploadedBody.reused, false)

    const operationId = randomUUID()
    const changes = [{ path: 'notes/daily.txt', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }]
    const committed = await postWorkspace(origin, identity, 'commit', {
      operationId,
      baseRevision: 0,
      changes,
    })
    assert.equal(committed.response.ok, true, JSON.stringify(committed.value))
    assert.equal(committed.value.revision, 1)
    assert.equal(committed.value.replayed, false)

    const replay = await postWorkspace(origin, identity, 'commit', {
      operationId,
      baseRevision: 0,
      changes,
    })
    assert.equal(replay.response.ok, true)
    assert.equal(replay.value.replayed, true)
    assert.equal(replay.value.revision, 1)

    const conflicting = await postWorkspace(origin, identity, 'commit', {
      operationId: randomUUID(),
      baseRevision: 0,
      changes,
    })
    assert.equal(conflicting.response.status, 409)
    assert.equal(conflicting.value.error.code, 'WORKSPACE_CONFLICT')
    assert.equal(conflicting.value.error.details.current.revision, 1)

    const manifestResponse = await fetch(`${origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    const manifest = await manifestResponse.json()
    assert.deepEqual(manifest.entries, [{ path: 'notes', kind: 'directory', mode: 0o755 }, { path: 'notes/daily.txt', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }])
    const downloaded = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes)
  })

  it('resumes chunk uploads after backend restart and fences conflicting or incomplete chunks', async () => {
    const dataDir = await temporaryDirectory()
    const first = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(first.origin)
    const bytes = Buffer.alloc(WORKSPACE_BLOB_CHUNK_BYTES * 2 + 37)
    for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = (index * 31 + 7) % 251
    const hash = createHash('sha256').update(bytes).digest('hex')
    const operationId = randomUUID()
    const uploadPath = `/api/browser-native/workspace/blob-upload/${operationId}-${hash}`
    const started = await postAuthenticatedWorkspace(first.origin, identity, '/api/browser-native/workspace/blob-upload/start', envelope('chunk-start', {
      workspaceId: identity.workspaceId,
      operationId,
      hash,
      totalBytes: bytes.byteLength,
      chunkBytes: WORKSPACE_BLOB_CHUNK_BYTES,
    }))
    assert.equal(started.complete, false)
    assert.equal(started.chunkCount, 3)
    assert.deepEqual(started.missing, [0, 1, 2])

    const firstChunk = bytes.subarray(0, WORKSPACE_BLOB_CHUNK_BYTES)
    const firstWrite = await uploadWorkspaceChunk(first.origin, identity, operationId, hash, 0, firstChunk)
    assert.equal(firstWrite.response.status, 200)
    assert.equal(firstWrite.value.replayed, false)
    const duplicate = await uploadWorkspaceChunk(first.origin, identity, operationId, hash, 0, firstChunk)
    assert.equal(duplicate.response.status, 200)
    assert.equal(duplicate.value.replayed, true)

    const conflictingBytes = Buffer.from(firstChunk)
    conflictingBytes[0] ^= 0xff
    const conflicting = await uploadWorkspaceChunk(first.origin, identity, operationId, hash, 0, conflictingBytes)
    assert.equal(conflicting.response.status, 409)
    assert.equal(conflicting.value.error.code, 'UPLOAD_CHUNK_CONFLICT')
    const invalidHash = await uploadWorkspaceChunk(first.origin, identity, operationId, hash, 1,
      bytes.subarray(WORKSPACE_BLOB_CHUNK_BYTES, WORKSPACE_BLOB_CHUNK_BYTES * 2), '0'.repeat(64))
    assert.equal(invalidHash.response.status, 400)

    const incomplete = await postAuthenticatedWorkspace(first.origin, identity, `${uploadPath}/complete`, envelope('chunk-incomplete', {
      workspaceId: identity.workspaceId,
    })).catch(error => error)
    assert.equal(incomplete.code, 'UPLOAD_INCOMPLETE')
    await first.app.close()
    liveApps.delete(first.app)

    const second = await start({ dataDir, llmMode: 'scripted' })
    const resumed = await fetch(`${second.origin}${uploadPath}?protocolVersion=1&workspaceId=${encodeURIComponent(identity.workspaceId)}`, {
      headers: { cookie: identity.cookie },
    })
    const resumeState = await resumed.json()
    assert.equal(resumed.status, 200)
    assert.deepEqual(resumeState.missing, [1, 2])
    const secondChunk = bytes.subarray(WORKSPACE_BLOB_CHUNK_BYTES, WORKSPACE_BLOB_CHUNK_BYTES * 2)
    const finalChunk = bytes.subarray(WORKSPACE_BLOB_CHUNK_BYTES * 2)
    assert.equal((await uploadWorkspaceChunk(second.origin, identity, operationId, hash, 1, secondChunk)).response.status, 200)
    assert.equal((await uploadWorkspaceChunk(second.origin, identity, operationId, hash, 2, finalChunk)).response.status, 200)
    const completed = await postAuthenticatedWorkspace(second.origin, identity, `${uploadPath}/complete`, envelope('chunk-complete', {
      workspaceId: identity.workspaceId,
    }))
    assert.equal(completed.complete, true)
    const replayedComplete = await postAuthenticatedWorkspace(second.origin, identity, `${uploadPath}/complete`, envelope('chunk-complete-replay', {
      workspaceId: identity.workspaceId,
    }))
    assert.equal(replayedComplete.replayed, true)

    const committed = await postWorkspace(second.origin, identity, 'commit', {
      operationId,
      baseRevision: 0,
      changes: [{ path: 'large.bin', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }],
    })
    assert.equal(committed.response.status, 200)
    assert.equal(committed.value.revision, 1)
    const chunkResponse = await fetch(`${second.origin}/api/browser-native/workspace/blob/${hash}/chunk/2?protocolVersion=1&workspaceId=${encodeURIComponent(identity.workspaceId)}`, {
      headers: { cookie: identity.cookie },
    })
    const downloadedChunk = new Uint8Array(await chunkResponse.arrayBuffer())
    assert.equal(chunkResponse.status, 200)
    assert.equal(chunkResponse.headers.get('x-chunk-count'), '3')
    assert.deepEqual(downloadedChunk, new Uint8Array(finalChunk))
    assert.equal(chunkResponse.headers.get('x-content-sha256'), createHash('sha256').update(finalChunk).digest('hex'))
  })

  it('reports a corrupted staged chunk as missing and accepts its verified replacement', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const bytes = Buffer.alloc(WORKSPACE_BLOB_CHUNK_BYTES + 19, 0x5a)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const operationId = randomUUID()
    const uploadPath = `/api/browser-native/workspace/blob-upload/${operationId}-${hash}`
    const started = await postAuthenticatedWorkspace(origin, identity, '/api/browser-native/workspace/blob-upload/start', envelope('corrupt-start', {
      workspaceId: identity.workspaceId,
      operationId,
      hash,
      totalBytes: bytes.byteLength,
      chunkBytes: WORKSPACE_BLOB_CHUNK_BYTES,
    }))
    assert.equal(started.complete, false)
    const firstChunk = bytes.subarray(0, WORKSPACE_BLOB_CHUNK_BYTES)
    assert.equal((await uploadWorkspaceChunk(origin, identity, operationId, hash, 0, firstChunk)).response.status, 200)
    const stagingDirectory = join(dataDir, 'workspace-v2', 'uploads', identity.workspaceId, `${operationId}-${hash}`)
    await writeFile(join(stagingDirectory, '0.part'), Buffer.from('corrupt'))

    const statusResponse = await fetch(`${origin}${uploadPath}?protocolVersion=1&workspaceId=${encodeURIComponent(identity.workspaceId)}`, {
      headers: { cookie: identity.cookie },
    })
    const status = await statusResponse.json()
    assert.equal(statusResponse.status, 200)
    assert.deepEqual(status.missing, [0, 1])

    const restoredFirst = await uploadWorkspaceChunk(origin, identity, operationId, hash, 0, firstChunk)
    assert.equal(restoredFirst.response.status, 200)
    assert.equal(restoredFirst.value.replayed, false)
    const lastChunk = bytes.subarray(WORKSPACE_BLOB_CHUNK_BYTES)
    assert.equal((await uploadWorkspaceChunk(origin, identity, operationId, hash, 1, lastChunk)).response.status, 200)
    const completed = await postAuthenticatedWorkspace(origin, identity, `${uploadPath}/complete`, envelope('corrupt-complete', {
      workspaceId: identity.workspaceId,
    }))
    assert.equal(completed.complete, true)

    const unreferenced = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}/chunk/0?protocolVersion=1&workspaceId=${encodeURIComponent(identity.workspaceId)}`, {
      headers: { cookie: identity.cookie },
    })
    assert.equal(unreferenced.status, 404)
  })

  it('isolates workspace identity and restores it after backend restart', async () => {
    const dataDir = await temporaryDirectory()
    const first = await start({ dataDir, llmMode: 'scripted' })
    const owner = await openWorkspaceIdentity(first.origin)
    const other = await openWorkspaceIdentity(first.origin)
    assert.notEqual(owner.workspaceId, other.workspaceId)

    const denied = await fetch(`${first.origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${owner.workspaceId}`, {
      headers: { cookie: other.cookie },
    })
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).error.code, 'WORKSPACE_FORBIDDEN')

    const bytes = Buffer.from('survives backend restart')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const upload = await fetch(`${first.origin}/api/browser-native/workspace/blob/${hash}`, {
      method: 'PUT',
      headers: {
        cookie: owner.cookie,
        'content-type': 'application/octet-stream',
        'x-browser-native-protocol': '1',
        'x-request-id': 'restart-upload',
        'x-workspace-id': owner.workspaceId,
      },
      body: bytes,
    })
    assert.equal(upload.ok, true)
    const committed = await postWorkspace(first.origin, owner, 'commit', {
      operationId: randomUUID(),
      baseRevision: 0,
      changes: [{ path: 'persisted.txt', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }],
    })
    assert.equal(committed.response.ok, true, JSON.stringify(committed.value))

    const foreignRead = await fetch(`${first.origin}/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${owner.workspaceId}`, {
      headers: { cookie: other.cookie },
    })
    assert.equal(foreignRead.status, 403)
    assert.equal((await foreignRead.json()).error.code, 'WORKSPACE_FORBIDDEN')

    const foreignBytes = Buffer.from('must remain private')
    const foreignHash = createHash('sha256').update(foreignBytes).digest('hex')
    const foreignUpload = await fetch(`${first.origin}/api/browser-native/workspace/blob/${foreignHash}`, {
      method: 'PUT',
      headers: {
        cookie: other.cookie,
        'content-type': 'application/octet-stream',
        'x-browser-native-protocol': '1',
        'x-request-id': 'foreign-workspace-upload',
        'x-workspace-id': owner.workspaceId,
      },
      body: foreignBytes,
    })
    assert.equal(foreignUpload.status, 403)
    assert.equal((await foreignUpload.json()).error.code, 'WORKSPACE_FORBIDDEN')

    const foreignCommit = await postWorkspace(first.origin, other, 'commit', {
      workspaceId: owner.workspaceId,
      operationId: randomUUID(),
      baseRevision: 1,
      changes: [{ path: 'intrusion.txt', deleted: true }],
    })
    assert.equal(foreignCommit.response.status, 403)
    assert.equal(foreignCommit.value.error.code, 'WORKSPACE_FORBIDDEN')

    await first.app.close()
    liveApps.delete(first.app)
    const restarted = await start({ dataDir, llmMode: 'scripted' })
    const restored = await fetch(`${restarted.origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${owner.workspaceId}`, {
      headers: { cookie: owner.cookie },
    })
    const restoredBody = await restored.json()
    assert.equal(restored.ok, true, JSON.stringify(restoredBody))
    assert.equal(restoredBody.revision, 1)
    assert.deepEqual(restoredBody.entries, [{ path: 'persisted.txt', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }])
  })

  it('serializes concurrent commits against one workspace revision', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const contenders = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const bytes = Buffer.from(`concurrent-${String(index)}`)
      const hash = createHash('sha256').update(bytes).digest('hex')
      const uploaded = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}`, {
        method: 'PUT',
        headers: {
          cookie: identity.cookie,
          'content-type': 'application/octet-stream',
          'x-browser-native-protocol': '1',
          'x-request-id': `concurrent-upload-${String(index)}`,
          'x-workspace-id': identity.workspaceId,
        },
        body: bytes,
      })
      assert.equal(uploaded.ok, true)
      return {
        operationId: randomUUID(),
        baseRevision: 0,
        changes: [{ path: `contender-${String(index)}.txt`, kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }],
      }
    }))

    const results = await Promise.all(contenders.map(body => postWorkspace(origin, identity, 'commit', body)))
    const committed = results.filter(result => result.response.ok)
    const conflicts = results.filter(result => result.response.status === 409
      && result.value.error.code === 'WORKSPACE_CONFLICT')
    assert.equal(committed.length, 1)
    assert.equal(conflicts.length, contenders.length - 1)

    const manifestResponse = await fetch(`${origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    const manifest = await manifestResponse.json()
    assert.equal(manifest.revision, 1)
    assert.equal(manifest.entries.filter(entry => entry.kind === 'file').length, 1)
  })

  it('requires Workspace upload authorization before referencing another user blob', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const owner = await openWorkspaceIdentity(origin)
    const other = await openWorkspaceIdentity(origin)
    const bytes = Buffer.from('owner-only-content')
    const uploaded = await uploadWorkspaceBlob(origin, owner, bytes)
    const changes = [{ path: 'private.txt', kind: 'file', hash: uploaded.hash, bytes: uploaded.bytes, mode: 0o600 }]
    const denied = await postWorkspace(origin, other, 'commit', {
      operationId: randomUUID(), baseRevision: 0, changes,
    })
    assert.equal(denied.response.status, 403)
    assert.equal(denied.value.error.code, 'BLOB_FORBIDDEN')

    const uploadedByOther = await uploadWorkspaceBlob(origin, other, bytes)
    assert.equal(uploadedByOther.reused, true)
    const allowed = await postWorkspace(origin, other, 'commit', {
      operationId: randomUUID(), baseRevision: 0, changes,
    })
    assert.equal(allowed.response.ok, true, JSON.stringify(allowed.value))
    assert.equal(allowed.value.revision, 1)
  })

  it('persists empty, binary, Unicode, renamed, removed, and chmod entries', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const binary = Buffer.from([0, 255, 128, 1])
    const emptyBlob = await uploadWorkspaceBlob(origin, identity, Buffer.alloc(0))
    const binaryBlob = await uploadWorkspaceBlob(origin, identity, binary)
    const textBlob = await uploadWorkspaceBlob(origin, identity, Buffer.from('alpha\nbeta\n'))
    const initial = await postWorkspace(origin, identity, 'commit', {
      operationId: randomUUID(), baseRevision: 0,
      changes: [
        { path: '目录', kind: 'directory', mode: 0o750 },
        { path: '目录/空文件', kind: 'file', hash: emptyBlob.hash, bytes: 0, mode: 0o600 },
        { path: 'binary.dat', kind: 'file', hash: binaryBlob.hash, bytes: binaryBlob.bytes, mode: 0o600 },
        { path: 'old.txt', kind: 'file', hash: textBlob.hash, bytes: textBlob.bytes, mode: 0o644 },
      ],
    })
    assert.equal(initial.response.ok, true, JSON.stringify(initial.value))
    const changed = await postWorkspace(origin, identity, 'commit', {
      operationId: randomUUID(), baseRevision: 1,
      changes: [
        { path: 'old.txt', deleted: true },
        { path: '目录/已重命名.txt', kind: 'file', hash: textBlob.hash, bytes: textBlob.bytes, mode: 0o600 },
        { path: 'binary.dat', kind: 'file', hash: binaryBlob.hash, bytes: binaryBlob.bytes, mode: 0o640 },
      ],
    })
    assert.equal(changed.response.ok, true, JSON.stringify(changed.value))
    const manifestResponse = await fetch(`${origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    const manifest = await manifestResponse.json()
    assert.equal(manifest.revision, 2)
    assert.equal(manifest.entries.some(entry => entry.path === 'old.txt'), false)
    assert.equal(manifest.entries.find(entry => entry.path === 'binary.dat').mode, 0o640)
    assert.equal(manifest.entries.find(entry => entry.path === '目录/空文件').bytes, 0)
    for (const [hash, expected] of [[binaryBlob.hash, binary], [emptyBlob.hash, Buffer.alloc(0)]]) {
      const downloaded = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
        headers: { cookie: identity.cookie },
      })
      assert.equal(downloaded.ok, true)
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), expected)
    }
    const removed = await postWorkspace(origin, identity, 'commit', {
      operationId: randomUUID(), baseRevision: 2, changes: [{ path: '目录', deleted: true }],
    })
    assert.equal(removed.response.ok, true, JSON.stringify(removed.value))
    const durable = JSON.parse(await readFile(join(dataDir, 'workspace-v2', 'workspaces', `${identity.workspaceId}.json`), 'utf8'))
    assert.equal(durable.revision, 3)
    assert.deepEqual(durable.entries.map(entry => entry.path), ['binary.dat'])
  })

  it('rejects invalid workspace paths, unverified blobs, and mismatched idempotency replays', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const badUpload = await fetch(`${origin}/api/browser-native/workspace/blob/${'0'.repeat(64)}`, {
      method: 'PUT',
      headers: {
        cookie: identity.cookie,
        'content-type': 'application/octet-stream',
        'x-browser-native-protocol': '1',
        'x-request-id': 'bad-hash',
        'x-workspace-id': identity.workspaceId,
      },
      body: Buffer.from('not the requested hash'),
    })
    assert.equal(badUpload.status, 400)
    assert.equal((await badUpload.json()).error.code, 'BLOB_HASH_MISMATCH')

    const invalidPath = await postWorkspace(origin, identity, 'commit', {
      operationId: randomUUID(),
      baseRevision: 0,
      changes: [{ path: '../outside', kind: 'file', hash: '0'.repeat(64), bytes: 1, mode: 0o600 }],
    })
    assert.equal(invalidPath.response.status, 400)
    assert.equal(invalidPath.value.error.code, 'INVALID_PATH')

    const bytes = Buffer.from('one')
    const hash = createHash('sha256').update(bytes).digest('hex')
    await fetch(`${origin}/api/browser-native/workspace/blob/${hash}`, {
      method: 'PUT',
      headers: {
        cookie: identity.cookie,
        'content-type': 'application/octet-stream',
        'x-browser-native-protocol': '1',
        'x-request-id': 'valid-hash',
        'x-workspace-id': identity.workspaceId,
      },
      body: bytes,
    })
    const operationId = randomUUID()
    const first = await postWorkspace(origin, identity, 'commit', {
      operationId,
      baseRevision: 0,
      changes: [{ path: 'one.txt', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }],
    })
    assert.equal(first.response.ok, true)
    const replay = await postWorkspace(origin, identity, 'commit', {
      operationId,
      baseRevision: 0,
      changes: [{ path: 'different.txt', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }],
    })
    assert.equal(replay.response.status, 409)
    assert.equal(replay.value.error.code, 'OPERATION_ID_REUSED')
  })

  it('fails closed on corrupted Workspace metadata and releases the data directory lock', async () => {
    const dataDir = await temporaryDirectory()
    const first = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(first.origin)
    const stagedBytes = Buffer.from('preserve staging until metadata validates')
    const stagedHash = createHash('sha256').update(stagedBytes).digest('hex')
    const stagedOperationId = randomUUID()
    await postAuthenticatedWorkspace(first.origin, identity, '/api/browser-native/workspace/blob-upload/start', envelope('metadata-failure-staging-start', {
      workspaceId: identity.workspaceId,
      operationId: stagedOperationId,
      hash: stagedHash,
      totalBytes: stagedBytes.byteLength,
      chunkBytes: WORKSPACE_BLOB_CHUNK_BYTES,
    }))
    await first.app.close()
    liveApps.delete(first.app)
    const stagingPath = join(dataDir, 'workspace-v2', 'uploads', identity.workspaceId, `${stagedOperationId}-${stagedHash}`, 'upload.json')
    const stagingMetadata = JSON.parse(await readFile(stagingPath, 'utf8'))
    await writeFile(stagingPath, JSON.stringify({ ...stagingMetadata, updatedAt: 0 }))
    const workspacePath = join(dataDir, 'workspace-v2', 'workspaces', `${identity.workspaceId}.json`)
    const valid = await readFile(workspacePath, 'utf8')
    const operationId = randomUUID()
    const invalidRecords = [
      { label: 'path', mutate: value => { value.entries = [{ path: '../escape', kind: 'directory', mode: 0o755 }] } },
      { label: 'hash', mutate: value => { value.entries = [{ path: 'bad.txt', kind: 'file', hash: '0', bytes: 1, mode: 0o600 }] } },
      { label: 'bytes', mutate: value => { value.entries = [{ path: 'bad.txt', kind: 'file', hash: '0'.repeat(64), bytes: -1, mode: 0o600 }] } },
      { label: 'unknown workspace field', mutate: value => { value.futureField = true } },
      { label: 'unknown entry field', mutate: value => { value.entries = [{ path: 'bad.txt', kind: 'directory', mode: 0o755, futureField: true }] } },
      { label: 'missing parent directory', mutate: value => { value.entries = [{ path: 'parent/child.txt', kind: 'file', hash: '0'.repeat(64), bytes: 1, mode: 0o600 }] } },
      { label: 'operation', mutate: value => { value.operations = { [operationId]: { digest: '0', receipt: {} } } } },
      {
        label: 'unknown operation receipt field',
        mutate: value => {
          value.revision = 1
          value.operations = { [operationId]: {
            digest: 'a'.repeat(64),
            receipt: {
              workspaceId: identity.workspaceId,
              revision: 1,
              operationId,
              changedPaths: ['valid.txt'],
              digest: 'b'.repeat(64),
              futureField: true,
            },
          } }
        },
      },
    ]
    for (const invalid of invalidRecords) {
      const value = JSON.parse(valid)
      invalid.mutate(value)
      await writeFile(workspacePath, JSON.stringify(value))
      await assert.rejects(
        () => createBrowserNativeV2Server({ dataDir, distRoot: resolve('apps/web/dist'), llmMode: 'scripted', testHooks: { workspaceNow: () => 86_400_001 } }),
        error => error?.code === 'WORKSPACE_METADATA_INVALID',
        `${invalid.label} metadata must fail closed`,
      )
    }
    await assert.doesNotReject(() => readFile(stagingPath, 'utf8'), 'failed metadata load must not clean an expired staging record first')
    await writeFile(workspacePath, valid)
    const identityPath = join(dataDir, 'workspace-v2', 'identities.json')
    const validIdentities = await readFile(identityPath, 'utf8')
    for (const invalid of [
      { version: 1, identities: [{ principalId: 'invalid', workspaceId: identity.workspaceId }] },
      { version: 1, identities: [{ principalId: identity.principalId, workspaceId: identity.workspaceId, futureField: true }] },
      { version: 1, identities: [{ principalId: identity.principalId, workspaceId: 'not-a-uuid' }] },
    ]) {
      await writeFile(identityPath, JSON.stringify(invalid))
      await assert.rejects(
        () => createBrowserNativeV2Server({ dataDir, distRoot: resolve('apps/web/dist'), llmMode: 'scripted', testHooks: { workspaceNow: () => 86_400_001 } }),
        error => error?.code === 'IDENTITY_METADATA_INVALID',
      )
    }
    await assert.doesNotReject(() => readFile(stagingPath, 'utf8'), 'failed identity load must not clean an expired staging record first')
    await writeFile(identityPath, validIdentities)
    const restored = await start({ dataDir, llmMode: 'scripted', testHooks: { workspaceNow: () => 86_400_001 } })
    await assert.rejects(() => readFile(stagingPath, 'utf8'), error => error?.code === 'ENOENT')
    const manifest = await fetch(`${restored.origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    assert.equal(manifest.ok, true)
    assert.equal((await manifest.json()).revision, 0)
  })

  it('garbage-collects unreachable blobs while preserving current and pending references', async () => {
    const dataDir = await temporaryDirectory()
    let now = 10_000
    const { origin, app } = await start({
      dataDir,
      llmMode: 'scripted',
      pendingUploadTtlMs: 1_000,
      testHooks: { workspaceNow: () => now },
    })
    const identity = await openWorkspaceIdentity(origin)
    const oldBytes = Buffer.from('old content')
    const newBytes = Buffer.from('new content')
    const pendingBytes = Buffer.from('never committed')
    const secondIdentity = await openWorkspaceIdentity(origin)
    const oldBlob = await uploadWorkspaceBlob(origin, identity, oldBytes)
    const firstOperation = randomUUID()
    const firstCommit = await postWorkspace(origin, identity, 'commit', {
      operationId: firstOperation,
      baseRevision: 0,
      changes: [{ path: 'document.txt', kind: 'file', hash: oldBlob.hash, bytes: oldBlob.bytes, mode: 0o600 }],
    })
    assert.equal(firstCommit.response.ok, true)
    const newBlob = await uploadWorkspaceBlob(origin, identity, newBytes)
    const pendingBlob = await uploadWorkspaceBlob(origin, identity, pendingBytes)
    const secondCommit = await postWorkspace(origin, identity, 'commit', {
      operationId: randomUUID(),
      baseRevision: 1,
      changes: [{ path: 'document.txt', kind: 'file', hash: newBlob.hash, bytes: newBlob.bytes, mode: 0o600 }],
    })
    assert.equal(secondCommit.response.ok, true)
    const sharedBlob = await uploadWorkspaceBlob(origin, secondIdentity, newBytes)
    const sharedCommit = await postWorkspace(origin, secondIdentity, 'commit', {
      operationId: randomUUID(),
      baseRevision: 0,
      changes: [{ path: 'shared.txt', kind: 'file', hash: sharedBlob.hash, bytes: sharedBlob.bytes, mode: 0o600 }],
    })
    assert.equal(sharedCommit.response.ok, true)

    const beforeExpiry = await app.workspaces.collectGarbage(identity.workspaceId, { now })
    assert.equal(beforeExpiry.removedFiles, 1)
    assert.equal(beforeExpiry.expiredPending, 0)
    assert.equal(beforeExpiry.retainedFiles, 2)
    const pendingStillThere = await fetch(`${origin}/api/browser-native/workspace/blob/${pendingBlob.hash}?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    assert.equal(pendingStillThere.status, 404, 'uncommitted blobs are not exposed as workspace files')

    now += 1_001
    const afterExpiry = await app.workspaces.collectGarbage(identity.workspaceId, { now })
    assert.equal(afterExpiry.removedFiles, 1)
    assert.equal(afterExpiry.expiredPending, 1)
    const current = await fetch(`${origin}/api/browser-native/workspace/blob/${newBlob.hash}?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    assert.equal(current.status, 200)
    assert.deepEqual(Buffer.from(await current.arrayBuffer()), newBytes)
    const secondWorkspaceCurrent = await fetch(`${origin}/api/browser-native/workspace/blob/${sharedBlob.hash}?protocolVersion=1&workspaceId=${secondIdentity.workspaceId}`, {
      headers: { cookie: secondIdentity.cookie },
    })
    assert.equal(secondWorkspaceCurrent.status, 200)
    const replay = await postWorkspace(origin, identity, 'commit', {
      operationId: firstOperation,
      baseRevision: 0,
      changes: [{ path: 'document.txt', kind: 'file', hash: oldBlob.hash, bytes: oldBlob.bytes, mode: 0o600 }],
    })
    assert.equal(replay.response.ok, true)
    assert.equal(replay.value.replayed, true)

    const durable = JSON.parse(await readFile(join(dataDir, 'workspace-v2', 'workspaces', `${identity.workspaceId}.json`), 'utf8'))
    assert.equal(durable.revision, 2)
    assert.deepEqual(durable.uploadedHashes, [])
  })

  it('expires incomplete chunk staging without removing unrelated blobs', async () => {
    const dataDir = await temporaryDirectory()
    let now = 50_000
    const { origin, app } = await start({ dataDir, llmMode: 'scripted', testHooks: { workspaceNow: () => now } })
    const identity = await openWorkspaceIdentity(origin)
    const content = Buffer.from('staged content')
    const hash = createHash('sha256').update(content).digest('hex')
    const operationId = randomUUID()
    const malformedOperationId = randomUUID()
    const unknownOperationId = randomUUID()
    const missingOperationId = randomUUID()
    const malformedHash = createHash('sha256').update(Buffer.from('malformed staging')).digest('hex')
    const uploadPath = `/api/browser-native/workspace/blob-upload/${operationId}-${hash}`
    await postAuthenticatedWorkspace(origin, identity, '/api/browser-native/workspace/blob-upload/start', envelope('gc-staging-start', {
      workspaceId: identity.workspaceId,
      operationId,
      hash,
      totalBytes: content.byteLength,
      chunkBytes: WORKSPACE_BLOB_CHUNK_BYTES,
    }))
    await postAuthenticatedWorkspace(origin, identity, '/api/browser-native/workspace/blob-upload/start', envelope('gc-staging-malformed-start', {
      workspaceId: identity.workspaceId,
      operationId: malformedOperationId,
      hash: malformedHash,
      totalBytes: content.byteLength,
      chunkBytes: WORKSPACE_BLOB_CHUNK_BYTES,
    }))
    for (const [requestId, uploadOperationId] of [
      ['gc-staging-unknown-start', unknownOperationId],
      ['gc-staging-missing-start', missingOperationId],
    ]) {
      await postAuthenticatedWorkspace(origin, identity, '/api/browser-native/workspace/blob-upload/start', envelope(requestId, {
        workspaceId: identity.workspaceId,
        operationId: uploadOperationId,
        hash: malformedHash,
        totalBytes: content.byteLength,
        chunkBytes: WORKSPACE_BLOB_CHUNK_BYTES,
      }))
    }
    const before = await app.workspaces.collectGarbage(identity.workspaceId, { now })
    assert.equal(before.expiredUploads, 0)
    assert.equal(before.preservedUnrecognizedUploads, 0)
    const staging = join(dataDir, 'workspace-v2', 'uploads', identity.workspaceId, `${operationId}-${hash}`)
    const malformedStaging = join(dataDir, 'workspace-v2', 'uploads', identity.workspaceId, `${malformedOperationId}-${malformedHash}`)
    const unknownStaging = join(dataDir, 'workspace-v2', 'uploads', identity.workspaceId, `${unknownOperationId}-${malformedHash}`)
    const missingStaging = join(dataDir, 'workspace-v2', 'uploads', identity.workspaceId, `${missingOperationId}-${malformedHash}`)
    await writeFile(join(malformedStaging, 'upload.json'), '{')
    const unknownMetadata = JSON.parse(await readFile(join(unknownStaging, 'upload.json'), 'utf8'))
    await writeFile(join(unknownStaging, 'upload.json'), JSON.stringify({ ...unknownMetadata, futureField: true }))
    await rm(join(missingStaging, 'upload.json'), { force: true })
    await assert.rejects(
      () => app.workspaces.readUploadMetadata(identity.workspaceId, malformedOperationId, malformedHash),
      error => error?.code === 'UPLOAD_METADATA_INVALID',
    )
    await assert.rejects(
      () => app.workspaces.readUploadMetadata(identity.workspaceId, unknownOperationId, malformedHash),
      error => error?.code === 'UPLOAD_METADATA_INVALID',
    )
    await assert.rejects(
      () => app.workspaces.readUploadMetadata(identity.workspaceId, missingOperationId, malformedHash),
      error => error?.code === 'UPLOAD_NOT_FOUND',
    )
    const withMalformed = await app.workspaces.collectGarbage(identity.workspaceId, { now })
    assert.equal(withMalformed.preservedUnrecognizedUploads, 3)
    await assert.doesNotReject(() => readFile(join(staging, 'upload.json')))
    now += 86_400_001
    const after = await app.workspaces.collectGarbage(identity.workspaceId, { now })
    assert.equal(after.expiredUploads, 1)
    assert.equal(after.preservedUnrecognizedUploads, 3)
    await assert.rejects(() => readFile(join(staging, 'upload.json')), error => error?.code === 'ENOENT')
    assert.equal(await readFile(join(malformedStaging, 'upload.json'), 'utf8'), '{')
    assert.equal(JSON.parse(await readFile(join(unknownStaging, 'upload.json'), 'utf8')).futureField, true)
    assert.equal(await readFile(join(missingStaging, 'upload.json'), 'utf8').catch(error => error?.code), 'ENOENT')
    const status = await fetch(`${origin}${uploadPath}?protocolVersion=1&workspaceId=${encodeURIComponent(identity.workspaceId)}`, {
      headers: { cookie: identity.cookie },
    })
    assert.equal(status.status, 404)
  })

  it('conservatively retains legacy pending blobs without upload timestamps', async () => {
    const dataDir = await temporaryDirectory()
    const { origin, app } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const pending = await uploadWorkspaceBlob(origin, identity, Buffer.from('legacy pending blob'))
    const workspacePath = join(dataDir, 'workspace-v2', 'workspaces', `${identity.workspaceId}.json`)
    const record = JSON.parse(await readFile(workspacePath, 'utf8'))
    delete record.uploadedAt
    await writeFile(workspacePath, JSON.stringify(record))
    await app.close()
    liveApps.delete(app)

    const restarted = await start({ dataDir, llmMode: 'scripted' })
    const result = await restarted.app.workspaces.collectGarbage(identity.workspaceId, { now: Number.MAX_SAFE_INTEGER })
    assert.equal(result.expiredPending, 0)
    assert.equal(result.removedFiles, 0)
    assert.equal(await restarted.app.workspaces.blobStore.verify(pending.hash, pending.bytes), true)
  })

  it('fences write ownership and releases it on close', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const id = 'owner-session'
    const created = await post(origin, '/api/browser-native/session/create', envelope('owner-create', {
      sessionId: id,
      header: header(id),
    }))

    const resumed = await post(origin, '/api/browser-native/session/open', envelope('owner-resume', {
      sessionId: id,
      access: 'write',
      ownerToken: created.owner.ownerToken,
    }))
    assert.equal(resumed.owner.ownerToken, created.owner.ownerToken)

    const alreadyOwned = await failure(origin, '/api/browser-native/session/open', envelope('owner-open-conflict', {
      sessionId: id,
      access: 'write',
    }))
    assert.equal(alreadyOwned.code, 'SESSION_ALREADY_OWNED')

    const wrongOwner = await failure(origin, '/api/browser-native/session/append', envelope('wrong-owner', {
      sessionId: id,
      ownerToken: 'wrong-owner-token',
      expectedNextSeq: 0,
      events: [],
    }))
    assert.equal(wrongOwner.code, 'SESSION_OWNERSHIP_LOST')

    const closed = await post(origin, '/api/browser-native/session/close', envelope('owner-close', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
    }))
    assert.equal(closed.closed, true)

    const reopened = await post(origin, '/api/browser-native/session/open', envelope('owner-reopen', {
      sessionId: id,
      access: 'write',
    }))
    assert.equal(typeof reopened.owner.ownerToken, 'string')
    assert.notEqual(reopened.owner.ownerToken, created.owner.ownerToken)
  })

  it('reclaims an abandoned write owner after its lease expires', async () => {
    const dataDir = await temporaryDirectory()
    let now = 1_000
    const { origin } = await start({
      dataDir,
      llmMode: 'scripted',
      ownerLeaseMs: 300,
      testHooks: { now: () => now },
    })
    const id = 'expired-owner-session'
    const created = await post(origin, '/api/browser-native/session/create', envelope('expired-create', {
      sessionId: id,
      header: header(id),
    }))
    const beforeExpiry = await failure(origin, '/api/browser-native/session/open', envelope('expired-open-before', {
      sessionId: id,
      access: 'write',
    }))
    assert.equal(beforeExpiry.code, 'SESSION_ALREADY_OWNED')
    assert.equal(beforeExpiry.retryAfterMs, 300)

    now += 301
    const reclaimed = await post(origin, '/api/browser-native/session/open', envelope('expired-open-after', {
      sessionId: id,
      access: 'write',
    }))
    assert.notEqual(reclaimed.owner.ownerToken, created.owner.ownerToken)
    assert.equal(reclaimed.owner.leaseDurationMs, 300)
    assert.equal(reclaimed.owner.renewAfterMs, 100)

    const staleAppend = await failure(origin, '/api/browser-native/session/append', envelope('expired-stale-append', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      expectedNextSeq: 0,
      events: [],
    }))
    assert.equal(staleAppend.code, 'SESSION_OWNERSHIP_LOST')
    const staleClose = await failure(origin, '/api/browser-native/session/close', envelope('expired-stale-close', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
    }))
    assert.equal(staleClose.status, 409)
    assert.equal(staleClose.code, 'SESSION_OWNERSHIP_LOST')
    await post(origin, '/api/browser-native/session/append', envelope('reclaimed-append-after-stale-close', {
      sessionId: id,
      ownerToken: reclaimed.owner.ownerToken,
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'user/message', payload: { content: 'new owner remains writable' } }],
    }))
    await post(origin, '/api/browser-native/session/flush', envelope('reclaimed-flush-after-stale-close', {
      sessionId: id,
      ownerToken: reclaimed.owner.ownerToken,
    }))
    const durable = JSON.parse(await readFile(join(dataDir, 'sessions', `${id}.json`), 'utf8'))
    assert.equal(durable.events[0].payload.content, 'new owner remains writable')
    assert.equal(durable.durableThroughSeq, 0)
    const renewed = await post(origin, '/api/browser-native/session/renew', envelope('expired-renew', {
      sessionId: id,
      ownerToken: reclaimed.owner.ownerToken,
    }))
    assert.equal(renewed.owner.ownerToken, reclaimed.owner.ownerToken)

    now += 301
    const expiredClose = await post(origin, '/api/browser-native/session/close', envelope('expired-close', {
      sessionId: id,
      ownerToken: reclaimed.owner.ownerToken,
    }))
    assert.equal(expiredClose.closed, true)
    const afterExpiredClose = await post(origin, '/api/browser-native/session/open', envelope('expired-reopen', {
      sessionId: id,
      access: 'write',
    }))
    assert.notEqual(afterExpiredClose.owner.ownerToken, reclaimed.owner.ownerToken)
  })

  it('flushes on close and recovers only durable events after an abrupt restart', async () => {
    const dataDir = await temporaryDirectory()
    const first = await start({ dataDir, llmMode: 'scripted' })
    const durableId = 'durable-session'
    const durable = await post(first.origin, '/api/browser-native/session/create', envelope('durable-create', {
      sessionId: durableId,
      header: header(durableId),
    }))
    await post(first.origin, '/api/browser-native/session/append', envelope('durable-append', {
      sessionId: durableId,
      ownerToken: durable.owner.ownerToken,
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'user/message', payload: { content: 'persist me' } }],
    }))
    const closed = await post(first.origin, '/api/browser-native/session/close', envelope('durable-close', {
      sessionId: durableId,
      ownerToken: durable.owner.ownerToken,
    }))
    assert.match(closed.durabilityReceipt, /^durable-durable-session-0$/)

    const transientId = 'transient-session'
    const transient = await post(first.origin, '/api/browser-native/session/create', envelope('transient-create', {
      sessionId: transientId,
      header: header(transientId),
    }))
    await post(first.origin, '/api/browser-native/session/append', envelope('transient-append', {
      sessionId: transientId,
      ownerToken: transient.owner.ownerToken,
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'user/message', payload: { content: 'do not persist yet' } }],
    }))
    await first.app.close()
    liveApps.delete(first.app)

    const second = await start({ dataDir, llmMode: 'scripted' })
    const recovered = await post(second.origin, '/api/browser-native/session/read', envelope('durable-read', {
      sessionId: durableId,
      offset: 0,
    }))
    assert.equal(recovered.events.length, 1)
    assert.equal(recovered.events[0].payload.content, 'persist me')
    const record = JSON.parse(await readFile(join(dataDir, 'sessions', `${durableId}.json`), 'utf8'))
    assert.equal(record.durableThroughSeq, 0)

    const lost = await failure(second.origin, '/api/browser-native/session/read', envelope('transient-read', {
      sessionId: transientId,
      offset: 0,
    }))
    assert.equal(lost.code, 'SESSION_NOT_FOUND')
  })

  it('streams the scripted model and applies session owner fencing to LLM requests', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const id = 'llm-session'
    const created = await post(origin, '/api/browser-native/session/create', envelope('llm-create', {
      sessionId: id,
      header: header(id),
    }))
    const response = await fetch(`${origin}/api/browser-native/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope('llm-scripted', {
        sessionId: id,
        ownerToken: created.owner.ownerToken,
        provider: 'browser-native',
        model: 'browser-native',
        messages: [{ role: 'user', content: 'SCRIPTED_CONTRACT_PROMPT' }],
      })),
    })
    const items = await readNdjson(response)
    assert.equal(items.at(-1).chunk.type, 'finish')
    assert.match(items.map(item => item.chunk?.block?.text ?? item.chunk?.text ?? '').join(''), /SCRIPTED_CONTRACT_PROMPT/)

    const fenced = await failure(origin, '/api/browser-native/llm', envelope('llm-fenced', {
      sessionId: id,
      ownerToken: 'wrong-owner-token',
      messages: [{ role: 'user', content: 'must reject' }],
    }))
    assert.equal(fenced.code, 'SESSION_OWNERSHIP_LOST')
  })

  it('returns only non-secret model capacity metadata and validates auxiliary LLM purpose', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted', contextWindow: 4096 })
    const configResponse = await fetch(`${origin}/api/browser-native/config`)
    const config = await configResponse.json()
    assert.equal(configResponse.status, 200)
    assert.deepEqual(config, {
      protocolVersion: 1,
      llmMode: 'scripted',
      provider: 'scripted',
      model: 'browser-native-scripted',
      contextWindow: 4096,
    })
    assert.equal(JSON.stringify(config).includes('apiKey'), false)
    assert.equal(JSON.stringify(config).includes('baseUrl'), false)

    const validPurpose = await fetch(`${origin}/api/browser-native/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope('llm-purpose-valid', {
        provider: 'browser-native',
        model: 'browser-native',
        purpose: 'compaction',
        messages: [{ role: 'user', content: 'PURPOSE_ALLOWLIST_CONTRACT_PROMPT' }],
      })),
    })
    assert.equal((await readNdjson(validPurpose)).at(-1).chunk.type, 'finish')

    const invalidPurpose = await failure(origin, '/api/browser-native/llm', envelope('llm-purpose-invalid', {
      provider: 'browser-native',
      model: 'browser-native',
      purpose: 'arbitrary-routing-data',
      messages: [{ role: 'user', content: 'PURPOSE_INVALID_CONTRACT_PROMPT' }],
    }))
    assert.equal(invalidPurpose.code, 'INVALID_REQUEST')
  })

  it('injects partial scripted streams and observes client response cancellation', async () => {
    const dataDir = await temporaryDirectory()
    const closedBodies = []
    const { origin } = await start({
      dataDir,
      llmMode: 'scripted',
      testHooks: {
        scriptedLlmFault: body => {
          const text = JSON.stringify(body.messages)
          if (text.includes('PARTIAL_TEXT_CONTRACT_PROMPT')) return { kind: 'partial-text', text: 'PARTIAL_TEXT' }
          if (text.includes('PARTIAL_TOOL_CONTRACT_PROMPT')) return {
            kind: 'partial-tool-call',
            id: 'partial-tool-contract-call',
            name: 'write',
            argumentsDelta: '{"file_path":"/dsh/home/workspace/partial.txt","content":"incomplete',
          }
          if (text.includes('CANCEL_SCRIPTED_CONTRACT_PROMPT')) return {
            kind: 'delayed-text',
            delayMs: 5_000,
            text: 'CANCEL_SCRIPTED_CONTRACT_OK',
          }
          return undefined
        },
        onLlmClientClose: body => { closedBodies.push(body) },
      },
    })
    const partialText = await fetch(`${origin}/api/browser-native/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope('llm-partial-text', { messages: [{ role: 'user', content: 'PARTIAL_TEXT_CONTRACT_PROMPT' }] })),
    })
    const partialTextItems = await readNdjson(partialText)
    assert.equal(partialTextItems.at(-1).kind, 'error')
    assert.equal(partialTextItems.at(-1).error.code, 'UPSTREAM_LLM_TRUNCATED')
    assert.equal(partialTextItems.some(item => item.chunk?.type === 'block-end'), false)

    const partialTool = await fetch(`${origin}/api/browser-native/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope('llm-partial-tool', { messages: [{ role: 'user', content: 'PARTIAL_TOOL_CONTRACT_PROMPT' }] })),
    })
    const partialToolItems = await readNdjson(partialTool)
    assert.equal(partialToolItems.at(-1).kind, 'error')
    assert.equal(partialToolItems.at(-1).error.code, 'UPSTREAM_LLM_TRUNCATED')
    assert.equal(partialToolItems.some(item => item.chunk?.type === 'block-end'), false)

    const controller = new AbortController()
    const delayed = await fetch(`${origin}/api/browser-native/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope('llm-cancel-scripted', { messages: [{ role: 'user', content: 'CANCEL_SCRIPTED_CONTRACT_PROMPT' }] })),
      signal: controller.signal,
    })
    const reader = delayed.body.getReader()
    const first = await reader.read()
    assert.equal(first.done, false)
    controller.abort()
    await reader.cancel().catch(() => {})
    await waitUntil(() => closedBodies.some(body => JSON.stringify(body.messages).includes('CANCEL_SCRIPTED_CONTRACT_PROMPT')), 'scripted response close')
    assert.equal(closedBodies.length, 1)
  })

  it('proxies an OpenAI-compatible stream without exposing the backend secret', async () => {
    const upstream = createServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer contract-secret')
      const requestChunks = []
      for await (const chunk of request) requestChunks.push(chunk)
      const requestBody = JSON.parse(Buffer.concat(requestChunks).toString('utf8'))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (JSON.stringify(requestBody.messages).includes('EMPTY_CONTRACT_PROMPT')) {
        response.end([
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'))
        return
      }
      if (JSON.stringify(requestBody.messages).includes('EMPTY_DONE_CONTRACT_PROMPT')) {
        response.end(['data: [DONE]', ''].join('\n'))
        return
      }
      if (JSON.stringify(requestBody.messages).includes('DONE_WITH_CONTENT_CONTRACT_PROMPT')) {
        response.end([
          'data: {"choices":[{"delta":{"content":"DONE_WITH_CONTENT_OK"}}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'))
        return
      }
      response.end([
        'data: {"choices":[{"delta":{"content":"REAL_CONTRACT_OK"}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'))
    })
    const upstreamOrigin = await listen(upstream)
    try {
      const envFile = await temporaryDirectory('browser-native-v2-env-').then(async directory => {
        const file = join(directory, '.env')
        await writeFile(file, [
          `OPENAI_NEXT_GPT_BASE_URL=${upstreamOrigin}`,
          'OPENAI_NEXT_GPT_COMPLETIONS_PATH=/v1/chat/completions',
          'OPENAI_NEXT_GPT_MODEL=contract-model',
          `OPENAI_NEXT_GPT_${'API_KEY'}=contract-secret`,
          'HTTPS_PROXY=',
          '',
        ].join('\n'))
        return file
      })
      const dataDir = await temporaryDirectory()
      const { origin } = await start({ dataDir, llmMode: 'real', envFile })
      const response = await fetch(`${origin}/api/browser-native/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope('llm-real', {
          messages: [{ role: 'user', content: 'real contract prompt' }],
        })),
      })
      const body = await response.text()
      assert.equal(response.ok, true, body)
      assert.match(body, /REAL_CONTRACT_OK/)
      assert.equal(body.includes('contract-secret'), false)

      const emptyResponse = await fetch(`${origin}/api/browser-native/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope('llm-empty', {
          messages: [{ role: 'user', content: 'EMPTY_CONTRACT_PROMPT' }],
        })),
      })
      const emptyItems = await readNdjson(emptyResponse)
      assert.equal(emptyResponse.ok, true)
      assert.equal(emptyItems.at(-1).kind, 'error')
      assert.equal(emptyItems.at(-1).error.code, 'UPSTREAM_LLM_EMPTY')

      const emptyDoneResponse = await fetch(`${origin}/api/browser-native/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope('llm-empty-done', {
          messages: [{ role: 'user', content: 'EMPTY_DONE_CONTRACT_PROMPT' }],
        })),
      })
      const emptyDoneItems = await readNdjson(emptyDoneResponse)
      assert.equal(emptyDoneItems.at(-1).kind, 'error')
      assert.equal(emptyDoneItems.at(-1).error.code, 'UPSTREAM_LLM_EMPTY')

      const doneWithContentResponse = await fetch(`${origin}/api/browser-native/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope('llm-done-with-content', {
          messages: [{ role: 'user', content: 'DONE_WITH_CONTENT_CONTRACT_PROMPT' }],
        })),
      })
      const doneWithContentItems = await readNdjson(doneWithContentResponse)
      assert.equal(doneWithContentItems.at(-1).kind, 'chunk')
      assert.equal(doneWithContentItems.at(-1).chunk.type, 'finish')
      assert.equal(doneWithContentItems.at(-1).chunk.reason.kind, 'stop')
      assert.match(doneWithContentItems.map(item => item.chunk?.block?.text ?? item.chunk?.text ?? '').join(''), /DONE_WITH_CONTENT_OK/)
    } finally {
      await close(upstream)
    }
  })

  it('aborts a real upstream request when the browser-side LLM response is cancelled', async () => {
    let upstreamAborted = false
    let resolveUpstreamAbort
    const upstreamAbort = new Promise(resolve => { resolveUpstreamAbort = resolve })
    const upstream = createServer(async (request, response) => {
      request.on('aborted', () => {
        upstreamAborted = true
        resolveUpstreamAbort()
      })
      response.on('close', () => {
        if (!response.writableEnded) {
          upstreamAborted = true
          resolveUpstreamAbort()
        }
      })
      for await (const _chunk of request) {}
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"UPSTREAM_PARTIAL"}}]}\n\n')
    })
    const upstreamOrigin = await listen(upstream)
    try {
      const envFile = await temporaryDirectory('browser-native-v2-abort-env-').then(async directory => {
        const file = join(directory, '.env')
        await writeFile(file, [
          `OPENAI_NEXT_GPT_BASE_URL=${upstreamOrigin}`,
          'OPENAI_NEXT_GPT_COMPLETIONS_PATH=/v1/chat/completions',
          'OPENAI_NEXT_GPT_MODEL=abort-contract-model',
          'OPENAI_NEXT_GPT_API_KEY=abort-contract-secret',
          'HTTPS_PROXY=',
          '',
        ].join('\n'))
        return file
      })
      const dataDir = await temporaryDirectory()
      const { origin } = await start({ dataDir, llmMode: 'real', envFile })
      const controller = new AbortController()
      const response = await fetch(`${origin}/api/browser-native/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope('llm-upstream-abort', { messages: [{ role: 'user', content: 'ABORT_UPSTREAM_CONTRACT_PROMPT' }] })),
        signal: controller.signal,
      })
      const reader = response.body.getReader()
      const first = await reader.read()
      assert.equal(first.done, false)
      controller.abort()
      await reader.cancel().catch(() => {})
      await Promise.race([
        upstreamAbort,
        new Promise((_, reject) => setTimeout(() => reject(new Error('upstream request was not aborted')), 5_000)),
      ])
      assert.equal(upstreamAborted, true)
    } finally {
      await close(upstream)
    }
  })

  it('rejects malformed requests and never returns a provider secret', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const invalid = await failure(origin, '/api/browser-native/session/list', { protocolVersion: 1 })
    assert.equal(invalid.code, 'INVALID_REQUEST')

    const missing = await failure(origin, '/api/browser-native/session/read', envelope('missing', {
      sessionId: 'missing-session',
      offset: 0,
    }))
    assert.equal(missing.code, 'SESSION_NOT_FOUND')

    const response = await fetch(`${origin}/api/browser-native/health`)
    const body = await response.text()
    assert.equal(response.ok, true)
    assert.equal(body.includes('apiKey'), false)
    assert.equal(body.includes('secret'), false)
  })

  it('rotates resumed Workspace leases and fences stale writers', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const firstLease = await postWorkspace(origin, identity, 'lease', { operation: 'claim' })
    assert.equal(firstLease.response.ok, true, JSON.stringify(firstLease.value))
    assert.equal(typeof firstLease.value.writerToken, 'string')
    assert.equal(firstLease.value.fencingToken, 1)

    const resumeId = randomUUID()
    const resumed = await postWorkspace(origin, identity, 'lease', {
      operation: 'resume',
      resumeId,
      writerToken: firstLease.value.writerToken,
      fencingToken: firstLease.value.fencingToken,
    })
    assert.equal(resumed.response.ok, true, JSON.stringify(resumed.value))
    assert.equal(resumed.value.fencingToken, 2)
    assert.notEqual(resumed.value.writerToken, firstLease.value.writerToken)

    const resumedReplay = await postWorkspace(origin, identity, 'lease', {
      operation: 'resume',
      resumeId,
      writerToken: firstLease.value.writerToken,
      fencingToken: firstLease.value.fencingToken,
    })
    assert.equal(resumedReplay.response.ok, true, JSON.stringify(resumedReplay.value))
    assert.deepEqual(resumedReplay.value, resumed.value)

    const staleRenew = await postWorkspace(origin, identity, 'lease', {
      operation: 'renew',
      writerToken: firstLease.value.writerToken,
      fencingToken: firstLease.value.fencingToken,
    })
    assert.equal(staleRenew.response.status, 409)
    assert.equal(staleRenew.value.error.code, 'WORKSPACE_OWNERSHIP_LOST')

    const secondClaim = await postWorkspace(origin, identity, 'lease', { operation: 'claim' })
    assert.equal(secondClaim.response.status, 409)
    assert.equal(secondClaim.value.error.code, 'WORKSPACE_ALREADY_OWNED')

    const released = await postWorkspace(origin, identity, 'lease', {
      operation: 'release',
      writerToken: resumed.value.writerToken,
      fencingToken: resumed.value.fencingToken,
    })
    assert.equal(released.response.ok, true, JSON.stringify(released.value))
    const staleResumeReplay = await postWorkspace(origin, identity, 'lease', {
      operation: 'resume',
      resumeId,
      writerToken: firstLease.value.writerToken,
      fencingToken: firstLease.value.fencingToken,
    })
    assert.equal(staleResumeReplay.response.status, 409)
    assert.equal(staleResumeReplay.value.error.code, 'WORKSPACE_OWNERSHIP_LOST')
    const secondLease = await postWorkspace(origin, identity, 'lease', { operation: 'claim' })
    assert.equal(secondLease.response.ok, true, JSON.stringify(secondLease.value))
    assert.equal(secondLease.value.fencingToken, 3)

    const bytes = Buffer.from('writer fenced')
    const uploaded = await uploadWorkspaceBlob(origin, identity, bytes)
    const operationId = randomUUID()
    const staleCommit = await postWorkspace(origin, identity, 'commit', {
      operationId,
      baseRevision: 0,
      writerToken: firstLease.value.writerToken,
      fencingToken: firstLease.value.fencingToken,
      changes: [{ path: 'fenced.txt', kind: 'file', hash: uploaded.hash, bytes: uploaded.bytes, mode: 0o600 }],
    })
    assert.equal(staleCommit.response.status, 409)
    assert.equal(staleCommit.value.error.code, 'WORKSPACE_OWNERSHIP_LOST')

    const committed = await postWorkspace(origin, identity, 'commit', {
      operationId,
      baseRevision: 0,
      writerToken: secondLease.value.writerToken,
      fencingToken: secondLease.value.fencingToken,
      changes: [{ path: 'fenced.txt', kind: 'file', hash: uploaded.hash, bytes: uploaded.bytes, mode: 0o600 }],
    })
    assert.equal(committed.response.ok, true, JSON.stringify(committed.value))
    const queried = await fetch(`${origin}/api/browser-native/workspace/operation/${operationId}?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    const queryBody = await queried.json()
    assert.equal(queried.ok, true, JSON.stringify(queryBody))
    assert.equal(queryBody.found, true)
    assert.equal(queryBody.receipt.operationId, operationId)
    assert.equal(queryBody.receipt.revision, 1)
  })
})
