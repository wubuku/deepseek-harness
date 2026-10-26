import { describe, expect, it } from 'vitest'
import {
  BrowserNativeRecoveryLocks,
  readBrowserNativeRecoveryState,
  type BrowserNativeRecoveryResource,
} from '../../../../apps/web/src/browser-native-recovery.ts'

class TestStorage implements Pick<Storage, 'length' | 'key' | 'getItem'> {
  constructor(private readonly entries: ReadonlyMap<string, string>) {}

  get length(): number {
    return this.entries.size
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null
  }
}

const ownerKey = (sessionId: string): string => `dsh.browser-native.owner.${encodeURIComponent(sessionId)}`
const workspaceKey = (workspaceId: string): string => `dsh.browser-native.workspace-lease.${encodeURIComponent(workspaceId)}`

class SharedLockManager implements Pick<LockManager, 'request'> {
  private readonly held = new Set<string>()
  private readonly completions = new Set<Promise<void>>()

  async waitForIdle(): Promise<void> {
    await Promise.all(this.completions)
  }

  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<Awaited<T>>
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<Awaited<T>>
  async request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    optionalCallback?: LockGrantedCallback<T>,
  ): Promise<Awaited<T>> {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : optionalCallback
    if (callback === undefined) throw new Error('Lock callback is required')
    if (this.held.has(name)) return await callback(null)
    this.held.add(name)
    let finish!: () => void
    const completion = new Promise<void>(resolve => { finish = resolve })
    this.completions.add(completion)
    try {
      return await callback({ name, mode: 'exclusive' })
    } finally {
      this.held.delete(name)
      this.completions.delete(completion)
      finish()
    }
  }
}

interface DeferredLockRequest {
  readonly grant: () => void
}

class DeferredLockManager implements Pick<LockManager, 'request'> {
  private readonly requests = new Map<string, DeferredLockRequest>()
  private readonly arrivals = new Map<string, () => void>()
  private readonly completions = new Set<Promise<void>>()

  get pendingCount(): number {
    return this.requests.size
  }

  grant(name: string): boolean {
    const request = this.requests.get(name)
    if (request === undefined) return false
    request.grant()
    return true
  }

  async waitForIdle(): Promise<void> {
    await Promise.all(this.completions)
  }

  async waitForRequest(name: string): Promise<void> {
    if (this.requests.has(name)) return
    await new Promise<void>(resolve => { this.arrivals.set(name, resolve) })
  }

  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<Awaited<T>>
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<Awaited<T>>
  request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    optionalCallback?: LockGrantedCallback<T>,
  ): Promise<Awaited<T>> {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : optionalCallback
    if (callback === undefined) return Promise.reject(new Error('Lock callback is required'))
    let completion!: Promise<void>
    const result = new Promise<Awaited<T>>((resolve, reject) => {
      let settled = false
      let resolveCompletion!: () => void
      completion = new Promise<void>(resolveFinished => { resolveCompletion = resolveFinished })
      const cleanup = (): void => {
        this.requests.delete(name)
        resolveCompletion()
      }
      this.requests.set(name, {
        grant: () => {
          if (settled) return
          settled = true
          void Promise.resolve(callback({ name, mode: 'exclusive' })).then(resolve, reject).finally(cleanup)
        },
      })
      this.arrivals.get(name)?.()
      this.arrivals.delete(name)
    })
    this.completions.add(completion)
    void completion.then(() => this.completions.delete(completion))
    return result
  }
}

