import { MessageNotSentError } from '@assistant-ui/react'
import type {
  AppendMessage,
  ExternalStoreAdapter,
  ThreadAssistantMessagePart,
  ThreadMessageLike,
} from '@assistant-ui/react'
import type {
  SessionBinding,
  SessionEventLikeEntry,
  SessionEventSource,
  SessionFace,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  AssistantMessage,
  AssistantStreamRecord,
  ContentBlock,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

export interface DshChatSnapshot {
  readonly messages: readonly ThreadMessageLike[]
  readonly isRunning: boolean
  readonly isLoading: boolean
  readonly hasEarlier: boolean
  readonly errorMessage: string | undefined
  readonly connectionError: string | undefined
}

export interface DshSessionAdapterOptions {
  readonly binding: Pick<SessionBinding, 'session' | 'eventSource'>
}

interface TimelineMessage {
  readonly message: ThreadMessageLike
  readonly seq: number
}

interface LiveAttempt {
  readonly attemptId: string
  readonly seq: number
  readonly time: number
  readonly turn: number
  readonly step: number
  text: string
}

interface ToolResultProjection {
  readonly content: readonly ContentBlock[]
  readonly isError: boolean
}

function isDurableEntry(
  entry: SessionEventLikeEntry,
): entry is Extract<SessionEventLikeEntry, { readonly type: 'event' }> {
  return entry.type === 'event'
}

function textOfContent(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function assistantPartOfBlock(
  block: ContentBlock,
  toolResults: ReadonlyMap<string, ToolResultProjection>,
): ThreadAssistantMessagePart | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      {
        const result = toolResults.get(String(block.id))
        return {
          type: 'tool-call',
          toolCallId: String(block.id),
          toolName: block.name,
          argsText: block.arguments,
          ...(result === undefined ? {} : {
            result: textOfContent(result.content),
            isError: result.isError,
          }),
        }
      }
    default:
      return undefined
  }
}

function assistantParts(
  message: AssistantMessage,
  toolResults: ReadonlyMap<string, ToolResultProjection>,
): ThreadAssistantMessagePart[] {
  return message.content.flatMap(block => {
    const part = assistantPartOfBlock(block, toolResults)
    return part === undefined ? [] : [part]
  })
}

function toolResultProjection(event: SessionEvent<'tool/result'>): ToolResultProjection {
  return {
    content: event.data.message.content,
    isError: event.data.message.isError === true,
  }
}

function assistantMessage(
  event: SessionEvent<'assistant/message'>,
  toolResults: ReadonlyMap<string, ToolResultProjection>,
): ThreadMessageLike {
  return {
    id: String(event.data.message.id),
    role: 'assistant',
    content: assistantParts(event.data.message, toolResults),
    createdAt: new Date(event.time),
    status: event.data.interrupted === true
      ? { type: 'incomplete', reason: 'cancelled' }
    : finishStatus(event.data.stream),
    metadata: { custom: { dshSeq: event.seq, dshTurn: event.data.turn, dshStep: event.data.step } },
  }
}

function applyLiveChunk(attempt: LiveAttempt, chunk: StreamChunk): void {
  if (chunk.type === 'text-delta') attempt.text += chunk.text
}

function liveMessage(attempt: LiveAttempt): ThreadMessageLike {
  return {
    id: `dsh-live-${attempt.attemptId}`,
    role: 'assistant',
    content: [{ type: 'text', text: attempt.text }],
    createdAt: new Date(attempt.time),
    status: { type: 'running' },
    metadata: {
      runId: attempt.attemptId,
      isOptimistic: true,
      custom: { dshLive: true, dshSeq: attempt.seq },
    },
  }
}

