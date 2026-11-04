import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const SESSION_COOKIE = 'dsh-browser-native-session-principal'

function cookiesFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie() : []
  return values.map(value => value.split(';', 1)[0]).join('; ')
}

function sessionPrincipal(cookie) {
  const prefix = `${SESSION_COOKIE}=`
  const pair = cookie.split('; ').find(value => value.startsWith(prefix))
  assert.ok(pair !== undefined, 'identity must set a Session principal cookie')
  return pair.slice(prefix.length)
}

async function request(origin, path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie === undefined ? {} : { cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify({
      protocolVersion: 1,
      requestId: randomUUID(),
      ...body,
    }) }),
  })
  const text = await response.text()
  let value
  try { value = text === '' ? {} : JSON.parse(text) } catch { value = { text } }
  return { status: response.status, value }
}

async function identity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  const value = await response.json()
  assert.equal(response.status, 200, JSON.stringify(value))
  const cookie = cookiesFrom(response)
  return { cookie, principalId: sessionPrincipal(cookie) }
}

async function openEventStream(origin, sessionId, cookie, fromSeq = 0) {
  const abort = new AbortController()
  const query = new URLSearchParams({ sessionId, fromSeq: String(fromSeq) })
  const response = await fetch(`${origin}/api/browser-native/session/events?${query.toString()}`, {
    headers: { cookie },
    signal: abort.signal,
  })
  assert.equal(response.status, 200, `event stream failed with ${String(response.status)}`)
  const lines = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const pump = (async () => {
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) if (part !== '') lines.push(JSON.parse(part))
      }
    } catch (error) {
      if (error.name !== 'AbortError') throw error
    }
  })()
  return { lines, abort, pump }
}

async function waitFor(condition, message) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

function streamEvents(stream) {
  return stream.lines.filter(line => line.kind === 'event').map(line => line.event)
}

function event(seq, content) {
  return { seq, type: 'user/message', payload: { content } }
}

