import { describe, expect, it } from 'vitest'
import { findContentChunks } from '../browser-native-content-chunker.ts'

const defaults = { minimumBytes: 1024, averageBytes: 4096, maximumBytes: 16 * 1024, readBytes: 733 }

function sourceBytes(length: number): Uint8Array {
  let seed = 0x12345678
  return Uint8Array.from({ length }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed >>> 24
  })
}

describe('browser-native content chunker', () => {
  it('returns deterministic bounded ranges that cover the complete file', async () => {
    const bytes = sourceBytes(128 * 1024)
    const readRange = (offset: number, length: number) => bytes.subarray(offset, offset + length)
    const first = await findContentChunks(bytes.byteLength, readRange, defaults)
    const second = await findContentChunks(bytes.byteLength, readRange, defaults)

    expect(first.chunks).toEqual(second.chunks)
    expect(first.bytesRead).toBe(bytes.byteLength)
    expect(first.maxReadBytes).toBe(defaults.readBytes)
    expect(first.chunks[0]?.offset).toBe(0)
    expect(first.chunks.at(-1)?.offset! + first.chunks.at(-1)?.length!).toBe(bytes.byteLength)
    expect(first.chunks.slice(0, -1).every(chunk => chunk.length >= defaults.minimumBytes
      && chunk.length <= defaults.maximumBytes)).toBe(true)
    expect(first.chunks.slice(1).every((chunk, index) =>
      chunk.offset === first.chunks[index]!.offset + first.chunks[index]!.length)).toBe(true)
  })

  it('uses bounded reads and returns no chunks for an empty file', async () => {
    const result = await findContentChunks(0, () => new Uint8Array(0), defaults)
    expect(result).toEqual({ chunks: [], bytesRead: 0, readCalls: 0, maxReadBytes: 0 })
  })

  it('rejects short reads and invalid chunk limits', async () => {
    await expect(findContentChunks(10, () => new Uint8Array(9), defaults)).rejects.toThrow(/short range read/)
    await expect(findContentChunks(10, () => new Uint8Array(10), { ...defaults, maximumBytes: 512 }))
      .rejects.toThrow(/invalid file or chunk limits/)
  })

  it('observes an already-aborted signal without reading the file', async () => {
    const controller = new AbortController()
    controller.abort()
    const readRange = () => { throw new Error('must not read after cancellation') }
    await expect(findContentChunks(10, readRange, { ...defaults, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('observes cancellation between bounded range reads', async () => {
    const controller = new AbortController()
    const bytes = sourceBytes(2048)
    let readCalls = 0
    await expect(findContentChunks(bytes.byteLength, (offset, length) => {
      readCalls += 1
      return bytes.subarray(offset, offset + length)
    }, {
      ...defaults,
      readBytes: 512,
      signal: controller.signal,
      yieldToCaller: async () => controller.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(readCalls).toBe(1)
  })

  it('resolves new boundaries after a middle insertion', async () => {
    const base = sourceBytes(2 * 1024 * 1024)
    const target = new Uint8Array(base.byteLength + 4096)
    target.set(base.subarray(0, 1024 * 1024))
    target.fill(0xa5, 1024 * 1024, 1024 * 1024 + 4096)
    target.set(base.subarray(1024 * 1024), 1024 * 1024 + 4096)
    const chunkOptions = { minimumBytes: 16 * 1024, averageBytes: 64 * 1024, maximumBytes: 256 * 1024 }
    const baseChunks = await findContentChunks(base.byteLength,
      (offset, length) => base.subarray(offset, offset + length), chunkOptions)
    const targetChunks = await findContentChunks(target.byteLength,
      (offset, length) => target.subarray(offset, offset + length), chunkOptions)
    const reusableAfterEdit = targetChunks.chunks.filter(targetChunk => targetChunk.offset >= 1024 * 1024 + 4096)
      .some(targetChunk => baseChunks.chunks.some(baseChunk => baseChunk.length === targetChunk.length
        && base.subarray(baseChunk.offset, baseChunk.offset + baseChunk.length)
          .every((byte, index) => byte === target[targetChunk.offset + index])))
    expect(targetChunks.chunks.length).toBeGreaterThan(0)
    expect(reusableAfterEdit).toBe(true)
  })
})
