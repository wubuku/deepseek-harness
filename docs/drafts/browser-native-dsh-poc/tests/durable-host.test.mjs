import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

/**
 * Read both principal cookies issued by the identity endpoint.
 * @param {string} origin - Loopback server origin.
 * @returns {Promise<{session: string, workspace: string, principal: string}>} Cookie header values.
 */
async function openIdentity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const cookies = response.headers.getSetCookie()
  const pick = name => {
    const cookie = cookies.find(value => value.startsWith(`${name}=`))
    assert.ok(cookie, `identity must issue ${name}`)
    return cookie.split(';')[0]
  }
  return {
    session: pick('dsh-browser-native-session-principal'),
    workspace: pick('dsh-browser-native-principal'),
    principal: cookies[0].split('=')[1].split(';')[0],
  }
}

async function request(origin, pathname, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ protocolVersion: 1, requestId: `test-${String(Date.now())}`, ...body }) }),
  })
  const payload = await response.json()
  return { status: response.status, body: payload }
}

test('durable host replays a turn without executing it twice and releases ownership for takeover', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-durable-host-'))
  const gate = Promise.withResolvers()
  const modelCalls = []
  const app = await createBrowserNativeV2Server({
    dataDir,
    llmMode: 'scripted',
    durableTurnTimeoutMs: 20_000,
    testHooks: {
      scriptedLlmFault: body => {
        const prompt = [...body.messages].reverse().find(message => message.role === 'user')?.content ?? ''
        if (prompt.includes('DURABLE_HOST_TEST_PRIMARY')) {
          modelCalls.push('primary')
          return {
            kind: 'barrier-text',
            release: gate.promise,
            onReleased: () => modelCalls.push('primary-released'),
            text: 'DURABLE_HOST_TEST_PRIMARY_DONE',
          }
        }
        modelCalls.push('second')
        return { kind: 'text', text: 'DURABLE_HOST_TEST_SECOND_DONE' }
      },
    },
  })
  let origin
  try {
    origin = await app.listen(0)
    const first = await openIdentity(origin)
    const sessionId = 'durable-session'
    const started = await request(origin, '/api/browser-native/session/durable', {
      method: 'POST',
      cookie: first.session,
      body: { sessionId, turnId: 'durable-turn-1', prompt: 'DURABLE_HOST_TEST_PRIMARY: reply with the marker only.' },
    })
    assert.equal(started.status, 202, JSON.stringify(started.body))
    assert.equal(started.body.status, 'running')
    assert.equal(started.body.turn, 1)

    const running = await request(origin, '/api/browser-native/session/durable?turnId=durable-turn-1', { cookie: first.session })
    assert.equal(running.status, 200)
    assert.equal(running.body.status, 'running')
    assert.equal(running.body.startedAt, started.body.startedAt)

    const replayWhileRunning = await request(origin, '/api/browser-native/session/durable', {
      method: 'POST',
      cookie: first.session,
      body: { sessionId, turnId: 'durable-turn-1', prompt: 'DURABLE_HOST_TEST_PRIMARY: replay must not re-run.' },
    })
    assert.equal(replayWhileRunning.status, 200)
    assert.equal(replayWhileRunning.body.status, 'running')
    assert.equal(replayWhileRunning.body.startedAt, started.body.startedAt)
    assert.equal(modelCalls.length, 1, 'a replay while running must not start another model request')

    const during = await request(origin, `/api/browser-native/session/read?sessionId=${sessionId}`, {
      method: 'POST',
      cookie: first.session,
      body: { sessionId, offset: 0 },
    })
    assert.equal(during.status, 200)
    assert.deepEqual(during.body.events.map(event => event.type), ['turn/start', 'user/message', 'step/start'])
    assert.equal(during.body.durableThroughSeq, 2)

    gate.resolve()
    let settled
    for (let attempt = 0; attempt < 200; attempt += 1) {
      settled = await request(origin, '/api/browser-native/session/durable?turnId=durable-turn-1', { cookie: first.session })
      if (settled.body.status === 'completed') break
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
    }
    assert.equal(settled.body.status, 'completed', JSON.stringify(settled.body))
    assert.deepEqual(modelCalls, ['primary', 'primary-released'], 'the durable turn must request the model exactly once')

    const final = await request(origin, `/api/browser-native/session/read?sessionId=${sessionId}`, {
      method: 'POST',
      cookie: first.session,
      body: { sessionId, offset: 0 },
    })
    assert.equal(final.status, 200)
    assert.equal(final.body.events.filter(event => event.type === 'turn/end').length, 1)
    assert.equal(final.body.events.find(event => event.type === 'assistant/message').data.message.content[0].text,
      'DURABLE_HOST_TEST_PRIMARY_DONE')
    assert.deepEqual(final.body.events.map(event => event.type),
      ['turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
    assert.equal(final.body.durableThroughSeq, 5)
    assert.equal(settled.body.nextSeq, 6)

    const replayAfterCompletion = await request(origin, '/api/browser-native/session/durable', {
      method: 'POST',
      cookie: first.session,
      body: { sessionId, turnId: 'durable-turn-1', prompt: 'DURABLE_HOST_TEST_PRIMARY: replay after completion.' },
    })
    assert.equal(replayAfterCompletion.status, 200)
    assert.equal(replayAfterCompletion.body.status, 'completed')
    assert.equal(modelCalls.length, 2, 'a completed turnId must never request the model again')

    const second = await request(origin, '/api/browser-native/session/durable', {
      method: 'POST',
      cookie: first.session,
      body: { sessionId, turnId: 'durable-turn-2', prompt: 'DURABLE_HOST_TEST_SECOND: reply with the marker only.' },
    })
    assert.equal(second.status, 202)
    assert.equal(second.body.turn, 2)
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const status = await request(origin, '/api/browser-native/session/durable?turnId=durable-turn-2', { cookie: first.session })
      if (status.body.status === 'completed') break
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
    }
    const afterSecond = await request(origin, `/api/browser-native/session/read?sessionId=${sessionId}`, {
      method: 'POST',
      cookie: first.session,
      body: { sessionId, offset: 0 },
    })
    assert.deepEqual(afterSecond.body.events.map(event => event.type), [
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end',
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
    assert.equal(afterSecond.body.events.filter(event => event.type === 'turn/end' && event.data.turn === 2).length, 1)

    const takeover = await request(origin, '/api/browser-native/session/open', {
      method: 'POST',
      cookie: first.session,
      body: { sessionId, access: 'write' },
    })
    assert.equal(takeover.status, 200, 'a reopened tab must be able to take over a settled durable Session')
    assert.equal(typeof takeover.body.owner.ownerToken, 'string')

    const secondPrincipal = await openIdentity(origin)
    const foreignStatus = await request(origin, '/api/browser-native/session/durable?turnId=durable-turn-1', {
      cookie: secondPrincipal.session,
    })
    assert.equal(foreignStatus.status, 404)
    assert.equal(foreignStatus.body.error.code, 'TURN_NOT_FOUND')

    const conflict = await request(origin, '/api/browser-native/session/durable', {
      method: 'POST',
      cookie: first.session,
      body: { sessionId: 'another-session', turnId: 'durable-turn-1', prompt: 'conflict' },
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.error.code, 'TURN_CONFLICT')

    const missing = await request(origin, '/api/browser-native/session/durable?turnId=durable-unknown', { cookie: first.session })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'TURN_NOT_FOUND')

    const browserOwned = await request(origin, '/api/browser-native/session/create', {
      method: 'POST',
      cookie: first.session,
      body: {
        sessionId: 'browser-owned',
        header: { id: 'browser-owned', version: 1, createdAt: Date.now(), cwd: '/workspace' },
      },
    })
    assert.equal(browserOwned.status, 200)
    const refused = await request(origin, '/api/browser-native/session/durable', {
      method: 'POST',
      cookie: first.session,
      body: { sessionId: 'browser-owned', turnId: 'durable-turn-3', prompt: 'refused' },
    })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error.code, 'SESSION_ALREADY_OWNED')

    process.stdout.write(`${JSON.stringify({
      result: 'passed',
      scope: 'durable-host-contract',
      modelCalls,
      turnOneStartSeqs: started.body.startSeqs,
      turnOneEndSeqs: settled.body.endSeqs,
      eventsAfterTurnOne: final.body.events.length,
      durableThroughSeq: final.body.durableThroughSeq,
      takeoverOwnerIssued: typeof takeover.body.owner.ownerToken === 'string',
      crossPrincipalStatus: foreignStatus.status,
      replayConflictStatus: conflict.status,
      browserOwnedRefusal: refused.body.error.code,
    })}\n`)
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
