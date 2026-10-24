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
import { createBrowserNativeStaticModules } from './browser-native-providers.ts'
import {
  setBrowserNativeControlPort,
  setBrowserNativeResumeOwner,
  setBrowserNativeResumeWorkspaceLease,
} from './browser-native-control.ts'
import {
  createBrowserNativeWorkspaceRuntime,
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
let localPersistBarrier: 'before' | 'after' | undefined
let localPersistReached: 'before' | 'after' | undefined
let releaseLocalPersist: (() => void) | undefined
const pending: unknown[] = []

interface BrowserNativeWorkspaceTestRequest {
  readonly type: 'browser-native-workspace-test-request'
  readonly requestId: string
  readonly action: 'write' | 'write-pattern' | 'append' | 'mkdir' | 'read' | 'read-digest' | 'read-range' | 'usage' | 'rename' | 'remove' | 'stat' | 'list' | 'chmod' | 'write-binary' | 'flush-local' | 'flush-workspace' | 'lease-info' | 'lease-timer-probe' | 'release-lease' | 'abort-next-metadata-transaction' | 'abort-metadata-transactions' | 'quota-next-opfs-write' | 'pause-local-save' | 'local-save-state' | 'release-local-save' | 'load-lazy-client-chunk'
  readonly stage?: 'before' | 'after'
  readonly path?: string
  readonly from?: string
  readonly to?: string
  readonly content?: string
  readonly base64?: string
  readonly byteLength?: number
  readonly byteValue?: number
  readonly offset?: number
  readonly length?: number
  readonly mode?: number
  readonly count?: number
}

function isWorkspaceTestRequest(value: unknown): value is BrowserNativeWorkspaceTestRequest {
  if (value === null || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  if (data.type !== 'browser-native-workspace-test-request' || typeof data.requestId !== 'string') return false
  if (data.action === 'abort-metadata-transactions') {
    return Number.isSafeInteger(data.count) && Number(data.count) > 0 && Number(data.count) <= 100
  }
  if (data.action === 'pause-local-save') return data.stage === 'before' || data.stage === 'after'
  return ['write', 'write-pattern', 'append', 'mkdir', 'read', 'read-digest', 'read-range', 'usage', 'rename', 'remove', 'stat', 'list', 'chmod', 'write-binary', 'flush-local', 'flush-workspace', 'lease-info', 'lease-timer-probe', 'release-lease', 'abort-next-metadata-transaction', 'quota-next-opfs-write', 'local-save-state', 'release-local-save', 'load-lazy-client-chunk'].includes(String(data.action))
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

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)))
  }
  return btoa(binary)
}

async function handleWorkspaceTestRequest(request: BrowserNativeWorkspaceTestRequest): Promise<void> {
  try {
    if (workspaceRuntime === undefined) throw new Error('browser-native workspace test: runtime is not ready')
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
      const bytes = new Uint8Array(request.byteLength)
      bytes.fill(request.byteValue)
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
      const bytes = workspaceRuntime.vfs.readFileSync(request.path)
      if (!(bytes instanceof Uint8Array)) throw new Error('browser-native workspace test: file content is not bytes')
      workspaceTestResponse(request.requestId, {
        ok: true,
        path: request.path,
        bytes: bytes.byteLength,
        digest: await crypto.subtle.digest('SHA-256', bytes).then(value =>
          [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('')),
      })
      return
    }
    if (request.action === 'read-range') {
      if (!Number.isSafeInteger(request.offset) || request.offset < 0
        || !Number.isSafeInteger(request.length) || request.length < 0) {
        throw new Error('browser-native workspace test: range offset and length are required')
      }
      const descriptor = workspaceRuntime.vfs.openFileSync(request.path, 'r')
      const bytes = descriptor.read(request.offset, request.length)
      workspaceTestResponse(request.requestId, {
        ok: true,
        path: request.path,
        offset: request.offset,
        length: bytes.byteLength,
        base64: encodeBase64(bytes),
      })
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
  if (host === undefined && isShellStartFrame(data)) {
    shellRole = true
    installProcessGlobal({ cwd: data.cwd, env: data.env })
    runShellProcess(data, self)
    return
  }
  if (host === undefined && data !== null && typeof data === 'object' && data.t === 'init') {
    if (typeof data.image !== 'string') {
      throw new Error('browser-native worker: init frame needs a string image url')
    }
    if (!Array.isArray(data.overlays) || data.overlays.some(overlay => typeof overlay !== 'string')) {
      throw new Error('browser-native worker: init frame needs an array of string overlay urls')
    }
    const workspace = createBrowserNativeWorkspaceRuntime({
      durable: durableWorkspace,
      writerLease: workspaceWriterLease,
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
        },
      }),
    })
    workspaceRuntime = workspace
    const created = createWorkerHost({
      staticModules: { ...createNodeBuiltins(), ...createBrowserNativeStaticModules(workspace) },
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
