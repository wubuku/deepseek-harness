import { Context } from '@deepseek-ai/cordis'
import { bootClient } from '@deepseek-ai/dsh-client-web/src/boot-client.ts'
import { getStaticModules } from '@deepseek-ai/dsh-client-web'
import type { ClientModuleLoaderTarget, DshWindow } from '@deepseek-ai/dsh-client-modules/client'
import type { ISessions, SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { connectWorkerHost } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
import DshWorker from './browser-native-worker.ts?worker'
import browserNativeProfileOverlay from '../profile-overlay/copilotkit-profile-overlay.tar.gz?url'
import type { BrowserNativeOwnerNotice } from '../../browser-native-dsh-poc/browser-native-control'
import type {
  BrowserNativeFrontendToolCancel,
  BrowserNativeFrontendToolRequest,
  BrowserNativeFrontendToolResponse,
} from './browser-native-control.ts'

const SESSION_STORAGE_KEY = 'dsh-copilotkit-browser-native-session'
const OWNER_TOKEN_STORAGE_PREFIX = 'dsh-copilotkit-browser-native-owner:'
const DEFAULT_CWD = '/dsh/home/'
const DISABLED_WEB_UI_ENTRIES = new Set([
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-deliverables',
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-goal',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-subagent',
  '@deepseek-ai/dsh-client-ui-trajectory',
  '@deepseek-ai/dsh-client-ui-user-questions',
  '@deepseek-ai/dsh-client-ui-workflow-run',
  '@deepseek-ai/dsh-client-ui-workspace',
])

export interface BrowserNativeDshClient {
  readonly binding: SessionBinding
  readonly reference: SessionReference
  readonly sessions: ISessions
  readonly context: Context
  readonly worker: Worker
  readonly frontendTools: BrowserNativeFrontendToolBridge
  ownershipError(): string | undefined
  subscribeOwnership(listener: () => void): () => void
  closeOwnershipOnPageHide(): void
  startNewSession(): void
  dispose(): Promise<void>
}

export interface BrowserNativeFrontendToolInvocation {
  readonly requestId: string
  readonly sessionId: string
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
}

export type BrowserNativeFrontendToolHandler = (
  argumentsValue: unknown,
  invocation: BrowserNativeFrontendToolInvocation,
) => Promise<unknown> | unknown

interface PendingFrontendInvocation {
  readonly invocation: BrowserNativeFrontendToolInvocation
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
}

export class BrowserNativeFrontendToolBridge {
  private readonly handlers = new Map<string, BrowserNativeFrontendToolHandler>()
  private readonly pending = new Map<string, PendingFrontendInvocation>()

  constructor(private readonly port: MessagePort) {}

  register(name: string, handler: BrowserNativeFrontendToolHandler): () => void {
    this.handlers.set(name, handler)
    return () => {
      if (this.handlers.get(name) === handler) this.handlers.delete(name)
    }
  }

  handleRequest(request: BrowserNativeFrontendToolRequest): void {
    const handler = this.handlers.get(request.name)
    if (handler === undefined) {
      this.respond(request.requestId, false, undefined, `No page handler is registered for ${request.name}`)
      return
    }
    const invocation: BrowserNativeFrontendToolInvocation = request
    const operation = new Promise<unknown>((resolve, reject) => {
      this.pending.set(request.callId, { invocation, resolve, reject })
    })
    void operation.then(
      result => this.respond(request.requestId, true, result),
      error => this.respond(request.requestId, false, undefined, error instanceof Error ? error.message : String(error)),
    ).finally(() => {
      const current = this.pending.get(request.callId)
      if (current?.invocation.requestId === request.requestId) this.pending.delete(request.callId)
    })
    Promise.resolve(handler(request.arguments, invocation)).then(
      result => this.resolve(request.callId, result),
      error => this.reject(request.callId, error),
    )
  }

  resolve(callId: string, result: unknown): boolean {
    const pending = this.pending.get(callId)
    if (pending === undefined) return false
    pending.resolve(result)
    return true
  }

  reject(callId: string, error: unknown): boolean {
    const pending = this.pending.get(callId)
    if (pending === undefined) return false
    pending.reject(error)
    return true
  }

  resolveLatest(name: string, sessionId: string, result: unknown): boolean {
    const pending = [...this.pending.values()].find(item =>
      item.invocation.name === name && item.invocation.sessionId === sessionId,
    )
    return pending === undefined ? false : this.resolve(pending.invocation.callId, result)
  }

  rejectLatest(name: string, sessionId: string, error: unknown): boolean {
    const pending = [...this.pending.values()].find(item =>
      item.invocation.name === name && item.invocation.sessionId === sessionId,
    )
    return pending === undefined ? false : this.reject(pending.invocation.callId, error)
  }

  cancel(request: BrowserNativeFrontendToolCancel): boolean {
    return this.reject(request.callId, new Error('The user cancelled the frontend interaction'))
  }

  private respond(requestId: string, ok: boolean, result?: unknown, error?: string): void {
    const response: BrowserNativeFrontendToolResponse = {
      type: 'browser-native-frontend-tool-response',
      requestId,
      ok,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    }
    this.port.postMessage(response)
  }
}

function moduleLoaderTarget(): ClientModuleLoaderTarget {
  const target = (globalThis as DshWindow).__ModuleLoader__
  if (target === undefined) throw new Error('CopilotKit PoC: client module loader is missing')
  return target
}

function bootValue(): unknown {
  const boot = (globalThis as DshWindow).__DSH_BOOT__
  if (boot === undefined) throw new Error('CopilotKit PoC: DSH boot graph is missing')
  return boot
}

function storedSessionId(): string | undefined {
  const query = new URLSearchParams(window.location.search).get('sessionId')
  if (query !== null && query.length > 0) return query
  const stored = window.sessionStorage.getItem(SESSION_STORAGE_KEY)
  return stored === null || stored.length === 0 ? undefined : stored
}

function rememberSessionId(sessionId: string): void {
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId)
  const url = new URL(window.location.href)
  url.searchParams.set('sessionId', sessionId)
  window.history.replaceState(null, '', url)
}

