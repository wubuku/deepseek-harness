import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const liveApps = new Set()
const temporaryDirectories = new Set()

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'browser-native-attachment-gc-'))
  temporaryDirectories.add(directory)
  return directory
}

async function start(options) {
  const app = await createBrowserNativeV2Server(options)
  const origin = await app.listen(0)
  liveApps.add(app)
  return { app, origin }
}

async function identityFor(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  const cookies = response.headers.getSetCookie()
  const workspaceCookie = cookies.find(cookie => cookie.startsWith('dsh-browser-native-principal='))
  const sessionCookie = cookies.find(cookie => cookie.startsWith('dsh-browser-native-session-principal='))
  assert.ok(workspaceCookie)
  assert.ok(sessionCookie)
  return {
    workspaceId: body.workspaceId,
    cookie: workspaceCookie.split(';', 1)[0],
    sessionCookie: sessionCookie.split(';', 1)[0],
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function upload(origin, identity, bytes, name) {
  const hash = digest(bytes)
  const url = new URL(`${origin}/api/browser-native/workspace/attachments/${hash}`)
  url.searchParams.set('workspaceId', identity.workspaceId)
  url.searchParams.set('name', name)
  const response = await fetch(url, {
    method: 'PUT',
    headers: { cookie: identity.cookie, 'content-type': 'application/octet-stream' },
    body: bytes,
  })
  const receipt = await response.json()
  assert.equal(response.ok, true, JSON.stringify(receipt))
  assert.equal(receipt.attachmentId, `sha256:${hash}`)
  return { hash, receipt }
}

async function download(origin, identity, hash) {
  const url = new URL(`${origin}/api/browser-native/workspace/attachments/${hash}`)
  url.searchParams.set('workspaceId', identity.workspaceId)
  return await fetch(url, { headers: { cookie: identity.cookie } })
}

async function createSessionWithAttachment(origin, identity, sessionId, attachment) {
  const created = await fetch(`${origin}/api/browser-native/session/create`, {
    method: 'POST',
    headers: { cookie: identity.sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: 1,
      requestId: `${sessionId}-create`,
      sessionId,
      header: { id: sessionId, version: 1, createdAt: 1_700_000_000_000, cwd: '/workspace' },
      inheritedEventCount: 0,
    }),
  })
  const createdBody = await created.json()
  assert.equal(created.ok, true, JSON.stringify(createdBody))
  const append = await fetch(`${origin}/api/browser-native/session/append`, {
    method: 'POST',
    headers: { cookie: identity.sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: 1,
      requestId: `${sessionId}-append`,
      sessionId,
      ownerToken: createdBody.owner.ownerToken,
      ownerEpoch: createdBody.owner.ownerEpoch,
      expectedNextSeq: 0,
      events: [{
        seq: 0,
        type: 'user/message',
        data: {
          content: [{
            type: 'file',
            attachment: { attachmentId: `sha256:${attachment.hash}`, name: 'in-use.txt', bytes: attachment.receipt.bytes },
          }],
        },
      }],
    }),
  })
  assert.equal(append.ok, true, await append.text())
  const flush = await fetch(`${origin}/api/browser-native/session/flush`, {
    method: 'POST',
    headers: { cookie: identity.sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: 1,
      requestId: `${sessionId}-flush`,
      sessionId,
      ownerToken: createdBody.owner.ownerToken,
      ownerEpoch: createdBody.owner.ownerEpoch,
    }),
  })
  assert.equal(flush.ok, true, await flush.text())
}

async function gcToken(origin, identity) {
  const response = await fetch(
    `${origin}/api/browser-native/workspace/attachments/gc-token?workspaceId=${identity.workspaceId}`,
    { headers: { cookie: identity.cookie } },
  )
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  return body
}

async function gc(origin, identity, token) {
  const response = await fetch(`${origin}/api/browser-native/workspace/attachments/gc`, {
    method: 'POST',
    headers: { cookie: identity.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: 1,
      requestId: 'attachment-gc',
      workspaceId: identity.workspaceId,
      token,
    }),
  })
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  return body
}

async function waitFor(condition, description, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await condition()
    if (value !== undefined) return value
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
  }
  throw new Error(`timed out waiting for ${description}`)
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

