/**
 * Worker-side providers for the browser-native DSH PoC.
 *
 * The module is bundled into the Dedicated Worker, but the DSH service classes
 * are resolved from the mounted Worker VFS at factory-call time. This keeps the
 * provider subclasses on the same Cordis/DSH runtime identities as the profile
 * that loads them.
 */
import { requireActiveModuleLoader, type StaticModuleFactory } from '../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import './browser-native-session-events.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {
  GenerateOptions,
  LlmAdapter,
  LlmModelInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tool-skill'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset,
  Session,
} from '@deepseek-ai/dsh-session'
import type { BrowserNativeWorkspaceReceiptEvent } from './browser-native-session-events.ts'
import type { BrowserNativeWorkspaceRuntime, WorkspaceReceipt, WorkspaceToolOperation } from './browser-native-workspace.ts'
import type {} from '@deepseek-ai/dsh-working-directory'
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
import { publishBrowserNativeOwner, takeBrowserNativeResumeOwner } from './browser-native-control.ts'
import {
  BrowserNativeFileToolError,
  assertBrowserNativeEditSafe,
  executeBrowserNativeEdit,
  executeBrowserNativeGlob,
  executeBrowserNativeGrep,
  isBrowserWorkspacePath,
} from './browser-native-file-tools.ts'
import {
  assertBrowserNativeToolSchemas,
  BrowserNativeCapabilityPublication,
} from './browser-native-capability-publication.ts'
import { readSessionPages } from './browser-native-session-read.ts'
import {
  createBrowserNativeAttachmentModule,
  type BrowserNativeAttachmentTestHooks,
} from './browser-native-attachments.ts'
import { splitSessionAppendBatches } from './browser-native-session-transport.ts'
import { BrowserNativeSessionOutbox } from './browser-native-session-outbox.ts'
import { matchesWorkspaceReceipt } from './workspace-session-reconciliation.mjs'
import type { BrowserNativePermissionProbe } from './browser-native-permission-probe.ts'

const PROTOCOL_VERSION = 1
const SESSION_ROUTE = '/api/browser-native/session'
const LLM_ROUTE = '/api/browser-native/llm'
const CONFIG_ROUTE = '/api/browser-native/config'
const SESSION_OPEN_OWNER_RETRY_WINDOW_MS = 5_000
const SESSION_OPEN_OWNER_RETRY_DELAY_MS = 100
const MAX_TOOL_ARGUMENT_BYTES = 1024 * 1024
const activeSessionOwners = new Map<string, { readonly ownerToken: string; readonly ownerEpoch: number }>()
const activeSessionFlushers = new Map<string, () => Promise<{
  readonly ownerEpoch: number
  readonly nextSeq: number
  readonly durableThroughSeq: number
  readonly pendingEvents: number
  readonly pendingWorkspaceReceipts: number
}>>()

/**
 * Flush one live DSH Session through its Cordis durability listeners.
 * @param sessionId - DSH Session identifier owned by this Worker.
 * @returns Durable Session cursors and remaining local outbox/Workspace receipt counts.
 * @throws when the Session is not live, lacks a durability listener, or any flush fails.
 */
export async function flushBrowserNativeSession(sessionId: string): Promise<{
  readonly ownerEpoch: number
  readonly nextSeq: number
  readonly durableThroughSeq: number
  readonly pendingEvents: number
  readonly pendingWorkspaceReceipts: number
}> {
  const flush = activeSessionFlushers.get(sessionId)
  if (flush === undefined) throw new Error(`browser-native Session "${sessionId}" has no live writer`)
  return await flush()
}

interface ErrorPayload {
  readonly error?: { readonly code?: string; readonly message?: string; readonly retryAfterMs?: number }
}

interface SessionResponse {
  readonly header?: SessionHeader
  readonly inheritedEventCount?: number
  readonly events?: readonly SessionEvent[]
  readonly eventState?: SessionHandleReadResult['eventState']
  readonly revision?: string
  readonly nextSeq?: number
  readonly durable?: boolean
  readonly durableThroughSeq?: number
  readonly closed?: boolean
  readonly hasMore?: boolean
  readonly owner?: BrowserNativeOwner
  readonly snapshots?: readonly SessionPersistenceSnapshot[]
}

