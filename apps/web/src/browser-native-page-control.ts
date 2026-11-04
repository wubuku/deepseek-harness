import {
  browserNativeFirstUseCopy,
  browserNativeOfflineStatusCopy,
  browserNativeQueueStatusCopy,
  browserNativeRecoveryErrorCopy,
  browserNativeSessionExportCopy,
  browserNativeSessionExportResultCopy,
  browserNativeSessionRetryCopy,
  browserNativeSupportBundleCopy,
  browserNativeSupportBundleResultCopy,
  browserNativeTurnRetryCopy,
  browserNativeWorkspaceRecoveryExportCopy,
  browserNativeWorkspaceRecoveryResultCopy,
  browserNativeWorkspaceRecoveryWarningCopy,
  browserNativeWorkspaceRefreshCopy,
  browserNativeWorkspaceRetryCopy,
  browserNativeWorkspaceStatusCopy,
  browserNativeWorkspaceSwitcherCopy,
} from './locales/browser-native-workspace.ts'
import {
  BrowserNativeRecoveryLocks,
  browserNativeOwnerStorageKey,
  browserNativeWorkspaceLeaseStorageKey,
  readBrowserNativeRecoveryState,
  type BrowserNativeRecoveryResource,
} from './browser-native-recovery.ts'
import {
  BrowserNativeControlReceiver,
  type BrowserNativeControlNotice,
  type BrowserNativeOfflineStatus,
  type BrowserNativePagehideAck,
  type BrowserNativeQueueStatus,
  type BrowserNativeWorkspaceStatus,
} from './browser-native-control-channel.ts'

type BrowserNativePageNotice = BrowserNativeControlNotice

const BROWSER_NATIVE_FIRST_USE_STORAGE_KEY = 'dsh-browser-native-first-use-completed-v1'

/**
 * Design-platform tokens for the injected status surfaces. These resolve on
 * `document.body`, so a single declaration follows the light and dark themes
 * instead of pinning one palette.
 */
const browserNativeSurface = {
  fill: 'var(--dsw-alias-bg-layer-2)',
  raised: 'var(--dsw-alias-bg-layer-3)',
  label: 'var(--dsw-alias-label-primary)',
  secondary: 'var(--dsw-alias-label-secondary)',
  border: 'var(--dsw-alias-border-l3)',
  actionFill: 'var(--dsw-alias-button-primary-fill)',
  actionLabel: 'var(--dsw-alias-label-primary-foreground)',
  success: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  info: 'var(--dsw-alias-state-business-primary)',
} as const

