/** Immutable chunks and atomic file descriptors, with legacy whole-blob fallback. */
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WorkspaceError } from './workspace-v2.mjs'

const HASH_PATTERN = /^[a-f0-9]{64}$/
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_CHUNK_BYTES = 1024 * 1024
const MIN_CHUNK_BYTES = 32768
const MAX_CHUNKS = 2048
const MAX_DESCRIPTOR_BYTES = 512 * 1024
const LAYOUT_PARAMETERS = { version: 1, algorithm: 'dsh-gear-v1', minimumBytes: MIN_CHUNK_BYTES,
  averageBytes: 131072, maximumBytes: MAX_CHUNK_BYTES }

function corrupt(message) {
  return new WorkspaceError('BLOB_CORRUPT', message, 500)
}

function assertHash(hash) {
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
    throw new WorkspaceError('INVALID_REQUEST', 'blob hash must be lowercase SHA-256')
  }
}

function assertSize(size, maximum, label) {
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) {
    throw new WorkspaceError('INVALID_REQUEST', `${label} must be an integer between 0 and ${String(maximum)}`)
  }
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function recordWithKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function normalizeLayout(layout, totalBytes) {
  const fields = [...Object.keys(LAYOUT_PARAMETERS), 'chunks']
  if (!recordWithKeys(layout, fields)
    || Object.entries(LAYOUT_PARAMETERS).some(([key, value]) => layout[key] !== value)) {
    throw new WorkspaceError('CONTENT_LAYOUT_INVALID', 'layout version, parameters or fields are unsupported')
  }
  if (!Array.isArray(layout.chunks) || layout.chunks.length > MAX_CHUNKS) {
    throw new WorkspaceError('CONTENT_LAYOUT_INVALID', 'layout must have at most 2048 chunks')
  }
  let offset = 0
  const chunks = layout.chunks.map((chunk, index) => {
    if (!recordWithKeys(chunk, ['offset', 'length', 'hash'])
      || !Number.isSafeInteger(chunk.offset) || chunk.offset !== offset
      || !Number.isSafeInteger(chunk.length) || chunk.length < 1 || chunk.length > MAX_CHUNK_BYTES
      || index < layout.chunks.length - 1 && chunk.length < MIN_CHUNK_BYTES
      || typeof chunk.hash !== 'string' || !HASH_PATTERN.test(chunk.hash)
      || offset + chunk.length > totalBytes) {
      throw new WorkspaceError('CONTENT_LAYOUT_INVALID', 'layout must contain contiguous bounded SHA-256 ranges')
    }
    offset += chunk.length
    return { offset: chunk.offset, length: chunk.length, hash: chunk.hash }
  })
  if (offset !== totalBytes) throw new WorkspaceError('CONTENT_LAYOUT_INVALID', 'layout must cover the whole file')
  return { ...LAYOUT_PARAMETERS, chunks }
}

/**
 * Single-process storage for immutable chunks and version-1 file descriptors.
 * One instance owns a root. Mutations are queued within that instance; the caller
 * holds its global lifecycle lock across uploads, durable pending roots, reads,
 * deletion and GC. The queue does not coordinate other instances or processes.
 * Published descriptors take precedence over fallback blobs; invalid descriptors
 * never fall back silently. Chunk collection never removes file descriptors.
 */
export class ChunkObjectWorkspaceBlobStore {
  /**
   * @param {string} root - Private directory containing chunks/ and files/.
   * @param {object} fallback - Existing FileWorkspaceBlobStore-compatible store.
   */
  constructor(root, fallback) {
    this.root = root
    this.fallback = fallback
    this.chunksDir = join(root, 'chunks')
    this.filesDir = join(root, 'files')
    this.mutationQueue = Promise.resolve()
    this.metrics = { chunkWriteBytes: 0, chunkReadBytes: 0, chunkVerificationBytes: 0,
      chunkInputVerificationBytes: 0, fileVerificationBytes: 0, descriptorWriteBytes: 0,
      descriptorReadBytes: 0, chunkWrites: 0, descriptorWrites: 0, removedChunkBytes: 0,
      removedChunks: 0, assembledWriteBytes: 0 }
  }

