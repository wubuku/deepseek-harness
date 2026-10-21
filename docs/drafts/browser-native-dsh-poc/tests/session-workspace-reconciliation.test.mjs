import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { classifyWorkspaceSession, createWorkspaceReceipt } from '../workspace-session-reconciliation.mjs'

const liveApps = new Set()
const temporaryDirectories = new Set()

async function start() {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-reconciliation-'))
  temporaryDirectories.add(dataDir)
  const app = await createBrowserNativeV2Server({ dataDir, port: 0, llmMode: 'scripted' })
  const origin = await app.listen()
  liveApps.add(app)
  return { app, origin }
}

async function post(origin, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), ...body }),
  })
  const value = await response.json()
  return { response, value }
}

async function workspaceIdentity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  const value = await response.json()
  return { workspaceId: value.workspaceId, cookie: response.headers.get('set-cookie').split(';', 1)[0] }
}

async function workspacePost(origin, identity, operation, body) {
  const response = await fetch(`${origin}/api/browser-native/workspace/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: identity.cookie },
    body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), workspaceId: identity.workspaceId, ...body }),
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

describe('Browser-Native Session/Workspace reconciliation', () => {
  it('classifies the four cross-storage outcomes without treating pending as saved', () => {
    assert.equal(classifyWorkspaceSession({ workspaceStatus: 'committed', sessionStatus: 'committed' }), 'reconciled')
    assert.equal(classifyWorkspaceSession({ workspaceStatus: 'committed', sessionStatus: 'pending' }), 'workspace-committed-session-pending')
    assert.equal(classifyWorkspaceSession({ workspaceStatus: 'pending', sessionStatus: 'committed' }), 'session-committed-workspace-pending')
    assert.equal(classifyWorkspaceSession({ workspaceStatus: 'unknown', sessionStatus: 'unknown' }), 'result-unknown')
    assert.throws(() => createWorkspaceReceipt({ operationId: 'op', status: 'committed' }), /workspace receipt is invalid/)
  })

  it('associates one committed Workspace operation with a durable Session receipt', async () => {
    const { origin } = await start()
    const identity = await workspaceIdentity(origin)
    const sessionId = randomUUID()
    const header = { id: sessionId, version: 1, createdAt: 1_700_000_000_000, cwd: '/workspace' }
    const created = await post(origin, '/api/browser-native/session/create', { sessionId, header, inheritedEventCount: 0 })
    assert.equal(created.response.ok, true, JSON.stringify(created.value))
    const ownerToken = created.value.owner.ownerToken

    const bytes = Buffer.from('reconciled content\n')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const uploadResponse = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}`, {
      method: 'PUT',
      headers: { cookie: identity.cookie, 'content-type': 'application/octet-stream', 'x-browser-native-protocol': '1', 'x-request-id': randomUUID(), 'x-workspace-id': identity.workspaceId },
      body: bytes,
    })
    assert.equal(uploadResponse.ok, true)
    const operationId = randomUUID()
    const committed = await workspacePost(origin, identity, 'commit', {
      operationId,
      baseRevision: 0,
      changes: [{ path: 'reconciled.txt', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }],
    })
    assert.equal(committed.response.ok, true, JSON.stringify(committed.value))
    const receipt = createWorkspaceReceipt({
      operationId,
      workspaceId: identity.workspaceId,
      baseRevision: 0,
      revision: committed.value.revision,
      manifestDigest: committed.value.digest,
      paths: committed.value.changedPaths,
      status: 'committed',
    })
    const appended = await post(origin, '/api/browser-native/session/append', {
      sessionId,
      ownerToken,
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'workspace/receipt', data: receipt }],
    })
    assert.equal(appended.response.ok, true, JSON.stringify(appended.value))
    const flushed = await post(origin, '/api/browser-native/session/flush', { sessionId, ownerToken })
    assert.equal(flushed.response.ok, true, JSON.stringify(flushed.value))

    const read = await post(origin, '/api/browser-native/session/read', { sessionId, offset: 0 })
    assert.deepEqual(read.value.events[0].data, receipt)
    const operation = await fetch(`${origin}/api/browser-native/workspace/operation/${operationId}?protocolVersion=1&workspaceId=${identity.workspaceId}`, { headers: { cookie: identity.cookie } })
    const operationBody = await operation.json()
    assert.equal(operationBody.found, true)
    assert.equal(operationBody.receipt.operationId, operationId)
    assert.equal(classifyWorkspaceSession({ workspaceStatus: 'committed', sessionStatus: 'committed' }), 'reconciled')
  })

  it('keeps a Workspace commit observable when Session ownership blocks the receipt append', async () => {
    const { origin } = await start()
    const identity = await workspaceIdentity(origin)
    const sessionId = randomUUID()
    const created = await post(origin, '/api/browser-native/session/create', {
      sessionId,
      header: { id: sessionId, version: 1, createdAt: 1_700_000_000_000, cwd: '/workspace' },
      inheritedEventCount: 0,
    })
    const bytes = Buffer.from('workspace first\n')
    const hash = createHash('sha256').update(bytes).digest('hex')
    await fetch(`${origin}/api/browser-native/workspace/blob/${hash}`, {
      method: 'PUT',
      headers: { cookie: identity.cookie, 'content-type': 'application/octet-stream', 'x-browser-native-protocol': '1', 'x-request-id': randomUUID(), 'x-workspace-id': identity.workspaceId },
      body: bytes,
    })
    const committed = await workspacePost(origin, identity, 'commit', {
      operationId: randomUUID(), baseRevision: 0,
      changes: [{ path: 'workspace-first.txt', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }],
    })
    assert.equal(committed.response.ok, true)
    const blocked = await post(origin, '/api/browser-native/session/append', {
      sessionId,
      ownerToken: 'stale-owner',
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'workspace/receipt', data: { status: 'committed' } }],
    })
    assert.equal(blocked.response.status, 409)
    const read = await post(origin, '/api/browser-native/session/read', { sessionId, offset: 0 })
    assert.deepEqual(read.value.events, [])
    assert.equal(classifyWorkspaceSession({ workspaceStatus: 'committed', sessionStatus: 'pending' }), 'workspace-committed-session-pending')
    assert.equal(typeof created.value.owner.ownerToken, 'string')
  })
})
