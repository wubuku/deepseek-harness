import { Sha256 } from './browser-native-sha256.ts'

const DEFAULT_CHUNK_BYTES = 1024 * 1024

/** Minimal synchronous file used by the bounded-memory replacement prototype. */
export interface ChunkBackedFile {
  readonly size: number
  read(position: number, length: number): Uint8Array
  write(position: number, bytes: Uint8Array): void
  truncate(length: number): void
  flush(): void
  close(): void
}

/** Stages at which the prototype may inject a deterministic write failure. */
export type ChunkEditStage = 'copy-prefix' | 'copy-suffix' | 'write-replacement' | 'truncate' | 'hash' | 'publish'

/** Measurements returned by one copy-on-write edit. */
export interface ChunkEditMetrics {
  readonly sourceBytes: number
  readonly resultBytes: number
  readonly chunkBytes: number
  readonly readCalls: number
  readonly writeCalls: number
  readonly bytesRead: number
  readonly bytesWritten: number
  readonly maxWorkingBytes: number
  readonly sourceHash: string
  readonly resultHash: string
}

/** Result of locating one unique UTF-8 replacement range. */
export interface ChunkEditRange {
  readonly start: number
  readonly end: number
}

/** Failure raised when a bounded-memory edit cannot safely proceed. */
export class ChunkEditError extends Error {
  override readonly name = 'ChunkEditError'

  constructor(readonly code: 'INVALID_RANGE' | 'TEXT_NOT_FOUND' | 'TEXT_NOT_UNIQUE' | 'CANCELLED' | 'WRITE_FAILED', message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options)
  }
}

/** Options shared by range lookup and copy-on-write replacement. */
export interface ChunkEditOptions {
  readonly chunkBytes?: number
  readonly signal?: AbortSignal
  readonly onStage?: (stage: ChunkEditStage) => void
}

/** Hash one chunk-backed file without materializing its contents. */
export function hashChunkBackedFile(file: ChunkBackedFile, chunkBytes = DEFAULT_CHUNK_BYTES): string {
  const size = checkChunkBytes(chunkBytes)
  const digest = new Sha256()
  for (let offset = 0; offset < file.size; offset += size) {
    const bytes = file.read(offset, Math.min(size, file.size - offset))
    const expectedLength = Math.min(size, file.size - offset)
    if (bytes.byteLength !== expectedLength) throw new ChunkEditError('WRITE_FAILED', 'file returned a short hash read')
    digest.update(bytes)
  }
  return digest.digestHex()
}

function checkChunkBytes(value: number | undefined): number {
  const chunkBytes = value ?? DEFAULT_CHUNK_BYTES
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 16 * 1024 * 1024) {
    throw new RangeError('browser-native chunk editor: chunkBytes must be between 1 and 16777216')
  }
  return chunkBytes
}

function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ChunkEditError('CANCELLED', 'chunk edit was cancelled')
}

function findBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let start = from; start + needle.byteLength <= haystack.byteLength; start += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[start + index] !== needle[index]) continue outer
    }
    return start
  }
  return -1
}

/** Locate a unique UTF-8 string without materializing the source file. */
export function findUniqueUtf8Range(file: ChunkBackedFile, oldText: string, options: ChunkEditOptions = {}): ChunkEditRange {
  const chunkBytes = checkChunkBytes(options.chunkBytes)
  const needle = new TextEncoder().encode(oldText)
  if (needle.byteLength === 0) throw new ChunkEditError('INVALID_RANGE', 'oldText must not be empty')
  const overlap = Math.max(0, needle.byteLength - 1)
  let carry = new Uint8Array(0)
  let offset = 0
  let found: ChunkEditRange | undefined
  while (offset < file.size) {
    checkSignal(options.signal)
    const length = Math.min(chunkBytes, file.size - offset)
    const bytes = file.read(offset, length)
    if (bytes.byteLength !== length) throw new ChunkEditError('WRITE_FAILED', 'source returned a short read')
    const combined = new Uint8Array(carry.byteLength + bytes.byteLength)
    combined.set(carry)
    combined.set(bytes, carry.byteLength)
    const base = offset - carry.byteLength
    let cursor = 0
    while (true) {
      const index = findBytes(combined, needle, cursor)
      if (index < 0) break
      const start = base + index
      if (found?.start !== start) {
        if (found !== undefined) throw new ChunkEditError('TEXT_NOT_UNIQUE', 'oldText occurs more than once')
        found = { start, end: start + needle.byteLength }
      }
      cursor = index + 1
    }
    carry = combined.slice(Math.max(0, combined.byteLength - overlap))
    offset += length
  }
  if (found === undefined) throw new ChunkEditError('TEXT_NOT_FOUND', 'oldText was not found')
  return found
}

