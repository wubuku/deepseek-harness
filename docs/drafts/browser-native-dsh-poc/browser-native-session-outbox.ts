/** IndexedDB journal for Session events awaiting the Browser-Native backend's durability watermark. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

const DEFAULT_DATABASE_NAME = 'dsh-browser-native-session-outbox-v1'
const DATABASE_VERSION = 2
const EVENTS_STORE = 'events'
const SESSIONS_STORE = 'sessions'
const META_STORE = 'meta'
const TOTALS_KEY = 'totals'
const MAX_TRACKED_SESSIONS = 256
const MAX_SESSION_PENDING_EVENTS = 8_192
const MAX_SESSION_PENDING_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_PENDING_EVENTS = 32_768
const MAX_TOTAL_PENDING_BYTES = 64 * 1024 * 1024

/** A durable local copy of Session events not yet covered by backend durability. */
export interface BrowserNativeSessionOutboxSnapshot {
  readonly ownerEpoch: number
  readonly writerId: string
  readonly pendingEvents: readonly SessionEvent[]
  readonly pendingBytes: number
}

/** Failure raised when the local Session outbox cannot safely accept or recover events. */
export class BrowserNativeSessionOutboxError extends Error {
  override readonly name = 'BrowserNativeSessionOutboxError'

  /** @param code - Stable outbox failure category. @param message - Safe diagnostic without Session payloads. @param options - Optional cause. */
  constructor(
    readonly code: 'SESSION_OUTBOX_UNAVAILABLE' | 'SESSION_OUTBOX_OWNER_STALE' | 'SESSION_OUTBOX_CONFLICT'
      | 'SESSION_OUTBOX_GAP' | 'SESSION_OUTBOX_CAPACITY' | 'SESSION_OUTBOX_CORRUPT',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

interface StoredSession {
  readonly sessionId: string
  readonly ownerEpoch: number
  readonly writerId: string
  readonly eventCount: number
  readonly pendingBytes: number
  readonly firstSeq?: number
  readonly lastSeq?: number
}

interface StoredEvent {
  readonly sessionId: string
  readonly seq: number
  readonly ownerEpoch: number
  readonly writerId: string
  readonly byteLength: number
  readonly event: SessionEvent
}

interface StoredTotals {
  readonly key: typeof TOTALS_KEY
  readonly eventCount: number
  readonly pendingBytes: number
}

interface EncodedEvent {
  readonly seq: number
  readonly byteLength: number
  readonly serialized: string
  readonly event: SessionEvent
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertIdentity(sessionId: string, ownerEpoch: number, writerId: string): void {
  if (sessionId.length === 0 || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1 || writerId.length === 0) {
    throw new TypeError('browser-native Session outbox: invalid writer identity')
  }
}

function encodeEvents(events: readonly SessionEvent[]): EncodedEvent[] {
  const encoder = new TextEncoder()
  const encoded: EncodedEvent[] = []
  let previousSeq: number | undefined
  for (const event of events) {
    const seq = Number(event.seq)
    if (!Number.isSafeInteger(seq) || seq < 0 || (previousSeq !== undefined && seq !== previousSeq + 1)) {
      throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_GAP', 'browser-native Session outbox: batch seq values are not contiguous')
    }
    const serialized = JSON.stringify(event)
    if (serialized === undefined) {
      throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_CORRUPT', `browser-native Session outbox: event ${String(seq)} is not JSON serializable`)
    }
    encoded.push({ seq, byteLength: encoder.encode(serialized).byteLength, serialized, event })
    previousSeq = seq
  }
  return encoded
}

function assertStoredSession(value: unknown, sessionId: string): asserts value is StoredSession {
  if (!isRecord(value) || value.sessionId !== sessionId || !Number.isSafeInteger(value.ownerEpoch)
    || Number(value.ownerEpoch) < 1 || typeof value.writerId !== 'string' || value.writerId.length === 0
    || !Number.isSafeInteger(value.eventCount) || Number(value.eventCount) < 0
    || !Number.isSafeInteger(value.pendingBytes) || Number(value.pendingBytes) < 0) {
    throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_CORRUPT', 'browser-native Session outbox: session metadata is invalid')
  }
  if (Number(value.eventCount) === 0) {
    if (value.firstSeq !== undefined || value.lastSeq !== undefined || Number(value.pendingBytes) !== 0) {
      throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_CORRUPT', 'browser-native Session outbox: empty session metadata has pending bounds')
    }
    return
  }
  if (!Number.isSafeInteger(value.firstSeq) || !Number.isSafeInteger(value.lastSeq)
    || Number(value.firstSeq) < 0 || Number(value.lastSeq) < Number(value.firstSeq)
    || Number(value.lastSeq) - Number(value.firstSeq) + 1 !== Number(value.eventCount)) {
    throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_CORRUPT', 'browser-native Session outbox: event bounds are not contiguous')
  }
}

function assertStoredTotals(value: unknown): asserts value is StoredTotals {
  if (!isRecord(value) || value.key !== TOTALS_KEY || !Number.isSafeInteger(value.eventCount)
    || Number(value.eventCount) < 0 || !Number.isSafeInteger(value.pendingBytes) || Number(value.pendingBytes) < 0) {
    throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_CORRUPT', 'browser-native Session outbox: global usage metadata is invalid')
  }
}

function isStoredEvent(value: unknown, sessionId: string): value is StoredEvent {
  if (!isRecord(value) || value.sessionId !== sessionId || !Number.isSafeInteger(value.seq)
    || Number(value.seq) < 0 || !Number.isSafeInteger(value.ownerEpoch) || Number(value.ownerEpoch) < 1
    || typeof value.writerId !== 'string' || value.writerId.length === 0
    || !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 0 || !isRecord(value.event)
    || value.event.seq !== value.seq || typeof value.event.type !== 'string' || !isRecord(value.event.data)) return false
  return true
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    transaction.oncomplete = () => {
      if (settled) return
      settled = true
      resolve()
    }
    transaction.onerror = () => {
      if (settled) return
      settled = true
      reject(transaction.error ?? new Error('browser-native Session outbox: IndexedDB transaction failed'))
    }
    transaction.onabort = () => {
      if (settled) return
      settled = true
      reject(transaction.error ?? new Error('browser-native Session outbox: IndexedDB transaction aborted'))
    }
  })
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new BrowserNativeSessionOutboxError('SESSION_OUTBOX_UNAVAILABLE', 'browser-native Session outbox: IndexedDB is unavailable'))
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, DATABASE_VERSION)
    request.onupgradeneeded = event => {
      if (!request.result.objectStoreNames.contains(EVENTS_STORE)) {
        request.result.createObjectStore(EVENTS_STORE, { keyPath: ['sessionId', 'seq'] })
      }
      if (!request.result.objectStoreNames.contains(SESSIONS_STORE)) {
        request.result.createObjectStore(SESSIONS_STORE, { keyPath: 'sessionId' })
      }
      if (event.oldVersion < 2) {
        const metadata = request.result.createObjectStore(META_STORE, { keyPath: 'key' })
        const sessions = request.transaction?.objectStore(SESSIONS_STORE)
        if (sessions === undefined) {
          request.transaction?.abort()
          return
        }
        let eventCount = 0
        let pendingBytes = 0
        const cursorRequest = sessions.openCursor()
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result
          if (cursor === null) {
            metadata.put({ key: TOTALS_KEY, eventCount, pendingBytes } satisfies StoredTotals)
            return
          }
          try {
            const sessionId = String(cursor.primaryKey)
            assertStoredSession(cursor.value, sessionId)
            eventCount += cursor.value.eventCount
            pendingBytes += cursor.value.pendingBytes
            cursor.continue()
          } catch {
            request.transaction?.abort()
          }
        }
      }
    }
    request.onsuccess = () => {
      const database = request.result
      if (database.version !== DATABASE_VERSION) {
        database.close()
        reject(new BrowserNativeSessionOutboxError('SESSION_OUTBOX_UNAVAILABLE', `browser-native Session outbox: unsupported IndexedDB version ${String(database.version)}`))
        return
      }
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => reject(request.error ?? new BrowserNativeSessionOutboxError(
      'SESSION_OUTBOX_UNAVAILABLE', 'browser-native Session outbox: IndexedDB open failed',
    ))
    request.onblocked = () => reject(new BrowserNativeSessionOutboxError(
      'SESSION_OUTBOX_UNAVAILABLE', 'browser-native Session outbox: IndexedDB open was blocked',
    ))
  })
}

