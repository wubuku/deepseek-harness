import './symbol-dispose'
import './browser-native-session-events.ts'

/**
 * Browser-native PoC Worker entry.
 *
 * This entry mirrors the upstream WebWorker bootstrap while keeping the
 * Browser-Native provider injection and owner-control channel in this draft.
 */
import { createWorkerHost } from '../../../packages/experimental/webworker-runtime/src/worker-host.ts'
import type { WorkerHost } from '../../../packages/experimental/webworker-runtime/src/worker-host.ts'
import type { WorkerModuleTraceSnapshot } from '../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import '../../../packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/buffer.ts'
import {
  alsCausality,
  runAtAsyncContextRoot,
} from '../../../packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/async_hooks.ts'
import { installAsyncContextHooks } from '../../../packages/experimental/webworker-runtime/src/polyfill/async-context/async-context-hooks.ts'
import {
  createNodeBuiltins,
  REPLACED_PREFIXES,
} from '../../../packages/experimental/webworker-runtime/src/node/builtins.ts'
import { whenRequestListener } from '../../../packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/http.ts'
import { installTimerGlobals } from '../../../packages/experimental/webworker-runtime/src/node/globals/timers.ts'
import { installCryptoGlobals } from '../../../packages/experimental/webworker-runtime/src/node/globals/crypto.ts'
import { isShellStartFrame } from '../../../packages/experimental/webworker-runtime/src/shell/process/protocol.ts'
import { runShellProcess } from '../../../packages/experimental/webworker-runtime/src/shell/process/host.ts'
import { installProcessGlobal } from '../../../packages/experimental/webworker-runtime/src/node/globals/process.ts'
import { createBrowserNativeStaticModules, flushBrowserNativeSession } from './browser-native-providers.ts'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { BrowserNativeSessionOutbox } from './browser-native-session-outbox.ts'
import {
  handoffBrowserNativeExecution,
  type BrowserNativeExecutionHandoffCheckpoint,
} from './browser-native-execution-handoff.ts'
import {
  probeBrowserNativeRuntime,
  type BrowserNativeRuntimeProbeFailureCode,
  type BrowserNativeRuntimeProbeReport,
} from './browser-native-runtime-probes.ts'
import {
  executeBrowserNativeGrep,
  type BrowserNativeEditMetrics,
} from './browser-native-file-tools.ts'
import {
  createSyncAccessChunkBackedFile,
  hashChunkBackedFile,
  replaceUniqueUtf8CopyOnWrite,
  type ChunkBackedFile,
  type ChunkEditStage,
} from './browser-native-chunk-editor.ts'
import { findContentChunks } from './browser-native-content-chunker.ts'
import { Sha256 } from './browser-native-sha256.ts'
import {
  BROWSER_NATIVE_PROFILE_MANIFEST,
  evaluateBrowserNativeProfile,
  formatBrowserNativePreflightFailure,
} from './browser-native-capabilities.ts'
import { BrowserNativeCapabilityPublication } from './browser-native-capability-publication.ts'
import {
  publishBrowserNativePagehideAck,
  publishBrowserNativeControlTestFrame,
  type BrowserNativeControlTestInjection,
  setBrowserNativeControlPort,
  setBrowserNativeResumeOwner,
  setBrowserNativeResumeWorkspaceLease,
} from './browser-native-control.ts'
import {
  createBrowserNativeWorkspaceRuntime,
  type BrowserNativeFileToolStage,
} from './browser-native-workspace.ts'
import type { BrowserNativeWorkspaceRuntime } from './browser-native-workspace.ts'
import type { DownloadPublicationStage } from './browser-native-workspace-store.ts'
import { createBrowserNativeBuiltinMemberTrace } from './browser-native-builtin-member-trace.ts'
import { createBrowserNativePermissionProbe } from './browser-native-permission-probe.ts'
import { BrowserNativeSessionMountCoordinator } from './browser-native-session-mount.ts'
import type { BrowserNativeExecutionIdentity, BrowserNativeSessionEvent } from './browser-native-session-adapter.ts'
import {
  BrowserNativeSessionProjectionStore,
  type BrowserNativeSessionProjectionSource,
} from './browser-native-session-projection.ts'
import {
  BrowserNativeApprovalProjection,
  BrowserNativeApprovalProjectionError,
} from './browser-native-approval-projection.ts'

installAsyncContextHooks()
installTimerGlobals()
installCryptoGlobals()

console.info('browser-native dsh: worker entry active')

let host: WorkerHost | undefined
let shellRole = false
let durableWorkspace = false
let contentDefinedUpload = false
let workspaceWriterLease = false
let workspaceRuntime: BrowserNativeWorkspaceRuntime | undefined
let workspaceTestPort: MessagePort | undefined
let builtinMemberTrace: ReturnType<typeof createBrowserNativeBuiltinMemberTrace> | undefined
let downloadPauseStage: DownloadPublicationStage | undefined
let abortMetadataTransactionsRemaining = 0
let quotaNextOpfsWrite = false
let fileToolYieldDelayMs = 0
let attachmentOpfsStageWaiter: string | undefined
let attachmentOpfsWriteRelease: (() => void) | undefined
let attachmentOpfsWriteOutcome: 'idle' | 'armed' | 'paused' | 'aborted' | 'released' | 'released-before-stage' = 'idle'
let reconcileAttachmentTemporaryFilesForTest: (() => Promise<void>) | undefined
const fileToolMetrics: BrowserNativeEditMetrics[] = []
const fileToolStageWaiters = new Map<string, {
  readonly stage: BrowserNativeFileToolStage
  readonly resolve: (observed: boolean) => void
  readonly timer: ReturnType<typeof setTimeout>
}>()
let localPersistBarrier: 'before' | 'after' | undefined
let localPersistReached: 'before' | 'after' | undefined
let releaseLocalPersist: (() => void) | undefined
let sessionOutboxAppendsToAbort = 0
let sessionOutboxProbesToAbort = 0
let runtimeProbePromise: Promise<BrowserNativeRuntimeProbeReport> | undefined
let runtimeProbeReport: BrowserNativeRuntimeProbeReport | undefined
const capabilityPublication = new BrowserNativeCapabilityPublication()
const permissionProbe = createBrowserNativePermissionProbe()
const pending: unknown[] = []
const sessionOutbox = new BrowserNativeSessionOutbox({
  abortNextAppend: () => {
    if (sessionOutboxAppendsToAbort === 0) return false
    sessionOutboxAppendsToAbort -= 1
    return true
  },
  abortNextProbe: () => {
    if (sessionOutboxProbesToAbort === 0) return false
    sessionOutboxProbesToAbort -= 1
    return true
  },
})

interface BrowserNativeRuntimeProbeRequest {
  readonly type: 'browser-native-runtime-probe'
  readonly requestId: string
  readonly durableWorkspace: boolean
  readonly testFault?: 'outbox-abort' | 'opfs-unavailable'
}

