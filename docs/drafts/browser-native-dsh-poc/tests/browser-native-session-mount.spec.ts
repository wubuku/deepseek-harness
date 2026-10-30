import { describe, expect, it } from 'vitest'
import {
  BrowserNativeSessionMountCoordinator,
  BrowserNativeSessionMountError,
} from '../browser-native-session-mount.ts'
import type { BrowserNativeSessionEvent } from '../browser-native-session-adapter.ts'

function identity(sessionId: string, workerInstanceId = 'worker-1', ownerEpoch = 1) {
  return { sessionId, backendId: 'backend-1', workerInstanceId, ownerEpoch } as const
}

function event(seq: number, text: string): BrowserNativeSessionEvent {
  return { seq, type: 'assistant/message', data: { text } }
}

function coordinator(): BrowserNativeSessionMountCoordinator {
  const mounts = new BrowserNativeSessionMountCoordinator()
  for (const sessionId of ['session-a', 'session-b', 'session-c']) {
    mounts.mount({ sessionId, identity: identity(sessionId), ownerId: 'page-1' })
    mounts.hydrate(sessionId, [event(0, `${sessionId}:history`)], 1)
  }
  return mounts
}

describe('Browser-Native Session mount coordinator', () => {
  it('parks a running Session while another Session becomes active', () => {
    const mounts = coordinator()
    mounts.activate('session-a')
    mounts.beginExecution('session-a', 'turn-a')
    mounts.activate('session-b')

    expect(mounts.snapshots()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'session-a', view: 'parked', execution: expect.objectContaining({ state: 'running' }) }),
      expect.objectContaining({ sessionId: 'session-b', view: 'active' }),
    ]))
    expect(mounts.acceptLive('session-a', identity('session-a'), event(1, 'a-live'))).toBe('accepted')
    expect(mounts.acceptLive('session-b', identity('session-b'), event(1, 'b-live'))).toBe('accepted')
  })

  it('starts a parked owned Session without changing the visible projection', () => {
    const mounts = coordinator()
    mounts.activate('session-a')
    const parked = mounts.beginExecution('session-b', 'turn-b')

    expect(parked).toMatchObject({ sessionId: 'session-b', view: 'parked', execution: { state: 'running' } })
    expect(mounts.snapshots().find(snapshot => snapshot.sessionId === 'session-a')).toMatchObject({ view: 'active' })
  })

  it('keeps history-before-live and duplicate replay rules per Session', () => {
    const mounts = new BrowserNativeSessionMountCoordinator()
    mounts.mount({ sessionId: 'session-a', identity: identity('session-a'), ownerId: 'page-1' })
    expect(() => mounts.acceptLive('session-a', identity('session-a'), event(0, 'early'))).toThrow(/before history/)
    mounts.hydrate('session-a', [event(0, 'history')], 1)
    expect(mounts.acceptLive('session-a', identity('session-a'), event(0, 'history'))).toBe('duplicate')
    expect(mounts.acceptLive('session-a', identity('session-a'), event(1, 'live'))).toBe('accepted')
    expect(() => mounts.acceptLive('session-a', identity('session-a'), event(3, 'gap'))).toThrow(/gap/)
    expect(mounts.snapshots()[0]).toMatchObject({ availability: 'unavailable', view: 'parked' })
  })

  it('fails closed for occupied, busy, and unavailable Session states', () => {
    const mounts = new BrowserNativeSessionMountCoordinator()
    mounts.mount({ sessionId: 'occupied', identity: identity('occupied'), availability: 'occupied' })
    mounts.mount({ sessionId: 'busy', identity: identity('busy'), ownerId: 'page-1', availability: 'busy' })
    mounts.mount({ sessionId: 'unavailable', identity: identity('unavailable'), ownerId: 'page-1', availability: 'unavailable' })
    expect(() => mounts.activate('occupied')).toThrow(BrowserNativeSessionMountError)
    expect(() => mounts.activate('busy')).toThrow(/busy/)
    expect(() => mounts.activate('unavailable')).toThrow(/unavailable/)
  })

  it('rehydrates with a new Worker identity and rejects the old identity', () => {
    const mounts = coordinator()
    mounts.activate('session-a')
    mounts.beginExecution('session-a', 'turn-a')
    const reconnected = mounts.reconnect('session-a', identity('session-a', 'worker-2', 2), 'page-1', [event(0, 'history'), event(1, 'last')], 2)
    expect(reconnected).toMatchObject({
      view: 'active',
      cursor: { identity: { workerInstanceId: 'worker-2', ownerEpoch: 2 }, nextSeq: 2 },
      execution: { state: 'unknown', outcome: { settlement: 'unknown' } },
    })
    expect(mounts.acceptLive('session-a', identity('session-a', 'worker-2', 2), event(2, 'new-worker'))).toBe('accepted')
    expect(() => mounts.acceptLive('session-a', identity('session-a'), event(3, 'old-worker'))).toThrow(/identity changed/)
  })

  it('converts every unresolved execution to unknown on disposal and ignores late results', () => {
    const mounts = coordinator()
    mounts.activate('session-a')
    mounts.beginExecution('session-a', 'turn-a', 'waiting')
    mounts.activate('session-b')
    mounts.beginExecution('session-b', 'turn-b')
    const disposed = mounts.dispose('pagehide terminated the Worker')
    expect(disposed).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'session-a', view: 'detached', availability: 'unavailable', execution: expect.objectContaining({ state: 'unknown' }) }),
      expect.objectContaining({ sessionId: 'session-b', view: 'detached', availability: 'unavailable', execution: expect.objectContaining({ state: 'unknown' }) }),
    ]))
    expect(mounts.settleExecution('session-a', 'turn-a', { settlement: 'confirmed' })).toBe(false)
    expect(mounts.snapshots().find(snapshot => snapshot.sessionId === 'session-a')?.execution).toMatchObject({ lateResults: 1 })
    expect(() => mounts.activate('session-a')).toThrow(/disposed/)
  })
})
