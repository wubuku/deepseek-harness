/**
 * Admission control for the browser-native PoC backend.
 *
 * It is the shared authority for two limits that several browser tabs cannot
 * coordinate on their own: concurrent model turns and simultaneously mounted
 * Sessions. Turn requests queue in arrival order instead of being rejected, and
 * mounted Sessions are tracked as short leases that renew with the Session owner
 * lease and expire when a page disappears without closing.
 */

/** A rejected or timed-out admission request, reported with a retry hint. */
export class AdmissionError extends Error {
  /**
   * @param {string} code - Stable machine-readable failure code.
   * @param {string} message - Operator-facing explanation.
   * @param {number} status - HTTP status.
   * @param {number} [retryAfterMs] - Suggested retry delay.
   * @param {object} [details] - Extra structured context.
   */
  constructor(code, message, status = 429, retryAfterMs, details) {
    super(message)
    this.name = 'AdmissionError'
    this.code = code
    this.status = status
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
    if (details !== undefined) this.details = details
  }
}

const RECENT_ADMITTED_LIMIT = 32

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}

/**
 * Create the turn and mount admission controller.
 * @param {object} [config] - Limits and clock override.
 * @param {number} [config.maxConcurrentTurns] - Turns allowed to hold a model request at once.
 * @param {number} [config.maxMountedSessions] - Sessions allowed to hold an open owner lease.
 * @param {number} [config.queueTimeoutMs] - How long a queued turn waits before failing.
 * @param {number} [config.mountLeaseMs] - Mount lease duration, aligned with the Session owner lease.
 * @param {() => number} [config.now] - Clock used by tests.
 * @returns {object} Admission operations and an observable snapshot.
 */
