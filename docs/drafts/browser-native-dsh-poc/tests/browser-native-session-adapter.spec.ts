import { describe, expect, it } from 'vitest'
import {
  BrowserNativeSessionAdapterError,
  BrowserNativeSessionCursor,
  type BrowserNativeSessionEvent,
} from '../browser-native-session-adapter.ts'

const identity = {
  sessionId: 'session-1',
  backendId: 'backend-1',
  workerInstanceId: 'worker-1',
  ownerEpoch: 1,
} as const

function event(seq: number, text: string): BrowserNativeSessionEvent {
  return { seq, type: 'assistant/message', data: { text } }
}

describe('Browser-Native Session adapter conformance', () => {
  it('requires complete history before live events and de-duplicates replay', () => {
    const cursor = new BrowserNativeSessionCursor(identity)
    expect(() => cursor.acceptLive(event(0, 'early'))).toThrow(/before history/)

    cursor.hydrate([event(0, 'hello'), event(1, 'world')], 2)
    expect(cursor.acceptLive(event(1, 'world'))).toBe('duplicate')
    expect(cursor.acceptLive(event(2, 'after reconnect'))).toBe('accepted')
    expect(cursor.snapshot()).toMatchObject({
      historyComplete: true,
      nextSeq: 3,
      acceptedEvents: 3,
      duplicateEvents: 1,
    })
  })

  it('fails closed on gaps, mismatched replay and history cursor errors', () => {
    const cursor = new BrowserNativeSessionCursor(identity)
    expect(() => cursor.hydrate([event(1, 'gap')], 2)).toThrow(BrowserNativeSessionAdapterError)

    cursor.hydrate([event(0, 'hello')], 1)
    expect(() => cursor.acceptLive(event(2, 'gap'))).toThrow(/gap/)
    expect(() => cursor.acceptLive(event(0, 'changed'))).toThrow(/different data/)

    const mismatch = new BrowserNativeSessionCursor(identity)
    expect(() => mismatch.hydrate([event(0, 'hello')], 0)).toThrow(/cursor mismatch/)
  })

  it('rejects a frame from a different backend, Worker or owner epoch', () => {
    const cursor = new BrowserNativeSessionCursor(identity)
    cursor.hydrate([])
    expect(() => cursor.assertSameIdentity({ ...identity, workerInstanceId: 'worker-2' })).toThrow(/identity changed/)
    expect(() => cursor.assertSameIdentity({ ...identity, ownerEpoch: 2 })).toThrow(/identity changed/)
  })
})