function isRuntimeProbeRequest(value: unknown): value is BrowserNativeRuntimeProbeRequest {
  if (value === null || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  return data.type === 'browser-native-runtime-probe'
    && typeof data.requestId === 'string' && data.requestId.length > 0
    && typeof data.durableWorkspace === 'boolean'
    && (data.testFault === undefined || data.testFault === 'outbox-abort' || data.testFault === 'opfs-unavailable')
}

function failedProbeReport(
  check: 'session-outbox' | 'backend' | 'workspace-opfs',
  code: BrowserNativeRuntimeProbeFailureCode,
): BrowserNativeRuntimeProbeReport {
  return {
    ok: false,
    checks: {
      'session-outbox': check === 'session-outbox' ? 'failed' : 'not-run',
      backend: check === 'backend' ? 'failed' : 'not-run',
      'workspace-opfs': check === 'workspace-opfs' ? 'failed' : 'not-run',
    },
    failures: [{ check, code }],
  }
}

async function handleRuntimeProbe(request: BrowserNativeRuntimeProbeRequest, port: MessagePort): Promise<void> {
  if (runtimeProbePromise !== undefined || host !== undefined) {
    port.postMessage({ type: 'browser-native-runtime-probe-result', requestId: request.requestId,
      ...failedProbeReport('backend', 'BACKEND_RESPONSE_INVALID') })
    return
  }
  if (request.durableWorkspace !== durableWorkspace) {
    const report = failedProbeReport('backend', 'BACKEND_RESPONSE_INVALID')
    runtimeProbeReport = report
    runtimeProbePromise = Promise.resolve(report)
    port.postMessage({ type: 'browser-native-runtime-probe-result', requestId: request.requestId, ...report })
    return
  }
  if (request.testFault !== undefined && workspaceTestPort === undefined) {
    const report = failedProbeReport('backend', 'BACKEND_RESPONSE_INVALID')
    runtimeProbeReport = report
    runtimeProbePromise = Promise.resolve(report)
    port.postMessage({ type: 'browser-native-runtime-probe-result', requestId: request.requestId, ...report })
    return
  }
  if (request.testFault === 'outbox-abort') sessionOutboxProbesToAbort = 1
  runtimeProbePromise = probeBrowserNativeRuntime({
    backendOrigin: self.location.origin,
    durableWorkspace,
    probeSessionOutbox: async () => await sessionOutbox.probe(),
    ...(request.testFault === 'opfs-unavailable' ? {
      probeWorkspaceOpfs: async () => { throw new Error('injected OPFS probe failure') },
    } : {}),
  })
  runtimeProbeReport = await runtimeProbePromise
  if (runtimeProbeReport.ok) capabilityPublication.activate()
  port.postMessage({ type: 'browser-native-runtime-probe-result', requestId: request.requestId, ...runtimeProbeReport })
}

interface BrowserNativeWorkspaceTestRequest {
  readonly type: 'browser-native-workspace-test-request'
  readonly requestId: string
  readonly action: 'write' | 'write-pattern' | 'write-content-workload' | 'append' | 'mkdir' | 'read' | 'read-digest' | 'read-range' | 'usage' | 'file-tool-metrics' | 'module-trace' | 'builtin-member-trace' | 'node-fs-read' | 'unsupported-builtin-probe' | 'permission-state' | 'session-mount-probe' | 'session-projection-probe' | 'approval-projection-probe' | 'rename' | 'remove' | 'stat' | 'list' | 'chmod' | 'write-binary' | 'flush-local' | 'flush-workspace' | 'lease-info' | 'lease-timer-probe' | 'release-lease' | 'abort-next-metadata-transaction' | 'abort-metadata-transactions' | 'quota-next-opfs-write' | 'pause-local-save' | 'local-save-state' | 'release-local-save' | 'load-lazy-client-chunk' | 'close-vfs' | 'set-file-tool-delay' | 'cancel-file-search' | 'wait-file-tool-stage' | 'chunk-edit-probe' | 'content-chunking-probe' | 'reference-edit-probe' | 'session-handoff' | 'execution-handoff' | 'abort-session-outbox-appends' | 'session-outbox-probe' | 'cross-store-probe' | 'control-inject' | 'wait-attachment-opfs-staging-write' | 'attachment-opfs-write-state' | 'release-attachment-opfs-write' | 'reconcile-attachment-staging'
  readonly controlInjection?: BrowserNativeControlTestInjection
  readonly stage?: 'before' | 'after'
  readonly path?: string
  readonly from?: string
  readonly to?: string
  readonly content?: string
  readonly base64?: string
  readonly byteLength?: number
  readonly byteValue?: number
  readonly lineBytes?: number
  readonly markerLine?: number
  readonly marker?: string
  readonly pattern?: string
  readonly offset?: number
  readonly length?: number
  readonly mode?: number
  readonly count?: number
  readonly delayMs?: number
  readonly chunkBytes?: number
  readonly contentKind?: 'text' | 'binary' | 'repetitive'
  readonly editKind?: 'replace' | 'insert' | 'delete'
  readonly editPosition?: 'head' | 'middle' | 'tail'
  readonly minimumChunkBytes?: number
  readonly averageChunkBytes?: number
  readonly alternateAverageChunkBytes?: number
  readonly maximumChunkBytes?: number
  readonly oldText?: string
  readonly newText?: string
  readonly failStage?: ChunkEditStage
  readonly toolStage?: BrowserNativeFileToolStage
  readonly timeoutMs?: number
  readonly sessionId?: string
  readonly operationId?: string
  readonly ownerId?: string
  readonly ownerToken?: string
  readonly ownerEpoch?: number
  readonly handoffId?: string
  readonly terminateAfter?: boolean
  readonly checkpoint?: Readonly<Record<string, unknown>>
}

function isWorkspaceTestRequest(value: unknown): value is BrowserNativeWorkspaceTestRequest {
  if (value === null || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  if (data.type !== 'browser-native-workspace-test-request' || typeof data.requestId !== 'string') return false
  if (data.action === 'control-inject') {
    return data.controlInjection === 'duplicate' || data.controlInjection === 'gap' || data.controlInjection === 'conflict'
      || data.controlInjection === 'max-text' || data.controlInjection === 'oversized-text'
      || data.controlInjection === 'escaped-frame-overflow' || data.controlInjection === 'unknown-field'
      || data.controlInjection === 'unknown-notice' || data.controlInjection === 'cyclic-extra'
  }
  if (data.action === 'abort-session-outbox-appends') {
    return Number.isSafeInteger(data.count) && Number(data.count) > 0 && Number(data.count) <= 100
  }
  if (data.action === 'session-outbox-probe') return true
  if (data.action === 'permission-state') return typeof data.sessionId === 'string' && data.sessionId.length > 0
  if (data.action === 'session-mount-probe' || data.action === 'session-projection-probe' || data.action === 'approval-projection-probe') return true
  if (data.action === 'wait-attachment-opfs-staging-write'
    || data.action === 'attachment-opfs-write-state'
    || data.action === 'release-attachment-opfs-write'
    || data.action === 'reconcile-attachment-staging') return true
  if (data.action === 'cross-store-probe') {
    return (data.path === undefined || typeof data.path === 'string')
      && (data.content === undefined || typeof data.content === 'string')
      && (data.sessionId === undefined || typeof data.sessionId === 'string')
      && (data.operationId === undefined || typeof data.operationId === 'string')
  }
  if (data.action === 'abort-metadata-transactions') {
    return Number.isSafeInteger(data.count) && Number(data.count) > 0 && Number(data.count) <= 100
  }
  if (data.action === 'set-file-tool-delay') {
    return Number.isSafeInteger(data.delayMs) && Number(data.delayMs) >= 0 && Number(data.delayMs) <= 10_000
  }
  if (data.action === 'cancel-file-search') {
    return typeof data.path === 'string' && (typeof data.pattern === 'string' || typeof data.marker === 'string')
      && Number.isSafeInteger(data.delayMs) && Number(data.delayMs) >= 0 && Number(data.delayMs) <= 1_000
  }
  if (data.action === 'wait-file-tool-stage') {
    return (data.timeoutMs === undefined || Number.isSafeInteger(data.timeoutMs)
      && Number(data.timeoutMs) >= 1 && Number(data.timeoutMs) <= 45_000)
      && ['grep-match', 'copy-prefix', 'copy-suffix', 'write-replacement', 'truncate', 'hash', 'publish']
        .includes(String(data.toolStage))
  }
  if (data.action === 'chunk-edit-probe' || data.action === 'reference-edit-probe') {
    const oldTextBytes = typeof data.oldText === 'string' ? new TextEncoder().encode(data.oldText).byteLength : 0
    const newTextBytes = typeof data.newText === 'string' ? new TextEncoder().encode(data.newText).byteLength : 0
    return Number.isSafeInteger(data.byteLength) && Number(data.byteLength) >= 1024 * 1024
      && Number(data.byteLength) <= 128 * 1024 * 1024
      && Number.isSafeInteger(data.chunkBytes) && Number(data.chunkBytes) >= 1024
      && Number(data.chunkBytes) <= 16 * 1024 * 1024
      && typeof data.oldText === 'string' && data.oldText.length > 0
      && oldTextBytes <= 256 * 1024
      && typeof data.newText === 'string'
      && newTextBytes <= 256 * 1024
      && (data.failStage === undefined || ['copy-prefix', 'copy-suffix', 'write-replacement', 'truncate', 'hash', 'publish'].includes(String(data.failStage)))
  }
  if (data.action === 'content-chunking-probe') {
    return Number.isSafeInteger(data.byteLength) && Number(data.byteLength) >= 1024 * 1024
      && Number(data.byteLength) <= 64 * 1024 * 1024
      && ['text', 'binary', 'repetitive'].includes(String(data.contentKind))
      && ['replace', 'insert', 'delete'].includes(String(data.editKind))
      && ['head', 'middle', 'tail'].includes(String(data.editPosition))
      && Number.isSafeInteger(data.minimumChunkBytes) && Number(data.minimumChunkBytes) >= 1024
      && Number.isSafeInteger(data.averageChunkBytes) && Number(data.averageChunkBytes) >= Number(data.minimumChunkBytes)
      && Number.isSafeInteger(data.alternateAverageChunkBytes) && Number(data.alternateAverageChunkBytes) >= Number(data.minimumChunkBytes)
      && Number.isSafeInteger(data.maximumChunkBytes) && Number(data.maximumChunkBytes) >= Number(data.averageChunkBytes)
      && Number(data.maximumChunkBytes) >= Number(data.alternateAverageChunkBytes)
      && Number(data.maximumChunkBytes) <= 1024 * 1024
  }
  if (data.action === 'session-handoff') {
    return typeof data.sessionId === 'string' && typeof data.ownerToken === 'string'
      && Number.isSafeInteger(data.ownerEpoch) && Number(data.ownerEpoch) > 0
      && typeof data.handoffId === 'string' && data.handoffId.length > 0
      && data.checkpoint !== null && typeof data.checkpoint === 'object' && !Array.isArray(data.checkpoint)
  }
  if (data.action === 'execution-handoff') {
    return typeof data.sessionId === 'string' && typeof data.ownerToken === 'string'
      && Number.isSafeInteger(data.ownerEpoch) && Number(data.ownerEpoch) > 0
      && typeof data.ownerId === 'string' && data.ownerId.length > 0
      && typeof data.handoffId === 'string' && data.handoffId.length > 0
      && (data.terminateAfter === undefined || typeof data.terminateAfter === 'boolean')
  }
  if (data.action === 'pause-local-save') return data.stage === 'before' || data.stage === 'after'
  if (data.action === 'node-fs-read') {
    return typeof data.path === 'string' && data.path.startsWith('/dsh/home/workspace/')
      && !data.path.split('/').includes('..')
      && typeof data.marker === 'string' && data.marker.length > 0 && data.marker.length <= 256
  }
  return ['write', 'write-pattern', 'write-content-workload', 'append', 'mkdir', 'read', 'read-digest', 'read-range', 'usage', 'file-tool-metrics', 'module-trace', 'builtin-member-trace', 'unsupported-builtin-probe', 'permission-state', 'session-mount-probe', 'session-projection-probe', 'approval-projection-probe', 'rename', 'remove', 'stat', 'list', 'chmod', 'write-binary', 'flush-local', 'flush-workspace', 'lease-info', 'lease-timer-probe', 'release-lease', 'abort-next-metadata-transaction', 'quota-next-opfs-write', 'local-save-state', 'release-local-save', 'load-lazy-client-chunk', 'close-vfs'].includes(String(data.action))
}

function sessionMountProbeIdentity(sessionId: string, workerInstanceId: string, ownerEpoch: number): BrowserNativeExecutionIdentity {
  return { sessionId, backendId: 'browser-native-probe-backend', workerInstanceId, ownerEpoch }
}

function sessionMountProbeEvent(seq: number, text: string): BrowserNativeSessionEvent {
  return { seq, type: 'assistant/message', data: { text } }
}

function runSessionMountProbe(): Record<string, unknown> {
  const coordinator = new BrowserNativeSessionMountCoordinator()
  const sessionIds = ['mount-a', 'mount-b', 'mount-c']
  for (const sessionId of sessionIds) {
    coordinator.mount({
      sessionId,
      identity: sessionMountProbeIdentity(sessionId, 'worker-1', 1),
      ownerId: 'page-1',
    })
    coordinator.hydrate(sessionId, [sessionMountProbeEvent(0, `${sessionId}:history`)], 1)
  }
  coordinator.activate('mount-a')
  coordinator.beginExecution('mount-a', 'turn-a')
  coordinator.activate('mount-b')
  const parkedExecutionContinued = coordinator.snapshots().some(snapshot => snapshot.sessionId === 'mount-a'
    && snapshot.view === 'parked' && snapshot.execution?.state === 'running')
  const duplicate = coordinator.acceptLive('mount-a', sessionMountProbeIdentity('mount-a', 'worker-1', 1), sessionMountProbeEvent(0, 'mount-a:history'))
  const liveA = coordinator.acceptLive('mount-a', sessionMountProbeIdentity('mount-a', 'worker-1', 1), sessionMountProbeEvent(1, 'mount-a:live'))
  const liveB = coordinator.acceptLive('mount-b', sessionMountProbeIdentity('mount-b', 'worker-1', 1), sessionMountProbeEvent(1, 'mount-b:live'))
  coordinator.setAvailability('mount-c', 'occupied')
  let occupiedRejected = false
  try { coordinator.activate('mount-c') } catch (error) { occupiedRejected = error instanceof Error && error.message.includes('occupied') }
  coordinator.setAvailability('mount-c', 'busy')
  let busyRejected = false
  try { coordinator.activate('mount-c') } catch (error) { busyRejected = error instanceof Error && error.message.includes('busy') }
  coordinator.setAvailability('mount-c', 'unavailable')
  let unavailableRejected = false
  try { coordinator.activate('mount-c') } catch (error) { unavailableRejected = error instanceof Error && error.message.includes('unavailable') }
  const reconnected = coordinator.reconnect(
    'mount-a',
    sessionMountProbeIdentity('mount-a', 'worker-2', 2),
    'page-1',
    [sessionMountProbeEvent(0, 'mount-a:history'), sessionMountProbeEvent(1, 'mount-a:live')],
    2,
  )
  const newIdentityAccepted = coordinator.acceptLive('mount-a', sessionMountProbeIdentity('mount-a', 'worker-2', 2), sessionMountProbeEvent(2, 'new'))
  let oldIdentityRejected = false
  try {
    coordinator.acceptLive('mount-a', sessionMountProbeIdentity('mount-a', 'worker-1', 1), sessionMountProbeEvent(3, 'old'))
  } catch (error) { oldIdentityRejected = error instanceof Error && error.message.includes('identity changed') }
  coordinator.setAvailability('mount-c', 'available')
  coordinator.activate('mount-c')
  coordinator.beginExecution('mount-c', 'hitl-c', 'waiting')
  const disposed = coordinator.dispose('Worker terminated with parked and active executions')
  const lateIgnored = coordinator.settleExecution('mount-a', 'turn-a', { settlement: 'confirmed' }) === false
  const waitingUnknown = disposed.every(snapshot => snapshot.execution === undefined
    || snapshot.execution.state === 'unknown' || snapshot.execution.state === 'settled')
  return {
    ok: parkedExecutionContinued && duplicate === 'duplicate' && liveA === 'accepted' && liveB === 'accepted'
      && occupiedRejected && busyRejected && unavailableRejected && reconnected.cursor.identity.workerInstanceId === 'worker-2'
      && oldIdentityRejected && newIdentityAccepted === 'accepted' && lateIgnored && waitingUnknown,
    parkedExecutionContinued,
    duplicate,
    liveA,
    liveB,
    occupiedRejected,
    busyRejected,
    unavailableRejected,
    reconnectedWorker: reconnected.cursor.identity.workerInstanceId,
    oldIdentityRejected,
    newIdentityAccepted,
    lateIgnored,
    waitingUnknown,
    mountCount: disposed.length,
    detachedCount: disposed.filter(snapshot => snapshot.view === 'detached').length,
  }
}

function runApprovalProjectionProbe(): Record<string, unknown> {
  const call = (seq: number, callId: string, name: string, argumentsText: string): SessionEvent<'tool/call'> => ({
    seq: seq as SessionSeq,
    time: seq,
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: callId as ToolCallId, name, arguments: argumentsText },
  })
  const asked = (seq: number, requestId: string, callId: string, toolName: string): SessionEvent<'approval/asked'> => ({
    seq: seq as SessionSeq,
    time: seq,
    type: 'approval/asked',
    data: {
      id: requestId as SessionEvent<'approval/asked'>['data']['id'],
      callId: callId as ToolCallId,
      toolName,
      reason: 'Browser probe',
    },
  })
  const decided = (seq: number, requestId: string, outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'): SessionEvent<'approval/decided'> => ({
    seq: seq as SessionSeq,
    time: seq,
    type: 'approval/decided',
    data: { id: requestId as SessionEvent<'approval/decided'>['data']['id'], outcome },
  })
  const result = (seq: number, callId: string): SessionEvent<'tool/result'> => ({
    seq: seq as SessionSeq,
    time: seq,
    type: 'tool/result',
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        id: `approval-probe-result-${callId}`,
        content: [{ type: 'text', text: 'done' }],
        source: { kind: 'tool', callId: callId as ToolCallId },
        toolCallId: callId as ToolCallId,
        isError: false,
      },
    },
  })

  const projection = new BrowserNativeApprovalProjection('approval-probe', 64)
  const first = projection.rebuild([
    call(0, 'call-a', 'bash', `{"command":"${'x'.repeat(100)}"}`),
    asked(1, 'request-a', 'call-a', 'bash'),
    call(2, 'call-b', 'write', '{"file_path":"x.txt","content":"ok"}'),
    asked(3, 'request-b', 'call-b', 'write'),
  ])
  const claim = projection.claim('request-a', 'allowed-once')
  let duplicateClaimRejected = false
  try { projection.claim('request-a', 'rejected') } catch (error) {
    duplicateClaimRejected = error instanceof BrowserNativeApprovalProjectionError
      && error.code === 'REQUEST_ALREADY_CLAIMED'
  }
  const replay = projection.rebuild([
    call(0, 'call-a', 'bash', '{"command":"echo a"}'),
    asked(1, 'request-a', 'call-a', 'bash'),
    decided(2, 'request-a', 'allowed-once'),
    result(3, 'call-a'),
  ])
  const invalid = projection.rebuild([
    call(0, 'call-c', 'bash', '{}'),
    asked(1, 'request-c', 'call-c', 'bash'),
    asked(2, 'request-c', 'call-c', 'bash'),
    asked(3, 'request-missing', 'missing', 'bash'),
    result(4, 'call-c'),
    asked(5, 'request-stale', 'call-c', 'bash'),
    decided(6, 'request-missing', 'rejected'),
    decided(7, 'request-c', 'rejected'),
    call(8, 'call-d', 'bash', '{}'),
    asked(9, 'request-d', 'call-d', 'bash'),
    decided(10, 'request-d', 'rejected'),
    decided(11, 'request-d', 'rejected'),
  ])
  return {
    ok: first.pending.map(request => request.requestId).join(',') === 'request-a,request-b'
      && claim.durable === false
      && first.pending[0]?.argumentsTruncated === true
      && duplicateClaimRejected
      && replay.pending.length === 0
      && replay.decisions[0]?.outcome === 'allowed-once'
      && invalid.pending.length === 0
      && invalid.diagnostics.map(item => item.code).join(',') === 'DUPLICATE_REQUEST,APPROVAL_CALL_UNBOUND,APPROVAL_CALL_SETTLED,DECISION_UNBOUND,DECISION_CALL_SETTLED,DECISION_DUPLICATE',
    firstPending: first.pending.map(request => request.requestId),
    firstSummaryTruncated: first.pending[0]?.argumentsTruncated === true,
    claimIsDurable: claim.durable,
    duplicateClaimRejected,
    replayPending: replay.pending.map(request => request.requestId),
    replayDecisions: replay.decisions,
    invalidDiagnostics: invalid.diagnostics.map(item => item.code),
    sessionId: first.sessionId,
  }
}