function pendingMessages(session: SessionFace): TimelineMessage[] {
  const pendingSubmissions = session.getSnapshot().pendingSubmissions
  return pendingSubmissions.map((pending, index) => ({
    seq: Number.MAX_SAFE_INTEGER - pendingSubmissions.length + index,
    message: {
      id: `dsh-pending-${pending.requestId}`,
      role: 'user',
      content: [{ type: 'text', text: pending.text }],
      createdAt: new Date(pending.time),
      metadata: {
        isOptimistic: true,
        custom: { dshPending: true, dshRequestId: pending.requestId },
      },
    },
  }))
}

export function projectDshEvents(
  session: Pick<SessionFace, 'getSnapshot'>,
  source: Pick<SessionEventSource, 'getSnapshot'>,
): DshChatSnapshot {
  const timeline: TimelineMessage[] = []
  const live = new Map<string, LiveAttempt>()
  const toolResults = new Map<string, ToolResultProjection>()
  let turnError: string | undefined
  for (const entry of source.getSnapshot().entries) {
    if (isDurableEntry(entry) && entry.event.type === 'tool/result') {
      toolResults.set(String(entry.event.data.message.toolCallId), toolResultProjection(entry.event))
    }
  }
  for (const entry of source.getSnapshot().entries) {
    if (!isDurableEntry(entry)) {
      const event = entry.event
      let attempt = live.get(String(event.data.attemptId))
      if (attempt === undefined) {
        attempt = {
          attemptId: String(event.data.attemptId),
          seq: event.seq,
          time: event.time,
          turn: event.data.turn,
          step: event.data.step,
          text: '',
        }
        live.set(attempt.attemptId, attempt)
      }
      applyLiveChunk(attempt, event.data.chunk)
      continue
    }
    const event = entry.event
    if (event.type === 'user/message') {
      const message = userMessage(event)
      if (message !== undefined) timeline.push({ message, seq: event.seq })
    } else if (event.type === 'assistant/message') {
      timeline.push({ message: assistantMessage(event, toolResults), seq: event.seq })
    } else if (event.type === 'assistant/attempt') {
      for (const [attemptId, attempt] of live) {
        if (attempt.turn === event.data.turn && attempt.step === event.data.step) live.delete(attemptId)
      }
    } else if (event.type === 'step/end') {
      for (const [attemptId, attempt] of live) {
        if (attempt.turn === event.data.turn && attempt.step === event.data.step) live.delete(attemptId)
      }
    } else if (event.type === 'turn/start') {
      turnError = undefined
    } else if (event.type === 'turn/end') {
      turnError = event.data.reason.kind === 'error' ? event.data.reason.error.message : undefined
    }
  }
  for (const attempt of live.values()) timeline.push({ message: liveMessage(attempt), seq: attempt.seq })
  timeline.push(...pendingMessages(session))
  timeline.sort((left, right) => left.seq - right.seq)
  const sessionSnapshot = session.getSnapshot()
  const sessionError = sessionSnapshot.promptError?.error.message
    ?? sessionSnapshot.lastAgentError
    ?? sessionSnapshot.openError?.message
  return {
    messages: timeline.map(item => item.message),
    isRunning: sessionSnapshot.running || live.size > 0,
    isLoading: sessionSnapshot.openState !== 'open',
    hasEarlier: sessionSnapshot.hasMore,
    errorMessage: sessionError ?? turnError,
    connectionError: sessionSnapshot.openError?.message ?? undefined,
  }
}

function finishStatus(stream: readonly AssistantStreamRecord[]): ThreadMessageLike['status'] {
  const finish = [...stream].reverse().find(item => item.type === 'chunk' && item.chunk.type === 'finish')
  if (finish?.type !== 'chunk' || finish.chunk.type !== 'finish') return { type: 'complete', reason: 'unknown' }
  switch (finish.chunk.reason.kind) {
    case 'stop': return { type: 'complete', reason: 'stop' }
    case 'max-tokens': return { type: 'incomplete', reason: 'length' }
    case 'aborted': return { type: 'incomplete', reason: 'cancelled' }
    case 'error': return { type: 'incomplete', reason: 'error' }
    default: return { type: 'complete', reason: 'unknown' }
  }
}

