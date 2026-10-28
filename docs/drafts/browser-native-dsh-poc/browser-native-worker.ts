import './symbol-dispose'
import './browser-native-session-events.ts'

/**
 * Browser-native PoC Worker entry.
 *
 * This entry mirrors the upstream WebWorker bootstrap while keeping the
 * Browser-Native provider injection and owner-control channel in this draft.
 */
import { createWorkerHost } from '../../../packages/experimental/webworker-runtime/src/worker-host.ts'
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
import { executeBrowserNativeGrep } from './browser-native-file-tools.ts'
import {
  createSyncAccessChunkBackedFile,
  hashChunkBackedFile,
  replaceUniqueUtf8CopyOnWrite,
  type ChunkBackedFile,
  type ChunkEditStage,
} from './browser-native-chunk-editor.ts'
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

installAsyncContextHooks()
installTimerGlobals()
installCryptoGlobals()

console.info('browser-native dsh: worker entry active')

let host: { handleMessage(data: unknown): void } | undefined
let shellRole = false
let durableWorkspace = false
let workspaceWriterLease = false
let workspaceRuntime: BrowserNativeWorkspaceRuntime | undefined
let workspaceTestPort: MessagePort | undefined
let abortMetadataTransactionsRemaining = 0
let quotaNextOpfsWrite = false
let fileToolYieldDelayMs = 0
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
  readonly action: 'write' | 'write-pattern' | 'append' | 'mkdir' | 'read' | 'read-digest' | 'read-range' | 'usage' | 'rename' | 'remove' | 'stat' | 'list' | 'chmod' | 'write-binary' | 'flush-local' | 'flush-workspace' | 'lease-info' | 'lease-timer-probe' | 'release-lease' | 'abort-next-metadata-transaction' | 'abort-metadata-transactions' | 'quota-next-opfs-write' | 'pause-local-save' | 'local-save-state' | 'release-local-save' | 'load-lazy-client-chunk' | 'close-vfs' | 'set-file-tool-delay' | 'cancel-file-search' | 'wait-file-tool-stage' | 'chunk-edit-probe' | 'reference-edit-probe' | 'session-handoff' | 'execution-handoff' | 'abort-session-outbox-appends' | 'session-outbox-probe' | 'control-inject'
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
  readonly oldText?: string
  readonly newText?: string
  readonly failStage?: ChunkEditStage
  readonly toolStage?: BrowserNativeFileToolStage
  readonly timeoutMs?: number
  readonly sessionId?: string
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
  return ['write', 'write-pattern', 'append', 'mkdir', 'read', 'read-digest', 'read-range', 'usage', 'rename', 'remove', 'stat', 'list', 'chmod', 'write-binary', 'flush-local', 'flush-workspace', 'lease-info', 'lease-timer-probe', 'release-lease', 'abort-next-metadata-transaction', 'quota-next-opfs-write', 'local-save-state', 'release-local-save', 'load-lazy-client-chunk', 'close-vfs'].includes(String(data.action))
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
    if (workspaceRuntime === undefined) throw new Error('browser-native workspace test: runtime is not ready')
    if (request.action === 'chunk-edit-probe') {
      workspaceTestResponse(request.requestId, await runChunkEditProbe(request))
      return
    }
    if (request.action === 'reference-edit-probe') {
      workspaceTestResponse(request.requestId, await runReferenceEditProbe(request))
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
    durableWorkspace = true
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
      writerLease: workspaceWriterLease,
      onAccessMode: mode => {
        if (mode === 'observer') capabilityPublication.setWorkspaceReadOnly()
        else if (mode === 'stale') capabilityPublication.markWorkspaceStale()
      },
      ...(workspaceTestPort === undefined ? {} : {
        testHooks: {
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
        },
      }),
    })
    workspaceRuntime = workspace
    const created = createWorkerHost({
      staticModules: { ...createNodeBuiltins(), ...createBrowserNativeStaticModules(workspace, sessionOutbox, capabilityPublication) },
      staticModulePrefixes: REPLACED_PREFIXES,
      requestListener: whenRequestListener,
      alsCausality,
      image: data.image,
      overlays: data.overlays as string[],
      vfs: workspace.vfs,
      prepareVfs: workspace.prepareVfs,
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
