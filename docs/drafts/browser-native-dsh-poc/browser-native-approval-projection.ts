import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'

const APPROVAL_OUTCOMES: readonly ApprovalOutcome[] = [
  'allowed-once',
  'rejected',
  'cancelled',
  'unavailable',
]

const DEFAULT_ARGUMENT_SUMMARY_LIMIT = 240

type ToolCallEvent = Extract<SessionEvent, { type: 'tool/call' }>
type ToolResultEvent = Extract<SessionEvent, { type: 'tool/result' }>
type ApprovalAskedEvent = Extract<SessionEvent, { type: 'approval/asked' }>
type ApprovalDecidedEvent = Extract<SessionEvent, { type: 'approval/decided' }>

export type BrowserNativeApprovalDiagnosticCode =
  | 'EVENT_ORDER_INVALID'
  | 'DUPLICATE_TOOL_CALL'
  | 'TOOL_RESULT_UNBOUND'
  | 'DUPLICATE_REQUEST'
  | 'APPROVAL_CALL_REQUIRED'
  | 'APPROVAL_CALL_UNBOUND'
  | 'APPROVAL_TOOL_MISMATCH'
  | 'APPROVAL_CALL_ALREADY_ASKED'
  | 'APPROVAL_CALL_SETTLED'
  | 'DECISION_UNBOUND'
  | 'DECISION_CALL_SETTLED'
  | 'DECISION_DUPLICATE'
  | 'DECISION_OUTCOME_INVALID'
  | 'REQUEST_ALREADY_CLAIMED'

export interface BrowserNativeApprovalDiagnostic {
  readonly code: BrowserNativeApprovalDiagnosticCode
  readonly message: string
  readonly eventSeq?: number
  readonly requestId?: string
  readonly callId?: string
}

export interface BrowserNativeApprovalRequestSnapshot {
  readonly requestId: string
  readonly callId: string
  readonly toolName: string
  readonly reason?: string
  readonly argumentSummary: string
  readonly argumentsTruncated: boolean
  readonly eventSeq: number
}

export interface BrowserNativeApprovalDecisionSnapshot {
  readonly requestId: string
  readonly outcome: ApprovalOutcome
  readonly eventSeq: number
}

export interface BrowserNativeApprovalProjectionSnapshot {
  readonly sessionId: string
  readonly pending: readonly BrowserNativeApprovalRequestSnapshot[]
  readonly decisions: readonly BrowserNativeApprovalDecisionSnapshot[]
  readonly diagnostics: readonly BrowserNativeApprovalDiagnostic[]
  readonly lastSeq?: number
}

export interface BrowserNativeApprovalClaim {
  readonly sessionId: string
  readonly requestId: string
  readonly outcome: ApprovalOutcome
  /** A UI claim is not a durable approval decision until DSH appends it. */
  readonly durable: false
}

export class BrowserNativeApprovalProjectionError extends Error {
  constructor(
    readonly code: 'REQUEST_NOT_PENDING' | 'REQUEST_ALREADY_CLAIMED' | 'INVALID_OUTCOME',
    message: string,
  ) {
    super(message)
    this.name = 'BrowserNativeApprovalProjectionError'
  }
}
interface ToolCallRecord {
  readonly event: ToolCallEvent
  settled: boolean
  approvalRequestId?: string
}

interface ApprovalRecord {
  readonly event: ApprovalAskedEvent
  readonly request: BrowserNativeApprovalRequestSnapshot
  status: 'pending' | 'claimed' | 'decided' | 'invalid'
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value)
}

function summarizeArguments(argumentsText: string, limit: number): { text: string; truncated: boolean } {
  const normalized = argumentsText.trim()
  if (normalized.length <= limit) return { text: normalized, truncated: false }
  return { text: `${normalized.slice(0, limit)}…`, truncated: true }
}

function callIdOf(event: ToolResultEvent): string {
  return text(event.data.message.toolCallId)
}

function diagnostic(
  code: BrowserNativeApprovalDiagnosticCode,
  message: string,
  event: SessionEvent,
  extra: Pick<BrowserNativeApprovalDiagnostic, 'requestId' | 'callId'> = {},
): BrowserNativeApprovalDiagnostic {
  return { code, message, eventSeq: Number(event.seq), ...extra }
}

