import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { WORKSPACE_BLOB_CHUNK_BYTES } from '../workspace-v2.mjs'

const liveApps = new Set()
const temporaryDirectories = new Set()

async function temporaryDirectory(prefix = 'browser-native-v2-test-') {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.add(directory)
  return directory
}

async function start(options) {
  const app = await createBrowserNativeV2Server({ port: 0, ...options })
  const origin = await app.listen()
  liveApps.add(app)
  return { app, origin }
}

function envelope(requestId, extra = {}) {
  return { protocolVersion: 1, requestId, ...extra }
}

async function post(origin, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const value = await response.json()
  if (!response.ok) {
    const error = new Error(value.error?.message ?? `HTTP ${response.status}`)
    error.code = value.error?.code
    error.status = response.status
    error.retryAfterMs = value.error?.retryAfterMs
    throw error
  }
  return value
}

async function failure(origin, path, body) {
  try {
    await post(origin, path, body)
  } catch (error) {
    return error
  }
  assert.fail(`expected ${path} to fail`)
}

function header(id) {
  return { id, version: 1, createdAt: 1_700_000_000_000, cwd: '/workspace' }
}

async function readNdjson(response) {
  const body = await response.text()
  assert.equal(response.ok, true, body)
  return body
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  return `http://127.0.0.1:${address.port}`
}

async function close(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function openWorkspaceIdentity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  const setCookie = response.headers.get('set-cookie')
  assert.equal(typeof setCookie, 'string')
  assert.match(setCookie, /Max-Age=31536000/)
  return { workspaceId: body.workspaceId, cookie: setCookie.split(';', 1)[0] }
}

async function postWorkspace(origin, identity, operation, body) {
  const response = await fetch(`${origin}/api/browser-native/workspace/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: identity.cookie },
    body: JSON.stringify(envelope(`workspace-${randomUUID()}`, { workspaceId: identity.workspaceId, ...body })),
  })
  const value = await response.json()
  return { response, value }
}

async function postAuthenticatedWorkspace(origin, identity, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: identity.cookie },
    body: JSON.stringify(body),
  })
  const value = await response.json()
  if (!response.ok) {
    const error = new Error(value.error?.message ?? `HTTP ${response.status}`)
    error.code = value.error?.code
    error.status = response.status
    throw error
  }
  return value
}

async function uploadWorkspaceBlob(origin, identity, bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex')
  const response = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}`, {
    method: 'PUT',
    headers: {
      cookie: identity.cookie,
      'content-type': 'application/octet-stream',
      'x-browser-native-protocol': '1',
      'x-request-id': randomUUID(),
      'x-workspace-id': identity.workspaceId,
    },
    body: bytes,
  })
  const value = await response.json()
  assert.equal(response.ok, true, JSON.stringify(value))
  return { hash, bytes: bytes.byteLength, reused: value.reused }
}

