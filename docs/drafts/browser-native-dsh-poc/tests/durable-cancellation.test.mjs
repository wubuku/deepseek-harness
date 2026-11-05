import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

/**
 * Read the session principal cookie issued by the identity endpoint.
 * @param {string} origin - Loopback server origin.
 * @returns {Promise<string>} Session principal cookie pair.
 */
async function openIdentity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const cookies = response.headers.getSetCookie()
  const cookie = cookies.find(value => value.startsWith('dsh-browser-native-session-principal='))
  assert.ok(cookie, 'identity must issue a session principal')
  return cookie.split(';')[0]
}

async function request(origin, pathname, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ protocolVersion: 1, requestId: `cancel-${String(Date.now())}`, ...body }) }),
  })
  const payload = await response.json()
  return { status: response.status, body: payload }
}

async function sessionEvents(origin, cookie, sessionId) {
  const read = await request(origin, '/api/browser-native/session/read', {
    method: 'POST',
    cookie,
    body: { sessionId, offset: 0 },
  })
  assert.equal(read.status, 200, JSON.stringify(read.body))
  return read.body.events
}

async function pollStatus(origin, cookie, turnId, predicate) {
  let last
  for (let attempt = 0; attempt < 200; attempt += 1) {
    last = await request(origin, `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`, { cookie })
    if (predicate(last)) return last
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  }
  return last
}

async function collectAttach(origin, cookie, turnId) {
  const response = await fetch(`${origin}/api/browser-native/session/durable/stream?turnId=${encodeURIComponent(turnId)}&fromSeq=0`, {
    headers: { cookie },
  })
  assert.equal(response.status, 200)
  const lines = []
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) if (part !== '') lines.push(JSON.parse(part))
  }
  if (buffer !== '') lines.push(JSON.parse(buffer))
  return {
    events: lines.filter(line => line.kind === 'event').map(line => ({
      seq: line.seq,
      time: line.time,
      type: line.type,
      ...(line.surfaceOp === undefined ? {} : { surfaceOp: line.surfaceOp }),
      data: line.data,
    })),
    settled: lines.find(line => line.kind === 'settled'),
  }
}

