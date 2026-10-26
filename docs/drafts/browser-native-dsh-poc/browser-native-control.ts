import {
  BROWSER_NATIVE_CONTROL_PROTOCOL_VERSION,
  type BrowserNativeControlFrame,
  type BrowserNativeControlNotice,
  type BrowserNativeOwnerNotice,
  type BrowserNativePagehideAck,
  type BrowserNativeWorkspaceLease,
  type BrowserNativeWorkspaceStatus,
} from '../../../apps/web/src/browser-native-control-channel.ts'

export type {
  BrowserNativeControlFrame,
  BrowserNativeControlNotice,
  BrowserNativeOwnerNotice,
  BrowserNativePagehideAck,
  BrowserNativeWorkspaceLease,
  BrowserNativeWorkspaceStatus,
} from '../../../apps/web/src/browser-native-control-channel.ts'

export interface BrowserNativeWorkspaceLeaseResume extends BrowserNativeWorkspaceLease {
  readonly resumeId: string
}

export type BrowserNativeWorkspaceLeaseNotice =
  | ({ readonly type: 'workspace-lease' } & BrowserNativeWorkspaceLease)
  | { readonly type: 'workspace-lease-released'; readonly workspaceId: string }

let controlPort: MessagePort | undefined
let controlChannelId: string | undefined
let controlSeq = 0
let lastControlFrame: BrowserNativeControlFrame | undefined
const resumeOwnerTokens = new Map<string, string>()
const resumeWorkspaceLeases = new Map<string, BrowserNativeWorkspaceLeaseResume>()

/** Attach the page-owned lifecycle channel before the Worker boots DSH. */
export function setBrowserNativeControlPort(port: MessagePort): void {
  controlPort?.close()
  controlPort = port
  controlChannelId = crypto.randomUUID()
  controlSeq = 0
  lastControlFrame = {
    type: 'control-ready',
    protocolVersion: BROWSER_NATIVE_CONTROL_PROTOCOL_VERSION,
    channelId: controlChannelId,
    seq: 0,
  }
  controlPort.start()
  controlPort.postMessage(lastControlFrame)
}

export function setBrowserNativeResumeOwner(sessionId: string, ownerToken: string): void {
  resumeOwnerTokens.set(sessionId, ownerToken)
}

export function takeBrowserNativeResumeOwner(sessionId: string): string | undefined {
  const ownerToken = resumeOwnerTokens.get(sessionId)
  resumeOwnerTokens.delete(sessionId)
  return ownerToken
}

/** Store a tab-scoped Workspace lease received before the Host boots.
 * @param lease The lease and stable resume id transferred from the page.
 */
export function setBrowserNativeResumeWorkspaceLease(lease: BrowserNativeWorkspaceLeaseResume): void {
  resumeWorkspaceLeases.set(lease.workspaceId, lease)
}

/** Take the tab-scoped Workspace lease for one Workspace boot.
 * @param workspaceId The Workspace whose lease should resume.
 * @returns The saved lease, or `undefined` when this tab has no saved lease.
 */
export function takeBrowserNativeResumeWorkspaceLease(workspaceId: string): BrowserNativeWorkspaceLeaseResume | undefined {
  const lease = resumeWorkspaceLeases.get(workspaceId)
  resumeWorkspaceLeases.delete(workspaceId)
  return lease
}

/** Publish the current write owner to the page without using the DSH event log. */
export function publishBrowserNativeOwner(notice: BrowserNativeOwnerNotice): void {
  publishBrowserNativeControlNotice(notice)
}

/** Publish the current Workspace synchronization state to the owning page. */
export function publishBrowserNativeWorkspaceStatus(notice: BrowserNativeWorkspaceStatus): void {
  publishBrowserNativeControlNotice(notice)
}

/** Send the current or released Workspace lease to the owning page. */
export function publishBrowserNativeWorkspaceLease(notice: BrowserNativeWorkspaceLeaseNotice): void {
  publishBrowserNativeControlNotice(notice)
}

/**
 * Report the result of the page-leave local persistence barrier.
 * @param notice - Persistence and lease-release result sent to the page.
 */
export function publishBrowserNativePagehideAck(notice: BrowserNativePagehideAck): void {
  publishBrowserNativeControlNotice(notice)
}

function publishBrowserNativeControlNotice(notice: BrowserNativeControlNotice): void {
  if (controlPort === undefined || controlChannelId === undefined) return
  const frame: BrowserNativeControlFrame = {
    type: 'control-frame',
    protocolVersion: BROWSER_NATIVE_CONTROL_PROTOCOL_VERSION,
    channelId: controlChannelId,
    seq: ++controlSeq,
    notice,
  }
  lastControlFrame = frame
  controlPort.postMessage(frame)
}

/** Inject a duplicate, gap, or same-sequence conflict for PoC fault tests. */
export function publishBrowserNativeControlTestFrame(kind: 'duplicate' | 'gap' | 'conflict'): void {
  if (controlPort === undefined || controlChannelId === undefined || lastControlFrame?.type !== 'control-frame') {
    throw new Error('browser-native control test frame requires a published notice')
  }
  const base = lastControlFrame
  if (kind === 'duplicate') {
    controlPort.postMessage(base)
    return
  }
  if (kind === 'gap') {
    controlPort.postMessage({ ...base, seq: controlSeq + 2 })
    return
  }
  const notice = base.notice
  const conflictingNotice: BrowserNativeControlNotice = notice.type === 'workspace'
    ? { ...notice, dirtyCount: notice.dirtyCount + 1 }
    : notice.type === 'owner'
      ? { ...notice, message: notice.message === 'control-test-conflict' ? 'control-test-conflict-2' : 'control-test-conflict' }
      : notice.type === 'unavailable'
        ? { ...notice, message: notice.message === 'control-test-conflict' ? 'control-test-conflict-2' : 'control-test-conflict' }
        : notice.type === 'workspace-lease'
          ? { ...notice, writerToken: `${notice.writerToken}-conflict` }
          : notice.type === 'workspace-lease-released'
            ? { ...notice, workspaceId: `${notice.workspaceId}-conflict` }
            : { ...notice, error: notice.error === 'control-test-conflict' ? 'control-test-conflict-2' : 'control-test-conflict' }
  controlPort.postMessage({ ...base, notice: conflictingNotice })
}