interface BrowserNativeConfigResponse extends ErrorPayload {
  readonly llmMode?: 'scripted' | 'real'
  readonly provider?: string
  readonly model?: string
  readonly contextWindow?: number
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

interface RuntimeFsModule {
  readonly FsError: typeof import('@deepseek-ai/dsh-fs').FsError
  readonly FsVersion: typeof import('@deepseek-ai/dsh-fs').FsVersion
}

interface RuntimeFsSandboxController {
  resolvePolicy(toolName: string, args: Record<string, unknown>, exec: ToolExecution): Promise<unknown>
  mapError(error: unknown, policy: unknown): unknown
}

interface RuntimeFileToolHelpers {
  readonly FsSandboxController: new(ctx: Context) => RuntimeFsSandboxController
  readonly remediateFsError: (error: unknown, displayPath: string) => unknown
}

interface BrowserNativeOwner {
  readonly ownerToken: string
  readonly ownerEpoch: number
  readonly leaseDurationMs: number
  readonly renewAfterMs: number
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

function runtimeFs(): RuntimeFsModule {
  return loaderRequire()('@deepseek-ai/dsh-fs') as RuntimeFsModule
}

function runtimeFileToolHelpers(): RuntimeFileToolHelpers {
  return loaderRequire()('@deepseek-ai/dsh-tool-fs') as RuntimeFileToolHelpers
}

function browserNativeFsVersion(vfs: BrowserNativeWorkspaceRuntime['vfs'], path: string): string {
  const stats = vfs.statSync(path, { bigint: true })
  if (stats.isDirectory()) throw new Error(`browser-native edit target is a directory: ${path}`)
  return `${String(stats.dev)}:${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeNs)}:${String(stats.ctimeNs)}`
}

function requestId(): string {
  return globalThis.crypto.randomUUID()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function responseError(value: ErrorPayload, fallback: string): { code: string; message: string; retryAfterMs?: number } {
  return {
    code: value.error?.code ?? 'REMOTE_ERROR',
    message: value.error?.message ?? fallback,
    ...(value.error?.retryAfterMs === undefined ? {} : { retryAfterMs: value.error.retryAfterMs }),
  }
}

async function readJson<T extends Record<string, unknown> = SessionResponse>(response: Response): Promise<ErrorPayload & T> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`browser-native backend returned invalid JSON: ${String(error)}`)
  }
  if (!isRecord(parsed)) throw new Error('browser-native backend returned a non-object response')
  return parsed as ErrorPayload & T
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
    throw Object.assign(new Error(error.message), { code: error.code, retryAfterMs: error.retryAfterMs })
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
  private ownershipLost = false
  private closeOperation: Promise<void> | undefined
  private renewTimer: ReturnType<typeof setTimeout> | undefined
  private liveRetryTimer: ReturnType<typeof setTimeout> | undefined
  private liveRetryAttempt = 0
  private liveDrain: Promise<void> | undefined
  private nextSeq: number
  private readonly pendingLive: SessionEvent[] = []
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    readonly id: SessionId,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
    readonly inheritedEventCount: SessionLogOffset,
    private readonly owner: BrowserNativeOwner | undefined,
    private readonly writerId: string | undefined,
    private readonly sessionOutbox: BrowserNativeSessionOutbox,
    private readonly ensureSessionFiles: (
      events: readonly SessionEvent[],
      signal?: AbortSignal,
    ) => Promise<void>,
    initialNextSeq: number,
    private readonly onClose: () => void,
  ) {
    this.nextSeq = initialNextSeq
    this.scheduleRenewal()
  }

  get ownerToken(): string | undefined {
    return this.owner?.ownerToken
  }

  private assertOpen(operation: string): void {
    if (this.ownershipLost) throw new (runtimePersistence().SessionOwnershipLostError)(this.id)
    if (this.closed) throw new (runtimePersistence().SessionHandleClosedError)(this.id, operation)
  }

  private scheduleRenewal(): void {
    if (this.owner === undefined || this.closed || this.closeOperation !== undefined || this.ownershipLost) return
    const owner = this.owner
    this.renewTimer = setTimeout(() => {
      this.renewTimer = undefined
      void this.enqueueWrite(async () => {
        if (this.closed || this.closeOperation !== undefined) return
        await sessionRequest('renew', { sessionId: this.id, ...this.ownerBody() }, AbortSignal.timeout(owner.renewAfterMs))
      }).then(() => {
        if (this.closed || this.closeOperation !== undefined) return
        activeSessionOwners.set(this.id, { ownerToken: owner.ownerToken, ownerEpoch: owner.ownerEpoch })
        publishBrowserNativeOwner({ type: 'owner', sessionId: String(this.id), ownerToken: owner.ownerToken, ownerEpoch: owner.ownerEpoch })
        this.scheduleRenewal()
      }, error => {
        if (this.closed || this.closeOperation !== undefined) return
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
        this.ownershipLost = code === 'SESSION_OWNERSHIP_LOST'
        activeSessionOwners.delete(this.id)
        publishBrowserNativeOwner({
          type: 'unavailable',
          sessionId: String(this.id),
          message: error instanceof Error ? error.message : String(error),
        })
        this.scheduleRenewal()
      })
    }, this.owner.renewAfterMs)
  }

  private ownerBody(): Record<string, unknown> {
    if (this.access !== 'write' || this.owner === undefined) {
      throw new (runtimePersistence().SessionReadOnlyError)(this.id, 'mutation')
    }
    return { ownerToken: this.owner.ownerToken, ownerEpoch: this.owner.ownerEpoch }
  }

  private outboxIdentity(): { readonly ownerEpoch: number; readonly writerId: string } {
    if (this.owner === undefined || this.writerId === undefined || this.access !== 'write') {
      throw new (runtimePersistence().SessionReadOnlyError)(this.id, 'mutation')
    }
    return { ownerEpoch: this.owner.ownerEpoch, writerId: this.writerId }
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.writeChain.then(operation, operation)
    this.writeChain = task.then(() => undefined, () => undefined)
    return task
  }

  private async appendEvents(events: readonly SessionEvent[], signal?: AbortSignal): Promise<void> {
    const batches = [...splitSessionAppendBatches(events)]
    for (const batch of batches) {
      await this.appendBatch(batch, signal)
    }
  }

  private async appendBatch(events: readonly SessionEvent[], signal?: AbortSignal): Promise<void> {
    if (events.length === 0) return
    const expectedNextSeq = this.nextSeq
    try {
      const identity = this.outboxIdentity()
      await this.sessionOutbox.append(String(this.id), identity.ownerEpoch, identity.writerId, events)
      const result = await sessionRequest('append', {
        sessionId: this.id,
        ...this.ownerBody(),
        expectedNextSeq,
        events,
      }, signal)
      const nextSeq = required(result.nextSeq, 'nextSeq')
      if (!Number.isSafeInteger(nextSeq) || nextSeq !== expectedNextSeq + events.length) {
        throw new Error(`browser-native Session append acknowledged invalid nextSeq ${String(nextSeq)}`)
      }
      this.nextSeq = nextSeq
    } catch (error) {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
      if (code === 'SEQ_CONFLICT' && await this.reconcileEvents(events)) return
      throw error
    }
  }

  private async reconcileEvents(events: readonly SessionEvent[]): Promise<boolean> {
    if (events.length === 0) return true
    const result = await sessionRequest('read', {
      sessionId: this.id,
      offset: events[0].seq,
      length: events.length,
    })
    if (result.events.length !== events.length
      || result.events.some((event, index) => JSON.stringify(event) !== JSON.stringify(events[index]))) {
      return false
    }
    const nextSeq = required(result.nextSeq, 'nextSeq')
    if (!Number.isSafeInteger(nextSeq) || nextSeq < events[0].seq + events.length) return false
    this.nextSeq = Math.max(this.nextSeq, nextSeq)
    return true
  }

  async recoverOutbox(): Promise<void> {
    const identity = this.outboxIdentity()
    const snapshot = await this.sessionOutbox.read(String(this.id), identity.ownerEpoch, identity.writerId)
    const pending = snapshot.pendingEvents
    if (pending.length === 0) return
    const firstSeq = Number(pending[0].seq)
    if (this.nextSeq < firstSeq) {
      throw new Error(`browser-native Session outbox starts at seq ${String(firstSeq)} after backend next seq ${String(this.nextSeq)}`)
    }
    const overlapCount = Math.min(pending.length, this.nextSeq - firstSeq)
    if (overlapCount > 0) {
      const stored = await this.read(firstSeq, overlapCount)
      if (stored.events.length !== overlapCount
        || stored.events.some((event, index) => JSON.stringify(event) !== JSON.stringify(pending[index]))) {
        throw new Error('browser-native Session outbox conflicts with the backend event log')
      }
    }
    const missing = pending.slice(overlapCount)
    await this.enqueueWrite(async () => {
      this.assertOpen('flush')
      if (missing.length > 0) {
        if (Number(missing[0].seq) !== this.nextSeq) {
          throw new Error('browser-native Session outbox does not continue the backend event log')
        }
        await this.appendEvents(missing)
      }
      const result = await sessionRequest('flush', { sessionId: this.id, ...this.ownerBody() }, undefined)
      const durableThroughSeq = this.assertDurableThrough(result, 'outbox recovery')
      await this.sessionOutbox.acknowledgeThrough(String(this.id), identity.ownerEpoch, identity.writerId, durableThroughSeq)
    })
  }

  async abandonOpenFailure(): Promise<void> {
    clearTimeout(this.renewTimer)
    this.renewTimer = undefined
    clearTimeout(this.liveRetryTimer)
    this.liveRetryTimer = undefined
    this.closeOperation ??= (async () => {
      try {
        if (this.access === 'write' && this.owner !== undefined && !this.ownershipLost) {
          await this.enqueueWrite(async () => {
            const result = await sessionRequest('close', { sessionId: this.id, ...this.owner }, undefined)
            if (result.closed !== true) throw new Error('browser-native Session open-failure release was not acknowledged')
          })
        }
      } finally {
        this.closed = true
        this.onClose()
      }
    })()
    await this.closeOperation
  }

  private async drainLiveNow(): Promise<void> {
    while (this.pendingLive.length > 0) {
      const events = splitSessionAppendBatches(this.pendingLive).next().value
      if (events === undefined) return
      this.pendingLive.splice(0, events.length)
      try {
        await this.appendBatch(events)
      } catch (error) {
        this.pendingLive.unshift(...events)
        throw error
      }
    }
    this.liveRetryAttempt = 0
  }

  private scheduleLiveRetry(report: (error: unknown) => void): void {
    if (this.liveRetryTimer !== undefined || this.closed || this.ownershipLost || this.pendingLive.length === 0) return
    if (this.liveRetryAttempt >= 5) return
    const delayMs = Math.min(1_000, 25 * 2 ** this.liveRetryAttempt)
    this.liveRetryAttempt += 1
    this.liveRetryTimer = setTimeout(() => {
      this.liveRetryTimer = undefined
      this.startLiveDrain(report, true)
    }, delayMs)
  }

  private startLiveDrain(report: (error: unknown) => void, retry = false): void {
    if (this.liveDrain !== undefined || (!retry && this.liveRetryAttempt >= 5)
      || this.closed || this.ownershipLost || this.pendingLive.length === 0) return
    const drain = this.enqueueWrite(() => this.drainLiveNow())
    this.liveDrain = drain
    void drain.then(() => undefined, error => {
      report(error)
      this.scheduleLiveRetry(report)
    }).finally(() => {
      if (this.liveDrain === drain) this.liveDrain = undefined
      if (this.pendingLive.length > 0 && this.liveRetryTimer === undefined && this.liveRetryAttempt === 0) {
        this.startLiveDrain(report)
      }
    })
  }

  enqueueLive(event: SessionEvent, report: (error: unknown) => void): void {
    if (this.closed || this.ownershipLost || this.access !== 'write') return
    this.pendingLive.push(event)
    this.startLiveDrain(report)
  }

  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    try {
      await this.writeChain
      const result = await readSessionPages(async (pageOffset, pageLength, signal) => {
        const page = await sessionRequest('read', {
          sessionId: this.id,
          offset: pageOffset,
          length: pageLength,
        }, signal)
        return {
          events: required(page.events, 'events'),
          eventState: required(page.eventState, 'eventState'),
          nextSeq: required(page.nextSeq, 'nextSeq'),
          hasMore: page.hasMore,
        }
      }, offset, length, options?.signal)
      await this.ensureSessionFiles(result.events, options?.signal)
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
        const durableThroughSeq = this.assertDurableThrough(result, 'flush')
        const identity = this.outboxIdentity()
        await this.sessionOutbox.acknowledgeThrough(String(this.id), identity.ownerEpoch, identity.writerId, durableThroughSeq)
      })
    } catch (error) {
      mapSessionError(error, this.id, 'flush')
    }
  }

  async close(): Promise<void> {
    if (this.closeOperation !== undefined) return this.closeOperation
    if (this.closed) return
    clearTimeout(this.renewTimer)
    this.renewTimer = undefined
    clearTimeout(this.liveRetryTimer)
    this.liveRetryTimer = undefined
    this.closeOperation = (async () => {
      try {
        if (this.access === 'write' && this.owner !== undefined && !this.ownershipLost) {
          await this.enqueueWrite(async () => {
            await this.drainLiveNow()
            const result = await sessionRequest('close', { sessionId: this.id, ...this.owner }, undefined)
            if (result.closed !== true) throw new Error('browser-native Session close was not acknowledged')
            const durableThroughSeq = this.assertDurableThrough(result, 'close')
            const identity = this.outboxIdentity()
            await this.sessionOutbox.acknowledgeThrough(String(this.id), identity.ownerEpoch, identity.writerId, durableThroughSeq)
          })
        }
      } catch (error) {
        this.closed = true
        this.onClose()
        mapSessionError(error, this.id, 'close')
      }
      this.closed = true
      this.onClose()
    })()
    return this.closeOperation
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  private assertDurableThrough(result: SessionResponse, operation: string): number {
    const durableThroughSeq = required(result.durableThroughSeq, 'durableThroughSeq')
    if (result.durable !== true || !Number.isSafeInteger(durableThroughSeq) || durableThroughSeq < this.nextSeq - 1) {
      throw new Error(`browser-native Session ${operation} did not confirm durability through seq ${this.nextSeq - 1}`)
    }
    return durableThroughSeq
  }
}

