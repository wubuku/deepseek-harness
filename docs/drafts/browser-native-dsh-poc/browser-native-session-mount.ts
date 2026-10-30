import {
  BrowserNativeSessionCursor,
  BrowserNativeSessionAdapterError,
  type BrowserNativeExecutionIdentity,
  type BrowserNativeSessionEvent,
  type BrowserNativeSessionCursorState,
} from './browser-native-session-adapter.ts'

export type BrowserNativeSessionMountView = 'active' | 'parked' | 'detached'
export type BrowserNativeSessionAvailability = 'available' | 'occupied' | 'busy' | 'unavailable'
export type BrowserNativeSessionExecutionState = 'idle' | 'running' | 'waiting' | 'settled' | 'unknown'

export interface BrowserNativeSessionMountOptions {
  readonly sessionId: string
  readonly identity: BrowserNativeExecutionIdentity
  readonly ownerId?: string
  readonly availability?: BrowserNativeSessionAvailability
}

export interface BrowserNativeSessionExecutionSnapshot {
  readonly executionId: string
  readonly state: BrowserNativeSessionExecutionState
  readonly lateResults: number
  readonly outcome?: BrowserNativeSessionExecutionOutcome
}

export interface BrowserNativeSessionExecutionOutcome {
  readonly settlement: 'confirmed' | 'failed' | 'unknown'
  readonly message?: string
}

export interface BrowserNativeSessionMountSnapshot {
  readonly sessionId: string
  readonly view: BrowserNativeSessionMountView
  readonly availability: BrowserNativeSessionAvailability
  readonly ownerId?: string
  readonly cursor: BrowserNativeSessionCursorState
  readonly execution?: BrowserNativeSessionExecutionSnapshot
}

export class BrowserNativeSessionMountError extends Error {
  constructor(
    readonly code: 'SESSION_NOT_MOUNTED' | 'SESSION_MOUNT_OCCUPIED' | 'SESSION_MOUNT_BUSY'
      | 'SESSION_MOUNT_UNAVAILABLE' | 'SESSION_MOUNT_NOT_ACTIVE' | 'SESSION_EXECUTION_ACTIVE'
      | 'SESSION_EXECUTION_UNKNOWN' | 'SESSION_MOUNT_DISPOSED' | 'SESSION_IDENTITY_INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'BrowserNativeSessionMountError'
  }
}

interface ExecutionRecord {
  readonly executionId: string
  state: BrowserNativeSessionExecutionState
  lateResults: number
  outcome?: BrowserNativeSessionExecutionOutcome
}

interface MountRecord {
  readonly sessionId: string
  identity: BrowserNativeExecutionIdentity
  ownerId?: string
  availability: BrowserNativeSessionAvailability
  view: BrowserNativeSessionMountView
  cursor: BrowserNativeSessionCursor
  execution?: ExecutionRecord
}

function assertIdentifier(value: string, name: string): void {
  if (value.length === 0) throw new BrowserNativeSessionMountError('SESSION_IDENTITY_INVALID', `${name} is required`)
}

function assertMountIdentity(sessionId: string, identity: BrowserNativeExecutionIdentity): void {
  assertIdentifier(sessionId, 'sessionId')
  if (identity.sessionId !== sessionId) {
    throw new BrowserNativeSessionMountError('SESSION_IDENTITY_INVALID', 'Session identity does not match the mount')
  }
}

function executionSnapshot(execution: ExecutionRecord | undefined): BrowserNativeSessionExecutionSnapshot | undefined {
  if (execution === undefined) return undefined
  return Object.freeze({
    executionId: execution.executionId,
    state: execution.state,
    lateResults: execution.lateResults,
    ...(execution.outcome === undefined ? {} : { outcome: execution.outcome }),
  })
}

function mountSnapshot(mount: MountRecord): BrowserNativeSessionMountSnapshot {
  return Object.freeze({
    sessionId: mount.sessionId,
    view: mount.view,
    availability: mount.availability,
    ...(mount.ownerId === undefined ? {} : { ownerId: mount.ownerId }),
    cursor: mount.cursor.snapshot(),
    ...(mount.execution === undefined ? {} : { execution: executionSnapshot(mount.execution) }),
  })
}

/**
 * Coordinate page-local Session projections without owning the DSH Agent Loop.
 * Parked mounts keep their execution state, while page disposal changes every
 * unresolved execution to unknown and prevents late callbacks from settling it.
 */
export class BrowserNativeSessionMountCoordinator {
  private readonly mounts = new Map<string, MountRecord>()
  private activeSessionId: string | undefined
  private disposed = false

