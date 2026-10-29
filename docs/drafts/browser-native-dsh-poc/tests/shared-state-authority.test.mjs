import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

async function start(app) {
  const origin = await app.listen(0)
  return { app, origin }
}

function cookiesFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie() : []
  return values.map(value => value.split(';', 1)[0]).join('; ')
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
  return { response, value }
}

test('two backend instances use one shared Session authority and owner fence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-shared-authority-'))
  const secret = `${randomUUID()}${randomUUID()}`
  const apps = []
  try {
    const authority = await start(await createBrowserNativeV2Server({
      dataDir: join(root, 'authority'),
      stateAuthorityToken: secret,
      llmMode: 'scripted',
    }))
    const first = await start(await createBrowserNativeV2Server({
      dataDir: join(root, 'backend-a'),
      stateAuthorityOrigin: authority.origin,
      stateAuthorityToken: secret,
      llmMode: 'scripted',
    }))
    const second = await start(await createBrowserNativeV2Server({
      dataDir: join(root, 'backend-b'),
      stateAuthorityOrigin: authority.origin,
      stateAuthorityToken: secret,
      llmMode: 'scripted',
    }))
    apps.push(second, first, authority)

    const identity = await request(second.origin, '/api/browser-native/workspace/identity')
    assert.equal(identity.response.status, 200, JSON.stringify(identity.value))
    const cookie = cookiesFrom(identity.response)
    assert.match(cookie, /dsh-browser-native-principal=/)
    assert.match(cookie, /dsh-browser-native-session-principal=/)
    const workspaceId = identity.value.workspaceId
    assert.equal(typeof workspaceId, 'string')

    const sessionId = randomUUID()
    const created = await request(first.origin, '/api/browser-native/session/create', {
      method: 'POST', cookie, body: {
        sessionId,
        header: { id: sessionId, version: 1, createdAt: Date.now(), cwd: '/dsh/home/workspace' },
        inheritedEventCount: 0,
      },
    })
    assert.equal(created.response.status, 200, JSON.stringify(created.value))
    const owner = created.value.owner
    assert.equal(typeof owner.ownerToken, 'string')

    const appended = await request(second.origin, '/api/browser-native/session/append', {
      method: 'POST', cookie, body: {
        sessionId,
        ownerToken: owner.ownerToken,
        ownerEpoch: owner.ownerEpoch,
        expectedNextSeq: 0,
        events: [{ seq: 0, time: Date.now(), type: 'test/shared-authority', ignorable: true, data: {} }],
      },
    })
    assert.equal(appended.response.status, 200, JSON.stringify(appended.value))
    assert.equal(appended.value.acceptedCount, 1)

    const read = await request(first.origin, '/api/browser-native/session/read', {
      method: 'POST', cookie, body: { sessionId, offset: 0, length: 10 },
    })
    assert.equal(read.response.status, 200, JSON.stringify(read.value))
    assert.equal(read.value.events.length, 1)
    assert.equal(read.value.events[0].type, 'test/shared-authority')

    const lease = await request(first.origin, '/api/browser-native/workspace/lease', {
      method: 'POST', cookie, body: { operation: 'claim', workspaceId },
    })
    assert.equal(lease.response.status, 200, JSON.stringify(lease.value))
    const stale = await request(second.origin, '/api/browser-native/workspace/lease', {
      method: 'POST', cookie, body: {
        operation: 'renew', workspaceId, writerToken: randomUUID(), fencingToken: lease.value.fencingToken,
      },
    })
    assert.equal(stale.response.status, 409, JSON.stringify(stale.value))
    assert.equal(stale.value.error.code, 'WORKSPACE_OWNERSHIP_LOST')

    const llm = await fetch(`${second.origin}/api/browser-native/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: randomUUID(),
        sessionId,
        ownerToken: owner.ownerToken,
        ownerEpoch: owner.ownerEpoch,
        messages: [{ role: 'user', content: 'shared authority smoke' }],
        tools: [],
      }),
    })
    assert.equal(llm.status, 200)
    assert.match(await llm.text(), /finish/)

    const oldOwner = await request(first.origin, '/api/browser-native/session/append', {
      method: 'POST', cookie, body: {
        sessionId,
        ownerToken: randomUUID(),
        ownerEpoch: owner.ownerEpoch,
        expectedNextSeq: 1,
        events: [],
      },
    })
    assert.equal(oldOwner.response.status, 409, JSON.stringify(oldOwner.value))
    assert.equal(oldOwner.value.error.code, 'SESSION_OWNERSHIP_LOST')
  } finally {
    for (const item of apps) await item.app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
