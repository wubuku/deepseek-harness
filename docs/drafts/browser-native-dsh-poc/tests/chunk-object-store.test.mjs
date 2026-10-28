import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ChunkObjectWorkspaceBlobStore } from '../chunk-object-store.mjs'
import { WorkspaceError, WorkspaceStore } from '../workspace-v2.mjs'

const MIN_CHUNK_BYTES = 32768
const MAX_CHUNK_BYTES = 1024 * 1024
const PARAMETERS = { version: 1, algorithm: 'dsh-gear-v1', minimumBytes: MIN_CHUNK_BYTES,
  averageBytes: 131072, maximumBytes: MAX_CHUNK_BYTES }

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function fileVersion(parts) {
  const bytes = Buffer.concat(parts)
  let offset = 0
  const chunks = parts.map(part => {
    const chunk = { offset, length: part.byteLength, hash: sha256(part) }
    offset += part.byteLength
    return chunk
  })
  return { bytes, hash: sha256(bytes), layout: { ...PARAMETERS, chunks } }
}

function descriptor(value) {
  return { version: 1, hash: value.hash, totalBytes: value.bytes.byteLength, layout: value.layout }
}

function rejectsCode(promise, code) {
  return assert.rejects(promise, error => error instanceof WorkspaceError && error.code === code)
}

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-chunk-object-store-'))
  context.after(async () => await rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'objects')
  const makeFallback = () => new WorkspaceStore(join(directory, 'legacy-data')).blobStore
  const fallback = makeFallback()
  const store = new ChunkObjectWorkspaceBlobStore(root, fallback)
  await store.initialize()
  return { directory, root, fallback, store,
    chunkPath: hash => join(root, 'chunks', hash.slice(0, 2), hash),
    descriptorPath: hash => join(root, 'files', `${hash}.json`),
    restart: async () => {
      const restored = new ChunkObjectWorkspaceBlobStore(root, makeFallback())
      await restored.initialize()
      return restored
    } }
}

async function upload(store, parts) {
  for (const part of parts) await store.putChunk(sha256(part), part)
  const value = fileVersion(parts)
  const result = await store.compose(value.hash, value.bytes.byteLength, value.layout)
  return { ...value, result }
}

test('compose durably publishes a descriptor without an assembled file and survives restart', async context => {
  const environment = await fixture(context)
  const parts = [Buffer.alloc(MIN_CHUNK_BYTES, 0x41), Buffer.alloc(65536, 0x42), Buffer.from('tail')]
  const value = await upload(environment.store, parts)
  const stored = await readFile(environment.descriptorPath(value.hash))
  assert.deepEqual(JSON.parse(stored), descriptor(value))
  assert.deepEqual(value.result, { chunkVerificationBytes: value.bytes.byteLength,
    descriptorWriteBytes: stored.byteLength, assembledWriteBytes: 0 })
  assert.equal(await environment.fallback.stat(value.hash), undefined)
  assert.deepEqual((await readdir(environment.root)).sort(), ['chunks', 'files'])
  assert.deepEqual(await environment.store.stat(value.hash), { size: value.bytes.byteLength })
  const restored = await environment.restart()
  assert.deepEqual(await restored.get(value.hash), value.bytes)
  assert.equal(await restored.verify(value.hash, value.bytes.byteLength), true)
  assert.equal(await restored.verify(value.hash, value.bytes.byteLength + 1), false)
  assert.deepEqual(await restored.listHashes(), [value.hash])
})

test('range reads cross repeated chunks and short tails while accounting for full-file verification', async context => {
  const { store } = await fixture(context)
  const repeated = Buffer.alloc(MIN_CHUNK_BYTES, 0x62)
  const value = await upload(store, [repeated, Buffer.alloc(49152, 0x70), repeated, Buffer.from('short-tail')])
  const ranges = [[0, 1], [MIN_CHUNK_BYTES - 7, 30], [80000, MIN_CHUNK_BYTES],
    [value.bytes.byteLength - 5, 30], [0, 0], [value.bytes.byteLength + 10, 10]]
  const before = store.getMetrics()
  for (const [offset, length] of ranges) {
    assert.deepEqual(await store.getRange(value.hash, offset, length), value.bytes.subarray(offset, offset + length))
  }
  const after = store.getMetrics()
  assert.equal(after.chunkReadBytes - before.chunkReadBytes, ranges.length * value.bytes.byteLength)
  assert.equal(after.chunkVerificationBytes - before.chunkVerificationBytes, ranges.length * value.bytes.byteLength)
  for (const [offset, length] of [[-1, 1], [0, -1], [0.5, 1], [0, Infinity], [0, 64 * 1024 * 1024 + 1], [Number.MAX_SAFE_INTEGER, 1]]) {
    await rejectsCode(store.getRange(value.hash, offset, length), 'INVALID_REQUEST')
  }
})