function ownerTokenStorageKey(sessionId: string): string {
  return `${OWNER_TOKEN_STORAGE_PREFIX}${sessionId}`
}

function storedOwnerToken(sessionId: string): string | undefined {
  const token = window.sessionStorage.getItem(ownerTokenStorageKey(sessionId))
  return token === null || token.length === 0 ? undefined : token
}

function clearStoredOwnerToken(sessionId: string): void {
  window.sessionStorage.removeItem(ownerTokenStorageKey(sessionId))
}

async function refreshUntilReady(sessions: ISessions): Promise<void> {
  let snapshot = sessions.list.getSnapshot()
  for (let attempt = 0; attempt < 8 && snapshot.phase !== 'ready'; attempt += 1) {
    await sessions.refresh()
    snapshot = sessions.list.getSnapshot()
  }
  if (snapshot.phase !== 'ready') {
    throw new Error('CopilotKit PoC: Session list did not reach ready state')
  }
}

async function openSession(sessions: ISessions): Promise<SessionReference> {
  await refreshUntilReady(sessions)
  const rememberedId = storedSessionId()
  const list = sessions.list.getSnapshot()
  let sessionId = rememberedId
  if (sessionId === undefined || list.byId[sessionId] === undefined) {
    sessionId = String(await sessions.create({ cwd: DEFAULT_CWD }))
  }
  rememberSessionId(sessionId)
  const reference = sessions.retain(sessionId, { source: 'controllerOperation' })
  await reference.ready
  return reference
}

