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
const browserNativeRuntimeProbeTest = browserNative && searchParams.get('browser-native-test') === 'runtime-capability-probes'
const requestedProbeFault = browserNativeRuntimeProbeTest ? searchParams.get('browser-native-probe-fault') : null
const browserNativeProbeFault = requestedProbeFault === 'outbox-abort' || requestedProbeFault === 'opfs-unavailable'
  ? requestedProbeFault
  : undefined
const pageLifecycle = { unloading: false }
let worker: Worker | undefined

interface BrowserNativeWorkspaceTestRequest {
  readonly action: 'write' | 'write-pattern' | 'append' | 'mkdir' | 'read' | 'read-digest' | 'read-range' | 'usage' | 'rename' | 'remove' | 'stat' | 'list' | 'chmod' | 'write-binary' | 'flush-local' | 'flush-workspace' | 'lease-info' | 'lease-timer-probe' | 'release-lease' | 'abort-next-metadata-transaction' | 'pause-local-save' | 'local-save-state' | 'release-local-save' | 'execution-handoff' | 'control-inject'
  readonly controlInjection?: 'duplicate' | 'gap' | 'conflict' | 'max-text' | 'oversized-text'
    | 'escaped-frame-overflow' | 'unknown-field' | 'unknown-notice' | 'cyclic-extra'
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
  readonly sessionId?: string
  readonly ownerId?: string
  readonly ownerToken?: string
  readonly ownerEpoch?: number
  readonly handoffId?: string
  readonly terminateAfter?: boolean
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
  readonly base64?: string
  readonly logicalBytes?: number
  readonly residentBytes?: number
  readonly receipts?: readonly Record<string, unknown>[]
  readonly executionHandoff?: {
    readonly state: string
    readonly checkpoint?: Readonly<Record<string, unknown>>
    readonly nextOwner?: { readonly ownerToken: string; readonly ownerEpoch: number }
  }
  readonly controlInjection?: string
}

function browserNativeTestUuid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40)
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80)
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function probeBrowserNativeWorker(currentWorker: Worker): Promise<void> {
  const channel = new MessageChannel()
  const requestId = browserNativeTestUuid()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      channel.port1.removeEventListener('message', onMessage)
      channel.port1.removeEventListener('messageerror', onMessageError)
      currentWorker.removeEventListener('error', onWorkerError)
      channel.port1.close()
      if (error === undefined) resolve()
      else reject(error)
    }
    const onMessage = (event: MessageEvent<Record<string, unknown>>): void => {
      if (event.data.type !== 'browser-native-runtime-probe-result' || event.data.requestId !== requestId) return
      if (event.data.ok === true) {
        finish()
        return
      }
      const failures = Array.isArray(event.data.failures) ? event.data.failures : []
      const codes = failures.flatMap(failure => failure !== null && typeof failure === 'object'
        && typeof (failure as Record<string, unknown>).code === 'string'
        ? [String((failure as Record<string, unknown>).code)]
        : [])
      finish(new Error(`browser-native startup blocked: ${codes.length === 0 ? 'PROBE_PROTOCOL_INVALID' : codes.join(',')}`))
    }
    const onMessageError = (): void => finish(new Error('browser-native startup blocked: PROBE_PROTOCOL_INVALID'))
    const onWorkerError = (event: ErrorEvent): void => finish(new Error(`browser-native startup blocked: WORKER_ERROR (${event.message})`))
    const timeout = window.setTimeout(() => finish(new Error('browser-native startup blocked: PROBE_TIMEOUT')), 10_000)
    channel.port1.addEventListener('message', onMessage)
    channel.port1.addEventListener('messageerror', onMessageError)
    currentWorker.addEventListener('error', onWorkerError, { once: true })
    channel.port1.start()
    try {
      currentWorker.postMessage({
        type: 'browser-native-runtime-probe',
        requestId,
        durableWorkspace: browserNativeDurable,
        ...(browserNativeRuntimeProbeTest && browserNativeProbeFault !== undefined
          ? { testFault: browserNativeProbeFault }
          : {}),
      }, [channel.port2])
    } catch (error) {
      finish(error instanceof Error ? error : new Error('browser-native startup blocked: PROBE_POST_FAILED'))
    }
  })
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
    if (!browserNativeDurable) worker?.terminate()
  })
}
const image = `preview/${IMAGE_FILE_NAME}`
try {
  const source = await chooseWorkerHostSource({ image })
  if (!browserNative || !pageLifecycle.unloading) {
    const currentWorker = new DshWorker({ name: 'dsh-host' })
    worker = currentWorker
    if (browserNativeWorkspaceTest || browserNativeRuntimeProbeTest) {
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
    if (browserNative) await connectBrowserNativePageControl(currentWorker, { durable: browserNativeDurable })
    if (browserNative) await probeBrowserNativeWorker(currentWorker)
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
    || workspaceStatus === 'local-newer-version' || workspaceStatus === 'recovery-conflict'
    || workspaceStatus === 'recovery-unavailable')
  if ((!pageLifecycle.unloading || !message.startsWith('web-preview tunnel: boot payload failed')) && !workspaceCannotBoot) throw error
}
