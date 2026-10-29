import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createExternalBusinessService } from '../external-business-service.mjs'

function cookiesFrom(response) {
  return response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
}

function cookieValue(cookie, name) {
  return cookie.split('; ').find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
}

function envelope(extra = {}) {
  return { protocolVersion: 1, requestId: randomUUID(), ...extra }
}

async function start(app, port = 0) {
  const origin = await app.listen(port)
  return { app, origin, port: Number(new URL(origin).port) }
}

async function post(origin, path, body, cookie) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(envelope(body)),
  })
  return { status: response.status, value: await response.json() }
}

async function createCluster(t, { businessServiceOrigin, authorityHooks = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shared-authority-races-'))
  const token = `${randomUUID()}${randomUUID()}`
  const apps = new Set()
  const authorityDir = join(root, 'authority')
  let authority

  async function startAuthority(port = 0) {
    const app = await createBrowserNativeV2Server({
      dataDir: authorityDir,
      stateAuthorityToken: token,
      llmMode: 'scripted',
      ...(businessServiceOrigin === undefined ? {} : { businessServiceOrigin }),
      testHooks: authorityHooks,
    })
    const started = await start(app, port)
    apps.add(app)
    authority = started
    return started
  }

  const firstAuthority = await startAuthority()
  const backends = []
  for (const label of ['backend-a', 'backend-b']) {
    const app = await createBrowserNativeV2Server({
      dataDir: join(root, label),
      stateAuthorityOrigin: firstAuthority.origin,
      stateAuthorityToken: token,
      llmMode: 'scripted',
    })
    const started = await start(app)
    apps.add(app)
    backends.push(started)
  }

  t.after(async () => {
    for (const app of apps) await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })

  return {
    root,
    token,
    authorityDir,
    apps,
    backends,
    get authority() { return authority },
    restartAuthority: async () => {
      const port = authority.port
      await authority.app.close()
      apps.delete(authority.app)
      return await startAuthority(port)
    },
    stopAuthority: async () => {
      await authority.app.close()
      apps.delete(authority.app)
      authority = undefined
    },
  }
}

async function identity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  const value = await response.json()
  assert.equal(response.status, 200, JSON.stringify(value))
  const cookie = cookiesFrom(response)
  const principalId = cookieValue(cookie, 'dsh-browser-native-principal')
  assert.ok(principalId)
  assert.ok(cookieValue(cookie, 'dsh-browser-native-session-principal'))
  return { cookie, principalId, workspaceId: value.workspaceId }
}

test('two backends serialize Session create, owner claim, and same-sequence append', async t => {
  const cluster = await createCluster(t)
  const [first, second] = cluster.backends
  const user = await identity(first.origin)
  const sessionId = randomUUID()
  const header = { id: sessionId, version: 1, createdAt: Date.now(), cwd: '/dsh/home/workspace' }
  const creates = await Promise.all([first, second].map(backend => post(
    backend.origin,
    '/api/browser-native/session/create',
    { sessionId, header, inheritedEventCount: 0 },
    user.cookie,
  )))
  assert.equal(creates.filter(result => result.status === 200).length, 1)
  assert.equal(creates.filter(result => result.status === 409 && result.value.error.code === 'SESSION_ALREADY_EXISTS').length, 1)
  const created = creates.find(result => result.status === 200).value

  const closed = await post(first.origin, '/api/browser-native/session/close', {
    sessionId, ownerToken: created.owner.ownerToken, ownerEpoch: created.owner.ownerEpoch,
  }, user.cookie)
  assert.equal(closed.status, 200, JSON.stringify(closed.value))

  const claims = await Promise.all([first, second].map(backend => post(
    backend.origin,
    '/api/browser-native/session/open',
    { sessionId, access: 'write' },
    user.cookie,
  )))
  assert.equal(claims.filter(result => result.status === 200).length, 1)
  assert.equal(claims.filter(result => result.status === 409 && result.value.error.code === 'SESSION_ALREADY_OWNED').length, 1)
  const owner = claims.find(result => result.status === 200).value.owner

  const appends = await Promise.all([first, second].map((backend, index) => post(
    backend.origin,
    '/api/browser-native/session/append',
    {
      sessionId,
      ownerToken: owner.ownerToken,
      ownerEpoch: owner.ownerEpoch,
      expectedNextSeq: 0,
      events: [{ seq: 0, time: Date.now(), type: 'test/concurrent-append', ignorable: true, data: { contender: index } }],
    },
    user.cookie,
  )))
  assert.equal(appends.filter(result => result.status === 200).length, 1)
  assert.equal(appends.filter(result => result.status === 409 && result.value.error.code === 'SEQ_CONFLICT').length, 1)

  const flushed = await post(second.origin, '/api/browser-native/session/flush', {
    sessionId, ownerToken: owner.ownerToken, ownerEpoch: owner.ownerEpoch,
  }, user.cookie)
  assert.equal(flushed.status, 200, JSON.stringify(flushed.value))
  assert.equal(flushed.value.durableThroughSeq, 0)
  const read = await post(first.origin, '/api/browser-native/session/read', { sessionId, offset: 0 }, user.cookie)
  assert.equal(read.status, 200, JSON.stringify(read.value))
  assert.equal(read.value.events.length, 1)
  assert.equal(read.value.events[0].type, 'test/concurrent-append')
  assert.equal(read.value.ownerEpoch, owner.ownerEpoch)
})

