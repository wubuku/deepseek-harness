/**
 * At-rest key rotation keeps the backend serving and leaves no plaintext.
 *
 * A deployment adds a successor key to its key file and calls the rotation
 * endpoint. The run proves reads keep working while rotation is paused, queued
 * writes land afterwards under the successor, every surface is rewritten, old
 * key material can no longer read new data, and export, import, backup, and
 * restart stay consistent. A damaged file aborts rotation while the previous
 * key still opens untouched data.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createAtRestCipher, envelopeKeyId, keyIdFor } from '../at-rest-crypto.mjs'
import { listAtRestTargets } from '../at-rest-rotation.mjs'

const PROMPT_MARKER = 'rotation-prompt-marker-4d2a'
const FILE_MARKER = 'rotation-file-marker-6be1'
const ATTACHMENT_MARKER = 'rotation-attachment-marker-8cf3'
const OLD_KEY = Buffer.alloc(32, 31)
const NEW_KEY = Buffer.alloc(32, 32)
const OLD_ID = keyIdFor(OLD_KEY)
const NEW_ID = keyIdFor(NEW_KEY)
const oldKeyring = { keys: [{ keyId: OLD_ID, key: OLD_KEY }], activeKeyId: OLD_ID }
const newKeyring = { keys: [{ keyId: NEW_ID, key: NEW_KEY }], activeKeyId: NEW_ID }
const bridgedKeyring = { keys: [{ keyId: NEW_ID, key: NEW_KEY }, { keyId: OLD_ID, key: OLD_KEY }], activeKeyId: NEW_ID }

const directories = []
const apps = []

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-at-rest-rotation-e2e-'))
  directories.push(directory)
  return directory
}

async function launch(dataDir, options = {}) {
  const app = await createBrowserNativeV2Server({ dataDir, llmMode: 'scripted', ...options })
  const origin = await app.listen()
  apps.push(app)
  return { app, origin }
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

async function postWorkspace(origin, caller, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: caller.cookie },
    body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), workspaceId: caller.workspaceId, ...body }),
  })
  const value = await response.json()
  assert.equal(response.ok, true, JSON.stringify(value))
  return value
}

async function postSession(origin, caller, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: caller.sessionCookie },
    body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), ...body }),
  })
  const value = await response.json()
  assert.equal(response.ok, true, JSON.stringify(value))
  return value
}

async function readSession(origin, caller, sessionId) {
  return (await postSession(origin, caller, '/api/browser-native/session/read', { sessionId, offset: 0, length: 20 })).events
}

async function fetchAttachment(origin, caller, hash) {
  const response = await fetch(
    `${origin}/api/browser-native/workspace/attachments/${hash}?workspaceId=${caller.workspaceId}`,
    { headers: { cookie: caller.cookie } },
  )
  assert.equal(response.ok, true)
  return Buffer.from(await response.arrayBuffer())
}

/** Every regular file below a directory, excluding the process lock. */
async function listFiles(root, prefix = '') {
  const found = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...await listFiles(join(root, entry.name), relative))
    else if (entry.isFile() && entry.name !== '.browser-native-backend.lock') found.push(relative)
  }
  return found
}

async function assertNoPlaintextMarker(dataDir, marker) {
  const offenders = []
  for (const relative of await listFiles(dataDir)) {
    const bytes = await readFile(join(dataDir, relative))
    if (bytes.includes(Buffer.from(marker))) offenders.push(relative)
  }
  assert.deepEqual(offenders, [], `marker "${marker}" was readable at rest in ${offenders.join(', ')}`)
}

async function rotate(origin) {
  const response = await fetch(`${origin}/api/browser-native/admin/at-rest-key/rotate`, { method: 'POST' })
  return { response, body: await response.json() }
}

