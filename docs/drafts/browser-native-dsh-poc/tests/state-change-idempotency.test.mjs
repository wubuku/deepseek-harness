/**
 * Contract tests for state-changing PoC endpoints: a retried request with the
 * same requestId must replay its receipt or fail closed, and a duplicate must
 * never produce a second Session, event batch, share, workspace, writer lease,
 * or durable turn.
 *
 * The double-click Send path and the browser-side retry are covered separately
 * by `idempotent-send.e2e.mjs`; this file fixes the server-side contract.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const PROTOCOL_VERSION = 1
const SESSION_FORMAT_VERSION = 4

async function call(origin, cookie, path, { method = 'POST', body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => undefined)
  return { status: response.status, body: payload }
}

async function identity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const payload = await response.json()
  const cookies = response.headers.getSetCookie().map(value => value.split(';', 1)[0])
  const principal = cookies.find(value => value.startsWith('dsh-browser-native-principal='))
  assert.ok(principal, 'identity must mint a principal cookie')
  return {
    cookie: cookies.join('; '),
    principalId: principal.slice('dsh-browser-native-principal='.length),
    workspaceId: payload.workspaceId,
  }
}

function turnEvents(startSeq, turn) {
  return [
    { seq: startSeq, type: 'turn/start', data: { turn } },
    { seq: startSeq + 1, type: 'assistant/message', data: { content: [{ type: 'text', text: `turn ${String(turn)}` }] } },
    { seq: startSeq + 2, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ]
}

async function readEvents(origin, cookie, sessionId) {
  const read = await call(origin, cookie, '/api/browser-native/session/read', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), sessionId, offset: 0 },
  })
  assert.equal(read.status, 200, JSON.stringify(read.body))
  return read.body
}

async function startServer(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-idempotency-'))
  const app = await createBrowserNativeV2Server({ dataDir, llmMode: 'scripted' })
  t.after(async () => {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { app, origin: await app.listen(0) }
}

test('Session create, append, share, and import settle once per request key', async t => {
  const { origin } = await startServer(t)
  const owner = await identity(origin)
  const viewer = await identity(origin)
  const sessionId = 'idempotent-session-1'
  const header = { id: sessionId, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), cwd: '/workspace' }
  const createBody = { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), sessionId, header }

  const [created, createdAgain] = await Promise.all([
    call(origin, owner.cookie, '/api/browser-native/session/create', { body: createBody }),
    call(origin, owner.cookie, '/api/browser-native/session/create', { body: createBody }),
  ])
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.equal(createdAgain.status, 200, JSON.stringify(createdAgain.body))
  assert.deepEqual(created.body.owner, createdAgain.body.owner,
    'concurrent create duplicates must return the same owner lease')
  const listed = await call(origin, owner.cookie, '/api/browser-native/session/list', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), limit: 20 },
  })
  assert.equal(listed.status, 200)
  assert.equal(listed.body.items.filter(item => item.sessionId === sessionId).length, 1,
    'a replayed create must not add a second Session')

  const conflictingCreate = await call(origin, owner.cookie, '/api/browser-native/session/create', {
    body: { ...createBody, header: { ...header, createdAt: header.createdAt + 1 } },
  })
  assert.equal(conflictingCreate.status, 409)
  assert.equal(conflictingCreate.body.error.code, 'IDEMPOTENCY_CONFLICT')

  const lease = { ownerToken: created.body.owner.ownerToken, ownerEpoch: created.body.owner.ownerEpoch }
  const appendRequestId = randomUUID()
  const events = turnEvents(0, 1)
  const appendBody = {
    protocolVersion: PROTOCOL_VERSION, requestId: appendRequestId, sessionId, ...lease,
    expectedNextSeq: 0, events,
  }
  const appended = await call(origin, owner.cookie, '/api/browser-native/session/append', { body: appendBody })
  assert.equal(appended.status, 200, JSON.stringify(appended.body))
  const replayed = await call(origin, owner.cookie, '/api/browser-native/session/append', { body: appendBody })
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body))
  const { replayed: replayedFlag, ...replayedReceipt } = replayed.body
  assert.equal(replayedFlag, true, 'an append retry must report the replay')
  assert.deepEqual(replayedReceipt, appended.body, 'an append retry must replay the same receipt')
  assert.equal((await readEvents(origin, owner.cookie, sessionId)).events.length, 3,
    'an append retry must not write the events twice')

  const conflictingAppend = await call(origin, owner.cookie, '/api/browser-native/session/append', {
    body: {
      protocolVersion: PROTOCOL_VERSION, requestId: appendRequestId, sessionId, ...lease,
      expectedNextSeq: 3, events: turnEvents(3, 2),
    },
  })
  assert.equal(conflictingAppend.status, 409)
  assert.equal(conflictingAppend.body.error.code, 'IDEMPOTENCY_CONFLICT')

  const concurrentRequestId = randomUUID()
  const secondTurn = {
    protocolVersion: PROTOCOL_VERSION, requestId: concurrentRequestId, sessionId, ...lease,
    expectedNextSeq: 3, events: turnEvents(3, 2),
  }
  const [first, second] = await Promise.all([
    call(origin, owner.cookie, '/api/browser-native/session/append', { body: secondTurn }),
    call(origin, owner.cookie, '/api/browser-native/session/append', { body: secondTurn }),
  ])
  assert.deepEqual([first.status, second.status], [200, 200], `${JSON.stringify(first.body)} / ${JSON.stringify(second.body)}`)
  assert.equal([first.body, second.body].filter(body => body.replayed === true).length, 1,
    'exactly one concurrent duplicate applies and the other replays')
  assert.equal((await readEvents(origin, owner.cookie, sessionId)).events.length, 6,
    'a concurrent duplicate append must not add a second event batch')

  const shareBody = { sessionId, viewerPrincipalId: viewer.principalId }
  const granted = await call(origin, owner.cookie, '/api/browser-native/session/share', { body: shareBody })
  assert.equal(granted.status, 200, JSON.stringify(granted.body))
  assert.equal(granted.body.shares.length, 1)
  const grantedAgain = await call(origin, owner.cookie, '/api/browser-native/session/share', { body: shareBody })
  assert.equal(grantedAgain.status, 200, JSON.stringify(grantedAgain.body))
  assert.equal(grantedAgain.body.shares.length, 1, 'repeating the same share must not add a second grant')

  const exported = await call(origin, owner.cookie, '/api/browser-native/session/export', {
    body: { workspaceId: owner.workspaceId, sessionId },
  })
  assert.equal(exported.status, 200, JSON.stringify(exported.body))
  const imported = await call(origin, owner.cookie, '/api/browser-native/session/import', {
    body: { workspaceId: owner.workspaceId, bundle: exported.body },
  })
  assert.equal(imported.status, 409, 'importing the existing Session must fail closed')
  assert.equal(imported.body.error.code, 'SESSION_ALREADY_EXISTS')
  assert.equal((await readEvents(origin, owner.cookie, sessionId)).events.length, 6,
    'a rejected import must not change the existing Session')
  assert.equal((await readEvents(origin, owner.cookie, sessionId)).nextSeq, 6)
})

test('Workspace create and writer lease replay without a second workspace or writer', async t => {
  const { origin } = await startServer(t)
  const owner = await identity(origin)
  const createRequestId = randomUUID()
  const body = { protocolVersion: PROTOCOL_VERSION, requestId: createRequestId }

  const [created, createdAgain] = await Promise.all([
    call(origin, owner.cookie, '/api/browser-native/workspace/create', { body }),
    call(origin, owner.cookie, '/api/browser-native/workspace/create', { body }),
  ])
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.equal(createdAgain.status, 200, JSON.stringify(createdAgain.body))
  assert.equal(created.body.activeWorkspaceId, createdAgain.body.activeWorkspaceId,
    'a concurrent workspace create retry must return the same workspace')
  const switched = await call(origin, owner.cookie, '/api/browser-native/workspace/select', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), workspaceId: created.body.activeWorkspaceId },
  })
  assert.equal(switched.status, 200, JSON.stringify(switched.body))

  const workspaceId = created.body.activeWorkspaceId
  const leaseRequestId = randomUUID()
  const leaseBody = { protocolVersion: PROTOCOL_VERSION, requestId: leaseRequestId, workspaceId, operation: 'claim' }
  const [first, second] = await Promise.all([
    call(origin, owner.cookie, '/api/browser-native/workspace/lease', { body: leaseBody }),
    call(origin, owner.cookie, '/api/browser-native/workspace/lease', { body: leaseBody }),
  ])
  assert.deepEqual([first.status, second.status], [200, 200], `${JSON.stringify(first.body)} / ${JSON.stringify(second.body)}`)
  assert.equal(first.body.writerToken, second.body.writerToken, 'a claim retry must return the first writer token')
  assert.equal(first.body.fencingToken, second.body.fencingToken, 'a claim retry must not advance the fencing token')

  const competing = await call(origin, owner.cookie, '/api/browser-native/workspace/lease', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), workspaceId, operation: 'claim' },
  })
  assert.equal(competing.status, 409, 'a different request must still observe the active writer')
  assert.equal(competing.body.error.code, 'WORKSPACE_ALREADY_OWNED')

  const released = await call(origin, owner.cookie, '/api/browser-native/workspace/lease', {
    body: {
      protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), workspaceId, operation: 'release',
      writerToken: first.body.writerToken, fencingToken: first.body.fencingToken,
    },
  })
  assert.equal(released.status, 200, JSON.stringify(released.body))
  const reclaimed = await call(origin, owner.cookie, '/api/browser-native/workspace/lease', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: leaseRequestId, workspaceId, operation: 'claim' },
  })
  assert.equal(reclaimed.status, 200, JSON.stringify(reclaimed.body))
  assert.notEqual(reclaimed.body.writerToken, first.body.writerToken,
    'a released workspace must not replay the stale claim receipt')
})

test('Durable turn start replays instead of running a second turn', async t => {
  const { origin } = await startServer(t)
  const owner = await identity(origin)
  const turnId = 'idempotent-durable-turn-1'
  const sessionId = 'idempotent-durable-session-1'
  const startBody = {
    protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(),
    sessionId, turnId, prompt: 'durable idempotency probe',
  }
  const [first, second] = await Promise.all([
    call(origin, owner.cookie, '/api/browser-native/session/durable', { body: startBody }),
    call(origin, owner.cookie, '/api/browser-native/session/durable', { body: startBody }),
  ])
  assert.deepEqual([first.status, second.status].sort(), [200, 202],
    `one start begins the turn and the other replays it: ${JSON.stringify(first.body)} / ${JSON.stringify(second.body)}`)

  let status
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const read = await call(origin, owner.cookie, `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`, { method: 'GET' })
    assert.equal(read.status, 200, JSON.stringify(read.body))
    status = read.body
    if (status.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(status.status, 'completed', `the durable turn must finish: ${JSON.stringify(status)}`)

  const replay = await call(origin, owner.cookie, '/api/browser-native/session/durable', { body: startBody })
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.equal(replay.body.replayed, true, 'starting a finished turn with the same turnId must replay')

  const events = await readEvents(origin, owner.cookie, sessionId)
  assert.equal(events.events.filter(event => event.type === 'turn/start').length, 1,
    'the replayed durable start must not append a second turn')
  const stopped = await call(origin, owner.cookie, '/api/browser-native/session/durable/stop', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), turnId },
  })
  assert.equal(stopped.status, 202, JSON.stringify(stopped.body))
  const stoppedAgain = await call(origin, owner.cookie, '/api/browser-native/session/durable/stop', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), turnId },
  })
  assert.equal(stoppedAgain.status, 202, JSON.stringify(stoppedAgain.body))
  assert.equal((await readEvents(origin, owner.cookie, sessionId)).events.length, events.events.length,
    'a stop retry must not append events')
})
