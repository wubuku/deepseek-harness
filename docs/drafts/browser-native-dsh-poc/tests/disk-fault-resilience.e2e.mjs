/**
 * Disk faults are explicit, retryable, and leave no half-written state.
 *
 * ENOSPC, a read-only mount, and an I/O timeout are injected before each
 * durable write on Session flush, Workspace blob, attachment, audit journal,
 * and key rotation. Every attempt must name the failing surface with an
 * actionable status, the same request must succeed after the fault clears,
 * audit chains must still verify, and an interrupted rotation must stay
 * readable with its previous keys and finish on retry.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createAtRestCipher, envelopeKeyId, keyIdFor } from '../at-rest-crypto.mjs'
import { listAtRestTargets } from '../at-rest-rotation.mjs'
import { createObservabilityJournal } from '../observability-journal.mjs'

const OLD_KEY = Buffer.alloc(32, 21)
const NEW_KEY = Buffer.alloc(32, 22)
const OLD_ID = keyIdFor(OLD_KEY)
const NEW_ID = keyIdFor(NEW_KEY)
const oldKeyring = { keys: [{ keyId: OLD_ID, key: OLD_KEY }], activeKeyId: OLD_ID }
const newKeyring = { keys: [{ keyId: NEW_ID, key: NEW_KEY }], activeKeyId: NEW_ID }
const bridgedKeyring = { keys: [{ keyId: NEW_ID, key: NEW_KEY }, { keyId: OLD_ID, key: OLD_KEY }], activeKeyId: NEW_ID }

const FAULTS = [
  ['ENOSPC', 'STORAGE_DISK_FULL', 507],
  ['EROFS', 'STORAGE_READ_ONLY', 503],
  ['ETIMEDOUT', 'STORAGE_TIMEOUT', 503],
]

const directories = []
const apps = []

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-disk-fault-'))
  directories.push(directory)
  return directory
}

async function launch(dataDir, options = {}) {
  const app = await createBrowserNativeV2Server({ dataDir, llmMode: 'scripted', port: 0, ...options })
  const origin = await app.listen()
  apps.push(app)
  return { app, origin }
}

/** One-shot fault hook: the next write on the armed surface fails with `code`. */
function faultController() {
  const armed = { surface: undefined, code: undefined, delayMs: 0 }
  return {
    arm(surface, code, delayMs = 0) {
      armed.surface = surface
      armed.code = code
      armed.delayMs = delayMs
    },
    clear() {
      armed.surface = undefined
    },
    hook: async surface => {
      if (armed.surface !== surface) return undefined
      const instruction = { code: armed.code, delayMs: armed.delayMs }
      armed.surface = undefined
      return instruction
    },
  }
}

async function identity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.ok, true)
  const body = await response.json()
  const cookies = response.headers.getSetCookie()
  return {
    workspaceId: body.workspaceId,
    cookie: cookies.find(value => value.startsWith('dsh-browser-native-principal=')).split(';', 1)[0],
    sessionCookie: cookies.find(value => value.startsWith('dsh-browser-native-session-principal=')).split(';', 1)[0],
  }
}

async function postSession(origin, caller, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: caller.sessionCookie },
    body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), ...body }),
  })
  return { response, body: await response.json() }
}

async function postWorkspace(origin, caller, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: caller.cookie },
    body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), workspaceId: caller.workspaceId, ...body }),
  })
  return { response, body: await response.json() }
}

async function putBlob(origin, caller, hash, bytes) {
  return await fetch(`${origin}/api/browser-native/workspace/blob/${hash}`, {
    method: 'PUT',
    headers: {
      cookie: caller.cookie,
      'content-type': 'application/octet-stream',
      'x-browser-native-protocol': '1',
      'x-request-id': randomUUID(),
      'x-workspace-id': caller.workspaceId,
    },
    body: bytes,
  })
}

async function putAttachment(origin, caller, hash, bytes) {
  return await fetch(
    `${origin}/api/browser-native/workspace/attachments/${hash}?workspaceId=${caller.workspaceId}&name=disk-fault.txt`,
    { method: 'PUT', headers: { cookie: caller.cookie, 'content-type': 'application/octet-stream' }, body: bytes },
  )
}

async function fetchAttachment(origin, caller, hash) {
  const response = await fetch(
    `${origin}/api/browser-native/workspace/attachments/${hash}?workspaceId=${caller.workspaceId}`,
    { headers: { cookie: caller.cookie } },
  )
  assert.equal(response.ok, true)
  return Buffer.from(await response.arrayBuffer())
}

async function expectStorageFailure(response, code, status, parsed) {
  const body = parsed ?? await response.json()
  assert.equal(response.status, status, JSON.stringify(body))
  assert.equal(body.error.code, code)
  if (code === 'STORAGE_TIMEOUT') assert.equal(body.error.retryAfterMs, 5_000)
  return body
}

/** Regular files below a directory, excluding the process lock. */
async function listFiles(root, prefix = '') {
  const found = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return found
    throw error
  }
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...await listFiles(join(root, entry.name), relative))
    else if (entry.isFile() && entry.name !== '.browser-native-backend.lock') found.push(relative)
  }
  return found
}

