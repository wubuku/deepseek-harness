import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { WORKSPACE_BLOB_CHUNK_BYTES } from '../workspace-v2.mjs'

const ROOT = '/api/browser-native/workspace'
const DAY_MS = 86_400_000
const PARAMETERS = { version: 1, algorithm: 'dsh-gear-v1', minimumBytes: 32768,
  averageBytes: 131072, maximumBytes: 1048576 }

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function upload(parts, { fixed = false, ...extra } = {}) {
  const bytes = Buffer.concat(parts)
  let offset = 0
  const chunks = parts.map(part => {
    const chunk = { offset, length: part.byteLength, hash: sha256(part) }
    offset += part.byteLength
    return chunk
  })
  return { bytes, hash: sha256(bytes), operationId: randomUUID(),
    ...(fixed ? {} : { layout: { ...PARAMETERS, chunks } }), ...extra }
}

function sourceParts() {
  return [Buffer.alloc(32768, 0x41), Buffer.alloc(49152, 0x42), Buffer.from('short tail')]
}

async function fixture(context, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'chunk-object-workspace-'))
  const environment = { dataDir, app: undefined, origin: undefined, requests: [] }
  environment.stop = async () => {
    const app = environment.app
    environment.app = undefined
    if (app !== undefined) await app.close()
  }
  context.after(async () => {
    try { await environment.stop() } finally { await rm(dataDir, { recursive: true, force: true }) }
  })
  environment.restart = async (overrides = {}) => {
    await environment.stop()
    environment.app = await createBrowserNativeV2Server({ dataDir, port: 0, llmMode: 'scripted',
      workspaceChunkObjects: true, ...options, ...overrides })
    environment.app.server.on('request', request => environment.requests.push(request.url))
    environment.origin = await environment.app.listen()
  }
  await environment.restart()
  return environment
}

