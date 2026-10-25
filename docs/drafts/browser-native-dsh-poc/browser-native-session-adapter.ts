/**
 * Conformance guard for a Browser-Native Session projection.
 *
 * The guard is deliberately independent from the DSH persistence class. It
 * makes history-before-live, sequence continuity, duplicate replay, and
 * execution identity explicit at the Worker/page adapter seam.
 */

export interface BrowserNativeExecutionIdentity {
  readonly sessionId: string
  readonly backendId: string
  readonly workerInstanceId: string
  readonly ownerEpoch: number
}

export interface BrowserNativeSessionEvent {
  readonly seq: number
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
  readonly ignorable?: boolean
}

export interface BrowserNativeSessionCursorState {
  readonly historyComplete: boolean
  readonly nextSeq: number
  readonly acceptedEvents: number
  readonly duplicateEvents: number
  readonly identity: BrowserNativeExecutionIdentity
}

export type BrowserNativeSessionEventResult = 'accepted' | 'duplicate'

export class BrowserNativeSessionAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserNativeSessionAdapterError'
  }
}

function eventDigest(event: BrowserNativeSessionEvent): string {
  return JSON.stringify(event)
}

function assertSafeSequence(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BrowserNativeSessionAdapterError(`${name} must be a non-negative safe integer`)
  }
}

function assertIdentity(identity: BrowserNativeExecutionIdentity): void {
  if (identity.sessionId.length === 0 || identity.backendId.length === 0 || identity.workerInstanceId.length === 0) {
    throw new BrowserNativeSessionAdapterError('Session execution identity contains an empty identifier')
  }
  assertSafeSequence(identity.ownerEpoch, 'ownerEpoch')
}

function assertEvent(event: BrowserNativeSessionEvent): void {
  assertSafeSequence(event.seq, 'event.seq')
  if (event.type.length === 0) throw new BrowserNativeSessionAdapterError('Session event type is empty')
}

/**
 * Enforce the ordering rules used by a live Session projection.
 * @param identity - Session, backend, Worker and owner identity for this cursor.
 */
export class BrowserNativeSessionCursor {
  private historyComplete = false
  private nextSequence = 0
  private acceptedCount = 0
  private duplicateCount = 0
  private readonly digests = new Map<number, string>()

  constructor(private readonly identity: BrowserNativeExecutionIdentity) {
    assertIdentity(identity)
  }

  /**
   * Hydrate the complete history before accepting live events.
   * @param events - Events in the order returned by the Session authority.
   * @param expectedNextSeq - Authority cursor after the returned history.
   */
  hydrate(events: readonly BrowserNativeSessionEvent[], expectedNextSeq = events.length): void {
    if (this.historyComplete) throw new BrowserNativeSessionAdapterError('Session history was already hydrated')
    assertSafeSequence(expectedNextSeq, 'expectedNextSeq')
    for (const event of events) {
      assertEvent(event)
      if (event.seq !== this.nextSequence) {
        throw new BrowserNativeSessionAdapterError(
          `Session history has a sequence gap: expected ${String(this.nextSequence)}, received ${String(event.seq)}`,
        )
      }
      this.digests.set(event.seq, eventDigest(event))
      this.nextSequence += 1
      this.acceptedCount += 1
    }
    if (expectedNextSeq !== this.nextSequence) {
      throw new BrowserNativeSessionAdapterError(
        `Session history cursor mismatch: expected ${String(expectedNextSeq)}, received ${String(this.nextSequence)}`,
      )
    }
    this.historyComplete = true
  }

  /**
   * Accept one live event after history hydration.
   * @param event - Event delivered by the live Session channel.
   * @returns Whether the event advanced the cursor or was a duplicate replay.
   */
  acceptLive(event: BrowserNativeSessionEvent): BrowserNativeSessionEventResult {
    if (!this.historyComplete) throw new BrowserNativeSessionAdapterError('Live Session event arrived before history completed')
    assertEvent(event)
    const digest = eventDigest(event)
    if (event.seq < this.nextSequence) {
      if (this.digests.get(event.seq) !== digest) {
        throw new BrowserNativeSessionAdapterError(`Session event ${String(event.seq)} was replayed with different data`)
      }
      this.duplicateCount += 1
      return 'duplicate'
    }
    if (event.seq > this.nextSequence) {
      throw new BrowserNativeSessionAdapterError(
        `Session live event has a gap: expected ${String(this.nextSequence)}, received ${String(event.seq)}`,
      )
    }
    this.digests.set(event.seq, digest)
    this.nextSequence += 1
    this.acceptedCount += 1
    return 'accepted'
  }

  /**
   * Reject a message from a different execution owner.
   * @param identity - Identity carried by the incoming channel frame.
   */
  assertSameIdentity(identity: BrowserNativeExecutionIdentity): void {
    assertIdentity(identity)
    if (JSON.stringify(identity) !== JSON.stringify(this.identity)) {
      throw new BrowserNativeSessionAdapterError('Session execution identity changed during projection')
    }
  }

  /** Return an immutable diagnostic snapshot for tests and UI adapters. */
  snapshot(): BrowserNativeSessionCursorState {
    return Object.freeze({
      historyComplete: this.historyComplete,
      nextSeq: this.nextSequence,
      acceptedEvents: this.acceptedCount,
      duplicateEvents: this.duplicateCount,
      identity: this.identity,
    })
  }
}
