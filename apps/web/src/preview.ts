/**
 * Worker-preview bootstrap: the one module preview.html adds ahead of the
 * stock entry tag. The runtime's optional source stage owns the pre-Cordis
 * chooser; the unchanged Host connector then owns the Worker handshake.
 * Everything after those calls is the served startup chain verbatim.
 */
import DshWorker from '../../../docs/drafts/browser-native-dsh-poc/browser-native-worker.ts?worker'
import browserNativeProfileOverlay from '../../../docs/drafts/browser-native-dsh-poc/browser-native-profile-overlay.tar.gz?url'
import { connectBrowserNativePageControl } from './browser-native-page-control.ts'
import {
  chooseWorkerHostSource, connectWorkerHost, IMAGE_FILE_NAME,
} from '@deepseek-ai/dsh-experimental-webworker-runtime/client'

const searchParams = new URLSearchParams(window.location.search)
const browserNative = searchParams.get('browser-native') === '1'
const browserNativeDurable = browserNative && searchParams.get('browser-native-durable') === '1'
const browserNativeWorkspaceLease = browserNative && searchParams.get('browser-native-workspace-lease') === '1'
const browserNativeWorkspaceTest = browserNative && searchParams.get('browser-native-test') === 'workspace-recovery'
const pageLifecycle = { unloading: false }
let worker: Worker | undefined

interface BrowserNativeWorkspaceTestRequest {
  readonly action: 'write' | 'write-pattern' | 'append' | 'mkdir' | 'read' | 'read-digest' | 'rename' | 'remove' | 'stat' | 'list' | 'chmod' | 'write-binary' | 'flush-local' | 'flush-workspace' | 'lease-info' | 'lease-timer-probe' | 'release-lease' | 'abort-next-metadata-transaction' | 'pause-local-save' | 'local-save-state' | 'release-local-save'
  readonly stage?: 'before' | 'after'
  readonly path?: string
  readonly from?: string
  readonly to?: string
  readonly content?: string
  readonly base64?: string
  readonly byteLength?: number
  readonly byteValue?: number
  readonly mode?: number
}

interface BrowserNativeWorkspaceTestResponse {
  readonly ok: boolean
  readonly path?: string
  readonly content?: string
  readonly error?: string
  readonly writerToken?: string
  readonly fencingToken?: number
  readonly state?: 'unclaimed' | 'active' | 'lost' | 'released'
  readonly renewalScheduled?: boolean
  readonly renewalPending?: boolean
  readonly renewAfterMs?: number
  readonly deadlineRemainingMs?: number
  readonly from?: string
  readonly to?: string
  readonly entries?: readonly string[]
  readonly kind?: 'directory' | 'file'
  readonly mode?: number
  readonly bytes?: number
  readonly digest?: string
  readonly receipts?: readonly Record<string, unknown>[]
}

function browserNativeTestUuid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40)
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80)
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

declare global {
  interface Window {
    __DSH_BROWSER_NATIVE_WORKSPACE_TEST__?:
    (request: BrowserNativeWorkspaceTestRequest) => Promise<BrowserNativeWorkspaceTestResponse>
  }
}

if (browserNative) {
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return
    pageLifecycle.unloading = true
    worker?.terminate()
  })
}
const image = `preview/${IMAGE_FILE_NAME}`
try {
  const source = await chooseWorkerHostSource({ image })
  if (!browserNative || !pageLifecycle.unloading) {
    const currentWorker = new DshWorker({ name: 'dsh-host' })
    worker = currentWorker
    if (browserNativeWorkspaceTest) {
      const channel = new MessageChannel()
      const pending = new Map<string, (response: BrowserNativeWorkspaceTestResponse) => void>()
      channel.port1.addEventListener('message', (event: MessageEvent<BrowserNativeWorkspaceTestResponse & { requestId: string }>) => {
        pending.get(event.data.requestId)?.(event.data)
        pending.delete(event.data.requestId)
      })
      channel.port1.start()
      currentWorker.postMessage({ type: 'browser-native-workspace-test-init' }, [channel.port2])
      window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ = request => new Promise((resolve) => {
        const requestId = browserNativeTestUuid()
        pending.set(requestId, resolve)
        currentWorker.postMessage({ type: 'browser-native-workspace-test-request', requestId, ...request })
      })
    }
    if (browserNativeDurable) currentWorker.postMessage({ type: 'browser-native-durable-workspace-init' })
    if (browserNativeWorkspaceLease) currentWorker.postMessage({ type: 'browser-native-workspace-lease-init' })
    if (browserNative) connectBrowserNativePageControl(currentWorker)
    await connectWorkerHost(currentWorker, {
      image,
      overlays: browserNative
        ? [...source.overlays, new URL(browserNativeProfileOverlay, document.baseURI)]
        : source.overlays,
    })
  }
} catch (error) {
  worker?.terminate()
  const message = error instanceof Error ? error.message : String(error)
  const workspaceStatus = window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state
  const workspaceCannotBoot = browserNative && (workspaceStatus === 'lease-conflict' || workspaceStatus === 'local-corrupt'
    || workspaceStatus === 'local-newer-version')
  if ((!pageLifecycle.unloading || !message.startsWith('web-preview tunnel: boot payload failed')) && !workspaceCannotBoot) throw error
}