async function uploadWorkspaceChunk(origin, identity, operationId, hash, index, bytes, chunkHash = createHash('sha256').update(bytes).digest('hex')) {
  const response = await fetch(`${origin}/api/browser-native/workspace/blob-upload/${operationId}-${hash}/${String(index)}`, {
    method: 'PUT',
    headers: {
      cookie: identity.cookie,
      'content-type': 'application/octet-stream',
      'x-browser-native-protocol': '1',
      'x-request-id': randomUUID(),
      'x-workspace-id': identity.workspaceId,
      'x-chunk-sha256': chunkHash,
    },
    body: bytes,
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

describe('browser-native DSH v2 backend', () => {
  it('returns the allocated port when listening on port zero', async () => {
    const dataDir = await temporaryDirectory()
    const { origin, app } = await start({ dataDir, port: 0, llmMode: 'scripted' })
    assert.equal(Number(new URL(origin).port), app.server.address().port)
    assert.notEqual(new URL(origin).port, '0')
    const response = await fetch(`${origin}/api/browser-native/health`)
    assert.equal(response.ok, true)
  })

  it('creates, lists, reads, appends, and rejects a stale sequence', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const id = 'contract-session'
    const created = await post(origin, '/api/browser-native/session/create', envelope('create', {
      sessionId: id,
      header: header(id),
      inheritedEventCount: 3,
    }))
    assert.equal(created.sessionId, id)
    assert.equal(created.inheritedEventCount, 3)
    assert.equal(created.nextSeq, 0)
    assert.equal(typeof created.owner.ownerToken, 'string')

    const listed = await post(origin, '/api/browser-native/session/list', envelope('list'))
    assert.deepEqual(listed.snapshots.map(snapshot => snapshot.header.id), [id])
    assert.equal(listed.snapshots[0].eventCount, 0)
    assert.deepEqual(listed.items, [{
      agentAvailable: false,
      sessionId: id,
      updatedAt: 1_700_000_000_000,
      running: false,
      blank: true,
      cwd: '/workspace',
    }])

    const event = { seq: 0, type: 'user/message', payload: { content: 'hello' }, at: '2026-10-03T00:00:00.000Z' }
    const appended = await post(origin, '/api/browser-native/session/append', envelope('append', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      expectedNextSeq: 0,
      events: [event],
    }))
    assert.equal(appended.acceptedCount, 1)
    assert.equal(appended.nextSeq, 1)

    const stale = await failure(origin, '/api/browser-native/session/append', envelope('append-stale', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      expectedNextSeq: 0,
      events: [event],
    }))
    assert.equal(stale.code, 'SEQ_CONFLICT')

    const read = await post(origin, '/api/browser-native/session/read', envelope('read', {
      sessionId: id,
      offset: 0,
      length: 10,
    }))
    assert.deepEqual(read.events, [event])
    assert.equal(read.eventState, 'shared-frozen')
  })

  it('persists workspace blobs and commits revisions idempotently with compare-and-swap', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const initialResponse = await fetch(`${origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    const initial = await initialResponse.json()
    assert.equal(initial.revision, 0)
    assert.deepEqual(initial.entries, [])

    const bytes = Buffer.from('cloud workspace ✓\n')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const uploaded = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}`, {
      method: 'PUT',
      headers: {
        cookie: identity.cookie,
        'content-type': 'application/octet-stream',
        'x-browser-native-protocol': '1',
        'x-request-id': 'blob-upload-one',
        'x-workspace-id': identity.workspaceId,
      },
      body: bytes,
    })
    const uploadedBody = await uploaded.json()
    assert.equal(uploaded.ok, true, JSON.stringify(uploadedBody))
    assert.equal(uploadedBody.reused, false)

    const operationId = randomUUID()
    const changes = [{ path: 'notes/daily.txt', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }]
    const committed = await postWorkspace(origin, identity, 'commit', {
      operationId,
      baseRevision: 0,
      changes,
    })
    assert.equal(committed.response.ok, true, JSON.stringify(committed.value))
    assert.equal(committed.value.revision, 1)
    assert.equal(committed.value.replayed, false)

    const replay = await postWorkspace(origin, identity, 'commit', {
      operationId,
      baseRevision: 0,
      changes,
    })
    assert.equal(replay.response.ok, true)
    assert.equal(replay.value.replayed, true)
    assert.equal(replay.value.revision, 1)

    const conflicting = await postWorkspace(origin, identity, 'commit', {
      operationId: randomUUID(),
      baseRevision: 0,
      changes,
    })
    assert.equal(conflicting.response.status, 409)
    assert.equal(conflicting.value.error.code, 'WORKSPACE_CONFLICT')
    assert.equal(conflicting.value.error.details.current.revision, 1)

    const manifestResponse = await fetch(`${origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    const manifest = await manifestResponse.json()
    assert.deepEqual(manifest.entries, [{ path: 'notes', kind: 'directory', mode: 0o755 }, { path: 'notes/daily.txt', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }])
    const downloaded = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes)
  })

  it('resumes chunk uploads after backend restart and fences conflicting or incomplete chunks', async () => {
    const dataDir = await temporaryDirectory()
    const first = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(first.origin)
    const bytes = Buffer.alloc(WORKSPACE_BLOB_CHUNK_BYTES * 2 + 37)
    for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = (index * 31 + 7) % 251
    const hash = createHash('sha256').update(bytes).digest('hex')
    const operationId = randomUUID()
    const uploadPath = `/api/browser-native/workspace/blob-upload/${operationId}-${hash}`
    const started = await postAuthenticatedWorkspace(first.origin, identity, '/api/browser-native/workspace/blob-upload/start', envelope('chunk-start', {
      workspaceId: identity.workspaceId,
      operationId,
      hash,
      totalBytes: bytes.byteLength,
      chunkBytes: WORKSPACE_BLOB_CHUNK_BYTES,
    }))
    assert.equal(started.complete, false)
    assert.equal(started.chunkCount, 3)
    assert.deepEqual(started.missing, [0, 1, 2])

    const firstChunk = bytes.subarray(0, WORKSPACE_BLOB_CHUNK_BYTES)
    const firstWrite = await uploadWorkspaceChunk(first.origin, identity, operationId, hash, 0, firstChunk)
    assert.equal(firstWrite.response.status, 200)
    assert.equal(firstWrite.value.replayed, false)
    const duplicate = await uploadWorkspaceChunk(first.origin, identity, operationId, hash, 0, firstChunk)
    assert.equal(duplicate.response.status, 200)
    assert.equal(duplicate.value.replayed, true)

    const conflictingBytes = Buffer.from(firstChunk)
    conflictingBytes[0] ^= 0xff
    const conflicting = await uploadWorkspaceChunk(first.origin, identity, operationId, hash, 0, conflictingBytes)
    assert.equal(conflicting.response.status, 409)
    assert.equal(conflicting.value.error.code, 'UPLOAD_CHUNK_CONFLICT')
    const invalidHash = await uploadWorkspaceChunk(first.origin, identity, operationId, hash, 1,
      bytes.subarray(WORKSPACE_BLOB_CHUNK_BYTES, WORKSPACE_BLOB_CHUNK_BYTES * 2), '0'.repeat(64))
    assert.equal(invalidHash.response.status, 400)

    const incomplete = await postAuthenticatedWorkspace(first.origin, identity, `${uploadPath}/complete`, envelope('chunk-incomplete', {
      workspaceId: identity.workspaceId,
    })).catch(error => error)
    assert.equal(incomplete.code, 'UPLOAD_INCOMPLETE')
    await first.app.close()
    liveApps.delete(first.app)

    const second = await start({ dataDir, llmMode: 'scripted' })
    const resumed = await fetch(`${second.origin}${uploadPath}?protocolVersion=1&workspaceId=${encodeURIComponent(identity.workspaceId)}`, {
      headers: { cookie: identity.cookie },
    })
    const resumeState = await resumed.json()
    assert.equal(resumed.status, 200)
    assert.deepEqual(resumeState.missing, [1, 2])
    const secondChunk = bytes.subarray(WORKSPACE_BLOB_CHUNK_BYTES, WORKSPACE_BLOB_CHUNK_BYTES * 2)
    const finalChunk = bytes.subarray(WORKSPACE_BLOB_CHUNK_BYTES * 2)
    assert.equal((await uploadWorkspaceChunk(second.origin, identity, operationId, hash, 1, secondChunk)).response.status, 200)
    assert.equal((await uploadWorkspaceChunk(second.origin, identity, operationId, hash, 2, finalChunk)).response.status, 200)
    const completed = await postAuthenticatedWorkspace(second.origin, identity, `${uploadPath}/complete`, envelope('chunk-complete', {
      workspaceId: identity.workspaceId,
    }))
    assert.equal(completed.complete, true)
    const replayedComplete = await postAuthenticatedWorkspace(second.origin, identity, `${uploadPath}/complete`, envelope('chunk-complete-replay', {
      workspaceId: identity.workspaceId,
    }))
    assert.equal(replayedComplete.replayed, true)

    const committed = await postWorkspace(second.origin, identity, 'commit', {
      operationId,
      baseRevision: 0,
      changes: [{ path: 'large.bin', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }],
    })
    assert.equal(committed.response.status, 200)
    assert.equal(committed.value.revision, 1)
    const chunkResponse = await fetch(`${second.origin}/api/browser-native/workspace/blob/${hash}/chunk/2?protocolVersion=1&workspaceId=${encodeURIComponent(identity.workspaceId)}`, {
      headers: { cookie: identity.cookie },
    })
    const downloadedChunk = new Uint8Array(await chunkResponse.arrayBuffer())
    assert.equal(chunkResponse.status, 200)
    assert.equal(chunkResponse.headers.get('x-chunk-count'), '3')
    assert.deepEqual(downloadedChunk, new Uint8Array(finalChunk))
    assert.equal(chunkResponse.headers.get('x-content-sha256'), createHash('sha256').update(finalChunk).digest('hex'))
  })

  it('reports a corrupted staged chunk as missing and accepts its verified replacement', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const bytes = Buffer.alloc(WORKSPACE_BLOB_CHUNK_BYTES + 19, 0x5a)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const operationId = randomUUID()
    const uploadPath = `/api/browser-native/workspace/blob-upload/${operationId}-${hash}`
    const started = await postAuthenticatedWorkspace(origin, identity, '/api/browser-native/workspace/blob-upload/start', envelope('corrupt-start', {
      workspaceId: identity.workspaceId,
      operationId,
      hash,
      totalBytes: bytes.byteLength,
      chunkBytes: WORKSPACE_BLOB_CHUNK_BYTES,
    }))
    assert.equal(started.complete, false)
    const firstChunk = bytes.subarray(0, WORKSPACE_BLOB_CHUNK_BYTES)
    assert.equal((await uploadWorkspaceChunk(origin, identity, operationId, hash, 0, firstChunk)).response.status, 200)
    const stagingDirectory = join(dataDir, 'workspace-v2', 'uploads', identity.workspaceId, `${operationId}-${hash}`)
    await writeFile(join(stagingDirectory, '0.part'), Buffer.from('corrupt'))

    const statusResponse = await fetch(`${origin}${uploadPath}?protocolVersion=1&workspaceId=${encodeURIComponent(identity.workspaceId)}`, {
      headers: { cookie: identity.cookie },
    })
    const status = await statusResponse.json()
    assert.equal(statusResponse.status, 200)
    assert.deepEqual(status.missing, [0, 1])

    const restoredFirst = await uploadWorkspaceChunk(origin, identity, operationId, hash, 0, firstChunk)
    assert.equal(restoredFirst.response.status, 200)
    assert.equal(restoredFirst.value.replayed, false)
    const lastChunk = bytes.subarray(WORKSPACE_BLOB_CHUNK_BYTES)
    assert.equal((await uploadWorkspaceChunk(origin, identity, operationId, hash, 1, lastChunk)).response.status, 200)
    const completed = await postAuthenticatedWorkspace(origin, identity, `${uploadPath}/complete`, envelope('corrupt-complete', {
      workspaceId: identity.workspaceId,
    }))
    assert.equal(completed.complete, true)

    const unreferenced = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}/chunk/0?protocolVersion=1&workspaceId=${encodeURIComponent(identity.workspaceId)}`, {
      headers: { cookie: identity.cookie },
    })
    assert.equal(unreferenced.status, 404)
  })

  it('isolates workspace identity and restores it after backend restart', async () => {
    const dataDir = await temporaryDirectory()
    const first = await start({ dataDir, llmMode: 'scripted' })
    const owner = await openWorkspaceIdentity(first.origin)
    const other = await openWorkspaceIdentity(first.origin)
    assert.notEqual(owner.workspaceId, other.workspaceId)

    const denied = await fetch(`${first.origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${owner.workspaceId}`, {
      headers: { cookie: other.cookie },
    })
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).error.code, 'WORKSPACE_FORBIDDEN')

    const bytes = Buffer.from('survives backend restart')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const upload = await fetch(`${first.origin}/api/browser-native/workspace/blob/${hash}`, {
      method: 'PUT',
      headers: {
        cookie: owner.cookie,
        'content-type': 'application/octet-stream',
        'x-browser-native-protocol': '1',
        'x-request-id': 'restart-upload',
        'x-workspace-id': owner.workspaceId,
      },
      body: bytes,
    })
    assert.equal(upload.ok, true)
    const committed = await postWorkspace(first.origin, owner, 'commit', {
      operationId: randomUUID(),
      baseRevision: 0,
      changes: [{ path: 'persisted.txt', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }],
    })
    assert.equal(committed.response.ok, true, JSON.stringify(committed.value))

    const foreignRead = await fetch(`${first.origin}/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${owner.workspaceId}`, {
      headers: { cookie: other.cookie },
    })
    assert.equal(foreignRead.status, 403)
    assert.equal((await foreignRead.json()).error.code, 'WORKSPACE_FORBIDDEN')

    const foreignBytes = Buffer.from('must remain private')
    const foreignHash = createHash('sha256').update(foreignBytes).digest('hex')
    const foreignUpload = await fetch(`${first.origin}/api/browser-native/workspace/blob/${foreignHash}`, {
      method: 'PUT',
      headers: {
        cookie: other.cookie,
        'content-type': 'application/octet-stream',
        'x-browser-native-protocol': '1',
        'x-request-id': 'foreign-workspace-upload',
        'x-workspace-id': owner.workspaceId,
      },
      body: foreignBytes,
    })
    assert.equal(foreignUpload.status, 403)
    assert.equal((await foreignUpload.json()).error.code, 'WORKSPACE_FORBIDDEN')

    const foreignCommit = await postWorkspace(first.origin, other, 'commit', {
      workspaceId: owner.workspaceId,
      operationId: randomUUID(),
      baseRevision: 1,
      changes: [{ path: 'intrusion.txt', deleted: true }],
    })
    assert.equal(foreignCommit.response.status, 403)
    assert.equal(foreignCommit.value.error.code, 'WORKSPACE_FORBIDDEN')

    await first.app.close()
    liveApps.delete(first.app)
    const restarted = await start({ dataDir, llmMode: 'scripted' })
    const restored = await fetch(`${restarted.origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${owner.workspaceId}`, {
      headers: { cookie: owner.cookie },
    })
    const restoredBody = await restored.json()
    assert.equal(restored.ok, true, JSON.stringify(restoredBody))
    assert.equal(restoredBody.revision, 1)
    assert.deepEqual(restoredBody.entries, [{ path: 'persisted.txt', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }])
  })

  it('serializes concurrent commits against one workspace revision', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const contenders = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const bytes = Buffer.from(`concurrent-${String(index)}`)
      const hash = createHash('sha256').update(bytes).digest('hex')
      const uploaded = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}`, {
        method: 'PUT',
        headers: {
          cookie: identity.cookie,
          'content-type': 'application/octet-stream',
          'x-browser-native-protocol': '1',
          'x-request-id': `concurrent-upload-${String(index)}`,
          'x-workspace-id': identity.workspaceId,
        },
        body: bytes,
      })
      assert.equal(uploaded.ok, true)
      return {
        operationId: randomUUID(),
        baseRevision: 0,
        changes: [{ path: `contender-${String(index)}.txt`, kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }],
      }
    }))

    const results = await Promise.all(contenders.map(body => postWorkspace(origin, identity, 'commit', body)))
    const committed = results.filter(result => result.response.ok)
    const conflicts = results.filter(result => result.response.status === 409
      && result.value.error.code === 'WORKSPACE_CONFLICT')
    assert.equal(committed.length, 1)
    assert.equal(conflicts.length, contenders.length - 1)

    const manifestResponse = await fetch(`${origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    const manifest = await manifestResponse.json()
    assert.equal(manifest.revision, 1)
    assert.equal(manifest.entries.filter(entry => entry.kind === 'file').length, 1)
  })

  it('requires Workspace upload authorization before referencing another user blob', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const owner = await openWorkspaceIdentity(origin)
    const other = await openWorkspaceIdentity(origin)
    const bytes = Buffer.from('owner-only-content')
    const uploaded = await uploadWorkspaceBlob(origin, owner, bytes)
    const changes = [{ path: 'private.txt', kind: 'file', hash: uploaded.hash, bytes: uploaded.bytes, mode: 0o600 }]
    const denied = await postWorkspace(origin, other, 'commit', {
      operationId: randomUUID(), baseRevision: 0, changes,
    })
    assert.equal(denied.response.status, 403)
    assert.equal(denied.value.error.code, 'BLOB_FORBIDDEN')

    const uploadedByOther = await uploadWorkspaceBlob(origin, other, bytes)
    assert.equal(uploadedByOther.reused, true)
    const allowed = await postWorkspace(origin, other, 'commit', {
      operationId: randomUUID(), baseRevision: 0, changes,
    })
    assert.equal(allowed.response.ok, true, JSON.stringify(allowed.value))
    assert.equal(allowed.value.revision, 1)
  })

  it('persists empty, binary, Unicode, renamed, removed, and chmod entries', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const binary = Buffer.from([0, 255, 128, 1])
    const emptyBlob = await uploadWorkspaceBlob(origin, identity, Buffer.alloc(0))
    const binaryBlob = await uploadWorkspaceBlob(origin, identity, binary)
    const textBlob = await uploadWorkspaceBlob(origin, identity, Buffer.from('alpha\nbeta\n'))
    const initial = await postWorkspace(origin, identity, 'commit', {
      operationId: randomUUID(), baseRevision: 0,
      changes: [
        { path: '目录', kind: 'directory', mode: 0o750 },
        { path: '目录/空文件', kind: 'file', hash: emptyBlob.hash, bytes: 0, mode: 0o600 },
        { path: 'binary.dat', kind: 'file', hash: binaryBlob.hash, bytes: binaryBlob.bytes, mode: 0o600 },
        { path: 'old.txt', kind: 'file', hash: textBlob.hash, bytes: textBlob.bytes, mode: 0o644 },
      ],
    })
    assert.equal(initial.response.ok, true, JSON.stringify(initial.value))
    const changed = await postWorkspace(origin, identity, 'commit', {
      operationId: randomUUID(), baseRevision: 1,
      changes: [
        { path: 'old.txt', deleted: true },
        { path: '目录/已重命名.txt', kind: 'file', hash: textBlob.hash, bytes: textBlob.bytes, mode: 0o600 },
        { path: 'binary.dat', kind: 'file', hash: binaryBlob.hash, bytes: binaryBlob.bytes, mode: 0o640 },
      ],
    })
    assert.equal(changed.response.ok, true, JSON.stringify(changed.value))
    const manifestResponse = await fetch(`${origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    const manifest = await manifestResponse.json()
    assert.equal(manifest.revision, 2)
    assert.equal(manifest.entries.some(entry => entry.path === 'old.txt'), false)
    assert.equal(manifest.entries.find(entry => entry.path === 'binary.dat').mode, 0o640)
    assert.equal(manifest.entries.find(entry => entry.path === '目录/空文件').bytes, 0)
    for (const [hash, expected] of [[binaryBlob.hash, binary], [emptyBlob.hash, Buffer.alloc(0)]]) {
      const downloaded = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
        headers: { cookie: identity.cookie },
      })
      assert.equal(downloaded.ok, true)
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), expected)
    }
    const removed = await postWorkspace(origin, identity, 'commit', {
      operationId: randomUUID(), baseRevision: 2, changes: [{ path: '目录', deleted: true }],
    })
    assert.equal(removed.response.ok, true, JSON.stringify(removed.value))
    const durable = JSON.parse(await readFile(join(dataDir, 'workspace-v2', 'workspaces', `${identity.workspaceId}.json`), 'utf8'))
    assert.equal(durable.revision, 3)
    assert.deepEqual(durable.entries.map(entry => entry.path), ['binary.dat'])
  })

  it('rejects invalid workspace paths, unverified blobs, and mismatched idempotency replays', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const badUpload = await fetch(`${origin}/api/browser-native/workspace/blob/${'0'.repeat(64)}`, {
      method: 'PUT',
      headers: {
        cookie: identity.cookie,
        'content-type': 'application/octet-stream',
        'x-browser-native-protocol': '1',
        'x-request-id': 'bad-hash',
        'x-workspace-id': identity.workspaceId,
      },
      body: Buffer.from('not the requested hash'),
    })
    assert.equal(badUpload.status, 400)
    assert.equal((await badUpload.json()).error.code, 'BLOB_HASH_MISMATCH')

    const invalidPath = await postWorkspace(origin, identity, 'commit', {
      operationId: randomUUID(),
      baseRevision: 0,
      changes: [{ path: '../outside', kind: 'file', hash: '0'.repeat(64), bytes: 1, mode: 0o600 }],
    })
    assert.equal(invalidPath.response.status, 400)
    assert.equal(invalidPath.value.error.code, 'INVALID_PATH')

    const bytes = Buffer.from('one')
    const hash = createHash('sha256').update(bytes).digest('hex')
    await fetch(`${origin}/api/browser-native/workspace/blob/${hash}`, {
      method: 'PUT',
      headers: {
        cookie: identity.cookie,
        'content-type': 'application/octet-stream',
        'x-browser-native-protocol': '1',
        'x-request-id': 'valid-hash',
        'x-workspace-id': identity.workspaceId,
      },
      body: bytes,
    })
    const operationId = randomUUID()
    const first = await postWorkspace(origin, identity, 'commit', {
      operationId,
      baseRevision: 0,
      changes: [{ path: 'one.txt', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }],
    })
    assert.equal(first.response.ok, true)
    const replay = await postWorkspace(origin, identity, 'commit', {
      operationId,
      baseRevision: 0,
      changes: [{ path: 'different.txt', kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }],
    })
    assert.equal(replay.response.status, 409)
    assert.equal(replay.value.error.code, 'OPERATION_ID_REUSED')
  })

  it('fences write ownership and releases it on close', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const id = 'owner-session'
    const created = await post(origin, '/api/browser-native/session/create', envelope('owner-create', {
      sessionId: id,
      header: header(id),
    }))

    const resumed = await post(origin, '/api/browser-native/session/open', envelope('owner-resume', {
      sessionId: id,
      access: 'write',
      ownerToken: created.owner.ownerToken,
    }))
    assert.equal(resumed.owner.ownerToken, created.owner.ownerToken)

    const alreadyOwned = await failure(origin, '/api/browser-native/session/open', envelope('owner-open-conflict', {
      sessionId: id,
      access: 'write',
    }))
    assert.equal(alreadyOwned.code, 'SESSION_ALREADY_OWNED')

    const wrongOwner = await failure(origin, '/api/browser-native/session/append', envelope('wrong-owner', {
      sessionId: id,
      ownerToken: 'wrong-owner-token',
      expectedNextSeq: 0,
      events: [],
    }))
    assert.equal(wrongOwner.code, 'SESSION_OWNERSHIP_LOST')

    const closed = await post(origin, '/api/browser-native/session/close', envelope('owner-close', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
    }))
    assert.equal(closed.closed, true)

    const reopened = await post(origin, '/api/browser-native/session/open', envelope('owner-reopen', {
      sessionId: id,
      access: 'write',
    }))
    assert.equal(typeof reopened.owner.ownerToken, 'string')
    assert.notEqual(reopened.owner.ownerToken, created.owner.ownerToken)
  })

  it('reclaims an abandoned write owner after its lease expires', async () => {
    const dataDir = await temporaryDirectory()
    let now = 1_000
    const { origin } = await start({
      dataDir,
      llmMode: 'scripted',
      ownerLeaseMs: 300,
      testHooks: { now: () => now },
    })
    const id = 'expired-owner-session'
    const created = await post(origin, '/api/browser-native/session/create', envelope('expired-create', {
      sessionId: id,
      header: header(id),
    }))
    const beforeExpiry = await failure(origin, '/api/browser-native/session/open', envelope('expired-open-before', {
      sessionId: id,
      access: 'write',
    }))
    assert.equal(beforeExpiry.code, 'SESSION_ALREADY_OWNED')
    assert.equal(beforeExpiry.retryAfterMs, 300)

    now += 301
    const reclaimed = await post(origin, '/api/browser-native/session/open', envelope('expired-open-after', {
      sessionId: id,
      access: 'write',
    }))
    assert.notEqual(reclaimed.owner.ownerToken, created.owner.ownerToken)
    assert.equal(reclaimed.owner.leaseDurationMs, 300)
    assert.equal(reclaimed.owner.renewAfterMs, 100)

    const staleAppend = await failure(origin, '/api/browser-native/session/append', envelope('expired-stale-append', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
      expectedNextSeq: 0,
      events: [],
    }))
    assert.equal(staleAppend.code, 'SESSION_OWNERSHIP_LOST')
    const staleClose = await failure(origin, '/api/browser-native/session/close', envelope('expired-stale-close', {
      sessionId: id,
      ownerToken: created.owner.ownerToken,
    }))
    assert.equal(staleClose.status, 409)
    assert.equal(staleClose.code, 'SESSION_OWNERSHIP_LOST')
    await post(origin, '/api/browser-native/session/append', envelope('reclaimed-append-after-stale-close', {
      sessionId: id,
      ownerToken: reclaimed.owner.ownerToken,
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'user/message', payload: { content: 'new owner remains writable' } }],
    }))
    await post(origin, '/api/browser-native/session/flush', envelope('reclaimed-flush-after-stale-close', {
      sessionId: id,
      ownerToken: reclaimed.owner.ownerToken,
    }))
    const durable = JSON.parse(await readFile(join(dataDir, 'sessions', `${id}.json`), 'utf8'))
    assert.equal(durable.events[0].payload.content, 'new owner remains writable')
    assert.equal(durable.durableThroughSeq, 0)
    const renewed = await post(origin, '/api/browser-native/session/renew', envelope('expired-renew', {
      sessionId: id,
      ownerToken: reclaimed.owner.ownerToken,
    }))
    assert.equal(renewed.owner.ownerToken, reclaimed.owner.ownerToken)

    now += 301
    const expiredClose = await post(origin, '/api/browser-native/session/close', envelope('expired-close', {
      sessionId: id,
      ownerToken: reclaimed.owner.ownerToken,
    }))
    assert.equal(expiredClose.closed, true)
    const afterExpiredClose = await post(origin, '/api/browser-native/session/open', envelope('expired-reopen', {
      sessionId: id,
      access: 'write',
    }))
    assert.notEqual(afterExpiredClose.owner.ownerToken, reclaimed.owner.ownerToken)
  })

  it('flushes on close and recovers only durable events after an abrupt restart', async () => {
    const dataDir = await temporaryDirectory()
    const first = await start({ dataDir, llmMode: 'scripted' })
    const durableId = 'durable-session'
    const durable = await post(first.origin, '/api/browser-native/session/create', envelope('durable-create', {
      sessionId: durableId,
      header: header(durableId),
    }))
    await post(first.origin, '/api/browser-native/session/append', envelope('durable-append', {
      sessionId: durableId,
      ownerToken: durable.owner.ownerToken,
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'user/message', payload: { content: 'persist me' } }],
    }))
    const closed = await post(first.origin, '/api/browser-native/session/close', envelope('durable-close', {
      sessionId: durableId,
      ownerToken: durable.owner.ownerToken,
    }))
    assert.match(closed.durabilityReceipt, /^durable-durable-session-0$/)

    const transientId = 'transient-session'
    const transient = await post(first.origin, '/api/browser-native/session/create', envelope('transient-create', {
      sessionId: transientId,
      header: header(transientId),
    }))
    await post(first.origin, '/api/browser-native/session/append', envelope('transient-append', {
      sessionId: transientId,
      ownerToken: transient.owner.ownerToken,
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'user/message', payload: { content: 'do not persist yet' } }],
    }))
    await first.app.close()
    liveApps.delete(first.app)

    const second = await start({ dataDir, llmMode: 'scripted' })
    const recovered = await post(second.origin, '/api/browser-native/session/read', envelope('durable-read', {
      sessionId: durableId,
      offset: 0,
    }))
    assert.equal(recovered.events.length, 1)
    assert.equal(recovered.events[0].payload.content, 'persist me')
    const record = JSON.parse(await readFile(join(dataDir, 'sessions', `${durableId}.json`), 'utf8'))
    assert.equal(record.durableThroughSeq, 0)

    const lost = await failure(second.origin, '/api/browser-native/session/read', envelope('transient-read', {
      sessionId: transientId,
      offset: 0,
    }))
    assert.equal(lost.code, 'SESSION_NOT_FOUND')
  })

  it('streams the scripted model and applies session owner fencing to LLM requests', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const id = 'llm-session'
    const created = await post(origin, '/api/browser-native/session/create', envelope('llm-create', {
      sessionId: id,
      header: header(id),
    }))
    const response = await fetch(`${origin}/api/browser-native/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope('llm-scripted', {
        sessionId: id,
        ownerToken: created.owner.ownerToken,
        provider: 'browser-native',
        model: 'browser-native',
        messages: [{ role: 'user', content: 'SCRIPTED_CONTRACT_PROMPT' }],
      })),
    })
    const items = await readNdjson(response)
    assert.equal(items.at(-1).chunk.type, 'finish')
    assert.match(items.map(item => item.chunk?.block?.text ?? item.chunk?.text ?? '').join(''), /SCRIPTED_CONTRACT_PROMPT/)

    const fenced = await failure(origin, '/api/browser-native/llm', envelope('llm-fenced', {
      sessionId: id,
      ownerToken: 'wrong-owner-token',
      messages: [{ role: 'user', content: 'must reject' }],
    }))
    assert.equal(fenced.code, 'SESSION_OWNERSHIP_LOST')
  })

  it('proxies an OpenAI-compatible stream without exposing the backend secret', async () => {
    const upstream = createServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer contract-secret')
      const requestChunks = []
      for await (const chunk of request) requestChunks.push(chunk)
      const requestBody = JSON.parse(Buffer.concat(requestChunks).toString('utf8'))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (JSON.stringify(requestBody.messages).includes('EMPTY_CONTRACT_PROMPT')) {
        response.end([
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'))
        return
      }
      if (JSON.stringify(requestBody.messages).includes('EMPTY_DONE_CONTRACT_PROMPT')) {
        response.end(['data: [DONE]', ''].join('\n'))
        return
      }
      if (JSON.stringify(requestBody.messages).includes('DONE_WITH_CONTENT_CONTRACT_PROMPT')) {
        response.end([
          'data: {"choices":[{"delta":{"content":"DONE_WITH_CONTENT_OK"}}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'))
        return
      }
      response.end([
        'data: {"choices":[{"delta":{"content":"REAL_CONTRACT_OK"}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'))
    })
    const upstreamOrigin = await listen(upstream)
    try {
      const envFile = await temporaryDirectory('browser-native-v2-env-').then(async directory => {
        const file = join(directory, '.env')
        await writeFile(file, [
          `OPENAI_NEXT_GPT_BASE_URL=${upstreamOrigin}`,
          'OPENAI_NEXT_GPT_COMPLETIONS_PATH=/v1/chat/completions',
          'OPENAI_NEXT_GPT_MODEL=contract-model',
          `OPENAI_NEXT_GPT_${'API_KEY'}=contract-secret`,
          'HTTPS_PROXY=',
          '',
        ].join('\n'))
        return file
      })
      const dataDir = await temporaryDirectory()
      const { origin } = await start({ dataDir, llmMode: 'real', envFile })
      const response = await fetch(`${origin}/api/browser-native/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope('llm-real', {
          messages: [{ role: 'user', content: 'real contract prompt' }],
        })),
      })
      const body = await response.text()
      assert.equal(response.ok, true, body)
      assert.match(body, /REAL_CONTRACT_OK/)
      assert.equal(body.includes('contract-secret'), false)

      const emptyResponse = await fetch(`${origin}/api/browser-native/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope('llm-empty', {
          messages: [{ role: 'user', content: 'EMPTY_CONTRACT_PROMPT' }],
        })),
      })
      const emptyItems = await readNdjson(emptyResponse)
      assert.equal(emptyResponse.ok, true)
      assert.equal(emptyItems.at(-1).kind, 'error')
      assert.equal(emptyItems.at(-1).error.code, 'UPSTREAM_LLM_EMPTY')

      const emptyDoneResponse = await fetch(`${origin}/api/browser-native/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope('llm-empty-done', {
          messages: [{ role: 'user', content: 'EMPTY_DONE_CONTRACT_PROMPT' }],
        })),
      })
      const emptyDoneItems = await readNdjson(emptyDoneResponse)
      assert.equal(emptyDoneItems.at(-1).kind, 'error')
      assert.equal(emptyDoneItems.at(-1).error.code, 'UPSTREAM_LLM_EMPTY')

      const doneWithContentResponse = await fetch(`${origin}/api/browser-native/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope('llm-done-with-content', {
          messages: [{ role: 'user', content: 'DONE_WITH_CONTENT_CONTRACT_PROMPT' }],
        })),
      })
      const doneWithContentItems = await readNdjson(doneWithContentResponse)
      assert.equal(doneWithContentItems.at(-1).kind, 'chunk')
      assert.equal(doneWithContentItems.at(-1).chunk.type, 'finish')
      assert.equal(doneWithContentItems.at(-1).chunk.reason.kind, 'stop')
      assert.match(doneWithContentItems.map(item => item.chunk?.block?.text ?? item.chunk?.text ?? '').join(''), /DONE_WITH_CONTENT_OK/)
    } finally {
      await close(upstream)
    }
  })

  it('rejects malformed requests and never returns a provider secret', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const invalid = await failure(origin, '/api/browser-native/session/list', { protocolVersion: 1 })
    assert.equal(invalid.code, 'INVALID_REQUEST')

    const missing = await failure(origin, '/api/browser-native/session/read', envelope('missing', {
      sessionId: 'missing-session',
      offset: 0,
    }))
    assert.equal(missing.code, 'SESSION_NOT_FOUND')

    const response = await fetch(`${origin}/api/browser-native/health`)
    const body = await response.text()
    assert.equal(response.ok, true)
    assert.equal(body.includes('apiKey'), false)
    assert.equal(body.includes('secret'), false)
  })

  it('rotates resumed Workspace leases and fences stale writers', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start({ dataDir, llmMode: 'scripted' })
    const identity = await openWorkspaceIdentity(origin)
    const firstLease = await postWorkspace(origin, identity, 'lease', { operation: 'claim' })
    assert.equal(firstLease.response.ok, true, JSON.stringify(firstLease.value))
    assert.equal(typeof firstLease.value.writerToken, 'string')
    assert.equal(firstLease.value.fencingToken, 1)

    const resumeId = randomUUID()
    const resumed = await postWorkspace(origin, identity, 'lease', {
      operation: 'resume',
      resumeId,
      writerToken: firstLease.value.writerToken,
      fencingToken: firstLease.value.fencingToken,
    })
    assert.equal(resumed.response.ok, true, JSON.stringify(resumed.value))
    assert.equal(resumed.value.fencingToken, 2)
    assert.notEqual(resumed.value.writerToken, firstLease.value.writerToken)

    const resumedReplay = await postWorkspace(origin, identity, 'lease', {
      operation: 'resume',
      resumeId,
      writerToken: firstLease.value.writerToken,
      fencingToken: firstLease.value.fencingToken,
    })
    assert.equal(resumedReplay.response.ok, true, JSON.stringify(resumedReplay.value))
    assert.deepEqual(resumedReplay.value, resumed.value)

    const staleRenew = await postWorkspace(origin, identity, 'lease', {
      operation: 'renew',
      writerToken: firstLease.value.writerToken,
      fencingToken: firstLease.value.fencingToken,
    })
    assert.equal(staleRenew.response.status, 409)
    assert.equal(staleRenew.value.error.code, 'WORKSPACE_OWNERSHIP_LOST')

    const secondClaim = await postWorkspace(origin, identity, 'lease', { operation: 'claim' })
    assert.equal(secondClaim.response.status, 409)
    assert.equal(secondClaim.value.error.code, 'WORKSPACE_ALREADY_OWNED')

    const released = await postWorkspace(origin, identity, 'lease', {
      operation: 'release',
      writerToken: resumed.value.writerToken,
      fencingToken: resumed.value.fencingToken,
    })
    assert.equal(released.response.ok, true, JSON.stringify(released.value))
    const staleResumeReplay = await postWorkspace(origin, identity, 'lease', {
      operation: 'resume',
      resumeId,
      writerToken: firstLease.value.writerToken,
      fencingToken: firstLease.value.fencingToken,
    })
    assert.equal(staleResumeReplay.response.status, 409)
    assert.equal(staleResumeReplay.value.error.code, 'WORKSPACE_OWNERSHIP_LOST')
    const secondLease = await postWorkspace(origin, identity, 'lease', { operation: 'claim' })
    assert.equal(secondLease.response.ok, true, JSON.stringify(secondLease.value))
    assert.equal(secondLease.value.fencingToken, 3)

    const bytes = Buffer.from('writer fenced')
    const uploaded = await uploadWorkspaceBlob(origin, identity, bytes)
    const operationId = randomUUID()
    const staleCommit = await postWorkspace(origin, identity, 'commit', {
      operationId,
      baseRevision: 0,
      writerToken: firstLease.value.writerToken,
      fencingToken: firstLease.value.fencingToken,
      changes: [{ path: 'fenced.txt', kind: 'file', hash: uploaded.hash, bytes: uploaded.bytes, mode: 0o600 }],
    })
    assert.equal(staleCommit.response.status, 409)
    assert.equal(staleCommit.value.error.code, 'WORKSPACE_OWNERSHIP_LOST')

    const committed = await postWorkspace(origin, identity, 'commit', {
      operationId,
      baseRevision: 0,
      writerToken: secondLease.value.writerToken,
      fencingToken: secondLease.value.fencingToken,
      changes: [{ path: 'fenced.txt', kind: 'file', hash: uploaded.hash, bytes: uploaded.bytes, mode: 0o600 }],
    })
    assert.equal(committed.response.ok, true, JSON.stringify(committed.value))
    const queried = await fetch(`${origin}/api/browser-native/workspace/operation/${operationId}?protocolVersion=1&workspaceId=${identity.workspaceId}`, {
      headers: { cookie: identity.cookie },
    })
    const queryBody = await queried.json()
    assert.equal(queried.ok, true, JSON.stringify(queryBody))
    assert.equal(queryBody.found, true)
    assert.equal(queryBody.receipt.operationId, operationId)
    assert.equal(queryBody.receipt.revision, 1)
  })
})
