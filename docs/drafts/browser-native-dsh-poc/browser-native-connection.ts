/**
 * Worker-side connectivity gate for Session requests.
 *
 * The page owns the `online`/`offline` window events and forwards them here;
 * `navigator.onLine` covers Worker-side transitions while no page frame runs.
 * A request that arrives without connectivity waits instead of failing, keeps
 * its original request id, and resumes after the connection returns in queue order.
 */
import { publishBrowserNativeOfflineStatus } from './browser-native-control.ts'
import type { BrowserNativeOfflineStatus } from './browser-native-control.ts'

const CONNECTIVITY_POLL_MS = 250

interface ConnectionWaiter {
  readonly signal: AbortSignal | undefined
  readonly abort: () => void
  readonly resume: () => void
}

let pageOnline: boolean | undefined
let queued = 0
let pollTimer: ReturnType<typeof setTimeout> | undefined
let waiters: ConnectionWaiter[] = []

/** Whether a Session request may be sent now. */
function connected(): boolean {
  return pageOnline !== false && globalThis.navigator?.onLine !== false
}

function publish(state: BrowserNativeOfflineStatus['state']): void {
  publishBrowserNativeOfflineStatus({ type: 'offline', state, queued })
}

function schedulePoll(): void {
  if (pollTimer !== undefined) return
  pollTimer = setTimeout(() => {
    pollTimer = undefined
    if (connected()) resumeWaiters()
    else if (waiters.length > 0) schedulePoll()
  }, CONNECTIVITY_POLL_MS)
}

function resumeWaiters(): void {
  if (!connected() || waiters.length === 0) return
  const pending = waiters
  waiters = []
  for (const waiter of pending) {
    waiter.signal?.removeEventListener('abort', waiter.abort)
    waiter.resume()
  }
  publish('replaying')
}

/** Apply the connectivity state forwarded by the owning page.
 * @param online Whether the page currently has network access.
 */
export function setBrowserNativeConnectionOnline(online: boolean): void {
  pageOnline = online
  if (online) resumeWaiters()
  else if (waiters.length > 0) schedulePoll()
}

/**
 * Hold one Session request until the connection returns.
 * @param signal Aborts the wait when the caller cancels the request.
 * @returns Resolves once connectivity is available; rejects with the abort reason.
 */
export function waitForBrowserNativeConnection(signal?: AbortSignal): Promise<void> {
  if (connected()) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(signal.reason)
  queued += 1
  publish('offline')
  return new Promise<void>((resolve, reject) => {
    const waiter: ConnectionWaiter = {
      signal,
      abort: () => {
        remove(waiter)
        reject(signal?.reason)
      },
      resume: () => {
        remove(waiter)
        resolve()
      },
    }
    waiters.push(waiter)
    signal?.addEventListener('abort', waiter.abort, { once: true })
    schedulePoll()
  }).finally(() => {
    queued = Math.max(0, queued - 1)
    publish(queued === 0 ? 'online' : connected() ? 'replaying' : 'offline')
  })
}

function remove(waiter: ConnectionWaiter): void {
  waiters = waiters.filter(current => current !== waiter)
}
