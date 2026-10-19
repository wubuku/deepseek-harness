/** AG-UI observation segments, not additional DSH turns or a framework model loop. */
import { AbstractAgent, type AgentConfig } from '@ag-ui/client'
import { EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/core'
import { Observable } from 'rxjs'
import type { SessionBinding, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { FrontendBridgeWithSegments } from './bridge.ts'

interface Binding {
  readonly sessionId: SessionBinding['sessionId']
  readonly session: Pick<SessionBinding['session'], 'beginSubmission' | 'prompt' | 'cancel'>
  readonly eventSource: {
    getSnapshot(): { readonly entries: readonly SessionEventLikeEntry[] }
    subscribe(listener: () => void): () => void
  }
}
interface Cursor { seq: number; turn?: number }

function text(blocks: readonly ContentBlock[]): string { return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('') }

/** Rebuild chat exclusively from durable DSH facts, without replaying page side effects.
 * @param entries - Current Session event projection, including possible transients.
 * @returns AG-UI messages derived only from durable user, assistant and tool facts.
 */
export function projectHistory(entries: readonly SessionEventLikeEntry[]): Message[] {
  const messages: Message[] = []
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event.type === 'user/message' && event.data.source.kind === 'user') messages.push({ id: String(event.data.id), role: 'user', content: text(event.data.content) })
    if (event.type === 'assistant/message') {
      const message = event.data.message
      const toolCalls = message.content.flatMap(block => block.type === 'tool-call' ? [{ id: String(block.id), type: 'function' as const, function: { name: block.name, arguments: block.arguments } }] : [])
      messages.push({ id: String(message.id), role: 'assistant', content: text(message.content), ...(toolCalls.length ? { toolCalls } : {}) })
    }
    if (event.type === 'tool/result') messages.push({ id: String(event.data.message.id), role: 'tool', toolCallId: String(event.data.message.toolCallId), content: text(event.data.message.content) })
  }
  return messages
}

/** Show abandoned historical calls as interrupted text; never re-run an approval without its Worker waiter.
 * @param entries - Restored Session events.
 * @returns Historical messages with unresolved calls displayed as interrupted text.
 */
export function hydrateHistory(entries: readonly SessionEventLikeEntry[]): Message[] {
  const history = projectHistory(entries)
  const completed = new Set(history.flatMap(message => message.role === 'tool' ? [message.toolCallId] : []))
  return history.map(message => {
    if (message.role !== 'assistant' || !message.toolCalls?.some(call => !completed.has(call.id))) return message
    const missing = message.toolCalls.filter(call => !completed.has(call.id))
    const kept = message.toolCalls.filter(call => completed.has(call.id))
    return { ...message, toolCalls: kept, content: `${typeof message.content === 'string' ? message.content : ''}\n${missing.map(call => `工具 ${call.function.name}（${call.id}）执行已中断，需要重新发起；未重放业务操作。`).join('\n')}` }
  })
}

/** Let CopilotKit execute native tools between segments while one DSH turn stays open. */
export class DshSegmentedAgent extends AbstractAgent {
  private suspension?: Cursor
  private readonly submitted = new Set<string>()
  private readonly transient = new Set<number>()
  private errorMessage = ''
  private readonly errorListeners = new Set<() => void>()
  readonly segments: { runId: string; kind: 'prompt' | 'continue'; turn?: number; paused: boolean }[] = []

  subscribeError = (listener: () => void): (() => void) => { this.errorListeners.add(listener); return () => { this.errorListeners.delete(listener) } }
  getError = (): string => this.errorMessage

  constructor(private readonly binding: Binding, private readonly bridge: FrontendBridgeWithSegments, config: AgentConfig = {}) {
    super({ ...config, agentId: 'dsh-browser-native', threadId: String(binding.sessionId) })
  }