function userMessage(event: SessionEvent<'user/message'>): ThreadMessageLike | undefined {
  if (event.data.source.kind !== 'user') return undefined
  const text = textOfContent(event.data.content)
  return {
    id: String(event.data.id),
    role: 'user',
    content: [{ type: 'text', text }],
    createdAt: new Date(event.time),
    metadata: { custom: { dshSeq: event.seq } },
  }
}


function textOfAppendMessage(message: AppendMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
}

function failureMessage(error: { readonly message: string }): Error {
  return new Error(`DSH prompt rejected: ${error.message}`)
}

export class DshSessionAdapter {
  private readonly listeners = new Set<() => void>()
  private readonly stopSession: () => void
  private readonly stopEvents: () => void
  private readonly inFlight = new WeakMap<object, Promise<void>>()
  private snapshot: DshChatSnapshot
  private ownershipError: string | undefined

  constructor(private readonly options: DshSessionAdapterOptions) {
    this.snapshot = projectDshEvents(options.binding.session, options.binding.eventSource)
    this.stopSession = options.binding.session.subscribe(() => { this.publish() })
    this.stopEvents = options.binding.eventSource.subscribe(() => { this.publish() })
  }

  getSnapshot = (): DshChatSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  runtimeOptions = (): ExternalStoreAdapter<ThreadMessageLike> => ({
    messages: this.snapshot.messages,
    isRunning: this.snapshot.isRunning,
    isLoading: this.snapshot.isLoading,
    isSendDisabled: this.snapshot.isLoading || this.snapshot.connectionError !== undefined,
    hasEarlier: this.snapshot.hasEarlier,
    onNew: this.onNew,
    onCancel: this.onCancel,
    onLoadEarlier: this.onLoadEarlier,
  })

  onNew = async (message: AppendMessage): Promise<void> => {
    if (this.snapshot.isLoading || this.snapshot.connectionError !== undefined) {
      throw new MessageNotSentError(this.snapshot.connectionError ?? 'The Session is still connecting.')
    }
    const key = message as object
    const previous = this.inFlight.get(key)
    if (previous !== undefined) return previous
    const operation = this.submit(message)
    this.inFlight.set(key, operation)
    try {
      await operation
    } finally {
      this.inFlight.delete(key)
    }
  }

  onCancel = async (): Promise<void> => {
    const result = await this.options.binding.session.cancel()
    if (!result.ok) throw failureMessage(result.error)
  }

  onLoadEarlier = async (): Promise<void> => {
    await this.options.binding.session.loadOlder()
  }

  dispose(): void {
    this.stopSession()
    this.stopEvents()
    this.listeners.clear()
  }

  setOwnershipError(message: string | undefined): void {
    if (message === this.ownershipError) return
    this.ownershipError = message
    this.publish()
  }

  private async submit(message: AppendMessage): Promise<void> {
    if (message.role !== 'user') throw new Error('assistant-ui PoC accepts user messages only')
    const text = textOfAppendMessage(message)
    if (text.trim().length === 0) throw new Error('assistant-ui PoC does not send blank messages')
    const submission = this.options.binding.session.beginSubmission({
      mode: message.steer === true ? 'steer' : 'queue',
      text,
      attachments: [],
    })
    try {
      const result = await this.options.binding.session.prompt(
        [{ type: 'text', text }],
        message.steer === true ? 'steer' : 'queue',
        undefined,
        submission.requestId,
      )
      if (!result.ok) throw new MessageNotSentError(`DSH prompt rejected: ${result.error.message}`)
    } catch (error) {
      submission.abandon()
      throw error
    }
  }

  private publish(): void {
    const projected = projectDshEvents(this.options.binding.session, this.options.binding.eventSource)
    this.snapshot = {
      ...projected,
      connectionError: this.ownershipError ?? projected.connectionError,
      errorMessage: this.ownershipError ?? projected.errorMessage,
    }
    for (const listener of this.listeners) listener()
  }
}
