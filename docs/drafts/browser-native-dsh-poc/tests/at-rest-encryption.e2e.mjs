/**
 * Data written by the browser-native v2 backend is unreadable at rest.
 *
 * The run creates a Session, a Workspace blob, and an attachment under a
 * deployment key, then scans every file the backend wrote for the marker
 * strings. It also proves restart, backup-copy, bundle export/import, and
 * upgrade-style restart stay consistent with the key, and that a missing key,
 * a different key, or a damaged ciphertext refuses startup instead of serving
 * substituted data.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createAtRestCipher, keyIdFor } from '../at-rest-crypto.mjs'

const PROMPT_MARKER = 'at-rest-prompt-marker-71f3'
const FILE_MARKER = 'at-rest-file-content-marker-9ac2'
const ATTACHMENT_MARKER = 'at-rest-attachment-marker-b40e'
const KEY = Buffer.alloc(32, 21)
const WRONG_KEY = Buffer.alloc(32, 22)
const keyring = { keys: [{ keyId: keyIdFor(KEY), key: KEY }], activeKeyId: keyIdFor(KEY) }
const wrongKeyring = { keys: [{ keyId: keyIdFor(WRONG_KEY), key: WRONG_KEY }], activeKeyId: keyIdFor(WRONG_KEY) }

const directories = []
const apps = []

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-at-rest-e2e-'))
  directories.push(directory)
  return directory
}

async function launch(dataDir, keyringOption = keyring) {
  const app = await createBrowserNativeV2Server({
    dataDir,
    llmMode: 'scripted',
    ...(keyringOption === undefined ? {} : { atRestKeyring: keyringOption }),
  })
  const origin = await app.listen()
  apps.push(app)
  return { app, origin }
}

async function identity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.ok, true)
  const body = await response.json()
  const cookies = response.headers.getSetCookie()
  const cookie = cookies.find(value => value.startsWith('dsh-browser-native-principal=')).split(';', 1)[0]
  const sessionCookie = cookies.find(value => value.startsWith('dsh-browser-native-session-principal=')).split(';', 1)[0]
  return { workspaceId: body.workspaceId, cookie, sessionCookie }
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

async function readSession(origin, caller, sessionId) {
  const read = await postSession(origin, caller, '/api/browser-native/session/read', {
    sessionId, offset: 0, length: 10,
  })
  return read.events
}

async function fetchAttachment(origin, caller, hash) {
  const response = await fetch(
    `${origin}/api/browser-native/workspace/attachments/${hash}?workspaceId=${caller.workspaceId}`,
    { headers: { cookie: caller.cookie } },
  )
  assert.equal(response.ok, true)
  return Buffer.from(await response.arrayBuffer())
}

/** Every regular file below a directory, excluding the lock file. */
async function listFiles(root, prefix = '') {
  const found = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...await listFiles(join(root, entry.name), relative))
    else if (entry.isFile() && entry.name !== '.browser-native-backend.lock') found.push(relative)
  }
  return found
}

/** Assert that no stored file contains the marker at rest. */
async function assertNoPlaintextMarker(dataDir, marker) {
  const offenders = []
  for (const relative of await listFiles(dataDir)) {
    const info = await stat(join(dataDir, relative))
    if (info.size > 2 * 1024 * 1024) continue
    if ((await readFile(join(dataDir, relative))).includes(Buffer.from(marker))) offenders.push(relative)
  }
  assert.deepEqual(offenders, [], `marker "${marker}" was readable at rest in ${offenders.join(', ')}`)
}

async function expectStartupRefused(dataDir, keyringOption, code) {
  await assert.rejects(
    createBrowserNativeV2Server({ dataDir, llmMode: 'scripted', ...(keyringOption === undefined ? {} : { atRestKeyring: keyringOption }) }),
    error => error?.code === code,
    `startup should fail with ${code}`,
  )
  // A failed startup can leave its ownership lock behind; the run owns it here.
  await rm(join(dataDir, '.browser-native-backend.lock'), { force: true })
}

let dataDir
let caller
let sessionId
let blobHash
let attachmentHash
let exportedBundle

