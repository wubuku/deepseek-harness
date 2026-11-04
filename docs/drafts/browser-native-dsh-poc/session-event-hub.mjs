/**
 * In-process fan-out for Session events.
 *
 * A viewer opens one subscription per Session and receives every batch the
 * backend appends after its replay window. The hub keeps no event history; the
 * caller replays from the Session log first and uses the hub only for live
 * deltas, so a dropped subscriber loses nothing that the log does not retain.
 */

class EventQueue {
  constructor() {
    this.items = []
    this.waiters = []
    this.closed = false
  }

  push(item) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(item)
    else this.items.push(item)
  }

  close() {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }

  next() {
    if (this.items.length > 0) return Promise.resolve(this.items.shift())
    if (this.closed) return Promise.resolve(undefined)
    return new Promise(resolve => { this.waiters.push(resolve) })
  }
}

/**
 * Per-Session subscriber registry for live event delivery.
 */
export class SessionEventHub {
  constructor() {
    this.queues = new Map()
  }

  /**
   * Register a live reader for one Session.
   * @param sessionId - Session identifier.
   * @returns {{next: () => Promise<object[] | undefined>, close: () => void}} Batch reader and disposer.
   */
  subscribe(sessionId) {
    const queue = new EventQueue()
    let queues = this.queues.get(sessionId)
    if (queues === undefined) {
      queues = new Set()
      this.queues.set(sessionId, queues)
    }
    queues.add(queue)
    let closed = false
    return {
      next: () => queue.next(),
      close: () => {
        if (closed) return
        closed = true
        queue.close()
        queues.delete(queue)
        if (queues.size === 0) this.queues.delete(sessionId)
      },
    }
  }

  /**
   * Deliver accepted append events to every live reader of the Session.
   * @param sessionId - Session identifier.
   * @param events - Events accepted by the append operation.
   */
  publish(sessionId, events) {
    if (events.length === 0) return
    for (const queue of this.queues.get(sessionId) ?? []) queue.push(events)
  }
}
