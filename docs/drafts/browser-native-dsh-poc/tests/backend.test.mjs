import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createBrowserNativeServer } from '../backend.mjs'
import { MAX_DURABLE_EVENTS } from '../protocol.mjs'

const live = new Set()

async function start(dataDir) {
  const app = await createBrowserNativeServer({ dataDir })
  const origin = await app.listen()
  live.add(app)
  return { app, origin }
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
    throw error
  }
  return value
}

async function postFailure(origin, path, body) {
  try {
    await post(origin, path, body)
  } catch (error) {
    return error
  }
  assert.fail(`expected ${path} to fail`)
}

function envelope(requestId, extra) {
  return { protocolVersion: 1, requestId, ...extra }
}

afterEach(async () => {
  for (const app of live) {
    await app.close()
    live.delete(app)
  }
})

describe('browser-native PoC backend', () => {
  it('flushes a visible session and reopens it after a backend restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const first = await start(dataDir)
      const createRequest = envelope('create-1', {
        sessionId: 'session-restart',
        header: { sessionId: 'session-restart', version: 1, cwd: '/workspace' },
        inheritedEventCount: 0,
      })
      const created = await post(first.origin, '/api/browser-native/session/create', createRequest)
      assert.equal(created.inheritedEventCount, 0)
      assert.equal(created.header.sessionId, 'session-restart')
      assert.equal(typeof created.backendRevision, 'string')
      const event = { seq: 0, type: 'user.message', payload: { content: 'hello' }, at: new Date().toISOString() }
      const appended = await post(first.origin, '/api/browser-native/session/append', envelope('append-1', {
        sessionId: 'session-restart', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        expectedNextSeq: 0, events: [event],
      }))
      assert.equal(appended.acceptedFromSeq, 0)
      assert.equal(appended.acceptedCount, 1)
      assert.equal(appended.nextSeq, 1)
      const replayed = await post(first.origin, '/api/browser-native/session/append', envelope('append-1', {
        sessionId: 'session-restart', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        expectedNextSeq: 0, events: [event],
      }))
      assert.deepEqual(replayed, appended)
      const flushed = await post(first.origin, '/api/browser-native/session/flush', envelope('flush-1', {
        sessionId: 'session-restart', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
      }))
      assert.equal(flushed.durable, true)
      assert.equal(flushed.durableThroughSeq, 0)
      await first.app.close()
      live.delete(first.app)

      const second = await start(dataDir)
      const duplicateCreate = await postFailure(second.origin, '/api/browser-native/session/create', createRequest)
      assert.equal(duplicateCreate.code, 'SESSION_ALREADY_EXISTS')
      const opened = await post(second.origin, '/api/browser-native/session/open', envelope('open-1', {
        sessionId: 'session-restart', access: 'write',
      }))
      assert.equal(opened.inheritedEventCount, 0)
      assert.equal(opened.header.sessionId, 'session-restart')
      const replayedFlush = await post(second.origin, '/api/browser-native/session/flush', envelope('flush-1', {
        sessionId: 'session-restart', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
      }))
      assert.deepEqual(replayedFlush, flushed)
      const read = await post(second.origin, '/api/browser-native/session/read', envelope('read-1', {
        sessionId: 'session-restart', offset: 0,
      }))
      assert.equal(opened.nextSeq, 1)
      assert.equal(read.durableThroughSeq, 0)
      assert.deepEqual(read.events.map(item => item.type), ['user.message'])
      const stat = await fetch(`${second.origin}/api/browser-native/session/stat?protocolVersion=1&sessionId=session-restart`)
      const statBody = await stat.json()
      assert.equal(statBody.header.sessionId, 'session-restart')
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('releases and removes an empty session on graceful close', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const { origin, app } = await start(dataDir)
      const created = await post(origin, '/api/browser-native/session/create', envelope('create-empty', {
        sessionId: 'session-empty', header: { sessionId: 'session-empty', version: 1 }, inheritedEventCount: 0,
      }))
      const closed = await post(origin, '/api/browser-native/session/close', envelope('close-empty', {
        sessionId: 'session-empty', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
      }))
      assert.equal(closed.closed, true)
      assert.equal(closed.ownerReleased, true)
      assert.equal(app.store.sessions.has('session-empty'), false)
      const reopened = await postFailure(origin, '/api/browser-native/session/open', envelope('open-empty', {
        sessionId: 'session-empty', access: 'read',
      }))
      assert.equal(reopened.code, 'SESSION_NOT_FOUND')
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('fences a second writer, renews the owner, and rejects stale mutations', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const { origin } = await start(dataDir)
      const created = await post(origin, '/api/browser-native/session/create', envelope('create-owner', {
        sessionId: 'session-owner', header: { sessionId: 'session-owner', version: 1 }, inheritedEventCount: 0,
      }))
      const conflict = await postFailure(origin, '/api/browser-native/session/open', envelope('open-owner-2', {
        sessionId: 'session-owner', access: 'write',
      }))
      assert.equal(conflict.code, 'SESSION_ALREADY_OWNED')
      const renewed = await post(origin, '/api/browser-native/session/renew', envelope('renew-owner', {
        sessionId: 'session-owner', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
      }))
      assert.equal(renewed.owner.generation, created.owner.generation)
      assert.equal(typeof renewed.backendRevision, 'string')
      const stale = await postFailure(origin, '/api/browser-native/session/append', envelope('append-stale', {
        sessionId: 'session-owner', ownerToken: 'stale-token', generation: created.owner.generation,
        expectedNextSeq: 0, events: [],
      }))
      assert.equal(stale.code, 'SESSION_OWNERSHIP_LOST')
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('flushes and releases ownership on close, then permits a new writer', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const first = await start(dataDir)
      const created = await post(first.origin, '/api/browser-native/session/create', envelope('create-close', {
        sessionId: 'session-close', header: { sessionId: 'session-close', version: 1 }, inheritedEventCount: 0,
      }))
      await post(first.origin, '/api/browser-native/session/append', envelope('append-close', {
        sessionId: 'session-close', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        expectedNextSeq: 0, events: [{ seq: 0, type: 'user.message', payload: { content: 'close me' } }],
      }))
      const closed = await post(first.origin, '/api/browser-native/session/close', envelope('close-1', {
        sessionId: 'session-close', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
      }))
      assert.equal(closed.closed, true)
      assert.equal(closed.ownerReleased, true)
      assert.equal(closed.durableThroughSeq, 0)
      await first.app.close()
      live.delete(first.app)
      const second = await start(dataDir)
      const replayedClose = await post(second.origin, '/api/browser-native/session/close', envelope('close-1', {
        sessionId: 'session-close', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
      }))
      assert.deepEqual(replayedClose, closed)
      const reopened = await post(second.origin, '/api/browser-native/session/open', envelope('open-close', {
        sessionId: 'session-close', access: 'write',
      }))
      assert.ok(reopened.owner.ownerToken)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('expires a crashed owner and fences its later mutation', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const { origin, app } = await start(dataDir)
      const created = await post(origin, '/api/browser-native/session/create', envelope('create-expiry', {
        sessionId: 'session-expiry', header: { sessionId: 'session-expiry', version: 1 }, inheritedEventCount: 0,
      }))
      const session = app.store.sessions.get('session-expiry')
      session.leaseExpiresAt = Date.now() - 1
      const stale = await postFailure(origin, '/api/browser-native/session/append', envelope('append-expired', {
        sessionId: 'session-expiry', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        expectedNextSeq: 0, events: [],
      }))
      assert.equal(stale.code, 'SESSION_OWNERSHIP_LOST')
      const reopened = await post(origin, '/api/browser-native/session/open', envelope('open-expiry', {
        sessionId: 'session-expiry', access: 'write',
      }))
      assert.equal(reopened.owner.generation, created.owner.generation + 1)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('replays a committed mutation after the original owner lease expires', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const { origin, app } = await start(dataDir)
      const created = await post(origin, '/api/browser-native/session/create', envelope('create-replay-expiry', {
        sessionId: 'session-replay-expiry', header: { sessionId: 'session-replay-expiry', version: 1 }, inheritedEventCount: 0,
      }))
      const request = envelope('append-replay-expiry', {
        sessionId: 'session-replay-expiry', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        expectedNextSeq: 0, events: [{ seq: 0, type: 'user.message', payload: { content: 'once' } }],
      })
      const appended = await post(origin, '/api/browser-native/session/append', request)
      assert.equal(appended.nextSeq, 1)
      app.store.sessions.get('session-replay-expiry').leaseExpiresAt = Date.now() - 1
      const replay = await post(origin, '/api/browser-native/session/append', request)
      assert.deepEqual(replay, appended)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('keeps sequence conflicts atomic and streams a scripted model response', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const { origin } = await start(dataDir)
      const created = await post(origin, '/api/browser-native/session/create', envelope('create-seq', {
        sessionId: 'session-seq', header: { sessionId: 'session-seq', version: 1 }, inheritedEventCount: 0,
      }))
      const conflict = await postFailure(origin, '/api/browser-native/session/append', envelope('append-bad-seq', {
        sessionId: 'session-seq', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        expectedNextSeq: 3, events: [{ seq: 3, type: 'bad', payload: {} }],
      }))
      assert.equal(conflict.code, 'SEQ_CONFLICT')
      const llm = await fetch(`${origin}/api/browser-native/llm`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope('llm-1', {
          sessionId: 'session-seq', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
          model: 'poc-scripted', messages: [{ role: 'user', content: 'echo' }],
        })),
      })
      const text = await llm.text()
      assert.equal(llm.status, 200)
      const lines = text.trim().split('\n').map(line => JSON.parse(line))
      assert.equal(lines.at(-1).kind, 'end')
      assert.equal(lines[0].chunk.type, 'tool-call')
      const read = await post(origin, '/api/browser-native/session/read', envelope('read-seq', {
        sessionId: 'session-seq', offset: 0,
      }))
      assert.deepEqual(read.events, [])
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('rejects unsupported protocol versions, malformed JSON, and unapproved models', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const { origin } = await start(dataDir)
      const unsupported = await postFailure(origin, '/api/browser-native/session/create', {
        protocolVersion: 99, requestId: 'bad-version', sessionId: 'bad-version',
        header: { sessionId: 'bad-version', version: 1 }, inheritedEventCount: 0,
      })
      assert.equal(unsupported.code, 'PROTOCOL_UNSUPPORTED')

      const malformed = await fetch(`${origin}/api/browser-native/session/create`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
      })
      assert.equal(malformed.status, 400)
      assert.equal((await malformed.json()).error.code, 'INVALID_REQUEST')

      const duplicateKey = await fetch(`${origin}/api/browser-native/session/create`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: '{"protocolVersion":1,"requestId":"duplicate","sessionId":"duplicate","sessionId":"other","header":{"sessionId":"duplicate","version":1},"inheritedEventCount":0}',
      })
      assert.equal(duplicateKey.status, 400)
      assert.equal((await duplicateKey.json()).error.code, 'INVALID_REQUEST')

      const created = await post(origin, '/api/browser-native/session/create', envelope('create-model', {
        sessionId: 'session-model', header: { sessionId: 'session-model', version: 1 }, inheritedEventCount: 0,
      }))
      const model = await postFailure(origin, '/api/browser-native/llm', envelope('llm-model', {
        sessionId: 'session-model', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        model: 'not-allowed', messages: [],
      }))
      assert.equal(model.code, 'MODEL_NOT_ALLOWED')

      const badHeader = await postFailure(origin, '/api/browser-native/session/create', envelope('bad-header', {
        sessionId: 'bad-header', header: null, inheritedEventCount: 0,
      }))
      assert.equal(badHeader.code, 'INVALID_REQUEST')

      const badMessage = await postFailure(origin, '/api/browser-native/llm', envelope('bad-message', {
        sessionId: 'session-model', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        model: 'poc-scripted', messages: [{ role: 'user', content: 42 }],
      }))
      assert.equal(badMessage.code, 'INVALID_REQUEST')
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('requires the protocol version on the read-only stat route', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const { origin } = await start(dataDir)
      const missing = await fetch(`${origin}/api/browser-native/session/stat?sessionId=missing`)
      assert.equal(missing.status, 400)
      assert.equal((await missing.json()).error.code, 'PROTOCOL_UNSUPPORTED')
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('returns not-found for invalid, missing, and directory static paths', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const { origin } = await start(dataDir)
      for (const path of ['/%E0%A4%A', '/missing.js', '/public']) {
        const response = await fetch(`${origin}${path}`)
        const body = await response.json()
        assert.equal(response.status, 404)
        assert.equal(body.error.code, 'NOT_FOUND')
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('rejects unsupported top-level request fields', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const { origin } = await start(dataDir)
      const failure = await postFailure(origin, '/api/browser-native/session/create', envelope('unknown-field', {
        sessionId: 'unknown-field', header: { sessionId: 'unknown-field', version: 1 }, inheritedEventCount: 0,
        unexpected: true,
      }))
      assert.equal(failure.code, 'INVALID_REQUEST')
      const missingSession = await postFailure(origin, '/api/browser-native/session/open', envelope('unknown-field-missing', {
        sessionId: 'missing', access: 'read', unexpected: true,
      }))
      assert.equal(missingSession.code, 'INVALID_REQUEST')
      const invalidMissingSession = await postFailure(origin, '/api/browser-native/session/open', envelope('invalid-missing-session', {
        sessionId: 'missing', access: 'invalid',
      }))
      assert.equal(invalidMissingSession.code, 'INVALID_REQUEST')
      const invalidMissingLlmSession = await postFailure(origin, '/api/browser-native/llm', envelope('invalid-missing-llm', {
        sessionId: 'missing', ownerToken: 'token', generation: 0,
        model: 'poc-scripted', messages: [{ role: 'user', content: 42 }],
      }))
      assert.equal(invalidMissingLlmSession.code, 'INVALID_REQUEST')
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('rejects forbidden control characters in identity fields and unknown stat queries', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const { origin } = await start(dataDir)
      const control = await postFailure(origin, '/api/browser-native/session/create', envelope('bad\u0000request', {
        sessionId: 'control-field', header: { sessionId: 'control-field', version: 1 }, inheritedEventCount: 0,
      }))
      assert.equal(control.code, 'INVALID_REQUEST')
      const query = await fetch(`${origin}/api/browser-native/session/stat?protocolVersion=1&sessionId=missing&extra=1`)
      assert.equal(query.status, 400)
      assert.equal((await query.json()).error.code, 'INVALID_REQUEST')
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('treats object-prototype names as ordinary request ids', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const { origin } = await start(dataDir)
      for (const requestId of ['toString', '__proto__']) {
        const request = envelope(requestId, {
          sessionId: `session-${requestId.replaceAll('_', 'x')}`,
          header: { sessionId: `session-${requestId.replaceAll('_', 'x')}`, version: 1 },
          inheritedEventCount: 0,
        })
        const created = await post(origin, '/api/browser-native/session/create', request)
        const replay = await post(origin, '/api/browser-native/session/create', request)
        assert.deepEqual(replay, created)
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('ignores malformed durable files during backend load', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const sessionsDir = join(dataDir, 'sessions')
      await (await import('node:fs/promises')).mkdir(sessionsDir, { recursive: true })
      await (await import('node:fs/promises')).writeFile(join(sessionsDir, 'broken.json'), JSON.stringify({
        id: 'broken', header: { sessionId: 'broken', version: 1 }, events: [{ seq: 3, type: 'bad', payload: {} }], durableThroughSeq: 0,
      }))
      const { origin } = await start(dataDir)
      const missing = await postFailure(origin, '/api/browser-native/session/open', envelope('open-broken', {
        sessionId: 'broken', access: 'read',
      }))
      assert.equal(missing.code, 'SESSION_NOT_FOUND')
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('ignores a durable file with a malformed replay record', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const sessionsDir = join(dataDir, 'sessions')
      await (await import('node:fs/promises')).mkdir(sessionsDir, { recursive: true })
      await (await import('node:fs/promises')).writeFile(join(sessionsDir, 'broken-replay.json'), JSON.stringify({
        id: 'broken-replay', header: { sessionId: 'broken-replay', version: 1 }, events: [], durableThroughSeq: -1,
        replay: { replayed: { operation: 'append', digest: 'digest', response: { sessionId: 'broken-replay' } } },
      }))
      const { origin } = await start(dataDir)
      const missing = await postFailure(origin, '/api/browser-native/session/open', envelope('open-broken-replay', {
        sessionId: 'broken-replay', access: 'read',
      }))
      assert.equal(missing.code, 'SESSION_NOT_FOUND')
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('ignores a durable file with an inconsistent replay receipt', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const sessionsDir = join(dataDir, 'sessions')
      await (await import('node:fs/promises')).mkdir(sessionsDir, { recursive: true })
      await (await import('node:fs/promises')).writeFile(join(sessionsDir, 'inconsistent-replay.json'), JSON.stringify({
        id: 'inconsistent-replay', header: { sessionId: 'inconsistent-replay', version: 1 }, events: [], durableThroughSeq: -1,
        replay: {
          replayed: {
            operation: 'read', digest: 'digest', resultDigest: 'wrong', nextSeq: 9, durableThroughSeq: -1,
            response: { protocolVersion: 1, requestId: 'replayed', sessionId: 'inconsistent-replay', nextSeq: 0 },
          },
        },
      }))
      const { origin } = await start(dataDir)
      const missing = await postFailure(origin, '/api/browser-native/session/open', envelope('open-inconsistent-replay', {
        sessionId: 'inconsistent-replay', access: 'read',
      }))
      assert.equal(missing.code, 'SESSION_NOT_FOUND')
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('serializes concurrent Session mutations for one session', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const first = await start(dataDir)
      const created = await post(first.origin, '/api/browser-native/session/create', envelope('create-serial', {
        sessionId: 'session-serial', header: { sessionId: 'session-serial', version: 1 }, inheritedEventCount: 0,
      }))
      const appendRequest = envelope('append-serial', {
        sessionId: 'session-serial', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        expectedNextSeq: 0, events: [{ seq: 0, type: 'user.message', payload: { content: 'serial' } }],
      })
      const flushRequest = envelope('flush-serial', {
        sessionId: 'session-serial', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
      })
      const [appendResult, flushResult] = await Promise.all([
        post(first.origin, '/api/browser-native/session/append', appendRequest),
        post(first.origin, '/api/browser-native/session/flush', flushRequest),
      ])
      assert.equal(appendResult.nextSeq, 1)
      assert.equal(flushResult.durable, true)
      await first.app.close()
      live.delete(first.app)
      const second = await start(dataDir)
      const read = await post(second.origin, '/api/browser-native/session/read', envelope('read-serial', {
        sessionId: 'session-serial', offset: 0,
      }))
      assert.equal(read.durableThroughSeq, flushResult.durableThroughSeq)
      assert.equal(read.events.length, flushResult.durableThroughSeq + 1)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('reopens replay records for an append after an earlier durable flush', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const first = await start(dataDir)
      const created = await post(first.origin, '/api/browser-native/session/create', envelope('create-replay-after-flush', {
        sessionId: 'session-replay-after-flush', header: { sessionId: 'session-replay-after-flush', version: 1 }, inheritedEventCount: 0,
      }))
      await post(first.origin, '/api/browser-native/session/append', envelope('append-replay-base', {
        sessionId: 'session-replay-after-flush', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        expectedNextSeq: 0, events: [{ seq: 0, type: 'user.message', payload: { content: 'base' } }],
      }))
      await post(first.origin, '/api/browser-native/session/flush', envelope('flush-replay-base', {
        sessionId: 'session-replay-after-flush', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
      }))
      const appendRequest = envelope('append-replay-after-flush', {
        sessionId: 'session-replay-after-flush', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        expectedNextSeq: 1, events: [{ seq: 1, type: 'user.message', payload: { content: 'after flush' } }],
      })
      const appended = await post(first.origin, '/api/browser-native/session/append', appendRequest)
      await post(first.origin, '/api/browser-native/session/flush', envelope('flush-replay-after-flush', {
        sessionId: 'session-replay-after-flush', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
      }))
      await first.app.close()
      live.delete(first.app)
      const second = await start(dataDir)
      await post(second.origin, '/api/browser-native/session/open', envelope('open-replay-after-flush', {
        sessionId: 'session-replay-after-flush', access: 'write',
      }))
      const replayed = await post(second.origin, '/api/browser-native/session/append', appendRequest)
      assert.deepEqual(replayed, appended)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('replays a close after restart when the Session was already flushed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const first = await start(dataDir)
      const created = await post(first.origin, '/api/browser-native/session/create', envelope('create-close-replay', {
        sessionId: 'session-close-replay', header: { sessionId: 'session-close-replay', version: 1 }, inheritedEventCount: 0,
      }))
      await post(first.origin, '/api/browser-native/session/append', envelope('append-close-replay', {
        sessionId: 'session-close-replay', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        expectedNextSeq: 0, events: [{ seq: 0, type: 'user.message', payload: { content: 'close' } }],
      }))
      await post(first.origin, '/api/browser-native/session/flush', envelope('flush-close-replay', {
        sessionId: 'session-close-replay', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
      }))
      const closeRequest = envelope('close-after-flush-replay', {
        sessionId: 'session-close-replay', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
      })
      const closed = await post(first.origin, '/api/browser-native/session/close', closeRequest)
      assert.equal(Object.hasOwn(closed, 'durabilityReceipt'), false)
      await first.app.close()
      live.delete(first.app)

      const second = await start(dataDir)
      const replayed = await post(second.origin, '/api/browser-native/session/close', closeRequest)
      assert.deepEqual(replayed, closed)
      await second.app.close()
      live.delete(second.app)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('reopens a durable Session whose log spans multiple append batches', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const first = await start(dataDir)
      const created = await post(first.origin, '/api/browser-native/session/create', envelope('create-large-log', {
        sessionId: 'session-large-log', header: { sessionId: 'session-large-log', version: 1 }, inheritedEventCount: 0,
      }))
      const firstBatch = Array.from({ length: 256 }, (_, seq) => ({
        seq, type: 'test.event', payload: { content: `event-${seq}` },
      }))
      await post(first.origin, '/api/browser-native/session/append', envelope('append-large-log-1', {
        sessionId: 'session-large-log', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        expectedNextSeq: 0, events: firstBatch,
      }))
      await post(first.origin, '/api/browser-native/session/append', envelope('append-large-log-2', {
        sessionId: 'session-large-log', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        expectedNextSeq: 256, events: [{ seq: 256, type: 'test.event', payload: { content: 'event-256' } }],
      }))
      await post(first.origin, '/api/browser-native/session/flush', envelope('flush-large-log', {
        sessionId: 'session-large-log', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
      }))
      await first.app.close()
      live.delete(first.app)

      const second = await start(dataDir)
      const read = await post(second.origin, '/api/browser-native/session/read', envelope('read-large-log', {
        sessionId: 'session-large-log', offset: 0,
      }))
      assert.equal(read.events.length, 257)
      assert.equal(read.events.at(-1).seq, 256)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('rejects an append that would make the durable Session log exceed its limit', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-'))
    try {
      const { origin, app } = await start(dataDir)
      const created = await post(origin, '/api/browser-native/session/create', envelope('create-event-limit', {
        sessionId: 'session-event-limit', header: { sessionId: 'session-event-limit', version: 1 }, inheritedEventCount: 0,
      }))
      const session = app.store.sessions.get('session-event-limit')
      session.events = new Array(MAX_DURABLE_EVENTS)
      const failure = await postFailure(origin, '/api/browser-native/session/append', envelope('append-event-limit', {
        sessionId: 'session-event-limit', ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        expectedNextSeq: MAX_DURABLE_EVENTS, events: [{ seq: MAX_DURABLE_EVENTS, type: 'test.event', payload: {} }],
      }))
      assert.equal(failure.code, 'REQUEST_TOO_LARGE')
      assert.equal(session.events.length, MAX_DURABLE_EVENTS)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
