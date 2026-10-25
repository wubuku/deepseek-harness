import { describe, expect, it } from 'vitest'
import { readSessionPages } from '../browser-native-session-read.ts'

interface TestEvent {
  readonly seq: number
  readonly value: string
}

function event(seq: number): TestEvent {
  return { seq, value: `event-${seq}` }
}

describe('Browser-Native Session read pagination', () => {
  it('aggregates pages without exceeding the backend page limit', async () => {
    const events = Array.from({ length: 4_201 }, (_, seq) => event(seq))
    const requests: Array<{ offset: number; length: number }> = []
    const result = await readSessionPages(async (offset, length) => {
      requests.push({ offset, length })
      const page = events.slice(offset, offset + length)
      return {
        events: page,
        eventState: 'shared-frozen',
        nextSeq: events.length,
        hasMore: offset + page.length < events.length,
      }
    }, 0, Number.MAX_SAFE_INTEGER)

    expect(requests).toEqual([
      { offset: 0, length: 2_048 },
      { offset: 2_048, length: 2_048 },
      { offset: 4_096, length: 2_048 },
    ])
    expect(result).toEqual({ events, eventState: 'shared-frozen', nextSeq: 4_201 })
  })

  it('continues after a short page when the backend reports more events', async () => {
    const events = Array.from({ length: 1_701 }, (_, seq) => event(seq))
    const offsets: number[] = []
    const result = await readSessionPages(async (offset, length) => {
      offsets.push(offset)
      const page = events.slice(offset, offset + Math.min(length, 700))
      return {
        events: page,
        eventState: 'detached',
        nextSeq: events.length,
        hasMore: offset + page.length < events.length,
      }
    }, 0, 2_000)

    expect(offsets).toEqual([0, 700, 1_400])
    expect(result.events).toEqual(events)
    expect(result.eventState).toBe('detached')
  })

  it('preserves empty reads and rejects inconsistent pages', async () => {
    const empty = await readSessionPages(async () => ({
      events: [],
      eventState: 'shared-frozen',
      nextSeq: 3,
      hasMore: false,
    }), 3, 10)
    expect(empty).toEqual({ events: [], eventState: 'shared-frozen', nextSeq: 3 })

    await expect(readSessionPages(async () => ({
      events: [event(1)],
      eventState: 'shared-frozen',
      nextSeq: 2,
      hasMore: false,
    }), 0, 2)).rejects.toThrow(/sequence gap/)

    let pageIndex = 0
    await expect(readSessionPages(async offset => {
      pageIndex += 1
      return {
        events: [event(offset)],
        eventState: pageIndex === 1 ? 'detached' : 'shared-frozen',
        nextSeq: 2,
        hasMore: true,
      }
    }, 0, 2)).rejects.toThrow(/ownership state/)
  })
})