export async function bootBrowserNativeDshClient(): Promise<BrowserNativeDshClient> {
  const worker = new DshWorker({ name: 'copilotkit-dsh-host' })
  const controlChannel = new MessageChannel()
  const frontendTools = new BrowserNativeFrontendToolBridge(controlChannel.port2)
  const ownerTokens = new Map<string, string>()
  const ownershipErrors = new Map<string, string>()
  const ownershipListeners = new Set<() => void>()
  const rememberedSessionId = storedSessionId()
  const rememberedOwnerToken = rememberedSessionId === undefined ? undefined : storedOwnerToken(rememberedSessionId)
  controlChannel.port2.addEventListener('message', (event: MessageEvent<BrowserNativeOwnerNotice | BrowserNativeFrontendToolRequest | BrowserNativeFrontendToolCancel>) => {
    if (event.data.type === 'browser-native-frontend-tool-request') {
      frontendTools.handleRequest(event.data)
    } else if (event.data.type === 'browser-native-frontend-tool-cancel') {
      frontendTools.cancel(event.data)
    } else if (event.data.type === 'owner' && event.data.ownerToken !== undefined) {
      ownerTokens.set(event.data.sessionId, event.data.ownerToken)
      window.sessionStorage.setItem(ownerTokenStorageKey(event.data.sessionId), event.data.ownerToken)
      ownershipErrors.delete(event.data.sessionId)
      for (const listener of ownershipListeners) listener()
    } else if (event.data.type === 'released') {
      ownerTokens.delete(event.data.sessionId)
      clearStoredOwnerToken(event.data.sessionId)
      ownershipErrors.delete(event.data.sessionId)
      for (const listener of ownershipListeners) listener()
    } else {
      ownerTokens.delete(event.data.sessionId)
      ownershipErrors.set(event.data.sessionId, event.data.message ?? 'Session write access has closed. Reconnect before sending.')
      for (const listener of ownershipListeners) listener()
    }
  })
  controlChannel.port2.start()
  worker.postMessage({ type: 'browser-native-control-init' }, [controlChannel.port1])
  if (rememberedSessionId !== undefined && rememberedOwnerToken !== undefined) {
    worker.postMessage({
      type: 'browser-native-control-resume-owner',
      sessionId: rememberedSessionId,
      ownerToken: rememberedOwnerToken,
    })
  }
  const closeOwnershipOnPageHide = (): void => {
    for (const [sessionId, ownerToken] of ownerTokens) {
      const body = JSON.stringify({ protocolVersion: 1, requestId: globalThis.crypto.randomUUID(), sessionId, ownerToken })
      const payload = new Blob([body], { type: 'application/json' })
      if (navigator.sendBeacon('/api/browser-native/session/close', payload)) continue
      void fetch('/api/browser-native/session/close', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-browser-native-protocol': '1' },
        body,
        keepalive: true,
      }).catch(error => { console.warn('CopilotKit PoC: page unload could not release Session write access', error) })
    }
  }
  const handlePageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) closeOwnershipOnPageHide()
  }
  window.addEventListener('pagehide', handlePageHide)
  try {
    const connection = await connectWorkerHost(worker, {
      image: new URL('/preview/vfs-image.tar.gz', document.baseURI),
      overlays: [new URL(browserNativeProfileOverlay, document.baseURI)],
    })
    const modules = moduleLoaderTarget().create({
      boot: bootValue(),
      staticModules: getStaticModules(),
      loadBundle: connection.loadBundle,
    })
    const manifest = {
      ...modules.manifest,
      plugins: modules.manifest.plugins.filter(plugin => !DISABLED_WEB_UI_ENTRIES.has(plugin.id)),
    }
    const context = new Context()
    await bootClient({ ctx: context, modules, manifest })
    const sessions = context.get('sessions') as ISessions | undefined
    if (sessions === undefined) throw new Error('CopilotKit PoC: Session Controller did not activate')
    const reference = await openSession(sessions)
    return {
      binding: reference.binding,
      reference,
      sessions,
      context,
      worker,
      frontendTools,
      ownershipError(): string | undefined {
        return ownershipErrors.get(String(reference.binding.sessionId))
      },
      subscribeOwnership(listener: () => void): () => void {
        ownershipListeners.add(listener)
        return () => ownershipListeners.delete(listener)
      },
      closeOwnershipOnPageHide,
      startNewSession(): void {
        const sessionId = storedSessionId()
        if (sessionId !== undefined) clearStoredOwnerToken(sessionId)
        window.sessionStorage.removeItem(SESSION_STORAGE_KEY)
        const url = new URL(window.location.href)
        url.searchParams.delete('sessionId')
        window.location.assign(url)
      },
      async dispose(): Promise<void> {
        window.removeEventListener('pagehide', handlePageHide)
        reference.release()
        try {
          await context.fiber.dispose()
        } finally {
          controlChannel.port2.close()
          ownershipListeners.clear()
          worker.terminate()
        }
      },
    }
  } catch (error) {
    window.removeEventListener('pagehide', handlePageHide)
    closeOwnershipOnPageHide()
    controlChannel.port2.close()
    ownershipListeners.clear()
    worker.terminate()
    throw error
  }
}