/** IndexedDB journal for Browser-Native Session events awaiting server durability. */
export class BrowserNativeSessionOutbox {
  private databasePromise: Promise<IDBDatabase> | undefined
  private readonly databaseName: string
  private readonly maxTrackedSessions: number
  private readonly maxSessionPendingEvents: number
  private readonly maxSessionPendingBytes: number
  private readonly maxTotalPendingEvents: number
  private readonly maxTotalPendingBytes: number

  /**
   * @param options - Optional PoC database, capacity, and fault-injection settings.
   */
  constructor(private readonly options: {
    readonly databaseName?: string
    readonly maxTrackedSessions?: number
    readonly maxSessionPendingEvents?: number
    readonly maxSessionPendingBytes?: number
    readonly maxTotalPendingEvents?: number
    readonly maxTotalPendingBytes?: number
    readonly abortNextAppend?: () => boolean
    readonly abortNextProbe?: () => boolean
  } = {}) {
    this.databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME
    this.maxTrackedSessions = options.maxTrackedSessions ?? MAX_TRACKED_SESSIONS
    this.maxSessionPendingEvents = options.maxSessionPendingEvents ?? MAX_SESSION_PENDING_EVENTS
    this.maxSessionPendingBytes = options.maxSessionPendingBytes ?? MAX_SESSION_PENDING_BYTES
    this.maxTotalPendingEvents = options.maxTotalPendingEvents ?? MAX_TOTAL_PENDING_EVENTS
    this.maxTotalPendingBytes = options.maxTotalPendingBytes ?? MAX_TOTAL_PENDING_BYTES
    const limits = [
      this.maxTrackedSessions,
      this.maxSessionPendingEvents,
      this.maxSessionPendingBytes,
      this.maxTotalPendingEvents,
      this.maxTotalPendingBytes,
    ]
    if (this.databaseName.length === 0 || limits.some(limit => !Number.isSafeInteger(limit) || limit < 1)) {
      throw new TypeError('browser-native Session outbox: invalid database or capacity option')
    }
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= openDatabase(this.databaseName).catch(error => {
      this.databasePromise = undefined
      throw error
    })
    return this.databasePromise
  }