interface SessionProjectionProbeValue {
  readonly status: 'idle' | 'running'
  readonly text: string
}

function narrowSessionProjection(value: unknown): SessionProjectionProbeValue | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if ((record.status !== 'idle' && record.status !== 'running') || typeof record.text !== 'string') return undefined
  return { status: record.status, text: record.text }
}

function runSessionProjectionProbe(): Record<string, unknown> {
  const values = new Map<string, unknown>([
    ['projection-a', { status: 'idle', text: 'A baseline' }],
    ['projection-b', { status: 'running', text: 'B baseline' }],
  ])
  const listeners = new Set<(sessionId: string, value: unknown) => void>()
  const source: BrowserNativeSessionProjectionSource = {
    snapshot: sessionId => values.get(sessionId),
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const publish = (sessionId: string, value: unknown): void => {
    values.set(sessionId, value)
    for (const listener of [...listeners]) listener(sessionId, value)
  }
  const remove = (sessionId: string): void => {
    values.delete(sessionId)
    for (const listener of [...listeners]) listener(sessionId, undefined)
  }
  const store = new BrowserNativeSessionProjectionStore({ narrow: narrowSessionProjection })
  const trace: Array<{ readonly sessionId: string | undefined; readonly text?: string }> = []
  store.subscribe(() => trace.push({ sessionId: store.sessionId, text: store.read()?.text }))
  store.attach(source)
  store.bind('projection-a')
  const baseline = store.read()?.text
  publish('projection-b', { status: 'idle', text: 'B foreign update' })
  const foreignIgnored = store.read()?.text === 'A baseline'
  const alphaLive = { status: 'running' as const, text: 'A live' }
  publish('projection-a', alphaLive)
  const activeUpdated = store.read()?.text === 'A live'
  const traceBeforeDuplicate = trace.length
  publish('projection-a', alphaLive)
  const duplicateIgnored = trace.length === traceBeforeDuplicate
  store.bind('projection-b')
  const switched = store.read()?.text === 'B foreign update'
  publish('projection-a', { status: 'idle', text: 'A late update' })
  const lateForeignIgnored = store.read()?.text === 'B foreign update'
  remove('projection-b')
  const removedCleared = store.read() === undefined
  store.detach(source)
  const detachedCleared = store.read() === undefined
  publish('projection-b', { status: 'running', text: 'B detached update' })
  const detachedUpdateIgnored = store.read() === undefined
  store.attach(source)
  const reattached = store.read()?.text === 'B detached update'
  return {
    ok: baseline === 'A baseline' && foreignIgnored && activeUpdated && duplicateIgnored && switched
      && lateForeignIgnored && removedCleared && detachedCleared && detachedUpdateIgnored && reattached,
    baseline,
    foreignIgnored,
    activeUpdated,
    duplicateIgnored,
    switched,
    lateForeignIgnored,
    removedCleared,
    detachedCleared,
    detachedUpdateIgnored,
    reattached,
    trace,
  }
}

async function pauseAttachmentOpfsStagingWrite(bytesWritten: number, signal?: AbortSignal): Promise<void> {
  const requestId = attachmentOpfsStageWaiter
  if (requestId === undefined) return
  attachmentOpfsStageWaiter = undefined
  attachmentOpfsWriteOutcome = 'paused'
  workspaceTestResponse(requestId, { ok: true, stage: 'partial-opfs-staging-write', bytesWritten })
  if (signal?.aborted) {
    attachmentOpfsWriteOutcome = 'aborted'
    throw signal.reason ?? new DOMException('Attachment upload was aborted', 'AbortError')
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      attachmentOpfsWriteRelease = undefined
      attachmentOpfsWriteOutcome = 'aborted'
      reject(signal?.reason ?? new DOMException('Attachment upload was aborted', 'AbortError'))
    }
    attachmentOpfsWriteRelease = () => {
      cleanup()
      attachmentOpfsWriteRelease = undefined
      attachmentOpfsWriteOutcome = 'released'
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function pauseLocalPersist(stage: 'before' | 'after'): Promise<void> {
  if (localPersistBarrier !== stage) return
  localPersistBarrier = undefined
  localPersistReached = stage
  await new Promise<void>(resolve => { releaseLocalPersist = resolve })
  releaseLocalPersist = undefined
  localPersistReached = undefined
}

function workspaceTestResponse(requestId: string, response: Record<string, unknown>): void {
  workspaceTestPort?.postMessage({ ...response, requestId })
}

async function browserNativeJson(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), ...body }),
  })
  const value: unknown = await response.json()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('cross-store response is invalid')
  if (!response.ok) {
    const error = 'error' in value && value.error !== null && typeof value.error === 'object' && !Array.isArray(value.error)
      ? value.error as Record<string, unknown>
      : undefined
    throw new Error(typeof error?.message === 'string' ? error.message : `cross-store request failed with ${String(response.status)}`)
  }
  return value as Record<string, unknown>
}

async function browserNativeGet(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(path, { credentials: 'same-origin' })
  const value: unknown = await response.json()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('cross-store response is invalid')
  if (!response.ok) throw new Error(`cross-store query failed with ${String(response.status)}`)
  return value as Record<string, unknown>
}

async function runCrossStoreProbe(request: BrowserNativeWorkspaceTestRequest): Promise<Record<string, unknown>> {
  if (workspaceRuntime === undefined || !workspaceRuntime.isDurableWorkspace()) throw new Error('cross-store probe requires a durable Workspace')
  const path = request.path ?? `/dsh/home/workspace/cross-store-${crypto.randomUUID()}.txt`
  const content = request.content ?? 'browser-native cross-store checkpoint\n'
  const identityResponse = await fetch('/api/browser-native/workspace/identity', {
    credentials: 'same-origin',
    headers: { 'x-browser-native-identity-mode': 'existing' },
  })
  const identity: unknown = await identityResponse.json()
  if (!identityResponse.ok || identity === null || typeof identity !== 'object' || Array.isArray(identity)
    || typeof (identity as Record<string, unknown>).workspaceId !== 'string') throw new Error('cross-store Workspace identity is unavailable')
  const workspaceId = String((identity as Record<string, unknown>).workspaceId)
  const sessionId = request.sessionId ?? crypto.randomUUID()
  const session = await browserNativeJson('/api/browser-native/session/create', {
    sessionId,
    header: { id: sessionId, version: 1, createdAt: Date.now(), cwd: '/dsh/home/workspace' },
    inheritedEventCount: 0,
  })
  const owner = session.owner
  if (owner === null || typeof owner !== 'object' || Array.isArray(owner)
    || typeof owner.ownerToken !== 'string' || !Number.isSafeInteger(owner.ownerEpoch)) throw new Error('cross-store Session owner is unavailable')
  const lease = workspaceRuntime.getWriterLease()
  const revision = workspaceRuntime.getRevision()
  if (lease === undefined || revision === undefined) throw new Error('cross-store Workspace lease is unavailable')
  const operationId = request.operationId ?? crypto.randomUUID()
  const operation = {
    operationId,
    sessionId,
    workspaceId,
    ownerEpoch: Number(owner.ownerEpoch),
    workspaceFencingToken: lease.fencingToken,
    turn: 1,
    step: 1,
    callId: `cross-store-${operationId}`,
    toolName: 'write',
    toolCallSeq: 1,
    operationKind: 'browser-native-cross-store-probe',
    payloadDigest: await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ path, content }))).then(bytes => {
      return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
    }),
    payloadBytes: new TextEncoder().encode(JSON.stringify({ path, content })).byteLength,
  }
  await browserNativeJson('/api/browser-native/workspace/cross-store-operation/intent', operation)
  const workspaceReceipt = await workspaceRuntime.runToolOperation({ ...operation }, async () => {
    workspaceRuntime!.vfs.writeFileSync(path, content)
    await workspaceRuntime!.flushLocalWorkspace()
    const receipts = await workspaceRuntime!.flushWorkspace()
    const receipt = receipts[0]
    if (receipt === undefined) throw new Error('cross-store Workspace commit produced no receipt')
    return receipt
  })
  const receipt = workspaceReceipt as Record<string, unknown>
  await browserNativeJson('/api/browser-native/workspace/cross-store-operation/receipt', {
    operationId,
    kind: 'workspace',
    status: 'committed',
    receipt: {
      workspaceId,
      baseRevision: receipt.baseRevision,
      revision: receipt.revision,
      digest: receipt.manifestDigest,
      changedPaths: receipt.paths,
    },
  })
  let business: Record<string, unknown>
  let businessResponseRecovered = false
  try {
    business = await browserNativeJson('/api/browser-native/workspace/cross-store-operation/business', {
      operationId,
      payload: { path, content },
    })
  } catch {
    const recovered = await browserNativeGet(`/api/browser-native/workspace/cross-store-operation/${operationId}?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}&sessionId=${encodeURIComponent(sessionId)}`)
    const receipts = recovered.receipts
    const businessReceipt = receipts !== null && typeof receipts === 'object' && !Array.isArray(receipts)
      ? (receipts as Record<string, unknown>).business
      : undefined
    if (businessReceipt === null || typeof businessReceipt !== 'object' || Array.isArray(businessReceipt)
      || businessReceipt.status !== 'committed') throw new Error('cross-store business outcome is unknown')
    business = recovered
    businessResponseRecovered = true
  }
  const sessionEvent = {
    seq: 0,
    time: Date.now(),
    type: 'browser-native/workspace-receipt',
    ignorable: true,
    data: {
      turn: operation.turn,
      step: operation.step,
      callId: operation.callId,
      toolName: operation.toolName,
      toolCallSeq: operation.toolCallSeq,
      operationId,
      workspaceId,
      baseRevision: receipt.baseRevision,
      revision: receipt.revision,
      manifestDigest: receipt.manifestDigest,
      paths: receipt.paths,
      replayed: receipt.replayed,
    },
  }
  const appended = await browserNativeJson('/api/browser-native/session/append', {
    sessionId,
    ownerToken: owner.ownerToken,
    ownerEpoch: owner.ownerEpoch,
    expectedNextSeq: 0,
    events: [sessionEvent],
  })
  const flushed = await browserNativeJson('/api/browser-native/session/flush', {
    sessionId,
    ownerToken: owner.ownerToken,
    ownerEpoch: owner.ownerEpoch,
  })
  const queriedSessionSeq = Number(flushed.durableThroughSeq)
  const ledgerSession = await browserNativeJson('/api/browser-native/workspace/cross-store-operation/receipt', {
    operationId,
    kind: 'session',
    status: 'committed',
    receipt: { sessionId, seq: queriedSessionSeq, durableThroughSeq: queriedSessionSeq },
  })
  await workspaceRuntime.acknowledgeReceipt(operationId)
  return {
    ok: true,
    operationId,
    sessionId,
    workspaceId,
    workspaceRevision: receipt.revision,
    sessionSeq: queriedSessionSeq,
    sessionAppendCount: appended.acceptedCount,
    businessEffectCount: business.businessEffectCount,
    businessResponseRecovered,
    pendingReceiptCount: workspaceRuntime.pendingReceiptCount(),
    decision: (ledgerSession.decision as Record<string, unknown>)?.decision,
    path,
  }
}

function reportFileToolStage(stage: BrowserNativeFileToolStage): void {
  for (const [requestId, waiter] of fileToolStageWaiters) {
    if (waiter.stage !== stage) continue
    clearTimeout(waiter.timer)
    fileToolStageWaiters.delete(requestId)
    waiter.resolve(true)
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)))
  }
  return btoa(binary)
}

function hashWorkspacePath(path: string): { readonly bytes: number; readonly digest: string } {
  if (workspaceRuntime === undefined) throw new Error('browser-native workspace test: runtime is not ready')
  const bytes = workspaceRuntime.vfs.statSync(path).size
  const digest = new Sha256()
  for (let offset = 0; offset < bytes; offset += 1024 * 1024) {
    const chunk = workspaceRuntime.vfs.readFileRangeSync(path, offset, Math.min(1024 * 1024, bytes - offset))
    const expected = Math.min(1024 * 1024, bytes - offset)
    if (chunk.byteLength !== expected) throw new Error('browser-native workspace test: digest range returned a short read')
    digest.update(chunk)
  }
  return { bytes, digest: digest.digestHex() }
}

