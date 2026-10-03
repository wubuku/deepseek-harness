/**
 * Worker-side providers for the browser-native DSH PoC.
 *
 * The module is bundled into the Dedicated Worker, but the DSH service classes
 * are resolved from the mounted Worker VFS at factory-call time. This keeps the
 * provider subclasses on the same Cordis/DSH runtime identities as the profile
 * that loads them.
 */
import { requireActiveModuleLoader, type StaticModuleFactory } from '../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {
  GenerateOptions,
  LlmAdapter,
  LlmModelInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset,
  Session,
} from '@deepseek-ai/dsh-session'
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
  SessionHandleReadResult,
  SessionPersistence,
  SessionPersistenceCreateOptions,
  SessionPersistenceListOptions,
  SessionPersistenceOpenOptions,
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
  SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'

const PROTOCOL_VERSION = 1
const SESSION_ROUTE = '/api/browser-native/session'
const LLM_ROUTE = '/api/browser-native/llm'
const activeSessionOwners = new Map<string, string>()

interface ErrorPayload {
  readonly error?: { readonly code?: string; readonly message?: string }
}

interface SessionResponse {
  readonly header?: SessionHeader
  readonly inheritedEventCount?: number
  readonly events?: readonly SessionEvent[]
  readonly eventState?: SessionHandleReadResult['eventState']
  readonly revision?: string
  readonly nextSeq?: number
  readonly owner?: BrowserNativeOwner
  readonly snapshots?: readonly SessionPersistenceSnapshot[]
}

interface LlmStreamResponse {
  readonly kind?: 'chunk' | 'error'
  readonly chunk?: StreamChunk
  readonly error?: { readonly code?: string; readonly message?: string }
}

interface RuntimePersistenceModule {
  readonly SessionPersistence: typeof import('@deepseek-ai/dsh-session-persistence').SessionPersistence
  readonly SessionAlreadyExistsError: typeof import('@deepseek-ai/dsh-session-persistence').SessionAlreadyExistsError
  readonly SessionAlreadyOwnedError: typeof import('@deepseek-ai/dsh-session-persistence').SessionAlreadyOwnedError
  readonly SessionHandleClosedError: typeof import('@deepseek-ai/dsh-session-persistence').SessionHandleClosedError
  readonly SessionOwnershipLostError: typeof import('@deepseek-ai/dsh-session-persistence').SessionOwnershipLostError
  readonly SessionPersistenceNotFoundError: typeof import('@deepseek-ai/dsh-session-persistence').SessionPersistenceNotFoundError
  readonly SessionReadOnlyError: typeof import('@deepseek-ai/dsh-session-persistence').SessionReadOnlyError
}

interface RuntimeLlmModule {
  readonly LlmAdapter: typeof import('@deepseek-ai/dsh-llm').LlmAdapter
  readonly LlmError: typeof import('@deepseek-ai/dsh-llm').LlmError
}

interface BrowserNativeOwner {
  readonly ownerToken: string
}

interface BrowserNativeSessionHandle extends SessionHandle {
  readonly ownerToken?: string
}

function loaderRequire(): (specifier: string) => unknown {
  return requireActiveModuleLoader().requireFrom('/dsh')
}

function runtimePersistence(): RuntimePersistenceModule {
  return loaderRequire()('@deepseek-ai/dsh-session-persistence') as RuntimePersistenceModule
}

function runtimeLlm(): RuntimeLlmModule {
  return loaderRequire()('@deepseek-ai/dsh-llm') as RuntimeLlmModule
}

function requestId(): string {
  return globalThis.crypto.randomUUID()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function responseError(value: ErrorPayload, fallback: string): { code: string; message: string } {
  return {
    code: value.error?.code ?? 'REMOTE_ERROR',
    message: value.error?.message ?? fallback,
  }
}

async function readJson(response: Response): Promise<ErrorPayload & SessionResponse> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`browser-native backend returned invalid JSON: ${String(error)}`)
  }
  if (!isRecord(parsed)) throw new Error('browser-native backend returned a non-object response')
  return parsed as ErrorPayload & SessionResponse
}