/**
 * Project approval UI state from one Session's durable events.
 *
 * This class does not call `ctx.approval`, append events, or grant a tool. A
 * claim only reserves the visible request in this projection; the DSH
 * approval service must append `approval/decided` before the tool can proceed.
 * The input is already scoped to one Session by the caller because the
 * persisted approval events carry no independent agent id.
 */
export class BrowserNativeApprovalProjection {
  private readonly calls = new Map<string, ToolCallRecord>()
  private readonly approvals = new Map<string, ApprovalRecord>()
  private readonly decisions: BrowserNativeApprovalDecisionSnapshot[] = []
  private readonly diagnostics: BrowserNativeApprovalDiagnostic[] = []
  private readonly claimed = new Set<string>()
  private lastSeq: number | undefined

  constructor(
    readonly sessionId: string,
    private readonly argumentSummaryLimit = DEFAULT_ARGUMENT_SUMMARY_LIMIT,
  ) {
    if (sessionId.length === 0) throw new Error('approval projection requires a Session id')
    if (!Number.isSafeInteger(argumentSummaryLimit) || argumentSummaryLimit < 32) {
      throw new Error('approval projection argument summary limit must be at least 32 bytes')
    }
  }

  /** Replace the ephemeral view with a complete Session replay. */
  rebuild(events: readonly SessionEvent[]): BrowserNativeApprovalProjectionSnapshot {
    this.calls.clear()
    this.approvals.clear()
    this.decisions.length = 0
    this.diagnostics.length = 0
    this.claimed.clear()
    this.lastSeq = undefined
    for (const event of events) this.accept(event)
    return this.snapshot()
  }

  /** Accept one newly appended event after the previous replay position. */
  accept(event: SessionEvent): void {
    const eventSeq = Number(event.seq)
    if (this.lastSeq !== undefined && eventSeq <= this.lastSeq) {
      this.diagnostics.push({
        code: 'EVENT_ORDER_INVALID',
        message: `Session event sequence ${String(eventSeq)} is not after ${String(this.lastSeq)}`,
        eventSeq,
      })
      return
    }
    this.lastSeq = eventSeq
    switch (event.type) {
      case 'tool/call':
        this.acceptToolCall(event)
        break
      case 'tool/result':
        this.acceptToolResult(event)
        break
      case 'approval/asked':
        this.acceptApprovalAsked(event)
        break
      case 'approval/decided':
        this.acceptApprovalDecided(event)
        break
      default:
        break
    }
  }

  /** Return a stable FIFO snapshot for the current Session. */
  snapshot(): BrowserNativeApprovalProjectionSnapshot {
    const pending = [...this.approvals.values()]
      .filter(record => record.status === 'pending' && !this.calls.get(record.request.callId)?.settled)
      .sort((left, right) => Number(left.event.seq) - Number(right.event.seq))
      .map(record => record.request)
    return Object.freeze({
      sessionId: this.sessionId,
      pending: Object.freeze(pending),
      decisions: Object.freeze([...this.decisions]),
      diagnostics: Object.freeze([...this.diagnostics]),
      ...(this.lastSeq === undefined ? {} : { lastSeq: this.lastSeq }),
    })
  }

  /** Claim one visible request for an answerer without creating a decision event. */
  claim(requestId: string, outcome: ApprovalOutcome): BrowserNativeApprovalClaim {
    if (!APPROVAL_OUTCOMES.includes(outcome)) {
      throw new BrowserNativeApprovalProjectionError('INVALID_OUTCOME', `Unsupported approval outcome: ${String(outcome)}`)
    }
    if (this.claimed.has(requestId)) {
      this.diagnostics.push({
        code: 'REQUEST_ALREADY_CLAIMED',
        message: `Approval request "${requestId}" was already claimed`,
        requestId,
      })
      throw new BrowserNativeApprovalProjectionError('REQUEST_ALREADY_CLAIMED', `Approval request "${requestId}" was already claimed`)
    }
    const record = this.approvals.get(requestId)
    if (record === undefined || record.status !== 'pending' || this.calls.get(record.request.callId)?.settled === true) {
      throw new BrowserNativeApprovalProjectionError('REQUEST_NOT_PENDING', `Approval request "${requestId}" is not pending`)
    }
    this.claimed.add(requestId)
    record.status = 'claimed'
    return Object.freeze({ sessionId: this.sessionId, requestId, outcome, durable: false })
  }

