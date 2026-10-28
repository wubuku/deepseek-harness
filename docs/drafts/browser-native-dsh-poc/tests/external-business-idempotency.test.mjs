import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createExternalBusinessService } from '../external-business-service.mjs'

const applications = new Set()
const directories = new Set()

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.add(directory)
  return directory
}

async function startBusiness(dataDir, testHooks = {}) {
  const service = await createExternalBusinessService({ dataDir, testHooks })
  const origin = await service.listen()
  applications.add(service)
  return { service, origin }
}

async function startBackend(dataDir, businessServiceOrigin, testHooks = {}) {
  const app = await createBrowserNativeV2Server({
    dataDir,
    port: 0,
    llmMode: 'scripted',
    businessServiceOrigin,
    testHooks,
  })
  const origin = await app.listen()
  applications.add(app)
  return { app, origin }
}

function envelope(requestId, extra = {}) {
  return { protocolVersion: 1, requestId, ...extra }
}

async function openIdentity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  const value = await response.json()
  assert.equal(response.ok, true, JSON.stringify(value))
  const cookies = response.headers.getSetCookie()
  const workspace = cookies.find(cookie => cookie.startsWith('dsh-browser-native-principal='))
  const session = cookies.find(cookie => cookie.startsWith('dsh-browser-native-session-principal='))
  assert.ok(workspace)
  assert.ok(session)
  return {
    workspaceId: value.workspaceId,
    principalId: workspace.split('=', 2)[1].split(';', 1)[0],
    workspaceCookie: workspace.split(';', 1)[0],
    sessionCookie: session.split(';', 1)[0],
  }
}

async function requestJson(origin, path, body, cookie) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(body),
  })
  const value = await response.json()
  return { response, value }
}

async function post(origin, path, body, cookie) {
  const { response, value } = await requestJson(origin, path, body, cookie)
  if (!response.ok) {
    const error = new Error(value.error?.message ?? `HTTP ${response.status}`)
    error.code = value.error?.code
    error.status = response.status
    throw error
  }
  return value
}

function payloadDigest(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function operation(identity, payload = { action: 'create-ticket', ticket: 'T-1' }) {
  const operationId = randomUUID()
  const sessionId = randomUUID()
  return {
    operationId,
    payload,
    intent: envelope(`${operationId}-intent`, {
      operationId,
      principalId: identity.principalId,
      sessionId,
      workspaceId: identity.workspaceId,
      ownerEpoch: 1,
      workspaceFencingToken: 1,
      turn: 1,
      step: 1,
      callId: `call-${operationId}`,
      toolName: 'business_effect',
      toolCallSeq: 1,
      operationKind: 'external-business-test',
      payloadDigest: payloadDigest(payload),
      payloadBytes: JSON.stringify(payload).length,
    }),
  }
}

afterEach(async () => {
  for (const application of applications) {
    await application.close().catch(() => {})
    applications.delete(application)
  }
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true })
    directories.delete(directory)
  }
})

