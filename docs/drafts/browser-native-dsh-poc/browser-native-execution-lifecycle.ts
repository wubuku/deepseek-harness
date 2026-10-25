/**
 * Explicit cancellation and disposal settlement for Browser-Native execution.
 *
 * This state machine does not cancel network requests itself. The owner calls
 * the underlying AbortController and uses this class to prevent an unknown or
 * late result from being presented as a confirmed business outcome.
 */

export type BrowserNativeSettlement = 'confirmed' | 'unknown' | 'failed'
export type BrowserNativeExecutionPhase = 'running' | 'cancelling' | 'settled' | 'disposed'

export interface BrowserNativeExecutionOutcome {
  readonly settlement: BrowserNativeSettlement
  readonly source: 'provider' | 'cancel' | 'dispose' | 'owner-lost' | 'worker-terminated'
  readonly message?: string
}

export interface BrowserNativeExecutionLifecycleSnapshot {
  readonly executionId: string
  readonly phase: BrowserNativeExecutionPhase
  readonly cancelRequested: boolean
  readonly disposeCount: number
  readonly lateResults: number
  readonly outcome?: BrowserNativeExecutionOutcome
}

export class BrowserNativeExecutionLifecycleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserNativeExecutionLifecycleError'
  }
}

/** Track one model/tool/HITL execution until a durable settlement exists. */
export class BrowserNativeExecutionLifecycle {
  private phase: BrowserNativeExecutionPhase = 'running'
  private cancelRequested = false
  private disposeCount = 0
  private lateResultCount = 0
  private outcome: BrowserNativeExecutionOutcome | undefined

  constructor(readonly executionId: string) {
    if (executionId.length === 0) throw new BrowserNativeExecutionLifecycleError('executionId is required')
  }

  /** Request cancellation without claiming that the underlying side effect stopped. */
  cancel(): boolean {
    if (this.phase === 'disposed' || this.phase === 'settled') return false
    if (this.cancelRequested) return false
    this.cancelRequested = true
    this.phase = 'cancelling'
    return true
  }

  /** Dispose the local waiter; an in-flight result becomes unknown. */
  dispose(message = 'execution owner was disposed'): BrowserNativeExecutionOutcome | undefined {
    this.disposeCount += 1
    if (this.phase === 'settled' || this.phase === 'disposed') return this.outcome
    this.phase = 'disposed'
    this.outcome ??= { settlement: 'unknown', source: 'dispose', message }
    return this.outcome
  }

  /** Record the provider result exactly once. */
  settle(outcome: BrowserNativeExecutionOutcome): boolean {
    if (this.phase === 'disposed' || this.phase === 'settled') return false
    if (this.outcome !== undefined) return false
    this.outcome = Object.freeze({ ...outcome })
    this.phase = 'settled'
    return true
  }

  /** Mark a callback that arrived after cancellation, disposal, or settlement. */
  recordLateResult(): void {
    this.lateResultCount += 1
  }

  /** Convert loss of the execution owner into an explicit unknown outcome. */
  markOwnerLost(message = 'execution owner was fenced'): BrowserNativeExecutionOutcome | undefined {
    if (this.phase === 'settled' || this.phase === 'disposed') return this.outcome
    this.settle({ settlement: 'unknown', source: 'owner-lost', message })
    return this.outcome
  }

  /** Return state for a receipt, Session event, or UI projection. */
  snapshot(): BrowserNativeExecutionLifecycleSnapshot {
    return Object.freeze({
      executionId: this.executionId,
      phase: this.phase,
      cancelRequested: this.cancelRequested,
      disposeCount: this.disposeCount,
      lateResults: this.lateResultCount,
      ...(this.outcome === undefined ? {} : { outcome: this.outcome }),
    })
  }
}
