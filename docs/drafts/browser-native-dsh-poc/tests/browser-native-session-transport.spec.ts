import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SESSION_APPEND_MAX_BYTES, SESSION_APPEND_MAX_EVENTS } from '../session-transport-limits.mjs'
import { splitSessionAppendBatches } from '../browser-native-session-transport.ts'

function attempt(seq: number, padding = ''): SessionEvent<'assistant/attempt'> {
  return {
    seq: seq as SessionEvent<'assistant/attempt'>['seq'],
    time: 1_700_000_000_000 + seq,
    type: 'assistant/attempt',
    data: {
      turn: seq + 1,
      step: 1,
      stream: padding === '' ? [] : [{ type: 'text-chunks', time0: 1_700_000_000_000, index: 0, dt: [0], texts: [padding] }],
    },
  }
}

function jsonBytes(events: readonly SessionEvent[]): number {
  return new TextEncoder().encode(JSON.stringify(events)).byteLength
}

describe('Browser-Native Session transport batching', () => {
  it('splits by event count without changing sequence order', () => {
    const events = Array.from({ length: SESSION_APPEND_MAX_EVENTS + 7 }, (_, seq) => attempt(seq))
    const batches = [...splitSessionAppendBatches(events)]

    expect(batches.map(batch => batch.length)).toEqual([SESSION_APPEND_MAX_EVENTS, 7])
    expect(batches.flat().map(event => event.seq)).toEqual(events.map(event => event.seq))
    expect(batches.every(batch => jsonBytes(batch) <= SESSION_APPEND_MAX_BYTES)).toBe(true)
  })

  it('splits by UTF-8 JSON byte size and refuses one oversized event', () => {
    const first = attempt(0, '汉'.repeat(180_000))
    const second = attempt(1, '界'.repeat(180_000))
    const batches = [...splitSessionAppendBatches([first, second])]
    expect(batches).toHaveLength(2)
    expect(batches.every(batch => jsonBytes(batch) <= SESSION_APPEND_MAX_BYTES)).toBe(true)
    expect(() => [...splitSessionAppendBatches([attempt(2, 'x'.repeat(SESSION_APPEND_MAX_BYTES))])])
      .toThrow(/exceeds the backend append byte limit/)
  })
})
