import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createObservabilityJournal } from '../observability-journal.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'

const principalCookie = 'dsh-browser-native-principal'
const sessionCookie = 'dsh-browser-native-session-principal'

test('two editors arbitrate one lease without tearing the Session log', async () => {
  const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-editor-')))
  let image
  let app
  let origin

  const call = async (principal, path, body) => {
    const headers = { cookie: `${principalCookie}=${principal}; ${sessionCookie}=${principal}` }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
    return { status: response.status, body: parsed }
  }

  const createIdentity = async () => {
    const known = new Set(app.workspaces.identities.keys())
    const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
    assert.equal(response.status, 200, await response.text())
    const principal = [...app.workspaces.identities.keys()].find(key => !known.has(key))
    assert.equal(typeof principal, 'string')
    return principal
  }

  const restart = async () => {
    app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
    origin = await app.listen(0)
  }

  try {
    image = await createRuntimeValidationDist({ roster: 'browser' })
    await restart()
    const owner = await createIdentity()
    const alice = await createIdentity()
    const bob = await createIdentity()
    const carol = await createIdentity()

    const sessionId = `sess-editor-${randomUUID()}`
    const created = await call(owner, '/api/browser-native/session/create', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      header: { id: sessionId, version: 4, createdAt: Date.now(), cwd: '/dsh/home/workspace' },
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const ownerRef = { ownerToken: created.body.owner.ownerToken, ownerEpoch: created.body.owner.ownerEpoch }
    const seeded = await call(owner, '/api/browser-native/session/append', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      ...ownerRef,
      expectedNextSeq: 0,
      events: [
        { seq: 0, type: 'user', data: { text: 'owner starts' } },
        { seq: 1, type: 'assistant', data: { text: 'owner replies' } },
      ],
    })
    assert.equal(seeded.status, 200, JSON.stringify(seeded.body))

    const shareAlice = await call(owner, '/api/browser-native/session/share', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      viewerPrincipalId: alice,
      role: 'editor',
    })
    assert.equal(shareAlice.status, 200, JSON.stringify(shareAlice.body))
    assert.equal(shareAlice.body.share.role, 'editor')
    const shareBob = await call(owner, '/api/browser-native/session/share', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      viewerPrincipalId: bob,
      role: 'editor',
    })
    assert.equal(shareBob.status, 200, JSON.stringify(shareBob.body))
    const shareCarol = await call(owner, '/api/browser-native/session/share', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      viewerPrincipalId: carol,
    })
    assert.equal(shareCarol.status, 200, JSON.stringify(shareCarol.body))
    assert.equal(shareCarol.body.share.role, 'viewer')

    const viewerAppend = await call(carol, '/api/browser-native/session/append', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      ...ownerRef,
      expectedNextSeq: 2,
      events: [{ seq: 2, type: 'user', data: { text: 'viewer write' } }],
    })
    assert.equal(viewerAppend.status, 403, JSON.stringify(viewerAppend.body))
    assert.equal(viewerAppend.body.error.code, 'SESSION_READ_ONLY')

    const aliceOpen = await call(alice, '/api/browser-native/session/open', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      access: 'write',
    })
    assert.equal(aliceOpen.status, 200, JSON.stringify(aliceOpen.body))
    assert.equal(aliceOpen.body.role, 'editor')
    assert.equal(aliceOpen.body.shared, true)
    assert.equal(aliceOpen.body.owner, undefined, 'an editor must not receive the owner lease')
    const aliceLease = aliceOpen.body.editor
    assert.equal(typeof aliceLease.editorToken, 'string')
    assert.equal(aliceLease.editorEpoch, 1)

    const bobOpen = await call(bob, '/api/browser-native/session/open', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      access: 'write',
    })
    assert.equal(bobOpen.status, 409, JSON.stringify(bobOpen.body))
    assert.equal(bobOpen.body.error.code, 'SESSION_EDITOR_LEASE_HELD')
    assert.ok(Number(bobOpen.body.error.retryAfterMs) > 0)

    const stolenAppend = await call(bob, '/api/browser-native/session/append', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      ...aliceLease,
      expectedNextSeq: 2,
      events: [{ seq: 2, type: 'user', data: { text: 'bob uses alice lease' } }],
    })
    assert.equal(stolenAppend.status, 409, JSON.stringify(stolenAppend.body))
    assert.equal(stolenAppend.body.error.code, 'SESSION_EDITOR_LEASE_LOST')

    const aliceAppend = await call(alice, '/api/browser-native/session/append', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      ...aliceLease,
      expectedNextSeq: 2,
      events: [{ seq: 2, type: 'user', data: { text: 'alice edits' } }],
    })
    assert.equal(aliceAppend.status, 200, JSON.stringify(aliceAppend.body))
    const flushed = await call(alice, '/api/browser-native/session/flush', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      ...aliceLease,
    })
    assert.equal(flushed.status, 200, JSON.stringify(flushed.body))

    const racing = await Promise.all([
      call(alice, '/api/browser-native/session/append', {
        protocolVersion: 1,
        requestId: randomUUID(),
        sessionId,
        ...aliceLease,
        expectedNextSeq: 3,
        events: [{ seq: 3, type: 'user', data: { text: 'race a' } }],
      }),
      call(alice, '/api/browser-native/session/append', {
        protocolVersion: 1,
        requestId: randomUUID(),
        sessionId,
        ...aliceLease,
        expectedNextSeq: 3,
        events: [{ seq: 3, type: 'user', data: { text: 'race b' } }],
      }),
    ])
    assert.deepEqual(racing.map(entry => entry.status).sort(), [200, 409])
    const loser = racing.find(entry => entry.status === 409)
    assert.equal(loser.body.error.code, 'SEQ_CONFLICT')

    const aliceReleased = await call(alice, '/api/browser-native/session/editor-lease', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      ...aliceLease,
      action: 'release',
    })
    assert.equal(aliceReleased.status, 200, JSON.stringify(aliceReleased.body))
    assert.equal(aliceReleased.body.released, true)

    const bobClaim = await call(bob, '/api/browser-native/session/editor-lease', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      action: 'claim',
    })
    assert.equal(bobClaim.status, 200, JSON.stringify(bobClaim.body))
    assert.equal(bobClaim.body.editor.editorEpoch, 2)
    const staleAlice = await call(alice, '/api/browser-native/session/append', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      ...aliceLease,
      expectedNextSeq: 4,
      events: [{ seq: 4, type: 'user', data: { text: 'stale alice' } }],
    })
    assert.equal(staleAlice.status, 409, JSON.stringify(staleAlice.body))
    assert.equal(staleAlice.body.error.code, 'SESSION_EDITOR_LEASE_LOST')

    const revoke = await call(owner, '/api/browser-native/session/editor-lease', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      ...ownerRef,
      action: 'revoke',
    })
    assert.equal(revoke.status, 200, JSON.stringify(revoke.body))
    assert.equal(revoke.body.revoked, true)
    const afterRevoke = await call(bob, '/api/browser-native/session/append', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      ...bobClaim.body.editor,
      expectedNextSeq: 4,
      events: [{ seq: 4, type: 'user', data: { text: 'after revoke' } }],
    })
    assert.equal(afterRevoke.status, 409, JSON.stringify(afterRevoke.body))
    assert.equal(afterRevoke.body.error.code, 'SESSION_EDITOR_LEASE_LOST')

    const read = await call(owner, '/api/browser-native/session/read', {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
    })
    assert.equal(read.status, 200, JSON.stringify(read.body))
    assert.deepEqual(read.body.events.map(event => event.seq), [0, 1, 2, 3])

    const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
    const audit = app.collaborationAudit()
    const actions = audit.map(entry => `${entry.action}:${entry.outcome}`)
    assert.ok(actions.includes('share.grant:granted'))
    assert.ok(actions.includes('editor-lease.claim:granted'))
    assert.ok(actions.includes('editor-lease.claim:denied'))
    assert.ok(actions.includes('session.append:accepted'))
    assert.ok(actions.includes('editor-lease.release:released'))
    assert.ok(actions.includes('editor-lease.revoke:revoked'))
    const deniedLease = audit.find(entry => entry.action === 'editor-lease.claim' && entry.outcome === 'denied')
    assert.equal(deniedLease.code, 'SESSION_EDITOR_LEASE_HELD')
    assert.equal(deniedLease.principalDigest, digest(bob))
    const editorAppends = audit.filter(entry => entry.action === 'session.append' && entry.role === 'editor')
    assert.ok(editorAppends.length >= 2)
    for (const entry of editorAppends) {
      assert.equal(entry.sessionId, sessionId)
      assert.ok(entry.fromSeq <= entry.toSeq)
    }
    const leaseGranted = audit.find(entry => entry.action === 'editor-lease.claim' && entry.outcome === 'granted')
    assert.equal(leaseGranted.principalDigest, digest(alice))
    assert.equal(leaseGranted.editorEpoch, 1)

    const shareFile = JSON.parse(await readFile(join(dataDir, 'session-shares.json'), 'utf8'))
    const roles = new Map(shareFile.shares.map(share => [share.viewerPrincipalId, share.role]))
    assert.equal(roles.get(alice), 'editor')
    assert.equal(roles.get(bob), 'editor')
    assert.equal(roles.get(carol), 'viewer')

    await app.close()
    app = undefined
    const journal = createObservabilityJournal({ dataDir })
    const restored = await journal.restore()
    assert.equal(restored.integrity.verified, true)
    assert.ok(restored.collaboration.some(entry => entry.action === 'session.append'))

    await restart()
    const restoredAudit = app.collaborationAudit()
    assert.ok(restoredAudit.length >= audit.length, 'collaboration audit must survive a backend restart')
    assert.ok(restoredAudit.some(entry => entry.action === 'editor-lease.claim' && entry.outcome === 'denied'))

    const summary = {
      result: 'passed',
      scope: 'session-editor-collaboration',
      sessionId,
      editorLeaseEpochs: [aliceLease.editorEpoch, bobClaim.body.editor.editorEpoch],
      concurrentAppendStatuses: racing.map(entry => entry.status).sort(),
      staleLeaseDenied: 'SESSION_EDITOR_LEASE_LOST',
      viewerWriteDenied: 'SESSION_READ_ONLY',
      logSeqs: [0, 1, 2, 3],
      auditEntries: audit.length,
      auditRestored: restoredAudit.length,
      grantRoles: Object.fromEntries(roles),
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`)
  } finally {
    await app?.close().catch(() => {})
    await image?.cleanup()
    if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
  }
})
