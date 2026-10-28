import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { WORKSPACE_BLOB_CHUNK_BYTES } from '../workspace-v2.mjs'

const ROOT = '/api/browser-native/workspace'
const PARAMETERS = { version: 1, algorithm: 'dsh-gear-v1', minimumBytes: 32768, averageBytes: 131072, maximumBytes: 1048576 }

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function upload(parts, extra = {}) {
  const bytes = Buffer.concat(parts)
  let offset = 0
  const chunks = parts.map(part => {
    const chunk = { offset, length: part.byteLength, hash: sha256(part) }
    offset += part.byteLength
    return chunk
  })
  const operationId = randomUUID()
  const hash = sha256(bytes)
  return { bytes, operationId, hash, layout: { ...PARAMETERS, chunks }, ...extra }
}

function uploadPath(value) {
  return `${ROOT}/blob-upload/${value.operationId}-${value.hash}`
}

function sourceParts() {
  return [Buffer.alloc(32768, 0x41), Buffer.alloc(49152, 0x42), Buffer.alloc(65536, 0x43), Buffer.from('end')]
}

async function fixture(context, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'content-upload-backend-'))
  const applications = new Set()
  const proxies = new Set()
  const environment = { dataDir }
  context.after(async () => {
    for (const proxy of proxies) await new Promise((resolveClose, rejectClose) => proxy.close(error => error ? rejectClose(error) : resolveClose()))
    for (const app of applications) await app.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  environment.restart = async () => {
    for (const app of applications) {
      await app.close()
      applications.delete(app)
    }
    const app = await createBrowserNativeV2Server({ dataDir, port: 0, llmMode: 'scripted', ...options })
    applications.add(app)
    environment.app = app
    environment.origin = await app.listen()
  }
  environment.proxy = async drop => {
    const proxy = createServer(async (request, response) => {
      try {
        const pieces = []
        for await (const piece of request) pieces.push(piece)
        const upstream = await fetch(`${environment.origin}${request.url}`, {
          method: request.method,
          headers: { ...request.headers, host: new URL(environment.origin).host },
          ...(pieces.length === 0 ? {} : { body: Buffer.concat(pieces) }),
        })
        const body = Buffer.from(await upstream.arrayBuffer())
        if (drop(request, upstream.status)) {
          response.destroy()
          return
        }
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers))
        response.end(body)
      } catch (error) {
        response.destroy(error)
      }
    })
    proxies.add(proxy)
    await new Promise(resolveListen => proxy.listen(0, '127.0.0.1', resolveListen))
    return `http://127.0.0.1:${proxy.address().port}`
  }
  await environment.restart()
  return environment
}

async function request(environment, identity, path, { method = 'GET', body, headers = {}, origin = environment.origin } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { ...(identity === undefined ? {} : { cookie: identity.cookie }), ...headers,
      ...(body === undefined || Buffer.isBuffer(body) ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
  })
  const value = await response.json()
  return { status: response.status, value, headers: response.headers }
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
  return result
}

async function identity(environment) {
  const result = await request(environment, undefined, `${ROOT}/identity`)
  const value = await ok(result)
  const cookie = result.headers.getSetCookie().find(value => value.startsWith('dsh-browser-native-principal='))
  return { workspaceId: value.workspaceId, cookie: cookie.split(';', 1)[0] }
}

function post(environment, owner, path, fields = {}, options) {
  return request(environment, owner, path, { method: 'POST', body: {
    protocolVersion: 1, requestId: randomUUID(), workspaceId: owner.workspaceId, ...fields,
  }, ...options })
}

function begin(environment, owner, value, fields = {}, options) {
  return post(environment, owner, `${ROOT}/blob-upload/start`, {
    operationId: value.operationId, hash: value.hash, totalBytes: value.bytes.byteLength,
    chunkBytes: WORKSPACE_BLOB_CHUNK_BYTES, layout: value.layout, ...fields,
  }, options)
}

function put(environment, owner, value, index, options = {}) {
  const chunk = value.layout.chunks[index]
  return request(environment, owner, `${uploadPath(value)}/${index}`, {
    method: 'PUT', body: value.bytes.subarray(chunk.offset, chunk.offset + chunk.length),
    headers: { 'content-type': 'application/octet-stream', 'x-browser-native-protocol': '1',
      'x-request-id': randomUUID(), 'x-workspace-id': owner.workspaceId, 'x-chunk-sha256': chunk.hash },
    ...options,
  })
}

