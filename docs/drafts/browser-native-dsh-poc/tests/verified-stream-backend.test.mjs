import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { WORKSPACE_BLOB_CHUNK_BYTES, WORKSPACE_CONTENT_LAYOUT } from '../workspace-v2.mjs'

const ROOT = '/api/browser-native/workspace'
const TEST_OPTIONS = { timeout: 15_000 }

function deferred() {
  const { promise, resolve, reject } = Promise.withResolvers()
  return { promise, resolve, reject }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function content(parts = [Buffer.alloc(32768, 0x41), Buffer.alloc(49152, 0x42), Buffer.from('short tail')]) {
  const bytes = Buffer.concat(parts)
  const { maxChunks, ...parameters } = WORKSPACE_CONTENT_LAYOUT
  let offset = 0
  const chunks = parts.map(part => {
    const chunk = { offset, length: part.length, hash: sha256(part) }
    offset += part.length
    return chunk
  })
  return { bytes, hash: sha256(bytes), operationId: randomUUID(), layout: { ...parameters, chunks } }
}

async function fixture(context, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'verified-stream-backend-'))
  const environment = { dataDir, clients: new Set(), gates: new Set() }
  environment.stop = async () => {
    for (const gate of environment.gates) gate.resolve()
    for (const client of environment.clients) client.destroy()
    if (environment.app !== undefined) {
      const app = environment.app
      environment.app = undefined
      await app.close()
    }
  }
  context.after(async () => {
    try { await environment.stop() } finally { await rm(dataDir, { recursive: true, force: true }) }
  })
  environment.restart = async (overrides = {}) => {
    await environment.stop()
    environment.app = await createBrowserNativeV2Server({ dataDir, port: 0, llmMode: 'scripted',
      workspaceChunkObjects: true, workspaceVerifiedDownloads: true, ...options, ...overrides })
    environment.origin = await environment.app.listen()
  }
  await environment.restart()
  return environment
}