async function request(environment, owner, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${environment.origin}${path}`, {
    method,
    headers: { ...(owner === undefined ? {} : { cookie: owner.cookie }), ...headers,
      ...(body === undefined || Buffer.isBuffer(body) ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
  })
  const raw = Buffer.from(await response.arrayBuffer())
  const value = response.headers.get('content-type')?.includes('application/json')
    ? JSON.parse(raw.toString('utf8')) : raw
  return { status: response.status, headers: response.headers, value }
}

async function ok(result) {
  result = await result
  assert.equal(result.status, 200, JSON.stringify(result.value))
  return result.value
}

async function rejected(result, code, status) {
  result = await result
  assert.equal(result.value.error?.code, code, JSON.stringify(result.value))
  if (status !== undefined) assert.equal(result.status, status)
}

async function identity(environment) {
  const result = await request(environment, undefined, `${ROOT}/identity`)
  const value = await ok(result)
  const cookie = result.headers.getSetCookie().find(header => header.startsWith('dsh-browser-native-principal='))
  return { workspaceId: value.workspaceId, cookie: cookie.split(';', 1)[0] }
}

function post(environment, owner, path, fields = {}) {
  return request(environment, owner, path, { method: 'POST', body: {
    protocolVersion: 1, requestId: randomUUID(), workspaceId: owner.workspaceId, ...fields,
  } })
}

function uploadPath(value) {
  return `${ROOT}/blob-upload/${value.operationId}-${value.hash}`
}

function begin(environment, owner, value, fields = {}) {
  return post(environment, owner, `${ROOT}/blob-upload/start`, {
    operationId: value.operationId, hash: value.hash, totalBytes: value.bytes.byteLength,
    chunkBytes: WORKSPACE_BLOB_CHUNK_BYTES, ...(value.layout === undefined ? {} : { layout: value.layout }), ...fields,
  })
}

function put(environment, owner, value, index) {
  const range = value.layout?.chunks[index] ?? { offset: index * WORKSPACE_BLOB_CHUNK_BYTES,
    length: Math.min(WORKSPACE_BLOB_CHUNK_BYTES, value.bytes.byteLength - index * WORKSPACE_BLOB_CHUNK_BYTES) }
  const bytes = value.bytes.subarray(range.offset, range.offset + range.length)
  return request(environment, owner, `${uploadPath(value)}/${index}`, {
    method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream',
      'x-browser-native-protocol': '1', 'x-request-id': randomUUID(),
      'x-workspace-id': owner.workspaceId, 'x-chunk-sha256': sha256(bytes) },
  })
}

function complete(environment, owner, value) {
  return post(environment, owner, `${uploadPath(value)}/complete`)
}

function reuse(environment, owner, source, target, fields = {}) {
  return post(environment, owner, `${uploadPath(target)}/reuse`, {
    baseHash: source.hash, chunkHashes: target.layout.chunks.map(chunk => chunk.hash), ...fields,
  })
}

function status(environment, owner, value) {
  return request(environment, owner, `${uploadPath(value)}?protocolVersion=1&workspaceId=${owner.workspaceId}`)
}

function manifest(environment, owner) {
  return request(environment, owner, `${ROOT}/manifest?protocolVersion=1&workspaceId=${owner.workspaceId}`)
}

function blob(environment, owner, value, suffix = '') {
  return request(environment, owner, `${ROOT}/blob/${value.hash}${suffix}?protocolVersion=1&workspaceId=${owner.workspaceId}`)
}

function fileChange(value, path = 'content.bin') {
  return { path, kind: 'file', hash: value.hash, bytes: value.bytes.byteLength, mode: 0o600 }
}

function commit(environment, owner, value, baseRevision, fields = {}) {
  return post(environment, owner, `${ROOT}/commit`, { operationId: value.operationId, baseRevision,
    changes: [fileChange(value)], ...fields })
}

function removePaths(environment, owner, baseRevision, paths) {
  return post(environment, owner, `${ROOT}/commit`, { operationId: randomUUID(), baseRevision,
    changes: paths.map(path => ({ path, deleted: true })) })
}

function chunkPath(environment, hash) {
  return join(environment.dataDir, 'workspace-v2', 'chunk-objects', 'chunks', hash.slice(0, 2), hash)
}

function descriptorPath(environment, value) {
  return join(environment.dataDir, 'workspace-v2', 'chunk-objects', 'files', `${value.hash}.json`)
}

function legacyPath(environment, value) {
  return join(environment.dataDir, 'workspace-v2', 'blobs', value.hash.slice(0, 2), value.hash)
}

function staging(environment, owner, value) {
  return join(environment.dataDir, 'workspace-v2', 'uploads', owner.workspaceId, `${value.operationId}-${value.hash}`)
}

async function stage(environment, owner, value) {
  const started = await ok(begin(environment, owner, value))
  for (const index of started.missing) await ok(put(environment, owner, value, index))
  return await ok(complete(environment, owner, value))
}

async function initializeSource(environment, owner, value = upload(sourceParts())) {
  await stage(environment, owner, value)
  await ok(commit(environment, owner, value, 0))
  return value
}

function noAgentExecution(environment) {
  assert.equal(environment.app.store.sessions.size, 0)
  assert.deepEqual(environment.requests.filter(path => /\/llm(?:\/|$)|\/session(?:\/|$)/.test(path)), [])
}

test('persists CDC PUT as chunks, references reused bytes and reads complete and cross-chunk HTTP ranges', async context => {
  const environment = await fixture(context)
  const capability = await request(environment, undefined, `${ROOT}/upload-capabilities`)
  assert.deepEqual((await ok(capability)).fileStorage, { version: 1, kind: 'chunk-objects' })
  assert.deepEqual(capability.headers.getSetCookie(), [])
  const owner = await identity(environment)
  const parts = [Buffer.alloc(384 * 1024, 0x41), Buffer.alloc(768 * 1024, 0x42), Buffer.from('tail')]
  const source = await initializeSource(environment, owner, upload(parts))
  const target = upload([Buffer.alloc(32768, 0x50), ...parts])
  await ok(begin(environment, owner, target))
  const reused = await ok(reuse(environment, owner, source, target))
  assert.deepEqual(reused.reused, [1, 2, 3])
  assert.deepEqual(reused.missing, [0])
  assert.equal(reused.stagedReuseBytes, 0)
  assert.equal(reused.referencedChunkBytes, source.bytes.byteLength)
  await ok(put(environment, owner, target, 0))
  await ok(put(environment, owner, target, 0))
  for (const chunk of target.layout.chunks) {
    const bytes = await readFile(chunkPath(environment, chunk.hash))
    assert.equal(bytes.byteLength, chunk.length)
    assert.equal(sha256(bytes), chunk.hash)
  }
  assert.deepEqual(await readdir(staging(environment, owner, target)), ['upload.json'])
  await rejected(blob(environment, owner, target), 'BLOB_NOT_FOUND', 404)
  const completed = await ok(complete(environment, owner, target))
  assert.equal(completed.assembledWriteBytes, 0)
  const descriptor = await readFile(descriptorPath(environment, target))
  assert.equal(JSON.parse(descriptor).hash, target.hash)
  await assert.rejects(readFile(legacyPath(environment, target)), { code: 'ENOENT' })
  assert.equal((await ok(complete(environment, owner, target))).replayed, true)
  assert.equal((await ok(commit(environment, owner, target, 1))).revision, 2)
  assert.equal((await ok(commit(environment, owner, target, 1))).replayed, true)
  assert.equal((await ok(complete(environment, owner, target))).replayed, true)
  assert.deepEqual(await readFile(descriptorPath(environment, target)), descriptor)
  assert.deepEqual(await ok(blob(environment, owner, target)), target.bytes)
  assert.deepEqual((await ok(blob(environment, owner, target, '/layout'))).layout, target.layout)
  for (const index of [0, 1]) {
    const result = await blob(environment, owner, target, `/chunk/${index}`)
    const bytes = await ok(result)
    assert.deepEqual(bytes, target.bytes.subarray(index * WORKSPACE_BLOB_CHUNK_BYTES, (index + 1) * WORKSPACE_BLOB_CHUNK_BYTES))
    assert.equal(result.headers.get('x-content-sha256'), sha256(bytes))
    assert.equal(result.headers.get('x-total-bytes'), String(target.bytes.byteLength))
  }
  await rejected(blob(environment, owner, target, '/chunk/2'), 'INVALID_REQUEST', 400)
  assert.equal((await ok(manifest(environment, owner))).revision, 2)
  noAgentExecution(environment)
})

test('retains pending reuse roots after source deletion, GC and restart and settles the same operation once', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const source = await initializeSource(environment, owner)
  const target = upload([Buffer.alloc(32768, 0x50), ...sourceParts()])
  await ok(begin(environment, owner, target))
  await ok(reuse(environment, owner, source, target))
  await ok(removePaths(environment, owner, 1, ['content.bin']))
  await environment.app.workspaces.collectGarbage(owner.workspaceId)
  await assert.rejects(readFile(descriptorPath(environment, source)), { code: 'ENOENT' })
  for (const chunk of source.layout.chunks) await assert.doesNotReject(readFile(chunkPath(environment, chunk.hash)))
  await environment.restart()
  assert.deepEqual((await ok(status(environment, owner, target))).missing, [0])
  const resumed = await ok(begin(environment, owner, target))
  assert.equal(resumed.stagingVerificationBytes, 0)
  assert.equal(resumed.chunkVerificationBytes, source.bytes.byteLength)
  await ok(put(environment, owner, target, 0))
  await ok(complete(environment, owner, target))
  assert.equal((await ok(commit(environment, owner, target, 2))).revision, 3)
  await environment.restart()
  assert.equal((await ok(complete(environment, owner, target))).replayed, true)
  assert.equal((await ok(commit(environment, owner, target, 2))).replayed, true)
  assert.deepEqual(await ok(blob(environment, owner, target)), target.bytes)
  assert.equal((await ok(manifest(environment, owner))).revision, 3)
  noAgentExecution(environment)
})

test('shares immutable chunks across files and principals and releases them only after every root expires', async context => {
  let now = 1000
  const environment = await fixture(context, { testHooks: { workspaceNow: () => now } })
  const owner = await identity(environment)
  const foreign = await identity(environment)
  const shared = Buffer.alloc(32768, 0x53)
  const first = upload([shared, Buffer.from('first')])
  const second = upload([shared, Buffer.from('second')])
  const third = upload([shared, Buffer.from('third')])
  await stage(environment, owner, first)
  await ok(commit(environment, owner, first, 0, { changes: [fileChange(first, 'first.bin')] }))
  await stage(environment, owner, second)
  await ok(commit(environment, owner, second, 1, { changes: [fileChange(second, 'second.bin')] }))
  await stage(environment, foreign, third)
  await ok(commit(environment, foreign, third, 0, { changes: [fileChange(third, 'third.bin')] }))
  const sharedPath = chunkPath(environment, sha256(shared))
  assert.deepEqual(await readFile(sharedPath), shared)
  const chunkFiles = []
  const chunksRoot = join(environment.dataDir, 'workspace-v2', 'chunk-objects', 'chunks')
  for (const prefix of await readdir(chunksRoot)) chunkFiles.push(...await readdir(join(chunksRoot, prefix)))
  assert.deepEqual(chunkFiles.sort(), [...new Set([first, second, third].flatMap(value => value.layout.chunks.map(chunk => chunk.hash)))].sort())
  await ok(removePaths(environment, owner, 2, ['first.bin']))
  now += DAY_MS + 1
  await environment.app.workspaces.collectGarbage(owner.workspaceId)
  assert.deepEqual(await ok(blob(environment, owner, second)), second.bytes)
  assert.deepEqual(await ok(blob(environment, foreign, third)), third.bytes)
  await assert.rejects(readFile(chunkPath(environment, first.layout.chunks[1].hash)), { code: 'ENOENT' })
  await ok(removePaths(environment, owner, 3, ['second.bin']))
  await environment.app.workspaces.collectGarbage(owner.workspaceId)
  assert.deepEqual(await readFile(sharedPath), shared)
  assert.deepEqual(await ok(blob(environment, foreign, third)), third.bytes)
  await ok(removePaths(environment, foreign, 1, ['third.bin']))
  await environment.app.workspaces.collectGarbage(foreign.workspaceId)
  await assert.rejects(readFile(sharedPath), { code: 'ENOENT' })
  for (const value of [first, second, third]) await assert.rejects(readFile(descriptorPath(environment, value)), { code: 'ENOENT' })
})

for (const damage of ['missing', 'corrupt']) {
  test(`rejects ${damage} chunks at complete and commit without advancing the manifest`, async context => {
    const environment = await fixture(context)
    const owner = await identity(environment)
    const value = upload(sourceParts())
    for (const index of (await ok(begin(environment, owner, value))).missing) await ok(put(environment, owner, value, index))
    const chunk = value.layout.chunks[0]
    const path = chunkPath(environment, chunk.hash)
    const original = value.bytes.subarray(chunk.offset, chunk.offset + chunk.length)
    const damageChunk = async () => damage === 'missing' ? await rm(path) : await writeFile(path, Buffer.alloc(chunk.length, 0x5a))
    await damageChunk()
    await rejected(complete(environment, owner, value), 'BLOB_CORRUPT')
    await assert.rejects(readFile(descriptorPath(environment, value)), { code: 'ENOENT' })
    assert.equal((await ok(manifest(environment, owner))).revision, 0)
    await writeFile(path, original)
    await ok(complete(environment, owner, value))
    await damageChunk()
    await rejected(status(environment, owner, value), 'BLOB_CORRUPT')
    await rejected(begin(environment, owner, value), 'BLOB_CORRUPT')
    await rejected(commit(environment, owner, value, 0), 'BLOB_CORRUPT')
    assert.equal((await ok(manifest(environment, owner))).revision, 0)
    assert.deepEqual((await ok(manifest(environment, owner))).entries, [])
    await writeFile(path, original)
    assert.equal((await ok(commit(environment, owner, value, 0))).revision, 1)
    assert.deepEqual(await ok(blob(environment, owner, value)), value.bytes)
  })
}

test('rejects a wrong full-file hash even when every uploaded chunk hash is valid', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const value = upload(sourceParts(), { hash: sha256(Buffer.from('different file')) })
  for (const index of (await ok(begin(environment, owner, value))).missing) await ok(put(environment, owner, value, index))
  await rejected(complete(environment, owner, value), 'UPLOAD_BLOB_HASH_MISMATCH', 409)
  await assert.rejects(readFile(descriptorPath(environment, value)), { code: 'ENOENT' })
  await rejected(commit(environment, owner, value, 0), 'BLOB_FORBIDDEN', 403)
  assert.equal((await ok(manifest(environment, owner))).revision, 0)
})

for (const metadataKind of ['future-version', 'invalid-json']) {
  test(`skips chunk sweep for ${metadataKind} pending metadata rather than deleting unknown references`, async context => {
    let now = 1000
    const environment = await fixture(context, { testHooks: { workspaceNow: () => now } })
    const owner = await identity(environment)
    const value = upload([Buffer.from('pending')])
    await ok(begin(environment, owner, value))
    await ok(put(environment, owner, value, 0))
    const metadataPath = join(staging(environment, owner, value), 'upload.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    await writeFile(metadataPath, metadataKind === 'invalid-json' ? '{' : JSON.stringify({ ...metadata, version: 2 }))
    const orphan = Buffer.from('unreferenced canonical chunk')
    const orphanPath = chunkPath(environment, sha256(orphan))
    await mkdir(dirname(orphanPath), { recursive: true })
    await writeFile(orphanPath, orphan)
    const unknownPath = join(dirname(orphanPath), 'future-object')
    await writeFile(unknownPath, 'unknown bytes')
    now += DAY_MS + 1
    const result = await environment.app.workspaces.collectGarbage(owner.workspaceId)
    assert.equal(result.chunkGarbage.skipped, 'unrecognized-upload-metadata')
    await assert.doesNotReject(readFile(metadataPath))
    assert.deepEqual(await readFile(orphanPath), orphan)
    assert.deepEqual(await readFile(chunkPath(environment, value.layout.chunks[0].hash)), value.bytes)
    await rm(staging(environment, owner, value), { recursive: true })
    await environment.app.workspaces.collectGarbage(owner.workspaceId)
    await assert.rejects(readFile(orphanPath), { code: 'ENOENT' })
    assert.equal(await readFile(unknownPath, 'utf8'), 'unknown bytes')
  })
}

test('keeps completed-upload chunk roots for 24 hours after the manifest entry is deleted', async context => {
  let now = 1000
  const environment = await fixture(context, { testHooks: { workspaceNow: () => now } })
  const owner = await identity(environment)
  const value = await initializeSource(environment, owner)
  await ok(removePaths(environment, owner, 1, ['content.bin']))
  await environment.app.workspaces.collectGarbage(owner.workspaceId)
  await assert.rejects(readFile(descriptorPath(environment, value)), { code: 'ENOENT' })
  now += DAY_MS
  await environment.app.workspaces.collectGarbage(owner.workspaceId)
  for (const chunk of value.layout.chunks) await assert.doesNotReject(readFile(chunkPath(environment, chunk.hash)))
  now += 1
  await environment.app.workspaces.collectGarbage(owner.workspaceId)
  for (const chunk of value.layout.chunks) await assert.rejects(readFile(chunkPath(environment, chunk.hash)), { code: 'ENOENT' })
})

test('protects confirmed pending chunks when a file descriptor exists before its Workspace grant', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const value = upload(sourceParts())
  for (const index of (await ok(begin(environment, owner, value))).missing) await ok(put(environment, owner, value, index))
  await environment.app.workspaces.exclusive(owner.workspaceId, async () => {
    await environment.app.workspaces.chunkObjects.compose(value.hash, value.bytes.byteLength, value.layout)
  })
  await assert.doesNotReject(readFile(descriptorPath(environment, value)))
  await rejected(commit(environment, owner, value, 0), 'BLOB_FORBIDDEN', 403)
  await environment.app.workspaces.collectGarbage(owner.workspaceId)
  await assert.rejects(readFile(descriptorPath(environment, value)), { code: 'ENOENT' })
  for (const chunk of value.layout.chunks) await assert.doesNotReject(readFile(chunkPath(environment, chunk.hash)))
  await environment.restart()
  assert.deepEqual((await ok(status(environment, owner, value))).missing, [])
  await ok(complete(environment, owner, value))
  assert.equal((await ok(commit(environment, owner, value, 0))).revision, 1)
  assert.deepEqual(await ok(blob(environment, owner, value)), value.bytes)
  noAgentExecution(environment)
})

test('requires explicit chunk mode after restart and releases the dataDir lock after rejected configurations', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const source = await initializeSource(environment, owner)
  await assert.rejects(environment.restart({ workspaceChunkObjects: false }), { code: 'CHUNK_STORE_REQUIRED' })
  await assert.rejects(readFile(join(environment.dataDir, '.browser-native-backend.lock')), { code: 'ENOENT' })
  await environment.restart()
  assert.deepEqual(await ok(blob(environment, owner, source)), source.bytes)
  await assert.rejects(environment.restart({ workspaceBlobStore: {} }), { code: 'CHUNK_STORE_CONFIGURATION' })
  await assert.rejects(readFile(join(environment.dataDir, '.browser-native-backend.lock')), { code: 'ENOENT' })
  await environment.restart()
  assert.deepEqual(await ok(blob(environment, owner, source)), source.bytes)
})

test('preserves default fixed uploads and legacy complete-blob reads after chunk mode is enabled', async context => {
  const environment = await fixture(context, { workspaceChunkObjects: false })
  const capability = await ok(request(environment, undefined, `${ROOT}/upload-capabilities`))
  assert.equal(Object.hasOwn(capability, 'fileStorage'), false)
  const owner = await identity(environment)
  const legacy = await initializeSource(environment, owner, upload([Buffer.from('legacy complete blob')], { fixed: true }))
  assert.deepEqual(await readFile(legacyPath(environment, legacy)), legacy.bytes)
  await environment.restart({ workspaceChunkObjects: true })
  assert.deepEqual(await ok(blob(environment, owner, legacy)), legacy.bytes)
  const fixed = upload([Buffer.alloc(WORKSPACE_BLOB_CHUNK_BYTES + 17, 0x5f)], { fixed: true })
  await stage(environment, owner, fixed)
  await ok(commit(environment, owner, fixed, 1))
  assert.deepEqual(await ok(blob(environment, owner, fixed)), fixed.bytes)
  assert.deepEqual(await ok(blob(environment, owner, fixed, '/chunk/1')), fixed.bytes.subarray(WORKSPACE_BLOB_CHUNK_BYTES))
  assert.deepEqual(await readFile(legacyPath(environment, fixed)), fixed.bytes)
  await assert.rejects(readFile(descriptorPath(environment, fixed)), { code: 'ENOENT' })
})

test('does not claim automatic chunk migration for legacy CDC layouts with complete blobs', async context => {
  const environment = await fixture(context, { workspaceChunkObjects: false })
  const owner = await identity(environment)
  const legacy = await initializeSource(environment, owner)
  await environment.restart({ workspaceChunkObjects: true })
  assert.deepEqual(await ok(blob(environment, owner, legacy)), legacy.bytes)
  assert.deepEqual((await ok(blob(environment, owner, legacy, '/layout'))).layout, legacy.layout)
  const target = upload([Buffer.alloc(32768, 0x50), ...sourceParts()])
  await ok(begin(environment, owner, target))
  await rejected(reuse(environment, owner, legacy, target), 'BLOB_CORRUPT', 500)
  assert.equal((await ok(manifest(environment, owner))).revision, 1)
  await assert.rejects(readFile(descriptorPath(environment, legacy)), { code: 'ENOENT' })
})

test('keeps layout identity and source authorization independent of global chunk deduplication', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const foreign = await identity(environment)
  const source = await initializeSource(environment, owner)
  await rejected(blob(environment, foreign, source), 'BLOB_NOT_FOUND', 404)
  await rejected(blob(environment, foreign, source, '/layout'), 'BLOB_NOT_FOUND', 404)
  await rejected(blob(environment, { ...owner, cookie: foreign.cookie }, source), 'WORKSPACE_FORBIDDEN', 403)
  const target = upload([Buffer.alloc(32768, 0x50), ...sourceParts()])
  await ok(begin(environment, foreign, target))
  await rejected(reuse(environment, foreign, source, target), 'BLOB_NOT_FOUND', 404)
  await rejected(commit(environment, foreign, source, 0), 'BLOB_FORBIDDEN', 403)
  await ok(begin(environment, owner, target))
  const invalid = structuredClone(target.layout)
  invalid.chunks[1].offset += 1
  await rejected(begin(environment, owner, target, { layout: invalid }), 'CONTENT_LAYOUT_INVALID', 400)
  const replacement = structuredClone(target.layout)
  replacement.chunks[0].hash = sha256(Buffer.from('other bytes'))
  await rejected(begin(environment, owner, target, { layout: replacement }), 'UPLOAD_ID_CONFLICT', 409)
  await ok(reuse(environment, owner, source, target))
  await rejected(reuse(environment, owner, source, target, { chunkHashes: target.layout.chunks.map(() => '0'.repeat(64)) }),
    'UPLOAD_ID_CONFLICT', 409)
  assert.deepEqual((await ok(status(environment, foreign, target))).missing, [0, 1, 2, 3])
  assert.equal((await ok(manifest(environment, foreign))).revision, 0)
})

test('preserves CAS and writer fencing before successful commit and during idempotent replay', async context => {
  let now = 1000
  const environment = await fixture(context, { testHooks: { workspaceNow: () => now, workspaceWriterLeaseMs: 300 } })
  const owner = await identity(environment)
  const source = await initializeSource(environment, owner)
  const oldLease = await ok(post(environment, owner, `${ROOT}/lease`, { operation: 'claim' }))
  const target = upload([Buffer.alloc(32768, 0x50), ...sourceParts()])
  await ok(begin(environment, owner, target))
  await ok(reuse(environment, owner, source, target))
  await ok(put(environment, owner, target, 0))
  await ok(complete(environment, owner, target))
  const oldWriter = { writerToken: oldLease.writerToken, fencingToken: oldLease.fencingToken }
  await rejected(commit(environment, owner, target, 0, oldWriter), 'WORKSPACE_CONFLICT', 409)
  assert.equal((await ok(manifest(environment, owner))).revision, 1)
  now += 301
  const currentLease = await ok(post(environment, owner, `${ROOT}/lease`, { operation: 'claim' }))
  assert.ok(currentLease.fencingToken > oldLease.fencingToken)
  await rejected(commit(environment, owner, target, 1, oldWriter), 'WORKSPACE_OWNERSHIP_LOST', 409)
  const currentWriter = { writerToken: currentLease.writerToken, fencingToken: currentLease.fencingToken }
  assert.equal((await ok(commit(environment, owner, target, 1, currentWriter))).revision, 2)
  await rejected(commit(environment, owner, target, 1, oldWriter), 'WORKSPACE_OWNERSHIP_LOST', 409)
  assert.equal((await ok(commit(environment, owner, target, 1, currentWriter))).replayed, true)
  await rejected(commit(environment, owner, target, 1, { ...currentWriter, changes: [fileChange(target, 'different.bin')] }),
    'OPERATION_ID_REUSED', 409)
  assert.equal((await ok(manifest(environment, owner))).revision, 2)
})

test('supports empty versions and repeated chunk references without writing duplicate objects', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const empty = upload([])
  assert.equal((await stage(environment, owner, empty)).assembledWriteBytes, 0)
  await ok(commit(environment, owner, empty, 0))
  assert.deepEqual(await ok(blob(environment, owner, empty)), Buffer.alloc(0))
  const repeated = Buffer.alloc(32768, 0x52)
  const value = upload([repeated, repeated, repeated])
  await stage(environment, owner, value)
  await ok(commit(environment, owner, value, 1))
  assert.deepEqual(await ok(blob(environment, owner, value)), value.bytes)
  assert.deepEqual(await readFile(chunkPath(environment, sha256(repeated))), repeated)
  const chunksRoot = join(environment.dataDir, 'workspace-v2', 'chunk-objects', 'chunks')
  const prefixes = await readdir(chunksRoot)
  assert.deepEqual(prefixes, [sha256(repeated).slice(0, 2)])
  assert.deepEqual(await readdir(join(chunksRoot, prefixes[0])), [sha256(repeated)])
})