  /** Add a Session projection and optionally claim its current page owner. */
  mount(options: BrowserNativeSessionMountOptions): BrowserNativeSessionMountSnapshot {
    this.assertLive()
    assertMountIdentity(options.sessionId, options.identity)
    if (options.ownerId !== undefined) assertIdentifier(options.ownerId, 'ownerId')
    const existing = this.mounts.get(options.sessionId)
    if (existing !== undefined) {
      if (existing.ownerId !== undefined && existing.ownerId !== options.ownerId) {
        throw new BrowserNativeSessionMountError('SESSION_MOUNT_OCCUPIED', `Session "${options.sessionId}" has another owner`)
      }
      if (JSON.stringify(existing.identity) !== JSON.stringify(options.identity)) {
        throw new BrowserNativeSessionMountError('SESSION_IDENTITY_INVALID', `Session "${options.sessionId}" identity changed without reconnect`)
      }
      return mountSnapshot(existing)
    }
    const mount: MountRecord = {
      sessionId: options.sessionId,
      identity: options.identity,
      ownerId: options.ownerId,
      availability: options.availability ?? 'available',
      view: 'parked',
      cursor: new BrowserNativeSessionCursor(options.identity),
    }
    this.mounts.set(options.sessionId, mount)
    return mountSnapshot(mount)
  }

  /** Make one mounted Session the visible prompt target. */
  activate(sessionId: string): BrowserNativeSessionMountSnapshot {
    const target = this.record(sessionId)
    this.assertActivatable(target)
    if (this.activeSessionId !== undefined && this.activeSessionId !== sessionId) {
      const current = this.mounts.get(this.activeSessionId)
      if (current !== undefined && current.view === 'active') current.view = 'parked'
    }
    target.view = 'active'
    this.activeSessionId = sessionId
    return mountSnapshot(target)
  }

  /** Park a visible Session without cancelling its model, tool, or HITL execution. */
  park(sessionId: string): BrowserNativeSessionMountSnapshot {
    const target = this.record(sessionId)
    if (target.view === 'active') {
      target.view = 'parked'
      if (this.activeSessionId === sessionId) this.activeSessionId = undefined
    }
    return mountSnapshot(target)
  }

  /** Set the authority-reported availability without treating it as a generic retryable error. */
  setAvailability(sessionId: string, availability: BrowserNativeSessionAvailability): BrowserNativeSessionMountSnapshot {
    const target = this.record(sessionId)
    target.availability = availability
    if (availability !== 'available' && target.view === 'active') {
      target.view = 'parked'
      if (this.activeSessionId === sessionId) this.activeSessionId = undefined
    }
    return mountSnapshot(target)
  }

  /** Load Session history before the mount accepts live events. */
  hydrate(sessionId: string, events: readonly BrowserNativeSessionEvent[], expectedNextSeq = events.length): void {
    this.record(sessionId).cursor.hydrate(events, expectedNextSeq)
  }

  /** Accept a live event after checking the current Session execution identity. */
  acceptLive(
    sessionId: string,
    identity: BrowserNativeExecutionIdentity,
    event: BrowserNativeSessionEvent,
  ): 'accepted' | 'duplicate' {
    const target = this.record(sessionId)
    if (target.availability === 'unavailable') {
      throw new BrowserNativeSessionMountError('SESSION_MOUNT_UNAVAILABLE', `Session "${sessionId}" requires reconnect`)
    }
    try {
      target.cursor.assertSameIdentity(identity)
      return target.cursor.acceptLive(event)
    } catch (error) {
      if (error instanceof BrowserNativeSessionAdapterError && !error.message.includes('before history')) {
        target.availability = 'unavailable'
        if (target.view === 'active') {
          target.view = 'parked'
          if (this.activeSessionId === sessionId) this.activeSessionId = undefined
        }
      }
      throw error
    }
  }

  /** Rehydrate a mount after Worker replacement with a new execution identity. */
  reconnect(
    sessionId: string,
    identity: BrowserNativeExecutionIdentity,
    ownerId: string,
    events: readonly BrowserNativeSessionEvent[],
    expectedNextSeq = events.length,
  ): BrowserNativeSessionMountSnapshot {
    this.assertLive()
    const target = this.record(sessionId)
    assertMountIdentity(sessionId, identity)
    assertIdentifier(ownerId, 'ownerId')
    if (target.ownerId !== undefined && target.ownerId !== ownerId) {
      throw new BrowserNativeSessionMountError('SESSION_MOUNT_OCCUPIED', `Session "${sessionId}" has another owner`)
    }
    const cursor = new BrowserNativeSessionCursor(identity)
    cursor.hydrate(events, expectedNextSeq)
    target.identity = identity
    target.ownerId = ownerId
    target.cursor = cursor
    target.availability = 'available'
    if (target.execution?.state === 'running' || target.execution?.state === 'waiting') {
      target.execution.state = 'unknown'
      target.execution.outcome = { settlement: 'unknown', message: 'previous Worker was replaced' }
    }
    return mountSnapshot(target)
  }