function complete(environment, owner, value, options) {
  return post(environment, owner, `${uploadPath(value)}/complete`, {}, options)
}

function reuse(environment, owner, source, target, fields = {}, options) {
  return post(environment, owner, `${uploadPath(target)}/reuse`, {
    baseHash: source.hash, chunkHashes: target.layout.chunks.map(chunk => chunk.hash), ...fields,
  }, options)
}

function status(environment, owner, value) {
  return request(environment, owner, `${uploadPath(value)}?protocolVersion=1&workspaceId=${owner.workspaceId}`)
}

function layout(environment, owner, value, query = '') {
  return request(environment, owner, `${ROOT}/blob/${value.hash}/layout?protocolVersion=1&workspaceId=${owner.workspaceId}${query}`)
}

function commit(environment, owner, value, baseRevision, extra = {}, options) {
  return post(environment, owner, `${ROOT}/commit`, { operationId: value.operationId, baseRevision,
    changes: [{ path: 'content.bin', kind: 'file', hash: value.hash, bytes: value.bytes.byteLength, mode: 0o600 }], ...extra }, options)
}

function staging(environment, owner, value) {
  return join(environment.dataDir, 'workspace-v2', 'uploads', owner.workspaceId, `${value.operationId}-${value.hash}`)
}

function indexPath(environment, owner, value) {
  return join(environment.dataDir, 'workspace-v2', 'layouts', owner.workspaceId, `${value.hash}.json`)
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

test('declares constant capabilities without a cookie and rejects unsupported layout queries', async context => {
  const environment = await fixture(context)
  const result = await request(environment, undefined, `${ROOT}/upload-capabilities`)
  const capability = await ok(result)
  assert.deepEqual(capability.contentLayout, { ...PARAMETERS, maxChunks: 2048 })
  assert.deepEqual(result.headers.getSetCookie(), [])
  await rejected(request(environment, undefined, `${ROOT}/upload-capabilities?layoutVersion=2`), 'PROTOCOL_UNSUPPORTED')
  const owner = await identity(environment)
  const source = await initializeSource(environment, owner)
  assert.deepEqual((await ok(layout(environment, owner, source))).layout, source.layout)
  for (const query of ['&layoutVersion=2', '&version=2', '&protocolVersion=2', '&workspaceId=other']) {
    await rejected(layout(environment, owner, source, query), 'PROTOCOL_UNSUPPORTED')
  }
})

test('uploads a shifted layout through reuse, missing PUT, full verification and one manifest CAS', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const source = await initializeSource(environment, owner)
  const target = upload([Buffer.alloc(32768, 0x50), ...sourceParts()])
  assert.deepEqual((await ok(begin(environment, owner, target))).missing, [0, 1, 2, 3, 4])
  const result = await ok(reuse(environment, owner, source, target))
  assert.deepEqual(result.reused, [1, 2, 3, 4])
  assert.deepEqual(result.missing, [0])
  assert.equal(result.baseVerificationBytes, source.bytes.byteLength)
  assert.equal(result.comparedSourceBytes, source.bytes.byteLength)
  assert.equal(result.stagedReuseBytes, source.bytes.byteLength)
  assert.equal(result.stagingVerificationBytes, source.bytes.byteLength)
  const repeated = await ok(reuse(environment, owner, source, target))
  assert.equal(repeated.comparedSourceBytes, 0)
  assert.equal(repeated.stagedReuseBytes, 0)
  assert.equal(repeated.stagingVerificationBytes, 2 * source.bytes.byteLength)
  const written = await ok(put(environment, owner, target, 0))
  assert.equal(written.stagedUploadBytes, 32768)
  await rejected(layout(environment, owner, target), 'BLOB_NOT_FOUND', 404)
  const completed = await ok(complete(environment, owner, target))
  assert.equal(completed.stagedReadBytes, target.bytes.byteLength)
  assert.equal(completed.assembledWriteBytes, target.bytes.byteLength)
  assert.equal(completed.blobVerificationBytes, 0)
  assert.equal(completed.retainedStagingBytes, 0)
  assert.deepEqual(await readdir(staging(environment, owner, target)), ['upload.json'])
  assert.equal(JSON.parse(await readFile(join(staging(environment, owner, target), 'upload.json'), 'utf8')).completed, true)
  await rejected(layout(environment, owner, target), 'BLOB_NOT_FOUND', 404)
  let commitVerificationBytes = 0
  const verify = environment.app.workspaces.blobStore.verify.bind(environment.app.workspaces.blobStore)
  environment.app.workspaces.blobStore.verify = async (hash, expectedBytes) => {
    const verified = await verify(hash, expectedBytes)
    commitVerificationBytes += expectedBytes
    return verified
  }
  assert.equal((await ok(commit(environment, owner, target, 1))).revision, 2)
  assert.equal(commitVerificationBytes, target.bytes.byteLength)
  assert.equal((await ok(commit(environment, owner, target, 1))).replayed, true)
  assert.equal(commitVerificationBytes, target.bytes.byteLength)
  const downloaded = await fetch(`${environment.origin}${ROOT}/blob/${target.hash}?protocolVersion=1&workspaceId=${owner.workspaceId}`, {
    headers: { cookie: owner.cookie },
  })
  assert.equal(downloaded.status, 200)
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), target.bytes)
  assert.deepEqual((await ok(layout(environment, owner, target))).layout, target.layout)
  const metadata = JSON.parse(await readFile(join(environment.dataDir, 'workspace-v2', 'workspaces', `${owner.workspaceId}.json`), 'utf8'))
  assert.deepEqual(Object.keys(metadata).sort(), ['entries', 'id', 'operations', 'owner', 'revision', 'uploadedAt', 'uploadedHashes', 'version', 'writerEpoch'])
})