  /** Create directories and initialize the fallback before accepting operations. */
  async initialize() {
    await this.#exclusive(async () => {
      await this.fallback.initialize()
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      await mkdir(this.chunksDir, { recursive: true, mode: 0o700 })
      await mkdir(this.filesDir, { recursive: true, mode: 0o700 })
      await this.#syncDirectory(this.root)
      await this.#syncDirectory(dirname(this.root))
    })
  }

  /**
   * Return logical file size, without reading its chunks, or undefined if absent.
   * @param {string} hash - Full-file SHA-256.
   * @returns {Promise<{size: number}|undefined>} Descriptor or fallback size.
   */
  async stat(hash) {
    assertHash(hash)
    const descriptor = await this.#readDescriptor(hash)
    return descriptor === undefined ? await this.fallback.stat(hash) : { size: descriptor.totalBytes }
  }

  /**
   * Read descriptor-backed bytes and verify every chunk and the full-file hash.
   * @param {string} hash - Full-file SHA-256.
   * @returns {Promise<Buffer>} Complete bytes; absent descriptors use fallback.get.
   */
  async get(hash) {
    assertHash(hash)
    const descriptor = await this.#readDescriptor(hash)
    if (descriptor === undefined) return await this.fallback.get(hash)
    const output = Buffer.alloc(descriptor.totalBytes)
    await this.#verifyDescriptor(descriptor, (bytes, offset) => bytes.copy(output, offset))
    return output
  }

  /**
   * Verify descriptor content; missing logical files or differing sizes return false.
   * Missing/corrupt chunks referenced by a published descriptor throw BLOB_CORRUPT.
   * @param {string} hash - Full-file SHA-256.
   * @param {number} expectedBytes - Expected logical byte length.
   * @returns {Promise<boolean>} Whether the complete file matches.
   */
  async verify(hash, expectedBytes) {
    assertHash(hash)
    assertSize(expectedBytes, MAX_FILE_BYTES, 'file size')
    const descriptor = await this.#readDescriptor(hash)
    if (descriptor === undefined) return await this.fallback.verify(hash, expectedBytes)
    if (descriptor.totalBytes !== expectedBytes) return false
    await this.#verifyDescriptor(descriptor)
    return true
  }

  /**
   * Read a bounded range while verifying every chunk and the full-file hash. Even
   * an empty range reads/verifies the entire descriptor-backed file, rejecting a
   * structurally valid reordered descriptor. This costs totalBytes disk reads.
   * Ranges extending past EOF are shortened; zero-length and past-EOF reads are empty.
   * @param {string} hash - Full-file SHA-256.
   * @param {number} offset - Nonnegative safe-integer byte offset.
   * @param {number} length - Nonnegative safe-integer byte count.
   * @returns {Promise<Buffer>} Requested bytes, or fallback range behavior if absent.
   */
  async getRange(hash, offset, length) {
    assertHash(hash)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0
      || length > MAX_FILE_BYTES || !Number.isSafeInteger(offset + length)) {
      throw new WorkspaceError('INVALID_REQUEST', 'range must use nonnegative safe integers and at most 64 MiB')
    }
    const descriptor = await this.#readDescriptor(hash)
    if (descriptor === undefined) return await this.fallback.getRange(hash, offset, length)
    const end = Math.min(descriptor.totalBytes, offset + length)
    const output = Buffer.alloc(Math.max(0, end - offset))
    await this.#verifyDescriptor(descriptor, (bytes, chunkOffset) => {
      if (chunkOffset >= end || chunkOffset + bytes.byteLength <= offset) return
      const startInChunk = Math.max(offset - chunkOffset, 0)
      const endInChunk = Math.min(end - chunkOffset, bytes.byteLength)
      bytes.copy(output, Math.max(chunkOffset - offset, 0), startInChunk, endInChunk)
    })
    return output
  }

  /**
   * Default fixed writes use fallback; an existing descriptor is verified and reused.
   * @param {string} hash - Full-file SHA-256.
   * @param {Uint8Array} bytes - Complete verified bytes, at most 64 MiB.
   * @returns {Promise<{reused: boolean}>} Whether content already existed.
   */
  async put(hash, bytes) {
    assertHash(hash)
    if (!(bytes instanceof Uint8Array)) throw new WorkspaceError('INVALID_REQUEST', 'blob bytes must be Uint8Array')
    assertSize(bytes.byteLength, MAX_FILE_BYTES, 'file size')
    const snapshot = Buffer.from(bytes)
    if (hashBytes(snapshot) !== hash) throw new WorkspaceError('BLOB_CORRUPT', 'blob bytes do not match SHA-256', 400)
    return await this.#exclusive(async () => {
      const descriptor = await this.#readDescriptor(hash)
      if (descriptor === undefined) return await this.fallback.put(hash, snapshot)
      if (descriptor.totalBytes !== snapshot.byteLength) throw corrupt('stored file size differs from uploaded bytes')
      await this.#verifyDescriptor(descriptor)
      return { reused: true }
    })
  }

  /**
   * Delegate verified staged files to fallback unless a valid descriptor exists.
   * The caller has already checked source bytes/size/hash, as for FileWorkspaceBlobStore.
   * @param {string} hash - Full-file SHA-256.
   * @param {string} sourcePath - Caller-owned verified staged file.
   * @param {number} byteLength - Verified length, at most 64 MiB.
   * @returns {Promise<{reused: boolean}>} Whether existing content was reused.
   */
  async putFile(hash, sourcePath, byteLength) {
    assertHash(hash)
    assertSize(byteLength, MAX_FILE_BYTES, 'file size')
    return await this.#exclusive(async () => {
      const descriptor = await this.#readDescriptor(hash)
      if (descriptor === undefined) return await this.fallback.putFile(hash, sourcePath, byteLength)
      if (descriptor.totalBytes !== byteLength) throw corrupt('stored file size differs from staged file')
      await this.#verifyDescriptor(descriptor)
      return { reused: true }
    })
  }

  /**
   * List unique logical hashes from valid published descriptors and legacy blobs.
   * @returns {Promise<string[]>} Canonical full-file hashes; malformed named descriptors throw.
   */
  async listHashes() {
    const hashes = new Set(await this.fallback.listHashes())
    for (const entry of await readdir(this.filesDir, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
      const hash = entry.name.slice(0, -5)
      await this.#readDescriptor(hash)
      hashes.add(hash)
    }
    return [...hashes].sort()
  }

  /**
   * Remove both representations of a logical file; retain chunks until collectChunks.
   * Invalid descriptors are preserved and reported instead of deleted.
   * @param {string} hash - Full-file SHA-256.
   * @returns {Promise<void>} Resolves after descriptor deletion and directory fsync.
   */
  async delete(hash) {
    assertHash(hash)
    await this.#exclusive(async () => {
      const descriptor = await this.#readDescriptor(hash)
      await this.fallback.delete(hash)
      if (descriptor !== undefined) {
        await unlink(this.#descriptorPath(hash))
        await this.#syncDirectory(this.filesDir)
      }
    })
  }

  /**
   * Verify and durably publish one immutable chunk without replacing existing bytes.
   * @param {string} hash - Chunk SHA-256.
   * @param {Uint8Array} bytes - Chunk bytes, at most 1 MiB; empty chunks cannot appear in layouts.
   * @returns {Promise<{writtenBytes: number, verificationBytes: number}>} Actual writes and
   * bytes hashed, including input bytes and any existing object verification read.
   */
  async putChunk(hash, bytes) {
    assertHash(hash)
    if (!(bytes instanceof Uint8Array)) throw new WorkspaceError('INVALID_REQUEST', 'chunk bytes must be Uint8Array')
    assertSize(bytes.byteLength, MAX_CHUNK_BYTES, 'chunk size')
    const snapshot = Buffer.from(bytes)
    this.metrics.chunkInputVerificationBytes += snapshot.byteLength
    if (hashBytes(snapshot) !== hash) throw new WorkspaceError('BLOB_CORRUPT', 'chunk bytes do not match SHA-256', 400)
    return await this.#exclusive(async () => {
      const existing = await this.#readChunk(hash, snapshot.byteLength)
      if (existing !== undefined) return { writtenBytes: 0, verificationBytes: snapshot.byteLength + existing.byteLength }
      await this.#publish(this.#chunkPath(hash), snapshot, 'chunkWriteBytes')
      this.metrics.chunkWrites += 1
      return { writtenBytes: snapshot.byteLength, verificationBytes: snapshot.byteLength }
    })
  }

  /**
   * Verify stored chunk bytes/size/hash; absent returns false, corruption throws BLOB_CORRUPT.
   * @param {string} hash - Chunk SHA-256.
   * @param {number} length - Expected byte length, at most 1 MiB.
   * @returns {Promise<boolean>} Whether a complete matching object is present.
   */
  async verifyChunk(hash, length) {
    assertHash(hash)
    assertSize(length, MAX_CHUNK_BYTES, 'chunk size')
    return await this.#readChunk(hash, length) !== undefined
  }

  /**
   * Verify chunks and full-file SHA-256, then atomically publish a version-1 descriptor.
   * No whole-file staging/assembly is written. Missing/corrupt bytes do not publish;
   * an existing different valid layout raises CONTENT_LAYOUT_CONFLICT and is preserved.
   * @param {string} hash - Full-file SHA-256.
   * @param {number} totalBytes - Logical file length, at most 64 MiB.
   * @param {object} layout - Version-1 dsh-gear-v1 parameters and contiguous chunks.
   * @returns {Promise<{chunkVerificationBytes: number, descriptorWriteBytes: number, assembledWriteBytes: 0}>}
   * Disk bytes verified and descriptor bytes actually written by this call.
   */
  async compose(hash, totalBytes, layout) {
    assertHash(hash)
    assertSize(totalBytes, MAX_FILE_BYTES, 'file size')
    const descriptor = { version: 1, hash, totalBytes, layout: normalizeLayout(layout, totalBytes) }
    return await this.#exclusive(async () => {
      const existing = await this.#readDescriptor(hash)
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(descriptor)) {
        throw new WorkspaceError('CONTENT_LAYOUT_CONFLICT', 'existing file descriptor uses a different layout', 409)
      }
      await this.#verifyDescriptor(descriptor, undefined, 'UPLOAD_BLOB_HASH_MISMATCH')
      const bytes = Buffer.from(JSON.stringify(descriptor))
      if (existing === undefined) {
        await this.#publish(this.#descriptorPath(hash), bytes, 'descriptorWriteBytes')
        this.metrics.descriptorWrites += 1
      }
      return { chunkVerificationBytes: totalBytes, descriptorWriteBytes: existing === undefined ? bytes.byteLength : 0,
        assembledWriteBytes: 0 }
    })
  }

  /**
   * Mark all published file descriptors and caller-supplied durable pending roots,
   * then remove only unreferenced canonical chunks. Caller holds its global lifecycle
   * lock throughout. Unknown/invalid descriptors, conflicting root lengths, or missing
   * and corrupt root chunks skip the entire sweep. Unknown objects are never deleted.
   * @param {ReadonlyArray<{hash: string, length: number}>} extraRoots - Pending upload roots.
   * @returns {Promise<object>} Object/byte counts and optional skipped reason; a skipped
   * result always has removedChunks=0 and removedBytes=0.
   */
  async collectChunks(extraRoots) {
    return await this.#exclusive(async () => {
      const result = { scannedChunks: 0, retainedChunks: 0, retainedBytes: 0,
        removedChunks: 0, removedBytes: 0, preservedUnknownObjects: 0, descriptorRoots: 0 }
      const roots = new Map()
      const addRoot = root => {
        if (!recordWithKeys(root, ['hash', 'length']) || typeof root.hash !== 'string' || !HASH_PATTERN.test(root.hash)
          || !Number.isSafeInteger(root.length) || root.length < 1 || root.length > MAX_CHUNK_BYTES
          || roots.has(root.hash) && roots.get(root.hash) !== root.length) throw corrupt('invalid or conflicting chunk GC root')
        roots.set(root.hash, root.length)
      }
      try {
        if (!Array.isArray(extraRoots)) throw corrupt('chunk GC roots must be an array')
        for (const root of extraRoots) addRoot(root)
        for (const entry of await readdir(this.filesDir, { withFileTypes: true })) {
          if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
            result.preservedUnknownObjects += 1
            throw corrupt('unknown file descriptor prevents chunk collection')
          }
          const descriptor = await this.#readDescriptor(entry.name.slice(0, -5))
          if (descriptor === undefined) throw corrupt('file descriptor disappeared during chunk collection')
          for (const chunk of descriptor.layout.chunks) addRoot({ hash: chunk.hash, length: chunk.length })
          await this.#verifyDescriptor(descriptor)
          result.descriptorRoots += 1
        }
        for (const [hash, length] of roots) {
          if (!await this.verifyChunk(hash, length)) throw corrupt('root chunk is missing during chunk collection')
        }
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error
        return { ...result, skipped: error.message }
      }
      const candidates = []
      for (const prefix of await readdir(this.chunksDir, { withFileTypes: true })) {
        if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) {
          result.preservedUnknownObjects += 1
          continue
        }
        for (const entry of await readdir(join(this.chunksDir, prefix.name), { withFileTypes: true })) {
          if (!entry.isFile() || !HASH_PATTERN.test(entry.name) || !entry.name.startsWith(prefix.name)) {
            result.preservedUnknownObjects += 1
            continue
          }
          result.scannedChunks += 1
          const path = this.#chunkPath(entry.name)
          const info = await lstat(path)
          if (!info.isFile() || info.size > MAX_CHUNK_BYTES) {
            result.preservedUnknownObjects += 1
            continue
          }
          if (roots.has(entry.name)) {
            result.retainedChunks += 1
            result.retainedBytes += info.size
          } else {
            try { await this.#readChunk(entry.name, info.size) } catch (error) {
              if (!(error instanceof WorkspaceError)) throw error
              result.preservedUnknownObjects += 1
              continue
            }
            candidates.push({ path, size: info.size })
          }
        }
      }
      for (const { path, size } of candidates) {
        await unlink(path)
        await this.#syncDirectory(dirname(path))
        result.removedChunks += 1
        result.removedBytes += size
        this.metrics.removedChunks += 1
        this.metrics.removedChunkBytes += size
      }
      return result
    })
  }

  /**
   * Return a detached cumulative counter snapshot; fallback I/O and filesystem metadata
   * I/O are excluded. chunkReadBytes includes chunkVerificationBytes; input verification
   * and full-file hash work are separate, nonadditive counters, not extra disk reads.
   * @returns {object} Numeric byte/object counters since construction, including failed calls.
   */
  getMetrics() {
    return { ...this.metrics }
  }

  #chunkPath(hash) {
    return join(this.chunksDir, hash.slice(0, 2), hash)
  }

  #descriptorPath(hash) {
    return join(this.filesDir, `${hash}.json`)
  }

  async #exclusive(operation) {
    const previous = this.mutationQueue
    let release
    this.mutationQueue = new Promise(resolve => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }

  async #syncDirectory(path) {
    const directory = await open(path, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }

  async #publish(path, bytes, metric) {
    const parent = dirname(path)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    await this.#syncDirectory(dirname(parent))
    const temporary = join(parent, `${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try {
        let offset = 0
        while (offset < bytes.byteLength) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset)
          if (bytesWritten === 0) throw new Error('object write made no progress')
          this.metrics[metric] += bytesWritten
          offset += bytesWritten
        }
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, path)
      await this.#syncDirectory(parent)
    } finally {
      try { await unlink(temporary) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
  }

  async #readBounded(path, maximum, metric) {
    let info
    try { info = await lstat(path) } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
    if (!info.isFile() || info.size > maximum) throw corrupt('stored object is not a bounded regular file')
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const bytes = Buffer.alloc(Math.min(info.size + 1, maximum + 1))
      let offset = 0
      while (offset < bytes.byteLength) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
        this.metrics[metric] += bytesRead
        if (bytesRead === 0) break
        offset += bytesRead
      }
      if (offset !== info.size) throw corrupt('stored object size changed while reading')
      return bytes.subarray(0, offset)
    } finally {
      await handle.close()
    }
  }

  async #readDescriptor(hash) {
    const bytes = await this.#readBounded(this.#descriptorPath(hash), MAX_DESCRIPTOR_BYTES, 'descriptorReadBytes')
    if (bytes === undefined) return undefined
    try {
      const value = JSON.parse(bytes.toString('utf8'))
      if (!recordWithKeys(value, ['version', 'hash', 'totalBytes', 'layout']) || value.version !== 1 || value.hash !== hash) {
        throw corrupt('stored file descriptor fields, version or full hash are invalid')
      }
      assertSize(value.totalBytes, MAX_FILE_BYTES, 'file size')
      return { version: 1, hash, totalBytes: value.totalBytes, layout: normalizeLayout(value.layout, value.totalBytes) }
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof WorkspaceError) throw corrupt('stored file descriptor is invalid')
      throw error
    }
  }

  async #readChunk(hash, length) {
    const bytes = await this.#readBounded(this.#chunkPath(hash), MAX_CHUNK_BYTES, 'chunkReadBytes')
    if (bytes === undefined) return undefined
    if (bytes.byteLength !== length) throw corrupt('stored chunk length does not match its reference')
    this.metrics.chunkVerificationBytes += bytes.byteLength
    if (hashBytes(bytes) !== hash) throw corrupt('stored chunk SHA-256 does not match its key')
    return bytes
  }

  async #requireChunk(chunk) {
    const bytes = await this.#readChunk(chunk.hash, chunk.length)
    if (bytes === undefined) throw corrupt('file descriptor references a missing chunk')
    return bytes
  }

  async #verifyDescriptor(descriptor, consume, code = 'BLOB_CORRUPT') {
    const digest = createHash('sha256')
    for (const chunk of descriptor.layout.chunks) {
      const bytes = await this.#requireChunk(chunk)
      digest.update(bytes)
      this.metrics.fileVerificationBytes += bytes.byteLength
      if (consume !== undefined) consume(bytes, chunk.offset)
    }
    if (digest.digest('hex') !== descriptor.hash) {
      throw new WorkspaceError(code, 'chunk sequence does not match full-file SHA-256', code === 'BLOB_CORRUPT' ? 500 : 409)
    }
  }
}
