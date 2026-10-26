const OWNER_STORAGE_PREFIX = 'dsh.browser-native.owner.'
const WORKSPACE_LEASE_STORAGE_PREFIX = 'dsh.browser-native.workspace-lease.'
const MAX_IDENTIFIER_BYTES = 256
const MAX_TOKEN_BYTES = 512
const MAX_WORKSPACE_RECORD_BYTES = 2048

interface PendingRecoveryLock {
  cancelled: boolean
  readonly resolveAcquired: (acquired: boolean) => void
  release?: () => void
}

/** Return the sessionStorage key used for a Session owner recovery token.
 * @param sessionId The Session identity whose owner token is stored.
 * @returns The canonical, encoded key for that Session.
 */
export function browserNativeOwnerStorageKey(sessionId: string): string {
  return `${OWNER_STORAGE_PREFIX}${encodeURIComponent(sessionId)}`
}

/** Return the sessionStorage key used for a Workspace lease recovery record.
 * @param workspaceId The Workspace identity whose lease is stored.
 * @returns The canonical, encoded key for that Workspace.
 */
export function browserNativeWorkspaceLeaseStorageKey(workspaceId: string): string {
  return `${WORKSPACE_LEASE_STORAGE_PREFIX}${encodeURIComponent(workspaceId)}`
}

/** A page-scoped lock key for one resumable Browser-Native writer. */
export interface BrowserNativeRecoveryResource {
  readonly kind: 'session' | 'workspace'
  readonly id: string
}

/** A validated Session owner token loaded from tab-scoped storage. */
export interface BrowserNativeOwnerRecovery {
  readonly sessionId: string
  readonly ownerToken: string
}

/** A validated Workspace writer lease loaded from tab-scoped storage. */
export interface BrowserNativeWorkspaceRecovery {
  readonly workspaceId: string
  readonly writerToken: string
  readonly fencingToken: number
  readonly resumeId?: string
}

/** Recovery records and malformed storage keys found in one tab. */
export interface BrowserNativeRecoveryState {
  readonly owners: readonly BrowserNativeOwnerRecovery[]
  readonly workspaces: readonly BrowserNativeWorkspaceRecovery[]
  readonly invalidKeys: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxBytes
    && new TextEncoder().encode(value).byteLength <= maxBytes
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function parseWorkspaceRecovery(key: string, raw: string): BrowserNativeWorkspaceRecovery | undefined {
  if (raw.length > MAX_WORKSPACE_RECORD_BYTES) return undefined
  if (new TextEncoder().encode(raw).byteLength > MAX_WORKSPACE_RECORD_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isPlainRecord(value)) return undefined
  const required = ['workspaceId', 'writerToken', 'fencingToken']
  const optional = ['resumeId']
  const allowed = new Set([...required, ...optional])
  if (!required.every(field => Object.hasOwn(value, field)) || Object.keys(value).some(field => !allowed.has(field))) {
    return undefined
  }
  if (!isBoundedString(value.workspaceId, MAX_IDENTIFIER_BYTES)
    || key !== browserNativeWorkspaceLeaseStorageKey(value.workspaceId)
    || !isBoundedString(value.writerToken, MAX_TOKEN_BYTES)
    || typeof value.fencingToken !== 'number' || !Number.isSafeInteger(value.fencingToken) || value.fencingToken < 0
    || (Object.hasOwn(value, 'resumeId') && !isUuid(value.resumeId))) {
    return undefined
  }
  return {
    workspaceId: value.workspaceId,
    writerToken: value.writerToken,
    fencingToken: value.fencingToken,
    ...(typeof value.resumeId === 'string' ? { resumeId: value.resumeId } : {}),
  }
}

/** Read only bounded, canonical recovery credentials from one tab's sessionStorage.
 * @param storage The tab-scoped storage area to inspect.
 * @returns Valid credentials and keys that must not be forwarded to a Worker.
 */
export function readBrowserNativeRecoveryState(
  storage: Pick<Storage, 'length' | 'key' | 'getItem'>,
): BrowserNativeRecoveryState {
  const owners: BrowserNativeOwnerRecovery[] = []
  const workspaces: BrowserNativeWorkspaceRecovery[] = []
  const invalidKeys: string[] = []
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
  for (const key of keys) {
    if (key === null) continue
    if (key.startsWith(OWNER_STORAGE_PREFIX)) {
      const encodedSessionId = key.slice(OWNER_STORAGE_PREFIX.length)
      if (encodedSessionId.length === 0 || encodedSessionId.length > MAX_IDENTIFIER_BYTES * 3) {
        invalidKeys.push(key)
        continue
      }
      let sessionId: string
      try {
        sessionId = decodeURIComponent(encodedSessionId)
      } catch {
        invalidKeys.push(key)
        continue
      }
      const ownerToken = storage.getItem(key)
      if (!isBoundedString(sessionId, MAX_IDENTIFIER_BYTES)
        || key !== browserNativeOwnerStorageKey(sessionId)
        || !isBoundedString(ownerToken, MAX_TOKEN_BYTES)) {
        invalidKeys.push(key)
        continue
      }
      owners.push({ sessionId, ownerToken })
      continue
    }
    if (key.startsWith(WORKSPACE_LEASE_STORAGE_PREFIX)) {
      const raw = storage.getItem(key)
      const workspace = raw === null ? undefined : parseWorkspaceRecovery(key, raw)
      if (workspace === undefined) invalidKeys.push(key)
      else workspaces.push(workspace)
    }
  }
  owners.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  workspaces.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))
  return { owners, workspaces, invalidKeys }
}

