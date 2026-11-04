import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

async function start(app) {
  return await app.listen(0)
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
  return { status: response.status, value }
}

async function identity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  const value = await response.json()
  assert.equal(response.status, 200, JSON.stringify(value))
  return { cookie: cookiesFrom(response), workspaceId: value.workspaceId }
}

function createSessionEnvelope(sessionId) {
  return {
    sessionId,
    header: { id: sessionId, version: 4, createdAt: Date.now(), cwd: '/dsh/home/workspace' },
    inheritedEventCount: 0,
  }
}

test('separate dataDirs share no identity, Session, Workspace, or operator state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-multi-instance-isolation-'))
  const apps = []
  t.after(async () => {
    for (const app of apps) await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })

  const nodeA = await createBrowserNativeV2Server({ dataDir: join(root, 'node-a'), llmMode: 'scripted' })
  apps.push(nodeA)
  const originA = await start(nodeA)
  const nodeB = await createBrowserNativeV2Server({ dataDir: join(root, 'node-b'), llmMode: 'scripted' })
  apps.push(nodeB)
  const originB = await start(nodeB)

  const userA = await identity(originA)
  const userB = await identity(originB)
  assert.notEqual(userA.workspaceId, userB.workspaceId, 'each dataDir must mint its own workspace')

  const listA = await request(originA, '/api/browser-native/workspace/list', { cookie: userA.cookie })
  assert.equal(listA.status, 200, JSON.stringify(listA.value))
  assert.deepEqual(listA.value.workspaces.map(workspace => workspace.workspaceId), [userA.workspaceId])
  const listB = await request(originB, '/api/browser-native/workspace/list', { cookie: userB.cookie })
  assert.equal(listB.status, 200, JSON.stringify(listB.value))
  assert.deepEqual(listB.value.workspaces.map(workspace => workspace.workspaceId), [userB.workspaceId])

  const sessionId = randomUUID()
  const created = await request(originA, '/api/browser-native/session/create', {
    method: 'POST', body: createSessionEnvelope(sessionId), cookie: userA.cookie,
  })
  assert.equal(created.status, 200, JSON.stringify(created.value))
  const flushed = await request(originA, '/api/browser-native/session/flush', {
    method: 'POST',
    body: { sessionId, ownerToken: created.value.owner.ownerToken, ownerEpoch: created.value.owner.ownerEpoch },
    cookie: userA.cookie,
  })
  assert.equal(flushed.status, 200, JSON.stringify(flushed.value))

  const readFromB = await request(originB, '/api/browser-native/session/read', {
    method: 'POST', body: { sessionId, offset: 0 }, cookie: userB.cookie,
  })
  assert.equal(readFromB.status, 404, JSON.stringify(readFromB.value))
  assert.equal(readFromB.value.error.code, 'SESSION_NOT_FOUND')

  const replayedIdentity = await request(originB, '/api/browser-native/workspace/list', { cookie: userA.cookie })
  assert.equal(replayedIdentity.status, 401, JSON.stringify(replayedIdentity.value))
  assert.equal(replayedIdentity.value.error.code, 'UNAUTHENTICATED')

  const metricsA = await request(originA, '/api/browser-native/observability/metrics')
  assert.equal(metricsA.status, 200, JSON.stringify(metricsA.value))
  assert.equal(metricsA.value.leases.sessions, 1)
  const metricsB = await request(originB, '/api/browser-native/observability/metrics')
  assert.equal(metricsB.status, 200, JSON.stringify(metricsB.value))
  assert.equal(metricsB.value.leases.sessions, 0)

  const sessionsA = await readdir(join(root, 'node-a', 'sessions'))
  assert.ok(sessionsA.includes(`${sessionId}.json`), 'state must live under the owning dataDir')
  const sessionsB = await readdir(join(root, 'node-b', 'sessions'))
  assert.equal(sessionsB.includes(`${sessionId}.json`), false)

  t.diagnostic(JSON.stringify({
    result: 'passed',
    scope: 'independent-dataDirs-share-nothing',
    workspaces: { nodeA: userA.workspaceId, nodeB: userB.workspaceId, distinct: true },
    crossRead: { status: readFromB.status, code: readFromB.value.error.code },
    replayedIdentity: { status: replayedIdentity.status, code: replayedIdentity.value.error.code },
    leases: { nodeA: metricsA.value.leases.sessions, nodeB: metricsB.value.leases.sessions },
  }))
})

test('the shared state authority is a single-writer local store that fronts multiple backends', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-multi-instance-authority-'))
  const secret = `${randomUUID()}${randomUUID()}`
  const authorityDir = join(root, 'authority')
  const apps = []
  t.after(async () => {
    for (const app of apps) await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })

  const authority = await createBrowserNativeV2Server({
    dataDir: authorityDir, stateAuthorityToken: secret, llmMode: 'scripted',
  })
  apps.push(authority)
  const authorityOrigin = await start(authority)

  const backendA = await createBrowserNativeV2Server({
    dataDir: join(root, 'backend-a'), stateAuthorityOrigin: authorityOrigin, stateAuthorityToken: secret, llmMode: 'scripted',
  })
  apps.push(backendA)
  const originA = await start(backendA)
  const backendB = await createBrowserNativeV2Server({
    dataDir: join(root, 'backend-b'), stateAuthorityOrigin: authorityOrigin, stateAuthorityToken: secret, llmMode: 'scripted',
  })
  apps.push(backendB)
  const originB = await start(backendB)

  let duplicate
  try {
    duplicate = await createBrowserNativeV2Server({
      dataDir: authorityDir, stateAuthorityToken: secret, llmMode: 'scripted',
    })
  } catch (error) {
    assert.equal(error.code, 'BACKEND_ALREADY_RUNNING', JSON.stringify(error))
  }
  if (duplicate !== undefined) {
    apps.push(duplicate)
    assert.fail('a second authority must not acquire the same dataDir')
  }

  const user = await identity(originA)
  const sessionId = randomUUID()
  const created = await request(originA, '/api/browser-native/session/create', {
    method: 'POST', body: createSessionEnvelope(sessionId), cookie: user.cookie,
  })
  assert.equal(created.status, 200, JSON.stringify(created.value))
  const flushed = await request(originA, '/api/browser-native/session/flush', {
    method: 'POST',
    body: { sessionId, ownerToken: created.value.owner.ownerToken, ownerEpoch: created.value.owner.ownerEpoch },
    cookie: user.cookie,
  })
  assert.equal(flushed.status, 200, JSON.stringify(flushed.value))

  const readFromB = await request(originB, '/api/browser-native/session/read', {
    method: 'POST', body: { sessionId, offset: 0 }, cookie: user.cookie,
  })
  assert.equal(readFromB.status, 200, JSON.stringify(readFromB.value))
  assert.equal(readFromB.value.events.length, 0)

  const authoritySessions = await readdir(join(authorityDir, 'sessions'))
  assert.ok(authoritySessions.includes(`${sessionId}.json`), 'the authority must own the Session file')
  for (const label of ['backend-a', 'backend-b']) {
    const backendSessions = await readdir(join(root, label, 'sessions'))
    assert.equal(backendSessions.includes(`${sessionId}.json`), false, `${label} must hold no Session copy`)
  }

  t.diagnostic(JSON.stringify({
    result: 'passed',
    scope: 'shared-authority-single-writer',
    duplicateAuthority: 'BACKEND_ALREADY_RUNNING',
    crossBackendRead: { status: readFromB.status, events: readFromB.value.events.length },
    sessionFiles: { authority: true, backendA: false, backendB: false },
  }))
})