  override connect(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable(subscriber => {
      subscriber.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId, protocolVersion: '1.0' })
      subscriber.next({ type: EventType.MESSAGES_SNAPSHOT, messages: hydrateHistory(this.binding.eventSource.getSnapshot().entries) })
      subscriber.next({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: { type: 'success' } })
      subscriber.complete()
    })
  }

  override abortRun(): void {
    this.suspension = undefined
    for (const call of this.bridge.getSnapshot()) this.bridge.cancel(call.callId)
    void this.binding.session.cancel().catch(error => { console.warn('停止 DSH turn 失败', error) })
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable(subscriber => {
      this.errorMessage = ''
      for (const listener of this.errorListeners) listener()
      const entries = (): readonly SessionEventLikeEntry[] => this.binding.eventSource.getSnapshot().entries
      const resumed = this.suspension
      const cursor: Cursor = resumed ? { ...resumed } : { seq: entries().reduce((maximum, entry) => entry.type === 'event' ? Math.max(maximum, Number(entry.event.seq)) : maximum, -1) }
      this.suspension = undefined
      this.bridge.context = input.context
      const record = { runId: input.runId, kind: resumed ? 'continue' as const : 'prompt' as const, turn: cursor.turn, paused: false }
      this.segments.push(record)
      let ended = false
      let liveId: string | undefined
      let draining = false
      const emit = (event: BaseEvent): void => { if (!ended) subscriber.next(event) }
      const snapshot = (): void => {
        if (liveId) { emit({ type: EventType.TEXT_MESSAGE_END, messageId: liveId }); liveId = undefined }
        emit({ type: EventType.MESSAGES_SNAPSHOT, messages: projectHistory(entries()) })
      }
      const finish = (error?: Error): void => {
        if (ended) return
        if (error) { this.errorMessage = error.message; for (const listener of this.errorListeners) listener() }
        snapshot()
        emit(error ? { type: EventType.RUN_ERROR, message: error.message, code: 'DSH_SEGMENT_FAILED' } : { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: { type: 'success' } })
        ended = true
        subscriber.complete()
      }
      const pause = (): void => {
        if (ended || cursor.turn === undefined) return
        const history = projectHistory(entries())
        const waiting = this.bridge.getSnapshot().some(call => history.some(message => message.role === 'assistant' && message.toolCalls?.some(tool => tool.id === call.callId)))
        if (!waiting) return
        this.suspension = { ...cursor }
        record.turn = cursor.turn
        record.paused = true
        finish()
      }
      const drain = (): void => {
        if (ended || draining) return
        draining = true
        try {
          for (const entry of entries()) {
            if (ended) break
            if (entry.type === 'transient') {
              const event = entry.event
              if (event.type !== 'assistant/live-chunk' || event.data.turn !== cursor.turn || event.data.chunk.type !== 'text-delta' || this.transient.has(event.seq)) continue
              this.transient.add(event.seq)
              if (!liveId) { liveId = `live-${String(event.data.attemptId)}`; emit({ type: EventType.TEXT_MESSAGE_START, messageId: liveId, role: 'assistant' }) }
              emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: liveId, delta: event.data.chunk.text })
              continue
            }
            const event = entry.event
            if (event.seq <= cursor.seq) continue
            cursor.seq = Number(event.seq)
            if (event.type === 'turn/start') cursor.turn ??= event.data.turn
            if (event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'user/message') snapshot()
            if (event.type === 'turn/end' && cursor.turn === event.data.turn) {
              record.turn = cursor.turn
              finish(event.data.reason.kind === 'error' ? new Error(event.data.reason.error.message) : undefined)
            }
          }
          pause()
        } finally { draining = false }
      }
      const unsubscribe = this.binding.eventSource.subscribe(drain)
      const unsubscribeBridge = this.bridge.subscribe(() => { queueMicrotask(drain) })
      emit({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId, protocolVersion: '1.0' })
      if (resumed) {
        let settled = 0
        for (const call of this.bridge.getSnapshot()) {
          const result = input.messages.find(message => message.role === 'tool' && message.toolCallId === call.callId)
          if (result?.role !== 'tool' || typeof result.content !== 'string') continue
          try { if (this.bridge.resolve(call.callId, JSON.parse(result.content))) settled += 1 }
          catch (error) { this.bridge.reject(call.callId, error) }
        }
        if (!settled) { this.suspension = resumed; finish(new Error('请先完成或停止当前工具；协议续接缺少原始 DSH 调用结果')) }
        else drain()
      } else {
        const message = [...input.messages].reverse().find(item => item.role === 'user')
        const content = message && typeof message.content === 'string' ? message.content : ''
        if (!message || !content.trim() || this.submitted.has(message.id)) finish(new Error('空消息或重复输入'))
        else {
          this.submitted.add(message.id)
          const submission = this.binding.session.beginSubmission({ mode: 'queue', text: content, attachments: [] })
          void this.binding.session.prompt([{ type: 'text', text: content }], 'queue', undefined, submission.requestId).then(result => {
            if (!result.ok) throw new Error(result.error.message)
            drain()
          }).catch(error => { submission.abandon(); finish(error instanceof Error ? error : new Error(String(error))) })
        }
      }
      return () => { unsubscribe(); unsubscribeBridge() }
    })
  }

  override clone(): this {
    return new DshSegmentedAgent(this.binding, this.bridge, { agentId: this.agentId, threadId: this.threadId }) as this
  }
}