test('recovers lost reuse, PUT, completion and CAS responses across backend restarts', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const source = await initializeSource(environment, owner)
  const target = upload([Buffer.alloc(32768, 0x50), ...sourceParts()])
  await ok(begin(environment, owner, target))
  let phase = 'reuse'
  let dropped = 0
  const origin = await environment.proxy((request, status) => {
    const matches = phase === 'put' ? request.method === 'PUT'
      : phase === 'commit' ? request.url === `${ROOT}/commit` : request.url.endsWith(`/${phase}`)
    if (!matches || status !== 200) return false
    dropped += 1
    return true
  })
  await assert.rejects(reuse(environment, owner, source, target, {}, { origin }), TypeError)
  assert.equal(dropped, 1)
  assert.deepEqual(JSON.parse(await readFile(join(staging(environment, owner, target), 'upload.json'), 'utf8')).reuse,
    { baseHash: source.hash, chunkHashes: target.layout.chunks.map(chunk => chunk.hash) })
  await environment.restart()
  assert.equal((await ok(begin(environment, owner, target))).reusePlanned, true)
  assert.deepEqual((await ok(status(environment, owner, target))).missing, [0])
  phase = 'put'
  await assert.rejects(put(environment, owner, target, 0, { origin }), TypeError)
  assert.equal(dropped, 2)
  await environment.restart()
  assert.deepEqual((await ok(status(environment, owner, target))).missing, [])
  assert.equal((await ok(put(environment, owner, target, 0))).replayed, true)
  phase = 'complete'
  await assert.rejects(complete(environment, owner, target, { origin }), TypeError)
  assert.equal(dropped, 3)
  await environment.restart()
  assert.equal((await ok(status(environment, owner, target))).complete, true)
  const replayedComplete = await ok(complete(environment, owner, target))
  assert.equal(replayedComplete.replayed, true)
  assert.equal(replayedComplete.stagedReadBytes, 0)
  assert.equal(replayedComplete.assembledWriteBytes, 0)
  assert.equal(replayedComplete.blobVerificationBytes, target.bytes.byteLength)
  assert.equal(replayedComplete.retainedStagingBytes, 0)
  phase = 'commit'
  await assert.rejects(commit(environment, owner, target, 1, {}, { origin }), TypeError)
  assert.equal(dropped, 4)
  await environment.restart()
  const replayed = await ok(commit(environment, owner, target, 1))
  assert.equal(replayed.revision, 2)
  assert.equal(replayed.replayed, true)
  assert.equal((await ok(status(environment, owner, target))).complete, true)
})