async function request(environment, owner, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${environment.origin}${ROOT}${path}`, {
    method, headers: { ...(owner === undefined ? {} : { cookie: owner.cookie }), ...headers,
      ...(body === undefined || Buffer.isBuffer(body) ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  return { status: response.status, headers: response.headers,
    value: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString()) : bytes }
}

async function ok(result) {
  result = await result
  assert.equal(result.status, 200, JSON.stringify(result.value))
  return result.value
}

async function rejected(result, status, code) {
  result = await result
  assert.equal(result.status, status)
  assert.equal(result.value.error?.code, code, JSON.stringify(result.value))
}

async function identity(environment) {
  const response = await request(environment, undefined, '/identity')
  const { workspaceId } = await ok(response)
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('dsh-browser-native-principal='))
  return { workspaceId, cookie: cookie.split(';', 1)[0] }
}

function post(environment, owner, path, body) {
  return request(environment, owner, path, { method: 'POST', body: {
    protocolVersion: 1, requestId: randomUUID(), workspaceId: owner.workspaceId, ...body,
  } })
}

function query(owner) {
  return `protocolVersion=1&workspaceId=${owner.workspaceId}`
}

function streamPath(owner, value) {
  return `/blob/${value.hash}/stream?${query(owner)}`
}

function chunkPath(environment, chunk) {
  return join(environment.dataDir, 'workspace-v2', 'chunk-objects', 'chunks', chunk.hash.slice(0, 2), chunk.hash)
}

function descriptorPath(environment, value) {
  return join(environment.dataDir, 'workspace-v2', 'chunk-objects', 'files', `${value.hash}.json`)
}

async function stage(environment, owner, value, { fixed = false } = {}) {
  const uploadPath = `/blob-upload/${value.operationId}-${value.hash}`
  const started = await ok(post(environment, owner, '/blob-upload/start', {
    operationId: value.operationId, hash: value.hash, totalBytes: value.bytes.length,
    chunkBytes: WORKSPACE_BLOB_CHUNK_BYTES, ...(fixed ? {} : { layout: value.layout }),
  }))
  for (const index of started.missing) {
    const range = fixed ? { offset: index * WORKSPACE_BLOB_CHUNK_BYTES,
      length: Math.min(WORKSPACE_BLOB_CHUNK_BYTES, value.bytes.length - index * WORKSPACE_BLOB_CHUNK_BYTES) }
      : value.layout.chunks[index]
    const bytes = value.bytes.subarray(range.offset, range.offset + range.length)
    await ok(request(environment, owner, `${uploadPath}/${index}`, { method: 'PUT', body: bytes,
      headers: { 'x-browser-native-protocol': '1', 'x-workspace-id': owner.workspaceId,
        'x-request-id': randomUUID(), 'x-chunk-sha256': sha256(bytes) } }))
  }
  await ok(post(environment, owner, `${uploadPath}/complete`))
}

async function commit(environment, owner, value, baseRevision = 0, deleted = false) {
  return await ok(post(environment, owner, '/commit', { operationId: randomUUID(), baseRevision,
    changes: [deleted ? { path: 'content.bin', deleted: true }
      : { path: 'content.bin', kind: 'file', hash: value.hash, bytes: value.bytes.length, mode: 0o600 }],
  }))
}

async function source(environment, owner, value = content(), options) {
  await stage(environment, owner, value, options)
  await commit(environment, owner, value)
  return value
}

function gate(environment) {
  const result = deferred()
  environment.gates.add(result)
  return result
}

function observeRequest(environment) {
  const observed = deferred()
  const listener = (incoming, response) => {
    if (!incoming.url.includes('/stream?')) return
    environment.app.server.off('request', listener)
    observed.resolve({ incoming, response })
  }
  environment.app.server.on('request', listener)
  return observed.promise
}

function rawDownload(environment, owner, value, { consume = true } = {}) {
  const response = deferred()
  const closed = deferred()
  const client = httpRequest(`${environment.origin}${ROOT}${streamPath(owner, value)}`, {
    headers: { cookie: owner.cookie }, agent: false,
  })
  environment.clients.add(client)
  client.on('error', error => closed.resolve({ error }))
  client.on('close', () => { environment.clients.delete(client); closed.resolve({}) })
  client.on('response', incoming => {
    incoming.on('error', error => closed.resolve({ error }))
    response.resolve(incoming)
    if (consume) incoming.resume()
  })
  client.end()
  return { client, response: response.promise, closed: closed.promise }
}

function instrumentReaders(environment, { beforeOpen, beforeChunk, beforeNext, syncClose = false } = {}) {
  const store = environment.app.workspaces.chunkObjects
  const original = store.openVerifiedRead.bind(store)
  const entered = deferred()
  const opened = deferred()
  const closed = deferred()
  const waiting = deferred()
  const state = { entered: entered.promise, opened: opened.promise, closed: closed.promise,
    waiting: waiting.promise, opens: 0, closes: 0, chunks: 0 }
  store.openVerifiedRead = async hash => {
    state.opens += 1
    entered.resolve()
    if (beforeOpen !== undefined) await beforeOpen.promise
    const reader = await original(hash)
    if (reader === undefined) return reader
    opened.resolve(reader)
    return {
      hash: reader.hash, totalBytes: reader.totalBytes,
      async *chunks() {
        const iterator = reader.chunks()
        try {
          for (;;) {
            if (beforeNext !== undefined) await beforeNext(state.chunks)
            const next = await iterator.next()
            if (next.done) return
            state.chunks += 1
            if (beforeChunk !== undefined) {
              waiting.resolve()
              await beforeChunk.promise
            }
            yield next.value
          }
        } finally { await iterator.return() }
      },
      close() {
        state.closes += 1
        const result = reader.close()
        if (beforeChunk !== undefined) beforeChunk.resolve()
        const completion = Promise.resolve(result).then(() => closed.resolve())
        return syncClose ? undefined : completion
      },
    }
  }
  state.restore = () => { store.openVerifiedRead = original }
  return state
}

test('validates opt-in dependencies, reader limits and deadlines before acquiring the data directory', TEST_OPTIONS, async context => {
  const environment = await fixture(context)
  await environment.stop()
  const base = { dataDir: environment.dataDir, llmMode: 'scripted' }
  for (const options of [
    { workspaceVerifiedDownloads: 'true' }, { workspaceVerifiedDownloads: true },
    { workspaceVerifiedDownloads: true, workspaceChunkObjects: false },
    ...[0, -1, 1.5, '4', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
      .map(workspaceDownloadMaxReaders => ({ workspaceDownloadMaxReaders })),
    ...[0, -1, 1.5, '30000', null, NaN, Infinity, 2_147_483_648]
      .map(workspaceDownloadTimeoutMs => ({ workspaceDownloadTimeoutMs })),
  ]) await assert.rejects(createBrowserNativeV2Server({ ...base, ...options }), /workspace/)
  await assert.rejects(readFile(join(environment.dataDir, '.browser-native-backend.lock')), { code: 'ENOENT' })
  await environment.restart()
})

test('advertises downloads only on explicit opt-in and returns an explicit legacy-file fallback', TEST_OPTIONS, async context => {
  const environment = await fixture(context, { workspaceChunkObjects: false, workspaceVerifiedDownloads: false })
  assert.equal(Object.hasOwn(await ok(request(environment, undefined, '/upload-capabilities')), 'fileDownload'), false)
  const owner = await identity(environment)
  const value = await source(environment, owner, content([Buffer.from('legacy fixed upload')]), { fixed: true })
  await rejected(request(environment, owner, streamPath(owner, value)), 404, 'NOT_FOUND')
  await environment.restart({ workspaceChunkObjects: true })
  const chunkOnly = await ok(request(environment, undefined, '/upload-capabilities'))
  assert.deepEqual(chunkOnly.fileStorage, { version: 1, kind: 'chunk-objects' })
  assert.equal(Object.hasOwn(chunkOnly, 'fileDownload'), false)
  await environment.restart({ workspaceChunkObjects: true, workspaceVerifiedDownloads: true })
  assert.deepEqual((await ok(request(environment, undefined, '/upload-capabilities'))).fileDownload,
    { version: 1, kind: 'verified-stream' })
  const fallback = environment.app.workspaces.chunkObjects.fallback
  const originalGet = fallback.get
  fallback.get = () => { throw new Error('stream must not buffer fallback') }
  try {
    await rejected(request(environment, owner, streamPath(owner, value)), 409, 'FILE_DOWNLOAD_UNSUPPORTED')
  } finally { fallback.get = originalGet }
  assert.deepEqual(await ok(request(environment, owner, `/blob/${value.hash}?${query(owner)}`)), value.bytes)
})

for (const variant of ['short-tail', 'empty', 'repeated']) {
  test(`streams ${variant} bytes with full-file headers, EOF and at most two file reads`, TEST_OPTIONS, async context => {
    const environment = await fixture(context)
    const owner = await identity(environment)
    const repeated = Buffer.alloc(32768, 0x52)
    const value = await source(environment, owner, variant === 'empty' ? content([])
      : variant === 'repeated' ? content([repeated, repeated, repeated]) : content())
    const store = environment.app.workspaces.chunkObjects
    const before = store.getMetrics().chunkReadBytes
    const state = instrumentReaders(environment, { syncClose: true })
    const result = await request(environment, owner, streamPath(owner, value))
    assert.deepEqual(await ok(result), value.bytes)
    assert.equal(result.headers.get('x-content-sha256'), value.hash)
    assert.equal(result.headers.get('x-total-bytes'), String(value.bytes.length))
    assert.equal(result.headers.get('content-length'), String(value.bytes.length))
    assert.equal(result.headers.get('x-browser-native-protocol'), '1')
    assert.equal(sha256(result.value), value.hash)
    await state.closed
    assert.equal(state.closes, 1)
    assert.equal(store.getMetrics().activeReaders, 0)
    assert.equal(store.getMetrics().chunkReadBytes - before, 2 * value.bytes.length)
  })
}

test('requires the principal and current manifest rather than uploaded or globally deduplicated hashes', TEST_OPTIONS, async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const foreign = await identity(environment)
  const value = content()
  await stage(environment, owner, value)
  const state = instrumentReaders(environment)
  await rejected(request(environment, owner, streamPath(owner, value)), 404, 'BLOB_NOT_FOUND')
  await commit(environment, owner, value)
  await rejected(request(environment, undefined, streamPath(owner, value)), 401, 'UNAUTHENTICATED')
  await rejected(request(environment, foreign, streamPath(owner, value)), 403, 'WORKSPACE_FORBIDDEN')
  await rejected(request(environment, foreign, streamPath(foreign, value)), 404, 'BLOB_NOT_FOUND')
  assert.equal(state.opens, 0)
  assert.deepEqual(await ok(request(environment, owner, streamPath(owner, value))), value.bytes)
  await commit(environment, owner, value, 1, true)
  await rejected(request(environment, owner, streamPath(owner, value)), 404, 'BLOB_NOT_FOUND')
  assert.equal(state.opens, 1)
})

test('rejects missing, unknown and duplicate query fields before opening a reader', TEST_OPTIONS, async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const value = await source(environment, owner)
  const state = instrumentReaders(environment)
  for (const parameters of ['', 'protocolVersion=1', `workspaceId=${owner.workspaceId}`,
    `protocolVersion=2&workspaceId=${owner.workspaceId}`, `${query(owner)}&unexpected=1`,
    `${query(owner)}&protocolVersion=1`, `${query(owner)}&workspaceId=${owner.workspaceId}`,
    `${query(owner)}&%77orkspaceId=${owner.workspaceId}`]) {
    await rejected(request(environment, owner, `/blob/${value.hash}/stream?${parameters}`), 400, 'PROTOCOL_UNSUPPORTED')
  }
  assert.equal(state.opens, 0)
  assert.deepEqual(await ok(request(environment, owner, streamPath(owner, value))), value.bytes)
})

for (const damage of ['missing', 'same-size', 'truncated', 'reordered-descriptor']) {
  test(`rejects ${damage} storage before headers and reads normally after repair`, TEST_OPTIONS, async context => {
    const environment = await fixture(context)
    const owner = await identity(environment)
    const value = await source(environment, owner)
    const path = damage === 'reordered-descriptor' ? descriptorPath(environment, value)
      : chunkPath(environment, value.layout.chunks[0])
    const original = await readFile(path)
    if (damage === 'missing') await rm(path)
    else if (damage === 'same-size') await writeFile(path, Buffer.alloc(original.length, 0x5a))
    else if (damage === 'truncated') await writeFile(path, original.subarray(1))
    else {
      const descriptor = JSON.parse(original)
      const chunks = [descriptor.layout.chunks[1], descriptor.layout.chunks[0], descriptor.layout.chunks[2]]
      let offset = 0
      descriptor.layout.chunks = chunks.map(chunk => {
        const result = { ...chunk, offset }
        offset += chunk.length
        return result
      })
      await writeFile(path, JSON.stringify(descriptor))
    }
    await rejected(request(environment, owner, streamPath(owner, value)), 500, 'BLOB_CORRUPT')
    assert.equal(environment.app.workspaces.chunkObjects.getMetrics().activeReaders, 0)
    await writeFile(path, original)
    assert.deepEqual(await ok(request(environment, owner, streamPath(owner, value))), value.bytes)
  })
}

test('counts pending verification toward the reader limit and closes a reader returned after inbound cancel', TEST_OPTIONS, async context => {
  const environment = await fixture(context, { workspaceDownloadMaxReaders: 1 })
  const owner = await identity(environment)
  const value = await source(environment, owner)
  const validation = gate(environment)
  const state = instrumentReaders(environment, { beforeOpen: validation })
  const observed = observeRequest(environment)
  const download = rawDownload(environment, owner, value)
  await state.entered
  const { response } = await observed
  const responseClosed = new Promise(resolveClose => response.once('close', resolveClose))
  await rejected(request(environment, owner, streamPath(owner, value)), 429, 'FILE_DOWNLOAD_BUSY')
  download.client.destroy()
  await responseClosed
  assert.equal(response.headersSent, false)
  await rejected(request(environment, owner, streamPath(owner, value)), 429, 'FILE_DOWNLOAD_BUSY')
  validation.resolve()
  await state.closed
  assert.equal(state.closes, 1)
  assert.equal(state.chunks, 0)
  assert.equal(environment.app.workspaces.chunkObjects.getMetrics().activeReaders, 0)
  assert.deepEqual(await ok(request(environment, owner, streamPath(owner, value))), value.bytes)
})

test('times out pending verification, rejects extra readers and closes the late reader without writing headers', TEST_OPTIONS, async context => {
  const environment = await fixture(context, { workspaceDownloadMaxReaders: 1, workspaceDownloadTimeoutMs: 1000 })
  const owner = await identity(environment)
  const value = await source(environment, owner)
  const validation = gate(environment)
  const state = instrumentReaders(environment, { beforeOpen: validation })
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const observed = observeRequest(environment)
  const download = rawDownload(environment, owner, value)
  await state.entered
  const { response } = await observed
  const responseClosed = new Promise(resolveClose => response.once('close', resolveClose))
  context.mock.timers.tick(999)
  assert.equal(response.destroyed, false)
  context.mock.timers.tick(1)
  await responseClosed
  assert.equal(response.headersSent, false)
  assert.equal(state.closes, 0)
  context.mock.timers.reset()
  await download.closed
  validation.resolve()
  await state.closed
  assert.equal(state.chunks, 0)
  assert.equal(environment.app.workspaces.chunkObjects.getMetrics().activeReaders, 0)
  assert.deepEqual(await ok(request(environment, owner, streamPath(owner, value))), value.bytes)
})

for (const termination of ['cancel', 'timeout', 'shutdown']) {
  test(`releases a gated slow stream on ${termination} and permits a normal read after restart`, TEST_OPTIONS, async context => {
    const environment = await fixture(context, { workspaceDownloadMaxReaders: 1, workspaceDownloadTimeoutMs: 1000 })
    const owner = await identity(environment)
    const value = await source(environment, owner)
    const hold = gate(environment)
    const state = instrumentReaders(environment, { beforeChunk: hold })
    if (termination === 'timeout') context.mock.timers.enable({ apis: ['setTimeout'] })
    const observed = observeRequest(environment)
    const download = rawDownload(environment, owner, value, { consume: false })
    const { response } = await observed
    const responseClosed = new Promise(resolveClose => response.once('close', resolveClose))
    await state.opened
    await state.waiting
    assert.equal(environment.app.workspaces.chunkObjects.getMetrics().activeReaders, 1)
    await ok(post(environment, owner, '/lease', { operation: 'claim' }))
    await rejected(request(environment, owner, streamPath(owner, value)), 429, 'FILE_DOWNLOAD_BUSY')
    let closing
    if (termination === 'cancel') download.client.destroy()
    else if (termination === 'timeout') context.mock.timers.tick(1000)
    else closing = environment.app.close()
    await state.closed
    await responseClosed
    if (termination === 'timeout') context.mock.timers.reset()
    assert.equal(state.closes, 1)
    assert.equal(environment.app.workspaces.chunkObjects.getMetrics().activeReaders, 0)
    if (closing !== undefined) {
      await closing
      environment.app = undefined
    }
    await environment.restart()
    assert.deepEqual(await ok(request(environment, owner, streamPath(owner, value))), value.bytes)
  })
}

test('protects active chunks across manifest deletion and GC without holding the Workspace lock', TEST_OPTIONS, async context => {
  let now = 1000
  const environment = await fixture(context, { testHooks: { workspaceNow: () => now } })
  const owner = await identity(environment)
  const value = await source(environment, owner)
  const hold = gate(environment)
  const state = instrumentReaders(environment, { beforeChunk: hold })
  const pending = request(environment, owner, streamPath(owner, value))
  await state.waiting
  await commit(environment, owner, value, 1, true)
  now += 86_400_001
  await environment.app.workspaces.collectGarbage(owner.workspaceId)
  await assert.rejects(readFile(descriptorPath(environment, value)), { code: 'ENOENT' })
  for (const chunk of value.layout.chunks) assert.equal((await readFile(chunkPath(environment, chunk))).length, chunk.length)
  hold.resolve()
  assert.deepEqual(await ok(pending), value.bytes)
  await state.closed
  await environment.app.workspaces.collectGarbage(owner.workspaceId)
  for (const chunk of value.layout.chunks) await assert.rejects(readFile(chunkPath(environment, chunk)), { code: 'ENOENT' })
  await rejected(request(environment, owner, streamPath(owner, value)), 404, 'BLOB_NOT_FOUND')
  state.restore()
  value.operationId = randomUUID()
  await stage(environment, owner, value)
  await commit(environment, owner, value, 2)
  assert.deepEqual(await ok(request(environment, owner, streamPath(owner, value))), value.bytes)
})

test('rejects manifest length disagreement and closes the verified reader', TEST_OPTIONS, async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const value = await source(environment, owner)
  const state = instrumentReaders(environment)
  const entry = environment.app.workspaces.workspaces.get(owner.workspaceId).entries.get('content.bin')
  entry.bytes += 1
  await rejected(request(environment, owner, streamPath(owner, value)), 500, 'BLOB_CORRUPT')
  await state.closed
  assert.equal(state.closes, 1)
  assert.equal(state.chunks, 0)
  assert.equal(environment.app.workspaces.chunkObjects.getMetrics().activeReaders, 0)
  entry.bytes -= 1
  assert.deepEqual(await ok(request(environment, owner, streamPath(owner, value))), value.bytes)
})

test('defaults to four readers and frees every reader on server close', TEST_OPTIONS, async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const value = await source(environment, owner)
  const store = environment.app.workspaces.chunkObjects
  const hold = gate(environment)
  const fourReaders = deferred()
  let waiting = 0
  const state = instrumentReaders(environment, { beforeNext: async index => {
    if (index !== 0) return
    waiting += 1
    if (waiting === 4) fourReaders.resolve()
    await hold.promise
  } })
  const original = store.openVerifiedRead.bind(store)
  store.openVerifiedRead = async hash => {
    const reader = await original(hash)
    return { ...reader, close() { hold.resolve(); return reader.close() } }
  }
  for (let index = 0; index < 4; index += 1) rawDownload(environment, owner, value)
  await fourReaders.promise
  assert.equal(store.getMetrics().activeReaders, 4)
  await rejected(request(environment, owner, streamPath(owner, value)), 429, 'FILE_DOWNLOAD_BUSY')
  await environment.app.close()
  assert.equal(state.closes, 4)
  assert.equal(store.getMetrics().activeReaders, 0)
  environment.app = undefined
  await environment.restart()
  assert.deepEqual(await ok(request(environment, owner, streamPath(owner, value))), value.bytes)
})

test('server close aborts verification immediately and retains the directory lock until its late reader is closed', TEST_OPTIONS, async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const value = await source(environment, owner)
  const validation = gate(environment)
  const state = instrumentReaders(environment, { beforeOpen: validation })
  const observed = observeRequest(environment)
  rawDownload(environment, owner, value)
  await state.entered
  const { response } = await observed
  const responseClosed = new Promise(resolveClose => response.once('close', resolveClose))
  let settled = false
  const closing = environment.app.close().then(() => { settled = true })
  await responseClosed
  assert.equal(response.headersSent, false)
  assert.equal(settled, false)
  assert.equal(state.closes, 0)
  await assert.doesNotReject(readFile(join(environment.dataDir, '.browser-native-backend.lock')))
  validation.resolve()
  await closing
  assert.equal(state.closes, 1)
  assert.equal(state.chunks, 0)
  assert.equal(environment.app.workspaces.chunkObjects.getMetrics().activeReaders, 0)
  await assert.rejects(readFile(join(environment.dataDir, '.browser-native-backend.lock')), { code: 'ENOENT' })
  environment.app = undefined
  await environment.restart()
  assert.deepEqual(await ok(request(environment, owner, streamPath(owner, value))), value.bytes)
})

test('terminates a response on chunk corruption after headers without appending a JSON error', TEST_OPTIONS, async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const value = await source(environment, owner)
  const hold = gate(environment)
  const secondRead = deferred()
  const state = instrumentReaders(environment, { beforeNext: async index => {
    if (index !== 1) return
    secondRead.resolve()
    await hold.promise
  } })
  const response = await fetch(`${environment.origin}${ROOT}${streamPath(owner, value)}`, { headers: { cookie: owner.cookie } })
  const body = response.arrayBuffer()
  const failed = assert.rejects(body)
  await secondRead.promise
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  const path = chunkPath(environment, value.layout.chunks[1])
  const original = await readFile(path)
  await writeFile(path, Buffer.alloc(original.length, 0x5a))
  hold.resolve()
  await failed
  await state.closed
  assert.equal(state.closes, 1)
  assert.equal(environment.app.workspaces.chunkObjects.getMetrics().activeReaders, 0)
  await writeFile(path, original)
  assert.deepEqual(await ok(request(environment, owner, streamPath(owner, value))), value.bytes)
})

test('waits for response drain before consuming more than one prefetched chunk', TEST_OPTIONS, async context => {
  const environment = await fixture(context)
  const owner = await identity(environment)
  const part = Buffer.alloc(32768, 0x51)
  const value = await source(environment, owner, content([part, part, part, part]))
  const secondRead = deferred()
  const state = instrumentReaders(environment, { beforeNext: async index => {
    if (index === 1) secondRead.resolve()
  } })
  const observed = observeRequest(environment)
  const pending = request(environment, owner, streamPath(owner, value))
  const { response } = await observed
  const originalWrite = response.write.bind(response)
  const firstWrite = deferred()
  let writes = 0
  response.write = (...argumentsList) => {
    writes += 1
    const writable = originalWrite(...argumentsList)
    if (writes !== 1) return writable
    assert.equal(writable, true)
    firstWrite.resolve()
    return false
  }
  await firstWrite.promise
  await secondRead.promise
  assert.equal(writes, 1)
  assert.ok(state.chunks <= 2)
  response.emit('drain')
  assert.deepEqual(await ok(pending), value.bytes)
  await state.closed
  assert.equal(state.chunks, 4)
  assert.equal(environment.app.workspaces.chunkObjects.getMetrics().activeReaders, 0)
})
