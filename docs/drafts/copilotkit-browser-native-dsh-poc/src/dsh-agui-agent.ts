import { AbstractAgent, type AgentConfig } from '@ag-ui/client'
import { EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/core'
import { Observable } from 'rxjs'
import type { SessionBinding, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AssistantMessage, ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

interface DshAgUiAgentOptions {
  readonly binding: Pick<SessionBinding, 'sessionId' | 'session' | 'eventSource'>
  readonly threadId: string
}

interface OpenTextMessage {
  readonly messageId: string
  readonly attemptId: string
  readonly turn: number
}

type DshEntry = Extract<SessionEventLikeEntry, { readonly type: 'event' }>

function isDurableEntry(entry: SessionEventLikeEntry): entry is DshEntry {
  return entry.type === 'event'
}

function textOfContent(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function textOfMessage(message: Message): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
}

function dshTextOfMessage(message: AssistantMessage): string {
  return textOfContent(message.content)
}

function contentBlocksToToolCalls(message: AssistantMessage): NonNullable<Extract<Message, { readonly role: 'assistant' }>['toolCalls']> {
  return message.content.flatMap(block => block.type === 'tool-call' ? [{
    id: String(block.id),
    type: 'function' as const,
    function: {
      name: block.name,
      arguments: block.arguments,
    },
  }] : [])
}

function historyFromEntries(entries: readonly SessionEventLikeEntry[]): Message[] {
  const messages: Message[] = []
  for (const entry of entries) {
    if (!isDurableEntry(entry)) continue
    const event = entry.event
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      messages.push({
        id: String(event.data.id),
        role: 'user',
        content: textOfContent(event.data.content),
      })
    } else if (event.type === 'assistant/message') {
      const assistant = event.data.message
      const content = dshTextOfMessage(assistant)
      const toolCalls = contentBlocksToToolCalls(assistant)
      messages.push({
        id: String(assistant.id),
        role: 'assistant',
        ...(content.length === 0 ? {} : { content }),
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
      })
    } else if (event.type === 'tool/result') {
      messages.push({
        id: String(event.data.message.id),
        role: 'tool',
        toolCallId: String(event.data.message.toolCallId),
        content: textOfContent(event.data.message.content),
        ...(event.data.message.isError === true ? { error: 'DSH tool returned an error' } : {}),
      })
    }
  }
  return messages
}

function latestDurableSequence(entries: readonly SessionEventLikeEntry[]): number {
  return entries.reduce((maximum, entry) => {
    if (!isDurableEntry(entry)) return maximum
    return Math.max(maximum, Number(entry.event.seq))
  }, -1)
}

function runStarted(threadId: string, runId: string): BaseEvent {
  return {
    type: EventType.RUN_STARTED,
    threadId,
    runId,
    timestamp: Date.now(),
    protocolVersion: '1.0',
  }
}

function runFinished(threadId: string, runId: string): BaseEvent {
  return {
    type: EventType.RUN_FINISHED,
    threadId,
    runId,
    timestamp: Date.now(),
    outcome: { type: 'success' },
  }
}

function runError(threadId: string, runId: string, error: Error): BaseEvent {
  return {
    type: EventType.RUN_ERROR,
    threadId,
    runId,
    timestamp: Date.now(),
    message: error.message,
    code: 'DSH_SESSION_RUN_FAILED',
  }
}

function dshEventForEntry(entry: DshEntry): SessionEvent {
  return entry.event
}

/**
 * Projects one DSH Session into the AG-UI agent surface without owning a model loop.
 * The only operation that starts execution is `SessionFace.prompt()`.
 */
export class DshAgUiAgent extends AbstractAgent {
  private readonly binding: DshAgUiAgentOptions['binding']
  private readonly submittedInputs = new Set<string>()

  constructor(options: DshAgUiAgentOptions, config: Omit<AgentConfig, 'threadId'> = {}) {
    super({
      ...config,
      agentId: config.agentId ?? 'dsh-browser-native',
      threadId: options.threadId,
      description: config.description ?? 'Browser-native DSH Session backed agent',
    })
    this.binding = options.binding
  }

  override connect(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>(subscriber => {
      subscriber.next(runStarted(input.threadId, input.runId))
      subscriber.next({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: historyFromEntries(this.binding.eventSource.getSnapshot().entries),
        timestamp: Date.now(),
      })
      subscriber.next(runFinished(input.threadId, input.runId))
      subscriber.complete()
    })
  }

  /** Detach the AG-UI run so its teardown cancels the same DSH Session turn. */
  override abortRun(): void {
    void this.detachActiveRun()
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>(subscriber => {
      const runId = input.runId
      const threadId = input.threadId
      const entries = this.binding.eventSource.getSnapshot().entries
      let lastDurableSeq = latestDurableSequence(entries)
      let targetTurn: number | undefined
      let ended = false
      let prompted = false
      let disposed = false
      let cancellationRequested = false
      const openTexts = new Map<string, OpenTextMessage>()
      const emittedToolCalls = new Set<string>()
      const emittedTransientSeqs = new Set<number>()

      const cancelSession = (): void => {
        if (cancellationRequested) return
        cancellationRequested = true
        void this.binding.session.cancel().then(result => {
          if (!result.ok) console.warn(`CopilotKit DSH stop failed: ${result.error.message}`)
        }).catch(error => {
          console.warn(`CopilotKit DSH stop failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }

      const emit = (event: BaseEvent): void => {
        if (!ended) subscriber.next(event)
      }

      const closeText = (messageId: string): void => {
        if (!openTexts.has(messageId)) return
        emit({ type: EventType.TEXT_MESSAGE_END, messageId, timestamp: Date.now() })
        openTexts.delete(messageId)
      }

      const emitToolCall = (callId: string, name: string, argumentsText: string): void => {
        if (emittedToolCalls.has(callId)) return
        emittedToolCalls.add(callId)
        emit({
          type: EventType.TOOL_CALL_START,
          toolCallId: callId,
          toolCallName: name,
          timestamp: Date.now(),
        })
        emit({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: callId,
          delta: argumentsText,
          timestamp: Date.now(),
        })
        emit({ type: EventType.TOOL_CALL_END, toolCallId: callId, timestamp: Date.now() })
      }

      const processEntry = (entry: SessionEventLikeEntry): void => {
        if (entry.type === 'transient') {
          const event = entry.event
          if (emittedTransientSeqs.has(event.seq)) return
          emittedTransientSeqs.add(event.seq)
          if (event.type !== 'assistant/live-chunk' || event.data.chunk.type !== 'text-delta') return
          if (targetTurn !== undefined && targetTurn !== event.data.turn) return
          targetTurn ??= event.data.turn
          const messageId = `dsh-live-${String(event.data.attemptId)}`
          if (!openTexts.has(messageId)) {
            openTexts.set(messageId, {
              messageId,
              attemptId: String(event.data.attemptId),
              turn: event.data.turn,
            })
            emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant', timestamp: event.time })
          }
          emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: event.data.chunk.text, timestamp: event.time })
          return
        }

        const event = dshEventForEntry(entry)
        if (event.seq <= lastDurableSeq) return
        lastDurableSeq = Number(event.seq)
        switch (event.type) {
          case 'turn/start':
            targetTurn ??= event.data.turn
            break
          case 'step/start':
            if (targetTurn === event.data.turn) {
              emit({
                type: EventType.STEP_STARTED,
                stepName: `turn-${event.data.turn}-step-${event.data.step}`,
                timestamp: event.time,
              })
            }
            break
          case 'assistant/message': {
            if (targetTurn !== event.data.turn) break
            const assistant = event.data.message
            const messageId = String(assistant.id)
            const hadLiveText = [...openTexts.values()].some(live => live.turn === event.data.turn)
            for (const live of [...openTexts.values()]) {
              if (live.turn === event.data.turn) closeText(live.messageId)
            }
            const text = dshTextOfMessage(assistant)
            if (text.length > 0 && !hadLiveText && openTexts.size === 0) {
              emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant', timestamp: event.time })
              emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text, timestamp: event.time })
              emit({ type: EventType.TEXT_MESSAGE_END, messageId, timestamp: event.time })
            } else {
              closeText(messageId)
            }
            for (const block of assistant.content) {
              if (block.type === 'tool-call') emitToolCall(String(block.id), block.name, block.arguments)
            }
            break
          }
          case 'tool/call':
            if (targetTurn === event.data.turn) emitToolCall(String(event.data.callId), event.data.name, event.data.arguments)
            break
          case 'tool/result':
            if (targetTurn === event.data.turn) {
              emit({
                type: EventType.TOOL_CALL_RESULT,
                messageId: String(event.data.message.id),
                toolCallId: String(event.data.message.toolCallId),
                content: textOfContent(event.data.message.content),
                timestamp: event.time,
              })
            }
            break
          case 'step/end':
            if (targetTurn === event.data.turn) {
              emit({
                type: EventType.STEP_FINISHED,
                stepName: `turn-${event.data.turn}-step-${event.data.step}`,
                timestamp: event.time,
              })
            }
            break
          case 'turn/end':
            if (targetTurn !== event.data.turn) break
            for (const message of [...openTexts.keys()]) closeText(message)
            if (event.data.reason.kind === 'error') {
              const error = new Error(event.data.reason.error.message)
              emit(runError(threadId, runId, error))
            } else {
              emit(runFinished(threadId, runId))
            }
            ended = true
            subscriber.complete()
            break
          default:
            break
        }
      }

      const drain = (): void => {
        for (const entry of this.binding.eventSource.getSnapshot().entries) processEntry(entry)
      }

      const stopListening = this.binding.eventSource.subscribe(drain)
      emit(runStarted(threadId, runId))
      const lastUserMessage = [...input.messages].reverse().find(message => message.role === 'user')
      const promptText = lastUserMessage === undefined ? '' : textOfMessage(lastUserMessage)
      const promptKey = `${lastUserMessage?.id ?? ''}:${promptText}`
      if (promptText.trim().length === 0) {
        const error = new Error('CopilotKit sent an empty user message to DSH')
        emit(runError(threadId, runId, error))
        ended = true
        subscriber.complete()
      } else if (this.submittedInputs.has(promptKey)) {
        const error = new Error('The same CopilotKit input was already submitted to this DSH Session')
        emit(runError(threadId, runId, error))
        ended = true
        subscriber.complete()
      } else {
        this.submittedInputs.add(promptKey)
        const submission = this.binding.session.beginSubmission({
          mode: 'queue',
          text: promptText,
          attachments: [],
        })
        void this.binding.session.prompt(
          [{ type: 'text', text: promptText }],
          'queue',
          undefined,
          submission.requestId,
        ).then(result => {
          prompted = true
          if (!result.ok) throw new Error(result.error.message)
          if (disposed) {
            cancelSession()
            return
          }
          drain()
        }).catch(error => {
          submission.abandon()
          if (ended) return
          const failure = error instanceof Error ? error : new Error(String(error))
          emit(runError(threadId, runId, failure))
          ended = true
          stopListening()
          subscriber.complete()
        })
      }

      return () => {
        stopListening()
        disposed = true
        if (!ended && prompted) {
          cancelSession()
        }
      }
    })
  }

  override clone(): this {
    const cloned = new DshAgUiAgent({ binding: this.binding, threadId: this.threadId }, {
      agentId: this.agentId,
      description: this.description,
    }) as this
    cloned.submittedInputs.clear()
    return cloned
  }
}