test('rejects gaps, overlap, out-of-range, oversized and unbounded descriptors without creating uploads', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const value = upload(sourceParts())
  const altered = mutate => {
    const candidate = structuredClone(value.layout)
    mutate(candidate)
    return candidate
  }
  const invalid = [
    altered(candidate => { candidate.chunks[0].offset = 1 }),
    altered(candidate => { candidate.chunks[1].offset += 1 }),
    altered(candidate => { candidate.chunks[1].offset -= 1 }),
    altered(candidate => { candidate.chunks.at(-1).length += 1 }),
    altered(candidate => { candidate.chunks.at(-1).length = 0 }),
    altered(candidate => { candidate.chunks[0].length = 32767 }),
    altered(candidate => { candidate.chunks[0].length = 1048577 }),
    altered(candidate => { candidate.chunks[0].hash = 'invalid' }),
    altered(candidate => { candidate.chunks[0].hash = 'A'.repeat(64) }),
    altered(candidate => { candidate.chunks[0].offset = 0.5 }),
    altered(candidate => { candidate.chunks[0].length = Number.MAX_SAFE_INTEGER + 1 }),
    altered(candidate => { candidate.chunks[0].extra = true }),
    altered(candidate => { candidate.maxChunks = 2048 }),
    altered(candidate => { delete candidate.averageBytes }),
    altered(candidate => { candidate.chunks.pop() }),
    altered(candidate => { candidate.chunks = [] }),
    altered(candidate => { candidate.chunks = Array.from({ length: 2049 }, () => candidate.chunks[0]) }),
  ]
  for (const candidate of invalid) {
    await rejected(begin(environment, owner, value, { layout: candidate }), 'CONTENT_LAYOUT_INVALID', 400)
  }
  for (const [field, replacement] of [['version', 2], ['algorithm', 'other'], ['minimumBytes', 1], ['averageBytes', 65536], ['maximumBytes', 2097152]]) {
    await rejected(begin(environment, owner, value, { layout: { ...value.layout, [field]: replacement } }), 'CONTENT_LAYOUT_UNSUPPORTED', 400)
  }
  await rejected(begin(environment, owner, value, { layout: null }), 'INVALID_REQUEST', 400)
  assert.deepEqual(await readdir(join(environment.dataDir, 'workspace-v2', 'uploads')), [])
})

test('binds canonical layouts and reuse hashes immutably before and after completion and restart', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const source = await initializeSource(environment, owner)
  const target = upload([Buffer.alloc(32768, 0x50), ...sourceParts()])
  await ok(begin(environment, owner, target))
  const changedHash = structuredClone(target.layout)
  changedHash.chunks[0].hash = '0'.repeat(64)
  const changedRanges = { ...target.layout, chunks: [
    { offset: 0, length: 65536, hash: sha256(target.bytes.subarray(0, 65536)) },
    ...target.layout.chunks.slice(2),
  ] }
  for (const candidate of [changedHash, changedRanges, undefined]) {
    await rejected(begin(environment, owner, target, { layout: candidate }), 'UPLOAD_ID_CONFLICT', 409)
  }
  await rejected(begin(environment, owner, target, { totalBytes: target.bytes.byteLength + 1,
    layout: { ...target.layout, chunks: [...target.layout.chunks.slice(0, -1), { ...target.layout.chunks.at(-1), length: 4 }] } }), 'UPLOAD_ID_CONFLICT', 409)
  const reversedFields = { chunks: target.layout.chunks.map(({ hash, length, offset }) => ({ hash, length, offset })),
    maximumBytes: 1048576, averageBytes: 131072, minimumBytes: 32768, algorithm: 'dsh-gear-v1', version: 1 }
  await ok(begin(environment, owner, target, { layout: reversedFields }))
  await rejected(reuse(environment, owner, source, target, { chunkHashes: target.layout.chunks.map(() => '0'.repeat(64)) }),
    'UPLOAD_CHUNK_CONFLICT', 409)
  await ok(reuse(environment, owner, source, target))
  await rejected(reuse(environment, owner, source, target, { baseHash: '0'.repeat(64) }), 'UPLOAD_ID_CONFLICT', 409)
  await ok(put(environment, owner, target, 0))
  await ok(complete(environment, owner, target))
  await rejected(begin(environment, owner, target, { layout: changedHash }), 'UPLOAD_ID_CONFLICT', 409)
  await ok(commit(environment, owner, target, 1))
  await environment.restart()
  await rejected(begin(environment, owner, target, { layout: changedHash }), 'UPLOAD_ID_CONFLICT', 409)
  await rejected(begin(environment, owner, target, { layout: undefined }), 'UPLOAD_ID_CONFLICT', 409)
  assert.equal((await ok(begin(environment, owner, target))).complete, true)
})