export function createAdmissionController({
  maxConcurrentTurns = 8,
  maxMountedSessions = 16,
  queueTimeoutMs = 30_000,
  mountLeaseMs = 30_000,
  now = Date.now,
} = {}) {
  positiveInteger(maxConcurrentTurns, 'maxConcurrentTurns')
  positiveInteger(maxMountedSessions, 'maxMountedSessions')
  positiveInteger(queueTimeoutMs, 'queueTimeoutMs')
  positiveInteger(mountLeaseMs, 'mountLeaseMs')
  if (typeof now !== 'function') throw new Error('now must be a function')

  let activeTurns = 0
  let sequence = 0
  const waiters = []
  const mounts = new Map()
  const counters = { admitted: 0, completed: 0, timedOut: 0, aborted: 0, maxQueueWaitMs: 0, maxActiveTurns: 0 }
  const recentAdmitted = []

  function sweepMounts() {
    const current = now()
    for (const [sessionId, entry] of mounts) {
      if (entry.expiresAt <= current) mounts.delete(sessionId)
    }
  }

  function settle(waiter, outcome) {
    const index = waiters.indexOf(waiter)
    if (index < 0) return
    waiters.splice(index, 1)
    clearTimeout(waiter.timer)
    waiter.cleanup()
    if (outcome.error === undefined) waiter.resolve(outcome.lease)
    else waiter.reject(outcome.error)
  }

  function grant(waiter) {
    activeTurns += 1
    counters.maxActiveTurns = Math.max(counters.maxActiveTurns, activeTurns)
    counters.admitted += 1
    const waitedMs = now() - waiter.enqueuedAt
    counters.maxQueueWaitMs = Math.max(counters.maxQueueWaitMs, waitedMs)
    recentAdmitted.push({
      requestId: waiter.requestId,
      sessionId: waiter.sessionId,
      purpose: waiter.purpose,
      waitedMs,
    })
    if (recentAdmitted.length > RECENT_ADMITTED_LIMIT) recentAdmitted.shift()
    let released = false
    waiter.cleanup()
    clearTimeout(waiter.timer)
    waiter.resolve({
      waitedMs,
      release() {
        if (released) return
        released = true
        activeTurns -= 1
        counters.completed += 1
        drain()
      },
    })
  }

  function drain() {
    while (activeTurns < maxConcurrentTurns && waiters.length > 0) {
      const waiter = waiters.shift()
      waiter.cleanup()
      clearTimeout(waiter.timer)
      grant(waiter)
    }
  }

  /**
   * Wait for a turn slot. A request that arrives with a free slot runs immediately;
   * otherwise it joins the back of the FIFO queue.
   * @param {object} meta - Request identity for diagnostics.
   * @param {string} [meta.requestId] - Client request id from the LLM request body.
   * @param {string} [meta.sessionId] - Session that owns the request.
   * @param {string} [meta.purpose] - Model request purpose, if any.
   * @param {AbortSignal} [signal] - Aborts the request when its browser disconnects.
   * @returns {Promise<{waitedMs: number, release: () => void}>} Held slot release handle.
   */
  function acquireTurn(meta = {}, signal) {
    if (signal?.aborted === true) {
      return Promise.reject(new AdmissionError('ADMISSION_ABORTED', 'the request was aborted before admission', 499))
    }
    if (activeTurns < maxConcurrentTurns && waiters.length === 0) {
      return new Promise(resolve => {
        grant({
          requestId: meta.requestId,
          sessionId: meta.sessionId,
          purpose: meta.purpose,
          enqueuedAt: now(),
          resolve,
          reject() {},
          cleanup() {},
          timer: undefined,
        })
      })
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        sequence: (sequence += 1),
        requestId: meta.requestId,
        sessionId: meta.sessionId,
        purpose: meta.purpose,
        enqueuedAt: now(),
        resolve,
        reject,
        cleanup: () => {},
        timer: undefined,
      }
      const cancel = error => settle(waiter, { error })
      if (signal !== undefined) {
        const onAbort = () => {
          counters.aborted += 1
          cancel(new AdmissionError('ADMISSION_ABORTED', 'the request was aborted while queued', 499))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort)
      }
      waiter.timer = setTimeout(() => {
        counters.timedOut += 1
        cancel(new AdmissionError(
          'ADMISSION_TIMEOUT',
          `no model turn slot became available within ${String(queueTimeoutMs)} ms`,
          503,
          Math.floor(queueTimeoutMs / 4),
          { queuePosition: waiters.indexOf(waiter) + 1 },
        ))
      }, queueTimeoutMs)
      waiters.push(waiter)
    })
  }

  /**
   * Assert that one more Session can mount, without changing state.
   * @param {string} sessionId - Session about to take an owner lease.
   * @returns {void}
   */
  function assertMountAvailable(sessionId) {
    sweepMounts()
    if (mounts.has(sessionId)) return
    if (mounts.size >= maxMountedSessions) {
      throw new AdmissionError(
        'SESSION_MOUNT_LIMIT',
        `at most ${String(maxMountedSessions)} Sessions may be mounted at once`,
        429,
        5_000,
        { mounted: mounts.size, limit: maxMountedSessions },
      )
    }
  }

  /**
   * Register a mounted Session and start its lease.
   * @param {string} sessionId - Session that just took an owner lease.
   * @returns {void}
   */
  function mountSession(sessionId) {
    assertMountAvailable(sessionId)
    mounts.set(sessionId, { expiresAt: now() + mountLeaseMs })
  }

  /**
   * Refresh a mount lease with the Session owner renewal.
   * @param {string} sessionId - Session whose owner lease was renewed.
   * @returns {boolean} Whether the mount was already tracked.
   */
  function renewMount(sessionId) {
    sweepMounts()
    if (!mounts.has(sessionId)) {
      if (mounts.size >= maxMountedSessions) return false
      mounts.set(sessionId, { expiresAt: now() + mountLeaseMs })
      return true
    }
    mounts.set(sessionId, { expiresAt: now() + mountLeaseMs })
    return true
  }

  /**
   * Release a mount when its Session closes or hands off.
   * @param {string} sessionId - Session that no longer holds an owner lease.
   * @returns {void}
   */
  function releaseMount(sessionId) {
    mounts.delete(sessionId)
  }

  /**
   * Read observable admission state without changing it.
   * @returns {object} Active and queued turn counts, queue positions, mounts and counters.
   */
  function snapshot() {
    sweepMounts()
    const current = now()
    return {
      limits: { maxConcurrentTurns, maxMountedSessions, queueTimeoutMs, mountLeaseMs },
      activeTurns,
      queuedTurns: waiters.length,
      queue: waiters.map((waiter, index) => ({
        position: index + 1,
        sequence: waiter.sequence,
        requestId: waiter.requestId,
        sessionId: waiter.sessionId,
        purpose: waiter.purpose,
        queuedMs: current - waiter.enqueuedAt,
      })),
      mounts: { active: mounts.size, limit: maxMountedSessions, sessionIds: [...mounts.keys()] },
      counters: { ...counters },
      recentAdmitted: [...recentAdmitted],
    }
  }

  return { acquireTurn, assertMountAvailable, mountSession, renewMount, releaseMount, snapshot }
}