  private acceptToolCall(event: ToolCallEvent): void {
    const callId = text(event.data.callId)
    if (this.calls.has(callId)) {
      this.diagnostics.push(diagnostic('DUPLICATE_TOOL_CALL', `Tool call "${callId}" was advertised more than once`, event, { callId }))
      return
    }
    this.calls.set(callId, { event, settled: false })
  }

  private acceptToolResult(event: ToolResultEvent): void {
    const callId = callIdOf(event)
    const call = this.calls.get(callId)
    if (call === undefined) {
      this.diagnostics.push(diagnostic('TOOL_RESULT_UNBOUND', `Tool result "${callId}" has no tool/call`, event, { callId }))
      return
    }
    call.settled = true
  }

  private acceptApprovalAsked(event: ApprovalAskedEvent): void {
    const requestId = text(event.data.id)
    const callId = event.data.callId === undefined ? undefined : text(event.data.callId)
    if (this.approvals.has(requestId)) {
      this.diagnostics.push(diagnostic('DUPLICATE_REQUEST', `Approval request "${requestId}" was advertised more than once`, event, { requestId, callId }))
      return
    }
    if (callId === undefined || callId.length === 0) {
      this.diagnostics.push(diagnostic('APPROVAL_CALL_REQUIRED', `Approval request "${requestId}" is not tied to a tool call`, event, { requestId }))
      return
    }
    const call = this.calls.get(callId)
    if (call === undefined) {
      this.diagnostics.push(diagnostic('APPROVAL_CALL_UNBOUND', `Approval request "${requestId}" references unknown tool call "${callId}"`, event, { requestId, callId }))
      return
    }
    if (call.event.data.name !== event.data.toolName) {
      this.diagnostics.push(diagnostic('APPROVAL_TOOL_MISMATCH', `Approval request "${requestId}" names ${event.data.toolName} for ${call.event.data.name}`, event, { requestId, callId }))
      return
    }
    if (call.settled) {
      this.diagnostics.push(diagnostic('APPROVAL_CALL_SETTLED', `Approval request "${requestId}" arrived after tool call "${callId}" settled`, event, { requestId, callId }))
      return
    }
    if (call.approvalRequestId !== undefined) {
      this.diagnostics.push(diagnostic('APPROVAL_CALL_ALREADY_ASKED', `Tool call "${callId}" already has approval request "${call.approvalRequestId}"`, event, { requestId, callId }))
      return
    }
    const summary = summarizeArguments(call.event.data.arguments, this.argumentSummaryLimit)
    const request: BrowserNativeApprovalRequestSnapshot = Object.freeze({
      requestId,
      callId,
      toolName: event.data.toolName,
      ...(event.data.reason === undefined ? {} : { reason: event.data.reason }),
      argumentSummary: summary.text,
      argumentsTruncated: summary.truncated,
      eventSeq: Number(event.seq),
    })
    this.approvals.set(requestId, { event, request, status: 'pending' })
    call.approvalRequestId = requestId
  }

  private acceptApprovalDecided(event: ApprovalDecidedEvent): void {
    const requestId = text(event.data.id)
    const record = this.approvals.get(requestId)
    if (record === undefined) {
      this.diagnostics.push(diagnostic('DECISION_UNBOUND', `Approval decision "${requestId}" has no valid request`, event, { requestId }))
      return
    }
    if (record.status === 'decided' || this.decisions.some(decision => decision.requestId === requestId)) {
      this.diagnostics.push(diagnostic('DECISION_DUPLICATE', `Approval request "${requestId}" was decided more than once`, event, { requestId }))
      return
    }
    const call = this.calls.get(record.request.callId)
    if (call === undefined || call.settled) {
      this.diagnostics.push(diagnostic(
        'DECISION_CALL_SETTLED',
        `Approval decision "${requestId}" arrived after tool call "${record.request.callId}" settled`,
        event,
        { requestId, callId: record.request.callId },
      ))
      return
    }
    if (!APPROVAL_OUTCOMES.includes(event.data.outcome)) {
      this.diagnostics.push(diagnostic('DECISION_OUTCOME_INVALID', `Approval request "${requestId}" has an unsupported outcome`, event, { requestId }))
      return
    }
    record.status = 'decided'
    this.claimed.delete(requestId)
    this.decisions.push(Object.freeze({ requestId, outcome: event.data.outcome, eventSeq: Number(event.seq) }))
  }
}