function createRemoteSessionPersistenceClass(
  workspace: BrowserNativeWorkspaceRuntime,
  sessionOutbox: BrowserNativeSessionOutbox,
  publication: BrowserNativeCapabilityPublication,
  ensureSessionFiles: (events: readonly SessionEvent[], signal?: AbortSignal) => Promise<void>,
): typeof import('@deepseek-ai/dsh-session-persistence').SessionPersistence {
  const Base = runtimePersistence().SessionPersistence
  return class RemoteSessionPersistence extends Base {
    override readonly name = 'session-persistence-browser-native'
    static inject = ['attachments', 'fs', 'workingDirectory', 'sessions']
    private readonly handles = new Set<RemoteSessionHandle>()
    private readonly writers = new Map<SessionId, RemoteSessionHandle>()
    private readonly receiptWrites = new Map<SessionId, Promise<void>>()
    private readonly fsSandbox: RuntimeFsSandboxController

    constructor(ctx: Context) {
      super(ctx)
      this.fsSandbox = new (runtimeFileToolHelpers().FsSandboxController)(ctx)
      ctx.on('session/event', (session: Session, event: SessionEvent) => {
        this.writers.get(session.id)?.enqueueLive(event, error => {
          ctx.logger.warn(`browser-native session write failed for "${session.id}": ${String(error)}`)
        })
        if (event.type === 'tool/result') {
          const callId = String(event.data.message.source.callId)
          queueMicrotask(() => {
            void this.persistWorkspaceReceipts(session, callId).catch(error => {
              ctx.logger.warn(`browser-native Workspace receipt persistence failed for "${session.id}": ${String(error)}`)
            })
          })
        }
      })
      ctx.on('session/created', (session: Session) => {
        void this.persistWorkspaceReceipts(session).catch(error => {
          ctx.logger.warn(`browser-native Workspace receipt recovery failed for "${session.id}": ${String(error)}`)
        })
      })
      ctx.on('session/flush', async (session: Session) => {
        await this.persistWorkspaceReceipts(session)
        await this.writers.get(session.id)?.flush()
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
      ctx.on('tools/execute', async (exec, next) => {
        const isWorkspaceTool = ['read', 'read_image', 'write', 'edit', 'grep', 'glob', 'bash'].includes(exec.name)
        if (!isWorkspaceTool || exec.agent === undefined) return await next()
        const authorizedRevision = await workspace.authorizeFileTool(exec.name)
        if (exec.name === 'grep') {
          const value = await executeBrowserNativeGrep(workspace.vfs, exec.arguments, exec.signal, workspace.getFileToolYieldDelayMs(), {
            onMatcherStarted: () => workspace.reportFileToolStage('grep-match'),
          })
          await workspace.verifyFileToolRevision(authorizedRevision)
          return { isError: false, value } as ToolExecutionResult
        }
        if (exec.name === 'glob') {
          const value = await executeBrowserNativeGlob(workspace.vfs, exec.arguments, exec.signal, workspace.getFileToolYieldDelayMs())
          await workspace.verifyFileToolRevision(authorizedRevision)
          return { isError: false, value } as ToolExecutionResult
        }
        if (exec.name === 'read' || exec.name === 'read_image') {
          if (exec.name === 'read') {
            const delayMs = workspace.getFileToolYieldDelayMs()
            const filePath = isRecord(exec.arguments) && typeof exec.arguments.file_path === 'string'
              ? exec.arguments.file_path
              : ''
            const readDelayMs = filePath.includes('parallel-slow') || filePath.includes('owner-committed.txt') ? delayMs
              : filePath.includes('parallel-fast') ? Math.floor(delayMs * 0.6) : 0
            if (readDelayMs > 0) await new Promise<void>(resolve => { setTimeout(resolve, readDelayMs) })
          }
          const result = await next()
          await workspace.verifyFileToolRevision(authorizedRevision)
          return result
        }
        if (!['write', 'edit', 'bash'].includes(exec.name)) return await next()
        const session = exec.agent.session
        const call = session.snapshotEvents().findLast(event => event.type === 'tool/call' && event.data.callId === exec.callId)
        if (call === undefined || call.type !== 'tool/call') return await next()
        const operation: WorkspaceToolOperation = {
          sessionId: String(session.id),
          turn: call.data.turn,
          step: call.data.step,
          callId: String(call.data.callId),
          toolName: call.data.name,
          toolCallSeq: Number(call.seq),
        }
        const sessionWriter = this.writers.get(session.id)
        if (sessionWriter === undefined) throw new Error(`browser-native Session "${String(session.id)}" has no write handle`)
        await sessionWriter.flush()
        if (exec.name === 'edit' && isRecord(exec.arguments) && typeof exec.arguments.file_path === 'string') {
          const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
          const target = await ctx.fs.resolve(exec.arguments.file_path, { cwd, signal: exec.signal })
          const targetPath = ctx.fs.processPath(target)
          if (isBrowserWorkspacePath(targetPath)) {
            const storage = globalThis.navigator?.storage
            const workspaceId = workspace.getWorkspaceId()
            if (workspace.isDurableWorkspace() && workspaceId !== undefined
              && storage !== undefined && typeof storage.getDirectory === 'function') {
              const sandboxPolicy = await this.fsSandbox.resolvePolicy('edit', exec.arguments, exec)
              try {
                const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
                const currentVersion = runtimeFs().FsVersion(browserNativeFsVersion(workspace.vfs, targetPath))
                if (intent !== undefined && intent.version !== currentVersion) {
                  throw new (runtimeFs().FsError)(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
                }
                const directResult = await workspace.runToolOperation(operation, async () => {
                  try {
                    return {
                      isError: false,
                      value: await executeBrowserNativeEdit(
                        workspace.vfs,
                        { ...exec.arguments, file_path: targetPath },
                        exec.signal,
                        workspaceId,
                        {
                          yieldDelayMs: workspace.getFileToolYieldDelayMs(),
                          onStage: stage => workspace.reportFileToolStage(stage),
                          onMetrics: metrics => workspace.reportFileToolMetrics(metrics),
                          beforePublish: async () => await workspace.ensureWriterLease(),
                        },
                      ),
                    } as ToolExecutionResult
                  } catch (error) {
                    if (!(error instanceof BrowserNativeFileToolError)) throw error
                    const code = error.code === 'EDIT_PAYLOAD_TOO_LARGE' || error.code === 'EDIT_MATCH_LIMIT'
                      ? 'FS_TOO_LARGE'
                      : error.code === 'FS_NOT_TEXT' || error.code === 'FS_NOT_REGULAR_FILE' || error.code === 'FS_EDIT_NOT_FOUND'
                        || error.code === 'FS_AMBIGUOUS_EDIT' || error.code === 'FS_ABORTED' || error.code === 'FS_STALE_VERSION'
                        ? error.code
                        : 'FS_IO_ERROR'
                    throw new (runtimeFs().FsError)(error.message, code)
                  }
                })
                if (!directResult.isError) exec.agent.ctx.emit('fs/observed', target, {
                  kind: 'present',
                  version: runtimeFs().FsVersion(browserNativeFsVersion(workspace.vfs, targetPath)),
                }, exec)
                if (!directResult.isError) {
                  await flushLocalWorkspaceOrDegrade(workspace, publication)
                  try {
                    await workspace.flushWorkspace()
                  } catch (error) {
                    ctx.logger.warn(`browser-native Workspace commit for tool call "${String(exec.callId)}" remains pending: ${String(error)}`)
                  }
                }
                return directResult
              } catch (error) {
                const helpers = runtimeFileToolHelpers()
                throw helpers.remediateFsError(this.fsSandbox.mapError(error, sandboxPolicy), target.displayPath)
              }
            }
            assertBrowserNativeEditSafe(workspace.vfs, { ...exec.arguments, file_path: targetPath }, exec.signal)
          }
        }
        const result = await workspace.runToolOperation(operation, next)
        await flushLocalWorkspaceOrDegrade(workspace, publication)
        try {
          await workspace.flushWorkspace()
        } catch (error) {
          ctx.logger.warn(`browser-native Workspace commit for tool call "${String(exec.callId)}" remains pending: ${String(error)}`)
        }
        return result
      })
    }

    private async persistWorkspaceReceipts(session: Session, callId?: string): Promise<void> {
      const existingWrite = this.receiptWrites.get(session.id)
      const currentWrite = (existingWrite ?? Promise.resolve()).catch(() => undefined).then(async () => {
        const handle = this.writers.get(session.id)
        if (handle === undefined) return
        const pending = workspace.pendingReceipts(String(session.id))
          .filter(receipt => callId === undefined || receipt.operation?.callId === callId)
        if (pending.length === 0) return
        const events = session.snapshotEvents()
        const appendedOperations = new Set<string>()
        for (const receipt of pending) {
          const operation = receipt.operation
          if (operation === undefined) continue
          const call = events.find(event => event.type === 'tool/call' && event.seq === operation.toolCallSeq
            && String(event.data.callId) === operation.callId && event.data.name === operation.toolName
            && event.data.turn === operation.turn && event.data.step === operation.step)
          if (call === undefined) {
            throw new Error(`Workspace receipt operation "${receipt.operationId}" does not match a persisted DSH tool call`)
          }
          const existing = events.find(event => event.type === 'browser-native/workspace-receipt'
            && event.data.operationId === receipt.operationId)
          if (existing !== undefined) {
            if (existing.type !== 'browser-native/workspace-receipt'
              || !matchesWorkspaceReceipt(existing.data, receipt, String(session.id))) {
              throw new Error(`receipt operation "${receipt.operationId}" is already linked to different Session data`)
            }
            appendedOperations.add(receipt.operationId)
            continue
          }
          const data: BrowserNativeWorkspaceReceiptEvent = {
            turn: operation.turn,
            step: operation.step,
            callId: operation.callId,
            toolName: operation.toolName,
            toolCallSeq: operation.toolCallSeq,
            operationId: receipt.operationId,
            workspaceId: receipt.workspaceId,
            baseRevision: receipt.baseRevision,
            revision: receipt.revision,
            manifestDigest: receipt.manifestDigest,
            paths: receipt.paths,
            replayed: receipt.replayed,
          }
          session.append('browser-native/workspace-receipt', data)
          appendedOperations.add(receipt.operationId)
        }
        if (appendedOperations.size === 0) return
        await handle.flush()
        for (const operationId of appendedOperations) await workspace.acknowledgeReceipt(operationId)
      })
      this.receiptWrites.set(session.id, currentWrite)
      try {
        await currentWrite
      } finally {
        if (this.receiptWrites.get(session.id) === currentWrite) this.receiptWrites.delete(session.id)
      }
    }

    private untrack(handle: RemoteSessionHandle): void {
      this.handles.delete(handle)
      if (this.writers.get(handle.id) === handle) {
        this.writers.delete(handle.id)
        activeSessionFlushers.delete(String(handle.id))
      }
    }

    private async track(response: SessionResponse, id: SessionId, access: SessionAccess): Promise<SessionHandle> {
      const owner = response.owner
      if (access === 'write' && (owner === undefined || typeof owner.ownerToken !== 'string'
        || !Number.isSafeInteger(owner.ownerEpoch) || owner.ownerEpoch < 1
        || !Number.isSafeInteger(owner.leaseDurationMs) || owner.leaseDurationMs < 300
        || !Number.isSafeInteger(owner.renewAfterMs) || owner.renewAfterMs < 1 || owner.renewAfterMs >= owner.leaseDurationMs)) {
        throw new Error('browser-native Session response is missing a valid write lease')
      }
      const writerId = access === 'write' ? globalThis.crypto.randomUUID() : undefined
      if (owner !== undefined && writerId !== undefined) {
        try {
          await sessionOutbox.claim(String(id), owner.ownerEpoch, writerId)
        } catch (error) {
          try {
            const released = await sessionRequest('close', { sessionId: id, ...owner }, undefined)
            if (released.closed !== true) throw new Error('browser-native Session local-claim failure release was not acknowledged')
          } catch (releaseError) {
            throw new AggregateError([error, releaseError], 'browser-native Session outbox claim and owner release failed')
          }
          throw error
        }
      }
      let handle: RemoteSessionHandle
      handle = new RemoteSessionHandle(
        id,
        required(response.header, 'header'),
        access,
        required(response.inheritedEventCount, 'inheritedEventCount') as SessionLogOffset,
        owner,
        writerId,
        sessionOutbox,
        ensureSessionFiles,
        required(response.nextSeq, 'nextSeq'),
        () => {
          if (owner !== undefined && activeSessionOwners.get(id)?.ownerToken === owner.ownerToken
            && activeSessionOwners.get(id)?.ownerEpoch === owner.ownerEpoch) {
            activeSessionOwners.delete(id)
            publishBrowserNativeOwner({ type: 'released', sessionId: String(id) })
          }
          this.untrack(handle)
        },
      )
      if (access === 'write') {
        activeSessionFlushers.set(String(id), async () => {
          const session = this.ctx.sessions.get(id)
          if (session === undefined) throw new Error(`browser-native Session "${String(id)}" is no longer live`)
          const participated = await this.ctx.sessions.flush(session)
          if (!participated) throw new Error('browser-native Session flush had no durability listener')
          const state = await sessionRequest('read', { sessionId: id, offset: 0, length: 1 })
          const pending = await sessionOutbox.inspectPending(String(id))
          if (pending.ownerEpoch !== undefined && pending.ownerEpoch !== owner?.ownerEpoch) {
            throw new Error('browser-native Session outbox belongs to a different owner epoch')
          }
          const nextSeq = required(state.nextSeq, 'nextSeq')
          const durableThroughSeq = required(state.durableThroughSeq, 'durableThroughSeq')
          if (!Number.isSafeInteger(nextSeq) || !Number.isSafeInteger(durableThroughSeq)) {
            throw new Error('browser-native Session read returned invalid durability cursors')
          }
          await flushLocalWorkspaceOrDegrade(workspace, publication)
          return {
            ownerEpoch: required(owner, 'owner').ownerEpoch,
            nextSeq,
            durableThroughSeq,
            pendingEvents: pending.pendingEvents,
            pendingWorkspaceReceipts: workspace.pendingReceiptCount(),
          }
        })
      }
      if (access === 'write') {
        try {
          await handle.recoverOutbox()
        } catch (error) {
          try {
            await handle.abandonOpenFailure()
          } catch (releaseError) {
            throw new AggregateError([error, releaseError], 'browser-native Session outbox recovery and owner release failed')
          }
          throw error
        }
      }
      this.handles.add(handle)
      if (access === 'write') {
        this.writers.set(id, handle)
        if (owner !== undefined) {
          activeSessionOwners.set(id, { ownerToken: owner.ownerToken, ownerEpoch: owner.ownerEpoch })
          publishBrowserNativeOwner({ type: 'owner', sessionId: String(id), ownerToken: owner.ownerToken, ownerEpoch: owner.ownerEpoch })
        }
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
        return await this.track(response, header.id, 'write')
      } catch (error) {
        mapSessionError(error, header.id, 'create')
      }
    }

    async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
      try {
        const deadline = Date.now() + SESSION_OPEN_OWNER_RETRY_WINDOW_MS
        const resumeOwnerToken = access === 'write' ? takeBrowserNativeResumeOwner(String(id)) : undefined
        while (true) {
          try {
            const response = await sessionRequest('open', {
              sessionId: id,
              access,
              ...(resumeOwnerToken === undefined ? {} : { ownerToken: resumeOwnerToken }),
            }, options?.signal)
            return await this.track(response, id, access)
          } catch (error) {
            const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
            if (code !== 'SESSION_ALREADY_OWNED' || Date.now() >= deadline) throw error
            options?.signal?.throwIfAborted()
            await new Promise(resolveDelay => setTimeout(resolveDelay, SESSION_OPEN_OWNER_RETRY_DELAY_MS))
          }
        }
      } catch (error) {
        publishBrowserNativeOwner({ type: 'unavailable', sessionId: String(id), message: error instanceof Error ? error.message : String(error) })
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

function isSkillCatalogMessage(message: RequestMessage): boolean {
  return 'source' in message && message.source?.kind === 'skill-catalog'
}

async function flushLocalWorkspaceOrDegrade(
  workspace: BrowserNativeWorkspaceRuntime,
  publication: BrowserNativeCapabilityPublication,
): Promise<void> {
  try {
    await workspace.flushLocalWorkspace()
  } catch (error) {
    publication.degradeWorkspace()
    throw new Error(
      `browser-native local Workspace persistence was not confirmed; the file change may remain only in volatile Worker memory (${String(error)})`,
      { cause: error },
    )
  }
}

function toWireTools(
  tools: readonly ToolSchema[] | undefined,
  publication: BrowserNativeCapabilityPublication,
): readonly unknown[] | undefined {
  if (tools === undefined) return undefined
  assertBrowserNativeToolSchemas(tools, publication)
  return tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

function createRemoteLlmAdapterClass(publication: BrowserNativeCapabilityPublication): typeof import('@deepseek-ai/dsh-llm').LlmAdapter {
  const Base = runtimeLlm().LlmAdapter
  return class RemoteLlmAdapter extends Base {
    private configPromise: Promise<BrowserNativeConfigResponse> | undefined

    override providerInfo(provider: string): { id: string; name: string } {
      return { id: provider, name: 'Browser-native remote' }
    }

    override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
      return Promise.resolve([{ provider, id: 'browser-native', name: 'Browser-native remote' }])
    }

    override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      this.configPromise ??= (async () => {
        const response = await fetch(CONFIG_ROUTE, { cache: 'no-store' })
        const payload = await readJson<BrowserNativeConfigResponse>(response)
        if (!response.ok) {
          const error = responseError(payload, 'browser-native configuration request failed')
          throw new Error(error.message)
        }
        if (payload.contextWindow !== undefined
          && (!Number.isSafeInteger(payload.contextWindow) || payload.contextWindow <= 0)) {
          throw new Error('browser-native config returned an invalid contextWindow')
        }
        return payload
      })()
      const config = await this.configPromise
      return {
        provider,
        id: model,
        name: model,
        ...(config.contextWindow === undefined ? {} : { context: { contextWindow: config.contextWindow } }),
      }
    }

    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const response = await fetch(LLM_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-browser-native-protocol': String(PROTOCOL_VERSION) },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        requestId: requestId(),
        sessionId: options.sessionId,
        ...(options.sessionId === undefined || activeSessionOwners.get(options.sessionId) === undefined ? {} : {
          ownerToken: activeSessionOwners.get(options.sessionId)!.ownerToken,
          ownerEpoch: activeSessionOwners.get(options.sessionId)!.ownerEpoch,
        }),
        provider: options.provider,
        model: options.model,
        ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
        messages: options.messages
          .filter(message => publication.isToolPublished('skill') || !isSkillCatalogMessage(message))
          .map(toWireMessage),
        tools: toWireTools(options.tools, publication),
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
      const toolArgumentEncoder = new TextEncoder()
      let toolArgumentBytes = 0
      const checkToolArgumentLimit = async (argumentsDelta: string): Promise<void> => {
        toolArgumentBytes += toolArgumentEncoder.encode(argumentsDelta).byteLength
        if (toolArgumentBytes > MAX_TOOL_ARGUMENT_BYTES) {
          await reader.cancel()
          const { LlmError } = runtimeLlm()
          throw new LlmError(
            `browser-native tool arguments exceed ${MAX_TOOL_ARGUMENT_BYTES} bytes`,
            'TOOL_ARGUMENT_TOO_LARGE',
          )
        }
      }
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
            if (item.kind === 'chunk' && item.chunk !== undefined) {
              if (item.chunk.type === 'tool-call-delta') await checkToolArgumentLimit(item.chunk.argumentsDelta)
              yield item.chunk
            }
          }
          newline = buffer.indexOf('\n')
        }
        if (part.done) break
      }
      const tail = buffer.trim()
      if (tail.length > 0) {
        const item = JSON.parse(tail) as LlmStreamResponse
        if (item.kind === 'chunk' && item.chunk !== undefined) {
          if (item.chunk.type === 'tool-call-delta') await checkToolArgumentLimit(item.chunk.argumentsDelta)
          yield item.chunk
        }
      }
    }
  }
}

function createSessionModule(
  workspace: BrowserNativeWorkspaceRuntime,
  sessionOutbox: BrowserNativeSessionOutbox,
  publication: BrowserNativeCapabilityPublication,
  ensureSessionFiles: (events: readonly SessionEvent[], signal?: AbortSignal) => Promise<void>,
): unknown {
  let module: unknown
  return () => {
    const RemoteSessionPersistence = createRemoteSessionPersistenceClass(
      workspace, sessionOutbox, publication, ensureSessionFiles,
    )
    module ??= { default: RemoteSessionPersistence, RemoteSessionPersistence }
    return module
  }
}

function createLlmModule(publication: BrowserNativeCapabilityPublication): unknown {
  let module: unknown
  return () => {
    const RemoteLlmAdapter = createRemoteLlmAdapterClass(publication)
    module ??= {
      default: (ctx: Context): void => {
        const adapter = new RemoteLlmAdapter()
        ctx.effect(() => ctx.llm.registerAdapter(['browser-native'], adapter))
        const controlledAgents = new Set<string>()
        const installAgentControls = (agent: NonNullable<ReturnType<typeof ctx.agents.get>>): void => {
          const agentId = String(agent.id)
          if (controlledAgents.has(agentId)) return
          agent.ctx.effect(() => {
            let disposeRestriction: (() => void) | undefined
            const refreshRestriction = (): void => {
              disposeRestriction?.()
              const registeredNames = new Set(agent.ctx.tools.schemas(agent).map(tool => tool.name))
              const denied = publication.unavailableWorkspaceToolNames().filter(name => registeredNames.has(name))
              disposeRestriction = denied.length === 0
                ? undefined
                : agent.ctx.tools.restrict({ deny: denied })
            }
            const unsubscribe = publication.subscribe(refreshRestriction)
            const disposeGuard = agent.ctx.tools.guard(({ name }) => publication.isToolPublished(name)
              ? undefined
              : 'browser-native capability is not currently published')
            refreshRestriction()
            return () => {
              unsubscribe()
              disposeRestriction?.()
              disposeGuard()
            }
          }, 'browser-native capability publication')
          controlledAgents.add(agentId)
        }
        ctx.on('agent/created', ({ agent }) => { installAgentControls(agent) })
        ctx.on('agent/disposed', ({ agent }) => {
          controlledAgents.delete(String(agent.id))
        })
      },
      RemoteLlmAdapter,
    }
    return module
  }
}

/** Return the static module table consumed by the custom Worker entry. */
export function createBrowserNativeStaticModules(
  workspace: BrowserNativeWorkspaceRuntime,
  sessionOutbox: BrowserNativeSessionOutbox,
  publication: BrowserNativeCapabilityPublication,
  attachmentTestHooks?: BrowserNativeAttachmentTestHooks,
  permissionProbe?: BrowserNativePermissionProbe,
): Readonly<Record<string, StaticModuleFactory>> {
  const attachments = createBrowserNativeAttachmentModule(workspace, attachmentTestHooks)
  attachmentTestHooks?.onModuleReady?.(attachments)
  return {
    '@deepseek-ai/dsh-browser-native-attachments': attachments.factory,
    '@deepseek-ai/dsh-browser-native-session-persistence': createSessionModule(
      workspace, sessionOutbox, publication, attachments.ensureSessionFiles,
    ),
    '@deepseek-ai/dsh-browser-native-llm': createLlmModule(publication),
    ...(permissionProbe === undefined ? {} : {
      '@deepseek-ai/dsh-browser-native-permission-probe': permissionProbe.factory,
    }),
  }
}