describe('Browser-Native recovery storage', () => {
  it('reads canonical bounded owner and Workspace credentials', () => {
    const storage = new TestStorage(new Map([
      [ownerKey('session/one'), 'owner-token'],
      [workspaceKey('workspace-one'), JSON.stringify({
        workspaceId: 'workspace-one',
        writerToken: 'writer-token',
        fencingToken: 3,
        resumeId: '123e4567-e89b-12d3-a456-426614174000',
      })],
      ['unrelated-key', 'untouched'],
    ]))
    expect(readBrowserNativeRecoveryState(storage)).toEqual({
      owners: [{ sessionId: 'session/one', ownerToken: 'owner-token' }],
      workspaces: [{
        workspaceId: 'workspace-one',
        writerToken: 'writer-token',
        fencingToken: 3,
        resumeId: '123e4567-e89b-12d3-a456-426614174000',
      }],
      invalidKeys: [],
    })
  })

  it('rejects malformed owner escapes, noncanonical keys, empty ids, and oversized credentials', () => {
    const entries = new Map([
      ['dsh.browser-native.owner.%E0%A4%A', 'owner-token'],
      ['dsh.browser-native.owner.', 'owner-token'],
      [ownerKey('session-one'), 'x'.repeat(513)],
      [ownerKey('s'.repeat(257)), 'owner-token'],
      [`dsh.browser-native.owner.${encodeURIComponent('session one').replaceAll('%20', '+')}`, 'owner-token'],
    ])
    const state = readBrowserNativeRecoveryState(new TestStorage(entries))
    expect(state.owners).toEqual([])
    expect(state.invalidKeys).toHaveLength(entries.size)
  })

  it('rejects malformed, oversized, extra-key, and invalid-fencing Workspace records', () => {
    const entries = new Map([
      [workspaceKey('bad-json'), '{'],
      [workspaceKey('too-large'), 'x'.repeat(2049)],
      [workspaceKey('extra-key'), JSON.stringify({ workspaceId: 'extra-key', writerToken: 'token', fencingToken: 0, extra: true })],
      [workspaceKey('negative-fence'), JSON.stringify({ workspaceId: 'negative-fence', writerToken: 'token', fencingToken: -1 })],
      [workspaceKey('bad-resume'), JSON.stringify({ workspaceId: 'bad-resume', writerToken: 'token', fencingToken: 0, resumeId: 'bad' })],
      [workspaceKey('large-token'), JSON.stringify({ workspaceId: 'large-token', writerToken: 'x'.repeat(513), fencingToken: 0 })],
      [`dsh.browser-native.workspace-lease.${encodeURIComponent('different-id')}`, JSON.stringify({ workspaceId: 'other-id', writerToken: 'token', fencingToken: 0 })],
    ])
    const state = readBrowserNativeRecoveryState(new TestStorage(entries))
    expect(state.workspaces).toEqual([])
    expect(state.invalidKeys).toHaveLength(entries.size)
  })

  it('accepts the legacy lease record without a resume id for migration under lock', () => {
    const storage = new TestStorage(new Map([
      [workspaceKey('legacy'), JSON.stringify({ workspaceId: 'legacy', writerToken: 'token', fencingToken: 0 })],
    ]))
    expect(readBrowserNativeRecoveryState(storage).workspaces).toEqual([{
      workspaceId: 'legacy',
      writerToken: 'token',
      fencingToken: 0,
    }])
  })

  it('allows only one tab lock holder per Session or Workspace until release', async () => {
    const manager = new SharedLockManager()
    const first = new BrowserNativeRecoveryLocks(manager)
    const second = new BrowserNativeRecoveryLocks(manager)
    const resource = { kind: 'workspace', id: 'workspace-one' } as const

    expect(await first.acquireResource(resource)).toBe(true)
    expect(await second.acquireResource(resource)).toBe(false)
    first.releaseResource(resource)
    await manager.waitForIdle()
    expect(await second.acquireResource(resource)).toBe(true)
    second.releaseAll()
  })

  it('releases only locks acquired by a failed multi-resource recovery', async () => {
    const manager = new SharedLockManager()
    const workspaceOwner = new BrowserNativeRecoveryLocks(manager)
    const recoveringPage = new BrowserNativeRecoveryLocks(manager)
    const contender = new BrowserNativeRecoveryLocks(manager)
    const workspace: BrowserNativeRecoveryResource = { kind: 'workspace', id: 'workspace-one' }
    const existingSession: BrowserNativeRecoveryResource = { kind: 'session', id: 'session-existing' }
    const newSession: BrowserNativeRecoveryResource = { kind: 'session', id: 'session-new' }

    expect(await workspaceOwner.acquireResource(workspace)).toBe(true)
    expect(await recoveringPage.acquireResource(existingSession)).toBe(true)
    expect(await recoveringPage.acquireResources([workspace, newSession, existingSession])).toBe(false)
    expect(await contender.acquireResource(existingSession)).toBe(false)
    expect(await contender.acquireResource(newSession)).toBe(true)
    contender.releaseAll()
    recoveringPage.releaseAll()
    workspaceOwner.releaseAll()
  })

  it('cancels pending lock requests on release and does not acquire them late', async () => {
    const manager = new DeferredLockManager()
    const releasingPage = new BrowserNativeRecoveryLocks(manager)
    const nextPage = new BrowserNativeRecoveryLocks(manager)
    const resource = { kind: 'session', id: 'session-one' } as const
    const lockName = `dsh.browser-native.recovery.${resource.kind}.${encodeURIComponent(resource.id)}`

    const pending = releasingPage.acquireResource(resource)
    expect(manager.pendingCount).toBe(1)
    releasingPage.releaseAll()
    await expect(pending).resolves.toBe(false)
    expect(manager.pendingCount).toBe(1)
    expect(manager.grant(lockName)).toBe(true)
    await manager.waitForIdle()
    expect(manager.pendingCount).toBe(0)

    const nextAttempt = nextPage.acquireResource(resource)
    await manager.waitForRequest(lockName)
    expect(manager.grant(lockName)).toBe(true)
    await expect(nextAttempt).resolves.toBe(true)
    nextPage.releaseAll()
    await manager.waitForIdle()
  })

  it('rejects recovery when Web Locks are unavailable or resource identifiers are invalid', async () => {
    const unsupported = new BrowserNativeRecoveryLocks(undefined)
    const supported = new BrowserNativeRecoveryLocks(new SharedLockManager())

    expect(unsupported.supported).toBe(false)
    expect(await unsupported.acquireResource({ kind: 'session', id: 'session-one' })).toBe(false)
    expect(await supported.acquireResource({ kind: 'session', id: 'x'.repeat(257) })).toBe(false)
  })
})