/** Coordinate recovery of Browser-Native writer credentials across same-origin tabs. */
export class BrowserNativeRecoveryLocks {
  private readonly held = new Map<string, () => void>()
  private readonly pending = new Map<string, Promise<boolean>>()
  private readonly requests = new Map<string, PendingRecoveryLock>()
  private readonly completions = new Map<string, Promise<void>>()
  private readonly releasing = new Map<string, Promise<void>>()

  /** Create a lock set backed by the browser Web Locks API when available.
   * @param lockManager The origin-scoped lock manager, or `undefined` when unsupported.
   */
  constructor(private readonly lockManager: Pick<LockManager, 'request'> | undefined) {}

  /** Whether this browser can coordinate recovery between same-origin tabs.
   * @returns Whether a Web Locks manager was provided.
   */
  get supported(): boolean {
    return this.lockManager !== undefined
  }

  /** Acquire a stable, exclusive lock for each recovery resource in sorted order.
   * @param resources Session and Workspace identities whose credentials will be resumed.
   * @returns `true` when every lock is held; on conflict, releases locks acquired by this set.
   */
  async acquireResources(resources: readonly BrowserNativeRecoveryResource[]): Promise<boolean> {
    const ordered = [...new Map(resources.map(resource => [this.name(resource), resource])).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
    const acquired: string[] = []
    for (const [name, resource] of ordered) {
      const alreadyHeld = this.held.has(name)
      if (!await this.acquire(name, resource)) {
        for (const acquiredName of acquired) this.release(acquiredName)
        return false
      }
      if (!alreadyHeld) acquired.push(name)
    }
    return true
  }

  /** Acquire one resource lock, reusing a lock already held by this page.
   * @param resource The Session or Workspace writer identity.
   * @returns Whether this page owns the lock.
   */
  async acquireResource(resource: BrowserNativeRecoveryResource): Promise<boolean> {
    return await this.acquire(this.name(resource), resource)
  }

  /** Release one resource lock after its Worker stops using the credential.
   * @param resource The Session or Workspace writer identity.
   */
  releaseResource(resource: BrowserNativeRecoveryResource): void {
    this.release(this.name(resource))
  }

  /** Release every lock owned by this page. */
  releaseAll(): void {
    const names = new Set([...this.held.keys(), ...this.requests.keys(), ...this.pending.keys()])
    for (const name of names) this.release(name)
  }

  private async acquire(name: string, resource: BrowserNativeRecoveryResource): Promise<boolean> {
    const releasing = this.releasing.get(name)
    if (releasing !== undefined) {
      await releasing
      if (this.releasing.get(name) === releasing) this.releasing.delete(name)
    }
    if (this.held.has(name)) return true
    const pending = this.pending.get(name)
    if (pending !== undefined) return await pending
    const request = this.requestLock(name, resource)
    this.pending.set(name, request)
    try {
      return await request
    } finally {
      if (this.pending.get(name) === request) this.pending.delete(name)
    }
  }

  private async requestLock(name: string, resource: BrowserNativeRecoveryResource): Promise<boolean> {
    if (this.lockManager === undefined || !isBoundedString(resource.id, MAX_IDENTIFIER_BYTES)) return false
    let resolveAcquired!: (acquired: boolean) => void
    const acquired = new Promise<boolean>((resolve) => { resolveAcquired = resolve })
    let releaseLock = (): void => {}
    const hold = new Promise<void>((resolve) => { releaseLock = resolve })
    const state: PendingRecoveryLock = {
      cancelled: false,
      resolveAcquired,
    }
    this.requests.set(name, state)
    let request: Promise<void>
    try {
      request = this.lockManager.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (lock === null || state.cancelled) {
          resolveAcquired(false)
          return
        }
        state.release = releaseLock
        if (state.cancelled) {
          releaseLock()
          resolveAcquired(false)
          return
        }
        resolveAcquired(true)
        await hold
      })
    } catch {
      this.requests.delete(name)
      return false
    }
    const completion = request.then(() => {}, () => {})
    this.completions.set(name, completion)
    void completion.then(() => {
      if (this.requests.get(name) === state) this.requests.delete(name)
      if (this.completions.get(name) === completion) this.completions.delete(name)
      if (this.releasing.get(name) === completion) this.releasing.delete(name)
    })
    void request.catch(() => { resolveAcquired(false) })
    if (!await acquired || state.cancelled) {
      releaseLock()
      return false
    }
    this.held.set(name, releaseLock)
    return true
  }

  private release(name: string): void {
    const release = this.held.get(name)
    const state = this.requests.get(name)
    if (release === undefined && state === undefined) return
    this.held.delete(name)
    const completion = this.completions.get(name)
    if (completion !== undefined) this.releasing.set(name, completion)
    if (state !== undefined) {
      state.cancelled = true
      state.resolveAcquired(false)
      state.release?.()
    }
    release?.()
  }

  private name(resource: BrowserNativeRecoveryResource): string {
    return `dsh.browser-native.recovery.${resource.kind}.${encodeURIComponent(resource.id)}`
  }
}
