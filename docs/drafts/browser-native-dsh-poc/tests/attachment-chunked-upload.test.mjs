import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const ATTACHMENTS = '/api/browser-native/workspace/attachments'
const MiB = 1024 * 1024

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

function uploadQuery(identity, name) {
  return `workspaceId=${identity.workspaceId}&name=${encodeURIComponent(name)}`
}

async function beginUpload(origin, identity, hash, bytes, name = 'chunked.bin') {
  const response = await fetch(`${origin}${ATTACHMENTS}/${hash}/uploads?${uploadQuery(identity, name)}`, {
    method: 'POST',
    headers: { cookie: identity.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ bytes }),
  })
  return response
}

async function putChunk(origin, identity, hash, uploadId, offset, bytes) {
  return await fetch(`${origin}${ATTACHMENTS}/${hash}/uploads/${uploadId}/chunks/${String(offset)}?workspaceId=${identity.workspaceId}`, {
    method: 'PUT',
    headers: { cookie: identity.cookie, 'content-type': 'application/octet-stream' },
    body: bytes,
  })
}

async function commitUpload(origin, identity, hash, uploadId) {
  return await fetch(`${origin}${ATTACHMENTS}/${hash}/uploads/${uploadId}/commit?workspaceId=${identity.workspaceId}`, {
    method: 'POST',
    headers: { cookie: identity.cookie, 'content-type': 'application/json' },
    body: '{}',
  })
}

