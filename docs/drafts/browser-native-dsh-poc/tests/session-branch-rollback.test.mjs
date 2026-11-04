import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const SESSION_FORMAT_VERSION = 4
const PROTOCOL_VERSION = 1

function requestId() {
  return randomUUID()
}

async function call(origin, cookie, path, { method = 'POST', body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => undefined)
  return { status: response.status, body: payload }
}

async function identity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const payload = await response.json()
  const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
  const principal = response.headers.getSetCookie()
    .map(value => value.split(';', 1)[0])
    .find(value => value.startsWith('dsh-browser-native-principal='))
  assert.ok(principal, 'identity must mint a principal cookie')
  return { cookie, principalId: principal.slice('dsh-browser-native-principal='.length), workspaceId: payload.workspaceId }
}

async function revision(origin, cookie, workspaceId) {
  const response = await fetch(`${origin}/api/browser-native/workspace/revision?protocolVersion=${String(PROTOCOL_VERSION)}&workspaceId=${encodeURIComponent(workspaceId)}`, {
    headers: { cookie },
  })
  assert.equal(response.status, 200)
  return (await response.json()).revision
}

function turnEvents(startSeq, turn) {
  return [
    { seq: startSeq, type: 'turn/start', data: { turn } },
    { seq: startSeq + 1, type: 'assistant/message', data: { content: [{ type: 'text', text: `turn ${String(turn)}` }] } },
    { seq: startSeq + 2, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ]
}

test('Session branch and turn rollback keep sequence, attachment, and workspace consistency', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-branch-'))
  const app = await createBrowserNativeV2Server({ dataDir, llmMode: 'scripted' })
  t.after(async () => {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const origin = await app.listen(0)
  const owner = await identity(origin)
  const viewer = await identity(origin)
  assert.notEqual(owner.principalId, viewer.principalId)

  const bytes = Buffer.from('branch-inherited attachment\n', 'utf8')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const uploaded = await fetch(`${origin}/api/browser-native/workspace/attachments/${hash}?workspaceId=${encodeURIComponent(owner.workspaceId)}&name=note.txt`, {
    method: 'PUT',
    headers: { cookie: owner.cookie, 'content-type': 'application/octet-stream' },
    body: bytes,
  })
  assert.equal(uploaded.status, 200)

  const sourceId = 'branch-source-1'
  const created = await call(origin, owner.cookie, '/api/browser-native/session/create', {
    body: {
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId(),
      sessionId: sourceId,
      header: { id: sourceId, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), cwd: '/workspace', isSeeded: false },
    },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const ownerLease = { ownerToken: created.body.owner.ownerToken, ownerEpoch: created.body.owner.ownerEpoch }
  const events = [
    {
      seq: 0,
      type: 'user/message',
      data: { content: [
        { type: 'file', attachment: { attachmentId: `sha256:${hash}`, name: 'note.txt' } },
        { type: 'text', text: 'BRANCH_SOURCE_PROMPT' },
      ] },
    },
    ...turnEvents(1, 1),
    ...turnEvents(4, 2),
  ]
  const appended = await call(origin, owner.cookie, '/api/browser-native/session/append', {
    body: {
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId(),
      sessionId: sourceId,
      ...ownerLease,
      expectedNextSeq: 0,
      events,
    },
  })
  assert.equal(appended.status, 200, JSON.stringify(appended.body))
  const flushed = await call(origin, owner.cookie, '/api/browser-native/session/flush', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: sourceId, ...ownerLease },
  })
  assert.equal(flushed.status, 200, JSON.stringify(flushed.body))
  const readSource = await call(origin, owner.cookie, '/api/browser-native/session/read', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: sourceId, offset: 0 },
  })
  assert.equal(readSource.status, 200)
  const sourceEvents = structuredClone(readSource.body.events)
  const revisionBefore = await revision(origin, owner.cookie, owner.workspaceId)
  assert.equal(readSource.body.nextSeq, 7)

  const branchId = 'branch-turn-1'
  const branchBody = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId(),
    sessionId: sourceId,
    newSessionId: branchId,
    atTurn: 1,
    ...ownerLease,
  }
  const branched = await call(origin, owner.cookie, '/api/browser-native/session/branch', { body: branchBody })
  assert.equal(branched.status, 200, JSON.stringify(branched.body))
  assert.equal(branched.body.sessionId, branchId)
  assert.equal(branched.body.inheritedEventCount, 4)
  assert.equal(branched.body.nextSeq, 5)
  assert.equal(branched.body.header.parentSession, sourceId)
  assert.equal(branched.body.header.isSeeded, true)
  assert.deepEqual(branched.body.branch, {
    intent: 'branch', parentSessionId: sourceId, boundarySeq: 3, boundaryTurn: 1, workspaceRevision: revisionBefore,
  })

  const replay = await call(origin, owner.cookie, '/api/browser-native/session/branch', { body: branchBody })
  assert.equal(replay.status, 200)
  assert.deepEqual(replay.body, branched.body, 'a replayed branch request must not create another Session')

  const readBranch = await call(origin, owner.cookie, '/api/browser-native/session/read', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: branchId, offset: 0 },
  })
  assert.equal(readBranch.status, 200)
  assert.deepEqual(readBranch.body.events.slice(0, 4), sourceEvents.slice(0, 4), 'the inherited prefix must stay byte-identical')
  assert.deepEqual(readBranch.body.events[4], {
    seq: 4, type: 'session/end-seed', data: { inherited: true },
  })
  assert.deepEqual(readBranch.body.events.map(event => event.seq), [0, 1, 2, 3, 4])
  assert.equal(readBranch.body.nextSeq, 5)

  const rollbackId = 'branch-rollback-turn-2'
  const rollback = await call(origin, owner.cookie, '/api/browser-native/session/branch', {
    body: {
      protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: sourceId,
      newSessionId: rollbackId, atTurn: 2, intent: 'rollback', ...ownerLease,
    },
  })
  assert.equal(rollback.status, 200, JSON.stringify(rollback.body))
  assert.equal(rollback.body.inheritedEventCount, 7)
  assert.equal(rollback.body.nextSeq, 8)
  assert.equal(rollback.body.branch.intent, 'rollback')
  assert.equal(rollback.body.branch.boundaryTurn, 2)

  const readAfter = await call(origin, owner.cookie, '/api/browser-native/session/read', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: sourceId, offset: 0 },
  })
  assert.equal(readAfter.status, 200)
  assert.deepEqual(readAfter.body.events, sourceEvents, 'branching and rollback must not mutate the source log')
  assert.equal(readAfter.body.nextSeq, 7)
  assert.deepEqual(readSource.body.header, readAfter.body.header)
  const revisionAfter = await revision(origin, owner.cookie, owner.workspaceId)
  assert.equal(revisionAfter, revisionBefore, 'branch and rollback must not write the workspace')

  const opened = await call(origin, owner.cookie, '/api/browser-native/session/open', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: branchId, access: 'write' },
  })
  assert.equal(opened.status, 200, JSON.stringify(opened.body))
  assert.ok(opened.body.owner?.ownerToken)
  const continuation = [
    { seq: 5, type: 'user/message', data: { content: [{ type: 'text', text: 'BRANCH_CONTINUATION' }] } },
    ...turnEvents(6, 2),
  ]
  const continued = await call(origin, owner.cookie, '/api/browser-native/session/append', {
    body: {
      protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: branchId,
      ...opened.body.owner, expectedNextSeq: 5, events: continuation,
    },
  })
  assert.equal(continued.status, 200, JSON.stringify(continued.body))
  const readContinued = await call(origin, owner.cookie, '/api/browser-native/session/read', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: branchId, offset: 0 },
  })
  assert.deepEqual(readContinued.body.events.map(event => event.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(readContinued.body.nextSeq, 9)
  const closed = await call(origin, owner.cookie, '/api/browser-native/session/close', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: branchId, ...opened.body.owner },
  })
  assert.equal(closed.status, 200, JSON.stringify(closed.body))

  const exported = await call(origin, owner.cookie, '/api/browser-native/session/export', {
    body: { workspaceId: owner.workspaceId, sessionId: branchId },
  })
  assert.equal(exported.status, 200, JSON.stringify(exported.body))
  assert.equal(exported.body.attachments.length, 1)
  assert.equal(exported.body.attachments[0].attachmentId, `sha256:${hash}`)
  assert.equal(Buffer.from(exported.body.attachments[0].data, 'base64').toString('utf8'), bytes.toString('utf8'))

  const invalidBoundary = await call(origin, owner.cookie, '/api/browser-native/session/branch', {
    body: {
      protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: sourceId,
      newSessionId: 'branch-invalid-seq', atSeq: 2, ...ownerLease,
    },
  })
  assert.equal(invalidBoundary.status, 400)
  assert.equal(invalidBoundary.body.error.code, 'SESSION_BRANCH_BOUNDARY_INVALID')
  const invalidTurn = await call(origin, owner.cookie, '/api/browser-native/session/branch', {
    body: {
      protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: sourceId,
      newSessionId: 'branch-invalid-turn', atTurn: 9, ...ownerLease,
    },
  })
  assert.equal(invalidTurn.status, 400)
  assert.equal(invalidTurn.body.error.code, 'SESSION_BRANCH_BOUNDARY_INVALID')

  const shared = await call(origin, owner.cookie, '/api/browser-native/session/share', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: sourceId, viewerPrincipalId: viewer.principalId },
  })
  assert.equal(shared.status, 200, JSON.stringify(shared.body))
  const viewerBranch = await call(origin, viewer.cookie, '/api/browser-native/session/branch', {
    body: {
      protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: sourceId,
      newSessionId: 'branch-viewer-denied', atTurn: 1,
    },
  })
  assert.equal(viewerBranch.status, 403)
  assert.equal(viewerBranch.body.error.code, 'SESSION_READ_ONLY')
})