interface MutableMetrics {
  readCalls: number
  writeCalls: number
  bytesRead: number
  bytesWritten: number
}

function copyRange(
  source: ChunkBackedFile,
  target: ChunkBackedFile,
  sourceStart: number,
  sourceEnd: number,
  targetStart: number,
  buffer: Uint8Array,
  metrics: MutableMetrics,
  options: ChunkEditOptions,
  stage: ChunkEditStage,
): void {
  let sourcePosition = sourceStart
  let targetPosition = targetStart
  while (sourcePosition < sourceEnd) {
    checkSignal(options.signal)
    options.onStage?.(stage)
    const length = Math.min(buffer.byteLength, sourceEnd - sourcePosition)
    const bytes = source.read(sourcePosition, length)
    if (bytes.byteLength !== length) throw new ChunkEditError('WRITE_FAILED', 'source returned a short read')
    target.write(targetPosition, bytes)
    metrics.readCalls += 1
    metrics.writeCalls += 1
    metrics.bytesRead += bytes.byteLength
    metrics.bytesWritten += bytes.byteLength
    sourcePosition += bytes.byteLength
    targetPosition += bytes.byteLength
  }
}

function hashFile(file: ChunkBackedFile, buffer: Uint8Array, metrics: MutableMetrics, options: ChunkEditOptions): string {
  const digest = new Sha256()
  let offset = 0
  while (offset < file.size) {
    checkSignal(options.signal)
    options.onStage?.('hash')
    const length = Math.min(buffer.byteLength, file.size - offset)
    const bytes = file.read(offset, length)
    if (bytes.byteLength !== length) throw new ChunkEditError('WRITE_FAILED', 'file returned a short hash read')
    digest.update(bytes)
    metrics.readCalls += 1
    metrics.bytesRead += bytes.byteLength
    offset += bytes.byteLength
  }
  return digest.digestHex()
}

/** Replace one unique byte range in a new file using bounded copy-on-write IO. */
export function replaceRangeCopyOnWrite(
  source: ChunkBackedFile,
  target: ChunkBackedFile,
  range: ChunkEditRange,
  replacement: Uint8Array,
  options: ChunkEditOptions = {},
): ChunkEditMetrics {
  const chunkBytes = checkChunkBytes(options.chunkBytes)
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 0 || range.end < range.start || range.end > source.size) {
    throw new ChunkEditError('INVALID_RANGE', 'replacement range is outside the source file')
  }
  checkSignal(options.signal)
  const metrics: MutableMetrics = { readCalls: 0, writeCalls: 0, bytesRead: 0, bytesWritten: 0 }
  const buffer = new Uint8Array(chunkBytes)
  const resultBytes = source.size - (range.end - range.start) + replacement.byteLength
  try {
    const sourceHash = hashFile(source, buffer, metrics, options)
    target.truncate(0)
    copyRange(source, target, 0, range.start, 0, buffer, metrics, options, 'copy-prefix')
    options.onStage?.('write-replacement')
    checkSignal(options.signal)
    if (replacement.byteLength > 0) {
      target.write(range.start, replacement)
      metrics.writeCalls += 1
      metrics.bytesWritten += replacement.byteLength
    }
    copyRange(source, target, range.end, source.size, range.start + replacement.byteLength, buffer, metrics, options, 'copy-suffix')
    options.onStage?.('truncate')
    checkSignal(options.signal)
    target.truncate(resultBytes)
    target.flush()
    const resultHash = hashFile(target, buffer, metrics, options)
    options.onStage?.('publish')
    target.flush()
    return {
      sourceBytes: source.size,
      resultBytes,
      chunkBytes,
      readCalls: metrics.readCalls,
      writeCalls: metrics.writeCalls,
      bytesRead: metrics.bytesRead,
      bytesWritten: metrics.bytesWritten,
      maxWorkingBytes: buffer.byteLength + replacement.byteLength,
      sourceHash,
      resultHash,
    }
  } catch (error) {
    if (error instanceof ChunkEditError) throw error
    throw new ChunkEditError('WRITE_FAILED', String(error), { cause: error })
  }
}

