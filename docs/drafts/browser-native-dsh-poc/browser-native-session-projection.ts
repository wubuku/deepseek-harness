/**
 * Session-scoped read projection for the Browser-Native PoC.
 *
 * A source may publish values for several Sessions through one feed. The store
 * keeps only the bound Session's narrowed value and reads a baseline whenever
 * the binding or source changes. It never grants Session or Workspace write
 * authority.
 */

export interface BrowserNativeSessionProjectionSource {
  /** Read the current raw projection for one Session. */
  snapshot(sessionId: string): unknown
  /** Subscribe to raw projection changes from any Session. */
  subscribe(listener: (sessionId: string, value: unknown) => void): () => void
}

export interface BrowserNativeSessionProjectionStoreOptions<T> {
  /** Reject values that are not valid for the current projection key. */
  narrow(value: unknown, sessionId: string): T | undefined
  /** Report a source read failure without turning it into an empty snapshot. */
  onReadFailure?(error: unknown): void
}

const UNREAD: unique symbol = Symbol('unread')

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Own one Session's visible projection while the page switches mounts.
 * @typeParam T - Narrowed value exposed to the UI.
 */
export class BrowserNativeSessionProjectionStore<T> {
  private source: BrowserNativeSessionProjectionSource | undefined
  private sourceDisposer: (() => void) | undefined
  private boundSessionId: string | undefined
  private raw: unknown | typeof UNREAD = UNREAD
  private value: T | undefined
  private readonly listeners = new Set<() => void>()
  private warnedReadFailure = false

  constructor(private readonly options: BrowserNativeSessionProjectionStoreOptions<T>) {}

  /** Attach a feed and seed the currently bound Session, if any. */
  attach(source: BrowserNativeSessionProjectionSource): void {
    if (this.source === source) {
      this.reseed()
      return
    }
    this.sourceDisposer?.()
    this.sourceDisposer = undefined
    this.source = source
    this.sourceDisposer = source.subscribe((sessionId, value) => this.update(sessionId, value))
    this.warnedReadFailure = false
    if (this.boundSessionId !== undefined) this.readBaseline(this.boundSessionId, false)
  }

  /** Detach a feed and clear the currently visible value. */
  detach(source: BrowserNativeSessionProjectionSource): void {
    if (this.source !== source) return
    this.sourceDisposer?.()
    this.sourceDisposer = undefined
    this.source = undefined
    this.raw = UNREAD
    this.setValue(undefined)
  }

  /** Bind a Session and immediately seed its current projection. */
  bind(sessionId: string): void {
    if (sessionId.length === 0) throw new Error('Session projection binding requires a Session id')
    const changed = this.boundSessionId !== sessionId
    this.boundSessionId = sessionId
    if (changed) {
      this.raw = UNREAD
      this.setValue(undefined)
    }
    this.readBaseline(sessionId, false)
  }

  /** Remove the binding and clear the visible value. */
  unbind(): void {
    this.boundSessionId = undefined
    this.raw = UNREAD
    this.setValue(undefined)
  }

  /** Re-read the bound Session, including an intentionally absent value. */
  reseed(): void {
    const sessionId = this.boundSessionId
    if (sessionId === undefined) return
    this.readBaseline(sessionId, true)
  }

  /** Apply one source update only when it belongs to the bound Session. */
  update(sessionId: string, value: unknown): void {
    if (sessionId !== this.boundSessionId) return
    this.applyRaw(value, sessionId)
  }

  /** Return the Session currently bound to this store. */
  get sessionId(): string | undefined {
    return this.boundSessionId
  }

  /** Return the current narrowed read model. */
  read(): T | undefined {
    return this.value
  }

  /** Subscribe to visible value changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private readBaseline(sessionId: string, retainOnFailure: boolean): void {
    const source = this.source
    if (source === undefined) return
    try {
      this.applyRaw(source.snapshot(sessionId), sessionId)
    } catch (error) {
      if (!retainOnFailure) {
        this.raw = UNREAD
        this.setValue(undefined)
      }
      this.reportReadFailure(error)
    }
  }

  private applyRaw(raw: unknown, sessionId: string): void {
    if (this.raw !== UNREAD && Object.is(this.raw, raw)) return
    this.raw = raw
    this.setValue(this.options.narrow(raw, sessionId))
  }

  private setValue(value: T | undefined): void {
    if (Object.is(this.value, value)) return
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }

  private reportReadFailure(error: unknown): void {
    if (this.warnedReadFailure) return
    this.warnedReadFailure = true
    this.options.onReadFailure?.(new Error(`Session projection read failed: ${errorMessage(error)}`))
  }
}