try {
  dataDir = await temporaryDirectory()
  const first = await launch(dataDir)
  caller = await identity(first.origin)
  const denied = await fetch(`${first.origin}/api/browser-native/session/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: caller.sessionCookie },
    body: JSON.stringify({
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId: 'at-rest-audit-probe',
      offset: 0,
      length: 1,
    }),
  })
  assert.equal(denied.status, 404)
  const denialJournal = join(dataDir, 'observability', 'access-denials.jsonl')
  let denialBytes
  for (let attempt = 0; attempt < 40 && denialBytes === undefined; attempt += 1) {
    denialBytes = await readFile(denialJournal).catch(() => undefined)
    if (denialBytes === undefined) await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.notEqual(denialBytes, undefined, 'access denial audit entry should be journaled')
  const denialLine = denialBytes.toString('utf8').trim().split('\n')[0]
  const journalCipher = createAtRestCipher(keyring)
  const denialRecord = JSON.parse(journalCipher.decryptText(denialLine, 'observability/access-denials.jsonl'))
  assert.equal(denialRecord.record.status, 404)
  assert.equal(denialBytes.includes(Buffer.from('"status":404')), false, 'journal bytes should not expose the record')

  sessionId = `at-rest-${randomUUID()}`
  const created = await postSession(first.origin, caller, '/api/browser-native/session/create', {
    sessionId,
    header: { id: sessionId, version: 4, createdAt: 1_700_000_000_000, cwd: '/workspace' },
  })
  await postSession(first.origin, caller, '/api/browser-native/session/append', {
    sessionId,
    ownerToken: created.owner.ownerToken,
    expectedNextSeq: 0,
    events: [{ seq: 0, type: 'user/message', data: { content: PROMPT_MARKER }, at: '2026-11-05T00:00:00.000Z' }],
  })

  const blob = Buffer.from(`${FILE_MARKER} and its workspace body`)
  blobHash = createHash('sha256').update(blob).digest('hex')
  const upload = await fetch(`${first.origin}/api/browser-native/workspace/blob/${blobHash}`, {
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
  await postWorkspace(first.origin, caller, '/api/browser-native/workspace/commit', {
    operationId: randomUUID(),
    baseRevision: 0,
    changes: [{ path: 'notes.txt', kind: 'file', hash: blobHash, bytes: blob.byteLength, mode: 0o600 }],
  })

  const attachment = Buffer.from(`${ATTACHMENT_MARKER} attachment body`)
  attachmentHash = createHash('sha256').update(attachment).digest('hex')
  const stored = await fetch(
    `${first.origin}/api/browser-native/workspace/attachments/${attachmentHash}?workspaceId=${caller.workspaceId}&name=secret.txt`,
    {
      method: 'PUT',
      headers: { cookie: caller.cookie, 'content-type': 'application/octet-stream' },
      body: attachment,
    },
  )
  assert.equal(stored.ok, true, await stored.text())
  await postSession(first.origin, caller, '/api/browser-native/session/append', {
    sessionId,
    ownerToken: created.owner.ownerToken,
    expectedNextSeq: 1,
    events: [{
      seq: 1,
      type: 'user/message',
      data: {
        content: [{
          type: 'file',
          attachment: { attachmentId: `sha256:${attachmentHash}`, name: 'secret.txt' },
        }],
      },
      at: '2026-11-05T00:00:01.000Z',
    }],
  })

  const sessionEvents = await readSession(first.origin, caller, sessionId)
  assert.equal(sessionEvents.length, 2)
  assert.equal(JSON.stringify(sessionEvents).includes(PROMPT_MARKER), true)
  await postSession(first.origin, caller, '/api/browser-native/session/flush', {
    sessionId, ownerToken: created.owner.ownerToken,
  })
  const downloaded = await fetch(
    `${first.origin}/api/browser-native/workspace/blob/${blobHash}?protocolVersion=1&workspaceId=${caller.workspaceId}`,
    { headers: { cookie: caller.cookie } },
  )
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), blob)
  assert.deepEqual(await fetchAttachment(first.origin, caller, attachmentHash), attachment)

  exportedBundle = await postSession(first.origin, caller, '/api/browser-native/session/export', {
    sessionId, workspaceId: caller.workspaceId,
  })
  assert.equal(JSON.stringify(exportedBundle).includes(PROMPT_MARKER), true)
  assert.equal(exportedBundle.attachments[0].data, attachment.toString('base64'))

  for (const marker of [PROMPT_MARKER, FILE_MARKER, ATTACHMENT_MARKER]) await assertNoPlaintextMarker(dataDir, marker)
  await first.app.close()

  const backupDir = join(await temporaryDirectory(), 'restored')
  await cp(dataDir, backupDir, { recursive: true })
  for (const marker of [PROMPT_MARKER, FILE_MARKER, ATTACHMENT_MARKER]) await assertNoPlaintextMarker(backupDir, marker)
  const restored = await launch(backupDir)
  assert.equal((await readSession(restored.origin, caller, sessionId)).length, 2)
  assert.deepEqual(await fetchAttachment(restored.origin, caller, attachmentHash), attachment)
  await restored.app.close()

  const restarted = await launch(dataDir)
  assert.equal((await readSession(restarted.origin, caller, sessionId)).length, 2)
  assert.deepEqual(await fetchAttachment(restarted.origin, caller, attachmentHash), attachment)
  await restarted.app.close()

  const importedDir = await temporaryDirectory()
  const importer = await launch(importedDir)
  const importedCaller = await identity(importer.origin)
  await postSession(importer.origin, importedCaller, '/api/browser-native/session/import', {
    workspaceId: importedCaller.workspaceId,
    bundle: exportedBundle,
  })
  assert.equal((await readSession(importer.origin, importedCaller, sessionId)).length, 2)
  assert.deepEqual(await fetchAttachment(importer.origin, importedCaller, attachmentHash), attachment)
  for (const marker of [PROMPT_MARKER, FILE_MARKER, ATTACHMENT_MARKER]) await assertNoPlaintextMarker(importedDir, marker)
  await importer.app.close()

  await expectStartupRefused(dataDir, undefined, 'AT_REST_KEY_REQUIRED')
  await expectStartupRefused(dataDir, wrongKeyring, 'AT_REST_KEY_INVALID')

  const sessionFile = join(dataDir, 'sessions', `${sessionId}.json`)
  const damaged = Buffer.from(await readFile(sessionFile))
  damaged[damaged.length - 1] ^= 0x01
  await writeFile(sessionFile, damaged)
  await expectStartupRefused(dataDir, keyring, 'AT_REST_CIPHERTEXT_CORRUPT')

  process.stdout.write('at-rest encryption e2e: PASS\n')
} finally {
  for (const app of apps.splice(0)) await app.close().catch(() => {})
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
}
