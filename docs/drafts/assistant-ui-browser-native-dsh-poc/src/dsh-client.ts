import { Context } from '@deepseek-ai/cordis'
import { bootClient } from '@deepseek-ai/dsh-client-web/src/boot-client.ts'
import { getStaticModules } from '@deepseek-ai/dsh-client-web'
import type { ClientModuleLoaderTarget, DshWindow } from '@deepseek-ai/dsh-client-modules/client'
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { connectWorkerHost } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
import DshWorker from './browser-native-worker.ts?worker'
import browserNativeProfileOverlay from '../../browser-native-dsh-poc/browser-native-profile-overlay.tar.gz?url'
import { DshSessionAdapter } from './dsh-session-adapter'
import type { BrowserNativeOwnerNotice } from '../../browser-native-dsh-poc/browser-native-control'

const SESSION_STORAGE_KEY = 'dsh-assistant-ui-browser-native-session'
const OWNER_TOKEN_STORAGE_PREFIX = 'dsh-assistant-ui-browser-native-owner:'
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
  readonly adapter: DshSessionAdapter
  readonly reference: SessionReference
  readonly sessions: ISessions
  readonly context: Context
  readonly worker: Worker
  closeOwnershipOnPageHide(): void
  startNewSession(): void
  dispose(): Promise<void>
}

function moduleLoaderTarget(): ClientModuleLoaderTarget {
  const target = (globalThis as DshWindow).__ModuleLoader__
  if (target === undefined) throw new Error('assistant-ui PoC: client module loader is missing')
  return target
}

function bootValue(): unknown {
  const boot = (globalThis as DshWindow).__DSH_BOOT__
  if (boot === undefined) throw new Error('assistant-ui PoC: DSH boot graph is missing')
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
    throw new Error('assistant-ui PoC: Session list did not reach ready state')
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
  const worker = new DshWorker({ name: 'assistant-ui-dsh-host' })
  const controlChannel = new MessageChannel()
  const ownerTokens = new Map<string, string>()
  const ownershipErrors = new Map<string, string>()
  const rememberedSessionId = storedSessionId()
  const rememberedOwnerToken = rememberedSessionId === undefined ? undefined : storedOwnerToken(rememberedSessionId)
  let adapter: DshSessionAdapter | undefined
  let selectedSessionId: string | undefined
  controlChannel.port2.addEventListener('message', (event: MessageEvent<BrowserNativeOwnerNotice>) => {
    if (event.data.type === 'owner' && event.data.ownerToken !== undefined) {
      ownerTokens.set(event.data.sessionId, event.data.ownerToken)
      window.sessionStorage.setItem(ownerTokenStorageKey(event.data.sessionId), event.data.ownerToken)
      ownershipErrors.delete(event.data.sessionId)
    } else if (event.data.type === 'released') {
      ownerTokens.delete(event.data.sessionId)
      clearStoredOwnerToken(event.data.sessionId)
      ownershipErrors.delete(event.data.sessionId)
    } else {
      ownerTokens.delete(event.data.sessionId)
      ownershipErrors.set(event.data.sessionId, event.data.message ?? 'Session write access has closed. Reconnect before sending.')
    }
    if (event.data.sessionId === selectedSessionId) adapter?.setOwnershipError(ownershipErrors.get(event.data.sessionId))
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
      }).catch(error => { console.warn('assistant-ui PoC: page unload could not release Session write access', error) })
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
    if (sessions === undefined) throw new Error('assistant-ui PoC: Session Controller did not activate')
    const reference = await openSession(sessions)
    const sessionAdapter = new DshSessionAdapter({ binding: reference.binding })
    adapter = sessionAdapter
    selectedSessionId = String(reference.binding.sessionId)
    sessionAdapter.setOwnershipError(ownershipErrors.get(selectedSessionId))
    return {
      adapter: sessionAdapter,
      reference,
      sessions,
      context,
      worker,
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
        sessionAdapter.dispose()
        reference.release()
        try {
          await context.fiber.dispose()
        } finally {
          controlChannel.port2.close()
          worker.terminate()
        }
      },
    }
  } catch (error) {
    window.removeEventListener('pagehide', handlePageHide)
    closeOwnershipOnPageHide()
    controlChannel.port2.close()
    worker.terminate()
    throw error
  }
}
