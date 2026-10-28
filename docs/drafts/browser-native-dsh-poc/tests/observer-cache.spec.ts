import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { BrowserObserverCache } from '../browser-native-observer-cache.ts'
import { observerCacheFixture } from './observer-cache-fixture.ts'

const workspaceId = '7cb327fe-f71a-4d54-ac91-17f0ab4fb163'
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const limits = { maxFiles: 4, maxBytes: 4 * 1024 * 1024 }
const bytes = new TextEncoder().encode('committed bytes\n')
const entry = { hash: hash(bytes), bytes: bytes.byteLength }
const source = (content = bytes) => ({
  read: vi.fn(async (offset: number, length: number) => content.slice(offset, offset + length)),
  close: vi.fn(async () => {}),
})

describe('private observer OPFS backing', () => {
  it('shares verified aliases with independent closes and releases the final handle', async () => {
    const environment = observerCacheFixture()
    const cache = await BrowserObserverCache.create(workspaceId, [entry, entry], limits, environment)
    try {
      const firstSource = source()
      const first = await cache.open(entry.hash, firstSource)
      const secondSource = source()
      const second = await cache.open(entry.hash, secondSource)
      expect(secondSource.read).not.toHaveBeenCalled()
      expect(firstSource.close).toHaveBeenCalledOnce()
      expect(secondSource.close).toHaveBeenCalledOnce()
      expect(environment.state.openHandles).toBe(1)
      first.close()
      first.close()
      expect(() => first.read(0, 1)).toThrow('backing was closed')
      expect(second.read(0, 100)).toEqual(bytes)
      expect(() => second.read(-1, 2)).toThrow('invalid read range')
      second.close()
      expect(environment.state.openHandles).toBe(0)
    } finally { await cache.dispose() }
    expect(environment.directories.size).toBe(0)
    expect(environment.held.size).toBe(0)
  })

  it('admits unique content before storage, rejecting byte/file budgets and conflicting aliases', async () => {
    const environment = observerCacheFixture()
    for (const [entries, budget] of [
      [[entry], { maxFiles: 1, maxBytes: 0 }],
      [[entry, { hash: 'a'.repeat(64), bytes: 1 }], { maxFiles: 1, maxBytes: 100 }],
      [[entry, { ...entry, bytes: entry.bytes + 1 }], limits],
      [[entry], { maxFiles: 0, maxBytes: 100 }],
    ] as const) {
      await expect(BrowserObserverCache.create(workspaceId, entries, budget, environment)).rejects.toThrow()
    }
    expect(environment.directories.size).toBe(0)
    expect(environment.held.size).toBe(0)
  })

  it.each(['hash', 'range', 'write', 'quota'] as const)('rejects %s failure without publishing partial bytes or leaking a handle', async fault => {
    const environment = observerCacheFixture()
    const cache = await BrowserObserverCache.create(workspaceId, [entry], limits, environment)
    try {
      environment.state.shortWrite = fault === 'write'
      environment.state.quota = fault === 'quota'
      const input = source(fault === 'hash' ? bytes.map(value => value ^ 1) : fault === 'range' ? bytes.slice(1) : bytes)
      await expect(cache.open(entry.hash, input)).rejects.toThrow()
      expect(input.close).toHaveBeenCalledOnce()
      expect(environment.state.openHandles).toBe(0)
      expect(environment.contents.size).toBe(0)
    } finally { await cache.dispose() }
  })

  it('uses bounded chunks and rejects short backing reads', async () => {
    const environment = observerCacheFixture()
    const content = new Uint8Array(3 * 1024 * 1024 + 17).fill(19)
    const identity = { hash: hash(content), bytes: content.byteLength }
    const cache = await BrowserObserverCache.create(workspaceId, [identity], limits, environment)
    try {
      const input = source(content)
      const backing = await cache.open(identity.hash, input)
      expect(input.read.mock.calls.length).toBe(4)
      expect(environment.state.maxWrite).toBe(1024 * 1024)
      environment.state.shortRead = true
      expect(() => backing.read(0, 4)).toThrow('short OPFS read')
    } finally { await cache.dispose() }
  })

  it('verifies empty content and closes the source even for unadmitted content', async () => {
    const environment = observerCacheFixture()
    const empty = new Uint8Array(0)
    const identity = { hash: hash(empty), bytes: 0 }
    const cache = await BrowserObserverCache.create(workspaceId, [identity], limits, environment)
    try {
      const input = source(empty)
      const backing = await cache.open(identity.hash, input)
      expect(input.read).toHaveBeenCalledWith(0, 0)
      expect(backing.read(0, 1)).toEqual(empty)
      const other = source()
      await expect(cache.open(entry.hash, other)).rejects.toThrow('not admitted')
      expect(other.close).toHaveBeenCalledOnce()
    } finally { await cache.dispose() }
  })

  it('preserves live observers and unrelated directories while reaping an unlocked orphan', async () => {
    const environment = observerCacheFixture()
    const root = await environment.root()
    const prefix = `dsh-observer-cache-v1-${workspaceId}-`
    const orphan = `${prefix}13af67eb-ab45-4e9b-8ed5-d706458a5b7c`
    const foreign = 'dsh-workspace-blobs-writer'
    await root.getDirectoryHandle(orphan, { create: true })
    await root.getDirectoryHandle(foreign, { create: true })
    const first = await BrowserObserverCache.create(workspaceId, [entry], limits, environment)
    const second = await BrowserObserverCache.create(workspaceId, [entry], limits, environment)
    try {
      expect(environment.directories.has(`${orphan}/`)).toBe(false)
      expect(environment.directories.has(`${foreign}/`)).toBe(true)
      expect(environment.held.size).toBe(2)
      expect(environment.directories.size).toBe(3)
      const backing = await first.open(entry.hash, source())
      await second.dispose()
      expect(backing.read(0, entry.bytes)).toEqual(bytes)
      await first.dispose()
      expect(() => backing.read(0, 1)).toThrow('disposed')
      backing.close()
      await first.dispose()
      expect(environment.held.size).toBe(0)
      expect(environment.state.openHandles).toBe(0)
    } finally { await Promise.all([first.dispose(), second.dispose()]) }
  })

  it('aborts and settles an active source before deleting storage', async () => {
    const environment = observerCacheFixture()
    const cache = await BrowserObserverCache.create(workspaceId, [entry], limits, environment)
    let rejectRead = (error: Error): void => { void error }
    let started = (): void => {}
    const reading = new Promise<void>(resolveReading => { started = resolveReading })
    const input = {
      read: async () => { started(); return await new Promise<Uint8Array>((resolveUnused, reject) => { rejectRead = reject }) },
      close: vi.fn(async () => { rejectRead(new Error('source aborted')) }),
    }
    const opening = cache.open(entry.hash, input)
    const failure = expect(opening).rejects.toThrow('source aborted')
    await reading
    await cache.dispose()
    await failure
    expect(environment.state.openHandles).toBe(0)
    expect(environment.held.size).toBe(0)
    expect(environment.directories.size).toBe(0)
  })
})