async function abortUpload(origin, identity, hash, uploadId) {
  return await fetch(`${origin}${ATTACHMENTS}/${hash}/uploads/${uploadId}?workspaceId=${identity.workspaceId}`, {
    method: 'DELETE',
    headers: { cookie: identity.cookie },
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

function stagingRoot(dataDir, workspaceId) {
  return join(dataDir, 'attachment-uploads-v1', workspaceId)
}

async function download(origin, identity, hash) {
  return await fetch(`${origin}${ATTACHMENTS}/${hash}?workspaceId=${identity.workspaceId}`, {
    headers: { cookie: identity.cookie },
  })
}

test('chunked upload commits a verified object and removes staging', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-chunked-upload-'))
  const { app, origin } = await openServer(dataDir)
  t.after(async () => {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const owner = await newIdentity(origin)
  const content = Buffer.alloc(3 * MiB, 0x61)
  for (let offset = 0; offset < content.byteLength; offset += 1024) content[offset] = 0x0a
  const hash = digest(content)

  const begun = await beginUpload(origin, owner, hash, content.byteLength, 'large.bin')
  assert.equal(begun.status, 200)
  const beginBody = await begun.json()
  assert.equal(typeof beginBody.uploadId, 'string')
  assert.equal(beginBody.chunkBytes, 16 * MiB)
  assert.deepEqual(await listFiles(stagingRoot(dataDir, owner.workspaceId)).then(files => files.sort()),
    [`${beginBody.uploadId}.json`, `${beginBody.uploadId}.part`].sort())

  for (let offset = 0; offset < content.byteLength; offset += MiB) {
    const response = await putChunk(origin, owner, hash, beginBody.uploadId, offset, content.subarray(offset, offset + MiB))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      protocolVersion: 1, uploadId: beginBody.uploadId, offset, received: offset + MiB, bytes: content.byteLength,
    })
  }

  const committed = await commitUpload(origin, owner, hash, beginBody.uploadId)
  assert.equal(committed.status, 200)
  assert.deepEqual(await committed.json(), {
    protocolVersion: 1, attachmentId: `sha256:${hash}`, name: 'large.bin', bytes: content.byteLength, reused: false,
  })
  assert.deepEqual(await listFiles(stagingRoot(dataDir, owner.workspaceId)), [], 'commit must remove staging')
  assert.deepEqual(await listFiles(join(dataDir, 'attachments-v1', owner.workspaceId)), [hash])

  const stored = await download(origin, owner, hash)
  assert.equal(stored.status, 200)
  assert.deepEqual(Buffer.from(await stored.arrayBuffer()), content)
})

test('chunk offsets are enforced and an incomplete upload cannot commit', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-chunked-offsets-'))
  const { app, origin } = await openServer(dataDir, { attachmentMaxBytes: 2 * MiB })
  t.after(async () => {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const owner = await newIdentity(origin)
  const content = Buffer.from('chunked offset enforcement payload')
  const hash = digest(content)

  const begun = await beginUpload(origin, owner, hash, content.byteLength)
  assert.equal(begun.status, 200)
  const { uploadId } = await begun.json()
  const skipped = await putChunk(origin, owner, hash, uploadId, 8, content)
  assert.equal(skipped.status, 409)
  assert.equal((await skipped.json()).error.code, 'ATTACHMENT_UPLOAD_OFFSET_MISMATCH')

  const first = await putChunk(origin, owner, hash, uploadId, 0, content.subarray(0, 5))
  assert.equal(first.status, 200)
  const stillIncomplete = await commitUpload(origin, owner, hash, uploadId)
  assert.equal(stillIncomplete.status, 409)
  assert.equal((await stillIncomplete.json()).error.code, 'ATTACHMENT_UPLOAD_INCOMPLETE')

  const rest = await putChunk(origin, owner, hash, uploadId, 5, content.subarray(5))
  assert.equal(rest.status, 200)
  const committed = await commitUpload(origin, owner, hash, uploadId)
  assert.equal(committed.status, 200)
  assert.equal((await committed.json()).bytes, content.byteLength)

  const oversized = Buffer.alloc(2 * MiB + 1, 0x62)
  const rejectedBegin = await beginUpload(origin, owner, digest(oversized), oversized.byteLength)
  assert.equal(rejectedBegin.status, 413)
  assert.equal((await rejectedBegin.json()).error.code, 'ATTACHMENT_TOO_LARGE')
})

test('aborting and failing a chunked upload removes only its staging', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-chunked-abort-'))
  const { app, origin } = await openServer(dataDir)
  t.after(async () => {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const owner = await newIdentity(origin)

  const committedContent = Buffer.from('committed attachment that must survive an abort\n')
  const committedHash = digest(committedContent)
  const committed = await fetch(`${origin}${ATTACHMENTS}/${committedHash}?${uploadQuery(owner, 'keep.txt')}`, {
    method: 'PUT', headers: { cookie: owner.cookie, 'content-type': 'application/octet-stream' }, body: committedContent,
  })
  assert.equal(committed.status, 200)

  const aborted = await beginUpload(origin, owner, 'a'.repeat(64), 4 * MiB, 'aborted.bin')
  assert.equal(aborted.status, 200)
  const abortedId = (await aborted.json()).uploadId
  assert.equal((await putChunk(origin, owner, 'a'.repeat(64), abortedId, 0, Buffer.alloc(MiB, 0x61))).status, 200)
  const deleted = await abortUpload(origin, owner, 'a'.repeat(64), abortedId)
  assert.equal(deleted.status, 200)
  assert.deepEqual(await deleted.json(), { protocolVersion: 1, uploadId: abortedId, removed: 2 })
  assert.deepEqual(await listFiles(stagingRoot(dataDir, owner.workspaceId)), [])
  assert.deepEqual(await listFiles(join(dataDir, 'attachments-v1', owner.workspaceId)), [committedHash])
  assert.equal((await download(origin, owner, committedHash)).status, 200)

  const mismatched = await beginUpload(origin, owner, 'b'.repeat(64), 8, 'mismatch.bin')
  assert.equal(mismatched.status, 200)
  const mismatchedId = (await mismatched.json()).uploadId
  assert.equal((await putChunk(origin, owner, 'b'.repeat(64), mismatchedId, 0, Buffer.from('wrong!!!'))).status, 200)
  const rejected = await commitUpload(origin, owner, 'b'.repeat(64), mismatchedId)
  assert.equal(rejected.status, 400)
  assert.equal((await rejected.json()).error.code, 'ATTACHMENT_HASH_MISMATCH')
  assert.deepEqual(await listFiles(stagingRoot(dataDir, owner.workspaceId)), [],
    'a digest mismatch must discard unrecoverable staging')

  const missing = await abortUpload(origin, owner, 'b'.repeat(64), mismatchedId)
  assert.equal(missing.status, 200)
  assert.equal((await missing.json()).removed, 0)

  const crossHash = await beginUpload(origin, owner, 'c'.repeat(64), 8, 'cross.bin')
  const crossId = (await crossHash.json()).uploadId
  assert.equal((await putChunk(origin, owner, 'd'.repeat(64), crossId, 0, Buffer.from('abcdefgh'))).status, 409,
    'chunks must arrive under the hash recorded at begin')
})

test('startup sweep removes expired staging and never deletes committed objects', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-chunked-sweep-'))
  let server = await openServer(dataDir)
  t.after(async () => {
    await server.app.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const owner = await newIdentity(server.origin)
  const content = Buffer.from('content addressed object retained by the sweep\n')
  const hash = digest(content)
  const stored = await fetch(`${server.origin}${ATTACHMENTS}/${hash}?${uploadQuery(owner, 'sweep.txt')}`, {
    method: 'PUT', headers: { cookie: owner.cookie, 'content-type': 'application/octet-stream' }, body: content,
  })
  assert.equal(stored.status, 200)

  const directory = stagingRoot(dataDir, owner.workspaceId)
  await mkdir(directory, { recursive: true })
  const uploadId = randomUUID()
  await writeFile(join(directory, `${uploadId}.part`), Buffer.alloc(1024, 0x61))
  await writeFile(join(directory, `${uploadId}.json`), JSON.stringify({
    version: 1, uploadId, workspaceId: owner.workspaceId, hash: 'e'.repeat(64), name: 'stale.bin', bytes: 1024, createdAt: 0,
  }))
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await utimes(join(directory, `${uploadId}.part`), past, past)
  await utimes(join(directory, `${uploadId}.json`), past, past)

  await server.app.close()
  server = await openServer(dataDir)
  assert.deepEqual(await listFiles(directory), [], 'startup must reclaim staging older than the upload TTL')
  assert.deepEqual(await listFiles(join(dataDir, 'attachments-v1', owner.workspaceId)), [hash],
    'the sweep must not delete committed attachments')
  assert.equal((await download(server.origin, owner, hash)).status, 200)

  const sweep = await server.app.sweepAttachments()
  assert.deepEqual(sweep.uploads.deleted, [])
  assert.ok(Array.isArray(sweep.uploads.failures))
})
