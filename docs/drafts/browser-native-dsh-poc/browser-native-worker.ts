import './symbol-dispose'

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
import { setBrowserNativeControlPort, setBrowserNativeResumeOwner } from './browser-native-control.ts'
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
let workspaceRuntime: BrowserNativeWorkspaceRuntime | undefined
let workspaceTestPort: MessagePort | undefined
const pending: unknown[] = []

interface BrowserNativeWorkspaceTestRequest {
  readonly type: 'browser-native-workspace-test-request'
  readonly requestId: string
  readonly action: 'write' | 'read' | 'flush-local' | 'flush-workspace'
  readonly path?: string
  readonly content?: string
}

function isWorkspaceTestRequest(value: unknown): value is BrowserNativeWorkspaceTestRequest {
  if (value === null || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  return data.type === 'browser-native-workspace-test-request'
    && typeof data.requestId === 'string'
    && ['write', 'read', 'flush-local', 'flush-workspace'].includes(String(data.action))
}

function workspaceTestResponse(requestId: string, response: Record<string, unknown>): void {
  workspaceTestPort?.postMessage({ requestId, ...response })
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
      await workspaceRuntime.flushWorkspace()
      workspaceTestResponse(request.requestId, { ok: true })
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
  if (data?.type === 'browser-native-durable-workspace-init') {
    if (host !== undefined) throw new Error('browser-native worker: durable Workspace must be selected before Host init')
    durableWorkspace = true
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
    const workspace = createBrowserNativeWorkspaceRuntime({ durable: durableWorkspace })
    workspaceRuntime = workspace
    const created = createWorkerHost({
      staticModules: { ...createNodeBuiltins(), ...createBrowserNativeStaticModules() },
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
