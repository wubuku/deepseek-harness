import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import {
  createCrossStoreCheckpoint,
  digestCrossStoreValue,
  reconcileCrossStoreState,
} from '../cross-store-checkpoint.mjs'

const liveApps = new Set()
const temporaryDirectories = new Set()

async function start(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-cross-store-ledger-'))
  temporaryDirectories.add(dataDir)
  const app = await createBrowserNativeV2Server({ dataDir, port: 0, llmMode: 'scripted', ...options })
  const origin = await app.listen()
  liveApps.add(app)
  return { app, origin, dataDir }
}

async function post(origin, path, body, cookie) {
  const headers = { 'content-type': 'application/json' }
  if (cookie !== undefined) headers.cookie = cookie
  const response = await fetch(`${origin}${path}`, {
    method: 'POST', headers, body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), ...body }),
  })
  return { response, value: await response.json() }
}

async function identity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  const value = await response.json()
  const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0])
  return {
    workspaceId: value.workspaceId,
    workspaceCookie: cookies.find(cookie => cookie.startsWith('dsh-browser-native-principal=')),
    sessionCookie: cookies.find(cookie => cookie.startsWith('dsh-browser-native-session-principal=')),
  }
}

function operationInput(identityValue, sessionId, operationId, payload) {
  return {
    operationId,
    principalId: identityValue.workspaceCookie.split('=')[1],
    sessionId,
    workspaceId: identityValue.workspaceId,
    ownerEpoch: 1,
    workspaceFencingToken: 1,
    turn: 1,
    step: 1,
    callId: `call-${operationId}`,
    toolName: 'business_update',
    toolCallSeq: 1,
    operationKind: 'business-update',
    payloadDigest: digestCrossStoreValue(payload),
    payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
  }
}

async function ledgerPost(origin, identityValue, operation, body) {
  return await post(origin, `/api/browser-native/workspace/cross-store-operation/${operation}`, body, identityValue.workspaceCookie)
}