describe('external business idempotency PoC', () => {
  it('keeps one durable effect across concurrent retries and service restart', async () => {
    const businessDir = await temporaryDirectory('dsh-business-service-')
    const { service, origin: businessOrigin } = await startBusiness(businessDir)
    const identity = { principalId: randomUUID() }
    const payload = { action: 'create-ticket', ticket: 'T-concurrent' }
    const operationId = randomUUID()
    await post(businessOrigin, '/v1/intent', { operationId, principalId: identity.principalId, payloadDigest: payloadDigest(payload) })
    const results = await Promise.all([
      post(businessOrigin, '/v1/effect', { operationId, principalId: identity.principalId, payloadDigest: payloadDigest(payload) }),
      post(businessOrigin, '/v1/effect', { operationId, principalId: identity.principalId, payloadDigest: payloadDigest(payload) }),
    ])
    assert.equal(results.filter(result => result.replayed !== true).length, 1)
    assert.equal(results[0].effectCount, 1)
    assert.equal(results[1].effectCount, 1)
    await service.close()
    applications.delete(service)
    const restarted = await startBusiness(businessDir)
    const queried = await fetch(`${restarted.origin}/v1/effect/${operationId}?principalId=${identity.principalId}`)
    const record = await queried.json()
    assert.equal(record.status, 'committed')
    assert.equal(record.effectCount, 1)
  })

  it('rejects operation id reuse with a different payload or principal', async () => {
    const businessDir = await temporaryDirectory('dsh-business-conflict-')
    const { origin } = await startBusiness(businessDir)
    const operationId = randomUUID()
    const principalId = randomUUID()
    await post(origin, '/v1/intent', { operationId, principalId, payloadDigest: payloadDigest({ value: 1 }) })
    const payloadConflict = await requestJson(origin, '/v1/intent', { operationId, principalId, payloadDigest: payloadDigest({ value: 2 }) })
    assert.equal(payloadConflict.response.status, 409)
    assert.equal(payloadConflict.value.error.code, 'IDEMPOTENCY_CONFLICT')
    const principalConflict = await requestJson(origin, '/v1/effect', { operationId, principalId: randomUUID(), payloadDigest: payloadDigest({ value: 1 }) })
    assert.equal(principalConflict.response.status, 409)
    assert.equal(principalConflict.value.error.code, 'IDEMPOTENCY_CONFLICT')
  })

  it('recovers a committed external effect after the backend response and ledger receipt are lost', async () => {
    const businessDir = await temporaryDirectory('dsh-business-recovery-')
    const backendDir = await temporaryDirectory('dsh-business-backend-')
    let dropResponse = true
    const { origin: businessOrigin } = await startBusiness(businessDir, {
      dropEffectResponse: () => {
        if (!dropResponse) return false
        dropResponse = false
        return true
      },
    })
    const { origin } = await startBackend(backendDir, businessOrigin)
    const identity = await openIdentity(origin)
    const item = operation(identity)
    await post(origin, '/api/browser-native/workspace/cross-store-operation/intent', item.intent, identity.workspaceCookie)
    const failed = await requestJson(origin, '/api/browser-native/workspace/cross-store-operation/business', envelope(`${item.operationId}-business`, {
      operationId: item.operationId,
      payload: item.payload,
    }), identity.workspaceCookie)
    assert.equal(failed.response.ok, false)
    const queried = await fetch(`${origin}/api/browser-native/workspace/cross-store-operation/${item.operationId}?protocolVersion=1&workspaceId=${identity.workspaceId}&sessionId=${item.intent.sessionId}`, { headers: { cookie: identity.workspaceCookie } }).then(response => response.json())
    assert.equal(queried.receipts.business.status, 'committed')
    assert.equal(queried.businessEffectCount, 1)
    assert.equal(queried.decision.decision, 'pending')
    const reconciled = await fetch(`${origin}/api/browser-native/workspace/cross-store-operation/${item.operationId}?protocolVersion=1&workspaceId=${identity.workspaceId}&sessionId=${item.intent.sessionId}`, { headers: { cookie: identity.workspaceCookie } }).then(response => response.json())
    assert.equal(reconciled.decision.decision, 'pending')
  })

  it('rebuilds the DSH ledger after a backend restart', async () => {
    const businessDir = await temporaryDirectory('dsh-business-backend-restart-service-')
    const backendDir = await temporaryDirectory('dsh-business-backend-restart-')
    const { origin: businessOrigin } = await startBusiness(businessDir)
    let failBeforeLedger = true
    const first = await startBackend(backendDir, businessOrigin, {
      failAfterExternalBusinessEffectBeforeLedger: () => {
        if (!failBeforeLedger) return false
        failBeforeLedger = false
        return true
      },
    })
    const identity = await openIdentity(first.origin)
    const item = operation(identity, { action: 'create-ticket', ticket: 'T-backend-restart' })
    await post(first.origin, '/api/browser-native/workspace/cross-store-operation/intent', item.intent, identity.workspaceCookie)
    const failed = await requestJson(first.origin, '/api/browser-native/workspace/cross-store-operation/business', envelope(`${item.operationId}-business`, {
      operationId: item.operationId,
      payload: item.payload,
    }), identity.workspaceCookie)
    assert.equal(failed.response.ok, false)
    await first.app.close()
    applications.delete(first.app)
    const second = await startBackend(backendDir, businessOrigin)
    const recovered = await fetch(`${second.origin}/api/browser-native/workspace/cross-store-operation/${item.operationId}?protocolVersion=1&workspaceId=${identity.workspaceId}&sessionId=${item.intent.sessionId}`, {
      headers: { cookie: identity.workspaceCookie },
    })
    const value = await recovered.json()
    assert.equal(recovered.ok, true, JSON.stringify(value))
    assert.equal(value.receipts.business.status, 'committed')
    assert.equal(value.businessEffectCount, 1)
    assert.equal((await businessRecordFromService(businessDir, businessOrigin, item.operationId, identity.principalId)).effectCount, 1)
  })
})

async function businessRecordFromService(dataDir, origin, operationId, principalId) {
  const response = await fetch(`${origin}/v1/effect/${operationId}?principalId=${principalId}`)
  assert.equal(response.ok, true)
  return await response.json()
}
