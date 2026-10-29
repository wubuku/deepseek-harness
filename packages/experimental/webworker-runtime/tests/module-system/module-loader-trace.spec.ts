import { describe, expect, it } from 'vitest'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

function fixture(): MemoryVfs {
  const vfs = new MemoryVfs()
  vfs.seedDirectory('/dsh/node_modules/pkg')
  vfs.writeFileSync('/dsh/node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', main: 'index.js' }))
  vfs.writeFileSync('/dsh/node_modules/pkg/index.js', 'module.exports = require("node:probe")')
  return vfs
}

function loader(vfs: MemoryVfs, moduleTraceCapacity?: number): WorkerModuleLoader {
  return new WorkerModuleLoader({
    vfs,
    root: '/dsh',
    staticModules: { 'node:probe': () => ({ loaded: true }) },
    ...(moduleTraceCapacity === undefined ? {} : { moduleTraceCapacity }),
  })
}

describe('WorkerModuleLoader request trace', () => {
  it('is disabled by default and leaves resolution behavior unchanged', () => {
    const instance = loader(fixture())

    expect(instance.requireFrom('/dsh')('pkg')).toEqual({ loaded: true })
    expect(instance.requestTrace()).toBeUndefined()
  })

  it('records importer, resolver kind, VFS target, static load, and cache hits', () => {
    const instance = loader(fixture(), 20)
    const require = instance.requireFrom('/dsh')

    expect(require('pkg')).toEqual({ loaded: true })
    expect(require('pkg')).toEqual({ loaded: true })
    expect(require.resolve('pkg')).toBe('/dsh/node_modules/pkg/index.js')

    const events = instance.requestTrace()?.events
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'request', importer: '/dsh', specifier: 'pkg', requestKind: 'require',
        resolution: 'file', target: '/dsh/node_modules/pkg/index.js',
      }),
      expect.objectContaining({
        type: 'request', importer: '/dsh/node_modules/pkg/index.js', specifier: 'node:probe',
        requestKind: 'require', resolution: 'static', target: 'node:probe',
      }),
      expect.objectContaining({ type: 'load', moduleKind: 'commonjs', outcome: 'evaluated' }),
      expect.objectContaining({ type: 'load', moduleKind: 'static', target: 'node:probe', outcome: 'returned' }),
      expect.objectContaining({ type: 'load', moduleKind: 'commonjs', outcome: 'cached' }),
      expect.objectContaining({ type: 'request', requestKind: 'require-resolve', resolution: 'file' }),
    ]))
    expect(events?.every((event, index) => index === 0 || event.sequence > (events[index - 1]?.sequence ?? 0))).toBe(true)
  })

  it('records internal ESM importer identity and import requests', async () => {
    const instance = loader(fixture(), 20)

    await expect(instance.internal.import('pkg', 'file:///dsh/node_modules/caller/index.js'))
      .resolves.toEqual({ loaded: true })

    expect(instance.requestTrace()?.events).toContainEqual(expect.objectContaining({
      type: 'request',
      importer: '/dsh/node_modules/caller/index.js',
      specifier: 'pkg',
      requestKind: 'internal-import',
      resolution: 'file',
    }))
    expect(instance.requestTrace()?.events).toContainEqual(expect.objectContaining({
      type: 'load',
      importer: '/dsh/node_modules/caller/index.js',
      target: '/dsh/node_modules/pkg/index.js',
      outcome: 'evaluated',
    }))
  })

  it('retains the source module identity for a require closure used after evaluation', () => {
    const vfs = fixture()
    vfs.writeFileSync('/dsh/node_modules/pkg/index.js', 'module.exports = require')
    const instance = loader(vfs, 20)
    const deferredRequire = instance.requireFrom('/dsh')('pkg') as (specifier: string) => unknown

    expect(deferredRequire('node:probe')).toEqual({ loaded: true })
    expect(instance.requestTrace()?.events).toContainEqual(expect.objectContaining({
      type: 'request',
      importer: '/dsh/node_modules/pkg/index.js',
      specifier: 'node:probe',
      requestKind: 'require',
      resolution: 'static',
    }))
  })

  it('records unresolved requests while preserving their thrown error', () => {
    const instance = loader(fixture(), 20)

    expect(() => instance.requireFrom('/dsh')('missing-package')).toThrow(/cannot resolve "missing-package"/)
    expect(instance.requestTrace()?.events).toContainEqual(expect.objectContaining({
      type: 'request',
      specifier: 'missing-package',
      requestKind: 'require',
      resolution: 'unresolved',
      errorCode: 'MODULE_NOT_FOUND',
    }))
  })

  it('records a module evaluation failure and rethrows it', () => {
    const vfs = fixture()
    vfs.writeFileSync('/dsh/node_modules/pkg/index.js', 'throw Object.assign(new Error("fixture failure"), { code: "ERR_FIXTURE" })')
    const instance = loader(vfs, 20)

    expect(() => instance.requireFrom('/dsh')('pkg')).toThrow('fixture failure')
    expect(instance.requestTrace()?.events).toContainEqual(expect.objectContaining({
      type: 'load',
      target: '/dsh/node_modules/pkg/index.js',
      outcome: 'failed',
      errorCode: 'ERR_FIXTURE',
    }))
  })

  it('keeps the first capacity events and reports every omitted event', () => {
    const instance = loader(fixture(), 2)

    expect(instance.requireFrom('/dsh')('pkg')).toEqual({ loaded: true })

    const trace = instance.requestTrace()
    expect(trace?.events).toHaveLength(2)
    expect(trace?.events.map(event => event.sequence)).toEqual([1, 2])
    expect(trace?.droppedEvents).toBeGreaterThan(0)
  })

  it('rejects invalid capacities before loading modules', () => {
    expect(() => loader(fixture(), 0)).toThrow('moduleTraceCapacity must be an integer from 1 through 100000')
    expect(() => loader(fixture(), 100_001)).toThrow('moduleTraceCapacity must be an integer from 1 through 100000')
  })
})
