export interface BrowserNativeOwnerNotice {
  readonly type: 'owner' | 'released' | 'unavailable'
  readonly sessionId: string
  readonly ownerToken?: string
  readonly message?: string
}

export interface BrowserNativeWorkspaceStatus {
  readonly type: 'workspace'
  readonly state: 'loading' | 'synced' | 'dirty' | 'syncing' | 'error' | 'conflict'
  readonly workspaceId?: string
  readonly revision?: number
  readonly dirtyCount: number
  readonly message?: string
}

export interface BrowserNativeWorkspaceLease {
  readonly workspaceId: string
  readonly writerToken: string
  readonly fencingToken: number
}

export interface BrowserNativeWorkspaceLeaseResume extends BrowserNativeWorkspaceLease {
  readonly resumeId: string
}

export type BrowserNativeWorkspaceLeaseNotice =
  | ({ readonly type: 'workspace-lease' } & BrowserNativeWorkspaceLease)
  | { readonly type: 'workspace-lease-released'; readonly workspaceId: string }

let controlPort: MessagePort | undefined
const resumeOwnerTokens = new Map<string, string>()
const resumeWorkspaceLeases = new Map<string, BrowserNativeWorkspaceLeaseResume>()

/** Attach the page-owned lifecycle channel before the Worker boots DSH. */
export function setBrowserNativeControlPort(port: MessagePort): void {
  controlPort?.close()
  controlPort = port
  controlPort.start()
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
  controlPort?.postMessage(notice)
}

/** Publish the current Workspace synchronization state to the owning page. */
export function publishBrowserNativeWorkspaceStatus(notice: BrowserNativeWorkspaceStatus): void {
  controlPort?.postMessage(notice)
}

/** Send the current or released Workspace lease to the owning page. */
export function publishBrowserNativeWorkspaceLease(notice: BrowserNativeWorkspaceLeaseNotice): void {
  controlPort?.postMessage(notice)
}
