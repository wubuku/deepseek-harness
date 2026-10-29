import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const ATTACHMENTS = '/api/browser-native/workspace/attachments'

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function openServer(dataDir, options = {}) {
  const app = await createBrowserNativeV2Server({ dataDir, port: 0, llmMode: 'scripted', ...options })
  return { app, origin: await app.listen() }
}

async function newIdentity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const body = await response.json()
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('dsh-browser-native-principal='))
  assert.ok(cookie)
  return { workspaceId: body.workspaceId, cookie: cookie.split(';', 1)[0] }
}

async function sendAttachment(origin, identity, hash, bytes, name = 'attachment.txt') {
  const stream = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += 3) {
        controller.enqueue(bytes.subarray(offset, Math.min(offset + 3, bytes.byteLength)))
      }
      controller.close()
    },
  })
  return await fetch(`${origin}${ATTACHMENTS}/${hash}?workspaceId=${identity.workspaceId}&name=${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { cookie: identity.cookie, 'content-type': 'application/octet-stream' },
    body: stream,
    duplex: 'half',
  })
}

async function listFiles(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await listFiles(path))
    else output.push(entry.name)
  }
  return output
}

test('browser-native attachment objects stream, verify, isolate, and survive backend restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-attachments-'))
  let server = await openServer(dataDir, { attachmentMaxBytes: 32 })
  t.after(async () => {
    await server.app.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const owner = await newIdentity(server.origin)
  const stranger = await newIdentity(server.origin)
  const content = Buffer.from('attachment payload: UTF-8 雪\n')
  const hash = digest(content)
  const upload = await sendAttachment(server.origin, owner, hash, content, '../report:final.txt')
  assert.equal(upload.status, 200)
  const receipt = await upload.json()
  assert.deepEqual(receipt, {
    protocolVersion: 1,
    attachmentId: `sha256:${hash}`,
    name: 'report_final.txt',
    bytes: content.byteLength,
    reused: false,
  })

  const duplicate = await sendAttachment(server.origin, owner, hash, content, 'second-name.txt')
  assert.equal(duplicate.status, 200)
  assert.equal((await duplicate.json()).reused, true)

  const reusedWithWrongBytes = await sendAttachment(server.origin, owner, hash, Buffer.alloc(content.byteLength, 0x61))
  assert.equal(reusedWithWrongBytes.status, 400)
  assert.equal((await reusedWithWrongBytes.json()).error.code, 'ATTACHMENT_HASH_MISMATCH')

  const download = await fetch(`${server.origin}${ATTACHMENTS}/${hash}?workspaceId=${owner.workspaceId}`, {
    headers: { cookie: owner.cookie },
  })
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-length'), String(content.byteLength))
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), content)

  const unauthorized = await fetch(`${server.origin}${ATTACHMENTS}/${hash}?workspaceId=${owner.workspaceId}`)
  assert.equal(unauthorized.status, 401)
  const crossWorkspace = await fetch(`${server.origin}${ATTACHMENTS}/${hash}?workspaceId=${owner.workspaceId}`, {
    headers: { cookie: stranger.cookie },
  })
  assert.equal(crossWorkspace.status, 403)

  const oversizedBytes = Buffer.alloc(33, 0x62)
  const oversized = await sendAttachment(server.origin, owner, digest(oversizedBytes), oversizedBytes)
  assert.equal(oversized.status, 413)
  assert.equal((await oversized.json()).error.code, 'ATTACHMENT_TOO_LARGE')
  assert.deepEqual(await listFiles(join(dataDir, 'attachments-v1', owner.workspaceId)), [hash],
    'failed streams must leave no partial object or staging file')

  const revisionUrl = `${server.origin}/api/browser-native/workspace/revision?protocolVersion=1&workspaceId=${owner.workspaceId}`
  const revision = await fetch(revisionUrl, { headers: { cookie: owner.cookie } })
  assert.equal(revision.status, 200)
  assert.equal((await revision.json()).revision, 0, 'attachments must not mutate the Workspace manifest revision')

  await server.app.close()
  server = await openServer(dataDir, { attachmentMaxBytes: 32 })
  const afterRestart = await fetch(`${server.origin}${ATTACHMENTS}/${hash}?workspaceId=${owner.workspaceId}`, {
    headers: { cookie: owner.cookie },
  })
  assert.equal(afterRestart.status, 200)
  assert.deepEqual(Buffer.from(await afterRestart.arrayBuffer()), content)
})

test('attachment endpoint rejects invalid hashes, media types, and byte limits', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-attachments-reject-'))
  const { app, origin } = await openServer(dataDir, { attachmentMaxBytes: 4 })
  t.after(async () => {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const owner = await newIdentity(origin)
  const bytes = Buffer.from('nope')
  const hash = digest(bytes)
  const wrongType = await fetch(`${origin}${ATTACHMENTS}/${hash}?workspaceId=${owner.workspaceId}`, {
    method: 'PUT', headers: { cookie: owner.cookie, 'content-type': 'text/plain' }, body: bytes,
  })
  assert.equal(wrongType.status, 400)
  assert.equal((await wrongType.json()).error.code, 'INVALID_REQUEST')

  const invalidHash = await fetch(`${origin}${ATTACHMENTS}/${'g'.repeat(64)}?workspaceId=${owner.workspaceId}`, {
    headers: { cookie: owner.cookie },
  })
  assert.equal(invalidHash.status, 404)

  const mismatch = await sendAttachment(origin, owner, '0'.repeat(64), bytes)
  assert.equal(mismatch.status, 400)
  assert.equal((await mismatch.json()).error.code, 'ATTACHMENT_HASH_MISMATCH')
  assert.deepEqual(await listFiles(join(dataDir, 'attachments-v1', owner.workspaceId)), [],
    'digest mismatch must not publish an object')
})

test('an interrupted attachment upload leaves no staging or published object', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-attachments-interrupted-'))
  let markUploadStarted
  const uploadStarted = new Promise(resolve => { markUploadStarted = resolve })
  const { app, origin } = await openServer(dataDir, {
    testHooks: { onAttachmentStage: stage => { if (stage === 'upload-body') markUploadStarted() } },
  })
  t.after(async () => {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const owner = await newIdentity(origin)
  const controller = new AbortController()
  const body = new ReadableStream({
    start(stream) { stream.enqueue(Buffer.alloc(32 * 1024, 0x61)) },
  })
  const upload = fetch(`${origin}${ATTACHMENTS}/${'a'.repeat(64)}?workspaceId=${owner.workspaceId}&name=interrupted.txt`, {
    method: 'PUT',
    headers: { cookie: owner.cookie, 'content-type': 'application/octet-stream' },
    body,
    duplex: 'half',
    signal: controller.signal,
  }).then(response => ({ response }), error => ({ error }))
  let startTimer
  await Promise.race([
    uploadStarted,
    new Promise((_, reject) => { startTimer = setTimeout(() => reject(new Error('backend did not start reading the upload')), 2_000) }),
  ])
  clearTimeout(startTimer)
  controller.abort()
  let settleTimer
  const outcome = await Promise.race([
    upload,
    new Promise(resolve => { settleTimer = setTimeout(() => resolve({ timeout: true }), 2_000) }),
  ])
  clearTimeout(settleTimer)
  assert.notEqual(outcome.timeout, true, 'the interrupted request must settle')
  if (outcome.response !== undefined) assert.ok(outcome.response.status >= 400)

  let remaining
  for (let attempt = 0; attempt < 50; attempt += 1) {
    remaining = await listFiles(join(dataDir, 'attachments-v1', owner.workspaceId))
    if (remaining.length === 0) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.deepEqual(remaining, [], 'an interrupted upload must remove its temporary object')
})