test('two backends serialize Workspace claims, operation replay, CAS conflicts, and principal checks', async t => {
  const cluster = await createCluster(t)
  const [first, second] = cluster.backends
  const ownerIdentity = await identity(first.origin)
  const foreignIdentity = await identity(second.origin)
  const workspaceId = ownerIdentity.workspaceId

  const claims = await Promise.all([first, second].map(backend => post(
    backend.origin,
    '/api/browser-native/workspace/lease',
    { operation: 'claim', workspaceId },
    ownerIdentity.cookie,
  )))
  assert.equal(claims.filter(result => result.status === 200).length, 1)
  assert.equal(claims.filter(result => result.status === 409 && result.value.error.code === 'WORKSPACE_ALREADY_OWNED').length, 1)
  const lease = claims.find(result => result.status === 200).value

  const operationId = randomUUID()
  const initialChanges = [{ path: 'race/initial', kind: 'directory', mode: 0o755 }]
  const sameOperation = await Promise.all([first, second].map(backend => post(
    backend.origin,
    '/api/browser-native/workspace/commit',
    {
      workspaceId, operationId, baseRevision: 0, changes: initialChanges,
      writerToken: lease.writerToken, fencingToken: lease.fencingToken,
    },
    ownerIdentity.cookie,
  )))
  assert.deepEqual(sameOperation.map(result => result.status).sort(), [200, 200])
  assert.deepEqual(new Set(sameOperation.map(result => result.value.revision)), new Set([1]))
  assert.equal(sameOperation.filter(result => result.value.replayed === false).length, 1)
  assert.equal(sameOperation.filter(result => result.value.replayed === true).length, 1)

  const reusedId = await post(first.origin, '/api/browser-native/workspace/commit', {
    workspaceId, operationId, baseRevision: 1,
    changes: [{ path: 'race/changed', kind: 'directory', mode: 0o755 }],
    writerToken: lease.writerToken, fencingToken: lease.fencingToken,
  }, ownerIdentity.cookie)
  assert.equal(reusedId.status, 409)
  assert.equal(reusedId.value.error.code, 'OPERATION_ID_REUSED')

  const competing = await Promise.all([first, second].map((backend, index) => post(
    backend.origin,
    '/api/browser-native/workspace/commit',
    {
      workspaceId, operationId: randomUUID(), baseRevision: 1,
      changes: [{ path: `race/contender-${index}`, kind: 'directory', mode: 0o755 }],
      writerToken: lease.writerToken, fencingToken: lease.fencingToken,
    },
    ownerIdentity.cookie,
  )))
  assert.equal(competing.filter(result => result.status === 200).length, 1)
  assert.equal(competing.filter(result => result.status === 409 && result.value.error.code === 'WORKSPACE_CONFLICT').length, 1)
  const manifest = await fetch(`${first.origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${workspaceId}`, {
    headers: { cookie: ownerIdentity.cookie },
  }).then(async response => ({ status: response.status, value: await response.json() }))
  assert.equal(manifest.status, 200, JSON.stringify(manifest.value))
  assert.equal(manifest.value.revision, 2)
  assert.equal(manifest.value.entries.filter(entry => entry.path.startsWith('race/contender-')).length, 1)

  const foreignRead = await fetch(`${second.origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${workspaceId}`, {
    headers: { cookie: foreignIdentity.cookie },
  })
  assert.equal(foreignRead.status, 403)
  const foreignSessionRead = await post(second.origin, '/api/browser-native/session/read', {
    sessionId: randomUUID(), offset: 0,
  }, foreignIdentity.cookie)
  assert.equal(foreignSessionRead.status, 404)
  const foreignLease = await post(second.origin, '/api/browser-native/workspace/lease', {
    operation: 'claim', workspaceId,
  }, foreignIdentity.cookie)
  assert.equal(foreignLease.status, 403)
})

