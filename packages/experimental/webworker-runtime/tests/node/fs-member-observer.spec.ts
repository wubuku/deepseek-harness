import { afterEach, describe, expect, it } from 'vitest'
import { setActiveVfs } from '../../src/storage/active.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import * as fs from '../../src/node/builtin_modules/implemented/fs.ts'
import * as fsp from '../../src/node/builtin_modules/implemented/fs/promises.ts'

afterEach(() => { setActiveVfs(new MemoryVfs()) })

describe('Node filesystem member observer', () => {
  it('is opt-in and leaves filesystem behavior unchanged', async () => {
    const vfs = new MemoryVfs()
    setActiveVfs(vfs)

    vfs.mkdirSync('/dsh/observer', { recursive: true })
    await fsp.writeFile('/dsh/observer/off.txt', 'observer-disabled')
    expect(await fsp.readFile('/dsh/observer/off.txt', 'utf8')).toBe('observer-disabled')
    expect(vfs.readFileSync('/dsh/observer/off.txt', 'utf8')).toBe('observer-disabled')
  })

  it('records public shim calls once without arguments or API wrapping', async () => {
    const vfs = new MemoryVfs()
    const calls: { readonly specifier: 'node:fs' | 'node:fs/promises'; readonly member: string }[] = []
    setActiveVfs(vfs, (specifier, member) => { calls.push({ specifier, member }) })

    const readFileSync = fs.readFileSync
    const readFile = fsp.readFile
    expect(fs.default.readFileSync).toBe(readFileSync)
    expect(fsp.default.readFile).toBe(readFile)

    fs.mkdirSync('/dsh/observer', { recursive: true })
    fs.writeFileSync('/dsh/observer/sync.txt', 'PATH_AND_CONTENT_MUST_NOT_ENTER_TRACE')
    expect(fs.readFileSync('/dsh/observer/sync.txt', 'utf8')).toBe('PATH_AND_CONTENT_MUST_NOT_ENTER_TRACE')
    await fsp.writeFile('/dsh/observer/async.txt', 'PRIVATE_ASYNC_CONTENT')
    expect(await fsp.readFile('/dsh/observer/async.txt', 'utf8')).toBe('PRIVATE_ASYNC_CONTENT')
    expect(await fsp.readdir('/dsh/observer')).toEqual(['async.txt', 'sync.txt'])
    await fsp.cp('/dsh/observer', '/dsh/observer-copy')
    expect(await fsp.readFile('/dsh/observer-copy/async.txt', 'utf8')).toBe('PRIVATE_ASYNC_CONTENT')
    expect(fs.lstatSync('/dsh/observer/sync.txt').isFile()).toBe(true)

    expect(calls).toEqual([
      { specifier: 'node:fs', member: 'mkdirSync' },
      { specifier: 'node:fs', member: 'writeFileSync' },
      { specifier: 'node:fs', member: 'readFileSync' },
      { specifier: 'node:fs/promises', member: 'writeFile' },
      { specifier: 'node:fs/promises', member: 'readFile' },
      { specifier: 'node:fs/promises', member: 'readdir' },
      { specifier: 'node:fs/promises', member: 'cp' },
      { specifier: 'node:fs/promises', member: 'readFile' },
      { specifier: 'node:fs', member: 'lstatSync' },
    ])
    expect(JSON.stringify(calls)).not.toContain('observer/sync.txt')
    expect(JSON.stringify(calls)).not.toContain('PRIVATE_ASYNC_CONTENT')
    expect(vfs.readFileSync('/dsh/observer/async.txt', 'utf8')).toBe('PRIVATE_ASYNC_CONTENT')
  })
})