declare global {
  interface Window {
    __DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?: BrowserNativeWorkspaceStatus
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

interface RecoveryBlob {
  readonly name: string
  readonly byteLength: number
  readonly base64: string
  readonly actualHash: string
  readonly hashMatches: boolean
}

interface WorkspaceListEntry {
  readonly workspaceId: string
  readonly revision: number
  readonly fileCount: number
  readonly active: boolean
}

interface WorkspaceSwitcherElements {
  readonly root: HTMLElement
  readonly select: HTMLSelectElement
  readonly create: HTMLButtonElement
  readonly status: HTMLElement
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(input).set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', input)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function readLocalRecoveryData(workspaceId: string, maxBytes = 64 * 1024 * 1024): Promise<Record<string, unknown>> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1')
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB open failed')) }
    request.onblocked = () => { reject(new Error('IndexedDB open was blocked')) }
  })
  let metadata: unknown
  const objectStoreNames = Array.from(database.objectStoreNames)
  try {
    if (database.objectStoreNames.contains('workspace')) {
      const transaction = database.transaction('workspace', 'readonly')
      const read = new Promise<unknown>((resolve, reject) => {
        const request = transaction.objectStore('workspace').get(workspaceId)
        request.onsuccess = () => { resolve(request.result ?? null) }
        request.onerror = () => { reject(request.error ?? new Error('Workspace metadata read failed')) }
      })
      const done = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => { resolve() }
        transaction.onerror = () => { reject(transaction.error ?? new Error('Workspace metadata transaction failed')) }
        transaction.onabort = () => { reject(transaction.error ?? new Error('Workspace metadata transaction aborted')) }
      })
      metadata = await read
      await done
    } else {
      metadata = null
    }
  } finally {
    database.close()
  }

  const blobs: RecoveryBlob[] = []
  const missingBlobs: string[] = []
  const unreadableBlobs: { readonly name: string; readonly error: string }[] = []
  let bytesRead = 0
  const root = await navigator.storage.getDirectory()
  let directory: FileSystemDirectoryHandle | undefined
  try {
    directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${workspaceId}`)
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
  }
  if (directory !== undefined) {
    for await (const [name, entry] of directory.entries()) {
      if (entry.kind !== 'file') continue
      let content: Uint8Array
      try {
        content = new Uint8Array(await (await entry.getFile()).arrayBuffer())
      } catch (error) {
        unreadableBlobs.push({ name, error: error instanceof Error ? error.message : String(error) })
        continue
      }
      bytesRead += content.byteLength
      if (bytesRead > maxBytes) throw new Error('Recovery bundle exceeds the 64 MiB export limit')
      let binary = ''
      for (let offset = 0; offset < content.length; offset += 0x8000) {
        binary += String.fromCharCode(...content.subarray(offset, offset + 0x8000))
      }
      const actualHash = await sha256Hex(content)
      blobs.push({ name, byteLength: content.byteLength, base64: btoa(binary), actualHash, hashMatches: actualHash === name })
    }
  }

  const referencedHashes = new Set<string>()
  if (isRecord(metadata)) {
    const retryBatch = isRecord(metadata.retryBatch) ? metadata.retryBatch : undefined
    for (const changes of [metadata.pending, retryBatch?.changes]) {
      if (!Array.isArray(changes)) continue
      for (const change of changes) {
        if (isRecord(change) && 'contentHash' in change
          && typeof change.contentHash === 'string' && /^[a-f0-9]{64}$/.test(change.contentHash)) {
          referencedHashes.add(change.contentHash)
        }
      }
    }
  }
  const available = new Set(blobs.map(blob => blob.name))
  for (const hash of referencedHashes) if (!available.has(hash)) missingBlobs.push(hash)
  return {
    format: 'dsh-browser-native-workspace-recovery-v1',
    exportedAt: new Date().toISOString(),
    workspaceId,
    indexedDbVersion: database.version,
    objectStoreNames,
    metadata,
    blobs,
    corruptBlobs: blobs.filter(blob => !blob.hashMatches).map(blob => ({
      name: blob.name,
      actualHash: blob.actualHash,
    })),
    missingBlobs,
    unreadableBlobs,
  }
}

async function listLocalRecoveryWorkspaceIds(): Promise<string[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1')
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB open failed')) }
    request.onblocked = () => { reject(new Error('IndexedDB open was blocked')) }
  })
  const workspaceIds = new Set<string>()
  try {
    if (database.objectStoreNames.contains('workspace')) {
      const transaction = database.transaction('workspace', 'readonly')
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = transaction.objectStore('workspace').getAllKeys()
        request.onsuccess = () => { resolve(request.result) }
        request.onerror = () => { reject(request.error ?? new Error('Workspace metadata read failed')) }
      })
      for (const key of keys) {
        if (typeof key === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
          workspaceIds.add(key)
        }
      }
    }
  } finally {
    database.close()
  }
  const root = await navigator.storage.getDirectory()
  for await (const [name, entry] of root.entries()) {
    if (entry.kind !== 'directory' || !name.startsWith('dsh-workspace-blobs-')) continue
    const workspaceId = name.slice('dsh-workspace-blobs-'.length)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) continue
    const firstChild = await entry.values().next()
    if (!firstChild.done) workspaceIds.add(workspaceId)
  }
  return [...workspaceIds].sort()
}

async function downloadLocalRecoveryBundle(workspaceId?: string): Promise<void> {
  let bundle: Record<string, unknown>
  if (workspaceId !== undefined) {
    bundle = await readLocalRecoveryData(workspaceId)
  } else {
    const workspaceIds = await listLocalRecoveryWorkspaceIds()
    if (workspaceIds.length === 0) throw new Error('No local Workspace data is available for export')
    let remainingBytes = 64 * 1024 * 1024
    const workspaces: Record<string, unknown>[] = []
    for (const id of workspaceIds) {
      const recovery = await readLocalRecoveryData(id, remainingBytes)
      const blobs: unknown[] = isUnknownArray(recovery.blobs) ? recovery.blobs : []
      const bytesRead = blobs.reduce<number>((total, blob) => isRecord(blob) && typeof blob.byteLength === 'number'
        ? total + blob.byteLength
        : total, 0)
      remainingBytes -= bytesRead
      workspaces.push(recovery)
    }
    bundle = {
      format: 'dsh-browser-native-workspace-recovery-set-v1',
      exportedAt: new Date().toISOString(),
      workspaces,
    }
  }
  const json = JSON.stringify(bundle, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)
  const objectUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  try {
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = workspaceId === undefined ? 'dsh-workspaces-recovery.json' : `dsh-workspace-recovery-${workspaceId}.json`
    link.click()
  } finally {
    window.setTimeout(() => { URL.revokeObjectURL(objectUrl) }, 30_000)
  }
}

async function downloadSessionBundle(workspaceId: string, sessionId: string): Promise<void> {
  const response = await fetch('/api/browser-native/session/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, sessionId }),
  })
  if (!response.ok) throw new Error(`Session export failed with HTTP ${response.status}`)
  const objectUrl = URL.createObjectURL(await response.blob())
  try {
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = `dsh-session-${sessionId}.json`
    link.click()
  } finally {
    window.setTimeout(() => { URL.revokeObjectURL(objectUrl) }, 30_000)
  }
}

async function downloadSupportBundle(sessionId: string): Promise<void> {
  const response = await fetch(`/api/browser-native/session/support-bundle?sessionId=${encodeURIComponent(sessionId)}`)
  if (!response.ok) throw new Error(`Support bundle failed with HTTP ${response.status}`)
  const objectUrl = URL.createObjectURL(await response.blob())
  try {
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = `dsh-support-bundle-${sessionId}.json`
    link.click()
  } finally {
    window.setTimeout(() => { URL.revokeObjectURL(objectUrl) }, 30_000)
  }
}

/**
 * Keep the browser-native Session write lease across a normal page reload.
 * @param worker - Dedicated Worker receiving the Browser-Native DSH Host.
 * @param options - Lifecycle options for the page-owned Worker.
 * @returns A promise for a disposer that detaches listeners and closes the page port. It keeps locks; detach does not stop the Worker.
 */
export async function connectBrowserNativePageControl(
  worker: Worker,
  options: { readonly durable?: boolean; readonly apiOrigin?: string } = {},
): Promise<() => void> {
  const channel = new MessageChannel()
  const receiver = new BrowserNativeControlReceiver()
  const owners = new Map<string, string>()
  const recoveryLocks = new BrowserNativeRecoveryLocks(typeof navigator.locks === 'undefined' ? undefined : navigator.locks)
  let recoveryStorage: Storage | undefined
  let workspaceId: string | undefined
  let workspaceStatus: HTMLElement | undefined
  let queueStatus: HTMLElement | undefined
  let offlineStatus: HTMLElement | undefined
  let offlineQueued = 0
  let exportControl: {
    readonly root: HTMLElement
    readonly button: HTMLButtonElement
    readonly supportButton: HTMLButtonElement
    readonly result: HTMLElement
  } | undefined
  let retryTimer: number | undefined
  const pagehideWaiters = new Map<string, (notice: BrowserNativePagehideAck) => void>()
  let failedClosed = false
  let pageLeaving = false
  let noticeQueue: Promise<void> = Promise.resolve()
  const clearRetryTimer = (): void => {
    if (retryTimer === undefined) return
    window.clearInterval(retryTimer)
    retryTimer = undefined
  }
  const styleStatusAction = (button: HTMLButtonElement, weight: '500' | '600' = '500'): void => {
    Object.assign(button.style, {
      display: 'block',
      marginTop: '8px',
      padding: '6px 10px',
      pointerEvents: 'auto',
      border: 'none',
      borderRadius: '5px',
      background: browserNativeSurface.actionFill,
      color: browserNativeSurface.actionLabel,
      cursor: 'pointer',
      font: `${weight} 13px/1.3 system-ui, sans-serif`,
    })
  }
  const isBlockingWorkspaceState = (state: BrowserNativeWorkspaceStatus['state']): boolean => state === 'error'
    || state === 'conflict' || state === 'local-corrupt' || state === 'local-newer-version'
    || state === 'recovery-conflict' || state === 'recovery-unavailable'
    || state === 'identity-missing' || state === 'identity-mismatch' || state === 'stale'
    || state === 'lease-conflict' || state === 'session-conflict'
  const applyLiveRegion = (element: HTMLElement, mode: 'status' | 'alert'): void => {
    element.setAttribute('role', mode)
    element.setAttribute('aria-live', mode === 'alert' ? 'assertive' : 'polite')
    element.setAttribute('aria-atomic', 'true')
  }
  const showWorkspaceStatus = (notice: BrowserNativeWorkspaceStatus): void => {
    clearRetryTimer()
    if (notice.state === 'synced') void checkFirstUse()
    workspaceStatus ??= (() => {
      const element = document.createElement('output')
      applyLiveRegion(element, 'status')
      element.setAttribute('data-browser-native-workspace-status', '')
      Object.assign(element.style, {
        position: 'fixed',
        right: '16px',
        top: '72px',
        zIndex: '900',
        pointerEvents: 'none',
        maxWidth: 'min(440px, calc(100vw - 32px))',
        padding: '9px 13px',
        border: `1px solid ${browserNativeSurface.border}`,
        borderRadius: '10px',
        background: browserNativeSurface.fill,
        color: browserNativeSurface.label,
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
    )
    workspaceStatus.dataset.state = notice.state
    if (notice.workspaceId !== undefined) {
      workspaceId = notice.workspaceId
      void refreshWorkspaceSwitcher()
    }
    applyLiveRegion(workspaceStatus, isBlockingWorkspaceState(notice.state) ? 'alert' : 'status')
    workspaceStatus.style.borderColor = isBlockingWorkspaceState(notice.state)
      ? browserNativeSurface.error
      : notice.state === 'synced' ? browserNativeSurface.success : browserNativeSurface.warn
    if ((notice.workspaceId !== undefined && (notice.state === 'conflict' || notice.state === 'error'))
      || notice.state === 'local-corrupt' || notice.state === 'local-newer-version'
      || notice.state === 'identity-missing' || notice.state === 'identity-mismatch') {
      const warning = document.createElement('span')
      warning.textContent = browserNativeWorkspaceRecoveryWarningCopy(document.documentElement.lang)
      warning.style.display = 'block'
      warning.style.marginTop = '6px'
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.browserNativeRecoveryExport = ''
      button.textContent = browserNativeWorkspaceRecoveryExportCopy(document.documentElement.lang)
      styleStatusAction(button)
      button.addEventListener('click', () => {
        void downloadLocalRecoveryBundle(
          notice.state === 'identity-missing' || notice.state === 'identity-mismatch' ? undefined : notice.workspaceId,
        ).then(() => {
          showRecoveryResult(true)
        }).catch(() => {
          showRecoveryResult(false)
        })
      })
      workspaceStatus.append(warning, button)
    }
    if (notice.state === 'lease-conflict' || notice.state === 'recovery-conflict') {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.browserNativeWorkspaceRetry = ''
      const retryAt = Date.now() + Math.max(0, notice.retryAfterMs ?? 0)
      const updateRetry = (): void => {
        const remainingMs = retryAt - Date.now()
        button.disabled = remainingMs > 0
        button.textContent = browserNativeWorkspaceRetryCopy(document.documentElement.lang, remainingMs)
      }
      updateRetry()
      styleStatusAction(button)
      button.addEventListener('click', () => { window.location.reload() })
      workspaceStatus.append(button)
      if (button.disabled) retryTimer = window.setInterval(updateRetry, 250)
    }
    if (notice.state === 'session-conflict') {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.browserNativeSessionRetry = ''
      button.textContent = browserNativeSessionRetryCopy(document.documentElement.lang)
      styleStatusAction(button)
      button.addEventListener('click', () => { window.location.reload() })
      workspaceStatus.append(button)
    }
    if (notice.state === 'read-only' || notice.state === 'stale') {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.browserNativeWorkspaceRefresh = ''
      button.textContent = browserNativeWorkspaceRefreshCopy(document.documentElement.lang, notice.state === 'stale')
      styleStatusAction(button, '600')
      button.addEventListener('click', () => { window.location.reload() })
      workspaceStatus.append(button)
    }
    syncExportControl()
  }
  const showQueueStatus = (notice: BrowserNativeQueueStatus): void => {
    queueStatus ??= (() => {
      const element = document.createElement('output')
      applyLiveRegion(element, 'status')
      element.setAttribute('data-browser-native-queue-status', '')
      Object.assign(element.style, {
        position: 'fixed',
        left: '16px',
        top: '72px',
        zIndex: '900',
        pointerEvents: 'none',
        maxWidth: 'min(440px, calc(100vw - 32px))',
        padding: '9px 13px',
        border: `1px solid ${browserNativeSurface.border}`,
        borderRadius: '10px',
        background: browserNativeSurface.fill,
        color: browserNativeSurface.label,
        boxShadow: '0 8px 28px rgb(0 0 0 / 28%)',
        font: '500 13px/1.4 system-ui, sans-serif',
      })
      document.body.append(element)
      return element
    })()
    if (notice.state === 'idle' || notice.position === undefined) {
      queueStatus.hidden = true
      queueStatus.textContent = ''
      queueStatus.dataset.state = 'idle'
      return
    }
    queueStatus.hidden = false
    queueStatus.dataset.state = 'queued'
    queueStatus.dataset.position = String(notice.position)
    queueStatus.dataset.queued = String(notice.queued ?? 0)
    queueStatus.textContent = browserNativeQueueStatusCopy(
      document.documentElement.lang,
      notice.position,
      notice.queued ?? 0,
      notice.activeTurns ?? 0,
      notice.limit,
    )
  }
  const showOfflineStatus = (notice: BrowserNativeOfflineStatus): void => {
    offlineQueued = notice.queued
    offlineStatus ??= (() => {
      const element = document.createElement('output')
      applyLiveRegion(element, 'status')
      element.setAttribute('data-browser-native-offline-status', '')
      Object.assign(element.style, {
        position: 'fixed',
        left: '16px',
        bottom: '16px',
        zIndex: '900',
        pointerEvents: 'none',
        maxWidth: 'min(440px, calc(100vw - 32px))',
        padding: '9px 13px',
        border: `1px solid ${browserNativeSurface.border}`,
        borderRadius: '10px',
        background: browserNativeSurface.fill,
        color: browserNativeSurface.label,
        boxShadow: '0 8px 28px rgb(0 0 0 / 28%)',
        font: '500 13px/1.4 system-ui, sans-serif',
      })
      document.body.append(element)
      return element
    })()
    offlineStatus.hidden = notice.state === 'online'
    offlineStatus.dataset.state = notice.state
    offlineStatus.dataset.queued = String(notice.queued)
    offlineStatus.textContent = browserNativeOfflineStatusCopy(
      document.documentElement.lang,
      notice.state,
      notice.queued,
    )
    offlineStatus.style.borderColor = notice.state === 'offline'
      ? browserNativeSurface.warn
      : notice.state === 'replaying' ? browserNativeSurface.info : browserNativeSurface.success
  }
  const showRecoveryResult = (success: boolean): void => {
    if (workspaceStatus === undefined) return
    workspaceStatus.querySelector('[data-browser-native-recovery-result]')?.remove()
    const result = document.createElement('span')
    result.dataset.browserNativeRecoveryResult = ''
    applyLiveRegion(result, 'status')
    result.style.display = 'block'
    result.style.marginTop = '6px'
    result.textContent = browserNativeWorkspaceRecoveryResultCopy(document.documentElement.lang, success)
    workspaceStatus.append(result)
  }
  const createExportControl = (): NonNullable<typeof exportControl> => {
    const root = document.createElement('div')
    root.setAttribute('data-browser-native-session-export-root', '')
    Object.assign(root.style, {
      position: 'fixed',
      left: '16px',
      bottom: '16px',
      zIndex: '900',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: '6px',
      maxWidth: 'min(320px, calc(100vw - 32px))',
      font: '500 13px/1.4 system-ui, sans-serif',
    })
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.browserNativeSessionExport = ''
    button.textContent = browserNativeSessionExportCopy(document.documentElement.lang)
    Object.assign(button.style, {
      padding: '7px 12px',
      border: `1px solid ${browserNativeSurface.border}`,
      borderRadius: '7px',
      background: browserNativeSurface.fill,
      color: browserNativeSurface.label,
      cursor: 'pointer',
      font: '500 13px/1.3 system-ui, sans-serif',
    })
    const supportButton = document.createElement('button')
    supportButton.type = 'button'
    supportButton.dataset.browserNativeSupportBundle = ''
    supportButton.textContent = browserNativeSupportBundleCopy(document.documentElement.lang)
    Object.assign(supportButton.style, {
      padding: '7px 12px',
      border: `1px solid ${browserNativeSurface.border}`,
      borderRadius: '7px',
      background: browserNativeSurface.fill,
      color: browserNativeSurface.label,
      cursor: 'pointer',
      font: '500 13px/1.3 system-ui, sans-serif',
    })
    const result = document.createElement('span')
    result.dataset.browserNativeSessionExportResult = ''
    applyLiveRegion(result, 'status')
    result.style.color = browserNativeSurface.label
    const supportResult = document.createElement('span')
    supportResult.dataset.browserNativeSupportBundleResult = ''
    applyLiveRegion(supportResult, 'status')
    supportResult.style.color = browserNativeSurface.label
    root.append(button, supportButton, result, supportResult)
    document.body.append(root)
    const control = { root, button, supportButton, result }
    button.addEventListener('click', () => {
      const sessionId = [...owners.keys()].at(-1)
      if (sessionId === undefined || workspaceId === undefined) return
      const language = document.documentElement.lang
      button.disabled = true
      button.setAttribute('aria-busy', 'true')
      result.textContent = ''
      delete root.dataset.exportState
      void downloadSessionBundle(workspaceId, sessionId).then(() => {
        root.dataset.exportState = 'downloaded'
        result.textContent = browserNativeSessionExportResultCopy(language, true)
      }).catch(() => {
        root.dataset.exportState = 'failed'
        result.textContent = browserNativeSessionExportResultCopy(language, false)
      }).finally(() => {
        button.disabled = false
        button.removeAttribute('aria-busy')
      })
    })
    supportButton.addEventListener('click', () => {
      const sessionId = [...owners.keys()].at(-1)
      if (sessionId === undefined) return
      const language = document.documentElement.lang
      supportButton.disabled = true
      supportButton.setAttribute('aria-busy', 'true')
      supportResult.textContent = ''
      delete root.dataset.supportBundleState
      void downloadSupportBundle(sessionId).then(() => {
        root.dataset.supportBundleState = 'downloaded'
        supportResult.textContent = browserNativeSupportBundleResultCopy(language, true)
      }).catch(() => {
        root.dataset.supportBundleState = 'failed'
        supportResult.textContent = browserNativeSupportBundleResultCopy(language, false)
      }).finally(() => {
        supportButton.disabled = false
        supportButton.removeAttribute('aria-busy')
      })
    })
    return control
  }
  const syncExportControl = (): void => {
    exportControl ??= createExportControl()
    const available = owners.size > 0 && workspaceId !== undefined
    // The locale plugin publishes the active language after the Worker handshake,
    // so a control created during boot would otherwise keep the page's default
    // English label for its lifetime.
    exportControl.button.textContent = browserNativeSessionExportCopy(document.documentElement.lang)
    exportControl.supportButton.textContent = browserNativeSupportBundleCopy(document.documentElement.lang)
    // The root's inline flex display outranks the UA `[hidden]` rule, so an
    // unavailable control would stay laid out and keep intercepting clicks at
    // its fixed corner. Set both: `hidden` for semantics, display for layout.
    exportControl.root.hidden = !available
    exportControl.root.style.display = available ? 'flex' : 'none'
  }
  const workspaceApiUrl = (path: string): string => `${options.apiOrigin ?? ''}${path}`
  let turnRetryPanel: { readonly root: HTMLElement; readonly message: HTMLElement; readonly button: HTMLButtonElement } | undefined
  let turnRetrySessionId: string | undefined
  let turnRetryTimer: number | undefined
  let turnRetryBusy = false
  let turnRetryHoldUntil = 0
  let turnRetryTarget: { readonly sessionId: string; readonly turn: number; readonly reason: string } | undefined
  const stopTurnRetryWatch = (): void => {
    if (turnRetryTimer !== undefined) {
      window.clearInterval(turnRetryTimer)
      turnRetryTimer = undefined
    }
    turnRetrySessionId = undefined
    turnRetryTarget = undefined
    turnRetryPanel?.root.remove()
    turnRetryPanel = undefined
  }
  const ensureTurnRetryPanel = (): NonNullable<typeof turnRetryPanel> => {
    if (turnRetryPanel !== undefined) return turnRetryPanel
    const root = document.createElement('output')
    applyLiveRegion(root, 'alert')
    root.setAttribute('data-browser-native-turn-retry', '')
    Object.assign(root.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '950',
      pointerEvents: 'auto',
      maxWidth: 'min(420px, calc(100vw - 32px))',
      padding: '9px 13px',
      border: `1px solid ${browserNativeSurface.border}`,
      borderRadius: '10px',
      background: browserNativeSurface.raised,
      color: browserNativeSurface.label,
      boxShadow: '0 8px 28px rgb(0 0 0 / 28%)',
      font: '500 13px/1.4 system-ui, sans-serif',
    })
    const message = document.createElement('span')
    message.setAttribute('data-browser-native-turn-retry-message', '')
    message.style.display = 'block'
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('data-browser-native-turn-retry-button', '')
    styleStatusAction(button, '600')
    button.hidden = true
    button.addEventListener('click', () => {
      const target = turnRetryTarget
      if (target !== undefined) void submitTurnRetry(target)
    })
    root.append(message, button)
    document.body.append(root)
    turnRetryPanel = { root, message, button }
    return turnRetryPanel
  }
  const showTurnRetryPanel = (
    target: { readonly sessionId: string; readonly turn: number; readonly reason: string },
    state: 'failed' | 'submitted' | 'duplicate',
    detail?: string,
  ): void => {
    turnRetryTarget = target
    const panel = ensureTurnRetryPanel()
    const copy = browserNativeTurnRetryCopy(document.documentElement.lang, target.turn, target.reason)
    panel.root.dataset.state = state
    panel.root.style.borderColor = state === 'failed' ? browserNativeSurface.warn : browserNativeSurface.success
    panel.message.textContent = detail ?? copy.message
    panel.button.hidden = state !== 'failed'
    panel.button.textContent = copy.action
    if (state !== 'failed') panel.root.setAttribute('aria-live', 'polite')
  }
  const submitComposerPrompt = async (prompt: string): Promise<void> => {
    const composer = [...document.querySelectorAll<HTMLElement>('[data-composer-input][contenteditable="true"]')].at(-1)
    if (composer === undefined) throw new Error('the composer is unavailable')
    composer.focus()
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(composer)
    selection?.removeAllRanges()
    selection?.addRange(range)
    if (!document.execCommand('insertText', false, prompt)) throw new Error('the composer rejected the retry prompt')
    const deadline = Date.now() + 2_000
    const retained = (): boolean => ((composer.innerText ?? '').trim() === prompt.trim())
    while (!retained() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    if (!retained()) throw new Error('the composer did not retain the retry prompt')
    const send = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
      .find(button => /^(Send message|发送消息)$/.test(button.getAttribute('aria-label') ?? ''))
    if (send === undefined) throw new Error('the Send action is unavailable')
    while (send.disabled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    if (send.disabled) throw new Error('the Send action stayed disabled')
    send.click()
  }
  const submitTurnRetry = async (target: { readonly sessionId: string; readonly turn: number; readonly reason: string }): Promise<void> => {
    if (turnRetryBusy) return
    const panel = ensureTurnRetryPanel()
    turnRetryBusy = true
    panel.button.disabled = true
    panel.button.setAttribute('aria-busy', 'true')
    try {
      const response = await fetch(workspaceApiUrl('/api/browser-native/session/turn-retry'), {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          requestId: globalThis.crypto.randomUUID(),
          sessionId: target.sessionId,
          turn: target.turn,
        }),
      })
      if (!response.ok) throw new Error(`Turn retry failed with HTTP ${String(response.status)}`)
      const body: unknown = await response.json()
      const retry = isRecord(body) && isRecord(body.retry) ? body.retry : undefined
      if (retry === undefined || typeof retry.retryId !== 'string' || typeof retry.prompt !== 'string') {
        throw new Error('Turn retry response is invalid')
      }
      const copy = browserNativeTurnRetryCopy(document.documentElement.lang, target.turn, target.reason)
      if (!isRecord(body) || body.created !== true) {
        showTurnRetryPanel(target, 'duplicate', copy.duplicate)
        return
      }
      await submitComposerPrompt(retry.prompt)
      const settled = await fetch(workspaceApiUrl('/api/browser-native/session/turn-retry/settle'), {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          requestId: globalThis.crypto.randomUUID(),
          retryId: retry.retryId,
        }),
      })
      if (!settled.ok) throw new Error(`Turn retry settlement failed with HTTP ${String(settled.status)}`)
      turnRetryHoldUntil = Date.now() + 8_000
      showTurnRetryPanel(target, 'submitted', copy.submitted)
    } catch (error) {
      console.warn('browser-native DSH: failed turn retry did not submit', error)
      const copy = browserNativeTurnRetryCopy(document.documentElement.lang, target.turn, target.reason)
      showTurnRetryPanel(target, 'failed', copy.failed)
    } finally {
      turnRetryBusy = false
      panel.button.disabled = false
      panel.button.removeAttribute('aria-busy')
    }
  }
  const pollTurnRetry = async (sessionId: string): Promise<void> => {
    if (turnRetryBusy || turnRetrySessionId !== sessionId || Date.now() < turnRetryHoldUntil) return
    try {
      const response = await fetch(workspaceApiUrl(
        `/api/browser-native/session/turn-retry?sessionId=${encodeURIComponent(sessionId)}`,
      ), { credentials: 'include', cache: 'no-store' })
      if (!response.ok) return
      const body: unknown = await response.json()
      if (turnRetrySessionId !== sessionId || Date.now() < turnRetryHoldUntil) return
      const retryable = isRecord(body) && isRecord(body.retryable)
        && typeof body.retryable.turn === 'number' && Number.isSafeInteger(body.retryable.turn)
        && typeof body.retryable.reason === 'string'
        ? { turn: body.retryable.turn, reason: body.retryable.reason }
        : undefined
      if (retryable === undefined) {
        turnRetryTarget = undefined
        turnRetryPanel?.root.remove()
        turnRetryPanel = undefined
        return
      }
      const target = { sessionId, turn: retryable.turn, reason: retryable.reason }
      const retries = isRecord(body) && Array.isArray(body.retries) ? body.retries : []
      const existing = retries.find(record => isRecord(record) && record.turn === target.turn)
      if (existing !== undefined) {
        const copy = browserNativeTurnRetryCopy(document.documentElement.lang, target.turn, target.reason)
        showTurnRetryPanel(target, 'duplicate', copy.duplicate)
        return
      }
      showTurnRetryPanel(target, 'failed')
    } catch (error) {
      // Polling is advisory; the next interval retries after a transient failure.
      console.warn('browser-native DSH: failed-turn poll did not complete', error)
    }
  }
  const startTurnRetryWatch = (sessionId: string): void => {
    if (turnRetrySessionId === sessionId && turnRetryTimer !== undefined) return
    stopTurnRetryWatch()
    turnRetrySessionId = sessionId
    void pollTurnRetry(sessionId)
    turnRetryTimer = window.setInterval(() => { void pollTurnRetry(sessionId) }, 1_000)
  }
  const reloadAfterWorkspaceChange = (): void => {
    try {
      window.sessionStorage.clear()
    } catch (error) {
      console.warn('browser-native DSH: sessionStorage could not be cleared before switching Workspace', error)
    }
    window.location.reload()
  }
  let firstUsePanel: { readonly root: HTMLElement; readonly status: HTMLElement } | undefined
  let firstUseChecked = false
  let firstUseCompleted = false
  const hideFirstUseGuide = (): void => {
    firstUsePanel?.root.remove()
    firstUsePanel = undefined
  }
  const markFirstUseCompleted = (): void => {
    if (firstUseCompleted) return
    firstUseCompleted = true
    try {
      window.localStorage.setItem(BROWSER_NATIVE_FIRST_USE_STORAGE_KEY, '1')
    } catch (error) {
      console.warn('browser-native DSH: the first-use marker could not be stored', error)
    }
    hideFirstUseGuide()
  }
  const firstUseMarkerPresent = (): boolean => {
    try {
      return window.localStorage.getItem(BROWSER_NATIVE_FIRST_USE_STORAGE_KEY) === '1'
    } catch (error) {
      console.warn('browser-native DSH: the first-use marker could not be read', error)
      return true
    }
  }
  const composerElement = (): HTMLElement | undefined => [
    ...document.querySelectorAll<HTMLElement>('[data-composer-input][contenteditable="true"]'),
  ].at(-1)
  const hasOpenDialog = (): boolean => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .some(dialog => typeof dialog.checkVisibility === 'function'
      ? dialog.checkVisibility()
      : dialog.getClientRects().length > 0)
  const waitForFirstUseSurface = async (): Promise<boolean> => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (failedClosed || pageLeaving) return false
      if (composerElement() !== undefined && !hasOpenDialog()) return true
      await new Promise((resolveDelay) => { window.setTimeout(resolveDelay, 250) })
    }
    return false
  }
  const insertComposerText = (input: HTMLElement, text: string): void => {
    input.focus()
    const selection = document.getSelection()
    const range = document.createRange()
    range.selectNodeContents(input)
    selection?.removeAllRanges()
    selection?.addRange(range)
    // oxlint-disable-next-line typescript/no-deprecated -- Chromium-only; no replacement API inserts into a focused contenteditable.
    if (document.execCommand('insertText', false, text)) return
    input.textContent = text
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  }
  const showFirstUseGuide = (): void => {
    if (firstUseCompleted || firstUsePanel !== undefined) return
    const copy = browserNativeFirstUseCopy(document.documentElement.lang)
    const root = document.createElement('section')
    root.setAttribute('data-browser-native-first-use', '')
    root.setAttribute('role', 'complementary')
    root.setAttribute('aria-label', copy.label)
    Object.assign(root.style, {
      position: 'fixed',
      left: '50%',
      top: '56px',
      transform: 'translateX(-50%)',
      zIndex: '900',
      pointerEvents: 'none',
      width: 'min(440px, calc(100vw - 32px))',
      maxHeight: 'calc(100vh - 120px)',
      overflow: 'auto',
      padding: '14px 16px',
      border: `1px solid ${browserNativeSurface.border}`,
      borderRadius: '12px',
      background: browserNativeSurface.fill,
      color: browserNativeSurface.label,
      boxShadow: '0 8px 28px rgb(0 0 0 / 32%)',
      font: '500 13px/1.45 system-ui, sans-serif',
    })
    const title = document.createElement('h2')
    title.setAttribute('data-browser-native-first-use-title', '')
    title.textContent = copy.title
    Object.assign(title.style, { margin: '0 0 6px', fontSize: '15px', fontWeight: '600', lineHeight: '1.3' })
    const body = document.createElement('p')
    body.textContent = copy.body
    Object.assign(body.style, { margin: '0 0 8px', color: browserNativeSurface.secondary })
    const steps = document.createElement('ol')
    Object.assign(steps.style, { margin: '0 0 10px', paddingLeft: '20px', color: browserNativeSurface.secondary })
    for (const step of copy.steps) {
      const item = document.createElement('li')
      item.textContent = step
      steps.append(item)
    }
    const task = document.createElement('code')
    task.setAttribute('data-browser-native-first-use-task', '')
    task.textContent = copy.sampleTask
    Object.assign(task.style, {
      display: 'block',
      margin: '0 0 10px',
      padding: '7px 9px',
      borderRadius: '8px',
      background: browserNativeSurface.raised,
      color: browserNativeSurface.label,
      font: '500 12px/1.4 ui-monospace, monospace',
    })
    const actions = document.createElement('div')
    Object.assign(actions.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' })
    const sample = document.createElement('button')
    sample.type = 'button'
    sample.setAttribute('data-browser-native-first-use-sample', '')
    sample.textContent = copy.sampleAction
    Object.assign(sample.style, {
      pointerEvents: 'auto',
      border: 'none',
      borderRadius: '8px',
      background: browserNativeSurface.actionFill,
      color: browserNativeSurface.actionLabel,
      padding: '6px 11px',
      font: '600 13px/1.2 system-ui, sans-serif',
      cursor: 'pointer',
    })
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.setAttribute('data-browser-native-first-use-dismiss', '')
    dismiss.textContent = copy.dismiss
    Object.assign(dismiss.style, {
      pointerEvents: 'auto',
      border: `1px solid ${browserNativeSurface.border}`,
      borderRadius: '8px',
      background: 'transparent',
      color: browserNativeSurface.label,
      padding: '6px 11px',
      font: '500 13px/1.2 system-ui, sans-serif',
      cursor: 'pointer',
    })
    const status = document.createElement('output')
    status.setAttribute('data-browser-native-first-use-status', '')
    applyLiveRegion(status, 'status')
    Object.assign(status.style, { display: 'block', marginTop: '8px', color: browserNativeSurface.secondary, minHeight: '1.2em' })
    sample.addEventListener('click', () => {
      const input = composerElement()
      if (input === undefined) {
        status.textContent = copy.composerMissing
        return
      }
      input.focus()
      // Chromium rejects the insert while focus is still moving from the button;
      // defer one task so the composer owns the selection before the edit.
      window.setTimeout(() => {
        const target = input.isConnected ? input : composerElement()
        if (target === undefined) {
          status.textContent = copy.composerMissing
          return
        }
        insertComposerText(target, copy.sampleTask)
        status.textContent = copy.filled
      }, 0)
    })
    dismiss.addEventListener('click', markFirstUseCompleted)
    actions.append(sample, dismiss)
    root.append(title, body, steps, task, actions, status)
    document.body.append(root)
    firstUsePanel = { root, status }
  }
  const checkFirstUse = async (): Promise<void> => {
    if (firstUseChecked || firstUseCompleted || failedClosed) return
    firstUseChecked = true
    if (firstUseMarkerPresent()) {
      firstUseCompleted = true
      return
    }
    if (!await waitForFirstUseSurface()) return
    if (!pageLeaving) showFirstUseGuide()
  }
  const isComposerSubmit = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false
    const button = target.closest('button[aria-label]')
    const label = button?.getAttribute('aria-label')
    return label === 'Send message' || label === '发送消息'
  }
  const handleFirstUseClick = (event: MouseEvent): void => {
    if (isComposerSubmit(event.target)) markFirstUseCompleted()
  }
  const handleFirstUseKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    if (!(event.target instanceof Element) || !event.target.closest('[data-composer-input]')) return
    markFirstUseCompleted()
  }
  document.addEventListener('click', handleFirstUseClick, true)
  document.addEventListener('keydown', handleFirstUseKeydown, true)
  let workspaceSwitcherLoaded = false
  const createWorkspaceSwitcher = (): WorkspaceSwitcherElements => {
    const copy = browserNativeWorkspaceSwitcherCopy(document.documentElement.lang)
    const root = document.createElement('div')
    root.setAttribute('data-browser-native-workspace-switcher', '')
    Object.assign(root.style, {
      position: 'fixed',
      right: '16px',
      top: '6px',
      zIndex: '900',
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      maxWidth: 'min(520px, calc(100vw - 32px))',
      font: '500 13px/1.4 system-ui, sans-serif',
    })
    const select = document.createElement('select')
    select.setAttribute('data-browser-native-workspace-select', '')
    select.setAttribute('aria-label', copy.label)
    Object.assign(select.style, {
      minWidth: '220px',
      padding: '7px 10px',
      border: `1px solid ${browserNativeSurface.border}`,
      borderRadius: '7px',
      background: browserNativeSurface.fill,
      color: browserNativeSurface.label,
      font: '500 13px/1.3 system-ui, sans-serif',
    })
    const create = document.createElement('button')
    create.type = 'button'
    create.setAttribute('data-browser-native-workspace-create', '')
    create.textContent = copy.create
    Object.assign(create.style, {
      padding: '7px 12px',
      border: `1px solid ${browserNativeSurface.border}`,
      borderRadius: '7px',
      background: browserNativeSurface.fill,
      color: browserNativeSurface.label,
      cursor: 'pointer',
      font: '500 13px/1.3 system-ui, sans-serif',
    })
    const status = document.createElement('span')
    status.setAttribute('data-browser-native-workspace-switcher-status', '')
    applyLiveRegion(status, 'status')
    status.style.color = browserNativeSurface.label
    status.style.maxWidth = '180px'
    status.style.overflow = 'hidden'
    status.style.textOverflow = 'ellipsis'
    status.style.whiteSpace = 'nowrap'
    root.append(select, create, status)
    document.body.append(root)
    select.addEventListener('change', () => { void selectWorkspace(select.value) })
    create.addEventListener('click', () => { void createWorkspace() })
    return { root, select, create, status }
  }
  let workspaceSwitcher: ReturnType<typeof createWorkspaceSwitcher> | undefined
  async function refreshWorkspaceSwitcher(force = false): Promise<void> {
    const switcher = workspaceSwitcher ??= createWorkspaceSwitcher()
    if (workspaceSwitcherLoaded && !force) return
    const copy = browserNativeWorkspaceSwitcherCopy(document.documentElement.lang)
    switcher.select.disabled = true
    switcher.create.disabled = true
    try {
      const response = await fetch(workspaceApiUrl('/api/browser-native/workspace/list?protocolVersion=1'), {
        credentials: 'include',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`Workspace list failed with HTTP ${String(response.status)}`)
      const raw: unknown = await response.json()
      if (!isRecord(raw) || !Array.isArray(raw.workspaces) || typeof raw.activeWorkspaceId !== 'string') {
        throw new Error('Workspace list response is invalid')
      }
      const workspaces = raw.workspaces.filter((workspace): workspace is WorkspaceListEntry => isRecord(workspace)
        && typeof workspace.workspaceId === 'string' && Number.isSafeInteger(workspace.revision)
        && Number.isSafeInteger(workspace.fileCount) && typeof workspace.active === 'boolean')
      switcher.select.replaceChildren()
      if (workspaces.length === 0) {
        const option = document.createElement('option')
        option.value = ''
        option.textContent = copy.empty
        switcher.select.append(option)
        switcher.select.disabled = true
      } else {
        for (const workspace of workspaces) {
          const option = document.createElement('option')
          option.value = workspace.workspaceId
          option.textContent = `${workspace.workspaceId.slice(0, 8)} · ${copy.fileCount(workspace.fileCount)} · r${String(workspace.revision)}`
          switcher.select.append(option)
        }
        switcher.select.value = raw.activeWorkspaceId
      }
      switcher.status.textContent = ''
      workspaceSwitcherLoaded = true
    } catch (error) {
      switcher.status.textContent = copy.loadFailed
      console.warn('browser-native DSH: Workspace switcher could not load its list', error)
    } finally {
      if (workspaceSwitcherLoaded && switcher.select.options.length > 0) switcher.select.disabled = false
      switcher.create.disabled = false
    }
  }
  async function selectWorkspace(targetWorkspaceId: string): Promise<void> {
    if (targetWorkspaceId.length === 0 || targetWorkspaceId === workspaceId) return
    const switcher = workspaceSwitcher
    if (switcher === undefined) return
    const copy = browserNativeWorkspaceSwitcherCopy(document.documentElement.lang)
    switcher.select.disabled = true
    switcher.create.disabled = true
    try {
      const response = await fetch(workspaceApiUrl('/api/browser-native/workspace/select'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          requestId: globalThis.crypto.randomUUID(),
          workspaceId: targetWorkspaceId,
        }),
      })
      if (!response.ok) throw new Error(`Workspace select failed with HTTP ${String(response.status)}`)
      reloadAfterWorkspaceChange()
    } catch (error) {
      switcher.status.textContent = copy.switchFailed
      console.warn('browser-native DSH: Workspace could not be selected', error)
      await refreshWorkspaceSwitcher(true)
    }
  }
  async function createWorkspace(): Promise<void> {
    const switcher = workspaceSwitcher
    if (switcher === undefined) return
    const copy = browserNativeWorkspaceSwitcherCopy(document.documentElement.lang)
    switcher.select.disabled = true
    switcher.create.disabled = true
    try {
      const response = await fetch(workspaceApiUrl('/api/browser-native/workspace/create'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          requestId: globalThis.crypto.randomUUID(),
        }),
      })
      if (!response.ok) throw new Error(`Workspace create failed with HTTP ${String(response.status)}`)
      reloadAfterWorkspaceChange()
    } catch (error) {
      switcher.status.textContent = copy.createFailed
      console.warn('browser-native DSH: a new Workspace could not be created', error)
      switcher.select.disabled = false
      switcher.create.disabled = false
    }
  }
  const publishLocalStatus = (state: BrowserNativeWorkspaceStatus['state'], message?: string): void => {
    const notice: BrowserNativeWorkspaceStatus = {
      type: 'workspace',
      state,
      dirtyCount: 0,
      ...(message === undefined ? {} : { message }),
    }
    window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__ = notice
    showWorkspaceStatus(notice)
    window.dispatchEvent(new CustomEvent('dsh-browser-native-workspace-status', { detail: notice }))
  }
  const stopWorker = (): void => {
    if (failedClosed) return
    failedClosed = true
    worker.terminate()
    channel.port1.close()
    clearRetryTimer()
    recoveryLocks.releaseAll()
  }
  const isPageLeaving = (): boolean => pageLeaving
  let recoveryOwners: ReturnType<typeof readBrowserNativeRecoveryState>['owners'] = []
  let recoveryWorkspaces: (ReturnType<typeof readBrowserNativeRecoveryState>['workspaces'][number] & { readonly resumeId: string })[] = []
  try {
    recoveryStorage = window.sessionStorage
    const recoveryState = readBrowserNativeRecoveryState(recoveryStorage)
    recoveryOwners = recoveryState.owners
    recoveryWorkspaces = recoveryState.workspaces.map(workspace => ({
      ...workspace,
      resumeId: workspace.resumeId ?? globalThis.crypto.randomUUID(),
    }))
    if (recoveryState.invalidKeys.length > 0) {
      window.dispatchEvent(new CustomEvent('dsh-browser-native-recovery-invalid', {
        detail: { reason: 'RECOVERY_RECORD_INVALID', count: recoveryState.invalidKeys.length },
      }))
    }
    if (!recoveryLocks.supported) {
      publishLocalStatus('recovery-unavailable', browserNativeRecoveryErrorCopy(document.documentElement.lang))
      throw new Error('browser-native recovery: Web Locks is required before starting the writable DSH Host')
    }
    const resources: BrowserNativeRecoveryResource[] = [
      ...recoveryOwners.map(owner => ({ kind: 'session' as const, id: owner.sessionId })),
      ...recoveryWorkspaces.map(workspace => ({ kind: 'workspace' as const, id: workspace.workspaceId })),
    ]
    if (!await recoveryLocks.acquireResources(resources)) {
      publishLocalStatus('recovery-conflict')
      throw new Error('browser-native recovery: another tab owns a saved writer credential')
    }
    recoveryWorkspaces = recoveryWorkspaces.map((workspace) => {
      recoveryStorage?.setItem(browserNativeWorkspaceLeaseStorageKey(workspace.workspaceId), JSON.stringify({
        workspaceId: workspace.workspaceId,
        writerToken: workspace.writerToken,
        fencingToken: workspace.fencingToken,
        resumeId: workspace.resumeId,
      }))
      return workspace
    })
  } catch (error) {
    recoveryLocks.releaseAll()
    channel.port1.close()
    channel.port2.close()
    if (window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state !== 'recovery-conflict'
      && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state !== 'recovery-unavailable') {
      publishLocalStatus('recovery-unavailable', browserNativeRecoveryErrorCopy(document.documentElement.lang))
    }
    throw error
  }
  const persistRecoveryRecord = (key: string, value: string): boolean => {
    try {
      recoveryStorage.setItem(key, value)
      return true
    } catch {
      publishLocalStatus('recovery-unavailable', browserNativeRecoveryErrorCopy(document.documentElement.lang))
      return false
    }
  }
  const removeRecoveryRecord = (key: string): void => {
    try {
      recoveryStorage.removeItem(key)
    } catch {
      publishLocalStatus('error', browserNativeRecoveryErrorCopy(document.documentElement.lang))
    }
  }
  const handleNotice = async (notice: BrowserNativePageNotice): Promise<void> => {
    if (failedClosed || pageLeaving) return
    if (notice.type === 'workspace') {
      window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__ = notice
      showWorkspaceStatus(notice)
      window.dispatchEvent(new CustomEvent('dsh-browser-native-workspace-status', { detail: notice }))
      return
    }
    if (notice.type === 'queue') {
      showQueueStatus(notice)
      return
    }
    if (notice.type === 'offline') {
      showOfflineStatus(notice)
      return
    }
    if (notice.type === 'workspace-lease' && typeof notice.workspaceId === 'string'
      && typeof notice.writerToken === 'string' && Number.isSafeInteger(notice.fencingToken)) {
      const resource = { kind: 'workspace', id: notice.workspaceId } as const
      if (recoveryLocks.supported && !await recoveryLocks.acquireResource(resource)) {
        if (isPageLeaving()) return
        publishLocalStatus('recovery-conflict')
        stopWorker()
        return
      }
      if (isPageLeaving()) {
        recoveryLocks.releaseResource(resource)
        return
      }
      if (!recoveryLocks.supported) {
        publishLocalStatus('recovery-unavailable', browserNativeRecoveryErrorCopy(document.documentElement.lang))
        stopWorker()
        return
      }
      if (!persistRecoveryRecord(browserNativeWorkspaceLeaseStorageKey(notice.workspaceId), JSON.stringify({
        workspaceId: notice.workspaceId,
        writerToken: notice.writerToken,
        fencingToken: notice.fencingToken,
        resumeId: globalThis.crypto.randomUUID(),
      }))) stopWorker()
      return
    }
    if (notice.type === 'workspace-lease-released' && typeof notice.workspaceId === 'string') {
      removeRecoveryRecord(browserNativeWorkspaceLeaseStorageKey(notice.workspaceId))
      recoveryLocks.releaseResource({ kind: 'workspace', id: notice.workspaceId })
      return
    }
    if (notice.type === 'owner') {
      const resource = { kind: 'session', id: notice.sessionId } as const
      if (recoveryLocks.supported && !await recoveryLocks.acquireResource(resource)) {
        if (isPageLeaving()) return
        publishLocalStatus('recovery-conflict')
        stopWorker()
        return
      }
      if (isPageLeaving()) {
        recoveryLocks.releaseResource(resource)
        return
      }
      owners.set(notice.sessionId, notice.ownerToken)
      syncExportControl()
      startTurnRetryWatch(notice.sessionId)
      if (!recoveryLocks.supported) {
        publishLocalStatus('recovery-unavailable', browserNativeRecoveryErrorCopy(document.documentElement.lang))
        stopWorker()
        return
      }
      if (!persistRecoveryRecord(browserNativeOwnerStorageKey(notice.sessionId), notice.ownerToken)) stopWorker()
      return
    }
    if (notice.type === 'released' || notice.type === 'unavailable') {
      owners.delete(notice.sessionId)
      syncExportControl()
      if (turnRetrySessionId === notice.sessionId) stopTurnRetryWatch()
      removeRecoveryRecord(browserNativeOwnerStorageKey(notice.sessionId))
      recoveryLocks.releaseResource({ kind: 'session', id: notice.sessionId })
    }
  }
  const enqueueNotice = (notice: BrowserNativePageNotice): void => {
    noticeQueue = noticeQueue.then(() => handleNotice(notice)).catch(() => {
      if (!failedClosed) publishLocalStatus('recovery-unavailable', browserNativeRecoveryErrorCopy(document.documentElement.lang))
      stopWorker()
    })
  }
  channel.port1.addEventListener('message', (event: MessageEvent<unknown>) => {
    const received = receiver.receive(event.data)
    if (received.kind === 'ready') {
      window.dispatchEvent(new CustomEvent('dsh-browser-native-control-ready', { detail: received.frame }))
      return
    }
    if (received.kind === 'duplicate') return
    if (received.kind === 'invalid') {
      window.dispatchEvent(new CustomEvent('dsh-browser-native-control-invalid', {
        detail: { reason: received.reason },
      }))
      return
    }
    const notice: BrowserNativePageNotice = received.frame.notice
    if (notice.type === 'pagehide-ack') {
      pagehideWaiters.get(notice.requestId)?.(notice)
      pagehideWaiters.delete(notice.requestId)
      return
    }
    enqueueNotice(notice)
  })
  channel.port1.start()
  worker.postMessage({ type: 'browser-native-control-init' }, [channel.port2])
  const reportNetworkState = (): void => {
    worker.postMessage({ type: 'browser-native-control-network', online: navigator.onLine })
    if (!navigator.onLine) {
      showOfflineStatus({ type: 'offline', state: 'offline', queued: offlineQueued })
      return
    }
    if (offlineQueued === 0) showOfflineStatus({ type: 'offline', state: 'online', queued: 0 })
  }
  window.addEventListener('offline', reportNetworkState)
  window.addEventListener('online', reportNetworkState)
  reportNetworkState()
  for (const workspace of recoveryWorkspaces) {
    worker.postMessage({
      type: 'browser-native-control-resume-workspace-lease',
      workspaceId: workspace.workspaceId,
      writerToken: workspace.writerToken,
      fencingToken: workspace.fencingToken,
      resumeId: workspace.resumeId,
    })
  }
  for (const owner of recoveryOwners) {
    worker.postMessage({
      type: 'browser-native-control-resume-owner',
      sessionId: owner.sessionId,
      ownerToken: owner.ownerToken,
    })
  }

  const handlePageHide = (event: PageTransitionEvent): void => {
    if (event.persisted) return
    pageLeaving = true
    if (options.durable === true) {
      const requestId = globalThis.crypto.randomUUID()
      const settled = new Promise<BrowserNativePagehideAck>((resolve) => { pagehideWaiters.set(requestId, resolve) })
      worker.postMessage({ type: 'browser-native-pagehide', requestId })
      void Promise.race([
        settled,
        new Promise<BrowserNativePagehideAck>((resolve) => {
          window.setTimeout(() => {
            resolve({
              type: 'pagehide-ack',
              requestId,
              localPersisted: false,
              writerReleased: false,
              error: 'pagehide local persistence barrier timed out',
            })
          }, 1_500)
        }),
      ]).then(() => {
        pagehideWaiters.delete(requestId)
        worker.terminate()
        recoveryLocks.releaseAll()
      })
    }
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
    if (options.durable !== true) recoveryLocks.releaseAll()
  }
  window.addEventListener('pagehide', handlePageHide)

  return () => {
    window.removeEventListener('pagehide', handlePageHide)
    window.removeEventListener('offline', reportNetworkState)
    window.removeEventListener('online', reportNetworkState)
    document.removeEventListener('click', handleFirstUseClick, true)
    document.removeEventListener('keydown', handleFirstUseKeydown, true)
    clearRetryTimer()
    stopTurnRetryWatch()
    pagehideWaiters.clear()
    channel.port1.close()
    workspaceStatus?.remove()
    queueStatus?.remove()
    offlineStatus?.remove()
    exportControl?.root.remove()
    workspaceSwitcher?.root.remove()
    firstUsePanel?.root.remove()
  }
}