async function writeContentUploadWorkload(request: BrowserNativeWorkspaceTestRequest): Promise<Record<string, unknown>> {
  const runtime = workspaceRuntime
  const sourceBytes = request.byteLength
  const kind = request.contentKind
  const path = request.path
  if (runtime === undefined || !runtime.isDurableWorkspace() || typeof path !== 'string'
    || !path.startsWith('/dsh/home/workspace/') || path.includes('..')
    || sourceBytes === undefined || !Number.isSafeInteger(sourceBytes)
    || sourceBytes < 1024 * 1024 || sourceBytes > 64 * 1024 * 1024
    || kind !== 'text' && kind !== 'binary'
    || request.editKind !== undefined && !['insert', 'delete', 'replace'].includes(request.editKind)
    || request.editPosition !== undefined && !['head', 'middle', 'tail'].includes(request.editPosition)) {
    throw new Error('browser-native content upload workload: invalid durable file parameters')
  }
  const editBytes = request.editKind === 'replace' ? 4096 : 64 * 1024
  const editOffset = request.editPosition === 'head' ? 0
    : request.editPosition === 'tail' ? sourceBytes - editBytes : Math.floor(sourceBytes / 2)
  const totalBytes = sourceBytes + (request.editKind === 'insert' ? editBytes : request.editKind === 'delete' ? -editBytes : 0)
  if (totalBytes > 64 * 1024 * 1024) throw new Error('browser-native content upload workload: target exceeds 64 MiB')
  const encoder = new TextEncoder()
  const sourceRange = (offset: number, length: number): Uint8Array => {
    const output = new Uint8Array(length)
    if (kind === 'binary') {
      for (let index = 0; index < length; index += 1) {
        let state = (offset + index) ^ 0x31415926
        state = Math.imul(state ^ (state >>> 16), 0x21f0aaad)
        state = Math.imul(state ^ (state >>> 15), 0x735a2d97)
        output[index] = (state ^ (state >>> 15)) >>> 24
      }
    } else {
      for (let cursor = 0; cursor < length;) {
        const absolute = offset + cursor
        const row = Math.floor(absolute / 128)
        const line = encoder.encode(`export const row${String(row).padStart(8, '0')} = { amount: ${String(row * 7919 % 100000)}, owner: 'team-${String(row % 997)}' };`.padEnd(127, ' ') + '\n')
        const start = absolute % 128
        const count = Math.min(128 - start, length - cursor)
        output.set(line.subarray(start, start + count), cursor)
        cursor += count
      }
    }
    return output
  }
  const readRange = (offset: number, length: number): Uint8Array => {
    const output = new Uint8Array(length)
    for (let cursor = 0; cursor < length;) {
      const absolute = offset + cursor
      if (request.editKind === undefined || absolute < editOffset) {
        const count = request.editKind === undefined ? length - cursor : Math.min(length - cursor, editOffset - absolute)
        output.set(sourceRange(absolute, count), cursor)
        cursor += count
      } else if (request.editKind === 'delete') {
        output.set(sourceRange(absolute + editBytes, length - cursor), cursor)
        cursor = length
      } else if (absolute < editOffset + editBytes) {
        const count = Math.min(length - cursor, editOffset + editBytes - absolute)
        output.fill(kind === 'text' ? 0x58 : 0xb7, cursor, cursor + count)
        cursor += count
      } else {
        output.set(sourceRange(absolute - (request.editKind === 'insert' ? editBytes : 0), length - cursor), cursor)
        cursor = length
      }
    }
    return output
  }
  const digest = new Sha256()
  for (let offset = 0; offset < totalBytes; offset += 1024 * 1024) {
    digest.update(readRange(offset, Math.min(1024 * 1024, totalBytes - offset)))
  }
  const hash = digest.digestHex()
  runtime.vfs.replaceExternalSync(path, { size: totalBytes, read: readRange, close: () => {} }, { hash, bytes: totalBytes })
  await runtime.flushLocalWorkspace()
  return { ok: true, path, bytes: totalBytes, digest: hash, durable: true, usage: runtime.vfs.usage() }
}

function fixedFileChunks(totalBytes: number, chunkBytes: number): readonly { readonly offset: number; readonly length: number }[] {
  const chunks = []
  for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
    chunks.push({ offset, length: Math.min(chunkBytes, totalBytes - offset) })
  }
  return chunks
}

interface ContentSourceIndex {
  readonly cdc: boolean
  readonly averageBytes: number
  readonly chunks: readonly { readonly offset: number; readonly length: number; readonly hash: string }[]
  readonly sourceChunkSizes: ChunkSizeStats
  readonly sourceRangeReadBytes: number
  readonly sourceRangeReadCalls: number
  readonly sourceChunkingMs: number
  readonly sourceReadAndHashMs: number
}

interface ChunkSizeStats {
  readonly minimumBytes: number
  readonly medianBytes: number
  readonly meanBytes: number
  readonly maximumBytes: number
}

type BrowserNativeSyncAccessHandle = Parameters<typeof createSyncAccessChunkBackedFile>[0]

async function hashFileChunks(
  file: ChunkBackedFile,
  chunks: readonly { readonly offset: number; readonly length: number }[],
): Promise<{
  readonly chunks: readonly { readonly offset: number; readonly length: number; readonly hash: string }[]
  readonly elapsedMs: number
  readonly bytesRead: number
  readonly readCalls: number
}> {
  const startedAt = performance.now()
  const hashed = []
  let bytesRead = 0
  for (const chunk of chunks) {
    const bytes = file.read(chunk.offset, chunk.length)
    if (bytes.byteLength !== chunk.length) throw new Error('browser-native content chunking probe: short chunk read')
    bytesRead += bytes.byteLength
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    hashed.push({
      ...chunk,
      hash: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join(''),
    })
  }
  return { chunks: hashed, elapsedMs: performance.now() - startedAt, bytesRead, readCalls: chunks.length }
}

function contentChunkRangesAreValid(
  fileBytes: number,
  chunks: readonly { readonly offset: number; readonly length: number }[],
  minimumBytes: number,
  maximumBytes: number,
): boolean {
  let expectedOffset = 0
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.offset !== expectedOffset || chunk.length < 1 || chunk.length > maximumBytes
      || index < chunks.length - 1 && chunk.length < minimumBytes) return false
    expectedOffset += chunk.length
  }
  return expectedOffset === fileBytes
}

function chunkSizeStats(chunks: readonly { readonly length: number }[]): ChunkSizeStats {
  const lengths = chunks.map(chunk => chunk.length).sort((left, right) => left - right)
  if (lengths.length === 0) return { minimumBytes: 0, medianBytes: 0, meanBytes: 0, maximumBytes: 0 }
  return {
    minimumBytes: lengths[0]!,
    medianBytes: lengths[Math.floor(lengths.length / 2)]!,
    meanBytes: Math.round(lengths.reduce((total, length) => total + length, 0) / lengths.length),
    maximumBytes: lengths[lengths.length - 1]!,
  }
}

async function runContentChunkingProbe(request: BrowserNativeWorkspaceTestRequest): Promise<Record<string, unknown>> {
  const byteLength = request.byteLength
  const contentKind = request.contentKind
  const editKind = request.editKind
  const editPosition = request.editPosition
  const minimumBytes = request.minimumChunkBytes
  const averageBytes = request.averageChunkBytes
  const alternateAverageBytes = request.alternateAverageChunkBytes
  const maximumBytes = request.maximumChunkBytes
  if (byteLength === undefined || contentKind === undefined || editKind === undefined || editPosition === undefined
    || minimumBytes === undefined || averageBytes === undefined || alternateAverageBytes === undefined || maximumBytes === undefined) {
    throw new Error('browser-native content chunking probe: all workload and chunk limits are required')
  }
  const storage = globalThis.navigator?.storage
  if (storage === undefined || typeof storage.getDirectory !== 'function') {
    throw new Error('browser-native content chunking probe: OPFS is unavailable')
  }
  const root = await storage.getDirectory()
  const directoryName = `dsh-content-chunking-${crypto.randomUUID()}`
  const ioBytes = 256 * 1024
  const editBytes = editKind === 'replace' ? 4096 : 64 * 1024
  const sourceBuffer = new Uint8Array(ioBytes)
  const repeated = new TextEncoder().encode('{"status":"active","amount":12345,"source":"web"}\n')
  const textEncoder = new TextEncoder()
  let directoryCreated = false
  let randomState = 0x31415926
  let textRow = 0
  let sourceSync: BrowserNativeSyncAccessHandle | undefined
  let targetSync: BrowserNativeSyncAccessHandle | undefined
  try {
    const directory = await root.getDirectoryHandle(directoryName, { create: true })
    directoryCreated = true
    const sourceHandle = await directory.getFileHandle('source', { create: true })
    const targetHandle = await directory.getFileHandle('target', { create: true })
    sourceSync = await sourceHandle.createSyncAccessHandle()
    targetSync = await targetHandle.createSyncAccessHandle()
    const source = createSyncAccessChunkBackedFile(sourceSync)
    const target = createSyncAccessChunkBackedFile(targetSync)
    source.truncate(byteLength)
    for (let offset = 0; offset < byteLength; offset += ioBytes) {
      const length = Math.min(ioBytes, byteLength - offset)
      for (let index = 0; index < length; index += 1) {
        if (contentKind === 'repetitive') {
          sourceBuffer[index] = repeated[(offset + index) % repeated.byteLength]!
        } else if (contentKind === 'binary') {
          randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
          sourceBuffer[index] = randomState >>> 24
        }
      }
      if (contentKind === 'text') {
        let bufferOffset = 0
        while (bufferOffset < length) {
          const line = textEncoder.encode(`export const row${String(textRow).padStart(8, '0')} = { status: 'active', amount: ${String((textRow * 7919) % 100000)}, owner: 'team-${String(textRow % 997)}' };\n`)
          const lineBytes = Math.min(line.byteLength, length - bufferOffset)
          sourceBuffer.set(line.subarray(0, lineBytes), bufferOffset)
          bufferOffset += lineBytes
          textRow += 1
        }
      }
      source.write(offset, sourceBuffer.subarray(0, length))
    }
    source.flush()

    const editOffset = editPosition === 'head' ? 0
      : editPosition === 'tail' ? byteLength - editBytes
        : Math.floor(byteLength / 2)
    const targetBytes = byteLength + (editKind === 'insert' ? editBytes : editKind === 'delete' ? -editBytes : 0)
    target.truncate(targetBytes)
    if (editKind === 'replace') {
      for (let offset = 0; offset < byteLength; offset += ioBytes) {
        const length = Math.min(ioBytes, byteLength - offset)
        target.write(offset, source.read(offset, length))
      }
      const replacement = new Uint8Array(editBytes)
      replacement.fill(contentKind === 'text' ? 0x58 : 0xd3)
      target.write(editOffset, replacement)
    } else if (editKind === 'insert') {
      for (let offset = 0; offset < editOffset; offset += ioBytes) {
        const length = Math.min(ioBytes, editOffset - offset)
        target.write(offset, source.read(offset, length))
      }
      const insertion = new Uint8Array(editBytes)
      if (contentKind === 'repetitive') {
        for (let index = 0; index < insertion.byteLength; index += 1) insertion[index] = repeated[index % repeated.byteLength]!
      } else insertion.fill(contentKind === 'text' ? 0x59 : 0xb7)
      target.write(editOffset, insertion)
      for (let sourceOffset = editOffset, targetOffset = editOffset + editBytes;
        sourceOffset < byteLength; sourceOffset += ioBytes, targetOffset += ioBytes) {
        const length = Math.min(ioBytes, byteLength - sourceOffset)
        target.write(targetOffset, source.read(sourceOffset, length))
      }
    } else {
      for (let offset = 0; offset < editOffset; offset += ioBytes) {
        const length = Math.min(ioBytes, editOffset - offset)
        target.write(offset, source.read(offset, length))
      }
      for (let sourceOffset = editOffset + editBytes, targetOffset = editOffset;
        sourceOffset < byteLength; sourceOffset += ioBytes, targetOffset += ioBytes) {
        const length = Math.min(ioBytes, byteLength - sourceOffset)
        target.write(targetOffset, source.read(sourceOffset, length))
      }
    }
    target.flush()

    const buildSourceIndex = async (cdc: boolean, cdcAverage = averageBytes): Promise<ContentSourceIndex> => {
      const sourceChunkingStartedAt = performance.now()
      const sourceRanges = cdc
        ? await findContentChunks(byteLength, (offset, length) => source.read(offset, length), {
          minimumBytes, averageBytes: cdcAverage, maximumBytes, readBytes: ioBytes,
        })
        : { chunks: fixedFileChunks(byteLength, 1024 * 1024), bytesRead: 0, readCalls: 0, maxReadBytes: 0 }
      const sourceChunkingMs = performance.now() - sourceChunkingStartedAt
      const sourceHashes = await hashFileChunks(source, sourceRanges.chunks)
      if (cdc && !contentChunkRangesAreValid(byteLength, sourceRanges.chunks, minimumBytes, maximumBytes)) {
        throw new Error('browser-native content chunking probe: source chunks violate range limits')
      }
      return {
        cdc,
        averageBytes: cdcAverage,
        chunks: sourceHashes.chunks,
        sourceChunkSizes: chunkSizeStats(sourceRanges.chunks),
        sourceRangeReadBytes: cdc ? sourceRanges.bytesRead + sourceHashes.bytesRead : sourceHashes.bytesRead,
        sourceRangeReadCalls: cdc ? sourceRanges.readCalls + sourceHashes.readCalls : sourceHashes.readCalls,
        sourceChunkingMs,
        sourceReadAndHashMs: sourceHashes.elapsedMs,
      }
    }

    const measureTarget = async (sourceIndex: ContentSourceIndex) => {
      const targetChunkingStartedAt = performance.now()
      const targetRanges = sourceIndex.cdc
        ? await findContentChunks(targetBytes, (offset, length) => target.read(offset, length), {
          minimumBytes, averageBytes: sourceIndex.averageBytes, maximumBytes, readBytes: ioBytes,
        })
        : { chunks: fixedFileChunks(targetBytes, 1024 * 1024), bytesRead: 0, readCalls: 0, maxReadBytes: 0 }
      const targetChunkingMs = performance.now() - targetChunkingStartedAt
      const targetHashes = await hashFileChunks(target, targetRanges.chunks)
      if (sourceIndex.cdc && !contentChunkRangesAreValid(targetBytes, targetRanges.chunks, minimumBytes, maximumBytes)) {
        throw new Error('browser-native content chunking probe: target chunks violate range limits')
      }
      const sourceByPosition = new Set(sourceIndex.chunks.map(chunk => `${chunk.offset}:${chunk.length}:${chunk.hash}`))
      const sourceByContent = new Set(sourceIndex.chunks.map(chunk => `${chunk.length}:${chunk.hash}`))
      let reusableBytes = 0
      let uploadedBytes = 0
      let uploadedChunks = 0
      for (const chunk of targetHashes.chunks) {
        const reusable = sourceIndex.cdc
          ? sourceByContent.has(`${chunk.length}:${chunk.hash}`)
          : sourceByPosition.has(`${chunk.offset}:${chunk.length}:${chunk.hash}`)
        if (reusable) reusableBytes += chunk.length
        else {
          uploadedBytes += chunk.length
          uploadedChunks += 1
        }
      }
      const descriptors = targetHashes.chunks.map(({ offset, length, hash }) => ({ offset, length, hash }))
      return {
        chunkCount: targetHashes.chunks.length,
        reusableBytes,
        uploadedBytes,
        uploadedChunks,
        descriptorBytes: new TextEncoder().encode(JSON.stringify(descriptors)).byteLength,
        sourceChunkSizes: sourceIndex.sourceChunkSizes,
        targetChunkSizes: chunkSizeStats(targetRanges.chunks),
        sourceChunkingMs: sourceIndex.sourceChunkingMs,
        sourceReadAndHashMs: sourceIndex.sourceReadAndHashMs,
        targetChunkingMs,
        targetReadAndHashMs: targetHashes.elapsedMs,
        sourceIndexBuildMs: sourceIndex.sourceChunkingMs + sourceIndex.sourceReadAndHashMs,
        targetPreparationMs: targetChunkingMs + targetHashes.elapsedMs,
        sourceBytesRead: sourceIndex.sourceRangeReadBytes,
        sourceReadCalls: sourceIndex.sourceRangeReadCalls,
        targetBytesRead: sourceIndex.cdc ? targetRanges.bytesRead + targetHashes.bytesRead : targetHashes.bytesRead,
        targetReadCalls: sourceIndex.cdc ? targetRanges.readCalls + targetHashes.readCalls : targetHashes.readCalls,
        maximumChunkBytes: targetHashes.chunks.reduce((maximum, chunk) => Math.max(maximum, chunk.length), 0),
      }
    }

    const fixedSourceIndex = await buildSourceIndex(false)
    const cdcSourceIndex = await buildSourceIndex(true, averageBytes)
    const alternateCdcSourceIndex = await buildSourceIndex(true, alternateAverageBytes)
    const results = []
    for (let repeat = 0; repeat < 3; repeat += 1) {
      results.push({
        fixed: await measureTarget(fixedSourceIndex),
        cdc: await measureTarget(cdcSourceIndex),
        alternateCdc: await measureTarget(alternateCdcSourceIndex),
      })
    }
    const sourceHash = hashChunkBackedFile(source, ioBytes)
    const targetHash = hashChunkBackedFile(target, ioBytes)
    return {
      ok: targetBytes === target.size && sourceHash !== targetHash
        && results.every(result => result.fixed.reusableBytes + result.fixed.uploadedBytes === targetBytes
          && result.cdc.reusableBytes + result.cdc.uploadedBytes === targetBytes
          && result.cdc.maximumChunkBytes <= maximumBytes
          && result.alternateCdc.reusableBytes + result.alternateCdc.uploadedBytes === targetBytes
          && result.alternateCdc.maximumChunkBytes <= maximumBytes),
      storage: 'DSH Worker OPFS sync access handles',
      sourceBytes: byteLength,
      targetBytes,
      contentKind,
      editKind,
      editPosition,
      sourceHash,
      targetHash,
      integrityReadBytes: byteLength + targetBytes,
      config: { minimumBytes, averageBytes, alternateAverageBytes, maximumBytes, readBytes: ioBytes },
      results,
    }
  } finally {
    try {
      sourceSync?.close()
    } finally {
      try {
        targetSync?.close()
      } finally {
        if (directoryCreated) await root.removeEntry(directoryName, { recursive: true })
      }
    }
  }
}

