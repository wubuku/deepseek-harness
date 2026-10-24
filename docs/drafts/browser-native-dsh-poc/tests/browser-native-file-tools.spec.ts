import { describe, expect, it } from 'vitest'
import { MemoryVfs } from '../../../../packages/experimental/webworker-runtime/src/storage/memory.ts'
import {
  assertBrowserNativeEditSafe,
  executeBrowserNativeGlob,
  executeBrowserNativeGrep,
} from '../browser-native-file-tools.ts'

function workspace(): MemoryVfs {
  const vfs = new MemoryVfs()
  vfs.seedDirectory('/dsh/home/workspace')
  return vfs
}

describe('browser-native file tools', () => {
  it('searches the VFS with path and include filters and returns standard values', async () => {
    const vfs = workspace()
    vfs.mkdirSync('/dsh/home/workspace/src', { recursive: true })
    vfs.writeFileSync('/dsh/home/workspace/src/a.ts', 'alpha\nTARGET one\n')
    vfs.writeFileSync('/dsh/home/workspace/src/b.js', 'TARGET two\n')
    vfs.writeFileSync('/dsh/home/workspace/README.md', 'TARGET three\n')

    await expect(executeBrowserNativeGrep(vfs, { pattern: '^TARGET', path: 'src', include: '*.ts' }, new AbortController().signal))
      .resolves.toEqual({ matches: [{ path: 'src/a.ts', lineNumber: 2, line: 'TARGET one' }] })
    await expect(executeBrowserNativeGrep(vfs, { pattern: 'TARGET', include: '*.{ts,js}' }, new AbortController().signal))
      .resolves.toMatchObject({ matches: [{ path: 'src/a.ts' }, { path: 'src/b.js' }] })
  })

  it('reports invalid patterns and bounds matched lines before returning them', async () => {
    const vfs = workspace()
    vfs.writeFileSync('/dsh/home/workspace/long.txt', `${'x'.repeat(70 * 1024)}\n`)
    await expect(executeBrowserNativeGrep(vfs, { pattern: 'x', path: 'long.txt' }, new AbortController().signal))
      .rejects.toThrow('SEARCH_LINE_TOO_LONG')
    await expect(executeBrowserNativeGrep(vfs, { pattern: '[' }, new AbortController().signal))
      .rejects.toThrow('SEARCH_INVALID_PATTERN')
    await expect(executeBrowserNativeGrep(vfs, { pattern: '(?:a+)+$' }, new AbortController().signal))
      .rejects.toThrow('SEARCH_PATTERN_TOO_COMPLEX')
    await expect(executeBrowserNativeGrep(vfs, { pattern: 'a'.repeat(4 * 1024 + 1) }, new AbortController().signal))
      .rejects.toThrow('SEARCH_PATTERN_TOO_LARGE')
    await expect(executeBrowserNativeGrep(vfs, { pattern: 'x', include: 'a'.repeat(4 * 1024 + 1) }, new AbortController().signal))
      .rejects.toThrow('SEARCH_PATTERN_TOO_LARGE')
  })

  it('cooperatively stops a long scan and leaves the VFS usable', async () => {
    const vfs = workspace()
    vfs.writeFileSync('/dsh/home/workspace/large.txt', `${Array.from({ length: 2_000 }, (_, index) => `line-${index}`).join('\n')}\n`)
    const controller = new AbortController()
    const search = executeBrowserNativeGrep(vfs, { pattern: 'line-' }, controller.signal)
    setTimeout(() => { controller.abort() }, 1)
    await expect(search).resolves.toEqual({ matches: [] })
    expect(vfs.readFileSync('/dsh/home/workspace/large.txt', 'utf8')).toContain('line-1999')
  })

  it('discovers files in modification order and rejects oversized edit payloads', async () => {
    const vfs = workspace()
    vfs.writeFileSync('/dsh/home/workspace/one.ts', 'one')
    vfs.writeFileSync('/dsh/home/workspace/two.js', 'two')
    await expect(executeBrowserNativeGlob(vfs, { pattern: '**/*.{ts,js}' }, new AbortController().signal))
      .resolves.toMatchObject({ paths: expect.arrayContaining(['one.ts', 'two.js']) })
    const paths = await executeBrowserNativeGlob(vfs, { pattern: '**/*.{ts,js}' }, new AbortController().signal)
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
    const result = await executeBrowserNativeGrep(vfs, { pattern: '目标' }, new AbortController().signal)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ path: 'chunked.txt', lineNumber: 1, line: content.split('\n')[0] })
    vfs.writeFileSync('/dsh/home/workspace/binary.bin', new Uint8Array([0, 0xff, 0x01]))
    await expect(executeBrowserNativeGrep(vfs, { pattern: 'x', path: 'binary.bin' }, new AbortController().signal))
      .rejects.toThrow('SEARCH_BINARY_FILE')
    expect(() => assertBrowserNativeEditSafe(vfs, {
      file_path: 'binary.bin', old_string: 'x', new_string: 'y',
    }, new AbortController().signal)).toThrow('EDIT_BINARY_FILE')
  })

  it('fails closed when glob output exceeds its browser budget', async () => {
    const vfs = workspace()
    for (let index = 0; index < 5_001; index += 1) {
      vfs.writeFileSync(`/dsh/home/workspace/file-${String(index).padStart(4, '0')}.txt`, 'x')
    }
    await expect(executeBrowserNativeGlob(vfs, { pattern: '*.txt' }, new AbortController().signal))
      .rejects.toThrow('SEARCH_RESULT_OVERFLOW')
  })
})
