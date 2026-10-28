import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { WORKSPACE_BLOB_CHUNK_BYTES } from '../workspace-v2.mjs'

const liveApps = new Set()
const temporaryDirectories = new Set()
const originScopes = new Map()
const identitiesByScope = new Map()

async function temporaryDirectory(prefix = 'browser-native-v2-test-') {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.add(directory)
  return directory
}

async function start(options) {
  const app = await createBrowserNativeV2Server({ port: 0, ...options })
  const origin = await app.listen()
  originScopes.set(origin, options.dataDir === undefined ? origin : resolve(options.dataDir))
  liveApps.add(app)
  return { app, origin }
}

function envelope(requestId, extra = {}) {
  return { protocolVersion: 1, requestId, ...extra }
}

async function identityFor(origin) {
  const scope = originScopes.get(origin) ?? origin
  let identity = identitiesByScope.get(scope)
  if (identity === undefined) {
    identity = await openWorkspaceIdentity(origin)
    identitiesByScope.set(scope, identity)
  }
  return identity
}

async function postWithCookie(origin, path, body, cookie) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
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

async function post(origin, path, body) {
  const identity = path.startsWith('/api/browser-native/session/') ? await identityFor(origin) : undefined
  return await postWithCookie(origin, path, body, identity?.sessionCookie)
}

async function failure(origin, path, body) {
  try {
    await post(origin, path, body)
  } catch (error) {
    return error
  }
  assert.fail(`expected ${path} to fail`)
}

async function failureWithCookie(origin, path, body, cookie) {
  try {
    await postWithCookie(origin, path, body, cookie)
  } catch (error) {
    return error
  }
  assert.fail(`expected ${path} to fail`)
}

function header(id) {
  return { id, version: 1, createdAt: 1_700_000_000_000, cwd: '/workspace' }
}

function sessionEvent(seq, type, data, extra = {}) {
  return { seq, type, data, ...extra }
}

function handoffCheckpoint(sessionId, owner, nextSessionSeq) {
  return {
    sessionId,
    ownerId: 'browser-worker-1',
    epoch: owner.ownerEpoch,
    nextSessionSeq,
    workspaceRevision: 0,
    pendingOperationIds: [],
    pendingExecutionIds: [],
  }
}

function assistantMessage(turn, step, content) {
  return {
    turn,
    step,
    message: {
      id: `assistant-${turn}-${step}`,
      role: 'assistant',
      source: { kind: 'model', provider: 'test', model: 'test' },
      content,
    },
  }
}

function pendingToolEvents({ started = false } = {}) {
  const events = [
    sessionEvent(0, 'turn/start', { turn: 1 }),
    sessionEvent(1, 'step/start', { turn: 1, step: 1 }),
    sessionEvent(2, 'assistant/message', assistantMessage(1, 1, [
      { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' },
    ]), { surfaceOp: 'append' }),
  ]
  if (started) events.push(sessionEvent(3, 'tool/call', {
    turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}',
  }))
  return events
}

function settledToolEvents() {
  return [
    ...pendingToolEvents({ started: true }),
    sessionEvent(4, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'result-call-1',
        role: 'tool',
        toolCallId: 'call-1',
        isError: true,
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'text', text: 'The read failed.' }],
      },
      error: { name: 'Error', code: 'READ_FAILED' },
    }, { surfaceOp: 'append', sourceEventSeqs: [3] }),
    sessionEvent(5, 'step/end', { turn: 1, step: 1 }),
    sessionEvent(6, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'read failed', code: 'READ_FAILED' } } }),
  ]
}

async function createHandoffSession(origin, sessionId, events = []) {
  const created = await post(origin, '/api/browser-native/session/create', envelope(`${sessionId}-create`, {
    sessionId,
    header: header(sessionId),
    inheritedEventCount: 0,
  }))
  if (events.length > 0) {
    await post(origin, '/api/browser-native/session/append', envelope(`${sessionId}-events`, {
      sessionId,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      expectedNextSeq: 0,
      events,
    }))
    await post(origin, '/api/browser-native/session/flush', envelope(`${sessionId}-flush`, {
      sessionId,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
    }))
  }
  return created
}

async function requestHandoff(origin, sessionId, owner, eventCount, handoffId = `${sessionId}-handoff`) {
  return await post(origin, '/api/browser-native/session/handoff', envelope(`${handoffId}-request`, {
    sessionId,
    ownerToken: owner.ownerToken,
    ownerEpoch: owner.ownerEpoch,
    handoffId,
    checkpoint: handoffCheckpoint(sessionId, owner, eventCount),
  }))
}

