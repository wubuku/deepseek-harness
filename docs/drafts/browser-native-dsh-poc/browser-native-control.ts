import {
  BROWSER_NATIVE_CONTROL_MAX_TEXT_BYTES,
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

/** Deterministic malformed or boundary cases accepted by the PoC test port. */
export type BrowserNativeControlTestInjection =
  | 'duplicate' | 'gap' | 'conflict' | 'max-text' | 'oversized-text'
  | 'escaped-frame-overflow' | 'unknown-field' | 'unknown-notice' | 'cyclic-extra'

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

/** Inject a control protocol case through the PoC test port.
 * @param kind The deterministic frame condition to send.
 * @returns No value; the case is delivered asynchronously to the page.
 */
export function publishBrowserNativeControlTestFrame(kind: BrowserNativeControlTestInjection): void {
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
  if (kind === 'max-text') {
    publishBrowserNativeWorkspaceStatus({
      type: 'workspace',
      state: 'dirty',
      workspaceId: 'control-test',
      revision: 0,
      dirtyCount: 0,
      message: 'x'.repeat(BROWSER_NATIVE_CONTROL_MAX_TEXT_BYTES),
    })
    return
  }
  if (kind === 'conflict') {
    const notice = base.notice
    let conflictingNotice: BrowserNativeControlNotice
    if (notice.type === 'workspace') conflictingNotice = { ...notice, dirtyCount: notice.dirtyCount + 1 }
    else if (notice.type === 'owner') conflictingNotice = { ...notice, ownerEpoch: notice.ownerEpoch + 1 }
    else if (notice.type === 'released') conflictingNotice = { ...notice, sessionId: `${notice.sessionId}-conflict` }
    else if (notice.type === 'unavailable') {
      conflictingNotice = { ...notice, message: `${notice.message}-conflict` }
    } else if (notice.type === 'workspace-lease') {
      conflictingNotice = { ...notice, writerToken: `${notice.writerToken}-conflict` }
    } else if (notice.type === 'workspace-lease-released') {
      conflictingNotice = { ...notice, workspaceId: `${notice.workspaceId}-conflict` }
    } else {
      conflictingNotice = { ...notice, error: `${notice.error ?? ''}-conflict` }
    }
    controlPort.postMessage({ ...base, notice: conflictingNotice })
    return
  }
  const seq = controlSeq + 1
  if (kind === 'oversized-text') {
    controlPort.postMessage({
      ...base,
      seq,
      notice: { type: 'workspace', state: 'dirty', workspaceId: 'control-test', dirtyCount: 0, message: 'x'.repeat(BROWSER_NATIVE_CONTROL_MAX_TEXT_BYTES + 1) },
    })
    return
  }
  if (kind === 'escaped-frame-overflow') {
    controlPort.postMessage({
      ...base,
      seq,
      notice: { type: 'workspace', state: 'dirty', workspaceId: 'control-test', dirtyCount: 0, message: '\0'.repeat(BROWSER_NATIVE_CONTROL_MAX_TEXT_BYTES) },
    })
    return
  }
  if (kind === 'unknown-field') {
    controlPort.postMessage({ ...base, seq, diagnosticSecret: 'CONTROL_TEST_SECRET' })
    return
  }
  if (kind === 'unknown-notice') {
    controlPort.postMessage({
      ...base,
      seq,
      notice: { type: 'future-required-notice', diagnosticSecret: 'CONTROL_TEST_SECRET' },
    })
    return
  }
  const cyclicExtra: Record<string, unknown> = { diagnosticSecret: 'CONTROL_TEST_SECRET' }
  cyclicExtra.self = cyclicExtra
  controlPort.postMessage({ ...base, seq, cyclicExtra })
}