async function ledgerQuery(origin, identityValue, sessionId, operationId) {
  const response = await fetch(`${origin}/api/browser-native/workspace/cross-store-operation/${operationId}?protocolVersion=1&workspaceId=${identityValue.workspaceId}&sessionId=${sessionId}`, {
    headers: { cookie: identityValue.workspaceCookie },
  })
  return { response, value: await response.json() }
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

describe('cross-store checkpoint and receipt ledger', () => {
  it('keeps pending and unknown distinct from committed', () => {
    assert.equal(reconcileCrossStoreState({ workspaceStatus: 'committed', sessionStatus: 'committed', businessStatus: 'committed' }), 'reconciled')
    assert.equal(reconcileCrossStoreState({ workspaceStatus: 'committed', sessionStatus: 'pending', businessStatus: 'committed' }), 'workspace-committed-session-pending')
    assert.equal(reconcileCrossStoreState({ workspaceStatus: 'pending', sessionStatus: 'committed', businessStatus: 'committed' }), 'session-committed-workspace-pending')
    assert.equal(reconcileCrossStoreState({ workspaceStatus: 'committed', sessionStatus: 'committed', businessStatus: 'unknown' }), 'unknown')
    assert.equal(reconcileCrossStoreState({ workspaceStatus: 'conflict', sessionStatus: 'committed', businessStatus: 'committed' }), 'conflict')
    assert.throws(() => createCrossStoreCheckpoint({ operationId: randomUUID(), sessionId: randomUUID(), workspaceId: randomUUID(), ownerEpoch: 1, workspaceFencingToken: 1, nextSessionSeq: 2, durableThroughSeq: 3, workspaceRevision: 1, workspaceStatus: 'pending', sessionStatus: 'pending', businessStatus: 'pending' }), /durableThroughSeq/)
  })

  it('deduplicates an unknown business response and preserves the effect count', async () => {
    let dropResponse = true
    const { origin } = await start({ testHooks: {
      dropCrossStoreBusinessResponse: () => {
        if (!dropResponse) return false
        dropResponse = false
        return true
      },
    } })
    const identityValue = await identity(origin)
    const sessionId = randomUUID()
    const payload = { ticketId: 'ticket-17', action: 'approve' }
    const operationId = randomUUID()
    const input = operationInput(identityValue, sessionId, operationId, payload)
    const created = await ledgerPost(origin, identityValue, 'intent', input)
    assert.equal(created.response.ok, true, JSON.stringify(created.value))
    const duplicateIntent = await ledgerPost(origin, identityValue, 'intent', input)
    assert.equal(duplicateIntent.value.replayed, true)

    await assert.rejects(fetch(`${origin}/api/browser-native/workspace/cross-store-operation/business`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: identityValue.workspaceCookie },
      body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), operationId, payload }),
    }))
    const retried = await ledgerPost(origin, identityValue, 'business', { operationId, payload })
    assert.equal(retried.response.ok, true, JSON.stringify(retried.value))
    assert.equal(retried.value.replayed, true)
    assert.equal(retried.value.businessEffectCount, 1)
    assert.equal(retried.value.decision.decision, 'pending')
    const queried = await ledgerQuery(origin, identityValue, sessionId, operationId)
    assert.equal(queried.value.receipts.business.status, 'committed')
    assert.equal(queried.value.businessEffectCount, 1)
  })

  it('rejects identity and payload reuse before a second side effect', async () => {
    const { origin } = await start()
    const identityValue = await identity(origin)
    const sessionId = randomUUID()
    const payload = { ticketId: 'ticket-18', action: 'reject' }
    const operationId = randomUUID()
    const input = operationInput(identityValue, sessionId, operationId, payload)
    assert.equal((await ledgerPost(origin, identityValue, 'intent', input)).response.ok, true)
    const differentPayload = { ticketId: 'ticket-18', action: 'approve' }
    const reused = await ledgerPost(origin, identityValue, 'intent', { ...input, payloadDigest: digestCrossStoreValue(differentPayload) })
    assert.equal(reused.response.status, 409)
    assert.equal(reused.value.error.code, 'OPERATION_ID_REUSED')
    const wrongIdentity = await ledgerPost(origin, identityValue, 'receipt', {
      operationId,
      kind: 'business',
      status: 'committed',
      receipt: { effectId: randomUUID() },
      identity: { ...input, ownerEpoch: 2 },
    })
    assert.equal(wrongIdentity.response.status, 409)
    assert.equal(wrongIdentity.value.error.code, 'RECEIPT_IDENTITY_MISMATCH')
    const business = await ledgerPost(origin, identityValue, 'business', { operationId, payload: differentPayload })
    assert.equal(business.response.status, 409)
    assert.equal(business.value.error.code, 'OPERATION_ID_REUSED')
  })

  it('reconciles Workspace, Session, and business receipts after a backend restart', async () => {
    const { origin, app, dataDir } = await start()
    const identityValue = await identity(origin)
    const sessionId = randomUUID()
    const operationId = randomUUID()
    const payload = { ticketId: 'ticket-19', action: 'approve' }
    const input = operationInput(identityValue, sessionId, operationId, payload)
    await ledgerPost(origin, identityValue, 'intent', input)
    await ledgerPost(origin, identityValue, 'business', { operationId, payload })
    const session = await post(origin, '/api/browser-native/session/create', {
      sessionId,
      header: { id: sessionId, version: 1, createdAt: 1_700_000_000_000, cwd: '/workspace' },
      inheritedEventCount: 0,
    }, identityValue.sessionCookie)
    assert.equal(session.response.ok, true, JSON.stringify(session.value))
    const receiptBase = {
      operationId,
      workspaceId: identityValue.workspaceId,
      revision: 1,
      digest: createHash('sha256').update('manifest').digest('hex'),
    }
    await ledgerPost(origin, identityValue, 'receipt', {
      operationId,
      kind: 'workspace',
      status: 'committed',
      receipt: { ...receiptBase, changedPaths: ['tickets/ticket-19.json'] },
      identity: input,
    })
    await ledgerPost(origin, identityValue, 'receipt', {
      operationId,
      kind: 'session',
      status: 'committed',
      receipt: { sessionId, seq: 0, durableThroughSeq: 0 },
      identity: input,
    })
    const beforeRestart = await ledgerQuery(origin, identityValue, sessionId, operationId)
    assert.equal(beforeRestart.value.decision.decision, 'reconciled', JSON.stringify(beforeRestart.value))
    await app.close()
    liveApps.delete(app)
    const restarted = await createBrowserNativeV2Server({ dataDir, port: 0, llmMode: 'scripted' })
    liveApps.add(restarted)
    const restartedOrigin = await restarted.listen()
    const afterRestart = await ledgerQuery(restartedOrigin, identityValue, sessionId, operationId)
    assert.equal(afterRestart.value.decision.decision, 'reconciled')
    assert.equal(afterRestart.value.businessEffectCount, 1)
  })
})
