import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SESSION_APPEND_MAX_BYTES, SESSION_APPEND_MAX_EVENTS } from './session-transport-limits.mjs'

/** Prepare an event exactly as the Browser Session backend stores it.
 * @param event - DSH Session event to persist.
 * @returns The backend representation of the event.
 */
export function persistedSessionEvent(event: SessionEvent): SessionEvent {
  return event.type === 'browser-native/workspace-receipt'
    ? { ...event, ignorable: true as const }
    : event
}

/** Yield ordered Session append batches within the backend's wire limits.
 * @param events - Events to split without changing their order.
 * @returns Consecutive batches within the backend count and byte limits.
 * @throws {Error} If an event is not JSON serializable or exceeds the byte limit alone.
 */
export function* splitSessionAppendBatches(events: Iterable<SessionEvent>): Generator<SessionEvent[]> {
  let batch: SessionEvent[] = []
  let batchBytes = 2
  const encoder = new TextEncoder()

  for (const sourceEvent of events) {
    const event = persistedSessionEvent(sourceEvent)
    const serialized = JSON.stringify(event)
    if (serialized === undefined) throw new Error(`Session event ${event.seq} is not JSON serializable`)
    const eventBytes = encoder.encode(serialized).byteLength
    if (eventBytes + 2 > SESSION_APPEND_MAX_BYTES) {
      throw new Error(`Session event ${event.seq} exceeds the backend append byte limit`)
    }
    const nextBytes = batchBytes + eventBytes + (batch.length === 0 ? 0 : 1)
    if (batch.length > 0 && (batch.length >= SESSION_APPEND_MAX_EVENTS || nextBytes > SESSION_APPEND_MAX_BYTES)) {
      yield batch
      batch = []
      batchBytes = 2
    }
    batchBytes += eventBytes + (batch.length === 0 ? 0 : 1)
    batch.push(event)
  }

  if (batch.length > 0) yield batch
}
