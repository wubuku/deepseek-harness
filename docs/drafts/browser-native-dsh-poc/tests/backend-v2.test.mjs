import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const liveApps = new Set()
const temporaryDirectories = new Set()

async function temporaryDirectory(prefix = 'browser-native-v2-test-') {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.add(directory)
  return directory
}

async function start(options) {
  const app = await createBrowserNativeV2Server(options)
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
})
