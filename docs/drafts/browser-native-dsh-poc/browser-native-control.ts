export interface BrowserNativeOwnerNotice {
  readonly type: 'owner' | 'released' | 'unavailable'
  readonly sessionId: string
  readonly ownerToken?: string
  readonly message?: string
}

let controlPort: MessagePort | undefined
const resumeOwnerTokens = new Map<string, string>()

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

/** Publish the current write owner to the page without using the DSH event log. */
export function publishBrowserNativeOwner(notice: BrowserNativeOwnerNotice): void {
  controlPort?.postMessage(notice)
}
