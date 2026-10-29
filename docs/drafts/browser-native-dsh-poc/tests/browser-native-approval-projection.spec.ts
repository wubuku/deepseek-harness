import { describe, expect, it } from 'vitest'
import { BrowserNativeApprovalProjection, BrowserNativeApprovalProjectionError } from '../browser-native-approval-projection.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-user-approval'

const approvalId = (value: string): ApprovalRequestId => value as ApprovalRequestId
const toolCallId = (value: string): ToolCallId => value as ToolCallId

function call(seq: number, callId: string, name = 'bash', argumentsText = '{"command":"echo ok"}'): SessionEvent<'tool/call'> {
  return { seq, time: seq, type: 'tool/call', data: { turn: 1, step: 1, callId: toolCallId(callId), name, arguments: argumentsText } }
}

function result(seq: number, callId: string): SessionEvent<'tool/result'> {
  return {
    seq,
    time: seq,
    type: 'tool/result',
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        id: `message-${callId}`,
        content: [{ type: 'text', text: 'done' }],
        source: { kind: 'tool', callId: toolCallId(callId) },
        toolCallId: toolCallId(callId),
        isError: false,
      },
    },
  }
}

function asked(seq: number, requestId: string, callId: string, toolName = 'bash'): SessionEvent<'approval/asked'> {
  return {
    seq,
    time: seq,
    type: 'approval/asked',
    data: { id: approvalId(requestId), callId: toolCallId(callId), toolName, reason: 'needs approval' },
  }
}

function decided(seq: number, requestId: string, outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'): SessionEvent<'approval/decided'> {
  return { seq, time: seq, type: 'approval/decided', data: { id: approvalId(requestId), outcome } }
}

describe('Browser-Native approval projection', () => {
  it('anchors approvals to unfinished tool calls and preserves FIFO order', () => {
    const projection = new BrowserNativeApprovalProjection('session-a', 40)
    const snapshot = projection.rebuild([
      call(0, 'call-a', 'bash', `{"command":"${'x'.repeat(60)}"}`),
      asked(1, 'request-a', 'call-a'),
      call(2, 'call-b', 'write', '{"file_path":"x.txt","content":"ok"}'),
      asked(3, 'request-b', 'call-b', 'write'),
    ])

    expect(snapshot.pending.map(request => request.requestId)).toEqual(['request-a', 'request-b'])
    expect(snapshot.pending[0]).toMatchObject({ callId: 'call-a', toolName: 'bash', argumentsTruncated: true })
    expect(snapshot.pending[0]?.argumentSummary.length).toBe(41)
  })

  it('uses one-shot ephemeral claims and durable replay as the authority', () => {
    const projection = new BrowserNativeApprovalProjection('session-a')
    projection.rebuild([call(0, 'call-a'), asked(1, 'request-a', 'call-a')])
    expect(projection.claim('request-a', 'allowed-once')).toMatchObject({ durable: false, outcome: 'allowed-once' })
    expect(projection.snapshot().pending).toEqual([])
    expect(() => projection.claim('request-a', 'rejected')).toThrow(BrowserNativeApprovalProjectionError)

    const replay = projection.rebuild([
      call(0, 'call-a'),
      asked(1, 'request-a', 'call-a'),
      decided(2, 'request-a', 'allowed-once'),
      result(3, 'call-a'),
    ])
    expect(replay.pending).toEqual([])
    expect(replay.decisions).toEqual([{ requestId: 'request-a', outcome: 'allowed-once', eventSeq: 2 }])
  })

  it('fails closed for forged, duplicate, mismatched, stale, and late events', () => {
    const projection = new BrowserNativeApprovalProjection('session-a')
    const snapshot = projection.rebuild([
      call(0, 'call-a'),
      asked(1, 'request-a', 'call-a'),
      asked(2, 'request-a', 'call-a'),
      asked(3, 'request-unknown', 'missing'),
      asked(4, 'request-mismatch', 'call-a', 'write'),
      decided(5, 'request-a', 'rejected'),
      decided(6, 'request-a', 'rejected'),
      result(7, 'call-a'),
      asked(8, 'request-stale', 'call-a'),
      call(9, 'call-b'),
      asked(10, 'request-b', 'call-b'),
      result(11, 'call-b'),
      decided(12, 'request-b', 'rejected'),
      decided(13, 'request-unknown', 'rejected'),
    ])
    expect(snapshot.pending).toEqual([])
    expect(snapshot.decisions).toEqual([{ requestId: 'request-a', outcome: 'rejected', eventSeq: 5 }])
    expect(snapshot.diagnostics.map(item => item.code)).toEqual([
      'DUPLICATE_REQUEST',
      'APPROVAL_CALL_UNBOUND',
      'APPROVAL_TOOL_MISMATCH',
      'DECISION_DUPLICATE',
      'APPROVAL_CALL_SETTLED',
      'DECISION_CALL_SETTLED',
      'DECISION_UNBOUND',
    ])
  })

  it('rejects missing call ids and records non-monotonic replay input', () => {
    const projection = new BrowserNativeApprovalProjection('session-a')
    const missingCall = { seq: 0, time: 0, type: 'approval/asked', data: { id: approvalId('request-a'), toolName: 'bash' } } satisfies SessionEvent<'approval/asked'>
    const snapshot = projection.rebuild([missingCall, call(0, 'call-a')])
    expect(snapshot.pending).toEqual([])
    expect(snapshot.diagnostics.map(item => item.code)).toEqual(['APPROVAL_CALL_REQUIRED', 'EVENT_ORDER_INVALID'])
  })
})