  /** Begin an execution for any available owned Session, regardless of its visible view. */
  beginExecution(sessionId: string, executionId: string, state: 'running' | 'waiting' = 'running'): BrowserNativeSessionMountSnapshot {
    const target = this.record(sessionId)
    this.assertActivatable(target)
    assertIdentifier(executionId, 'executionId')
    if (target.execution !== undefined && ['running', 'waiting'].includes(target.execution.state)) {
      throw new BrowserNativeSessionMountError('SESSION_EXECUTION_ACTIVE', `Session "${sessionId}" already has an active execution`)
    }
    target.execution = { executionId, state, lateResults: 0 }
    return mountSnapshot(target)
  }

  /** Move an execution between running and waiting without changing its owner. */
  setExecutionState(sessionId: string, executionId: string, state: 'running' | 'waiting'): BrowserNativeSessionMountSnapshot {
    const target = this.record(sessionId)
    const execution = this.execution(target, executionId)
    if (execution.state === 'unknown' || execution.state === 'settled') {
      throw new BrowserNativeSessionMountError('SESSION_EXECUTION_UNKNOWN', `Execution "${executionId}" is already settled`)
    }
    execution.state = state
    return mountSnapshot(target)
  }

  /** Settle an execution once; a late result after unknown is recorded but ignored. */
  settleExecution(sessionId: string, executionId: string, outcome: BrowserNativeSessionExecutionOutcome): boolean {
    const target = this.mounts.get(sessionId)
    if (target === undefined) throw new BrowserNativeSessionMountError('SESSION_NOT_MOUNTED', `Session "${sessionId}" is not mounted`)
    const execution = this.execution(target, executionId)
    if (execution.state === 'unknown' || execution.state === 'settled') {
      execution.lateResults += 1
      return false
    }
    execution.outcome = Object.freeze({ ...outcome })
    execution.state = 'settled'
    return true
  }

  /** Dispose the page-local coordinator and convert unresolved work to unknown. */
  dispose(message = 'page or Worker was disposed'): readonly BrowserNativeSessionMountSnapshot[] {
    if (this.disposed) return this.snapshots()
    this.disposed = true
    this.activeSessionId = undefined
    for (const mount of this.mounts.values()) {
      if (mount.execution !== undefined && ['running', 'waiting'].includes(mount.execution.state)) {
        mount.execution.state = 'unknown'
        mount.execution.outcome = { settlement: 'unknown', message }
      }
      mount.view = 'detached'
      mount.ownerId = undefined
      mount.availability = 'unavailable'
    }
    return this.snapshots()
  }

  /** Return the current mount set in stable Session order. */
  snapshots(): readonly BrowserNativeSessionMountSnapshot[] {
    return Object.freeze([...this.mounts.values()]
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      .map(mountSnapshot))
  }

  private assertLive(): void {
    if (this.disposed) throw new BrowserNativeSessionMountError('SESSION_MOUNT_DISPOSED', 'Session mount coordinator was disposed')
  }

  private record(sessionId: string): MountRecord {
    this.assertLive()
    const mount = this.mounts.get(sessionId)
    if (mount === undefined) throw new BrowserNativeSessionMountError('SESSION_NOT_MOUNTED', `Session "${sessionId}" is not mounted`)
    return mount
  }

  private assertActivatable(mount: MountRecord): void {
    if (mount.availability === 'occupied') throw new BrowserNativeSessionMountError('SESSION_MOUNT_OCCUPIED', `Session "${mount.sessionId}" is occupied`)
    if (mount.availability === 'busy') throw new BrowserNativeSessionMountError('SESSION_MOUNT_BUSY', `Session "${mount.sessionId}" is busy`)
    if (mount.availability === 'unavailable') throw new BrowserNativeSessionMountError('SESSION_MOUNT_UNAVAILABLE', `Session "${mount.sessionId}" is unavailable`)
    if (mount.ownerId === undefined) throw new BrowserNativeSessionMountError('SESSION_MOUNT_OCCUPIED', `Session "${mount.sessionId}" has no writable owner`)
  }

  private execution(mount: MountRecord, executionId: string): ExecutionRecord {
    const execution = mount.execution
    if (execution === undefined || execution.executionId !== executionId) {
      throw new BrowserNativeSessionMountError('SESSION_EXECUTION_UNKNOWN', `Execution "${executionId}" is not mounted on Session "${mount.sessionId}"`)
    }
    return execution
  }
}