test('checks each descriptor hash and length independently of the chunk PUT hash', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const value = upload(sourceParts())
  await ok(begin(environment, owner, value))
  const other = Buffer.alloc(32768, 0x58)
  await rejected(put(environment, owner, value, 0, { body: other }), 'UPLOAD_CHUNK_HASH_MISMATCH', 400)
  await rejected(put(environment, owner, value, 0, { body: other, headers: {
    'x-browser-native-protocol': '1', 'x-request-id': randomUUID(), 'x-workspace-id': owner.workspaceId,
    'x-chunk-sha256': sha256(other),
  } }), 'UPLOAD_CHUNK_CONFLICT', 409)
  const short = value.bytes.subarray(0, 1)
  await rejected(put(environment, owner, value, 0, { body: short, headers: {
    'x-browser-native-protocol': '1', 'x-request-id': randomUUID(), 'x-workspace-id': owner.workspaceId,
    'x-chunk-sha256': sha256(short),
  } }), 'UPLOAD_CHUNK_SIZE_MISMATCH', 400)
  await rejected(complete(environment, owner, value), 'UPLOAD_INCOMPLETE', 409)
})

test('fixes one verified layout per Workspace and hash while preserving earlier completed replays', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const parts = sourceParts()
  const first = upload(parts)
  const alternate = upload([Buffer.concat(parts.slice(0, 2)), ...parts.slice(2)])
  assert.equal(first.hash, alternate.hash)
  await ok(begin(environment, owner, alternate))
  for (const index of [0, 1, 2]) await ok(put(environment, owner, alternate, index))
  await stage(environment, owner, first)
  const expected = await readFile(indexPath(environment, owner, first), 'utf8')
  await rejected(complete(environment, owner, alternate), 'CONTENT_LAYOUT_CONFLICT', 409)
  await rejected(begin(environment, owner, { ...alternate, operationId: randomUUID() }), 'CONTENT_LAYOUT_CONFLICT', 409)
  assert.equal(await readFile(indexPath(environment, owner, first), 'utf8'), expected)
  const matching = { ...first, operationId: randomUUID() }
  const result = await stage(environment, owner, matching)
  assert.equal(result.blobVerificationBytes, first.bytes.byteLength)
  assert.equal(result.stagedReadBytes, first.bytes.byteLength)
  assert.equal(result.assembledWriteBytes, first.bytes.byteLength)
  await ok(commit(environment, owner, first, 0))
  await environment.restart()
  assert.equal((await ok(begin(environment, owner, first))).complete, true)
  assert.equal((await ok(complete(environment, owner, first))).assembledWriteBytes, 0)
  assert.deepEqual((await ok(layout(environment, owner, first))).layout, first.layout)
})

test('releases interrupted post-marker staging and verifies completed target bytes without reassembly', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const value = upload(sourceParts())
  await stage(environment, owner, value)
  const directory = staging(environment, owner, value)
  await writeFile(join(directory, '0.part'), value.bytes.subarray(0, 32768))
  await writeFile(join(directory, 'assembled.upload'), 'interrupted cleanup')
  await environment.restart()
  assert.equal((await ok(begin(environment, owner, value))).retainedStagingBytes, 0)
  assert.deepEqual(await readdir(directory), ['upload.json'])
  assert.equal((await ok(put(environment, owner, value, 0))).stagedUploadBytes, 0)
  assert.deepEqual(await readdir(directory), ['upload.json'])
  const replayed = await ok(complete(environment, owner, value))
  assert.equal(replayed.stagedReadBytes, 0)
  assert.equal(replayed.assembledWriteBytes, 0)
  assert.equal(replayed.blobVerificationBytes, value.bytes.byteLength)
  await writeFile(environment.app.workspaces.blobStore.path(value.hash), Buffer.alloc(value.bytes.byteLength, 0x58))
  await rejected(complete(environment, owner, value), 'BLOB_CORRUPT', 409)
  await rejected(commit(environment, owner, value, 0), 'BLOB_CORRUPT', 409)
})

