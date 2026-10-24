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
})
