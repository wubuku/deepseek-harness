/**
 * PoC-local owner handoff and fencing coordinator.
 *
 * It models the explicit Browser-to-Cloud transfer point. It does not keep a
 * Worker alive, run a background task, or copy in-memory Agent state.
 */

export interface BrowserNativeOwnerLease {
  readonly sessionId: string
  readonly ownerId: string
  readonly epoch: number
  readonly fencingToken: number
}

export interface BrowserNativeHandoffCheckpoint {
  readonly sessionId: string
  readonly ownerId: string
  readonly epoch: number
  readonly nextSessionSeq: number
  readonly workspaceRevision: number
  readonly pendingOperationIds: readonly string[]
  readonly pendingExecutionIds: readonly string[]
}

export interface BrowserNativeHandoffReceipt {
  readonly sessionId: string
  readonly previous: BrowserNativeOwnerLease
  readonly next: BrowserNativeOwnerLease
  readonly checkpoint: BrowserNativeHandoffCheckpoint
}

export class BrowserNativeHandoffError extends Error {
  constructor(readonly code: 'OWNER_ACTIVE' | 'OWNER_STALE' | 'CHECKPOINT_INVALID' | 'SESSION_MISMATCH', message: string) {
    super(message)
    this.name = 'BrowserNativeHandoffError'
  }
}

function assertCounter(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new BrowserNativeHandoffError('CHECKPOINT_INVALID', `${name} is invalid`)
}

/** Serialize one owner transfer with strict old-owner fencing. */
export class BrowserNativeHandoffCoordinator {
  private current: BrowserNativeOwnerLease | undefined
  private nextEpoch = 0
  private nextFencingToken = 0

  constructor(readonly sessionId: string) {
    if (sessionId.length === 0) throw new BrowserNativeHandoffError('SESSION_MISMATCH', 'sessionId is required')
  }

  /** Claim an idle session for one execution owner. */
  claim(ownerId: string): BrowserNativeOwnerLease {
    if (ownerId.length === 0) throw new BrowserNativeHandoffError('SESSION_MISMATCH', 'ownerId is required')
    if (this.current !== undefined) throw new BrowserNativeHandoffError('OWNER_ACTIVE', 'Session already has an active owner')
    const lease = Object.freeze({
      sessionId: this.sessionId,
      ownerId,
      epoch: ++this.nextEpoch,
      fencingToken: ++this.nextFencingToken,
    })
    this.current = lease
    return lease
  }

  /** Assert that a mutation belongs to the current owner and fencing token. */
  assertCurrent(owner: BrowserNativeOwnerLease): void {
    if (this.current === undefined || JSON.stringify(owner) !== JSON.stringify(this.current)) {
      throw new BrowserNativeHandoffError('OWNER_STALE', 'Owner epoch or fencing token is stale')
    }
  }

  /** Transfer ownership only after a checkpoint from the current owner. */
  handoff(owner: BrowserNativeOwnerLease, checkpoint: BrowserNativeHandoffCheckpoint, nextOwnerId: string): BrowserNativeHandoffReceipt {
    this.assertCurrent(owner)
    if (checkpoint.sessionId !== this.sessionId || checkpoint.ownerId !== owner.ownerId || checkpoint.epoch !== owner.epoch) {
      throw new BrowserNativeHandoffError('CHECKPOINT_INVALID', 'Handoff checkpoint does not identify the current owner')
    }
    assertCounter(checkpoint.nextSessionSeq, 'nextSessionSeq')
    assertCounter(checkpoint.workspaceRevision, 'workspaceRevision')
    if (nextOwnerId.length === 0) throw new BrowserNativeHandoffError('CHECKPOINT_INVALID', 'nextOwnerId is required')
    const next = Object.freeze({
      sessionId: this.sessionId,
      ownerId: nextOwnerId,
      epoch: ++this.nextEpoch,
      fencingToken: ++this.nextFencingToken,
    })
    this.current = next
    return Object.freeze({ sessionId: this.sessionId, previous: owner, next, checkpoint: Object.freeze({ ...checkpoint }) })
  }

  /** Release the current owner; a later claim receives a higher fence. */
  release(owner: BrowserNativeOwnerLease): void {
    this.assertCurrent(owner)
    this.current = undefined
  }

  /** Return the current owner only for diagnostics and tests. */
  currentOwner(): BrowserNativeOwnerLease | undefined {
    return this.current
  }
}