/** Find a unique UTF-8 range and replace it in one bounded-memory operation. */
export function replaceUniqueUtf8CopyOnWrite(
  source: ChunkBackedFile,
  target: ChunkBackedFile,
  oldText: string,
  newText: string,
  options: ChunkEditOptions = {},
): ChunkEditMetrics {
  const range = findUniqueUtf8Range(source, oldText, options)
  return replaceRangeCopyOnWrite(source, target, range, new TextEncoder().encode(newText), options)
}

/** In-memory file used by unit tests and deterministic fault injection. */
export class MemoryChunkBackedFile implements ChunkBackedFile {
  private bytes: Uint8Array
  private closed = false

  constructor(initial: Uint8Array = new Uint8Array(), private readonly fail?: (operation: 'read' | 'write' | 'truncate' | 'flush') => void) {
    this.bytes = initial.slice()
  }

  get size(): number { return this.bytes.byteLength }

  read(position: number, length: number): Uint8Array {
    this.assertOpen()
    this.fail?.('read')
    return this.bytes.slice(position, Math.min(position + length, this.bytes.byteLength))
  }

  write(position: number, bytes: Uint8Array): void {
    this.assertOpen()
    this.fail?.('write')
    const result = new Uint8Array(Math.max(this.bytes.byteLength, position + bytes.byteLength))
    result.set(this.bytes)
    result.set(bytes, position)
    this.bytes = result
  }

  truncate(length: number): void {
    this.assertOpen()
    this.fail?.('truncate')
    const result = new Uint8Array(length)
    result.set(this.bytes.subarray(0, length))
    this.bytes = result
  }

  flush(): void { this.assertOpen(); this.fail?.('flush') }

  close(): void { this.closed = true }

  snapshot(): Uint8Array { return this.bytes.slice() }

  private assertOpen(): void {
    if (this.closed) throw new Error('memory chunk file is closed')
  }
}

/** Adapter for a Worker-only FileSystemSyncAccessHandle. */
export function createSyncAccessChunkBackedFile(handle: {
  getSize(): number
  read(buffer: Uint8Array, options?: { at?: number }): number
  write(buffer: Uint8Array, options?: { at?: number }): number
  truncate(size: number): void
  flush(): void
  close(): void
}): ChunkBackedFile {
  let closed = false
  const assertOpen = (): void => {
    if (closed) throw new Error('OPFS chunk file is closed')
  }
  return {
    get size(): number { assertOpen(); return handle.getSize() },
    read(position, length) {
      assertOpen()
      const output = new Uint8Array(length)
      const read = handle.read(output, { at: position })
      return output.subarray(0, read)
    },
    write(position, bytes) {
      assertOpen()
      let offset = 0
      while (offset < bytes.byteLength) {
        const written = handle.write(bytes.subarray(offset), { at: position + offset })
        if (written <= 0) throw new Error('OPFS chunk file returned a zero-byte write')
        offset += written
      }
    },
    truncate(length) { assertOpen(); handle.truncate(length) },
    flush() { assertOpen(); handle.flush() },
    close() { if (!closed) { closed = true; handle.close() } },
  }
}