test('empty files publish only the SHA-256 of empty bytes with an empty layout', async context => {
  const { store, root } = await fixture(context)
  const value = await upload(store, [])
  assert.equal(value.result.chunkVerificationBytes, 0)
  assert.equal(value.result.assembledWriteBytes, 0)
  assert.deepEqual(await store.get(value.hash), Buffer.alloc(0))
  assert.deepEqual(await store.getRange(value.hash, 12, 50), Buffer.alloc(0))
  assert.equal(await store.verify(value.hash, 0), true)
  assert.deepEqual(await readdir(join(root, 'chunks')), [])
  await rejectsCode(store.compose(sha256('wrong'), 0, value.layout), 'UPLOAD_BLOB_HASH_MISMATCH')
})

test('a 64 MiB logical file reuses one immutable chunk without assembling whole-file bytes', async context => {
  const { store } = await fixture(context)
  const part = Buffer.alloc(MAX_CHUNK_BYTES, 0x71)
  const chunkHash = sha256(part)
  const digest = createHash('sha256')
  const chunks = Array.from({ length: 64 }, (_, index) => {
    digest.update(part)
    return { hash: chunkHash, offset: index * part.byteLength, length: part.byteLength }
  })
  const fullHash = digest.digest('hex')
  const totalBytes = part.byteLength * chunks.length
  await store.putChunk(chunkHash, part)
  const result = await store.compose(fullHash, totalBytes, { ...PARAMETERS, chunks })
  assert.equal(result.chunkVerificationBytes, totalBytes)
  assert.equal(result.assembledWriteBytes, 0)
  assert.deepEqual(await store.stat(fullHash), { size: totalBytes })
  assert.deepEqual(await store.getRange(fullHash, totalBytes - 2, 10), Buffer.from([0x71, 0x71]))
  assert.equal(store.getMetrics().chunkWriteBytes, part.byteLength)
  assert.equal(store.getMetrics().chunkReadBytes, totalBytes * 2)
})

test('chunk verification distinguishes missing, wrong length and same-size corrupt bytes', async context => {
  const { store, chunkPath } = await fixture(context)
  const part = Buffer.alloc(MIN_CHUNK_BYTES, 0x31)
  const hash = sha256(part)
  assert.equal(await store.verifyChunk(hash, part.byteLength), false)
  assert.deepEqual(await store.putChunk(hash, part), { writtenBytes: part.byteLength, verificationBytes: part.byteLength })
  assert.equal(await store.verifyChunk(hash, part.byteLength), true)
  await rejectsCode(store.verifyChunk(hash, part.byteLength + 1), 'BLOB_CORRUPT')
  await writeFile(chunkPath(hash), Buffer.alloc(part.byteLength, 0x32))
  await rejectsCode(store.verifyChunk(hash, part.byteLength), 'BLOB_CORRUPT')
  await rejectsCode(store.putChunk(hash, part), 'BLOB_CORRUPT')
  assert.deepEqual(await readFile(chunkPath(hash)), Buffer.alloc(part.byteLength, 0x32))
})

test('putChunk rejects invalid keys, oversized inputs and mismatched hashes before publication', async context => {
  const { store, root } = await fixture(context)
  const bytes = Buffer.from('input')
  await rejectsCode(store.putChunk(sha256(bytes).toUpperCase(), bytes), 'INVALID_REQUEST')
  await rejectsCode(store.putChunk('../escape', bytes), 'INVALID_REQUEST')
  await rejectsCode(store.putChunk(sha256(bytes), 'input'), 'INVALID_REQUEST')
  await rejectsCode(store.putChunk(sha256(bytes), Buffer.alloc(MAX_CHUNK_BYTES + 1)), 'INVALID_REQUEST')
  await rejectsCode(store.putChunk(sha256('other'), bytes), 'BLOB_CORRUPT')
  await rejectsCode(store.verifyChunk(sha256(bytes), -1), 'INVALID_REQUEST')
  assert.deepEqual(await readdir(join(root, 'chunks')), [])
})