test('requires current principal and manifest authorization for indices and reuse sources', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const foreign = await identity(environment)
  const source = await initializeSource(environment, foreign)
  const target = upload([Buffer.alloc(32768, 0x50), ...sourceParts()])
  await ok(begin(environment, owner, target))
  await rejected(layout(environment, owner, source), 'BLOB_NOT_FOUND', 404)
  await rejected(request(environment, owner, `${ROOT}/blob/${source.hash}/layout?protocolVersion=1&workspaceId=${foreign.workspaceId}`),
    'WORKSPACE_FORBIDDEN', 403)
  await rejected(reuse(environment, owner, source, target), 'BLOB_NOT_FOUND', 404)
  await rejected(post(environment, foreign, `${uploadPath(target)}/reuse`, {
    workspaceId: owner.workspaceId, baseHash: source.hash, chunkHashes: target.layout.chunks.map(chunk => chunk.hash),
  }), 'WORKSPACE_FORBIDDEN', 403)
  const pending = upload([Buffer.from('not committed')])
  await stage(environment, owner, pending)
  await rejected(layout(environment, owner, pending), 'BLOB_NOT_FOUND', 404)
  await rejected(reuse(environment, owner, pending, target), 'BLOB_NOT_FOUND', 404)
  await rejected(request(environment, owner, `${ROOT}/blob/${source.hash}/layout?protocolVersion=1&workspaceId=../../outside`), 'INVALID_REQUEST', 400)
  await rejected(request(environment, undefined, `${ROOT}/blob/${source.hash}/layout?protocolVersion=1&workspaceId=${foreign.workspaceId}`), 'UNAUTHENTICATED', 401)
  assert.deepEqual((await ok(status(environment, owner, target))).missing, [0, 1, 2, 3, 4])
})

test('keeps fixed uploads readable and explicitly rejects absent or corrupt layout indices', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const source = upload([Buffer.from('legacy fixed blob')])
  await ok(begin(environment, owner, source, { layout: undefined }))
  await ok(put(environment, owner, source, 0))
  await ok(complete(environment, owner, source))
  await ok(commit(environment, owner, source, 0))
  const fixedReplay = { ...source, operationId: randomUUID() }
  await ok(begin(environment, owner, fixedReplay, { layout: undefined }))
  await ok(put(environment, owner, fixedReplay, 0))
  await ok(complete(environment, owner, fixedReplay))
  assert.equal((await ok(status(environment, owner, fixedReplay))).complete, true)
  await environment.restart()
  await rejected(layout(environment, owner, source), 'CONTENT_LAYOUT_UNAVAILABLE', 404)
  const target = upload([Buffer.from('content target')])
  await ok(begin(environment, owner, target))
  await rejected(reuse(environment, owner, source, target), 'CONTENT_LAYOUT_UNAVAILABLE', 404)
  assert.equal(JSON.parse(await readFile(join(staging(environment, owner, target), 'upload.json'), 'utf8')).reuse, undefined)
  await stage(environment, owner, target)
  await ok(commit(environment, owner, target, 1))
  await writeFile(indexPath(environment, owner, target), '{')
  await rejected(layout(environment, owner, target), 'CONTENT_LAYOUT_CORRUPT', 500)
  const gc = await environment.app.workspaces.collectGarbage(owner.workspaceId)
  assert.equal(gc.preservedUnrecognizedLayouts, 1)
  assert.equal(await readFile(indexPath(environment, owner, target), 'utf8'), '{')
})

