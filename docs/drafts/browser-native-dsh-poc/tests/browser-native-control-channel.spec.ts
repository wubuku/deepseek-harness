import { describe, expect, it } from 'vitest'
import {
  BROWSER_NATIVE_CONTROL_MAX_FRAME_BYTES,
  BROWSER_NATIVE_CONTROL_MAX_TEXT_BYTES,
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
    expect(receiver.receive({ ...frame(2), notice: { ...frame(2).notice, state: 'read-only' } }).kind).toBe('notice')
    expect(receiver.receive({ ...frame(3), notice: { ...frame(3).notice, state: 'stale' } }).kind).toBe('notice')
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
      reason: 'CONTROL_PROTOCOL_UNSUPPORTED',
    })
    expect(protocolReceiver.receive(ready())).toEqual({ kind: 'invalid', reason: 'CONTROL_CHANNEL_INVALID' })

    const repeatedReceiver = new BrowserNativeControlReceiver()
    repeatedReceiver.receive(ready())
    expect(repeatedReceiver.receive(ready())).toEqual({ kind: 'invalid', reason: 'CONTROL_BASELINE_REPEATED' })
    expect(repeatedReceiver.receive(frame(1))).toEqual({ kind: 'invalid', reason: 'CONTROL_CHANNEL_INVALID' })

    const unsupportedFrameReceiver = new BrowserNativeControlReceiver()
    expect(unsupportedFrameReceiver.receive({ ...ready(), type: 'future-control-frame' })).toEqual({
      kind: 'invalid',
      reason: 'CONTROL_FRAME_UNSUPPORTED',
    })
  })

  it('accepts the exact text byte limit and rejects one byte over', () => {
    const accepted = new BrowserNativeControlReceiver()
    accepted.receive(ready())
    expect(accepted.receive({ ...frame(1), notice: { ...frame(1).notice, message: 'x'.repeat(BROWSER_NATIVE_CONTROL_MAX_TEXT_BYTES) } }).kind)
      .toBe('notice')

    const rejected = new BrowserNativeControlReceiver()
    rejected.receive(ready())
    expect(rejected.receive({ ...frame(1), notice: { ...frame(1).notice, message: 'x'.repeat(BROWSER_NATIVE_CONTROL_MAX_TEXT_BYTES + 1) } }))
      .toEqual({ kind: 'invalid', reason: 'CONTROL_FIELD_TOO_LARGE' })
  })

  it('measures UTF-8 bytes and rejects escaped frames over the total byte budget', () => {
    const multibyte = new BrowserNativeControlReceiver()
    multibyte.receive(ready())
    expect(multibyte.receive({ ...frame(1), notice: { ...frame(1).notice, message: 'é'.repeat(BROWSER_NATIVE_CONTROL_MAX_TEXT_BYTES / 2) } }).kind)
      .toBe('notice')

    const oversizedMultibyte = new BrowserNativeControlReceiver()
    oversizedMultibyte.receive(ready())
    expect(oversizedMultibyte.receive({ ...frame(1), notice: { ...frame(1).notice, message: 'é'.repeat(BROWSER_NATIVE_CONTROL_MAX_TEXT_BYTES / 2 + 1) } }))
      .toEqual({ kind: 'invalid', reason: 'CONTROL_FIELD_TOO_LARGE' })

    const serializedOversize = new BrowserNativeControlReceiver()
    serializedOversize.receive(ready())
    expect(serializedOversize.receive({ ...frame(1), notice: { ...frame(1).notice, message: '\0'.repeat(BROWSER_NATIVE_CONTROL_MAX_TEXT_BYTES) } }))
      .toEqual({ kind: 'invalid', reason: 'CONTROL_FRAME_TOO_LARGE' })

    const emptyMessage = { ...frame(1), notice: { ...frame(1).notice, message: '' } }
    const frameOverhead = new TextEncoder().encode(JSON.stringify(emptyMessage)).byteLength
    const remainingBytes = BROWSER_NATIVE_CONTROL_MAX_FRAME_BYTES - frameOverhead
    const nullCount = Math.floor(remainingBytes / 6)
    const asciiCount = remainingBytes % 6
    const exactBoundary = {
      ...frame(1),
      notice: { ...frame(1).notice, message: '\0'.repeat(nullCount) + 'a'.repeat(asciiCount) },
    }
    expect(new TextEncoder().encode(JSON.stringify(exactBoundary)).byteLength).toBe(BROWSER_NATIVE_CONTROL_MAX_FRAME_BYTES)
    const exactReceiver = new BrowserNativeControlReceiver()
    exactReceiver.receive(ready())
    expect(exactReceiver.receive(exactBoundary).kind).toBe('notice')

    const oneByteOverReceiver = new BrowserNativeControlReceiver()
    oneByteOverReceiver.receive(ready())
    expect(oneByteOverReceiver.receive({
      ...exactBoundary,
      notice: { ...exactBoundary.notice, message: `${exactBoundary.notice.message}a` },
    })).toEqual({ kind: 'invalid', reason: 'CONTROL_FRAME_TOO_LARGE' })
  })

  it('rejects unknown keys, unknown notices, and cyclic extras before fingerprinting', () => {
    const extra = new BrowserNativeControlReceiver()
    extra.receive(ready())
    expect(extra.receive({ ...frame(1), extra: { nested: true } })).toEqual({
      kind: 'invalid',
      reason: 'CONTROL_FRAME_INVALID',
    })

    const unsupported = new BrowserNativeControlReceiver()
    unsupported.receive(ready())
    expect(unsupported.receive({ ...frame(1), notice: { type: 'future-required-notice', secret: 'never-forward' } }))
      .toEqual({ kind: 'invalid', reason: 'CONTROL_NOTICE_UNSUPPORTED' })

    const cyclicExtra: { self?: unknown } = {}
    cyclicExtra.self = cyclicExtra
    const cyclic = new BrowserNativeControlReceiver()
    cyclic.receive(ready())
    expect(cyclic.receive({ ...frame(1), extra: cyclicExtra })).toEqual({
      kind: 'invalid',
      reason: 'CONTROL_FRAME_INVALID',
    })
  })

  it('rejects unsafe sequence integers before accepting a frame', () => {
    const receiver = new BrowserNativeControlReceiver()
    receiver.receive(ready())
    expect(receiver.receive(frame(Number.MAX_SAFE_INTEGER + 1))).toEqual({ kind: 'invalid', reason: 'CONTROL_FRAME_INVALID' })
  })
})