test('putChunk owns a snapshot of queued caller bytes', async context => {
  const { store } = await fixture(context)
  const bytes = Buffer.alloc(MIN_CHUNK_BYTES, 0x61)
  const hash = sha256(bytes)
  const pending = store.putChunk(hash, bytes)
  bytes.fill(0xff)
  await pending
  assert.equal(await store.verifyChunk(hash, MIN_CHUNK_BYTES), true)
})

test('concurrent same-hash chunk and descriptor publications write each immutable object once', async context => {
  const { store, descriptorPath } = await fixture(context)
  const part = Buffer.alloc(MIN_CHUNK_BYTES, 0x41)
  const results = await Promise.all(Array.from({ length: 8 }, () => store.putChunk(sha256(part), part)))
  assert.equal(results.reduce((total, value) => total + value.writtenBytes, 0), part.byteLength)
  const value = fileVersion([part, part])
  const compositions = await Promise.all(Array.from({ length: 8 }, () => store.compose(value.hash, value.bytes.byteLength, value.layout)))
  const descriptorBytes = (await readFile(descriptorPath(value.hash))).byteLength
  assert.equal(compositions.reduce((total, result) => total + result.descriptorWriteBytes, 0), descriptorBytes)
  assert.ok(compositions.every(result => result.assembledWriteBytes === 0))
  assert.equal(store.getMetrics().chunkWrites, 1)
  assert.equal(store.getMetrics().descriptorWrites, 1)
})