async function runChunkEditProbe(request: BrowserNativeWorkspaceTestRequest): Promise<Record<string, unknown>> {
  if (request.byteLength === undefined || request.chunkBytes === undefined
    || request.oldText === undefined || request.newText === undefined) {
    throw new Error('browser-native chunk edit probe: byteLength, chunkBytes, oldText, and newText are required')
  }
  const storage = globalThis.navigator?.storage
  if (storage === undefined || typeof storage.getDirectory !== 'function') {
    throw new Error('browser-native chunk edit probe: OPFS is unavailable')
  }
  const root = await storage.getDirectory()
  const directoryName = `dsh-chunk-edit-probe-${crypto.randomUUID()}`
  const directory = await root.getDirectoryHandle(directoryName, { create: true })
  const sourceHandle = await directory.getFileHandle('source', { create: true })
  const targetHandle = await directory.getFileHandle('candidate', { create: true })
  const sourceSync = await sourceHandle.createSyncAccessHandle()
  const targetSync = await targetHandle.createSyncAccessHandle()
  const source = createSyncAccessChunkBackedFile(sourceSync)
  const target = createSyncAccessChunkBackedFile(targetSync)
  try {
    const sourceChunk = new Uint8Array(request.chunkBytes)
    const markerOffset = Math.floor(request.byteLength / 2)
    const markerBytes = new TextEncoder().encode(request.oldText)
    if (markerOffset + markerBytes.byteLength > request.byteLength) {
      throw new Error('browser-native chunk edit probe: marker does not fit in the source file')
    }
    source.truncate(request.byteLength)
    for (let offset = 0; offset < request.byteLength; offset += request.chunkBytes) {
      const length = Math.min(request.chunkBytes, request.byteLength - offset)
      sourceChunk.fill(0x61, 0, length)
      source.write(offset, sourceChunk.subarray(0, length))
    }
    source.write(markerOffset, markerBytes)
    source.flush()
    const sourceHash = hashChunkBackedFile(source, request.chunkBytes)
    let metrics
    try {
      metrics = replaceUniqueUtf8CopyOnWrite(source, target, request.oldText, request.newText, {
        chunkBytes: request.chunkBytes,
        onStage: stage => {
          if (request.failStage === stage) throw new Error(`injected ${stage} failure`)
        },
      })
    } catch (error) {
      const afterFailureHash = hashChunkBackedFile(source, request.chunkBytes)
      return {
        ok: false,
        failure: error instanceof Error ? error.message : String(error),
        sourceHash,
        afterFailureHash,
        sourceUnchanged: sourceHash === afterFailureHash,
        targetBytes: target.size,
        chunkBytes: request.chunkBytes,
        failStage: request.failStage,
      }
    }
    const verifiedHash = hashChunkBackedFile(target, request.chunkBytes)
    const resultMarker = new TextEncoder().encode(request.newText)
    const aroundMarker = target.read(markerOffset, Math.min(request.chunkBytes, resultMarker.byteLength + 32))
    return {
      ok: true,
      sourceHash,
      verifiedHash,
      resultHash: metrics.resultHash,
      resultBytes: metrics.resultBytes,
      markerOffset,
      markerBytes: resultMarker.byteLength,
      markerPreview: encodeBase64(aroundMarker),
      ...metrics,
    }
  } finally {
    source.close()
    target.close()
    await root.removeEntry(directoryName, { recursive: true })
  }
}

function createWorkspaceRangeFile(path: string): ChunkBackedFile {
  if (workspaceRuntime === undefined) throw new Error('browser-native reference edit probe: runtime is not ready')
  const vfs = workspaceRuntime.vfs
  return {
    get size(): number { return (vfs.statSync(path) as { size: number }).size },
    read: (position, length) => vfs.readFileRangeSync(path, position, length),
    write: () => { throw new Error('browser-native reference edit probe: source is read-only') },
    truncate: () => { throw new Error('browser-native reference edit probe: source is read-only') },
    flush: () => {},
    close: () => {},
  }
}

async function runReferenceEditProbe(request: BrowserNativeWorkspaceTestRequest): Promise<Record<string, unknown>> {
  if (workspaceRuntime === undefined || request.byteLength === undefined || request.chunkBytes === undefined
    || request.oldText === undefined || request.newText === undefined) {
    throw new Error('browser-native reference edit probe: runtime, byteLength, chunkBytes, oldText, and newText are required')
  }
  const storage = globalThis.navigator?.storage
  if (storage === undefined || typeof storage.getDirectory !== 'function') {
    throw new Error('browser-native reference edit probe: OPFS is unavailable')
  }
  const path = request.path ?? '/dsh/home/workspace/reference-edit.bin'
  if (!path.startsWith('/dsh/home/workspace/')) throw new Error('browser-native reference edit probe: path must be in Workspace')
  const root = await storage.getDirectory()
  const directoryName = `dsh-reference-edit-probe-${crypto.randomUUID()}`
  const directory = await root.getDirectoryHandle(directoryName, { create: true })
  const sourceHandle = await directory.getFileHandle('source', { create: true })
  const targetHandle = await directory.getFileHandle('target', { create: true })
  const sourceSync = await sourceHandle.createSyncAccessHandle()
  const targetSync = await targetHandle.createSyncAccessHandle()
  const sourceChunk = createSyncAccessChunkBackedFile(sourceSync)
  const targetChunk = createSyncAccessChunkBackedFile(targetSync)
  let published = false
  try {
    const markerBytes = new TextEncoder().encode(request.oldText)
    const markerOffset = Math.floor(request.byteLength / 2)
    if (markerOffset + markerBytes.byteLength > request.byteLength) throw new Error('browser-native reference edit probe: marker does not fit')
    sourceChunk.truncate(request.byteLength)
    const fill = new Uint8Array(request.chunkBytes)
    fill.fill(0x61)
    for (let offset = 0; offset < request.byteLength; offset += request.chunkBytes) {
      sourceChunk.write(offset, fill.subarray(0, Math.min(request.chunkBytes, request.byteLength - offset)))
    }
    sourceChunk.write(markerOffset, markerBytes)
    sourceChunk.flush()
    workspaceRuntime.vfs.seedExternal(path, {
      size: request.byteLength,
      read: (position, length) => sourceChunk.read(position, length),
      close: () => { sourceChunk.close() },
    })
    const source = createWorkspaceRangeFile(path)
    const sourceHash = hashChunkBackedFile(source, request.chunkBytes)
    let metrics
    try {
      metrics = replaceUniqueUtf8CopyOnWrite(source, targetChunk, request.oldText, request.newText, {
        chunkBytes: request.chunkBytes,
        onStage: stage => {
          if (request.failStage === stage) throw new Error(`injected ${stage} failure`)
        },
      })
    } catch (error) {
      const afterFailureHash = hashChunkBackedFile(source, request.chunkBytes)
      return {
        ok: false,
        failure: error instanceof Error ? error.message : String(error),
        sourceHash,
        afterFailureHash,
        sourceUnchanged: sourceHash === afterFailureHash,
        failStage: request.failStage,
      }
    }
    const targetBacking = {
      get size(): number { return targetChunk.size },
      read: (position: number, length: number): Uint8Array => targetChunk.read(position, length),
      close: (): void => { targetChunk.close() },
    }
    const reference = { hash: metrics.resultHash, bytes: metrics.resultBytes }
    const receipts = await workspaceRuntime.runToolOperation({
      sessionId: 'browser-native-reference-edit-probe',
      turn: 1,
      step: 1,
      callId: `reference-edit-${crypto.randomUUID()}`,
      toolName: 'browser_edit_ref',
      toolCallSeq: 1,
    }, async () => {
      workspaceRuntime!.vfs.replaceExternalSync(path, targetBacking, reference)
      published = true
      await workspaceRuntime!.flushLocalWorkspace()
      return await workspaceRuntime!.flushWorkspace()
    })
    const afterHash = hashChunkBackedFile(createWorkspaceRangeFile(path), request.chunkBytes)
    const usage = workspaceRuntime.vfs.usage()
    const receipt = receipts[0]
    return {
      ok: true,
      result: {
        path,
        beforeHash: sourceHash,
        afterHash,
        beforeBytes: request.byteLength,
        afterBytes: metrics.resultBytes,
        replacedBytes: markerBytes.byteLength,
        replacementBytes: new TextEncoder().encode(request.newText).byteLength,
        operationId: receipt?.operationId,
        revision: receipt?.revision,
      },
      metrics,
      usage,
      receipt,
    }
  } finally {
    workspaceRuntime.vfs.close()
    if (!published) {
      sourceChunk.close()
      targetChunk.close()
    }
    await root.removeEntry(directoryName, { recursive: true })
  }
}

