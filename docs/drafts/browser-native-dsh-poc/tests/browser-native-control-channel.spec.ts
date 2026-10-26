import { describe, expect, it } from 'vitest'
import {
  BROWSER_NATIVE_CONTROL_PROTOCOL_VERSION,
  BrowserNativeControlReceiver,
  type BrowserNativeControlNoticeFrame,
  type BrowserNativeControlReadyFrame,
} from '../../../../apps/web/src/browser-native-control-channel.ts'

const channelId = '123e4567-e89b-12d3-a456-426614174000'

const ready = (): BrowserNativeControlReadyFrame => ({
  type: 'control-ready',
  protocolVersion: BROWSER_NATIVE_CONTROL_PROTOCOL_VERSION,
  channelId,
  seq: 0,
})

const frame = (seq: number, dirtyCount = seq): BrowserNativeControlNoticeFrame => ({
  type: 'control-frame',
  protocolVersion: BROWSER_NATIVE_CONTROL_PROTOCOL_VERSION,
  channelId,
  seq,
  notice: {
    type: 'workspace',
    state: dirtyCount === 0 ? 'synced' : 'dirty',
    workspaceId: 'workspace-test',
    revision: 1,
    dirtyCount,
  },
})

describe('Browser-Native control channel', () => {
  it('requires one baseline before accepting notices', () => {
    const receiver = new BrowserNativeControlReceiver()
    expect(receiver.receive(frame(1)).kind).toBe('invalid')
    expect(receiver.receive(ready())).toEqual({ kind: 'invalid', reason: 'CONTROL_CHANNEL_INVALID' })
  })

  it('accepts a baseline and contiguous notices', () => {
    const receiver = new BrowserNativeControlReceiver()
    expect(receiver.receive(ready()).kind).toBe('ready')
    expect(receiver.receive(frame(1)).kind).toBe('notice')
    expect(receiver.receive(frame(2)).kind).toBe('notice')
  })

  it('deduplicates an identical frame without applying it twice', () => {
    const receiver = new BrowserNativeControlReceiver()
    receiver.receive(ready())
    receiver.receive(frame(1))
    expect(receiver.receive(frame(1))).toEqual({ kind: 'duplicate' })
    expect(receiver.receive(frame(2)).kind).toBe('notice')
  })

  it('rejects same-sequence payload conflicts', () => {
    const receiver = new BrowserNativeControlReceiver()
    receiver.receive(ready())
    receiver.receive(frame(1, 1))
    expect(receiver.receive(frame(1, 2))).toEqual({ kind: 'invalid', reason: 'CONTROL_SEQUENCE_CONFLICT' })
    expect(receiver.receive(frame(2))).toEqual({ kind: 'invalid', reason: 'CONTROL_CHANNEL_INVALID' })
  })

  it('rejects sequence gaps and channel changes', () => {
    const gapReceiver = new BrowserNativeControlReceiver()
    gapReceiver.receive(ready())
    expect(gapReceiver.receive(frame(2))).toEqual({ kind: 'invalid', reason: 'CONTROL_SEQUENCE_GAP' })

    const channelReceiver = new BrowserNativeControlReceiver()
    channelReceiver.receive(ready())
    expect(channelReceiver.receive({ ...frame(1), channelId: '123e4567-e89b-12d3-a456-426614174001' }))
      .toEqual({ kind: 'invalid', reason: 'CONTROL_CHANNEL_CHANGED' })
  })

  it('locks the receiver after an unsupported or repeated baseline', () => {
    const protocolReceiver = new BrowserNativeControlReceiver()
    expect(protocolReceiver.receive({ ...ready(), protocolVersion: 99 })).toEqual({
      kind: 'invalid',
      reason: 'CONTROL_FRAME_INVALID',
    })
    expect(protocolReceiver.receive(ready())).toEqual({ kind: 'invalid', reason: 'CONTROL_CHANNEL_INVALID' })

    const repeatedReceiver = new BrowserNativeControlReceiver()
    repeatedReceiver.receive(ready())
    expect(repeatedReceiver.receive(ready())).toEqual({ kind: 'invalid', reason: 'CONTROL_BASELINE_REPEATED' })
    expect(repeatedReceiver.receive(frame(1))).toEqual({ kind: 'invalid', reason: 'CONTROL_CHANNEL_INVALID' })
  })
})
