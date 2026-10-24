import { describe, expect, it } from 'vitest'
import {
  ChunkEditError,
  MemoryChunkBackedFile,
  findUniqueUtf8Range,
  hashChunkBackedFile,
  replaceRangeCopyOnWrite,
  replaceUniqueUtf8CopyOnWrite,
} from '../browser-native-chunk-editor.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe('browser-native chunk editor', () => {
  it('finds UTF-8 text across chunk boundaries without reading the whole file', () => {
    const source = new MemoryChunkBackedFile(encoder.encode(`prefix-${'x'.repeat(11)}目标-尾部`))
    expect(findUniqueUtf8Range(source, '目标', { chunkBytes: 7 })).toEqual({ start: 18, end: 24 })
  })

  it('supports shorter, equal-length, and longer replacements', () => {
    const cases = [
      ['before TARGET after', 'TARGET', 'T', 'before T after'],
      ['before TARGET after', 'TARGET', 'CHANGE', 'before CHANGE after'],
      ['before TARGET after', 'TARGET', 'a much longer replacement', 'before a much longer replacement after'],
    ] as const
    for (const [initial, oldText, newText, expected] of cases) {
      const source = new MemoryChunkBackedFile(encoder.encode(initial))
      const target = new MemoryChunkBackedFile()
      const result = replaceUniqueUtf8CopyOnWrite(source, target, oldText, newText, { chunkBytes: 8 })
      expect(decoder.decode(target.snapshot())).toBe(expected)
      expect(result.sourceBytes).toBe(initial.length)
      expect(result.resultBytes).toBe(expected.length)
      expect(result.maxWorkingBytes).toBe(8 + encoder.encode(newText).byteLength)
      expect(decoder.decode(source.snapshot())).toBe(initial)
    }
  })

  it('rejects missing and repeated old text before publishing a target', () => {
    expect(() => replaceUniqueUtf8CopyOnWrite(
      new MemoryChunkBackedFile(encoder.encode('one TARGET')),
      new MemoryChunkBackedFile(),
      'missing',
      'new',
      { chunkBytes: 8 },
    )).toThrowError(new RegExp('TEXT_NOT_FOUND'))
    expect(() => replaceUniqueUtf8CopyOnWrite(
      new MemoryChunkBackedFile(encoder.encode('TARGET and TARGET')),
      new MemoryChunkBackedFile(),
      'TARGET',
      'new',
      { chunkBytes: 8 },
    )).toThrowError(new RegExp('TEXT_NOT_UNIQUE'))
  })

  it('keeps the source unchanged when the target fails before publish', () => {
    const source = new MemoryChunkBackedFile(encoder.encode('prefix TARGET suffix'))
    const target = new MemoryChunkBackedFile()
    expect(() => replaceUniqueUtf8CopyOnWrite(source, target, 'TARGET', 'replacement', {
      chunkBytes: 8,
      onStage: stage => { if (stage === 'publish') throw new Error('publish interrupted') },
    })).toThrowError(new RegExp('WRITE_FAILED'))
    expect(decoder.decode(source.snapshot())).toBe('prefix TARGET suffix')
  })

  it('reports cancellation without claiming a result', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => replaceRangeCopyOnWrite(
      new MemoryChunkBackedFile(encoder.encode('source')),
      new MemoryChunkBackedFile(),
      { start: 0, end: 1 },
      encoder.encode('x'),
      { signal: controller.signal, chunkBytes: 8 },
    )).toThrowError(new RegExp('CANCELLED'))
  })

  it('rejects ranges outside the source file', () => {
    expect(() => replaceRangeCopyOnWrite(
      new MemoryChunkBackedFile(encoder.encode('source')),
      new MemoryChunkBackedFile(),
      { start: 2, end: 99 },
      encoder.encode('x'),
      { chunkBytes: 8 },
    )).toThrowError(new RegExp('INVALID_RANGE'))
    expect(new ChunkEditError('INVALID_RANGE', 'test')).toBeInstanceOf(Error)
  })

  it('rejects short reads while hashing', () => {
    const shortReadFile = {
      size: 3,
      read: (_position: number, _length: number) => encoder.encode('so'),
      write: (_position: number, _bytes: Uint8Array) => {},
      truncate: (_length: number) => {},
      flush: () => {},
      close: () => {},
    }
    expect(() => hashChunkBackedFile(shortReadFile)).toThrowError(new RegExp('short hash read'))
  })
})