/** Create one flushed Session, Workspace blob, and attachment. */
async function seed(origin) {
  const caller = await identity(origin)
  const sessionId = `rotation-${randomUUID()}`
  const created = await postSession(origin, caller, '/api/browser-native/session/create', {
    sessionId,
    header: { id: sessionId, version: 4, createdAt: 1_700_000_000_000, cwd: '/workspace' },
  })
  await postSession(origin, caller, '/api/browser-native/session/append', {
    sessionId,
    ownerToken: created.owner.ownerToken,
    expectedNextSeq: 0,
    events: [{ seq: 0, type: 'user/message', data: { content: PROMPT_MARKER }, at: '2026-11-05T00:00:00.000Z' }],
  })
  const blob = Buffer.from(`${FILE_MARKER} workspace body`)
  const blobHash = createHash('sha256').update(blob).digest('hex')
  const upload = await fetch(`${origin}/api/browser-native/workspace/blob/${blobHash}`, {
    method: 'PUT',
    headers: {
      cookie: caller.cookie,
      'content-type': 'application/octet-stream',
      'x-browser-native-protocol': '1',
      'x-request-id': randomUUID(),
      'x-workspace-id': caller.workspaceId,
    },
    body: blob,
  })
  assert.equal(upload.ok, true, await upload.text())
  await postWorkspace(origin, caller, '/api/browser-native/workspace/commit', {
    operationId: randomUUID(),
    baseRevision: 0,
    changes: [{ path: 'notes.txt', kind: 'file', hash: blobHash, bytes: blob.byteLength, mode: 0o600 }],
  })
  const attachment = Buffer.from(`${ATTACHMENT_MARKER} attachment body`)
  const attachmentHash = createHash('sha256').update(attachment).digest('hex')
  const stored = await fetch(
    `${origin}/api/browser-native/workspace/attachments/${attachmentHash}?workspaceId=${caller.workspaceId}&name=secret.txt`,
    { method: 'PUT', headers: { cookie: caller.cookie, 'content-type': 'application/octet-stream' }, body: attachment },
  )
  assert.equal(stored.ok, true, await stored.text())
  await postSession(origin, caller, '/api/browser-native/session/append', {
    sessionId,
    ownerToken: created.owner.ownerToken,
    expectedNextSeq: 1,
    events: [{
      seq: 1,
      type: 'user/message',
      data: {
        content: [{ type: 'file', attachment: { attachmentId: `sha256:${attachmentHash}`, name: 'secret.txt' } }],
      },
      at: '2026-11-05T00:00:01.000Z',
    }],
  })
  await postSession(origin, caller, '/api/browser-native/session/flush', {
    sessionId, ownerToken: created.owner.ownerToken,
  })
  return { caller, sessionId, blob, blobHash, attachment, attachmentHash, ownerToken: created.owner.ownerToken }
}