describe('browser-native scheduled attachment GC', () => {
  it('sweeps on an injected clock without waiting for the grace period and fences a second instance', async () => {
    const dataDir = await temporaryDirectory()
    let now = Date.now()
    const first = await start({
      dataDir,
      port: 0,
      llmMode: 'scripted',
      attachmentGcMinAgeMs: 60_000,
      attachmentGcSweepIntervalMs: 10,
      testHooks: { attachmentGcNow: () => now },
    })
    const origin = first.origin
    const identity = await identityFor(origin)

    const inUseBytes = Buffer.from('attachment referenced by a durable Session\n')
    const inUse = await upload(origin, identity, inUseBytes, 'in-use.txt')
    await createSessionWithAttachment(origin, identity, 'scheduled-gc-session', inUse)
    const orphanBytes = Buffer.from('orphan before the injected clock advances\n')
    const orphan = await upload(origin, identity, orphanBytes, 'orphan.txt')

    const early = await first.app.sweepAttachments()
    assert.deepEqual(early.workspaces.find(workspace => workspace.workspaceId === identity.workspaceId).deleted, [],
      'an object younger than the grace period must survive a scheduled sweep')

    now += 120_000
    const swept = await first.app.sweepAttachments()
    const sweptWorkspace = swept.workspaces.find(workspace => workspace.workspaceId === identity.workspaceId)
    assert.deepEqual(sweptWorkspace.deleted, [orphan.hash])
    assert.equal(sweptWorkspace.kept, 1)
    assert.equal((await download(origin, identity, inUse.hash)).status, 200)
    assert.equal((await download(origin, identity, orphan.hash)).status, 404)

    const lateBytes = Buffer.from('orphan swept by the interval timer\n')
    const late = await upload(origin, identity, lateBytes, 'late-orphan.txt')
    now += 120_000
    await waitFor(async () => {
      try {
        await access(join(dataDir, 'attachments-v1', identity.workspaceId, late.hash.slice(0, 2), late.hash))
        return undefined
      } catch (error) {
        if (error?.code === 'ENOENT') return true
        throw error
      }
    }, 'the interval-triggered sweep to remove the aged orphan')
    assert.equal((await download(origin, identity, inUse.hash)).status, 200,
      'the interval sweep must keep the referenced object')

    await assert.rejects(createBrowserNativeV2Server({
      dataDir,
      port: 0,
      llmMode: 'scripted',
      attachmentGcMinAgeMs: 60_000,
      attachmentGcSweepIntervalMs: 10,
      testHooks: { attachmentGcNow: () => now },
    }), error => {
      assert.equal(error.code, 'BACKEND_ALREADY_RUNNING', 'a scheduled sweeper must not run in a second live instance')
      return true
    })
    assert.equal((await download(origin, identity, inUse.hash)).status, 200)

    process.stdout.write(`${JSON.stringify({
      result: 'passed',
      scope: 'scheduled-attachment-gc-with-injected-clock',
      skippedYoungOrphan: early.workspaces.find(workspace => workspace.workspaceId === identity.workspaceId).deleted.length === 0,
      deletedAfterClockAdvance: sweptWorkspace.deleted,
      keptAfterClockAdvance: sweptWorkspace.kept,
      intervalSweptOrphan: true,
      inUseBytesIntact: true,
      secondInstanceRejected: 'BACKEND_ALREADY_RUNNING',
    })}\n`)
  })
})

describe('browser-native attachment GC', () => {
  it('keeps referenced objects, removes orphans, and rejects stale generations', async () => {
    const dataDir = await temporaryDirectory()
    const first = await start({ dataDir, port: 0, llmMode: 'scripted', attachmentGcMinAgeMs: 0, attachmentGcSweepIntervalMs: 0 })
    const origin = first.origin
    const identity = await identityFor(origin)

    const inUseBytes = Buffer.from('attachment referenced by a durable Session\n')
    const inUse = await upload(origin, identity, inUseBytes, 'in-use.txt')
    await createSessionWithAttachment(origin, identity, 'attachment-gc-session', inUse)

    const orphanBytes = Buffer.from('attachment without any Session reference\n')
    const orphan = await upload(origin, identity, orphanBytes, 'orphan.txt')

    const before = await gcToken(origin, identity)
    const collected = await gc(origin, identity, before.token)
    assert.equal(collected.skipped, undefined)
    assert.deepEqual(collected.deleted, [orphan.hash])
    assert.deepEqual(collected.failures, [])
    assert.equal(collected.scanned, 2)
    assert.equal(collected.kept, 1)
    assert.equal(collected.generation, before.generation)

    const kept = await download(origin, identity, inUse.hash)
    assert.equal(kept.status, 200)
    assert.deepEqual(Buffer.from(await kept.arrayBuffer()), inUseBytes)
    assert.equal((await download(origin, identity, orphan.hash)).status, 404)

    const replay = await gc(origin, identity, (await gcToken(origin, identity)).token)
    assert.deepEqual(replay.deleted, [])
    assert.equal(replay.kept, 1)

    const staleIssued = await gcToken(origin, identity)
    const lateBytes = Buffer.from('attachment uploaded after the GC scan started\n')
    const late = await upload(origin, identity, lateBytes, 'late.txt')
    const stale = await gc(origin, identity, staleIssued.token)
    assert.equal(stale.skipped, 'scan-stale')
    assert.deepEqual(stale.deleted, [])
    assert.equal((await download(origin, identity, late.hash)).status, 200)

    const reusedIssued = await gcToken(origin, identity)
    const reused = await upload(origin, identity, inUseBytes, 'in-use-copy.txt')
    assert.equal(reused.receipt.reused, true)
    const rejectedReuse = await gc(origin, identity, reusedIssued.token)
    assert.equal(rejectedReuse.skipped, 'scan-stale')
    assert.equal((await download(origin, identity, inUse.hash)).status, 200)

    const finalPass = await gc(origin, identity, (await gcToken(origin, identity)).token)
    assert.deepEqual(finalPass.deleted, [late.hash])
    assert.equal((await download(origin, identity, inUse.hash)).status, 200)

    await first.app.close()
    liveApps.delete(first.app)
    const restarted = await start({ dataDir, port: 0, llmMode: 'scripted', attachmentGcMinAgeMs: 0, attachmentGcSweepIntervalMs: 0 })
    const afterRestart = await gc(restarted.origin, identity, finalPass.token)
    assert.equal(afterRestart.skipped, 'scan-stale')
    assert.equal((await download(restarted.origin, identity, inUse.hash)).status, 200)
  })
})