async function assertRejectedHandoffPreservesOwner({ origin, dataDir, sessionId, owner, eventCount, code }) {
  const before = await readFile(join(dataDir, 'sessions', `${sessionId}.json`), 'utf8')
  const rejected = await failure(origin, '/api/browser-native/session/handoff', envelope(`${sessionId}-reject`, {
    sessionId,
    ownerToken: owner.ownerToken,
    ownerEpoch: owner.ownerEpoch,
    handoffId: `${sessionId}-rejected-handoff`,
    checkpoint: handoffCheckpoint(sessionId, owner, eventCount),
  }))
  assert.equal(rejected.code, code)
  const current = await post(origin, '/api/browser-native/session/read', envelope(`${sessionId}-read-after-reject`, {
    sessionId,
    offset: 0,
  }))
  assert.equal(current.ownerEpoch, owner.ownerEpoch)
  assert.equal(current.nextSeq, eventCount)
  const renewed = await post(origin, '/api/browser-native/session/open', envelope(`${sessionId}-owner-after-reject`, {
    sessionId,
    access: 'write',
    ownerToken: owner.ownerToken,
    ownerEpoch: owner.ownerEpoch,
  }))
  assert.equal(renewed.owner.ownerEpoch, owner.ownerEpoch)
  assert.equal(renewed.owner.ownerToken, owner.ownerToken)
  assert.equal(await readFile(join(dataDir, 'sessions', `${sessionId}.json`), 'utf8'), before)
  const retried = await failure(origin, '/api/browser-native/session/handoff', envelope(`${sessionId}-reject-retry`, {
    sessionId,
    ownerToken: owner.ownerToken,
    ownerEpoch: owner.ownerEpoch,
    handoffId: `${sessionId}-rejected-handoff`,
    checkpoint: handoffCheckpoint(sessionId, owner, eventCount),
  }))
  assert.equal(retried.code, code)
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
  const setCookies = response.headers.getSetCookie()
  assert.equal(setCookies.length, 2)
  const workspaceCookie = setCookies.find(cookie => cookie.startsWith('dsh-browser-native-principal='))
  const sessionCookie = setCookies.find(cookie => cookie.startsWith('dsh-browser-native-session-principal='))
  assert.match(workspaceCookie, /Path=\/api\/browser-native\/workspace;/)
  assert.match(sessionCookie, /Path=\/api\/browser-native\/session;/)
  assert.match(workspaceCookie, /Max-Age=31536000/)
  assert.match(sessionCookie, /Max-Age=31536000/)
  const identity = {
    workspaceId: body.workspaceId,
    cookie: workspaceCookie.split(';', 1)[0],
    sessionCookie: sessionCookie.split(';', 1)[0],
  }
  identitiesByScope.set(originScopes.get(origin) ?? origin, identity)
  return identity
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
  const cookie = path === '/api/browser-native/session/handoff' ? identity.sessionCookie : identity.cookie
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
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

async function failureAuthenticatedWorkspace(origin, identity, path, body) {
  try {
    await postAuthenticatedWorkspace(origin, identity, path, body)
  } catch (error) {
    return error
  }
  assert.fail(`expected ${path} to fail`)
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

  it('can lose the response after accepting a Session append', async () => {
    const dataDir = await temporaryDirectory()
    let dropped = false
    const { origin } = await start({
      dataDir,
      llmMode: 'scripted',
      testHooks: {
        dropSessionAppendResponse: () => {
          dropped = true
          return true
        },
      },
    })
    const id = 'session-append-response-lost'
    const created = await post(origin, '/api/browser-native/session/create', envelope('response-lost-create', {
      sessionId: id,
      header: header(id),
      inheritedEventCount: 0,
    }))
    const event = { seq: 0, type: 'user/message', payload: { content: 'accepted before response loss' } }
    const identity = await identityFor(origin)
    await assert.rejects(fetch(`${origin}/api/browser-native/session/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: identity.sessionCookie },
      body: JSON.stringify(envelope('response-lost-append', {
        sessionId: id,
        ownerToken: created.owner.ownerToken,
        ownerEpoch: created.owner.ownerEpoch,
        expectedNextSeq: 0,
        events: [event],
      })),
    }))
    assert.equal(dropped, true)
    const read = await post(origin, '/api/browser-native/session/read', envelope('response-lost-read', {
      sessionId: id,
      offset: 0,
    }))
    assert.deepEqual(read.events, [event])
    assert.equal(read.nextSeq, 1)
    assert.equal(read.durableThroughSeq, -1)
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
        pendingOperationIds: [],
        pendingExecutionIds: [],
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
    for (const operation of ['renew', 'flush', 'close']) {
      const staleWrite = await failure(origin, `/api/browser-native/session/${operation}`, envelope(`handoff-stale-${operation}`, {
        sessionId: id,
        ownerToken: oldOwner.ownerToken,
        ownerEpoch: oldOwner.ownerEpoch,
      }))
      assert.equal(staleWrite.code, 'SESSION_OWNERSHIP_LOST')
    }

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
    const storedAfterHandoff = JSON.parse(await readFile(join(dataDir, 'sessions', `${id}.json`), 'utf8'))
    assert.equal(JSON.stringify(storedAfterHandoff.handoffs).includes(created.owner.ownerToken), false)
    assert.equal(JSON.stringify(storedAfterHandoff.handoffs).includes(first.owner.ownerToken), false)
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
    assert.equal(replay.owner, null)
    assert.equal(replay.credentialStatus, 'not-replayed')
    assert.equal(replay.ownerEpoch, first.owner.ownerEpoch)

    const conflict = await failure(origin, '/api/browser-native/session/handoff', envelope('handoff-idempotent-conflict', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'same-handoff',
      checkpoint: { ...checkpoint, workspaceRevision: 1 },
    }))
    assert.equal(conflict.code, 'HANDOFF_CONFLICT')
  })

  it('binds an execution handoff receipt to durable Session and Workspace cursors', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const lease = await postWorkspace(origin, identity, 'lease', { operation: 'claim' })
    assert.equal(lease.response.ok, true, JSON.stringify(lease.value))
    const id = 'handoff-execution-checkpoint-session'
    const created = await post(origin, '/api/browser-native/session/create', envelope('handoff-execution-checkpoint-create', {
      sessionId: id,
      header: header(id),
      inheritedEventCount: 0,
    }))
    const checkpoint = {
      sessionId: id,
      ownerId: 'browser-worker-1',
      epoch: created.owner.ownerEpoch,
      nextSessionSeq: 0,
      durableThroughSeq: -1,
      workspaceId: identity.workspaceId,
      workspaceRevision: 0,
      workspaceFencingToken: lease.value.fencingToken,
      pendingWorkspaceReceipts: 0,
      pendingSessionEvents: 0,
      pendingOperationIds: [],
      pendingExecutionIds: [],
    }
    const pending = await failureAuthenticatedWorkspace(origin, identity, '/api/browser-native/session/handoff', envelope('handoff-execution-pending', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'execution-handoff',
      checkpoint: { ...checkpoint, pendingWorkspaceReceipts: 1 },
      workspaceWriterToken: lease.value.writerToken,
    }))
    assert.equal(pending.code, 'HANDOFF_BUSY')

    const behind = await failureAuthenticatedWorkspace(origin, identity, '/api/browser-native/session/handoff', envelope('handoff-execution-behind', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'execution-handoff',
      checkpoint: { ...checkpoint, durableThroughSeq: -2 },
      workspaceWriterToken: lease.value.writerToken,
    }))
    assert.equal(behind.code, 'CHECKPOINT_INVALID')

    const staleRevision = await failureAuthenticatedWorkspace(origin, identity, '/api/browser-native/session/handoff', envelope('handoff-execution-stale-workspace', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'execution-handoff',
      checkpoint: { ...checkpoint, workspaceRevision: 1 },
      workspaceWriterToken: lease.value.writerToken,
    }))
    assert.equal(staleRevision.code, 'WORKSPACE_REVISION_CONFLICT')
    const staleLease = await failureAuthenticatedWorkspace(origin, identity, '/api/browser-native/session/handoff', envelope('handoff-execution-stale-lease', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'execution-handoff',
      checkpoint,
      workspaceWriterToken: 'stale-workspace-token',
    }))
    assert.equal(staleLease.code, 'WORKSPACE_OWNERSHIP_LOST')

    const transferred = await postAuthenticatedWorkspace(origin, identity, '/api/browser-native/session/handoff', envelope('handoff-execution-valid', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'execution-handoff',
      checkpoint,
      workspaceWriterToken: lease.value.writerToken,
    }))
    assert.equal(transferred.owner.ownerEpoch, created.owner.ownerEpoch + 1)
    assert.deepEqual(transferred.checkpoint, checkpoint)

    const changedWorkspace = await failureAuthenticatedWorkspace(origin, identity, '/api/browser-native/session/handoff', envelope('handoff-execution-conflict', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'execution-handoff',
      checkpoint: { ...checkpoint, ownerId: 'browser-worker-2' },
      workspaceWriterToken: lease.value.writerToken,
    }))
    assert.equal(changedWorkspace.code, 'HANDOFF_CONFLICT')
  })

  it('rejects unsettled work before changing Session ownership', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const id = 'handoff-pending-work-session'
    const created = await post(origin, '/api/browser-native/session/create', envelope('handoff-pending-create', {
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
      pendingOperationIds: ['workspace-op-1'],
      pendingExecutionIds: [],
    }
    const pendingOperation = await failure(origin, '/api/browser-native/session/handoff', envelope('handoff-pending-operation', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'pending-operation',
      checkpoint,
    }))
    assert.equal(pendingOperation.code, 'HANDOFF_BUSY')

    const pendingExecution = await failure(origin, '/api/browser-native/session/handoff', envelope('handoff-pending-execution', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'pending-execution',
      checkpoint: { ...checkpoint, pendingOperationIds: [], pendingExecutionIds: ['tool-1'] },
    }))
    assert.equal(pendingExecution.code, 'HANDOFF_BUSY')

    const renewed = await post(origin, '/api/browser-native/session/open', envelope('handoff-pending-owner', {
      sessionId: id,
      access: 'write',
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
    }))
    assert.equal(renewed.owner.ownerEpoch, created.owner.ownerEpoch)
    const validHandoff = await post(origin, '/api/browser-native/session/handoff', envelope('handoff-pending-valid', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'pending-operation',
      checkpoint: { ...checkpoint, pendingOperationIds: [] },
    }))
    assert.equal(validHandoff.owner.ownerEpoch, created.owner.ownerEpoch + 1)
  })

  it('derives handoff busy state from open DSH turn and step events, ignoring empty caller pending lists', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const cases = [
      { id: 'handoff-open-turn', events: [sessionEvent(0, 'turn/start', { turn: 1 })] },
      { id: 'handoff-open-step', events: [
        sessionEvent(0, 'turn/start', { turn: 1 }),
        sessionEvent(1, 'step/start', { turn: 1, step: 1 }),
      ] },
      { id: 'handoff-assistant-tool-pending', events: pendingToolEvents() },
      { id: 'handoff-tool-result-pending', events: pendingToolEvents({ started: true }) },
    ]

    for (const item of cases) {
      const created = await createHandoffSession(origin, item.id, item.events)
      await assertRejectedHandoffPreservesOwner({
        origin,
        dataDir,
        sessionId: item.id,
        owner: created.owner,
        eventCount: item.events.length,
        code: 'HANDOFF_BUSY',
      })
    }
  })

  it('rejects malformed DSH turn, step, and tool-result sequences without publishing a receipt', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const cases = [
      {
        id: 'handoff-malformed-step',
        events: [
          sessionEvent(0, 'turn/start', { turn: 1 }),
          sessionEvent(1, 'step/start', { turn: 2, step: 1 }),
        ],
      },
      {
        id: 'handoff-orphan-tool-result',
        events: [
          sessionEvent(0, 'turn/start', { turn: 1 }),
          sessionEvent(1, 'step/start', { turn: 1, step: 1 }),
          sessionEvent(2, 'tool/result', {
            turn: 1,
            step: 1,
            message: {
              id: 'orphan-result',
              role: 'tool',
              toolCallId: 'missing-call',
              isError: true,
              source: { kind: 'tool', callId: 'missing-call' },
              content: [{ type: 'text', text: 'orphan' }],
            },
          }, { surfaceOp: 'append' }),
        ],
      },
      {
        id: 'handoff-orphan-tool-result-replacement',
        events: [sessionEvent(0, 'tool/result', {
          turn: 1,
          step: 1,
          message: {
            id: 'replacement-without-result',
            role: 'tool',
            toolCallId: 'missing-call',
            isError: true,
            source: { kind: 'tool', callId: 'missing-call' },
            content: [{ type: 'text', text: 'orphan replacement' }],
          },
        }, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] })],
      },
    ]

    for (const item of cases) {
      const created = await createHandoffSession(origin, item.id, item.events)
      await assertRejectedHandoffPreservesOwner({
        origin,
        dataDir,
        sessionId: item.id,
        owner: created.owner,
        eventCount: item.events.length,
        code: 'HANDOFF_STATE_INVALID',
      })
    }
  })

  it('allows handoff after a tool error result and terminal turn are recorded', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const id = 'handoff-settled-error-tool'
    const events = settledToolEvents()
    const created = await createHandoffSession(origin, id, events)
    const handoff = await requestHandoff(origin, id, created.owner, events.length)
    assert.equal(handoff.owner.ownerEpoch, created.owner.ownerEpoch + 1)
    assert.equal(handoff.checkpoint.nextSessionSeq, events.length)
  })

  it('allows compaction replacement of an already settled historical tool result', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const id = 'handoff-compacted-tool-result'
    const events = [
      ...settledToolEvents(),
      sessionEvent(7, 'turn/start', { turn: 2 }),
      sessionEvent(8, 'step/start', { turn: 2, step: 1 }),
      sessionEvent(9, 'tool/result', {
        ...structuredClone(settledToolEvents()[4].data),
        message: {
          ...structuredClone(settledToolEvents()[4].data.message),
          content: [{ type: 'text', text: 'Earlier result compacted.' }],
        },
      }, { surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, sourceEventSeqs: [4] }),
      sessionEvent(10, 'step/end', { turn: 2, step: 1 }),
      sessionEvent(11, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]
    const created = await createHandoffSession(origin, id, events)
    const handoff = await requestHandoff(origin, id, created.owner, events.length)
    assert.equal(handoff.owner.ownerEpoch, created.owner.ownerEpoch + 1)
  })

  it('scopes repeated tool call ids by turn and matches late compaction replacements to their source result', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const id = 'handoff-reused-tool-call-id'
    const firstTurn = settledToolEvents()
    const secondTurn = [
      sessionEvent(7, 'turn/start', { turn: 2 }),
      sessionEvent(8, 'step/start', { turn: 2, step: 1 }),
      sessionEvent(9, 'assistant/message', assistantMessage(2, 1, [
        { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' },
      ]), { surfaceOp: 'append' }),
      sessionEvent(10, 'tool/call', { turn: 2, step: 1, callId: 'call-1', name: 'read', arguments: '{}' }),
      sessionEvent(11, 'tool/result', {
        turn: 2,
        step: 1,
        message: {
          id: 'result-call-1-turn-2',
          role: 'tool',
          toolCallId: 'call-1',
          isError: true,
          source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'text', text: 'The second read failed.' }],
        },
        error: { name: 'Error', code: 'READ_FAILED' },
      }, { surfaceOp: 'append', sourceEventSeqs: [10] }),
      sessionEvent(12, 'step/end', { turn: 2, step: 1 }),
      sessionEvent(13, 'turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'read failed', code: 'READ_FAILED' } } }),
    ]
    const originalFirstResult = structuredClone(firstTurn[4].data)
    const events = [
      ...firstTurn,
      ...secondTurn,
      sessionEvent(14, 'tool/result', {
        ...originalFirstResult,
        message: { ...originalFirstResult.message, content: [{ type: 'text', text: 'First result compacted later.' }] },
      }, { surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, sourceEventSeqs: [4] }),
    ]
    const created = await createHandoffSession(origin, id, events)
    const handoff = await requestHandoff(origin, id, created.owner, events.length)
    assert.equal(handoff.owner.ownerEpoch, created.owner.ownerEpoch + 1)
  })

  it('ignores unrelated extension events when deriving DSH quiescence', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const id = 'handoff-extension-event'
    const events = [sessionEvent(0, 'extension/observed', { detail: 'not a turn boundary' })]
    const created = await createHandoffSession(origin, id, events)
    const handoff = await requestHandoff(origin, id, created.owner, events.length)
    assert.equal(handoff.owner.ownerEpoch, created.owner.ownerEpoch + 1)
  })

  it('serializes handoff against terminal Session append and requires a fresh cursor after either race', async () => {
    let heldRequestId
    let releaseHeldRequest
    let signalHeldRequest
    let queuedRequestId
    let signalQueuedRequest
    let heldRequestReached = new Promise(resolve => { signalHeldRequest = resolve })
    let queuedRequestReached = new Promise(resolve => { signalQueuedRequest = resolve })
    let heldRequestGate = new Promise(resolve => { releaseHeldRequest = resolve })
    const dataDir = await temporaryDirectory()
    const { origin } = await start({
      dataDir,
      llmMode: 'scripted',
      testHooks: {
        onSessionOperationQueued: (_operation, body) => {
          if (body.requestId === queuedRequestId) signalQueuedRequest()
        },
        beforeSessionOperation: async (_operation, body) => {
          if (body.requestId !== heldRequestId) return
          signalHeldRequest()
          await heldRequestGate
        },
      },
    })

    async function race({ id, heldOperation, expectedHandoffCode }) {
      const initialEvents = [
        sessionEvent(0, 'turn/start', { turn: 1 }),
        sessionEvent(1, 'step/start', { turn: 1, step: 1 }),
      ]
      const created = await createHandoffSession(origin, id, initialEvents)
      const terminalEvents = [
        sessionEvent(2, 'step/end', { turn: 1, step: 1 }),
        sessionEvent(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ]
      const appendRequestId = `${id}-terminal-append`
      const handoffRequestId = `${id}-racing-handoff`
      heldRequestId = heldOperation === 'append' ? appendRequestId : handoffRequestId
      queuedRequestId = heldOperation === 'append' ? handoffRequestId : appendRequestId
      heldRequestReached = new Promise(resolve => { signalHeldRequest = resolve })
      queuedRequestReached = new Promise(resolve => { signalQueuedRequest = resolve })
      heldRequestGate = new Promise(resolve => { releaseHeldRequest = resolve })

      const appendRequest = () => post(origin, '/api/browser-native/session/append', envelope(appendRequestId, {
        sessionId: id,
        ownerToken: created.owner.ownerToken,
        ownerEpoch: created.owner.ownerEpoch,
        expectedNextSeq: initialEvents.length,
        events: terminalEvents,
      }))
      const handoffRequest = () => post(origin, '/api/browser-native/session/handoff', envelope(handoffRequestId, {
        sessionId: id,
        ownerToken: created.owner.ownerToken,
        ownerEpoch: created.owner.ownerEpoch,
        handoffId: `${id}-handoff`,
        checkpoint: handoffCheckpoint(id, created.owner, initialEvents.length),
      }))
      const heldRequest = heldOperation === 'append' ? appendRequest() : handoffRequest()
      await heldRequestReached
      const queuedRequest = heldOperation === 'append' ? handoffRequest() : appendRequest()
      await queuedRequestReached
      releaseHeldRequest()
      const [heldResult, queuedResult] = await Promise.allSettled([heldRequest, queuedRequest])
      const appendResult = heldOperation === 'append' ? heldResult : queuedResult
      const handoffResult = heldOperation === 'handoff' ? heldResult : queuedResult
      assert.equal(appendResult.status, 'fulfilled')
      assert.equal(handoffResult.status, 'rejected')
      assert.equal(handoffResult.reason.code, expectedHandoffCode)
      const afterRace = await post(origin, '/api/browser-native/session/read', envelope(`${id}-read-race`, {
        sessionId: id,
        offset: 0,
      }))
      assert.equal(afterRace.nextSeq, initialEvents.length + terminalEvents.length)
      assert.equal(afterRace.ownerEpoch, created.owner.ownerEpoch)

      const retried = await requestHandoff(origin, id, created.owner, afterRace.nextSeq, `${id}-handoff`)
      assert.equal(retried.owner.ownerEpoch, created.owner.ownerEpoch + 1)
    }

    await race({ id: 'handoff-append-first', heldOperation: 'append', expectedHandoffCode: 'CHECKPOINT_INVALID' })
    await race({ id: 'handoff-first', heldOperation: 'handoff', expectedHandoffCode: 'HANDOFF_BUSY' })
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

  it('blocks writes after post-rename unknown durability and recovers from the published receipt', async () => {
    const dataDir = await temporaryDirectory()
    const first = await start({
      dataDir,
      llmMode: 'scripted',
      ownerLeaseMs: 300,
      testHooks: { failSessionFlushAfterRename: () => true },
    })
    const id = 'handoff-unknown-durability-session'
    const created = await post(first.origin, '/api/browser-native/session/create', envelope('handoff-unknown-create', {
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
    const unknown = await failure(first.origin, '/api/browser-native/session/handoff', envelope('handoff-unknown', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'post-rename-unknown',
      checkpoint,
    }))
    assert.equal(unknown.code, 'DURABILITY_UNKNOWN')
    const blockedAppend = await failure(first.origin, '/api/browser-native/session/append', envelope('handoff-unknown-write', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'user/message', payload: { content: 'must remain blocked' } }],
    }))
    assert.equal(blockedAppend.code, 'SESSION_RECOVERY_REQUIRED')
    const published = JSON.parse(await readFile(join(dataDir, 'sessions', `${id}.json`), 'utf8'))
    assert.equal(published.ownerEpoch, 2)
    assert.equal(JSON.stringify(published.handoffs).includes(created.owner.ownerToken), false)

    await first.app.close()
    liveApps.delete(first.app)
    const second = await start({ dataDir, llmMode: 'scripted', ownerLeaseMs: 300 })
    const recovered = await post(second.origin, '/api/browser-native/session/open', envelope('handoff-unknown-reopen', {
      sessionId: id,
      access: 'write',
    }))
    assert.equal(recovered.owner.ownerEpoch, 3)
    assert.notEqual(recovered.owner.ownerToken, created.owner.ownerToken)
    const accepted = await post(second.origin, '/api/browser-native/session/append', envelope('handoff-unknown-recovered-append', {
      sessionId: id,
      ownerToken: recovered.owner.ownerToken,
      ownerEpoch: recovered.owner.ownerEpoch,
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'user/message', payload: { content: 'recovered owner' } }],
    }))
    assert.equal(accepted.nextSeq, 1)
  })

  it('does not reissue a handoff token after a committed response is lost', async () => {
    const dataDir = await temporaryDirectory()
    let now = 1_800_000_000_000
    let dropResponse = true
    const first = await start({
      dataDir,
      llmMode: 'scripted',
      ownerLeaseMs: 300,
      testHooks: {
        now: () => now,
        dropSessionHandoffResponse: () => {
          if (!dropResponse) return false
          dropResponse = false
          return true
        },
      },
    })
    const id = 'handoff-lost-response-session'
    const created = await post(first.origin, '/api/browser-native/session/create', envelope('handoff-lost-response-create', {
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
    const identity = await identityFor(first.origin)
    await assert.rejects(fetch(`${first.origin}/api/browser-native/session/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: identity.sessionCookie },
      body: JSON.stringify(envelope('handoff-lost-response', {
        sessionId: id,
        ownerToken: created.owner.ownerToken,
        ownerEpoch: created.owner.ownerEpoch,
        handoffId: 'lost-response',
        checkpoint,
      })),
    }))
    const replay = await post(first.origin, '/api/browser-native/session/handoff', envelope('handoff-lost-response-retry', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      ownerEpoch: created.owner.ownerEpoch,
      handoffId: 'lost-response',
      checkpoint,
    }))
    assert.equal(replay.replayed, true)
    assert.equal(replay.owner, null)
    assert.equal(replay.credentialStatus, 'not-replayed')
    const stillOwned = await failure(first.origin, '/api/browser-native/session/open', envelope('handoff-lost-response-too-early', {
      sessionId: id,
      access: 'write',
    }))
    assert.equal(stillOwned.code, 'SESSION_ALREADY_OWNED')

    now += 301
    const recovered = await post(first.origin, '/api/browser-native/session/open', envelope('handoff-lost-response-claim', {
      sessionId: id,
      access: 'write',
    }))
    assert.equal(recovered.owner.ownerEpoch, 3)
    assert.notEqual(recovered.owner.ownerToken, created.owner.ownerToken)
    const persisted = JSON.parse(await readFile(join(dataDir, 'sessions', `${id}.json`), 'utf8'))
    assert.equal(JSON.stringify(persisted.handoffs).includes(created.owner.ownerToken), false)
    assert.equal(JSON.stringify(persisted.handoffs).includes(recovered.owner.ownerToken), false)
  })

  it('serializes simultaneous handoff retries and fences a competing handoff ID', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const id = 'handoff-concurrent-session'
    const created = await post(origin, '/api/browser-native/session/create', envelope('handoff-concurrent-create', {
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
    const sameIdResults = await Promise.all([
      post(origin, '/api/browser-native/session/handoff', envelope('handoff-concurrent-same-a', {
        sessionId: id, ownerToken: created.owner.ownerToken, ownerEpoch: created.owner.ownerEpoch,
        handoffId: 'same-concurrent-handoff', checkpoint,
      })),
      post(origin, '/api/browser-native/session/handoff', envelope('handoff-concurrent-same-b', {
        sessionId: id, ownerToken: created.owner.ownerToken, ownerEpoch: created.owner.ownerEpoch,
        handoffId: 'same-concurrent-handoff', checkpoint,
      })),
    ])
    assert.deepEqual(sameIdResults.map(result => result.replayed).sort(), [false, true])
    assert.equal(sameIdResults.filter(result => result.owner !== null).length, 1)
    assert.equal(sameIdResults.find(result => result.replayed).owner, null)
    assert.equal(sameIdResults.every(result => result.ownerEpoch === 2), true)

    const secondId = 'handoff-concurrent-distinct-session'
    const secondCreated = await post(origin, '/api/browser-native/session/create', envelope('handoff-concurrent-distinct-create', {
      sessionId: secondId,
      header: header(secondId),
      inheritedEventCount: 0,
    }))
    const secondCheckpoint = { ...checkpoint, sessionId: secondId }
    const distinctResults = await Promise.allSettled(['distinct-a', 'distinct-b'].map(handoffId =>
      post(origin, '/api/browser-native/session/handoff', envelope(`handoff-concurrent-${handoffId}`, {
        sessionId: secondId,
        ownerToken: secondCreated.owner.ownerToken,
        ownerEpoch: secondCreated.owner.ownerEpoch,
        handoffId,
        checkpoint: secondCheckpoint,
      })),
    ))
    assert.equal(distinctResults.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = distinctResults.find(result => result.status === 'rejected')
    assert.equal(rejected.reason.code, 'SESSION_OWNERSHIP_LOST')
  })

  it('scrubs legacy handoff bearer tokens before serving and fences the former owner', async () => {
    const dataDir = await temporaryDirectory()
    const id = 'handoff-legacy-migration-session'
    const sessionsDir = join(dataDir, 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    const seed = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(seed.origin)
    await seed.app.close()
    liveApps.delete(seed.app)
    const previousToken = 'legacy-previous-bearer-token'
    const nextToken = 'legacy-next-bearer-token'
    const checkpoint = {
      sessionId: id,
      ownerId: 'browser-worker-legacy',
      epoch: 1,
      nextSessionSeq: 0,
      workspaceRevision: 0,
      pendingOperationIds: [],
      pendingExecutionIds: [],
    }
    await writeFile(join(sessionsDir, `${id}.json`), JSON.stringify({
      id,
      principalId: identity.sessionCookie.split('=', 2)[1],
      header: header(id),
      inheritedEventCount: 0,
      events: [],
      durableThroughSeq: -1,
      ownerEpoch: 2,
      handoffs: {
        legacy: {
          fingerprint: JSON.stringify(checkpoint),
          receipt: {
            sessionId: id,
            previous: { sessionId: id, ownerToken: previousToken, ownerEpoch: 1 },
            next: { sessionId: id, ownerToken: nextToken, ownerEpoch: 2 },
            checkpoint,
            handoffId: 'legacy',
            durabilityReceipt: `durable-${id}-0`,
          },
        },
      },
    }))

    await assert.rejects(
      createBrowserNativeV2Server({ dataDir, llmMode: 'scripted', testHooks: { failSessionFlush: () => true } }),
      error => error.code === 'DURABILITY_FAILED',
    )
    const unmigrated = await readFile(join(sessionsDir, `${id}.json`), 'utf8')
    assert.equal(unmigrated.includes(previousToken), true)
    assert.equal(unmigrated.includes(nextToken), true)

    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const migrated = await readFile(join(sessionsDir, `${id}.json`), 'utf8')
    assert.equal(migrated.includes(previousToken), false)
    assert.equal(migrated.includes(nextToken), false)
    const opened = await postWithCookie(origin, '/api/browser-native/session/open', envelope('handoff-legacy-open', {
      sessionId: id,
      access: 'write',
    }), identity.sessionCookie)
    assert.equal(opened.owner.ownerEpoch, 3)
    const staleRetry = await failureWithCookie(origin, '/api/browser-native/session/handoff', envelope('handoff-legacy-retry', {
      sessionId: id,
      ownerToken: previousToken,
      ownerEpoch: 1,
      handoffId: 'legacy',
      checkpoint,
    }), identity.sessionCookie)
    assert.equal(staleRetry.code, 'SESSION_OWNERSHIP_LOST')
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

  it('scopes Session catalog, records, and durable restart to the issuing principal', async () => {
    const dataDir = await temporaryDirectory()
    let modelRequests = 0
    const first = await start({
      dataDir,
      llmMode: 'scripted',
      testHooks: { failLlmRequest: () => { modelRequests += 1; return true } },
    })
    const accountA = await openWorkspaceIdentity(first.origin)
    const accountB = await openWorkspaceIdentity(first.origin)
    const sessionA1 = 'principal-a-session-1'
    const sessionA2 = 'principal-a-session-2'
    const sessionB = 'principal-b-session-1'

    const createdA1 = await postWithCookie(first.origin, '/api/browser-native/session/create', envelope('principal-a-create-1', {
      sessionId: sessionA1,
      header: header(sessionA1),
      inheritedEventCount: 0,
    }), accountA.sessionCookie)
    await postWithCookie(first.origin, '/api/browser-native/session/append', envelope('principal-a-append', {
      sessionId: sessionA1,
      ownerToken: createdA1.owner.ownerToken,
      ownerEpoch: createdA1.owner.ownerEpoch,
      expectedNextSeq: 0,
      events: [sessionEvent(0, 'user/message', { content: 'private account A event' })],
    }), accountA.sessionCookie)
    await postWithCookie(first.origin, '/api/browser-native/session/flush', envelope('principal-a-flush', {
      sessionId: sessionA1,
      ownerToken: createdA1.owner.ownerToken,
      ownerEpoch: createdA1.owner.ownerEpoch,
    }), accountA.sessionCookie)
    for (const id of [sessionA2]) {
      const created = await postWithCookie(first.origin, '/api/browser-native/session/create', envelope(`principal-a-create-${id}`, {
        sessionId: id,
        header: header(id),
        inheritedEventCount: 0,
      }), accountA.sessionCookie)
      await postWithCookie(first.origin, '/api/browser-native/session/flush', envelope(`principal-a-flush-${id}`, {
        sessionId: id,
        ownerToken: created.owner.ownerToken,
        ownerEpoch: created.owner.ownerEpoch,
      }), accountA.sessionCookie)
    }
    const createdB = await postWithCookie(first.origin, '/api/browser-native/session/create', envelope('principal-b-create', {
      sessionId: sessionB,
      header: header(sessionB),
      inheritedEventCount: 0,
    }), accountB.sessionCookie)
    await postWithCookie(first.origin, '/api/browser-native/session/flush', envelope('principal-b-flush', {
      sessionId: sessionB,
      ownerToken: createdB.owner.ownerToken,
      ownerEpoch: createdB.owner.ownerEpoch,
    }), accountB.sessionCookie)

    const pageA = await postWithCookie(first.origin, '/api/browser-native/session/list', envelope('principal-a-list', { limit: 1 }), accountA.sessionCookie)
    assert.deepEqual(pageA.items.map(item => item.sessionId), [sessionA1])
    assert.equal(pageA.hasMore, true)
    const pageB = await postWithCookie(first.origin, '/api/browser-native/session/list', envelope('principal-b-list', { limit: 10 }), accountB.sessionCookie)
    assert.deepEqual(pageB.items.map(item => item.sessionId), [sessionB])
    assert.equal(pageB.hasMore, false)

    const crossCursor = await failureWithCookie(first.origin, '/api/browser-native/session/list', envelope('principal-b-cross-cursor', {
      limit: 10,
      cursor: pageA.nextCursor,
    }), accountB.sessionCookie)
    assert.equal(crossCursor.code, 'INVALID_REQUEST')
    for (const operation of ['read', 'stat', 'open']) {
      const denied = await failureWithCookie(first.origin, `/api/browser-native/session/${operation}`, envelope(`principal-b-${operation}`, {
        sessionId: sessionA1,
        access: 'read',
        offset: 0,
      }), accountB.sessionCookie)
      assert.equal(denied.code, 'SESSION_NOT_FOUND')
      assert.equal(denied.status, 404)
      assert.equal(denied.message, 'session does not exist')
    }
    const deniedCreate = await failureWithCookie(first.origin, '/api/browser-native/session/create', envelope('principal-b-create-foreign-id', {
      sessionId: sessionA1,
      header: header(sessionA1),
      inheritedEventCount: 0,
    }), accountB.sessionCookie)
    assert.equal(deniedCreate.code, 'SESSION_NOT_FOUND')

    const rawUnauthenticated = await fetch(`${first.origin}/api/browser-native/session/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope('principal-no-cookie-list')),
    })
    assert.equal(rawUnauthenticated.status, 401)

    const llmWithoutOwner = await fetch(`${first.origin}/api/browser-native/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope('principal-b-llm-without-owner', {
        sessionId: sessionA1,
        messages: [],
        tools: [],
      })),
    })
    assert.equal(llmWithoutOwner.status, 404)
    assert.equal((await llmWithoutOwner.json()).error.code, 'SESSION_NOT_FOUND')
    assert.equal(modelRequests, 0)

    const durable = JSON.parse(await readFile(join(dataDir, 'sessions', `${sessionA1}.json`), 'utf8'))
    assert.equal(durable.principalId, accountA.sessionCookie.split('=', 2)[1])
    assert.deepEqual(durable.events, [sessionEvent(0, 'user/message', { content: 'private account A event' })])

    await first.app.close()
    liveApps.delete(first.app)
    const second = await start({ dataDir, llmMode: 'scripted' })
    const restoredA = await postWithCookie(second.origin, '/api/browser-native/session/list', envelope('principal-a-list-after-restart', {
      limit: 10,
    }), accountA.sessionCookie)
    const restoredB = await postWithCookie(second.origin, '/api/browser-native/session/list', envelope('principal-b-list-after-restart', {
      limit: 10,
    }), accountB.sessionCookie)
    assert.deepEqual(restoredA.items.map(item => item.sessionId), [sessionA1, sessionA2])
    assert.deepEqual(restoredB.items.map(item => item.sessionId), [sessionB])
    const restoredRead = await postWithCookie(second.origin, '/api/browser-native/session/read', envelope('principal-a-read-after-restart', {
      sessionId: sessionA1,
      offset: 0,
    }), accountA.sessionCookie)
    assert.deepEqual(restoredRead.events, durable.events)
    const stillDenied = await failureWithCookie(second.origin, '/api/browser-native/session/read', envelope('principal-b-read-after-restart', {
      sessionId: sessionA1,
      offset: 0,
    }), accountB.sessionCookie)
    assert.equal(stillDenied.code, 'SESSION_NOT_FOUND')
  })

  it('keeps legacy Sessions without a durable principal inaccessible and unchanged', async () => {
    const dataDir = await temporaryDirectory()
    const sessionsDir = join(dataDir, 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    const id = 'legacy-unowned-session'
    const legacy = JSON.stringify({
      id,
      header: header(id),
      inheritedEventCount: 0,
      events: [sessionEvent(0, 'user/message', { content: 'legacy private event' })],
      durableThroughSeq: 0,
      ownerEpoch: 1,
      handoffs: {},
    })
    const path = join(sessionsDir, `${id}.json`)
    await writeFile(path, legacy)
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const list = await postWithCookie(origin, '/api/browser-native/session/list', envelope('legacy-unowned-list'), identity.sessionCookie)
    assert.deepEqual(list.items, [])
    const read = await failureWithCookie(origin, '/api/browser-native/session/read', envelope('legacy-unowned-read', {
      sessionId: id,
      offset: 0,
    }), identity.sessionCookie)
    assert.equal(read.code, 'SESSION_NOT_FOUND')
    const create = await failureWithCookie(origin, '/api/browser-native/session/create', envelope('legacy-unowned-create', {
      sessionId: id,
      header: header(id),
      inheritedEventCount: 0,
    }), identity.sessionCookie)
    assert.equal(create.code, 'SESSION_NOT_FOUND')
    assert.equal(await readFile(path, 'utf8'), legacy)
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
    assert.equal(replayed.ownerEpoch, handedOff.owner.ownerEpoch)
    assert.equal(replayed.owner, null)
    assert.equal(replayed.credentialStatus, 'not-replayed')
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
    const initialRevisionResponse = await fetch(
      `${origin}/api/browser-native/workspace/revision?protocolVersion=1&workspaceId=${identity.workspaceId}`,
      { headers: { cookie: identity.cookie } },
    )
    assert.equal(initialRevisionResponse.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await initialRevisionResponse.json(), {
      protocolVersion: 1,
      workspaceId: identity.workspaceId,
      revision: 0,
    })

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
    const revisionResponse = await fetch(
      `${origin}/api/browser-native/workspace/revision?protocolVersion=1&workspaceId=${identity.workspaceId}`,
      { headers: { cookie: identity.cookie } },
    )
    assert.equal(revisionResponse.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await revisionResponse.json(), {
      protocolVersion: 1,
      workspaceId: identity.workspaceId,
      revision: 1,
    })
    const downloaded = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes)
  })

  it('returns an authenticated revision-only response whose size does not depend on manifest entries', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const changes = Array.from({ length: 1_000 }, (_, index) => ({
      path: `entry-${String(index).padStart(4, '0')}`,
      kind: 'directory',
      mode: 0o755,
    }))
    const committed = await postWorkspace(origin, identity, 'commit', {
      operationId: randomUUID(),
      baseRevision: 0,
      changes,
    })
    assert.equal(committed.response.ok, true, JSON.stringify(committed.value))

    const query = `protocolVersion=1&workspaceId=${identity.workspaceId}`
    const manifestResponse = await fetch(`${origin}/api/browser-native/workspace/manifest?${query}`, {
      headers: { cookie: identity.cookie },
    })
    const manifestBytes = Buffer.byteLength(await manifestResponse.text())
    const revisionResponse = await fetch(`${origin}/api/browser-native/workspace/revision?${query}`, {
      headers: { cookie: identity.cookie },
    })
    const revisionBody = await revisionResponse.json()
    const revisionBytes = Buffer.byteLength(JSON.stringify(revisionBody))
    assert.equal(revisionResponse.headers.get('cache-control'), 'no-store')
    assert.deepEqual(revisionBody, { protocolVersion: 1, workspaceId: identity.workspaceId, revision: 1 })
    assert.equal(manifestBytes > revisionBytes * 100, true,
      `manifest=${manifestBytes} bytes, revision=${revisionBytes} bytes`)

    const unauthenticated = await fetch(`${origin}/api/browser-native/workspace/revision?${query}`)
    assert.equal(unauthenticated.status, 401)
    const foreign = await openWorkspaceIdentity(origin)
    const forbidden = await fetch(`${origin}/api/browser-native/workspace/revision?${query}`, {
      headers: { cookie: foreign.cookie },
    })
    assert.equal(forbidden.status, 403)
    const unsupported = await fetch(
      `${origin}/api/browser-native/workspace/revision?protocolVersion=99&workspaceId=${identity.workspaceId}`,
      { headers: { cookie: identity.cookie } },
    )
    assert.equal(unsupported.status, 400)
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
    const missingLookup = await fetch(`${first.origin}/api/browser-native/workspace/identity`, {
      headers: { 'x-browser-native-identity-mode': 'existing' },
    })
    assert.equal(missingLookup.status, 401)
    assert.equal((await missingLookup.json()).error.code, 'UNAUTHENTICATED')

    const owner = await openWorkspaceIdentity(first.origin)
    const existingLookup = await fetch(`${first.origin}/api/browser-native/workspace/identity`, {
      headers: {
        cookie: owner.cookie,
        'x-browser-native-identity-mode': 'existing',
      },
    })
    assert.equal(existingLookup.status, 200)
    assert.equal((await existingLookup.json()).workspaceId, owner.workspaceId)
    assert.equal(existingLookup.headers.get('set-cookie'), null)
    const other = await openWorkspaceIdentity(first.origin)
    assert.notEqual(owner.workspaceId, other.workspaceId)

    const denied = await fetch(`${first.origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${owner.workspaceId}`, {
      headers: { cookie: other.cookie },
    })
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).error.code, 'WORKSPACE_FORBIDDEN')
    const deniedRevision = await fetch(
      `${first.origin}/api/browser-native/workspace/revision?protocolVersion=1&workspaceId=${owner.workspaceId}`,
      { headers: { cookie: other.cookie } },
    )
    assert.equal(deniedRevision.status, 403)
    assert.equal((await deniedRevision.json()).error.code, 'WORKSPACE_FORBIDDEN')

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
    assert.equal(closed.durable, true)
    assert.equal(closed.durableThroughSeq, 0)
    assert.equal(closed.closed, true)

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

  it('expires Workspace writer leases against the injected clock', async () => {
    const dataDir = await temporaryDirectory()
    let now = 1_800_000_000_000
    const { origin } = await start({
      dataDir,
      llmMode: 'scripted',
      testHooks: { workspaceWriterLeaseMs: 300, workspaceNow: () => now },
    })
    const identity = await openWorkspaceIdentity(origin)
    const first = await postWorkspace(origin, identity, 'lease', { operation: 'claim' })
    assert.equal(first.response.ok, true, JSON.stringify(first.value))
    now += 301
    const staleRenew = await postWorkspace(origin, identity, 'lease', {
      operation: 'renew', writerToken: first.value.writerToken, fencingToken: first.value.fencingToken,
    })
    assert.equal(staleRenew.response.status, 409)
    assert.equal(staleRenew.value.error.code, 'WORKSPACE_OWNERSHIP_LOST')
    const reclaimed = await postWorkspace(origin, identity, 'lease', { operation: 'claim' })
    assert.equal(reclaimed.response.ok, true, JSON.stringify(reclaimed.value))
    assert.equal(reclaimed.value.fencingToken, first.value.fencingToken + 1)
  })
})