test('concurrent different valid layouts preserve the first published descriptor', async context => {
  const { store, descriptorPath } = await fixture(context)
  const half = Buffer.alloc(MIN_CHUNK_BYTES, 0x43)
  const small = fileVersion([half, half])
  const large = fileVersion([Buffer.concat([half, half])])
  await store.putChunk(sha256(half), half)
  await store.putChunk(sha256(large.bytes), large.bytes)
  const results = await Promise.allSettled([
    store.compose(small.hash, small.bytes.byteLength, small.layout),
    store.compose(large.hash, large.bytes.byteLength, large.layout),
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.equal(results[1].reason.code, 'CONTENT_LAYOUT_CONFLICT')
  assert.deepEqual(JSON.parse(await readFile(descriptorPath(small.hash), 'utf8')), descriptor(small))
  assert.deepEqual(await store.get(small.hash), small.bytes)
})

test('invalid or incomplete layouts never publish descriptors', async context => {
  const { store, root } = await fixture(context)
  const value = fileVersion([Buffer.alloc(MIN_CHUNK_BYTES, 0x41), Buffer.from('tail')])
  const invalid = [
    { ...value.layout, version: 2 },
    { ...value.layout, extra: true },
    { ...value.layout, algorithm: 'unknown' },
    { ...value.layout, minimumBytes: 1 },
    { ...value.layout, chunks: value.layout.chunks.slice(0, 1) },
    { ...value.layout, chunks: [value.layout.chunks[0], { ...value.layout.chunks[1], offset: 0 }] },
    { ...value.layout, chunks: [{ ...value.layout.chunks[0], offset: 1 }, value.layout.chunks[1]] },
    { ...value.layout, chunks: [{ ...value.layout.chunks[0], length: MAX_CHUNK_BYTES + 1 }] },
    { ...value.layout, chunks: [{ ...value.layout.chunks[0], length: 0 }] },
    { ...value.layout, chunks: [{ ...value.layout.chunks[0], hash: value.layout.chunks[0].hash.toUpperCase() }] },
    { ...value.layout, chunks: [{ ...value.layout.chunks[0], extra: true }, value.layout.chunks[1]] },
    { ...value.layout, chunks: [{ ...value.layout.chunks[0], length: 1 }, { ...value.layout.chunks[1], offset: 1 }] },
    { ...value.layout, chunks: Array.from({ length: 2049 }, () => value.layout.chunks[0]) },
  ]
  for (const layout of invalid) await rejectsCode(store.compose(value.hash, value.bytes.byteLength, layout), 'CONTENT_LAYOUT_INVALID')
  for (const size of [-1, 1.2, 64 * 1024 * 1024 + 1]) {
    await rejectsCode(store.compose(value.hash, size, value.layout), 'INVALID_REQUEST')
  }
  assert.deepEqual(await readdir(join(root, 'files')), [])
})

test('missing, corrupt or wrong-order chunks prevent composition without publishing logical versions', async context => {
  const { store, descriptorPath, chunkPath } = await fixture(context)
  const first = Buffer.alloc(MIN_CHUNK_BYTES, 0x41)
  const second = Buffer.alloc(MIN_CHUNK_BYTES, 0x42)
  const value = fileVersion([first, second])
  await store.putChunk(sha256(first), first)
  await rejectsCode(store.compose(value.hash, value.bytes.byteLength, value.layout), 'BLOB_CORRUPT')
  assert.equal(await store.stat(value.hash), undefined)
  await store.putChunk(sha256(second), second)
  const wrongOrder = fileVersion([second, first])
  await rejectsCode(store.compose(value.hash, value.bytes.byteLength, wrongOrder.layout), 'UPLOAD_BLOB_HASH_MISMATCH')
  await assert.rejects(readFile(descriptorPath(value.hash)), { code: 'ENOENT' })
  await writeFile(chunkPath(sha256(first)), Buffer.alloc(first.byteLength, 0x43))
  await rejectsCode(store.compose(value.hash, value.bytes.byteLength, value.layout), 'BLOB_CORRUPT')
  assert.equal(await store.stat(value.hash), undefined)
})

test('unpublished chunks remain invisible as logical files after a durable restart', async context => {
  const { store, restart, root } = await fixture(context)
  const bytes = Buffer.alloc(MIN_CHUNK_BYTES, 0x52)
  const hash = sha256(bytes)
  await store.putChunk(hash, bytes)
  const restored = await restart()
  assert.equal(await restored.verifyChunk(hash, bytes.byteLength), true)
  assert.equal(await restored.stat(hash), undefined)
  assert.equal(await restored.verify(hash, bytes.byteLength), false)
  assert.deepEqual(await restored.listHashes(), [])
  assert.deepEqual(await readdir(join(root, 'files')), [])
})

test('published descriptors refuse missing chunks and corruption even when fallback bytes exist', async context => {
  const { store, fallback, chunkPath } = await fixture(context)
  const first = Buffer.alloc(MIN_CHUNK_BYTES, 0x41)
  const second = Buffer.alloc(MIN_CHUNK_BYTES, 0x42)
  const value = await upload(store, [first, second])
  await fallback.put(value.hash, value.bytes)
  await rm(chunkPath(sha256(second)))
  await rejectsCode(store.get(value.hash), 'BLOB_CORRUPT')
  await rejectsCode(store.verify(value.hash, value.bytes.byteLength), 'BLOB_CORRUPT')
  await rejectsCode(store.getRange(value.hash, 0, 1), 'BLOB_CORRUPT')
  await rejectsCode(store.getRange(value.hash, 0, 0), 'BLOB_CORRUPT')
})

test('structurally valid descriptor reorder is rejected for full reads, ranges and GC', async context => {
  const { store, fallback, descriptorPath } = await fixture(context)
  const first = Buffer.alloc(MIN_CHUNK_BYTES, 0x41)
  const second = Buffer.alloc(MIN_CHUNK_BYTES, 0x42)
  const value = await upload(store, [first, second])
  await fallback.put(value.hash, value.bytes)
  const damaged = { ...descriptor(value), layout: fileVersion([second, first]).layout }
  await writeFile(descriptorPath(value.hash), JSON.stringify(damaged))
  const orphan = Buffer.from('orphan')
  await store.putChunk(sha256(orphan), orphan)
  await rejectsCode(store.get(value.hash), 'BLOB_CORRUPT')
  await rejectsCode(store.verify(value.hash, value.bytes.byteLength), 'BLOB_CORRUPT')
  await rejectsCode(store.getRange(value.hash, 0, 1), 'BLOB_CORRUPT')
  const collected = await store.collectChunks([])
  assert.equal(typeof collected.skipped, 'string')
  assert.equal(collected.removedChunks, 0)
  assert.equal(await store.verifyChunk(sha256(orphan), orphan.byteLength), true)
})

test('malformed descriptors fail closed rather than exposing a legacy fallback', async context => {
  const cases = [
    bytes => bytes.subarray(0, bytes.byteLength - 1),
    bytes => Buffer.from(JSON.stringify({ ...JSON.parse(bytes), version: 2 })),
    bytes => Buffer.from(JSON.stringify({ ...JSON.parse(bytes), totalBytes: 64 * 1024 * 1024 + 1 })),
    bytes => Buffer.from(JSON.stringify({ ...JSON.parse(bytes), hash: sha256('wrong') })),
    bytes => Buffer.from(JSON.stringify({ ...JSON.parse(bytes), layout: { ...PARAMETERS, chunks: [] } })),
    bytes => Buffer.from(JSON.stringify({ ...JSON.parse(bytes), unknown: true })),
    () => Buffer.alloc(512 * 1024 + 1),
  ]
  for (const [index, damage] of cases.entries()) {
    await context.test(`descriptor corruption case ${String(index)}`, async child => {
      const { store, fallback, descriptorPath } = await fixture(child)
      const value = await upload(store, [Buffer.alloc(MIN_CHUNK_BYTES, 0x61)])
      await fallback.put(value.hash, value.bytes)
      const corrupted = damage(await readFile(descriptorPath(value.hash)))
      await writeFile(descriptorPath(value.hash), corrupted)
      await rejectsCode(store.stat(value.hash), 'BLOB_CORRUPT')
      await rejectsCode(store.get(value.hash), 'BLOB_CORRUPT')
      await rejectsCode(store.getRange(value.hash, 0, 2), 'BLOB_CORRUPT')
      await rejectsCode(store.verify(value.hash, value.bytes.byteLength), 'BLOB_CORRUPT')
      await rejectsCode(store.listHashes(), 'BLOB_CORRUPT')
      await rejectsCode(store.delete(value.hash), 'BLOB_CORRUPT')
      const result = await store.collectChunks([])
      assert.equal(typeof result.skipped, 'string')
      assert.equal(result.removedChunks, 0)
      assert.deepEqual(await readFile(descriptorPath(value.hash)), corrupted)
    })
  }
})

test('GC retains descriptor, duplicate and pending roots while reclaiming only unreferenced chunks', async context => {
  const { store, chunkPath, restart } = await fixture(context)
  const shared = Buffer.alloc(MIN_CHUNK_BYTES, 0x31)
  const first = await upload(store, [shared, Buffer.from('one')])
  const second = await upload(store, [shared, shared, Buffer.from('two')])
  const pending = Buffer.from('pending-durable-upload')
  const orphan = Buffer.from('unpublished-orphan')
  await store.putChunk(sha256(pending), pending)
  await store.putChunk(sha256(orphan), orphan)
  const restored = await restart()
  const roots = Object.freeze([Object.freeze({ hash: sha256(pending), length: pending.byteLength })])
  const firstCollection = await restored.collectChunks(roots)
  assert.equal(firstCollection.skipped, undefined)
  assert.equal(firstCollection.descriptorRoots, 2)
  assert.equal(firstCollection.retainedChunks, 4)
  assert.equal(firstCollection.removedChunks, 1)
  assert.equal(firstCollection.removedBytes, orphan.byteLength)
  await restored.delete(first.hash)
  const secondCollection = await restored.collectChunks(roots)
  assert.equal(secondCollection.removedChunks, 1)
  assert.equal(secondCollection.removedBytes, Buffer.byteLength('one'))
  assert.deepEqual(await restored.get(second.hash), second.bytes)
  assert.equal(await restored.verifyChunk(sha256(shared), shared.byteLength), true)
  await restored.delete(second.hash)
  const finalCollection = await restored.collectChunks(roots)
  assert.equal(finalCollection.removedChunks, 2)
  assert.equal(finalCollection.retainedChunks, 1)
  assert.equal(await restored.verifyChunk(sha256(pending), pending.byteLength), true)
  const releasePending = await restored.collectChunks([])
  assert.equal(releasePending.removedChunks, 1)
  assert.equal(releasePending.removedBytes, pending.byteLength)
  await assert.rejects(readFile(chunkPath(sha256(shared))), { code: 'ENOENT' })
})

test('missing or corrupt pending roots stop the entire sweep before deleting any candidate', async context => {
  const { store, chunkPath } = await fixture(context)
  const root = Buffer.from('pending')
  const orphan = Buffer.from('orphan')
  await store.putChunk(sha256(orphan), orphan)
  let result = await store.collectChunks([{ hash: sha256(root), length: root.byteLength }])
  assert.equal(typeof result.skipped, 'string')
  assert.equal(result.removedBytes, 0)
  assert.equal(await store.verifyChunk(sha256(orphan), orphan.byteLength), true)
  await store.putChunk(sha256(root), root)
  await writeFile(chunkPath(sha256(root)), Buffer.from('corrupt'))
  result = await store.collectChunks([{ hash: sha256(root), length: root.byteLength }])
  assert.equal(typeof result.skipped, 'string')
  assert.equal(result.removedChunks, 0)
  assert.equal(await store.verifyChunk(sha256(orphan), orphan.byteLength), true)
})

test('conflicting or malformed pending roots skip sweeping without mutating the root list', async context => {
  const { store } = await fixture(context)
  const bytes = Buffer.from('pending')
  const hash = sha256(bytes)
  await store.putChunk(hash, bytes)
  for (const roots of [undefined, [{ hash, length: bytes.byteLength, extra: true }],
    [{ hash, length: 0 }], [{ hash, length: bytes.byteLength }, { hash, length: bytes.byteLength + 1 }]]) {
    const result = await store.collectChunks(roots)
    assert.equal(typeof result.skipped, 'string')
    assert.equal(result.removedChunks, 0)
    assert.equal(await store.verifyChunk(hash, bytes.byteLength), true)
  }
})

test('unknown descriptor objects block all sweeping and remain untouched', async context => {
  const { store, root } = await fixture(context)
  const orphan = Buffer.from('orphan')
  await store.putChunk(sha256(orphan), orphan)
  const unknown = join(root, 'files', 'next-version.record')
  await writeFile(unknown, 'unrecognized descriptor')
  const collected = await store.collectChunks([])
  assert.equal(typeof collected.skipped, 'string')
  assert.equal(collected.removedChunks, 0)
  assert.equal(collected.preservedUnknownObjects, 1)
  assert.equal(await readFile(unknown, 'utf8'), 'unrecognized descriptor')
  assert.equal(await store.verifyChunk(sha256(orphan), orphan.byteLength), true)
})

test('GC preserves unfamiliar, oversized and corrupt chunk objects', async context => {
  const { store, root, chunkPath } = await fixture(context)
  const orphan = Buffer.from('orphan')
  const corruptKey = sha256('original')
  const oversizedKey = sha256('oversized')
  await store.putChunk(sha256(orphan), orphan)
  for (const hash of [corruptKey, oversizedKey]) await mkdir(join(root, 'chunks', hash.slice(0, 2)), { recursive: true })
  await writeFile(chunkPath(corruptKey), 'different')
  await writeFile(chunkPath(oversizedKey), Buffer.alloc(MAX_CHUNK_BYTES + 1))
  await writeFile(join(root, 'chunks', 'unknown-format'), 'keep')
  const result = await store.collectChunks([])
  assert.equal(result.skipped, undefined)
  assert.equal(result.removedChunks, 1)
  assert.equal(result.removedBytes, orphan.byteLength)
  assert.equal(result.preservedUnknownObjects, 3)
  assert.equal(await readFile(chunkPath(corruptKey), 'utf8'), 'different')
  assert.equal((await lstat(chunkPath(oversizedKey))).size, MAX_CHUNK_BYTES + 1)
  assert.equal(await readFile(join(root, 'chunks', 'unknown-format'), 'utf8'), 'keep')
})

test('descriptor symlinks are rejected and never removed by collection', { skip: process.platform === 'win32' ? 'symlink creation requires Windows privileges' : false }, async context => {
  const { store, directory, descriptorPath } = await fixture(context)
  const value = fileVersion([Buffer.from('external')])
  const target = join(directory, 'external-metadata')
  await writeFile(target, JSON.stringify(descriptor(value)))
  await symlink(target, descriptorPath(value.hash))
  await rejectsCode(store.stat(value.hash), 'BLOB_CORRUPT')
  const result = await store.collectChunks([])
  assert.equal(typeof result.skipped, 'string')
  assert.equal((await lstat(descriptorPath(value.hash))).isSymbolicLink(), true)
  assert.equal(JSON.parse(await readFile(target, 'utf8')).hash, value.hash)
})

test('default writes and putFile preserve real legacy blobs and logical deletion removes both formats', async context => {
  const { store, fallback, directory, descriptorPath } = await fixture(context)
  const bytes = Buffer.from('legacy fixed blob')
  const hash = sha256(bytes)
  assert.deepEqual(await store.put(hash, bytes), { reused: false })
  assert.deepEqual(await fallback.get(hash), bytes)
  await assert.rejects(readFile(descriptorPath(hash)), { code: 'ENOENT' })
  assert.deepEqual(await store.get(hash), bytes)
  assert.equal(await store.verify(hash, bytes.byteLength), true)
  assert.deepEqual(await store.getRange(hash, 2, 6), bytes.subarray(2, 8))
  const stagedBytes = Buffer.from('staged legacy blob')
  const stagedHash = sha256(stagedBytes)
  const source = join(directory, 'verified.upload')
  await writeFile(source, stagedBytes)
  assert.deepEqual(await store.putFile(stagedHash, source, stagedBytes.byteLength), { reused: false })
  assert.deepEqual(await fallback.get(stagedHash), stagedBytes)
  await store.putChunk(hash, bytes)
  const layout = fileVersion([bytes]).layout
  await store.compose(hash, bytes.byteLength, layout)
  assert.deepEqual(await store.put(hash, bytes), { reused: true })
  assert.deepEqual(await store.putFile(hash, 'unused-verified-source', bytes.byteLength), { reused: true })
  assert.deepEqual(await store.listHashes(), [hash, stagedHash].sort())
  await store.delete(hash)
  assert.equal(await fallback.stat(hash), undefined)
  assert.equal(await store.stat(hash), undefined)
  assert.equal(await store.verifyChunk(hash, bytes.byteLength), true)
  await store.delete(hash)
  assert.deepEqual(await store.listHashes(), [stagedHash])
})

test('cumulative I/O snapshots count physical chunk and descriptor bytes and exclude fallback traffic', async context => {
  const { store, descriptorPath } = await fixture(context)
  const part = Buffer.alloc(MIN_CHUNK_BYTES, 0x64)
  const value = fileVersion([part, part])
  const baseline = store.getMetrics()
  assert.ok(Object.values(baseline).every(value => typeof value === 'number' && value === 0))
  await store.putChunk(sha256(part), part)
  await store.putChunk(sha256(part), part)
  await store.compose(value.hash, value.bytes.byteLength, value.layout)
  const descriptorBytes = (await readFile(descriptorPath(value.hash))).byteLength
  const beforeRange = store.getMetrics()
  assert.equal(beforeRange.chunkWriteBytes, part.byteLength)
  assert.equal(beforeRange.chunkInputVerificationBytes, part.byteLength * 2)
  assert.equal(beforeRange.chunkReadBytes, part.byteLength * 3)
  assert.equal(beforeRange.chunkVerificationBytes, part.byteLength * 3)
  assert.equal(beforeRange.fileVerificationBytes, part.byteLength * 2)
  assert.equal(beforeRange.descriptorWriteBytes, descriptorBytes)
  assert.equal(beforeRange.descriptorReadBytes, 0)
  await store.getRange(value.hash, 1, 2)
  await store.verify(value.hash, value.bytes.byteLength)
  await store.get(value.hash)
  const after = store.getMetrics()
  assert.equal(after.chunkReadBytes, beforeRange.chunkReadBytes + value.bytes.byteLength * 3)
  assert.equal(after.chunkVerificationBytes, after.chunkReadBytes)
  assert.equal(after.descriptorReadBytes, descriptorBytes * 3)
  assert.equal(after.assembledWriteBytes, 0)
  const legacy = Buffer.from('legacy not included in chunk I/O')
  await store.put(sha256(legacy), legacy)
  await store.get(sha256(legacy))
  assert.deepEqual(store.getMetrics(), after)
  after.chunkWriteBytes = -1
  assert.equal(store.getMetrics().chunkWriteBytes, part.byteLength)
  assert.ok(Object.values(baseline).every(value => value === 0))
})