async function waitFor(check, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail(`timed out waiting for ${label}`)
}

after(async () => {
  await Promise.all(apps.map(app => app.close().catch(() => {})))
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
})

describe('disk fault resilience', () => {
  test('Session flush reports each disk fault and retries cleanly', async () => {
    const dataDir = await temporaryDirectory()
    const faults = faultController()
    const service = await launch(dataDir, { atRestKeyring: oldKeyring, testHooks: { storageFault: faults.hook } })
    const caller = await identity(service.origin)
    const sessionId = `disk-${randomUUID()}`
    const created = await postSession(service.origin, caller, '/api/browser-native/session/create', {
      sessionId,
      header: { id: sessionId, version: 4, createdAt: 1_700_000_000_000, cwd: '/workspace' },
    })
    assert.equal(created.response.ok, true)
    await postSession(service.origin, caller, '/api/browser-native/session/append', {
      sessionId,
      ownerToken: created.body.owner.ownerToken,
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'user/message', data: { content: 'disk fault prompt' }, at: '2026-11-05T00:00:00.000Z' }],
    })

    for (const [systemCode, code, status] of FAULTS) {
      faults.arm('session', systemCode)
      const failed = await postSession(service.origin, caller, '/api/browser-native/session/flush', {
        sessionId, ownerToken: created.body.owner.ownerToken,
      })
      await expectStorageFailure(failed.response, code, status, failed.body)
      const files = await readdir(join(dataDir, 'sessions'))
      assert.deepEqual(files.filter(name => name.endsWith('.tmp')), [], 'a failed flush leaves no temporary file')
      assert.deepEqual(files.filter(name => name !== `${sessionId}.json`), [], 'a failed flush leaves no partial Session file')

      faults.clear()
      const retried = await postSession(service.origin, caller, '/api/browser-native/session/flush', {
        sessionId, ownerToken: created.body.owner.ownerToken,
      })
      assert.equal(retried.response.ok, true, JSON.stringify(retried.body))
    }
    const read = await postSession(service.origin, caller, '/api/browser-native/session/read', {
      sessionId, offset: 0, length: 10,
    })
    assert.equal(read.response.ok, true)
    assert.equal(read.body.events.length, 1)
    assert.equal(read.body.events[0].data.content, 'disk fault prompt')
    await service.app.close()
  })

  test('Workspace blob writes report each disk fault without publishing', async () => {
    const dataDir = await temporaryDirectory()
    const faults = faultController()
    const service = await launch(dataDir, { atRestKeyring: oldKeyring, testHooks: { storageFault: faults.hook } })
    const caller = await identity(service.origin)

    for (const [systemCode, code, status] of FAULTS) {
      const bytes = Buffer.from(`disk fault blob body ${systemCode}`)
      const hash = createHash('sha256').update(bytes).digest('hex')
      faults.arm('workspace-blob', systemCode)
      const failed = await putBlob(service.origin, caller, hash, bytes)
      await expectStorageFailure(failed, code, status)
      await assert.rejects(
        stat(join(dataDir, 'workspace-v2', 'blobs', hash.slice(0, 2), hash)),
        { code: 'ENOENT' },
        'a rejected blob write publishes nothing',
      )

      faults.clear()
      const retried = await putBlob(service.origin, caller, hash, bytes)
      assert.equal(retried.ok, true, await retried.text())
      const target = (await listAtRestTargets(dataDir)).find(entry => entry.context === `workspace-blob:${hash}`)
      assert.notEqual(target, undefined)
      assert.deepEqual(
        createAtRestCipher(oldKeyring).decryptBuffer(await readFile(target.path), target.context),
        bytes,
      )
    }
    await service.app.close()
  })

  test('attachment writes report each disk fault and retry to one complete object', async () => {
    const dataDir = await temporaryDirectory()
    const faults = faultController()
    const service = await launch(dataDir, { atRestKeyring: oldKeyring, testHooks: { storageFault: faults.hook } })
    const caller = await identity(service.origin)

    for (const [systemCode, code, status] of FAULTS) {
      const bytes = Buffer.from(`disk fault attachment body ${systemCode}`)
      const hash = createHash('sha256').update(bytes).digest('hex')
      faults.arm('attachment', systemCode)
      const failed = await putAttachment(service.origin, caller, hash, bytes)
      await expectStorageFailure(failed, code, status)
      const staged = (await listFiles(join(dataDir, 'attachments-v1'))).filter(name => name.includes('.part'))
      assert.deepEqual(staged, [], 'a rejected attachment write leaves no partial file')

      faults.clear()
      const retried = await putAttachment(service.origin, caller, hash, bytes)
      assert.equal(retried.ok, true, await retried.text())
      assert.deepEqual(await fetchAttachment(service.origin, caller, hash), bytes)
    }
    const stored = await listFiles(join(dataDir, 'attachments-v1'))
    assert.equal(stored.filter(name => name.includes('.part')).length, 0)
    assert.equal(stored.length, FAULTS.length, 'each retry publishes exactly one complete object')
    await service.app.close()
  })

  test('a stalled audit write is reported, never tears the ledger, and recovers', async () => {
    const dataDir = await temporaryDirectory()
    const faults = faultController()
    const service = await launch(dataDir, { atRestKeyring: oldKeyring, testHooks: { storageFault: faults.hook } })
    const caller = await identity(service.origin)
    const missing = await postSession(service.origin, caller, '/api/browser-native/session/read', {
      sessionId: `missing-${randomUUID()}`, offset: 0, length: 1,
    })
    assert.equal(missing.response.status, 404)

    const reconciliation = async () => {
      const response = await fetch(`${service.origin}/api/browser-native/observability/reconciliation`, {
        headers: { cookie: caller.sessionCookie },
      })
      assert.equal(response.ok, true)
      return await response.json()
    }

    faults.arm('audit', 'ETIMEDOUT', 40)
    const denied = await postSession(service.origin, caller, '/api/browser-native/session/read', {
      sessionId: `missing-${randomUUID()}`, offset: 0, length: 1,
    })
    assert.equal(denied.response.status, 404, 'an audit write fault must not change the response')
    await waitFor(async () => (await reconciliation()).journal.writeFailures >= 1, 'audit failure report')
    const reported = await reconciliation()
    assert.ok(reported.journal.writeFailures >= 1)
    assert.equal(reported.journal.integrity.accessDenials.verified, true, 'the previous ledger stays verifiable')

    faults.clear()
    const recovered = await postSession(service.origin, caller, '/api/browser-native/session/read', {
      sessionId: `missing-${randomUUID()}`, offset: 0, length: 1,
    })
    assert.equal(recovered.response.status, 404)

    let restored
    await waitFor(async () => {
      const verification = createObservabilityJournal({ dataDir, cipher: createAtRestCipher(oldKeyring) })
      restored = await verification.restore()
      return restored.integrity.accessDenials.verified === true && restored.accessDenials.length >= 1
    }, 'verified audit ledger')
    assert.equal(restored.integrity.accessDenials.verified, true, JSON.stringify(restored.integrity.accessDenials))
    assert.ok(restored.accessDenials.length >= 1)
    assert.equal(restored.accessDenials.at(-1).status, 404)
    const leftovers = (await listFiles(join(dataDir, 'observability'))).filter(name => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
    await service.app.close()
  })

  test('an interrupted rotation stays readable and completes on retry', async () => {
    for (const [systemCode, code, status] of FAULTS) {
      const dataDir = await temporaryDirectory()
      const faults = faultController()
      const service = await launch(dataDir, {
        atRestKeyring: oldKeyring,
        reloadAtRestKeyring: async () => bridgedKeyring,
        testHooks: { storageFault: faults.hook },
      })
      const caller = await identity(service.origin)
      const blob = Buffer.from(`rotation fault blob ${systemCode}`)
      const blobHash = createHash('sha256').update(blob).digest('hex')
      assert.equal((await putBlob(service.origin, caller, blobHash, blob)).ok, true)
      const attachment = Buffer.from(`rotation fault attachment ${systemCode}`)
      const attachmentHash = createHash('sha256').update(attachment).digest('hex')
      assert.equal((await putAttachment(service.origin, caller, attachmentHash, attachment)).ok, true)

      faults.arm('rotation', systemCode)
      const failed = await fetch(`${service.origin}/api/browser-native/admin/at-rest-key/rotate`, { method: 'POST' })
      await expectStorageFailure(failed, code, status)
      assert.equal((await fetch(`${service.origin}/api/browser-native/health`)).status, 200)
      assert.deepEqual(await fetchAttachment(service.origin, caller, attachmentHash), attachment)
      assert.deepEqual(
        createAtRestCipher(bridgedKeyring).decryptBuffer(await readFile((await listAtRestTargets(dataDir))
          .find(entry => entry.context === `workspace-blob:${blobHash}`).path), `workspace-blob:${blobHash}`),
        blob,
      )
      assert.deepEqual((await listFiles(dataDir)).filter(name => name.endsWith('.rotate.tmp')), [])

      faults.clear()
      const retried = await fetch(`${service.origin}/api/browser-native/admin/at-rest-key/rotate`, { method: 'POST' })
      const report = await retried.json()
      assert.equal(retried.status, 200, JSON.stringify(report))
      assert.equal(report.toKeyId, NEW_ID)
      for (const target of await listAtRestTargets(dataDir)) {
        const stored = await readFile(target.path)
        assert.equal(envelopeKeyId(stored), NEW_ID, target.context)
      }
      await service.app.close()
      await rm(join(dataDir, '.browser-native-backend.lock'), { force: true })

      const restarted = await launch(dataDir, { atRestKeyring: newKeyring })
      assert.deepEqual(await fetchAttachment(restarted.origin, caller, attachmentHash), attachment)
      await restarted.app.close()
    }
  })
})
