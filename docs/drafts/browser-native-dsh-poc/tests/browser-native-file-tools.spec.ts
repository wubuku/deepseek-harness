import { describe, expect, it } from 'vitest'
import { MemoryVfs } from '../../../../packages/experimental/webworker-runtime/src/storage/memory.ts'
import {
  assertBrowserNativeEditSafe,
  executeBrowserNativeGlob,
  executeBrowserNativeGrep,
  type BrowserNativeRegexMatcherFactory,
} from '../browser-native-file-tools.ts'

function workspace(): MemoryVfs {
  const vfs = new MemoryVfs()
  vfs.seedDirectory('/dsh/home/workspace')
  return vfs
}

const testMatcherFactory: BrowserNativeRegexMatcherFactory = () => {
  return {
    match: async (pattern, lines, signal, _timeoutMs, onStarted) => {
      onStarted?.()
      if (signal.aborted) throw new Error('test matcher aborted')
      let regex: RegExp
      try {
        regex = new RegExp(pattern, 'u')
      } catch (error) {
        throw new Error(`SEARCH_INVALID_PATTERN: ${String(error)}`)
      }
      const indices: number[] = []
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (line !== undefined && regex.test(line)) indices.push(index)
      }
      return indices
    },
    validate: async (pattern, signal, _timeoutMs) => {
      if (signal.aborted) throw new Error('test matcher aborted')
      try {
        new RegExp(pattern, 'u')
      } catch (error) {
        throw new Error(`SEARCH_INVALID_PATTERN: ${String(error)}`)
      }
    },
    dispose: () => {},
  }
}

function grep(vfs: MemoryVfs, value: unknown, signal = new AbortController().signal, yieldDelayMs = 0,
  matcherFactory = testMatcherFactory) {
  return executeBrowserNativeGrep(vfs, value, signal, yieldDelayMs, { matcherFactory })
}

function glob(vfs: MemoryVfs, value: unknown, signal = new AbortController().signal, yieldDelayMs = 0,
  matcherFactory = testMatcherFactory) {
  return executeBrowserNativeGlob(vfs, value, signal, yieldDelayMs, { matcherFactory })
}