async function sessionRequest(
  operation: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SessionResponse> {
  const response = await fetch(`${SESSION_ROUTE}/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-browser-native-protocol': String(PROTOCOL_VERSION) },
    body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId: requestId(), ...body }),
    signal,
  })
  const payload = await readJson(response)
  if (!response.ok) {
    const error = responseError(payload, `browser-native Session ${operation} failed`)
    throw Object.assign(new Error(error.message), { code: error.code })
  }
  return payload
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`browser-native Session response is missing ${name}`)
  return value
}

function mapSessionError(error: unknown, id: SessionId, operation: string): never {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
  const module = runtimePersistence()
  if (code === 'SESSION_ALREADY_EXISTS') throw new module.SessionAlreadyExistsError(id)
  if (code === 'SESSION_ALREADY_OWNED') throw new module.SessionAlreadyOwnedError(id)
  if (code === 'SESSION_NOT_FOUND') throw new module.SessionPersistenceNotFoundError(id)
  if (code === 'SESSION_OWNERSHIP_LOST') throw new module.SessionOwnershipLostError(id)
  if (code === 'READ_ONLY') throw new module.SessionReadOnlyError(id, operation)
  throw error
}

class RemoteSessionHandle implements BrowserNativeSessionHandle {
  private closed = false
  private closeOperation: Promise<void> | undefined
  private nextSeq: number
  private readonly pendingLive: SessionEvent[] = []
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    readonly id: SessionId,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
    readonly inheritedEventCount: SessionLogOffset,
    private readonly owner: BrowserNativeOwner | undefined,
    initialNextSeq: number,
    private readonly onClose: () => void,
  ) {
    this.nextSeq = initialNextSeq
  }

  get ownerToken(): string | undefined {
    return this.owner?.ownerToken
  }

  private assertOpen(operation: string): void {
    if (this.closed) throw new (runtimePersistence().SessionHandleClosedError)(this.id, operation)
  }

  private ownerBody(): Record<string, unknown> {
    if (this.access !== 'write' || this.owner === undefined) {
      throw new (runtimePersistence().SessionReadOnlyError)(this.id, 'mutation')
    }
    return { ownerToken: this.owner.ownerToken }
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.writeChain.then(operation, operation)
    this.writeChain = task.then(() => undefined, () => undefined)
    return task
  }

  private async appendEvents(events: readonly SessionEvent[], signal?: AbortSignal): Promise<void> {
    if (events.length === 0) return
    const owner = this.ownerBody()
    const result = await sessionRequest('append', {
      sessionId: this.id,
      ...owner,
      expectedNextSeq: this.nextSeq,
      events,
    }, signal)
    this.nextSeq = required(result.nextSeq, 'nextSeq')
  }

  private async drainLiveNow(): Promise<void> {
    if (this.pendingLive.length === 0) return
    const events = this.pendingLive.splice(0)
    try {
      await this.appendEvents(events)
    } catch (error) {
      this.pendingLive.unshift(...events)
      throw error
    }
  }

  enqueueLive(event: SessionEvent, report: (error: unknown) => void): void {
    if (this.closed || this.access !== 'write') return
    this.pendingLive.push(event)
    void this.enqueueWrite(() => this.drainLiveNow()).catch(report)
  }

  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    try {
      await this.writeChain
      const result = await sessionRequest('read', { sessionId: this.id, offset, length }, options?.signal)
      this.nextSeq = Math.max(this.nextSeq, required(result.nextSeq, 'nextSeq'))
      return {
        eventState: required(result.eventState, 'eventState'),
        events: required(result.events, 'events'),
      }
    } catch (error) {
      mapSessionError(error, this.id, 'read')
    }
  }

  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen('append')
    try {
      await this.enqueueWrite(async () => {
        this.assertOpen('append')
        await this.drainLiveNow()
        await this.appendEvents(events, options?.signal)
      })
    } catch (error) {
      mapSessionError(error, this.id, 'append')
    }
  }

  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen('flush')
    try {
      await this.enqueueWrite(async () => {
        this.assertOpen('flush')
        await this.drainLiveNow()
        const result = await sessionRequest('flush', { sessionId: this.id, ...this.ownerBody() }, options?.signal)
        this.nextSeq = Math.max(this.nextSeq, required(result.nextSeq, 'nextSeq'))
      })
    } catch (error) {
      mapSessionError(error, this.id, 'flush')
    }
  }

  async close(): Promise<void> {
    if (this.closeOperation !== undefined) return this.closeOperation
    if (this.closed) return
    this.closeOperation = (async () => {
      if (this.access === 'write' && this.owner !== undefined) {
        try {
          await this.enqueueWrite(async () => {
            await this.drainLiveNow()
            await sessionRequest('close', { sessionId: this.id, ...this.owner }, undefined)
          })
        } catch (error) {
          mapSessionError(error, this.id, 'close')
        }
      }
      this.closed = true
      this.onClose()
    })()
    return this.closeOperation
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}

function createRemoteSessionPersistenceClass(): typeof import('@deepseek-ai/dsh-session-persistence').SessionPersistence {
  const Base = runtimePersistence().SessionPersistence
  return class RemoteSessionPersistence extends Base {
    override readonly name = 'session-persistence-browser-native'
    private readonly handles = new Set<RemoteSessionHandle>()
    private readonly writers = new Map<SessionId, RemoteSessionHandle>()

    constructor(ctx: Context) {
      super(ctx)
      ctx.on('session/event', (session: Session, event: SessionEvent) => {
        this.writers.get(session.id)?.enqueueLive(event, error => {
          ctx.logger.warn(`browser-native session write failed for "${session.id}": ${String(error)}`)
        })
      })
      ctx.on('session/flush', (session: Session) => {
        const handle = this.writers.get(session.id)
        return handle === undefined ? undefined : handle.flush()
      })
      ctx.on('session/disposed', (session: Session) => {
        const handle = this.writers.get(session.id)
        if (handle === undefined) return
        void handle.close().catch(error => {
          ctx.logger.warn(`browser-native session close failed for "${session.id}": ${String(error)}`)
        })
      })
      ctx.effect(() => async () => {
        const errors: unknown[] = []
        for (const handle of [...this.handles]) {
          try {
            await handle.close()
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, 'browser-native session persistence dispose failed')
      }, 'session-persistence-browser-native open handles')
    }

    private untrack(handle: RemoteSessionHandle): void {
      this.handles.delete(handle)
      if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id)
    }

    private track(response: SessionResponse, id: SessionId, access: SessionAccess): SessionHandle {
      const owner = response.owner === undefined ? undefined : response.owner as BrowserNativeOwner
      let handle: RemoteSessionHandle
      handle = new RemoteSessionHandle(
        id,
        required(response.header, 'header'),
        access,
        required(response.inheritedEventCount, 'inheritedEventCount') as SessionLogOffset,
        owner,
        required(response.nextSeq, 'nextSeq'),
        () => {
          if (owner !== undefined) activeSessionOwners.delete(id)
          this.untrack(handle)
        },
      )
      this.handles.add(handle)
      if (access === 'write') {
        this.writers.set(id, handle)
        if (owner !== undefined) activeSessionOwners.set(id, owner.ownerToken)
      }
      return handle
    }

    async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
      try {
        const response = await sessionRequest('create', {
          sessionId: header.id,
          header,
          inheritedEventCount: options?.inheritedEventCount ?? 0,
        }, options?.signal)
        return this.track(response, header.id, 'write')
      } catch (error) {
        mapSessionError(error, header.id, 'create')
      }
    }

    async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
      try {
        const response = await sessionRequest('open', { sessionId: id, access }, options?.signal)
        return this.track(response, id, access)
      } catch (error) {
        mapSessionError(error, id, 'open')
      }
    }

    async flush(): Promise<void> {
      const results = await Promise.allSettled([...this.writers.values()].map(handle => handle.flush()))
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError(errors, 'browser-native session persistence flush failed')
    }

    async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
      const response = await sessionRequest('stat', { sessionId: id }, options?.signal)
      if (response.header === undefined) return undefined
      return {
        header: response.header,
        revision: required(response.revision, 'revision') as SessionPersistenceRevision,
        eventCount: response.nextSeq,
      }
    }

    async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
      const response = await sessionRequest('list', {}, options?.signal)
      return required(response.snapshots, 'snapshots')
    }
  }
}

function textFromContent(content: RequestMessage['content']): string {
  if (typeof content === 'string') return content
  return content.map(block => {
    switch (block.type) {
      case 'text': return block.text
      case 'reasoning': return block.text
      case 'file': return `[file: ${block.attachment.name}]`
      case 'image': return '[image]'
      case 'tool-call': return ''
      default: return ''
    }
  }).join('')
}

interface WireMessage {
  readonly role: string
  readonly content: string
  readonly tool_calls?: readonly { readonly id: string; readonly type: 'function'; readonly function: { readonly name: string; readonly arguments: string } }[]
  readonly tool_call_id?: string
}

function toWireMessage(message: RequestMessage): WireMessage {
  const toolCalls = typeof message.content === 'string' ? [] : message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: textFromContent(message.content),
      tool_call_id: message.source.callId,
    }
  }
  return {
    role: message.role,
    content: textFromContent(message.content),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  }
}

function toWireTools(tools: readonly ToolSchema[] | undefined): readonly unknown[] | undefined {
  if (tools === undefined) return undefined
  return tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

function createRemoteLlmAdapterClass(): typeof import('@deepseek-ai/dsh-llm').LlmAdapter {
  const Base = runtimeLlm().LlmAdapter
  return class RemoteLlmAdapter extends Base {
    override providerInfo(provider: string): { id: string; name: string } {
      return { id: provider, name: 'Browser-native remote' }
    }

    override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
      return Promise.resolve([{ provider, id: 'browser-native', name: 'Browser-native remote' }])
    }

    override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 128_000 } })
    }

    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const response = await fetch(LLM_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-browser-native-protocol': String(PROTOCOL_VERSION) },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        requestId: requestId(),
        sessionId: options.sessionId,
        ownerToken: options.sessionId === undefined ? undefined : activeSessionOwners.get(options.sessionId),
        provider: options.provider,
        model: options.model,
        messages: options.messages.map(toWireMessage),
        tools: toWireTools(options.tools),
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        reasoningEffort: options.reasoningEffort,
      }),
      signal: options.signal,
    })
      if (!response.ok || response.body === null) {
        const payload = await readJson(response)
        const error = responseError(payload, 'browser-native LLM request failed')
        const { LlmError } = runtimeLlm()
        throw new LlmError(error.message, error.code, { status: response.status })
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const part = await reader.read()
        buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done })
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line.length > 0) {
            const item = JSON.parse(line) as LlmStreamResponse
            if (item.kind === 'error') {
              const { LlmError } = runtimeLlm()
              throw new LlmError(item.error?.message ?? 'browser-native LLM stream failed', item.error?.code ?? 'REMOTE_LLM')
            }
            if (item.kind === 'chunk' && item.chunk !== undefined) yield item.chunk
          }
          newline = buffer.indexOf('\n')
        }
        if (part.done) break
      }
      const tail = buffer.trim()
      if (tail.length > 0) {
        const item = JSON.parse(tail) as LlmStreamResponse
        if (item.kind === 'chunk' && item.chunk !== undefined) yield item.chunk
      }
    }
  }
}

function createSessionModule(): unknown {
  let module: unknown
  return () => {
    const RemoteSessionPersistence = createRemoteSessionPersistenceClass()
    module ??= { default: RemoteSessionPersistence, RemoteSessionPersistence }
    return module
  }
}

function createLlmModule(): unknown {
  let module: unknown
  return () => {
    const RemoteLlmAdapter = createRemoteLlmAdapterClass()
    module ??= {
      default: (ctx: Context): void => {
        const adapter = new RemoteLlmAdapter()
        ctx.effect(() => ctx.llm.registerAdapter(['browser-native'], adapter))
      },
      RemoteLlmAdapter,
    }
    return module
  }
}

/** Return the static module table consumed by the custom Worker entry. */
export function createBrowserNativeStaticModules(): Readonly<Record<string, StaticModuleFactory>> {
  return {
    '@deepseek-ai/dsh-browser-native-session-persistence': createSessionModule(),
    '@deepseek-ai/dsh-browser-native-llm': createLlmModule(),
  }
}
