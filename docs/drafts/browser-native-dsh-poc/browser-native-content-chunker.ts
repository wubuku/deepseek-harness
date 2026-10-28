const GEAR = makeGearTable()

/** A contiguous byte range selected by the experimental content chunker. */
export interface ContentChunk {
  readonly offset: number
  readonly length: number
}

/** Read and work limits for one experimental content chunking pass. */
export interface ContentChunkOptions {
  readonly minimumBytes: number
  readonly averageBytes: number
  readonly maximumBytes: number
  readonly readBytes?: number
  readonly signal?: AbortSignal
  readonly yieldToCaller?: () => Promise<void>
}

/** Measurements for one range-backed content chunking pass. */
export interface ContentChunkMetrics {
  readonly chunks: readonly ContentChunk[]
  readonly bytesRead: number
  readonly readCalls: number
  readonly maxReadBytes: number
}

function makeGearTable(): Uint32Array {
  let state = 0x9e3779b9
  return Uint32Array.from({ length: 256 }, () => {
    state = Math.imul(state ^ (state >>> 16), 0x21f0aaad)
    state = Math.imul(state ^ (state >>> 15), 0x735a2d97)
    state ^= state >>> 15
    return state >>> 0
  })
}

function validateOptions(options: ContentChunkOptions, totalBytes: number): number {
  const readBytes = options.readBytes ?? 256 * 1024
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0
    || !Number.isSafeInteger(options.minimumBytes) || options.minimumBytes < 1
    || !Number.isSafeInteger(options.averageBytes) || options.averageBytes < options.minimumBytes
    || !Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < options.averageBytes
    || options.maximumBytes > 16 * 1024 * 1024
    || !Number.isSafeInteger(readBytes) || readBytes < 1 || readBytes > 16 * 1024 * 1024) {
    throw new RangeError('browser-native content chunker: invalid file or chunk limits')
  }
  return readBytes
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('content chunking cancelled', 'AbortError')
}

/**
 * Find deterministic gear-hash boundaries from bounded file ranges.
 * @param totalBytes - Complete file length.
 * @param readRange - Read exactly the requested file range.
 * @param options - Chunk limits, cancellation signal, and cooperative yield.
 * @returns Chunk ranges that cover the file without gaps or overlap.
 */
export async function findContentChunks(
  totalBytes: number,
  readRange: (offset: number, length: number) => Uint8Array,
  options: ContentChunkOptions,
): Promise<ContentChunkMetrics> {
  const readBytes = validateOptions(options, totalBytes)
  const chunks: ContentChunk[] = []
  const averageBits = Math.round(Math.log2(options.averageBytes))
  if (averageBits < 1 || averageBits > 30) throw new RangeError('browser-native content chunker: averageBytes is unsupported')
  const mask = (2 ** averageBits - 1) >>> 0
  let chunkStart = 0
  let fingerprint = 0
  let bytesRead = 0
  let readCalls = 0
  let maxReadBytes = 0

  for (let offset = 0; offset < totalBytes; offset += readBytes) {
    throwIfAborted(options.signal)
    const length = Math.min(readBytes, totalBytes - offset)
    const bytes = readRange(offset, length)
    if (bytes.byteLength !== length) throw new RangeError('browser-native content chunker: short range read')
    bytesRead += length
    readCalls += 1
    maxReadBytes = Math.max(maxReadBytes, length)

    for (let index = 0; index < bytes.byteLength; index += 1) {
      const absoluteOffset = offset + index
      const chunkLength = absoluteOffset - chunkStart + 1
      fingerprint = (Math.imul(fingerprint, 2) + GEAR[bytes[index]!]!) >>> 0
      if (chunkLength >= options.maximumBytes
        || chunkLength >= options.minimumBytes && (fingerprint & mask) === 0) {
        chunks.push({ offset: chunkStart, length: chunkLength })
        chunkStart = absoluteOffset + 1
        fingerprint = 0
      }
    }

    await options.yieldToCaller?.()
  }

  if (chunkStart < totalBytes) chunks.push({ offset: chunkStart, length: totalBytes - chunkStart })
  throwIfAborted(options.signal)
  return { chunks, bytesRead, readCalls, maxReadBytes }
}