test('rejects false whole-file hashes and corrupt staging, then accepts verified repairs', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const bad = upload(sourceParts(), { hash: '0'.repeat(64) })
  await ok(begin(environment, owner, bad))
  for (const index of [0, 1, 2, 3]) await ok(put(environment, owner, bad, index))
  await rejected(complete(environment, owner, bad), 'UPLOAD_BLOB_HASH_MISMATCH', 409)
  await rejected(commit(environment, owner, bad, 0), 'BLOB_FORBIDDEN', 403)
  await assert.rejects(readFile(indexPath(environment, owner, bad)), { code: 'ENOENT' })
  const value = upload(sourceParts())
  await ok(begin(environment, owner, value))
  for (const index of [0, 1, 2, 3]) await ok(put(environment, owner, value, index))
  await writeFile(join(staging(environment, owner, value), '1.part'), Buffer.alloc(49152, 0x58))
  await rm(join(staging(environment, owner, value), '2.part'))
  assert.deepEqual((await ok(status(environment, owner, value))).missing, [1, 2])
  assert.deepEqual((await ok(begin(environment, owner, value))).missing, [1, 2])
  await rejected(complete(environment, owner, value), 'UPLOAD_CHUNK_CORRUPT', 409)
  await ok(put(environment, owner, value, 1))
  await rejected(complete(environment, owner, value), 'UPLOAD_CHUNK_CORRUPT', 409)
  await ok(put(environment, owner, value, 2))
  await writeFile(join(staging(environment, owner, value), 'assembled.upload'), 'interrupted assembly')
  await ok(complete(environment, owner, value))
  await ok(commit(environment, owner, value, 0))
  assert.deepEqual(await environment.app.workspaces.blobStore.get(value.hash), value.bytes)
})

test('verifies the complete source and each indexed candidate rather than trusting sidecar hashes', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const source = await initializeSource(environment, owner)
  const target = upload([Buffer.alloc(32768, 0x50), ...sourceParts()])
  await ok(begin(environment, owner, target))
  const blobPath = environment.app.workspaces.blobStore.path(source.hash)
  await writeFile(blobPath, Buffer.alloc(source.bytes.byteLength, 0x58))
  await rejected(reuse(environment, owner, source, target), 'BLOB_CORRUPT', 500)
  await writeFile(blobPath, source.bytes)
  const path = indexPath(environment, owner, source)
  const index = JSON.parse(await readFile(path, 'utf8'))
  index.layout.chunks[0].hash = target.layout.chunks[0].hash
  await writeFile(path, JSON.stringify(index))
  await rejected(reuse(environment, owner, source, target), 'BLOB_CORRUPT', 500)
  assert.deepEqual((await ok(status(environment, owner, target))).missing, [0, 1, 2, 3, 4])
  assert.equal(JSON.parse(await readFile(join(staging(environment, owner, target), 'upload.json'), 'utf8')).reuse.baseHash, source.hash)
})

test('completes and replays self-contained staging after source GC and collects only unused recognized indices', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const source = await initializeSource(environment, owner)
  const target = upload([Buffer.alloc(32768, 0x50), ...sourceParts()])
  await ok(begin(environment, owner, target))
  await ok(reuse(environment, owner, source, target))
  await ok(post(environment, owner, `${ROOT}/commit`, { operationId: randomUUID(), baseRevision: 1,
    changes: [{ path: 'content.bin', deleted: true }] }))
  const foreign = await identity(environment)
  await initializeSource(environment, foreign, upload([Buffer.from('foreign retained')]))
  const gc = await environment.app.workspaces.collectGarbage(owner.workspaceId)
  assert.equal(gc.removedLayouts, 1)
  assert.equal(await environment.app.workspaces.blobStore.stat(source.hash), undefined)
  await assert.rejects(readFile(indexPath(environment, owner, source)), { code: 'ENOENT' })
  await rejected(layout(environment, owner, source), 'BLOB_NOT_FOUND', 404)
  await rejected(reuse(environment, owner, source, target), 'BLOB_NOT_FOUND', 404)
  await environment.restart()
  assert.equal((await ok(begin(environment, owner, target))).reusePlanned, true)
  assert.deepEqual((await ok(status(environment, owner, target))).missing, [0])
  await ok(put(environment, owner, target, 0))
  await ok(complete(environment, owner, target))
  await environment.app.workspaces.collectGarbage(owner.workspaceId)
  await assert.doesNotReject(readFile(indexPath(environment, owner, target)))
  assert.equal((await ok(complete(environment, owner, target))).replayed, true)
  assert.equal((await ok(commit(environment, owner, target, 2))).revision, 3)
  await environment.restart()
  assert.equal((await ok(complete(environment, owner, target))).replayed, true)
  assert.deepEqual(await environment.app.workspaces.blobStore.get(target.hash), target.bytes)
})