function businessIntent(user, payload, operationId = randomUUID()) {
  const sessionId = randomUUID()
  const identity = {
    operationId,
    principalId: user.principalId,
    sessionId,
    workspaceId: user.workspaceId,
    ownerEpoch: 1,
    workspaceFencingToken: 1,
    turn: 1,
    step: 1,
    callId: `call-${operationId}`,
    toolName: 'create_ticket',
    toolCallSeq: 1,
  }
  return {
    operationId,
    sessionId,
    payload,
    identity,
    intent: {
      ...identity,
      operationKind: 'shared-authority-business-race',
      payloadDigest: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
    },
  }
}

test('business effects deduplicate across backends and reconcile response loss after authority restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shared-authority-business-'))
  let dropEffectResponse = false
  const business = await createExternalBusinessService({
    dataDir: join(root, 'business-service'),
    testHooks: {
      dropEffectResponse: () => {
        if (!dropEffectResponse) return false
        dropEffectResponse = false
        return true
      },
    },
  })
  const businessOrigin = await business.listen(0)
  t.after(async () => {
    await business.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  const cluster = await createCluster(t, { businessServiceOrigin: businessOrigin })
  const [first, second] = cluster.backends
  const user = await identity(first.origin)
  const payload = { action: 'create-ticket', ticket: 'BN-MULTI-1' }
  const operation = businessIntent(user, payload)
  const intent = await post(first.origin, '/api/browser-native/workspace/cross-store-operation/intent', operation.intent, user.cookie)
  assert.equal(intent.status, 200, JSON.stringify(intent.value))

  const effects = await Promise.all([first, second].map(backend => post(
    backend.origin,
    '/api/browser-native/workspace/cross-store-operation/business',
    { operationId: operation.operationId, payload, identity: operation.identity },
    user.cookie,
  )))
  assert.deepEqual(effects.map(result => result.status).sort(), [200, 200])
  assert.equal(new Set(effects.map(result => result.value.businessReceipt.effectId)).size, 1)
  assert.equal(effects[0].value.businessEffectCount, 1)
  assert.equal(effects[1].value.businessEffectCount, 1)
  const businessEffect = await fetch(`${businessOrigin}/v1/effect/${operation.operationId}?principalId=${user.principalId}`).then(response => response.json())
  assert.equal(businessEffect.status, 'committed')
  assert.equal(businessEffect.effectCount, 1)

  const lostPayload = { action: 'create-ticket', ticket: 'BN-MULTI-2' }
  const lost = businessIntent(user, lostPayload)
  const lostIntent = await post(second.origin, '/api/browser-native/workspace/cross-store-operation/intent', lost.intent, user.cookie)
  assert.equal(lostIntent.status, 200, JSON.stringify(lostIntent.value))
  dropEffectResponse = true
  const lostResponse = await post(first.origin, '/api/browser-native/workspace/cross-store-operation/business', {
    operationId: lost.operationId, payload: lostPayload, identity: lost.identity,
  }, user.cookie)
  assert.equal(lostResponse.status, 503)
  assert.equal(lostResponse.value.error.code, 'BUSINESS_SERVICE_UNAVAILABLE')

  await cluster.restartAuthority()
  const query = await fetch(`${second.origin}/api/browser-native/workspace/cross-store-operation/${lost.operationId}`
    + `?protocolVersion=1&workspaceId=${user.workspaceId}&sessionId=${lost.sessionId}`, {
    headers: { cookie: user.cookie },
  }).then(async response => ({ status: response.status, value: await response.json() }))
  assert.equal(query.status, 200, JSON.stringify(query.value))
  assert.equal(query.value.receipts.business.status, 'committed')
  assert.equal(query.value.businessEffectCount, 1)
  assert.equal(query.value.decision.statuses.business, 'committed')
  const recoveredBusinessEffect = await fetch(`${businessOrigin}/v1/effect/${lost.operationId}?principalId=${user.principalId}`).then(response => response.json())
  assert.equal(recoveredBusinessEffect.effectCount, 1)

  const foreign = await identity(second.origin)
  const foreignQuery = await fetch(`${first.origin}/api/browser-native/workspace/cross-store-operation/${lost.operationId}`
    + `?protocolVersion=1&workspaceId=${user.workspaceId}&sessionId=${lost.sessionId}`, {
    headers: { cookie: foreign.cookie },
  })
  assert.equal(foreignQuery.status, 404)
})