try {
  const dataDir = await temporaryDirectory()
  let startedResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  let releaseResolve
  const gate = new Promise(resolve => { releaseResolve = resolve })
  const service = await launch(dataDir, {
    atRestKeyring: oldKeyring,
    reloadAtRestKeyring: async () => bridgedKeyring,
    testHooks: {
      atRestRotationStarted: async () => {
        startedResolve()
        await gate
      },
    },
  })
  const fixture = await seed(service.origin)
  const probe = await fetch(`${service.origin}/api/browser-native/session/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: fixture.caller.sessionCookie },
    body: JSON.stringify({
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId: 'rotation-audit-probe',
      offset: 0,
      length: 1,
    }),
  })
  assert.equal(probe.status, 404)
  let denialBytes
  for (let attempt = 0; attempt < 40 && denialBytes === undefined; attempt += 1) {
    denialBytes = await readFile(join(dataDir, 'observability', 'access-denials.jsonl')).catch(() => undefined)
    if (denialBytes === undefined) await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.notEqual(denialBytes, undefined, 'access denial audit entry should be journaled')
  const bundleBefore = await postSession(service.origin, fixture.caller, '/api/browser-native/session/export', {
    sessionId: fixture.sessionId, workspaceId: fixture.caller.workspaceId,
  })

  const rotationPromise = rotate(service.origin)
  await started
  const health = await fetch(`${service.origin}/api/browser-native/health`)
  assert.equal(health.status, 200)
  assert.equal((await readSession(service.origin, fixture.caller, fixture.sessionId)).length, 2)
  let writeSettled = false
  const queuedWrite = postSession(service.origin, fixture.caller, '/api/browser-native/session/append', {
    sessionId: fixture.sessionId,
    ownerToken: fixture.ownerToken,
    expectedNextSeq: 2,
    events: [{ seq: 2, type: 'user/message', data: { content: 'rotation queued write' }, at: '2026-11-05T00:00:02.000Z' }],
  }).finally(() => { writeSettled = true })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(writeSettled, false, 'a state-changing request must wait for rotation')
  releaseResolve()
  await queuedWrite
  await postSession(service.origin, fixture.caller, '/api/browser-native/session/flush', {
    sessionId: fixture.sessionId, ownerToken: fixture.ownerToken,
  })
  const { response, body: report } = await rotationPromise
  assert.equal(response.status, 200, JSON.stringify(report))
  assert.equal(report.fromKeyId, OLD_ID)
  assert.equal(report.toKeyId, NEW_ID)
  assert.deepEqual(report.retired, [OLD_ID])
  assert.equal(report.files.sessions, 1)
  assert.equal(report.files.blobs, 1)
  assert.equal(report.files.attachments, 1)

  assert.equal((await readSession(service.origin, fixture.caller, fixture.sessionId)).length, 3)
  assert.deepEqual(await fetchAttachment(service.origin, fixture.caller, fixture.attachmentHash), fixture.attachment)
  for (const target of await listAtRestTargets(dataDir)) {
    assert.equal(envelopeKeyId(await readFile(target.path)), NEW_ID, target.context)
  }
  const journalLine = (await readFile(join(dataDir, 'observability', 'access-denials.jsonl'), 'utf8')).trim().split('\n')[0]
  assert.equal(JSON.parse(createAtRestCipher(newKeyring).decryptText(journalLine, 'observability/access-denials.jsonl')).record.status, 404)
  for (const marker of [PROMPT_MARKER, FILE_MARKER, ATTACHMENT_MARKER]) await assertNoPlaintextMarker(dataDir, marker)
  const bundleAfter = await postSession(service.origin, fixture.caller, '/api/browser-native/session/export', {
    sessionId: fixture.sessionId, workspaceId: fixture.caller.workspaceId,
  })
  assert.equal(
    JSON.stringify(bundleAfter.session.events.slice(0, bundleBefore.session.events.length).map(event => event.data)),
    JSON.stringify(bundleBefore.session.events.map(event => event.data)),
  )
  assert.equal(bundleAfter.attachments[0].data, bundleBefore.attachments[0].data)
  await service.app.close()

  const oldOnly = createAtRestCipher(oldKeyring)
  await assert.rejects(
    oldOnly.readFile(join(dataDir, 'sessions', `${fixture.sessionId}.json`), `session/${fixture.sessionId}.json`),
    error => error?.code === 'AT_REST_KEY_UNKNOWN',
  )
  await assert.rejects(
    createBrowserNativeV2Server({ dataDir, llmMode: 'scripted', atRestKeyring: oldKeyring }),
    error => error?.code === 'AT_REST_KEY_INVALID',
  )
  await rm(join(dataDir, '.browser-native-backend.lock'), { force: true })

  const backupDir = join(await temporaryDirectory(), 'restored')
  await cp(dataDir, backupDir, { recursive: true })
  const backup = await launch(backupDir, { atRestKeyring: newKeyring })
  assert.equal((await readSession(backup.origin, fixture.caller, fixture.sessionId)).length, 3)
  assert.deepEqual(await fetchAttachment(backup.origin, fixture.caller, fixture.attachmentHash), fixture.attachment)
  await backup.app.close()

  const importedDir = await temporaryDirectory()
  const importer = await launch(importedDir, { atRestKeyring: newKeyring })
  const importedCaller = await identity(importer.origin)
  await postSession(importer.origin, importedCaller, '/api/browser-native/session/import', {
    workspaceId: importedCaller.workspaceId,
    bundle: bundleAfter,
  })
  assert.equal((await readSession(importer.origin, importedCaller, fixture.sessionId)).length, 3)
  assert.deepEqual(await fetchAttachment(importer.origin, importedCaller, fixture.attachmentHash), fixture.attachment)
  await importer.app.close()

  const failedDir = await temporaryDirectory()
  const failing = await launch(failedDir, {
    atRestKeyring: oldKeyring,
    reloadAtRestKeyring: async () => bridgedKeyring,
  })
  const failedCaller = await identity(failing.origin)
  const failedBlob = Buffer.from(`${FILE_MARKER} rollback body`)
  const failedBlobHash = createHash('sha256').update(failedBlob).digest('hex')
  const failedUpload = await fetch(`${failing.origin}/api/browser-native/workspace/blob/${failedBlobHash}`, {
    method: 'PUT',
    headers: {
      cookie: failedCaller.cookie,
      'content-type': 'application/octet-stream',
      'x-browser-native-protocol': '1',
      'x-request-id': randomUUID(),
      'x-workspace-id': failedCaller.workspaceId,
    },
    body: failedBlob,
  })
  assert.equal(failedUpload.ok, true, await failedUpload.text())
  await postWorkspace(failing.origin, failedCaller, '/api/browser-native/workspace/commit', {
    operationId: randomUUID(),
    baseRevision: 0,
    changes: [{ path: 'rollback.txt', kind: 'file', hash: failedBlobHash, bytes: failedBlob.byteLength, mode: 0o600 }],
  })
  const failedAttachment = Buffer.from(`${ATTACHMENT_MARKER} rollback attachment`)
  const failedAttachmentHash = createHash('sha256').update(failedAttachment).digest('hex')
  const failedStore = await fetch(
    `${failing.origin}/api/browser-native/workspace/attachments/${failedAttachmentHash}?workspaceId=${failedCaller.workspaceId}&name=rollback.txt`,
    { method: 'PUT', headers: { cookie: failedCaller.cookie, 'content-type': 'application/octet-stream' }, body: failedAttachment },
  )
  assert.equal(failedStore.ok, true, await failedStore.text())

  // A crash-consistent copy taken before rotation is the rollback source.
  const rollbackDir = join(await temporaryDirectory(), 'rollback')
  await cp(failedDir, rollbackDir, { recursive: true })
  await rm(join(rollbackDir, '.browser-native-backend.lock'), { force: true })

  // Damage the only blob so rotation aborts before rewriting attachments.
  const blobTarget = (await listAtRestTargets(failedDir)).find(target => target.surface === 'blobs')
  const damaged = Buffer.from(await readFile(blobTarget.path))
  damaged[damaged.length - 17] ^= 0x01
  await writeFile(blobTarget.path, damaged)
  const failed = await rotate(failing.origin)
  assert.notEqual(failed.response.ok, true)
  assert.equal((await fetch(`${failing.origin}/api/browser-native/health`)).status, 200)
  assert.deepEqual(await fetchAttachment(failing.origin, failedCaller, failedAttachmentHash), failedAttachment)
  await failing.app.close()

  const rollback = await launch(rollbackDir, { atRestKeyring: oldKeyring })
  assert.equal((await fetch(`${rollback.origin}/api/browser-native/health`)).status, 200)
  assert.deepEqual(await fetchAttachment(rollback.origin, failedCaller, failedAttachmentHash), failedAttachment)
  const rolledBack = await fetch(
    `${rollback.origin}/api/browser-native/workspace/blob/${failedBlobHash}?protocolVersion=1&workspaceId=${failedCaller.workspaceId}`,
    { headers: { cookie: failedCaller.cookie } },
  )
  assert.deepEqual(Buffer.from(await rolledBack.arrayBuffer()), failedBlob)
  await rollback.app.close()

  process.stdout.write('at-rest key rotation e2e: PASS\n')
} finally {
  for (const app of apps.splice(0)) await app.close().catch(() => {})
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
}
