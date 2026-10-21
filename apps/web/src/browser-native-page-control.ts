import { browserNativeWorkspaceStatusCopy } from './locales/browser-native-workspace.ts'

const OWNER_STORAGE_PREFIX = 'dsh.browser-native.owner.'
const WORKSPACE_LEASE_STORAGE_PREFIX = 'dsh.browser-native.workspace-lease.'

interface BrowserNativeOwnerNotice {
  readonly type: 'owner' | 'released' | 'unavailable'
  readonly sessionId: string
  readonly ownerToken?: string
}

interface BrowserNativeWorkspaceStatus {
  readonly type: 'workspace'
  readonly state: 'loading' | 'synced' | 'dirty' | 'syncing' | 'error' | 'conflict' | 'local-corrupt'
  readonly workspaceId?: string
  readonly revision?: number
  readonly dirtyCount: number
  readonly message?: string
}

interface BrowserNativeWorkspaceLease {
  readonly type: 'workspace-lease'
  readonly workspaceId: string
  readonly writerToken: string
  readonly fencingToken: number
  readonly resumeId?: string
}

interface BrowserNativeWorkspaceLeaseReleased {
  readonly type: 'workspace-lease-released'
  readonly workspaceId: string
}

type BrowserNativePageNotice = BrowserNativeOwnerNotice | BrowserNativeWorkspaceStatus
  | BrowserNativeWorkspaceLease | BrowserNativeWorkspaceLeaseReleased

declare global {
  interface Window {
    __DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?: BrowserNativeWorkspaceStatus
  }
}

/**
 * Keep the browser-native Session write lease across a normal page reload.
 * @param worker - Dedicated Worker receiving the Browser-Native DSH Host.
 * @returns A function that detaches page listeners and closes the page-side port.
 */