test('collects layout indices only while holding their own Workspace lock', async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const foreign = await identity(environment)
  const value = await initializeSource(environment, foreign)
  await ok(post(environment, foreign, `${ROOT}/commit`, { operationId: randomUUID(), baseRevision: 1,
    changes: [{ path: 'content.bin', deleted: true }] }))
  assert.equal((await environment.app.workspaces.collectGarbage(owner.workspaceId)).removedLayouts, 0)
  await assert.doesNotReject(readFile(indexPath(environment, foreign, value)))
  assert.equal((await environment.app.workspaces.collectGarbage(foreign.workspaceId)).removedLayouts, 1)
  await assert.rejects(readFile(indexPath(environment, foreign, value)), { code: 'ENOENT' })
})

test('preserves manifest CAS and writer fencing after CDC completion', async context => {
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
  await rejected(commit(environment, owner, target, 0, { writerToken: oldLease.writerToken, fencingToken: oldLease.fencingToken }),
    'WORKSPACE_CONFLICT', 409)
  now += 301
  const currentLease = await ok(post(environment, owner, `${ROOT}/lease`, { operation: 'claim' }))
  assert.ok(currentLease.fencingToken > oldLease.fencingToken)
  await rejected(commit(environment, owner, target, 1, { writerToken: oldLease.writerToken, fencingToken: oldLease.fencingToken }),
    'WORKSPACE_OWNERSHIP_LOST', 409)
  const fields = { writerToken: currentLease.writerToken, fencingToken: currentLease.fencingToken }
  assert.equal((await ok(commit(environment, owner, target, 1, fields))).revision, 2)
  await rejected(commit(environment, owner, target, 1, { writerToken: oldLease.writerToken, fencingToken: oldLease.fencingToken }),
    'WORKSPACE_OWNERSHIP_LOST', 409)
  assert.equal((await ok(commit(environment, owner, target, 1, fields))).replayed, true)
})

test('accepts empty files and the bounded 2048-chunk layout while expiring only recognized staging', async context => {
  let now = 1000
  const environment = await fixture(context, { pendingUploadTtlMs: 1000, testHooks: { workspaceNow: () => now } })
  const owner = await identity(environment)
  const empty = upload([])
  assert.deepEqual((await ok(begin(environment, owner, empty))).missing, [])
  await ok(complete(environment, owner, empty))
  await ok(commit(environment, owner, empty, 0))
  assert.deepEqual((await ok(layout(environment, owner, empty))).layout.chunks, [])
  const pending = upload([Buffer.from('pending layout')])
  await stage(environment, owner, pending)
  const part = Buffer.alloc(32768, 0x41)
  const chunks = Array.from({ length: 2048 }, (_, index) => ({ offset: index * part.length, length: part.length, hash: sha256(part) }))
  const bounded = { ...pending, operationId: randomUUID(), hash: '1'.repeat(64),
    bytes: { byteLength: 64 * 1024 * 1024 }, layout: { ...PARAMETERS, chunks } }
  assert.equal((await ok(begin(environment, owner, bounded))).chunkCount, 2048)
  const corrupt = upload([Buffer.from('corrupt metadata')])
  await ok(begin(environment, owner, corrupt))
  const path = join(staging(environment, owner, corrupt), 'upload.json')
  const metadata = JSON.parse(await readFile(path, 'utf8'))
  metadata.layout.chunks[0].hash = '0'.repeat(64)
  metadata.chunks = [corrupt.layout.chunks[0].hash]
  await writeFile(path, JSON.stringify(metadata))
  await rejected(status(environment, owner, corrupt), 'UPLOAD_METADATA_INVALID', 500)
  now += 86_400_001
  const gc = await environment.app.workspaces.collectGarbage(owner.workspaceId)
  assert.equal(gc.preservedUnrecognizedUploads, 1)
  assert.equal(gc.expiredUploads, 3)
  assert.equal(gc.removedLayouts, 1)
  await assert.rejects(readFile(indexPath(environment, owner, pending)), { code: 'ENOENT' })
  assert.deepEqual((await ok(layout(environment, owner, empty))).layout.chunks, [])
  await assert.doesNotReject(readFile(path))
})