  /**
   * Verify that this Worker can commit a readwrite transaction in the outbox database.
   * @returns Settlement after a temporary metadata row has been written and removed atomically.
   * @throws BrowserNativeSessionOutboxError when the database cannot be opened or the transaction aborts.
   */
  async probe(): Promise<void> {
    try {
      const database = await this.database()
      const transaction = database.transaction(META_STORE, 'readwrite')
      const completed = transactionDone(transaction)
      const key = `probe:${crypto.randomUUID()}`
      const metadata = transaction.objectStore(META_STORE)
      metadata.put({ key, probe: true })
      metadata.delete(key)
      if (this.options.abortNextProbe?.() === true) transaction.abort()
      await completed
    } catch (cause) {
      if (cause instanceof BrowserNativeSessionOutboxError) throw cause
      throw new BrowserNativeSessionOutboxError(
        'SESSION_OUTBOX_UNAVAILABLE',
        'browser-native Session outbox: IndexedDB write probe did not commit',
        { cause },
      )
    }
  }

  /**
   * Fence this Worker instance against outbox writes from an older lease holder.
   * @param sessionId - DSH Session identifier.
   * @param ownerEpoch - Monotonic server writer lease epoch.
   * @param writerId - Random identifier for this Worker handle, never a bearer token.
   * @returns Settlement after the local claim is committed.
   */
  async claim(sessionId: string, ownerEpoch: number, writerId: string): Promise<void> {
    assertIdentity(sessionId, ownerEpoch, writerId)
    const database = await this.database()
    const transaction = database.transaction(SESSIONS_STORE, 'readwrite')
    let failure: unknown
    const completed = transactionDone(transaction).catch(error => { throw failure ?? error })
    const store = transaction.objectStore(SESSIONS_STORE)
    const request = store.get(sessionId)
    request.onsuccess = () => {
      try {
        if (request.result !== undefined) {
          assertStoredSession(request.result, sessionId)
          const current = request.result
          if (ownerEpoch < current.ownerEpoch) {
            throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_OWNER_STALE', 'browser-native Session outbox: writer lease epoch is stale')
          }
          store.put({ ...current, ownerEpoch, writerId })
        } else {
          const count = store.count()
          count.onsuccess = () => {
            if (count.result < this.maxTrackedSessions) {
              store.put({ sessionId, ownerEpoch, writerId, eventCount: 0, pendingBytes: 0 } satisfies StoredSession)
              return
            }
            const cursorRequest = store.openCursor()
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result
              if (cursor === null) {
                failure = new BrowserNativeSessionOutboxError(
                  'SESSION_OUTBOX_CAPACITY',
                  `browser-native Session outbox: ${String(this.maxTrackedSessions)} active or pending Session fences are retained`,
                )
                transaction.abort()
                return
              }
              try {
                const candidateId = String(cursor.primaryKey)
                assertStoredSession(cursor.value, candidateId)
                if (cursor.value.eventCount === 0) {
                  cursor.delete()
                  store.put({ sessionId, ownerEpoch, writerId, eventCount: 0, pendingBytes: 0 } satisfies StoredSession)
                  return
                }
                cursor.continue()
              } catch (error) {
                failure = error
                transaction.abort()
              }
            }
          }
        }
      } catch (error) {
        failure = error
        transaction.abort()
      }
    }
    await completed
  }

  /**
   * Persist an ordered event batch before its remote append can be attempted.
   * @param sessionId - DSH Session identifier.
   * @param ownerEpoch - Current server writer lease epoch.
   * @param writerId - Current Worker handle identifier.
   * @param events - Contiguous DSH Session events.
   * @returns Settlement after all new rows and metadata are committed atomically.
   */
  async append(sessionId: string, ownerEpoch: number, writerId: string, events: readonly SessionEvent[]): Promise<void> {
    assertIdentity(sessionId, ownerEpoch, writerId)
    const encoded = encodeEvents(events)
    if (encoded.length === 0) return
    const database = await this.database()
    const transaction = database.transaction([EVENTS_STORE, SESSIONS_STORE, META_STORE], 'readwrite')
    let failure: unknown
    const completed = transactionDone(transaction).catch(error => { throw failure ?? error })
    const eventStore = transaction.objectStore(EVENTS_STORE)
    const sessionStore = transaction.objectStore(SESSIONS_STORE)
    const totalsStore = transaction.objectStore(META_STORE)
    const metadataRequest = sessionStore.get(sessionId)
    const totalsRequest = totalsStore.get(TOTALS_KEY)
    let metadataValue: unknown
    let totalsValue: unknown
    let loaded = 0
    const start = (): void => {
      if (loaded !== 2) return
      try {
        if (metadataValue === undefined) {
          throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_OWNER_STALE', 'browser-native Session outbox: writer has no local claim')
        }
        assertStoredSession(metadataValue, sessionId)
        const metadata = metadataValue
        if (metadata.ownerEpoch !== ownerEpoch || metadata.writerId !== writerId) {
          throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_OWNER_STALE', 'browser-native Session outbox: writer instance was fenced')
        }
        assertStoredTotals(totalsValue)
        const totals = totalsValue
        const existingRequests = encoded.map(item => eventStore.get([sessionId, item.seq]))
        let remaining = existingRequests.length
        const existing = new Map<number, StoredEvent | undefined>()
        const finish = (): void => {
          try {
            const added = encoded.filter(item => existing.get(item.seq) === undefined)
            for (let index = 0; index < encoded.length; index += 1) {
              const prior = existing.get(encoded[index].seq)
              if (prior !== undefined && (JSON.stringify(prior.event) !== encoded[index].serialized
                || prior.byteLength !== encoded[index].byteLength)) {
                throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_CONFLICT', `browser-native Session outbox: seq ${String(encoded[index].seq)} has different event data`)
              }
            }
            if (added.length > 0) {
              const firstAdded = added[0].seq
              if ((metadata.lastSeq !== undefined && firstAdded !== metadata.lastSeq + 1)
                || added.some((item, index) => index > 0 && item.seq !== added[index - 1].seq + 1)) {
                throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_GAP', 'browser-native Session outbox: new events do not continue the pending suffix')
              }
            }
            const addedBytes = added.reduce((sum, item) => sum + item.byteLength, 0)
            if (metadata.eventCount + added.length > this.maxSessionPendingEvents
              || metadata.pendingBytes + addedBytes > this.maxSessionPendingBytes
              || totals.eventCount + added.length > this.maxTotalPendingEvents
              || totals.pendingBytes + addedBytes > this.maxTotalPendingBytes) {
              throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_CAPACITY', 'browser-native Session outbox: pending event capacity exceeded')
            }
            for (const item of added) {
              eventStore.put({
                sessionId,
                seq: item.seq,
                ownerEpoch,
                writerId,
                byteLength: item.byteLength,
                event: item.event,
              } satisfies StoredEvent)
            }
            if (added.length > 0) {
              sessionStore.put({
                ...metadata,
                eventCount: metadata.eventCount + added.length,
                pendingBytes: metadata.pendingBytes + addedBytes,
                firstSeq: metadata.firstSeq ?? added[0].seq,
                lastSeq: added[added.length - 1].seq,
              } satisfies StoredSession)
              totalsStore.put({
                key: TOTALS_KEY,
                eventCount: totals.eventCount + added.length,
                pendingBytes: totals.pendingBytes + addedBytes,
              } satisfies StoredTotals)
            }
            if (this.options.abortNextAppend?.() === true) transaction.abort()
          } catch (error) {
            failure = error
            transaction.abort()
          }
        }
        if (remaining === 0) {
          finish()
          return
        }
        existingRequests.forEach((request, index) => {
          request.onsuccess = () => {
            const value: unknown = request.result
            if (value !== undefined) {
              if (!isStoredEvent(value, sessionId)) {
                failure = new BrowserNativeSessionOutboxError('SESSION_OUTBOX_CORRUPT', 'browser-native Session outbox: existing event row is invalid')
                transaction.abort()
                return
              }
              existing.set(encoded[index].seq, value)
            } else {
              existing.set(encoded[index].seq, undefined)
            }
            remaining -= 1
            if (remaining === 0) finish()
          }
        })
      } catch (error) {
        failure = error
        transaction.abort()
      }
    }
    metadataRequest.onsuccess = () => {
      metadataValue = metadataRequest.result
      loaded += 1
      start()
    }
    totalsRequest.onsuccess = () => {
      totalsValue = totalsRequest.result
      loaded += 1
      start()
    }
    await completed
  }

  /**
   * Read and validate the complete locally pending Session suffix.
   * @param sessionId - DSH Session identifier.
   * @param ownerEpoch - Current server writer lease epoch.
   * @param writerId - Current Worker handle identifier.
   * @returns Validated pending events and their encoded byte count.
   */
  async read(sessionId: string, ownerEpoch: number, writerId: string): Promise<BrowserNativeSessionOutboxSnapshot> {
    assertIdentity(sessionId, ownerEpoch, writerId)
    const database = await this.database()
    const transaction = database.transaction([EVENTS_STORE, SESSIONS_STORE], 'readonly')
    const completed = transactionDone(transaction)
    const metadataRequest = transaction.objectStore(SESSIONS_STORE).get(sessionId)
    const eventsRequest = transaction.objectStore(EVENTS_STORE).getAll(
      IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]),
    )
    const [metadataValue, eventValues] = await Promise.all([
      new Promise<unknown>((resolve, reject) => {
        metadataRequest.onsuccess = () => resolve(metadataRequest.result)
        metadataRequest.onerror = () => reject(metadataRequest.error)
      }),
      new Promise<unknown[]>((resolve, reject) => {
        eventsRequest.onsuccess = () => resolve(eventsRequest.result)
        eventsRequest.onerror = () => reject(eventsRequest.error)
      }),
    ])
    await completed
    if (metadataValue === undefined) {
      if (eventValues.length > 0) throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_CORRUPT', 'browser-native Session outbox: event rows have no session metadata')
      throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_OWNER_STALE', 'browser-native Session outbox: writer has no local claim')
    }
    assertStoredSession(metadataValue, sessionId)
    if (metadataValue.ownerEpoch !== ownerEpoch || metadataValue.writerId !== writerId) {
      throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_OWNER_STALE', 'browser-native Session outbox: writer instance was fenced')
    }
    const records: StoredEvent[] = []
    const encoder = new TextEncoder()
    for (const value of eventValues) {
      if (!isStoredEvent(value, sessionId)) throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_CORRUPT', 'browser-native Session outbox: event row is invalid')
      const serialized = JSON.stringify(value.event)
      if (serialized === undefined || encoder.encode(serialized).byteLength !== value.byteLength) {
        throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_CORRUPT', `browser-native Session outbox: event ${String(value.seq)} byte count is invalid`)
      }
      records.push(value)
    }
    records.sort((left, right) => left.seq - right.seq)
    const byteLength = records.reduce((sum, record) => sum + record.byteLength, 0)
    if (records.length !== metadataValue.eventCount || byteLength !== metadataValue.pendingBytes
      || records.some((record, index) => index > 0 && record.seq !== records[index - 1].seq + 1)
      || (records.length > 0 && (records[0].seq !== metadataValue.firstSeq || records.at(-1)?.seq !== metadataValue.lastSeq))) {
      throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_CORRUPT', 'browser-native Session outbox: stored event rows do not match the indexed suffix')
    }
    return {
      ownerEpoch,
      writerId,
      pendingEvents: records.map(record => record.event),
      pendingBytes: byteLength,
    }
  }

  /**
   * Delete only events covered by an acknowledged backend durable watermark.
   * @param sessionId - DSH Session identifier.
   * @param ownerEpoch - Current server writer lease epoch.
   * @param writerId - Current Worker handle identifier.
   * @param durableThroughSeq - Inclusive backend durability watermark.
   * @returns Settlement after covered rows and metadata are committed atomically.
   */
  async acknowledgeThrough(sessionId: string, ownerEpoch: number, writerId: string, durableThroughSeq: number): Promise<void> {
    assertIdentity(sessionId, ownerEpoch, writerId)
    if (!Number.isSafeInteger(durableThroughSeq) || durableThroughSeq < -1) {
      throw new TypeError('browser-native Session outbox: invalid durable watermark')
    }
    if (durableThroughSeq < 0) return
    const database = await this.database()
    const transaction = database.transaction([EVENTS_STORE, SESSIONS_STORE, META_STORE], 'readwrite')
    let failure: unknown
    const completed = transactionDone(transaction).catch(error => { throw failure ?? error })
    const eventStore = transaction.objectStore(EVENTS_STORE)
    const sessionStore = transaction.objectStore(SESSIONS_STORE)
    const totalsStore = transaction.objectStore(META_STORE)
    const metadataRequest = sessionStore.get(sessionId)
    const totalsRequest = totalsStore.get(TOTALS_KEY)
    let metadataValue: unknown
    let totalsValue: unknown
    let loaded = 0
    const start = (): void => {
      if (loaded !== 2) return
      try {
        if (metadataValue === undefined) throw new BrowserNativeSessionOutboxError(
          'SESSION_OUTBOX_OWNER_STALE', 'browser-native Session outbox: writer has no local claim',
        )
        assertStoredSession(metadataValue, sessionId)
        const metadata = metadataValue
        assertStoredTotals(totalsValue)
        const totals = totalsValue
        if (metadata.ownerEpoch !== ownerEpoch || metadata.writerId !== writerId) {
          throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_OWNER_STALE', 'browser-native Session outbox: writer instance was fenced')
        }
        if (metadata.eventCount === 0 || metadata.firstSeq === undefined || metadata.firstSeq > durableThroughSeq) return
        const range = IDBKeyRange.bound([sessionId, 0], [sessionId, durableThroughSeq])
        const rowsRequest = eventStore.getAll(range)
        rowsRequest.onsuccess = () => {
          try {
            let removedCount = 0
            let removedBytes = 0
            const values: unknown[] = rowsRequest.result
            for (const value of values) {
              if (!isStoredEvent(value, sessionId)) throw new BrowserNativeSessionOutboxError(
                'SESSION_OUTBOX_CORRUPT', 'browser-native Session outbox: event row is invalid during acknowledgement',
              )
              if (value.seq > durableThroughSeq) continue
              eventStore.delete([sessionId, value.seq])
              removedCount += 1
              removedBytes += value.byteLength
            }
            const expectedRemoved = Math.min(metadata.lastSeq, durableThroughSeq) - metadata.firstSeq + 1
            if (removedCount !== expectedRemoved) throw new BrowserNativeSessionOutboxError(
              'SESSION_OUTBOX_CORRUPT', 'browser-native Session outbox: acknowledgement found a gap in stored event rows',
            )
            const eventCount = metadata.eventCount - removedCount
            const pendingBytes = metadata.pendingBytes - removedBytes
            if (totals.eventCount < removedCount || totals.pendingBytes < removedBytes) {
              throw new BrowserNativeSessionOutboxError('SESSION_OUTBOX_CORRUPT', 'browser-native Session outbox: global usage underflow during acknowledgement')
            }
            sessionStore.put(eventCount === 0
              ? { sessionId, ownerEpoch, writerId, eventCount: 0, pendingBytes: 0 } satisfies StoredSession
              : {
                  ...metadata,
                  eventCount,
                  pendingBytes,
                  firstSeq: durableThroughSeq + 1,
                } satisfies StoredSession)
            totalsStore.put({
              key: TOTALS_KEY,
              eventCount: totals.eventCount - removedCount,
              pendingBytes: totals.pendingBytes - removedBytes,
            } satisfies StoredTotals)
          } catch (error) {
            failure = error
            transaction.abort()
          }
        }
      } catch (error) {
        failure = error
        transaction.abort()
      }
    }
    metadataRequest.onsuccess = () => {
      metadataValue = metadataRequest.result
      loaded += 1
      start()
    }
    totalsRequest.onsuccess = () => {
      totalsValue = totalsRequest.result
      loaded += 1
      start()
    }
    await completed
  }
}