test('stop aborts an in-flight model request, settles the turn as aborted, and stays idempotent', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-durable-cancel-'))
  const gate = Promise.withResolvers()
  const modelEntered = Promise.withResolvers()
  let modelRequests = 0
  let clientClosed = 0
  const app = await createBrowserNativeV2Server({
    dataDir,
    llmMode: 'scripted',
    durableTurnTimeoutMs: 20_000,
    testHooks: {
      scriptedLlmFault: () => {
        modelRequests += 1
        modelEntered.resolve()
        return { kind: 'barrier-text', release: gate.promise, text: 'CANCEL_MUST_NOT_APPEAR' }
      },
      onLlmClientClose: () => { clientClosed += 1 },
    },
  })
  let origin
  try {
    origin = await app.listen(0)
    const cookie = await openIdentity(origin)
    const sessionId = 'durable-cancel-session'
    const turnId = 'durable-cancel-turn-1'
    const started = await request(origin, '/api/browser-native/session/durable', {
      method: 'POST',
      cookie,
      body: { sessionId, turnId, prompt: 'DURABLE_CANCEL: wait for a stop.' },
    })
    assert.equal(started.status, 202, JSON.stringify(started.body))
    await modelEntered.promise

    const stopped = await request(origin, '/api/browser-native/session/durable/stop', {
      method: 'POST',
      cookie,
      body: { turnId },
    })
    assert.equal(stopped.status, 202, JSON.stringify(stopped.body))
    assert.equal(stopped.body.cancelRequested, true)

    const settled = await pollStatus(origin, cookie, turnId, status => status.body.status !== 'running')
    assert.equal(settled.status, 200, JSON.stringify(settled.body))
    assert.equal(settled.body.status, 'cancelled', JSON.stringify(settled.body))
    assert.equal(settled.body.error.code, 'DURABLE_TURN_CANCELLED')
    assert.equal(modelRequests, 1, 'cancellation must not start another model request')
    assert.equal(clientClosed, 1, 'the aborted model request must be observed as a client disconnect')

    const events = await sessionEvents(origin, cookie, sessionId)
    assert.deepEqual(events.map(event => event.type), ['turn/start', 'user/message', 'step/start', 'step/end', 'turn/end'])
    for (const [index, event] of events.entries()) assert.equal(event.seq, index, 'cancelled turn events must stay contiguous')
    const end = events.at(-1)
    assert.equal(end.data.reason.kind, 'aborted', JSON.stringify(end))
    assert.equal(end.data.reason.reason.kind, 'user')
    assert.equal(events.filter(event => event.type === 'assistant/message').length, 0)

    const attached = await collectAttach(origin, cookie, turnId)
    assert.deepEqual(attached.events, events, 'the attach stream must replay the cancelled turn exactly')
    assert.equal(attached.settled.status, 'cancelled')

    const repeated = await request(origin, '/api/browser-native/session/durable/stop', {
      method: 'POST',
      cookie,
      body: { turnId },
    })
    assert.equal(repeated.status, 202)
    assert.equal(repeated.body.status, 'cancelled')
    assert.deepEqual(await sessionEvents(origin, cookie, sessionId), events, 'a repeated stop must not append events')

    const replay = await request(origin, '/api/browser-native/session/durable', {
      method: 'POST',
      cookie,
      body: { sessionId, turnId, prompt: 'DURABLE_CANCEL replay.' },
    })
    assert.equal(replay.status, 200)
    assert.equal(replay.body.status, 'cancelled')
    assert.equal(modelRequests, 1)

    const foreignCookie = await openIdentity(origin)
    const foreign = await request(origin, '/api/browser-native/session/durable/stop', {
      method: 'POST',
      cookie: foreignCookie,
      body: { turnId },
    })
    assert.equal(foreign.status, 404)
    assert.equal(foreign.body.error.code, 'TURN_NOT_FOUND')

    const unknown = await request(origin, '/api/browser-native/session/durable/stop', {
      method: 'POST',
      cookie,
      body: { turnId: 'durable-cancel-unknown' },
    })
    assert.equal(unknown.status, 404)

    const anonymous = await request(origin, '/api/browser-native/session/durable/stop', {
      method: 'POST',
      body: { turnId },
    })
    assert.equal(anonymous.status, 401)

    let takeover
    for (let attempt = 0; attempt < 100; attempt += 1) {
      takeover = await request(origin, '/api/browser-native/session/open', {
        method: 'POST',
        cookie,
        body: { sessionId, access: 'write' },
      })
      if (takeover.status === 200) break
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
    }
    assert.equal(takeover.status, 200, 'a cancelled turn must release its Session lease')

    const metrics = await request(origin, '/api/browser-native/observability/metrics')
    assert.equal(metrics.status, 200)
    assert.equal(metrics.body.durableTurns.cancelled, 1)
    const prometheus = await fetch(`${origin}/api/browser-native/observability/metrics?format=prometheus`)
    const text = await prometheus.text()
    assert.match(text, /dsh_browser_native_durable_turns_cancelled 1/)

    process.stdout.write(`${JSON.stringify({
      result: 'passed',
      scope: 'durable-cancellation',
      status: settled.body.status,
      errorCode: settled.body.error.code,
      events: events.length,
      turnEndReason: end.data.reason,
      modelRequests,
      clientClosed,
      repeatedStopStatus: repeated.body.status,
      foreignStop: foreign.status,
      anonymousStop: anonymous.status,
      leaseTakeover: takeover.status,
      cancelledGauge: metrics.body.durableTurns.cancelled,
    })}\n`)
  } finally {
    gate.resolve()
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