async function runSessionOutboxMigrationProbe(sessionId: string, event: SessionEvent): Promise<boolean> {
  const databaseName = `dsh-browser-native-session-outbox-migration-${crypto.randomUUID()}`
  const oldWriterId = crypto.randomUUID()
  const byteLength = new TextEncoder().encode(JSON.stringify(event)).byteLength
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('events', { keyPath: ['sessionId', 'seq'] })
      request.result.createObjectStore('sessions', { keyPath: 'sessionId' })
    }
    request.onerror = () => reject(request.error ?? new Error('legacy Session outbox open failed'))
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction(['events', 'sessions'], 'readwrite')
      transaction.objectStore('events').put({
        sessionId,
        seq: Number(event.seq),
        ownerEpoch: 4,
        writerId: oldWriterId,
        byteLength,
        event,
      })
      transaction.objectStore('sessions').put({
        sessionId,
        ownerEpoch: 4,
        writerId: oldWriterId,
        eventCount: 1,
        pendingBytes: byteLength,
        firstSeq: Number(event.seq),
        lastSeq: Number(event.seq),
      })
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error ?? new Error('legacy Session outbox seed failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('legacy Session outbox seed aborted'))
    }
  })

  const outbox = new BrowserNativeSessionOutbox({ databaseName })
  const writerId = crypto.randomUUID()
  await outbox.claim(sessionId, 5, writerId)
  const recovered = await outbox.read(sessionId, 5, writerId)
  const appended: SessionEvent = {
    seq: (Number(event.seq) + 1) as SessionSeq,
    time: Date.now(),
    type: 'turn/start',
    data: { turn: 2 },
  }
  await outbox.append(sessionId, 5, writerId, [appended])
  let totals: unknown
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 2)
    request.onerror = () => reject(request.error ?? new Error('migrated Session outbox open failed'))
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('meta', 'readonly')
      const totalsRequest = transaction.objectStore('meta').get('totals')
      totalsRequest.onsuccess = () => { totals = totalsRequest.result }
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error ?? new Error('migrated Session outbox totals read failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('migrated Session outbox totals read aborted'))
    }
  })
  return recovered.pendingEvents.length === 1 && JSON.stringify(recovered.pendingEvents[0]) === JSON.stringify(event)
    && typeof totals === 'object' && totals !== null && 'eventCount' in totals && totals.eventCount === 2
    && 'pendingBytes' in totals && totals.pendingBytes === byteLength
      + new TextEncoder().encode(JSON.stringify(appended)).byteLength
}