export function connectBrowserNativePageControl(worker: Worker): () => void {
  const channel = new MessageChannel()
  const owners = new Map<string, string>()
  const storageKey = (sessionId: string): string => `${OWNER_STORAGE_PREFIX}${encodeURIComponent(sessionId)}`
  let workspaceStatus: HTMLElement | undefined
  const showWorkspaceStatus = (notice: BrowserNativeWorkspaceStatus): void => {
    workspaceStatus ??= (() => {
      const element = document.createElement('output')
      element.setAttribute('aria-live', 'polite')
      element.setAttribute('data-browser-native-workspace-status', '')
      Object.assign(element.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483000',
        maxWidth: 'min(440px, calc(100vw - 32px))',
        padding: '9px 13px',
        border: '1px solid #526174',
        borderRadius: '10px',
        background: '#111827',
        color: '#f9fafb',
        boxShadow: '0 8px 28px rgb(0 0 0 / 28%)',
        font: '500 13px/1.4 system-ui, sans-serif',
      })
      document.body.append(element)
      return element
    })()
    workspaceStatus.textContent = browserNativeWorkspaceStatusCopy(
      notice.state,
      document.documentElement.lang,
      notice.revision,
      notice.dirtyCount,
      notice.message,
    )
    workspaceStatus.dataset.state = notice.state
    workspaceStatus.style.borderColor = notice.state === 'error' || notice.state === 'conflict' || notice.state === 'local-corrupt' ? '#f87171'
      : notice.state === 'synced' ? '#34d399' : '#fbbf24'
  }
  channel.port1.addEventListener('message', (event: MessageEvent<BrowserNativePageNotice>) => {
    const notice = event.data
    if (notice.type === 'workspace') {
      window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__ = notice
      showWorkspaceStatus(notice)
      window.dispatchEvent(new CustomEvent('dsh-browser-native-workspace-status', { detail: notice }))
      return
    }
    if (notice.type === 'workspace-lease' && typeof notice.workspaceId === 'string'
      && typeof notice.writerToken === 'string' && Number.isSafeInteger(notice.fencingToken)) {
      window.sessionStorage.setItem(
        `${WORKSPACE_LEASE_STORAGE_PREFIX}${encodeURIComponent(notice.workspaceId)}`,
        JSON.stringify({
          workspaceId: notice.workspaceId,
          writerToken: notice.writerToken,
          fencingToken: notice.fencingToken,
          resumeId: globalThis.crypto.randomUUID(),
        }),
      )
      return
    }
    if (notice.type === 'workspace-lease-released' && typeof notice.workspaceId === 'string') {
      window.sessionStorage.removeItem(`${WORKSPACE_LEASE_STORAGE_PREFIX}${encodeURIComponent(notice.workspaceId)}`)
      return
    }
    if (notice.type === 'owner') {
      if (typeof notice.ownerToken === 'string') {
        owners.set(notice.sessionId, notice.ownerToken)
        window.sessionStorage.setItem(storageKey(notice.sessionId), notice.ownerToken)
      }
      return
    }
    if (notice.type === 'released' || notice.type === 'unavailable') {
      owners.delete(notice.sessionId)
      window.sessionStorage.removeItem(storageKey(notice.sessionId))
    }
  })
  channel.port1.start()
  worker.postMessage({ type: 'browser-native-control-init' }, [channel.port2])

  const storedKeys = Array.from({ length: window.sessionStorage.length }, (_, index) => window.sessionStorage.key(index))
  for (const key of storedKeys) {
    if (key !== null && key.startsWith(WORKSPACE_LEASE_STORAGE_PREFIX)) {
      const rawLease = window.sessionStorage.getItem(key)
      try {
        const lease: unknown = rawLease === null ? undefined : JSON.parse(rawLease)
        if (lease !== null && typeof lease === 'object'
          && 'workspaceId' in lease && typeof lease.workspaceId === 'string'
          && 'writerToken' in lease && typeof lease.writerToken === 'string'
          && key === `${WORKSPACE_LEASE_STORAGE_PREFIX}${encodeURIComponent(lease.workspaceId)}`
          && 'fencingToken' in lease && Number.isSafeInteger(lease.fencingToken)) {
          const resumeId = 'resumeId' in lease && typeof lease.resumeId === 'string'
            && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lease.resumeId)
            ? lease.resumeId
            : globalThis.crypto.randomUUID()
          window.sessionStorage.setItem(key, JSON.stringify({
            workspaceId: lease.workspaceId,
            writerToken: lease.writerToken,
            fencingToken: lease.fencingToken,
            resumeId,
          }))
          worker.postMessage({
            type: 'browser-native-control-resume-workspace-lease',
            workspaceId: lease.workspaceId,
            writerToken: lease.writerToken,
            fencingToken: lease.fencingToken,
            resumeId,
          })
        } else {
          window.sessionStorage.removeItem(key)
        }
      } catch {
        window.sessionStorage.removeItem(key)
      }
      continue
    }
    if (key === null || !key.startsWith(OWNER_STORAGE_PREFIX)) continue
    const ownerToken = window.sessionStorage.getItem(key)
    if (ownerToken === null) continue
    const sessionId = decodeURIComponent(key.slice(OWNER_STORAGE_PREFIX.length))
    worker.postMessage({ type: 'browser-native-control-resume-owner', sessionId, ownerToken })
  }

  const handlePageHide = (event: PageTransitionEvent): void => {
    if (event.persisted) return
    for (const [sessionId, ownerToken] of owners) {
      const body = JSON.stringify({
        protocolVersion: 1,
        requestId: globalThis.crypto.randomUUID(),
        sessionId,
        ownerToken,
      })
      const payload = new Blob([body], { type: 'application/json' })
      if (navigator.sendBeacon('/api/browser-native/session/close', payload)) continue
      void fetch('/api/browser-native/session/close', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-browser-native-protocol': '1' },
        body,
        keepalive: true,
      }).catch((error: unknown) => { console.warn('browser-native DSH: page unload could not release Session write access', error) })
    }
  }
  window.addEventListener('pagehide', handlePageHide)

  return () => {
    window.removeEventListener('pagehide', handlePageHide)
    channel.port1.close()
    workspaceStatus?.remove()
  }
}