describe('browser-native file tools', () => {
  it('searches the VFS with path and include filters and returns standard values', async () => {
    const vfs = workspace()
    vfs.mkdirSync('/dsh/home/workspace/src', { recursive: true })
    vfs.writeFileSync('/dsh/home/workspace/src/a.ts', 'alpha\nTARGET one\n')
    vfs.writeFileSync('/dsh/home/workspace/src/b.js', 'TARGET two\n')
    vfs.writeFileSync('/dsh/home/workspace/README.md', 'TARGET three\n')

    await expect(grep(vfs, { pattern: '^TARGET', path: 'src', include: '*.ts' }))
      .resolves.toEqual({ matches: [{ path: 'src/a.ts', lineNumber: 2, line: 'TARGET one' }] })
    await expect(grep(vfs, { pattern: 'TARGET', include: '*.{ts,js}' }))
      .resolves.toMatchObject({ matches: [{ path: 'src/a.ts' }, { path: 'src/b.js' }] })
  })

  it('reports invalid patterns and bounds matched lines before returning them', async () => {
    const vfs = workspace()
    vfs.writeFileSync('/dsh/home/workspace/long.txt', `${'x'.repeat(70 * 1024)}\n`)
    let matcherCalls = 0
    const trackingFactory: BrowserNativeRegexMatcherFactory = () => {
      const matcher = testMatcherFactory()
      return {
        ...matcher,
        match: async (...args) => {
          if (args[1].length > 0) matcherCalls += 1
          return await matcher.match(...args)
        },
      }
    }
    await expect(executeBrowserNativeGrep(vfs, { pattern: 'x', path: 'long.txt' }, new AbortController().signal, 0, {
      matcherFactory: trackingFactory,
    }))
      .rejects.toThrow('SEARCH_LINE_TOO_LONG')
    expect(matcherCalls).toBe(0)
    await expect(grep(workspace(), { pattern: '[' }))
      .rejects.toThrow('SEARCH_INVALID_PATTERN')
    vfs.writeFileSync('/dsh/home/workspace/overlap.txt', 'aaaaaaaaaaaaaaaa!\n')
    await expect(grep(vfs, { pattern: '^(a|aa)+$', path: 'overlap.txt' }))
      .resolves.toEqual({ matches: [] })
    await expect(grep(vfs, { pattern: 'a'.repeat(4 * 1024 + 1) }))
      .rejects.toThrow('SEARCH_PATTERN_TOO_LARGE')
    await expect(grep(vfs, { pattern: 'x', include: 'a'.repeat(4 * 1024 + 1) }))
      .rejects.toThrow('SEARCH_PATTERN_TOO_LARGE')
  })

  it('cooperatively stops a long scan and leaves the VFS usable', async () => {
    const vfs = workspace()
    vfs.writeFileSync('/dsh/home/workspace/large.txt', `${Array.from({ length: 2_000 }, (_, index) => `line-${index}`).join('\n')}\n`)
    const controller = new AbortController()
    const search = grep(vfs, { pattern: 'line-' }, controller.signal)
    setTimeout(() => { controller.abort() }, 1)
    await expect(search).resolves.toEqual({ matches: [] })
    expect(vfs.readFileSync('/dsh/home/workspace/large.txt', 'utf8')).toContain('line-1999')
  })

  it('discovers files in modification order and rejects oversized edit payloads', async () => {
    const vfs = workspace()
    vfs.writeFileSync('/dsh/home/workspace/one.ts', 'one')
    vfs.writeFileSync('/dsh/home/workspace/two.js', 'two')
    await expect(glob(vfs, { pattern: '**/*.{ts,js}' }))
      .resolves.toMatchObject({ paths: expect.arrayContaining(['one.ts', 'two.js']) })
    const paths = await glob(vfs, { pattern: '**/*.{ts,js}' })
    expect(paths.paths).toHaveLength(2)
    vfs.writeFileSync('/dsh/home/workspace/huge-line.txt', `${'a'.repeat(70 * 1024)}\n`)
    expect(() => assertBrowserNativeEditSafe(vfs, {
      file_path: 'huge-line.txt', old_string: 'a', new_string: 'b',
    }, new AbortController().signal)).toThrow('EDIT_PAYLOAD_TOO_LARGE')
    expect(() => assertBrowserNativeEditSafe(vfs, {
      file_path: 'one.ts', old_string: 'a'.repeat(256 * 1024), new_string: 'b',
    }, new AbortController().signal)).toThrow('EDIT_PAYLOAD_TOO_LARGE')
  })

  it('reads UTF-8 across chunks and rejects binary search input', async () => {
    const vfs = workspace()
    const content = `${'prefix '.repeat(8_000)}目标\n尾行\n`
    vfs.writeFileSync('/dsh/home/workspace/chunked.txt', content)
    const result = await grep(vfs, { pattern: '目标' })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ path: 'chunked.txt', lineNumber: 1, line: content.split('\n')[0] })
    vfs.writeFileSync('/dsh/home/workspace/binary.bin', new Uint8Array([0, 0xff, 0x01]))
    await expect(grep(vfs, { pattern: 'x', path: 'binary.bin' }))
      .rejects.toThrow('SEARCH_BINARY_FILE')
    expect(() => assertBrowserNativeEditSafe(vfs, {
      file_path: 'binary.bin', old_string: 'x', new_string: 'y',
    }, new AbortController().signal)).toThrow('EDIT_BINARY_FILE')
  })

  it('bounds unmatched lines and total lines before regex execution', async () => {
    const vfs = workspace()
    vfs.writeFileSync('/dsh/home/workspace/no-match.txt', `${'x'.repeat(70 * 1024)}\n`)
    let matchCalls = 0
    const trackingFactory: BrowserNativeRegexMatcherFactory = () => {
      const matcher = testMatcherFactory()
      return {
        ...matcher,
        match: async (...args) => {
          if (args[1].length > 0) matchCalls += 1
          return await matcher.match(...args)
        },
      }
    }
    await expect(executeBrowserNativeGrep(vfs, { pattern: 'not-present' }, new AbortController().signal, 0, {
      matcherFactory: trackingFactory,
    })).rejects.toThrow('SEARCH_LINE_TOO_LONG')
    expect(matchCalls).toBe(0)

    vfs.writeFileSync('/dsh/home/workspace/many-lines.txt', 'x\n'.repeat(250_001))
    await expect(grep(vfs, { pattern: 'not-present', path: 'many-lines.txt' })).rejects.toThrow('SEARCH_RESULT_OVERFLOW')
  })

  it('fails closed when glob output exceeds its browser budget', async () => {
    const vfs = workspace()
    for (let index = 0; index < 5_001; index += 1) {
      vfs.writeFileSync(`/dsh/home/workspace/file-${String(index).padStart(4, '0')}.txt`, 'x')
    }
    await expect(glob(vfs, { pattern: '*.txt' }))
      .rejects.toThrow('SEARCH_RESULT_OVERFLOW')
  })
})
