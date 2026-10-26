import {
  browserNativeRecoveryErrorCopy,
  browserNativeWorkspaceRecoveryExportCopy,
  browserNativeWorkspaceRecoveryResultCopy,
  browserNativeWorkspaceRecoveryWarningCopy,
  browserNativeWorkspaceRetryCopy,
  browserNativeWorkspaceStatusCopy,
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
  type BrowserNativePagehideAck,
  type BrowserNativeWorkspaceStatus,
} from './browser-native-control-channel.ts'

type BrowserNativePageNotice = BrowserNativeControlNotice

declare global {
  interface Window {
    __DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?: BrowserNativeWorkspaceStatus
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

interface RecoveryBlob {
  readonly name: string
  readonly byteLength: number
  readonly base64: string
  readonly actualHash: string
  readonly hashMatches: boolean
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(input).set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', input)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function readLocalRecoveryData(workspaceId: string): Promise<Record<string, unknown>> {
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
  const maxBytes = 64 * 1024 * 1024
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

async function downloadLocalRecoveryBundle(workspaceId: string): Promise<void> {
  const bundle = await readLocalRecoveryData(workspaceId)
  const json = JSON.stringify(bundle, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)
  const objectUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  try {
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = `dsh-workspace-recovery-${workspaceId}.json`
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
export async function connectBrowserNativePageControl(worker: Worker, options: { readonly durable?: boolean } = {}): Promise<() => void> {
  const channel = new MessageChannel()
  const receiver = new BrowserNativeControlReceiver()
  const owners = new Map<string, string>()
  const recoveryLocks = new BrowserNativeRecoveryLocks(typeof navigator.locks === 'undefined' ? undefined : navigator.locks)
  let recoveryStorage: Storage | undefined
  let workspaceStatus: HTMLElement | undefined
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
  const showWorkspaceStatus = (notice: BrowserNativeWorkspaceStatus): void => {
    clearRetryTimer()
    workspaceStatus ??= (() => {
      const element = document.createElement('output')
      element.setAttribute('aria-live', 'polite')
      element.setAttribute('data-browser-native-workspace-status', '')
      Object.assign(element.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483000',
        pointerEvents: 'none',
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
    workspaceStatus.style.borderColor = notice.state === 'error' || notice.state === 'conflict'
      || notice.state === 'local-corrupt' || notice.state === 'local-newer-version'
      || notice.state === 'recovery-conflict' || notice.state === 'recovery-unavailable' ? '#f87171'
      : notice.state === 'synced' ? '#34d399' : '#fbbf24'
    if (notice.state === 'local-corrupt' || notice.state === 'local-newer-version') {
      const warning = document.createElement('span')
      warning.textContent = browserNativeWorkspaceRecoveryWarningCopy(document.documentElement.lang)
      warning.style.display = 'block'
      warning.style.marginTop = '6px'
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.browserNativeRecoveryExport = ''
      button.textContent = browserNativeWorkspaceRecoveryExportCopy(document.documentElement.lang)
      Object.assign(button.style, {
        display: 'block',
        marginTop: '8px',
        padding: '6px 10px',
        pointerEvents: 'auto',
        border: '1px solid #8ab4f8',
        borderRadius: '5px',
        background: '#1d4ed8',
        color: '#fff',
        cursor: 'pointer',
        font: '600 13px/1.3 system-ui, sans-serif',
      })
      button.addEventListener('click', () => {
        void downloadLocalRecoveryBundle(notice.workspaceId ?? '').then(() => {
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
      Object.assign(button.style, {
        display: 'block',
        marginTop: '8px',
        padding: '6px 10px',
        pointerEvents: 'auto',
        border: '1px solid #8ab4f8',
        borderRadius: '5px',
        background: '#1d4ed8',
        color: '#fff',
        cursor: 'pointer',
        font: '600 13px/1.3 system-ui, sans-serif',
      })
      button.addEventListener('click', () => { window.location.reload() })
      workspaceStatus.append(button)
      if (button.disabled) retryTimer = window.setInterval(updateRetry, 250)
    }
  }
  const showRecoveryResult = (success: boolean): void => {
    if (workspaceStatus === undefined) return
    workspaceStatus.querySelector('[data-browser-native-recovery-result]')?.remove()
    const result = document.createElement('span')
    result.dataset.browserNativeRecoveryResult = ''
    result.setAttribute('role', 'status')
    result.style.display = 'block'
    result.style.marginTop = '6px'
    result.textContent = browserNativeWorkspaceRecoveryResultCopy(document.documentElement.lang, success)
    workspaceStatus.append(result)
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
      if (recoveryStorage === undefined) throw new Error('sessionStorage is unavailable')
      recoveryStorage.setItem(key, value)
      return true
    } catch {
      publishLocalStatus('recovery-unavailable', browserNativeRecoveryErrorCopy(document.documentElement.lang))
      return false
    }
  }
  const removeRecoveryRecord = (key: string): void => {
    try {
      recoveryStorage?.removeItem(key)
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
    if (notice.type === 'workspace-lease' && typeof notice.workspaceId === 'string'
      && typeof notice.writerToken === 'string' && Number.isSafeInteger(notice.fencingToken)) {
      const resource = { kind: 'workspace', id: notice.workspaceId } as const
      if (recoveryLocks.supported && !await recoveryLocks.acquireResource(resource)) {
        if (pageLeaving) return
        publishLocalStatus('recovery-conflict')
        stopWorker()
        return
      }
      if (pageLeaving) {
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
        if (pageLeaving) return
        publishLocalStatus('recovery-conflict')
        stopWorker()
        return
      }
      if (pageLeaving) {
        recoveryLocks.releaseResource(resource)
        return
      }
      owners.set(notice.sessionId, notice.ownerToken)
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
          window.setTimeout(() => resolve({
            type: 'pagehide-ack',
            requestId,
            localPersisted: false,
            writerReleased: false,
            error: 'pagehide local persistence barrier timed out',
          }), 1_500)
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
    clearRetryTimer()
    pagehideWaiters.clear()
    channel.port1.close()
    workspaceStatus?.remove()
  }
}
