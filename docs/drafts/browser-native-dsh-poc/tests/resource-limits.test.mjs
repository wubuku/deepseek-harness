/**
 * HTTP-level resource bounds for the Browser-Native backend: body size,
 * concurrent request cap, slow-client timeout, and model-turn timeout.
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const liveApps = new Set()
const liveRequests = new Set()
const temporaryDirectories = new Set()

async function start(options) {
  const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-resource-'))
  temporaryDirectories.add(dataDir)
  const app = await createBrowserNativeV2Server({ port: 0, dataDir, llmMode: 'scripted', ...options })
  liveApps.add(app)
  return { app, origin: await app.listen(0) }
}

async function identity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  const cookies = response.headers.getSetCookie()
  const sessionCookie = cookies.find(cookie => cookie.startsWith('dsh-browser-native-session-principal='))
  assert.notEqual(sessionCookie, undefined)
  return sessionCookie.split(';', 1)[0]
}

function partialRequest(origin, pathname) {
  const url = new URL(origin)
  const request = httpRequest({
    hostname: url.hostname,
    port: url.port,
    path: pathname,
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '100' },
  })
  request.on('error', () => {})
  liveRequests.add(request)
  request.write('{"protocolVersion":1,')
  return request
}

async function post(origin, path, body, cookie) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify({ protocolVersion: 1, requestId: `resource-${String(Date.now())}`, ...body }),
  })
  return { status: response.status, body: await response.json(), headers: response.headers }
}

async function bodyStatus(origin, payload) {
  return await new Promise(resolve => {
    const url = new URL(origin)
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: '/api/browser-native/session/list',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
    }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', () => resolve('client-aborted'))
    request.end(payload)
  })
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(message)
}

afterEach(async () => {
  for (const request of liveRequests) request.destroy()
  liveRequests.clear()
  for (const app of liveApps) await app.close()
  liveApps.clear()
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

describe('browser-native resource bounds', () => {
  it('rejects a request body above the 8 MiB cap', async () => {
    const { origin } = await start({})
    const payload = JSON.stringify({
      protocolVersion: 1,
      requestId: 'oversized',
      pad: 'x'.repeat(9 * 1024 * 1024),
    })
    const status = await bodyStatus(origin, payload)
    assert.equal(status, 413)
    const health = await fetch(`${origin}/api/browser-native/health`)
    assert.equal(health.status, 200)
  })

  it('sheds requests above the concurrent cap and recovers after the slow clients leave', async () => {
    const { origin } = await start({ maxConcurrentRequests: 2, requestTimeoutMs: 10_000 })
    const first = partialRequest(origin, '/api/browser-native/session/list')
    const second = partialRequest(origin, '/api/browser-native/session/list')
    await new Promise(resolve => setTimeout(resolve, 60))
    const busy = await fetch(`${origin}/api/browser-native/health`)
    assert.equal(busy.status, 503)
    assert.equal((await busy.json()).error.code, 'SERVER_BUSY')
    assert.equal(busy.headers.get('retry-after'), '1')
    first.destroy()
    second.destroy()
    await waitFor(async () => (await fetch(`${origin}/api/browser-native/health`)).status === 200, 3_000, 'server did not recover')
  })

  it('closes a slow request body at the request timeout', async () => {
    const { origin } = await start({ requestTimeoutMs: 1_500, headersTimeoutMs: 1_200 })
    const request = partialRequest(origin, '/api/browser-native/session/list')
    const startedAt = Date.now()
    await Promise.race([
      once(request, 'close'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('slow request was not closed')), 6_000)),
    ])
    const elapsed = Date.now() - startedAt
    assert.equal(elapsed >= 1_000, true, `closed after ${String(elapsed)}ms`)
    assert.equal(elapsed <= 6_000, true)
    const health = await fetch(`${origin}/api/browser-native/health`)
    assert.equal(health.status, 200)
  })

  it('settles a durable turn as failed when the model exceeds its turn timeout', async () => {
    const { origin } = await start({
      durableTurnTimeoutMs: 1_200,
      testHooks: {
        scriptedLlmFault: () => ({ kind: 'delayed-text', text: 'TOO_LATE', delayMs: 5_000 }),
      },
    })
    const cookie = await identity(origin)
    const startedAt = Date.now()
    const started = await post(origin, '/api/browser-native/session/durable', {
      sessionId: 'timeout-session',
      turnId: 'timeout-turn',
      prompt: 'hang until the turn timeout',
    }, cookie)
    assert.equal(started.status, 202, JSON.stringify(started.body))
    await waitFor(async () => {
      const status = await fetch(`${origin}/api/browser-native/session/durable?turnId=timeout-turn`, { headers: { cookie } })
      const body = await status.json()
      return body.status === 'failed'
    }, 4_000, 'durable turn did not settle as failed')
    const settled = await fetch(`${origin}/api/browser-native/session/durable?turnId=timeout-turn`, { headers: { cookie } })
    const body = await settled.json()
    assert.equal(body.error.code, 'DURABLE_LLM_TIMEOUT')
    assert.equal(body.status, 'failed')
    const elapsed = Date.now() - startedAt
    assert.equal(elapsed >= 1_000, true, `settled after ${String(elapsed)}ms`)
    assert.equal(elapsed <= 4_000, true)
  })
})
