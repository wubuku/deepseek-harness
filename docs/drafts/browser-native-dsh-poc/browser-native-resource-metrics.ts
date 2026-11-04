/**
 * Listener and timer counters for long-run Worker resource checks.
 *
 * The counters wrap the globals after the Node timer shims are installed, so
 * long-running Session cycles can compare live registrations instead of only
 * observing heap growth. Counts are diagnostic: `once` and `AbortSignal`
 * listeners auto-remove without passing through `removeEventListener`, so
 * `live` is an upper bound and the harness asserts bounded growth between idle
 * checkpoints rather than an exact zero.
 */

export interface BrowserNativeResourceMetrics {
  readonly listeners: {
    readonly added: number
    readonly removed: number
    readonly live: number
    readonly liveByType: Readonly<Record<string, number>>
  }
  readonly timers: {
    readonly scheduled: number
    readonly cancelled: number
    readonly fired: number
    readonly live: number
  }
}

interface MutableMetrics {
  listeners: { added: number; removed: number; live: number; liveByType: Map<string, number> }
  timers: { scheduled: number; cancelled: number; fired: number }
}

type TimerHandler = ((...args: never[]) => unknown) | string
type Scheduler = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => unknown
type Clear = (handle?: unknown) => void

interface Registration {
  readonly wrapped: EventListener
}

const INSTALL_KEY = Symbol.for('dsh.browser-native.resource-metrics')
let installed: MutableMetrics | undefined
let liveTimers: Set<unknown> | undefined

/**
 * Snapshot listener and timer counts accumulated since Worker startup.
 * @returns A frozen copy of the current counters.
 */
export function readBrowserNativeResourceMetrics(): BrowserNativeResourceMetrics {
  const metrics = installed ?? { listeners: { added: 0, removed: 0, live: 0, liveByType: new Map<string, number>() }, timers: { scheduled: 0, cancelled: 0, fired: 0 } }
  return Object.freeze({
    listeners: Object.freeze({ ...metrics.listeners, liveByType: Object.freeze(Object.fromEntries(metrics.listeners.liveByType)) }),
    timers: Object.freeze({ ...metrics.timers, live: liveTimers?.size ?? 0 }),
  })
}

/**
 * Install listener and timer counters on the Worker global scope. Reinstalling
 * is a no-op so a test channel cannot double-count the same registration.
 */
export function installBrowserNativeResourceMetrics(): void {
  if (installed !== undefined) return
  const scope = globalThis as Record<string, unknown>
  if (scope[INSTALL_KEY] === true) return
  scope[INSTALL_KEY] = true
  const metrics: MutableMetrics = {
    listeners: { added: 0, removed: 0, live: 0, liveByType: new Map() },
    timers: { scheduled: 0, cancelled: 0, fired: 0 },
  }
  installed = metrics

  const targetPrototype = EventTarget.prototype as EventTarget & Record<PropertyKey, unknown>
  const addListener = targetPrototype.addEventListener as (
    this: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean,
  ) => void
  const removeListener = targetPrototype.removeEventListener as (
    this: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean,
  ) => void
  const registrations = new WeakMap<EventTarget, Map<string, Map<EventListenerOrEventListenerObject, Registration>>>()

  const normalize = (options?: AddEventListenerOptions | boolean): { capture: boolean; once: boolean; signal?: AbortSignal } => {
    if (typeof options === 'boolean') return { capture: options, once: false }
    return { capture: options?.capture === true, once: options?.once === true, signal: options?.signal }
  }
  const keyFor = (type: string, capture: boolean): string => `${type}|${capture ? 'capture' : 'bubble'}`
  const lookup = (target: EventTarget, type: string, listener: EventListenerOrEventListenerObject, capture: boolean) =>
    registrations.get(target)?.get(keyFor(type, capture))?.get(listener)

  targetPrototype.addEventListener = function addEventListener(
    this: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean,
  ): void {
    const normalized = normalize(options)
    if (normalized.signal?.aborted) {
      addListener.call(this, type, listener, options)
      return
    }
    const key = keyFor(type, normalized.capture)
    let byType = registrations.get(this)
    if (byType === undefined) {
      byType = new Map()
      registrations.set(this, byType)
    }
    let byListener = byType.get(key)
    if (byListener === undefined) {
      byListener = new Map()
      byType.set(key, byListener)
    }
    if (byListener.has(listener)) {
      addListener.call(this, type, listener, options)
      return
    }
    const removeRegistration = () => {
      if (byListener?.delete(listener) === true) {
        metrics.listeners.live -= 1
        metrics.listeners.removed += 1
        metrics.listeners.liveByType.set(type, (metrics.listeners.liveByType.get(type) ?? 1) - 1)
      }
    }
    const invoke = (event: Event) => {
      if (typeof listener === 'function') return listener.call(this, event)
      return listener.handleEvent(event)
    }
    const wrapped: EventListener =
      normalized.once
        ? (event) => {
            removeRegistration()
            invoke(event)
          }
        : (event) => { invoke(event) }
    byListener.set(listener, { wrapped })
    metrics.listeners.added += 1
    metrics.listeners.live += 1
    metrics.listeners.liveByType.set(type, (metrics.listeners.liveByType.get(type) ?? 0) + 1)
    addListener.call(this, type, wrapped, options)
    normalized.signal?.addEventListener('abort', removeRegistration, { once: true })
  }
  targetPrototype.removeEventListener = function removeEventListener(
    this: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean,
  ): void {
    const capture = typeof options === 'boolean' ? options : options?.capture === true
    const entry = lookup(this, type, listener, capture)
    if (entry === undefined) {
      removeListener.call(this, type, listener, options)
      return
    }
    removeListener.call(this, type, entry.wrapped, options)
    const byListener = registrations.get(this)?.get(keyFor(type, capture))
    if (byListener?.delete(listener) === true) {
      metrics.listeners.live -= 1
      metrics.listeners.removed += 1
      metrics.listeners.liveByType.set(type, (metrics.listeners.liveByType.get(type) ?? 1) - 1)
    }
  }

  const setTimeoutRaw = scope.setTimeout as Scheduler
  const setIntervalRaw = scope.setInterval as Scheduler
  const clearTimeoutRaw = scope.clearTimeout as Clear
  const clearIntervalRaw = scope.clearInterval as Clear
  const timers = new Set<unknown>()
  liveTimers = timers

  scope.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (typeof handler !== 'function') return setTimeoutRaw(handler, timeout, ...args)
    let handle: unknown
    const wrapped = (...callbackArgs: never[]) => {
      timers.delete(handle)
      metrics.timers.fired += 1
      return handler(...callbackArgs)
    }
    handle = setTimeoutRaw(wrapped, timeout, ...args)
    timers.add(handle)
    metrics.timers.scheduled += 1
    return handle
  }) as Scheduler
  scope.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const handle = setIntervalRaw(handler, timeout, ...args)
    timers.add(handle)
    metrics.timers.scheduled += 1
    return handle
  }) as Scheduler
  scope.clearTimeout = ((handle?: unknown) => {
    if (timers.delete(handle)) metrics.timers.cancelled += 1
    clearTimeoutRaw(handle)
  }) as Clear
  scope.clearInterval = ((handle?: unknown) => {
    if (timers.delete(handle)) metrics.timers.cancelled += 1
    clearIntervalRaw(handle)
  }) as Clear
}