test('a viewer replays and tails the event log, and ownership transfer leaves both principals consistent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-collaboration-stream-'))
  const app = await createBrowserNativeV2Server({ dataDir: join(root, 'backend'), llmMode: 'scripted' })
  const origin = await app.listen(0)
  const streams = []
  t.after(async () => {
    for (const stream of streams) {
      stream.abort.abort()
      await stream.pump.catch(() => {})
    }
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })

  const owner = await identity(origin)
  const viewer = await identity(origin)
  const stranger = await identity(origin)
  assert.notEqual(owner.principalId, viewer.principalId)

  const sessionId = randomUUID()
  const created = await request(origin, '/api/browser-native/session/create', {
    method: 'POST',
    body: { sessionId, header: { id: sessionId, version: 4, createdAt: Date.now(), cwd: '/dsh/home/workspace' } },
    cookie: owner.cookie,
  })
  assert.equal(created.status, 200, JSON.stringify(created.value))
  const firstOwner = created.value.owner

  const seeded = await request(origin, '/api/browser-native/session/append', {
    method: 'POST',
    body: {
      sessionId,
      expectedNextSeq: 0,
      ownerToken: firstOwner.ownerToken,
      ownerEpoch: firstOwner.ownerEpoch,
      events: [event(0, 'first event'), event(1, 'second event')],
    },
    cookie: owner.cookie,
  })
  assert.equal(seeded.status, 200, JSON.stringify(seeded.value))
  assert.equal(seeded.value.acceptedCount, 2)

  const shared = await request(origin, '/api/browser-native/session/share', {
    method: 'POST',
    body: { sessionId, viewerPrincipalId: viewer.principalId },
    cookie: owner.cookie,
  })
  assert.equal(shared.status, 200, JSON.stringify(shared.value))

  const viewerStream = await openEventStream(origin, sessionId, viewer.cookie)
  streams.push(viewerStream)
  await waitFor(() => streamEvents(viewerStream).length === 2, 'viewer must replay the two stored events')
  const ready = viewerStream.lines.find(line => line.kind === 'ready')
  assert.equal(ready.role, 'viewer')
  assert.equal(ready.nextSeq, 2)
  assert.deepEqual(streamEvents(viewerStream).map(entry => entry.seq), [0, 1])

  const live = await request(origin, '/api/browser-native/session/append', {
    method: 'POST',
    body: {
      sessionId,
      expectedNextSeq: 2,
      ownerToken: firstOwner.ownerToken,
      ownerEpoch: firstOwner.ownerEpoch,
      events: [event(2, 'third event'), event(3, 'fourth event')],
    },
    cookie: owner.cookie,
  })
  assert.equal(live.status, 200, JSON.stringify(live.value))
  await waitFor(() => streamEvents(viewerStream).length === 4, 'viewer must receive appended events without replaying')
  assert.deepEqual(streamEvents(viewerStream).map(entry => entry.seq), [0, 1, 2, 3])

  const transfer = await request(origin, '/api/browser-native/session/transfer', {
    method: 'POST',
    body: { sessionId, toPrincipalId: viewer.principalId },
    cookie: owner.cookie,
  })
  assert.equal(transfer.status, 200, JSON.stringify(transfer.value))
  assert.equal(transfer.value.transferred, true)
  assert.equal(transfer.value.fromPrincipalId, owner.principalId)
  assert.equal(transfer.value.toPrincipalId, viewer.principalId)

  const claimed = await request(origin, '/api/browser-native/session/open', {
    method: 'POST', body: { sessionId, access: 'write' }, cookie: viewer.cookie,
  })
  assert.equal(claimed.status, 200, JSON.stringify(claimed.value))
  const secondOwner = claimed.value.owner
  assert.ok(secondOwner !== null)

  const staleWrite = await request(origin, '/api/browser-native/session/append', {
    method: 'POST',
    body: {
      sessionId,
      expectedNextSeq: 4,
      ownerToken: firstOwner.ownerToken,
      ownerEpoch: firstOwner.ownerEpoch,
      events: [event(4, 'stale owner must not append')],
    },
    cookie: owner.cookie,
  })
  assert.equal(staleWrite.status, 403, JSON.stringify(staleWrite.value))
  assert.equal(staleWrite.value.error.code, 'SESSION_READ_ONLY')

  const continued = await request(origin, '/api/browser-native/session/append', {
    method: 'POST',
    body: {
      sessionId,
      expectedNextSeq: 4,
      ownerToken: secondOwner.ownerToken,
      ownerEpoch: secondOwner.ownerEpoch,
      events: [event(4, 'new owner continues')],
    },
    cookie: viewer.cookie,
  })
  assert.equal(continued.status, 200, JSON.stringify(continued.value))
  await waitFor(() => streamEvents(viewerStream).length === 5, 'the original viewer stream must keep tailing after transfer')

  const fromOldOwner = await request(origin, '/api/browser-native/session/read', {
    method: 'POST', body: { sessionId, offset: 0 }, cookie: owner.cookie,
  })
  assert.equal(fromOldOwner.status, 200, JSON.stringify(fromOldOwner.value))
  assert.equal(fromOldOwner.value.shared, true)
  assert.equal(fromOldOwner.value.nextSeq, 5)
  assert.deepEqual(fromOldOwner.value.events.map(entry => entry.seq), [0, 1, 2, 3, 4])

  const fromNewOwner = await request(origin, '/api/browser-native/session/read', {
    method: 'POST', body: { sessionId, offset: 0 }, cookie: viewer.cookie,
  })
  assert.equal(fromNewOwner.status, 200, JSON.stringify(fromNewOwner.value))
  assert.equal(fromNewOwner.value.nextSeq, 5)
  assert.deepEqual(fromNewOwner.value.events.map(entry => entry.seq), [0, 1, 2, 3, 4])

  const replayStream = await openEventStream(origin, sessionId, owner.cookie, 0)
  streams.push(replayStream)
  await waitFor(() => streamEvents(replayStream).length === 5, 'a later replay must reproduce the whole log')
  assert.deepEqual(streamEvents(replayStream).map(entry => entry.seq), [0, 1, 2, 3, 4])
  assert.equal(replayStream.lines.find(line => line.kind === 'ready').role, 'viewer')

  const sequences = streamEvents(viewerStream).map(entry => entry.seq)
  assert.equal(new Set(sequences).size, sequences.length, 'live delivery must not duplicate an event')

  const unshared = await request(origin, '/api/browser-native/session/transfer', {
    method: 'POST',
    body: { sessionId, toPrincipalId: stranger.principalId },
    cookie: viewer.cookie,
  })
  assert.equal(unshared.status, 409, JSON.stringify(unshared.value))
  assert.equal(unshared.value.error.code, 'SHARE_REQUIRED')

  const staleTransfer = await request(origin, '/api/browser-native/session/transfer', {
    method: 'POST',
    body: { sessionId, toPrincipalId: viewer.principalId },
    cookie: owner.cookie,
  })
  assert.equal(staleTransfer.status, 404, JSON.stringify(staleTransfer.value))
  assert.equal(staleTransfer.value.error.code, 'SESSION_NOT_FOUND')

  t.diagnostic(JSON.stringify({
    result: 'passed',
    replayEvents: 2,
    liveEvents: 2,
    postTransferEvents: 1,
    roles: { viewer: ready.role, replay: replayStream.lines.find(line => line.kind === 'ready').role },
    staleWrite: staleWrite.value.error.code,
    unsharedTransfer: unshared.value.error.code,
    staleTransfer: staleTransfer.value.error.code,
    totalSeq: sequences,
  }))
})