async function handleWorkspaceTestRequest(request: BrowserNativeWorkspaceTestRequest): Promise<void> {
  try {
    if (request.action === 'wait-attachment-opfs-staging-write') {
      if (attachmentOpfsStageWaiter !== undefined || attachmentOpfsWriteRelease !== undefined) {
        throw new Error('browser-native attachment test: an OPFS write barrier is already active')
      }
      attachmentOpfsWriteOutcome = 'armed'
      attachmentOpfsStageWaiter = request.requestId
      return
    }
    if (request.action === 'attachment-opfs-write-state') {
      workspaceTestResponse(request.requestId, { ok: true, outcome: attachmentOpfsWriteOutcome })
      return
    }
    if (request.action === 'release-attachment-opfs-write') {
      if (attachmentOpfsStageWaiter !== undefined) {
        const waiter = attachmentOpfsStageWaiter
        attachmentOpfsStageWaiter = undefined
        attachmentOpfsWriteOutcome = 'released-before-stage'
        workspaceTestResponse(waiter, { ok: false, outcome: attachmentOpfsWriteOutcome })
      }
      attachmentOpfsWriteRelease?.()
      workspaceTestResponse(request.requestId, { ok: true, outcome: attachmentOpfsWriteOutcome })
      return
    }
    if (request.action === 'reconcile-attachment-staging') {
      if (reconcileAttachmentTemporaryFilesForTest === undefined) {
        throw new Error('browser-native attachment test: attachment module is unavailable')
      }
      await reconcileAttachmentTemporaryFilesForTest()
      workspaceTestResponse(request.requestId, { ok: true })
      return
    }
    if (request.action === 'module-trace') {
      const moduleTrace = host?.modules?.requestTrace()
      if (moduleTrace === undefined) throw new Error('browser-native worker: module trace is disabled')
      workspaceTestResponse(request.requestId, {
        ok: true,
        moduleTrace,
        builtinMemberTrace: builtinMemberTrace?.snapshot() ?? { members: [], droppedCalls: 0 },
      })
      return
    }
    if (request.action === 'builtin-member-trace') {
      if (builtinMemberTrace === undefined) throw new Error('browser-native worker: builtin member trace is disabled')
      workspaceTestResponse(request.requestId, { ok: true, trace: builtinMemberTrace.snapshot() })
      return
    }
    if (request.action === 'node-fs-read') {
      if (host?.modules === undefined || request.path === undefined || request.marker === undefined) {
        throw new Error('browser-native worker: node filesystem probe needs a ready loader, path, and marker')
      }
      const fsPromises = host.modules.requireFrom('/dsh')('node:fs/promises') as typeof import('node:fs/promises')
      const content = await fsPromises.readFile(request.path, 'utf8')
      workspaceTestResponse(request.requestId, {
        ok: true,
        path: request.path,
        characters: content.length,
        markerFound: content.includes(request.marker),
      })
      return
    }
    if (request.action === 'unsupported-builtin-probe') {
      if (host?.modules === undefined) throw new Error('browser-native worker: module loader is not ready')
      try {
        const net = host.modules.requireFrom('/dsh')('node:net') as typeof import('node:net')
        net.createServer()
        workspaceTestResponse(request.requestId, { ok: false, error: 'node:net.createServer unexpectedly returned' })
      } catch (error) {
        workspaceTestResponse(request.requestId, {
          ok: true,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    if (request.action === 'permission-state') {
      if (request.sessionId === undefined) throw new Error('browser-native permission test: sessionId is required')
      workspaceTestResponse(request.requestId, { ok: true, permission: permissionProbe.inspect(request.sessionId) })
      return
    }
    if (request.action === 'control-inject') {
      if (request.controlInjection === undefined) throw new Error('browser-native control test: injection kind is required')
      publishBrowserNativeControlTestFrame(request.controlInjection)
      workspaceTestResponse(request.requestId, { ok: true, controlInjection: request.controlInjection })
      return
    }
    if (request.action === 'abort-session-outbox-appends') {
      sessionOutboxAppendsToAbort = Number(request.count)
      workspaceTestResponse(request.requestId, { ok: true, count: sessionOutboxAppendsToAbort })
      return
    }
    if (request.action === 'session-outbox-probe') {
      const probePrefix = `outbox-probe-${crypto.randomUUID()}`
      const probeOutbox = new BrowserNativeSessionOutbox({
        databaseName: `dsh-browser-native-session-outbox-probe-${crypto.randomUUID()}`,
        maxTrackedSessions: 2,
      })
      const sessionId = `outbox-probe-${crypto.randomUUID()}`
      const oldWriterId = crypto.randomUUID()
      const newWriterId = crypto.randomUUID()
      const createEvent = (seq: number, turn: number): SessionEvent => ({
        seq: seq as SessionSeq,
        time: Date.now(),
        type: 'turn/start',
        data: { turn },
      })
      const first = createEvent(0, 1)
      const second = createEvent(1, 2)
      await probeOutbox.claim(sessionId, 1, oldWriterId)
      await probeOutbox.append(sessionId, 1, oldWriterId, [first])
      await probeOutbox.append(sessionId, 1, oldWriterId, [first])
      const duplicate = await probeOutbox.read(sessionId, 1, oldWriterId)
      let gapRejected = false
      try {
        await probeOutbox.append(sessionId, 1, oldWriterId, [createEvent(2, 3)])
      } catch (error) {
        gapRejected = error instanceof Error && error.message.includes('do not continue')
      }
      await probeOutbox.claim(sessionId, 2, newWriterId)
      let staleWriterRejected = false
      try {
        await probeOutbox.append(sessionId, 1, oldWriterId, [second])
      } catch (error) {
        staleWriterRejected = error instanceof Error && error.message.includes('fenced')
      }
      const claimed = await probeOutbox.read(sessionId, 2, newWriterId)
      await probeOutbox.append(sessionId, 2, newWriterId, [first])
      let conflictRejected = false
      try {
        await probeOutbox.append(sessionId, 2, newWriterId, [createEvent(0, 99)])
      } catch (error) {
        conflictRejected = error instanceof Error && error.message.includes('different event data')
      }
      await probeOutbox.append(sessionId, 2, newWriterId, [second])
      await probeOutbox.acknowledgeThrough(sessionId, 2, newWriterId, 0)
      const afterAcknowledgement = await probeOutbox.read(sessionId, 2, newWriterId)
      await probeOutbox.acknowledgeThrough(sessionId, 2, newWriterId, 1)
      let fencedAfterDrain = false
      try {
        await probeOutbox.append(sessionId, 1, oldWriterId, [createEvent(2, 3)])
      } catch (error) {
        fencedAfterDrain = error instanceof Error && error.message.includes('fenced')
      }
      const fenceOutbox = new BrowserNativeSessionOutbox({
        databaseName: `dsh-browser-native-session-fence-probe-${crypto.randomUUID()}`,
        maxTrackedSessions: 2,
      })
      const fenceA = `${probePrefix}-fence-a`
      const fenceB = `${probePrefix}-fence-b`
      const fenceC = `${probePrefix}-fence-c`
      const fenceD = `${probePrefix}-fence-d`
      const fenceAWriter = crypto.randomUUID()
      const fenceBWriter = crypto.randomUUID()
      const fenceCWriter = crypto.randomUUID()
      const fenceDWriter = crypto.randomUUID()
      await fenceOutbox.claim(fenceA, 1, fenceAWriter)
      await fenceOutbox.claim(fenceB, 1, fenceBWriter)
      await fenceOutbox.claim(fenceC, 1, fenceCWriter)
      let emptyFenceEvicted = false
      try {
        await fenceOutbox.append(fenceA, 1, fenceAWriter, [createEvent(0, 1)])
      } catch (error) {
        emptyFenceEvicted = error instanceof Error && error.message.includes('no local claim')
      }
      await fenceOutbox.append(fenceB, 1, fenceBWriter, [createEvent(0, 2)])
      await fenceOutbox.claim(fenceD, 1, fenceDWriter)
      await fenceOutbox.append(fenceD, 1, fenceDWriter, [createEvent(0, 3)])
      let pendingCapacityRejected = false
      try {
        await fenceOutbox.claim(`${probePrefix}-over-capacity`, 1, crypto.randomUUID())
      } catch (error) {
        pendingCapacityRejected = error instanceof Error && error.message.includes('active or pending')
      }
      const capacityRejected = emptyFenceEvicted && pendingCapacityRejected
      const totalBudgetOutbox = new BrowserNativeSessionOutbox({
        databaseName: `dsh-browser-native-session-total-budget-probe-${crypto.randomUUID()}`,
        maxTotalPendingBytes: 32,
      })
      const totalBudgetSession = `${probePrefix}-total-budget`
      const totalBudgetWriter = crypto.randomUUID()
      await totalBudgetOutbox.claim(totalBudgetSession, 1, totalBudgetWriter)
      let totalByteCapacityRejected = false
      try {
        await totalBudgetOutbox.append(totalBudgetSession, 1, totalBudgetWriter, [createEvent(0, 1_000_000)])
      } catch (error) {
        totalByteCapacityRejected = error instanceof Error && error.message.includes('pending event capacity exceeded')
      }
      const afterTotalLimit = await totalBudgetOutbox.read(totalBudgetSession, 1, totalBudgetWriter)
      const migrationEvent = createEvent(0, 1)
      const migrationPreserved = await runSessionOutboxMigrationProbe(`${probePrefix}-migration`, migrationEvent)
      const largeSession = `outbox-large-${crypto.randomUUID()}`
      const largeWriter = crypto.randomUUID()
      await probeOutbox.claim(largeSession, 1, largeWriter)
      let bytesLimitRejected = false
      const largeEvent: SessionEvent = {
        seq: 0 as SessionSeq,
        time: Date.now(),
        type: 'tool/call',
        data: {
          turn: 1,
          step: 1,
          callId: 'outbox-large-call' as ToolCallId,
          name: 'write',
          arguments: JSON.stringify({ content: 'x'.repeat(16 * 1024 * 1024) }),
        },
      }
      try {
        await probeOutbox.append(largeSession, 1, largeWriter, [largeEvent])
      } catch (error) {
        bytesLimitRejected = error instanceof Error && error.message.includes('pending event capacity exceeded')
      }
      const afterLargeEvent = await probeOutbox.read(largeSession, 1, largeWriter)
      workspaceTestResponse(request.requestId, {
        ok: staleWriterRejected && conflictRejected && claimed.pendingEvents.length === 1
          && afterAcknowledgement.pendingEvents.length === 1 && afterAcknowledgement.pendingEvents[0].seq === 1
          && fencedAfterDrain && gapRejected && duplicate.pendingEvents.length === 1
          && capacityRejected && totalByteCapacityRejected && afterTotalLimit.pendingEvents.length === 0
          && bytesLimitRejected && afterLargeEvent.pendingEvents.length === 0 && migrationPreserved,
        staleWriterRejected,
        fencedAfterDrain,
        gapRejected,
        duplicateCount: duplicate.pendingEvents.length,
        trackedSessionCapacityRejected: capacityRejected,
        emptyFenceEvicted,
        pendingSessionCapacityRejected: pendingCapacityRejected,
        totalPendingByteCapacityRejected: totalByteCapacityRejected,
        versionOneMigrationPreservedPendingEvents: migrationPreserved,
        pendingByteCapacityRejected: bytesLimitRejected,
        pendingAfterRejectedLargeEvent: afterLargeEvent.pendingEvents.length,
        conflictRejected,
        claimedPendingEvents: claimed.pendingEvents.length,
        remainingSeq: afterAcknowledgement.pendingEvents.map(event => Number(event.seq)),
      })
      return
    }
    if (request.action === 'session-mount-probe') {
      workspaceTestResponse(request.requestId, { ok: true, sessionMount: runSessionMountProbe() })
      return
    }
    if (request.action === 'session-projection-probe') {
      workspaceTestResponse(request.requestId, { ok: true, sessionProjection: runSessionProjectionProbe() })
      return
    }
    if (request.action === 'approval-projection-probe') {
      workspaceTestResponse(request.requestId, { ok: true, approvalProjection: runApprovalProjectionProbe() })
      return
    }
    if (workspaceRuntime === undefined) throw new Error('browser-native workspace test: runtime is not ready')
    if (request.action === 'write-content-workload') {
      workspaceTestResponse(request.requestId, await writeContentUploadWorkload(request))
      return
    }
    if (request.action === 'chunk-edit-probe') {
      workspaceTestResponse(request.requestId, await runChunkEditProbe(request))
      return
    }
    if (request.action === 'content-chunking-probe') {
      workspaceTestResponse(request.requestId, await runContentChunkingProbe(request))
      return
    }
    if (request.action === 'reference-edit-probe') {
      workspaceTestResponse(request.requestId, await runReferenceEditProbe(request))
      return
    }
    if (request.action === 'cross-store-probe') {
      workspaceTestResponse(request.requestId, await runCrossStoreProbe(request))
      return
    }
    if (request.action === 'session-handoff') {
      const response = await fetch('/api/browser-native/session/handoff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          requestId: request.requestId,
          sessionId: request.sessionId,
          ownerToken: request.ownerToken,
          ownerEpoch: request.ownerEpoch,
          handoffId: request.handoffId,
          checkpoint: request.checkpoint,
        }),
      })
      workspaceTestResponse(request.requestId, {
        ok: response.ok,
        status: response.status,
        value: await response.json(),
      })
      return
    }
    if (request.action === 'execution-handoff') {
      const sessionId = request.sessionId!
      const ownerToken = request.ownerToken!
      const ownerEpoch = request.ownerEpoch!
      const handoff = await handoffBrowserNativeExecution({
        sessionId,
        ownerId: request.ownerId!,
        handoffId: request.handoffId!,
        ownerEpoch,
        flushWorkspace: async () => {
          if (!workspaceRuntime.isDurableWorkspace()) throw new Error('durable Workspace is required for execution handoff')
          const workspaceId = workspaceRuntime.getWorkspaceId()
          const revision = workspaceRuntime.getRevision()
          const lease = workspaceRuntime.getWriterLease()
          if (workspaceId === undefined || revision === undefined || lease === undefined) {
            throw new Error('Workspace identity, revision, or writer lease is unavailable')
          }
          await workspaceRuntime.flushWorkspace()
          await workspaceRuntime.flushLocalWorkspace()
          return {
            workspaceId,
            revision: workspaceRuntime.getRevision() ?? revision,
            fencingToken: lease.fencingToken,
          }
        },
        flushSession: async () => {
          return await flushBrowserNativeSession(sessionId)
        },
        handoffSession: async (checkpoint: BrowserNativeExecutionHandoffCheckpoint, handoffId: string) => {
          const lease = workspaceRuntime.getWriterLease()
          if (lease === undefined) throw new Error('Workspace writer lease is unavailable')
          const response = await fetch('/api/browser-native/session/handoff', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              protocolVersion: 1,
              requestId: crypto.randomUUID(),
              sessionId,
              ownerToken,
              ownerEpoch,
              handoffId,
              checkpoint: {
                sessionId: checkpoint.sessionId,
                ownerId: checkpoint.ownerId,
                epoch: checkpoint.ownerEpoch,
                nextSessionSeq: checkpoint.nextSessionSeq,
                durableThroughSeq: checkpoint.durableThroughSeq,
                workspaceId: checkpoint.workspaceId,
                workspaceRevision: checkpoint.workspaceRevision,
                workspaceFencingToken: checkpoint.workspaceFencingToken,
                pendingWorkspaceReceipts: checkpoint.pendingWorkspaceReceipts,
                pendingSessionEvents: checkpoint.pendingSessionEvents,
                pendingOperationIds: checkpoint.pendingOperationIds,
                pendingExecutionIds: checkpoint.pendingExecutionIds,
              },
              workspaceWriterToken: lease.writerToken,
            }),
          })
          const value: unknown = await response.json()
          if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Session handoff returned an invalid response')
          }
          const result = value as Record<string, unknown>
          if (!response.ok) {
            const detail = result.error !== null && typeof result.error === 'object' && !Array.isArray(result.error)
              ? result.error as Record<string, unknown>
              : undefined
            const code = typeof detail?.code === 'string'
              ? detail.code
              : typeof result.code === 'string' ? result.code : undefined
            const message = typeof detail?.message === 'string'
              ? detail.message
              : typeof result.error === 'string' ? result.error : code ?? 'Session handoff failed'
            const error = new Error(message) as Error & {
              code?: string
              outcome?: 'rejected' | 'unknown'
            }
            error.code = code
            error.outcome = error.code === 'DURABILITY_UNKNOWN' ? 'unknown' : 'rejected'
            throw error
          }
          const next = result.owner
          if (next === null || typeof next !== 'object' || typeof next.ownerToken !== 'string'
            || !Number.isSafeInteger(next.ownerEpoch)) {
            const error = new Error('Session handoff response did not include a new owner') as Error & { outcome?: 'unknown' }
            error.outcome = 'unknown'
            throw error
          }
          return { ownerToken: next.ownerToken, ownerEpoch: Number(next.ownerEpoch) }
        },
        releaseWorkspace: async () => await workspaceRuntime.releaseWriter(),
        classifySessionHandoffError: error => error !== null && typeof error === 'object'
          && 'outcome' in error && error.outcome === 'rejected' ? 'rejected' : 'unknown',
      })
      workspaceTestResponse(request.requestId, { ok: true, executionHandoff: handoff })
      if (request.terminateAfter === true) setTimeout(() => self.close(), 0)
      return
    }
    if (request.action === 'flush-local') {
      await workspaceRuntime.flushLocalWorkspace()
      workspaceTestResponse(request.requestId, { ok: true })
      return
    }
    if (request.action === 'flush-workspace') {
      const receipts = await workspaceRuntime.flushWorkspace()
      workspaceTestResponse(request.requestId, { ok: true, receipts })
      return
    }
    if (request.action === 'lease-info') {
      const lease = workspaceRuntime.getWriterLease()
      workspaceTestResponse(request.requestId, {
        ok: lease !== undefined,
        ...lease,
        ...workspaceRuntime.getWriterLeaseTestState(),
        accessMode: workspaceRuntime.getAccessMode(),
      })
      return
    }
    if (request.action === 'lease-timer-probe') {
      await new Promise(resolveTimer => { setTimeout(resolveTimer, 100) })
      workspaceTestResponse(request.requestId, { ok: true })
      return
    }
    if (request.action === 'release-lease') {
      await workspaceRuntime.releaseWriter()
      workspaceTestResponse(request.requestId, { ok: true })
      return
    }
    if (request.action === 'abort-next-metadata-transaction') {
      abortMetadataTransactionsRemaining = 1
      workspaceTestResponse(request.requestId, { ok: true })
      return
    }
    if (request.action === 'abort-metadata-transactions') {
      abortMetadataTransactionsRemaining = request.count ?? 0
      workspaceTestResponse(request.requestId, { ok: true })
      return
    }
    if (request.action === 'quota-next-opfs-write') {
      quotaNextOpfsWrite = true
      workspaceTestResponse(request.requestId, { ok: true })
      return
    }
    if (request.action === 'set-file-tool-delay') {
      fileToolYieldDelayMs = request.delayMs ?? 0
      workspaceTestResponse(request.requestId, { ok: true, delayMs: fileToolYieldDelayMs })
      return
    }
    if (request.action === 'wait-file-tool-stage') {
      const observed = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => {
          fileToolStageWaiters.delete(request.requestId)
          resolve(false)
        }, request.timeoutMs ?? 45_000)
        fileToolStageWaiters.set(request.requestId, {
          stage: request.toolStage!,
          resolve,
          timer,
        })
      })
      workspaceTestResponse(request.requestId, { ok: observed, stage: request.toolStage })
      return
    }
    if (request.action === 'cancel-file-search') {
      const controller = new AbortController()
      let matcherStartedResolve: (() => void) | undefined
      const matcherStarted = new Promise<void>(resolve => { matcherStartedResolve = resolve })
      const search = executeBrowserNativeGrep(
        workspaceRuntime.vfs,
        { pattern: request.pattern ?? request.marker, path: request.path },
        controller.signal,
        fileToolYieldDelayMs,
        { onMatcherStarted: () => { matcherStartedResolve?.() } },
      )
      if (request.pattern !== undefined) {
        await matcherStarted
        controller.abort()
      } else {
        setTimeout(() => { controller.abort() }, request.delayMs ?? 0)
      }
      const result = await search
      workspaceTestResponse(request.requestId, { ok: true, canceled: result.matches.length === 0 })
      return
    }
    if (request.action === 'pause-local-save') {
      if (localPersistBarrier !== undefined || localPersistReached !== undefined) {
        throw new Error('browser-native workspace test: a local save barrier is already armed')
      }
      localPersistBarrier = request.stage
      workspaceTestResponse(request.requestId, { ok: true })
      return
    }
    if (request.action === 'local-save-state') {
      workspaceTestResponse(request.requestId, { ok: true, stage: localPersistReached ?? 'idle' })
      return
    }
    if (request.action === 'release-local-save') {
      releaseLocalPersist?.()
      workspaceTestResponse(request.requestId, { ok: true })
      return
    }
    if (request.action === 'close-vfs') {
      workspaceRuntime.vfs.close()
      workspaceTestResponse(request.requestId, { ok: true })
      return
    }
    if (request.action === 'usage') {
      const usage = workspaceRuntime.vfs.usage()
      workspaceTestResponse(request.requestId, { ok: true, ...usage, logicalBytes: usage.bytes })
      return
    }
    if (request.action === 'file-tool-metrics') {
      workspaceTestResponse(request.requestId, { ok: true, metrics: fileToolMetrics.splice(0) })
      return
    }
    if (request.action === 'load-lazy-client-chunk') {
      const path = '/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js'
      if (request.path !== path) throw new Error('browser-native workspace test: lazy path is not in the approved probe list')
      const content = await workspaceRuntime.vfs.promises.readFile(path, 'utf8')
      if (typeof content !== 'string') throw new Error('browser-native workspace test: lazy chunk did not decode as text')
      workspaceTestResponse(request.requestId, {
        ok: true,
        path,
        bytes: new TextEncoder().encode(content).byteLength,
        digest: await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)).then(value =>
          [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('')),
      })
      return
    }
    if (request.action === 'rename') {
      if (typeof request.from !== 'string' || typeof request.to !== 'string') throw new Error('browser-native workspace test: rename paths are required')
      if (!request.from.startsWith('/dsh/home/workspace/') || !request.to.startsWith('/dsh/home/workspace/')) throw new Error('browser-native workspace test: rename paths must be inside the Workspace')
      workspaceRuntime.vfs.renameSync(request.from, request.to)
      await workspaceRuntime.flushLocalWorkspace()
      workspaceTestResponse(request.requestId, { ok: true, from: request.from, to: request.to })
      return
    }
    if (typeof request.path !== 'string' || !request.path.startsWith('/dsh/home/workspace/')) {
      throw new Error('browser-native workspace test: path must be inside the Workspace')
    }
    if (request.action === 'write') {
      if (typeof request.content !== 'string') throw new Error('browser-native workspace test: content is required')
      workspaceRuntime.vfs.writeFileSync(request.path, request.content)
      await workspaceRuntime.flushLocalWorkspace()
      workspaceTestResponse(request.requestId, { ok: true, path: request.path, content: request.content })
      return
    }
    if (request.action === 'write-binary') {
      if (typeof request.base64 !== 'string') throw new Error('browser-native workspace test: base64 content is required')
      const binary = atob(request.base64)
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
      workspaceRuntime.vfs.writeFileSync(request.path, bytes)
      await workspaceRuntime.flushLocalWorkspace()
      workspaceTestResponse(request.requestId, { ok: true, path: request.path, bytes: bytes.byteLength })
      return
    }
    if (request.action === 'write-pattern') {
      if (!Number.isSafeInteger(request.byteLength) || request.byteLength < 0 || request.byteLength > 64 * 1024 * 1024
        || !Number.isSafeInteger(request.byteValue) || request.byteValue < 0 || request.byteValue > 255) {
        throw new Error('browser-native workspace test: byteLength or byteValue is invalid')
      }
      if (request.lineBytes !== undefined && (!Number.isSafeInteger(request.lineBytes) || request.lineBytes < 2 || request.lineBytes > 65_536)
        || request.markerLine !== undefined && (!Number.isSafeInteger(request.markerLine) || request.markerLine < 1)
        || request.marker !== undefined && typeof request.marker !== 'string') {
        throw new Error('browser-native workspace test: lineBytes, markerLine, or marker is invalid')
      }
      if (request.marker !== undefined && (request.lineBytes === undefined || request.markerLine === undefined)) {
        throw new Error('browser-native workspace test: marker requires lineBytes and markerLine')
      }
      const bytes = new Uint8Array(request.byteLength)
      bytes.fill(request.byteValue)
      if (request.lineBytes !== undefined) {
        for (let offset = request.lineBytes - 1; offset < bytes.byteLength; offset += request.lineBytes) bytes[offset] = 0x0a
      }
      if (request.marker !== undefined) {
        const marker = new TextEncoder().encode(request.marker)
        const offset = (request.markerLine! - 1) * request.lineBytes!
        if (marker.byteLength > request.lineBytes! - 1 || offset + marker.byteLength > bytes.byteLength) {
          throw new Error('browser-native workspace test: marker does not fit in the selected line')
        }
        bytes.set(marker, offset)
        bytes[offset + marker.byteLength] = 0x0a
      }
      workspaceRuntime.vfs.writeFileSync(request.path, bytes)
      await workspaceRuntime.flushLocalWorkspace()
      workspaceTestResponse(request.requestId, {
        ok: true,
        path: request.path,
        bytes: bytes.byteLength,
        digest: await crypto.subtle.digest('SHA-256', bytes).then(value =>
          [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('')),
      })
      return
    }
    if (request.action === 'read-digest') {
      const digest = hashWorkspacePath(request.path)
      workspaceTestResponse(request.requestId, {
        ok: true,
        path: request.path,
        bytes: digest.bytes,
        digest: digest.digest,
      })
      return
    }
    if (request.action === 'read-range') {
      if (!Number.isSafeInteger(request.offset) || request.offset < 0
        || !Number.isSafeInteger(request.length) || request.length < 0) {
        throw new Error('browser-native workspace test: range offset and length are required')
      }
      const descriptor = workspaceRuntime.vfs.openFileSync(request.path, 'r')
      try {
        const bytes = descriptor.read(request.offset, request.length)
        workspaceTestResponse(request.requestId, {
          ok: true,
          path: request.path,
          offset: request.offset,
          length: bytes.byteLength,
          base64: encodeBase64(bytes),
        })
      } finally {
        descriptor.close()
      }
      return
    }
    if (request.action === 'append') {
      if (typeof request.content !== 'string') throw new Error('browser-native workspace test: content is required')
      workspaceRuntime.vfs.appendFileSync(request.path, request.content)
      await workspaceRuntime.flushLocalWorkspace()
      workspaceTestResponse(request.requestId, { ok: true, path: request.path })
      return
    }
    if (request.action === 'mkdir') {
      workspaceRuntime.vfs.mkdirSync(request.path, { recursive: true, mode: request.mode })
      await workspaceRuntime.flushLocalWorkspace()
      workspaceTestResponse(request.requestId, { ok: true, path: request.path })
      return
    }
    if (request.action === 'remove') {
      workspaceRuntime.vfs.rmSync(request.path, { recursive: true, force: true })
      await workspaceRuntime.flushLocalWorkspace()
      workspaceTestResponse(request.requestId, { ok: true, path: request.path })
      return
    }
    if (request.action === 'chmod') {
      if (!Number.isSafeInteger(request.mode)) throw new Error('browser-native workspace test: mode is required')
      workspaceRuntime.vfs.chmodSync(request.path, request.mode)
      await workspaceRuntime.flushLocalWorkspace()
      workspaceTestResponse(request.requestId, { ok: true, path: request.path, mode: request.mode })
      return
    }
    if (request.action === 'stat') {
      const stats = workspaceRuntime.vfs.statSync(request.path)
      workspaceTestResponse(request.requestId, { ok: true, path: request.path, kind: stats.isDirectory() ? 'directory' : 'file', mode: stats.mode, bytes: stats.size })
      return
    }
    if (request.action === 'list') {
      workspaceTestResponse(request.requestId, { ok: true, path: request.path, entries: workspaceRuntime.vfs.readdirSync(request.path) })
      return
    }
    const content = workspaceRuntime.vfs.readFileSync(request.path, { encoding: 'utf8' })
    workspaceTestResponse(request.requestId, { ok: true, path: request.path, content })
  } catch (error) {
    workspaceTestResponse(request.requestId, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as Record<string, unknown> | null
  if (data?.type === 'browser-native-workspace-test-init') {
    const port = event.ports[0]
    if (port === undefined) throw new Error('browser-native workspace test: init frame needs a MessagePort')
    if (data.downloadPauseStage !== undefined && data.downloadPauseStage !== 'intent-durable'
      && data.downloadPauseStage !== 'entry-created' && data.downloadPauseStage !== 'first-chunk-written'
      && data.downloadPauseStage !== 'published') {
      throw new Error('browser-native workspace test: invalid download pause stage')
    }
    downloadPauseStage = data.downloadPauseStage
    if (data.skillFilesystem === true) capabilityPublication.enableSkillFilesystemValidation()
    workspaceTestPort?.close()
    workspaceTestPort = port
    workspaceTestPort.start()
    return
  }
  if (isRuntimeProbeRequest(data)) {
    const port = event.ports[0]
    if (port === undefined) throw new Error('browser-native worker: runtime probe needs a MessagePort')
    void handleRuntimeProbe(data, port).catch(() => {
      const report = failedProbeReport('backend', 'BACKEND_UNAVAILABLE')
      runtimeProbeReport = report
      runtimeProbePromise = Promise.resolve(report)
      port.postMessage({ type: 'browser-native-runtime-probe-result', requestId: data.requestId, ...report })
    })
    return
  }
  if (isWorkspaceTestRequest(data)) {
    void handleWorkspaceTestRequest(data)
    return
  }
  if (data?.type === 'browser-native-control-init') {
    const port = event.ports[0]
    if (port === undefined) throw new Error('browser-native worker: control init frame needs a MessagePort')
    setBrowserNativeControlPort(port)
    return
  }
  if (data?.type === 'browser-native-control-resume-owner') {
    if (typeof data.sessionId !== 'string' || typeof data.ownerToken !== 'string') {
      throw new Error('browser-native worker: resume owner frame needs sessionId and ownerToken')
    }
    setBrowserNativeResumeOwner(data.sessionId, data.ownerToken)
    return
  }
  if (data?.type === 'browser-native-control-resume-workspace-lease') {
    if (typeof data.workspaceId !== 'string' || typeof data.writerToken !== 'string'
      || typeof data.fencingToken !== 'number' || !Number.isSafeInteger(data.fencingToken)
      || typeof data.resumeId !== 'string') {
      throw new Error('browser-native worker: resume Workspace lease frame is invalid')
    }
    setBrowserNativeResumeWorkspaceLease({
      workspaceId: data.workspaceId,
      writerToken: data.writerToken,
      fencingToken: data.fencingToken,
      resumeId: data.resumeId,
    })
    return
  }
  if (data?.type === 'browser-native-durable-workspace-init') {
    if (host !== undefined) throw new Error('browser-native worker: durable Workspace must be selected before Host init')
    if (data.contentDefinedUpload !== undefined && typeof data.contentDefinedUpload !== 'boolean') {
      throw new Error('browser-native worker: content upload selection must be a boolean')
    }
    durableWorkspace = true
    contentDefinedUpload = data.contentDefinedUpload === true
    return
  }
  if (data?.type === 'browser-native-workspace-lease-init') {
    if (host !== undefined) throw new Error('browser-native worker: Workspace lease must be selected before Host init')
    workspaceWriterLease = true
    return
  }
  if (data?.type === 'browser-native-pagehide') {
    if (typeof data.requestId !== 'string') throw new Error('browser-native worker: pagehide request id is required')
    void (async () => {
      let localPersisted = false
      let writerReleased = false
      let error: string | undefined
      try {
        if (workspaceRuntime !== undefined) {
          await workspaceRuntime.flushLocalWorkspace()
          localPersisted = true
          await workspaceRuntime.releaseWriter()
          writerReleased = true
        } else {
          localPersisted = true
          writerReleased = true
        }
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason)
      }
      publishBrowserNativePagehideAck({
        type: 'pagehide-ack',
        requestId: data.requestId,
        localPersisted,
        writerReleased,
        ...(error === undefined ? {} : { error }),
      })
    })()
    return
  }
  if (host === undefined && isShellStartFrame(data)) {
    shellRole = true
    installProcessGlobal({ cwd: data.cwd, env: data.env })
    runShellProcess(data, self)
    return
  }
  if (host === undefined && data !== null && typeof data === 'object' && data.t === 'init') {
    if (runtimeProbeReport?.ok !== true) throw new Error('browser-native worker: runtime capability probes did not pass')
    if (typeof data.image !== 'string') {
      throw new Error('browser-native worker: init frame needs a string image url')
    }
    if (!Array.isArray(data.overlays) || data.overlays.some(overlay => typeof overlay !== 'string')) {
      throw new Error('browser-native worker: init frame needs an array of string overlay urls')
    }
    const preflight = evaluateBrowserNativeProfile(BROWSER_NATIVE_PROFILE_MANIFEST)
    if (!preflight.ok) throw new Error(formatBrowserNativePreflightFailure(preflight))
    const workspace = createBrowserNativeWorkspaceRuntime({
      durable: durableWorkspace,
      contentDefinedUpload,
      writerLease: workspaceWriterLease,
      onAccessMode: mode => {
        if (mode === 'observer') capabilityPublication.setWorkspaceReadOnly()
        else if (mode === 'stale') capabilityPublication.markWorkspaceStale()
      },
      ...(workspaceTestPort === undefined ? {} : {
        testHooks: {
          downloadStage: async stage => {
            if (stage !== downloadPauseStage) return
            downloadPauseStage = undefined
            self.postMessage({ type: 'browser-native-workspace-test-download-paused', stage })
            await new Promise<void>(() => {})
          },
          abortNextMetadataTransaction: () => {
            if (abortMetadataTransactionsRemaining === 0) return false
            abortMetadataTransactionsRemaining -= 1
            return true
          },
          quotaNextOpfsWrite: () => {
            if (!quotaNextOpfsWrite) return false
            quotaNextOpfsWrite = false
            return true
          },
          beforeLocalPersist: async () => await pauseLocalPersist('before'),
          afterLocalPersist: async () => await pauseLocalPersist('after'),
          fileToolYieldDelayMs: () => fileToolYieldDelayMs,
          onFileToolStage: stage => reportFileToolStage(stage),
          onFileToolMetrics: metrics => fileToolMetrics.push(metrics),
        },
      }),
    })
    workspaceRuntime = workspace
    const nodeBuiltins = createNodeBuiltins()
    builtinMemberTrace = workspaceTestPort === undefined ? undefined : createBrowserNativeBuiltinMemberTrace()
    const created = createWorkerHost({
      staticModules: {
        ...nodeBuiltins,
        ...createBrowserNativeStaticModules(
          workspace,
          sessionOutbox,
          capabilityPublication,
          workspaceTestPort === undefined ? undefined : {
            afterOpfsStagingWrite: (bytesWritten, signal) => pauseAttachmentOpfsStagingWrite(bytesWritten, signal),
            onModuleReady: module => { reconcileAttachmentTemporaryFilesForTest = module.reconcileTemporaryFiles },
          },
          permissionProbe,
        ),
      },
      staticModulePrefixes: REPLACED_PREFIXES,
      requestListener: whenRequestListener,
      alsCausality,
      image: data.image,
      overlays: data.overlays as string[],
      vfs: workspace.vfs,
      prepareVfs: workspace.prepareVfs,
      ...(workspaceTestPort === undefined ? {} : { moduleTraceCapacity: 50_000 }),
      ...(builtinMemberTrace === undefined
        ? {}
        : { onNodeBuiltinMemberCall: (specifier, member) => builtinMemberTrace?.record(specifier, member) }),
    })
    host = created
    for (const queued of pending) {
      runAtAsyncContextRoot(() => { created.handleMessage(queued) })
    }
    pending.length = 0
    created.start().catch(error => {
      console.error('browser-native dsh: Worker Host startup failed', error)
    })
    return
  }
  if (host === undefined) {
    if (shellRole) return
    pending.push(event.data)
    return
  }
  const ready = host
  runAtAsyncContextRoot(() => { ready.handleMessage(event.data) })
})
