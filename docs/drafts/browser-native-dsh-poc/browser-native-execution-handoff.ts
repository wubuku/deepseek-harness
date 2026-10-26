/** Durable Session and Workspace cursors observed before ownership changes. */
export interface BrowserNativeExecutionHandoffCheckpoint {
  readonly sessionId: string
  readonly ownerId: string
  readonly ownerEpoch: number
  readonly nextSessionSeq: number
  readonly durableThroughSeq: number
  readonly workspaceId: string
  readonly workspaceRevision: number
  readonly workspaceFencingToken: number
  readonly pendingWorkspaceReceipts: number
  readonly pendingSessionEvents: number
  readonly pendingOperationIds: readonly string[]
  readonly pendingExecutionIds: readonly string[]
}

/** Session credentials issued to the next Worker by the existing handoff endpoint. */
export interface BrowserNativeExecutionHandoffOwner {
  readonly ownerToken: string
  readonly ownerEpoch: number
}

/** Last confirmed phase; unknown results never imply that the next owner is ready. */
export type BrowserNativeExecutionHandoffResult =
  | { readonly state: 'preparation-failed'; readonly handoffId: string; readonly stage: 'workspace' | 'session'; readonly error: string }
  | { readonly state: 'session-rejected'; readonly handoffId: string; readonly checkpoint: BrowserNativeExecutionHandoffCheckpoint; readonly error: string }
  | { readonly state: 'session-unknown'; readonly handoffId: string; readonly checkpoint: BrowserNativeExecutionHandoffCheckpoint; readonly error: string }
  | {
      readonly state: 'workspace-release-unknown'
      readonly handoffId: string
      readonly checkpoint: BrowserNativeExecutionHandoffCheckpoint
      readonly nextOwner: BrowserNativeExecutionHandoffOwner
      readonly error: string
    }
  | {
      readonly state: 'complete'
      readonly handoffId: string
      readonly checkpoint: BrowserNativeExecutionHandoffCheckpoint
      readonly nextOwner: BrowserNativeExecutionHandoffOwner
    }

/** Operations required to transfer one quiescent Browser-Native execution. */
export interface BrowserNativeExecutionHandoffOptions {
  readonly sessionId: string
  readonly ownerId: string
  readonly handoffId: string
  readonly ownerEpoch: number
  readonly flushWorkspace: () => Promise<{
    readonly workspaceId: string
    readonly revision: number
    readonly fencingToken: number
  }>
  readonly flushSession: () => Promise<{
    readonly ownerEpoch: number
    readonly nextSeq: number
    readonly durableThroughSeq: number
    readonly pendingEvents: number
    readonly pendingWorkspaceReceipts: number
  }>
  readonly handoffSession: (checkpoint: BrowserNativeExecutionHandoffCheckpoint, handoffId: string) => Promise<BrowserNativeExecutionHandoffOwner>
  readonly releaseWorkspace: () => Promise<void>
  readonly classifySessionHandoffError: (error: unknown) => 'rejected' | 'unknown'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertCheckpoint(checkpoint: BrowserNativeExecutionHandoffCheckpoint): void {
  if (checkpoint.sessionId.length === 0 || checkpoint.ownerId.length === 0 || checkpoint.workspaceId.length === 0
    || !Number.isSafeInteger(checkpoint.ownerEpoch) || checkpoint.ownerEpoch < 1
    || !Number.isSafeInteger(checkpoint.nextSessionSeq) || checkpoint.nextSessionSeq < 0
    || !Number.isSafeInteger(checkpoint.durableThroughSeq) || checkpoint.durableThroughSeq !== checkpoint.nextSessionSeq - 1
    || !Number.isSafeInteger(checkpoint.workspaceRevision) || checkpoint.workspaceRevision < 0
    || !Number.isSafeInteger(checkpoint.workspaceFencingToken) || checkpoint.workspaceFencingToken < 1
    || checkpoint.pendingWorkspaceReceipts !== 0 || checkpoint.pendingSessionEvents !== 0
    || checkpoint.pendingOperationIds.length !== 0 || checkpoint.pendingExecutionIds.length !== 0) {
    throw new Error('execution handoff checkpoint is not quiescent and durable')
  }
}

/**
 * Transfer Session ownership before releasing the Workspace lease, preserving explicit partial outcomes.
 * @param options - Session/Workspace durability callbacks and the stable handoff identifier.
 * @returns The last confirmed stage; unknown outcomes never trigger an automatic retry.
 */
export async function handoffBrowserNativeExecution(
  options: BrowserNativeExecutionHandoffOptions,
): Promise<BrowserNativeExecutionHandoffResult> {
  if (options.handoffId.length === 0 || options.sessionId.length === 0 || options.ownerId.length === 0
    || !Number.isSafeInteger(options.ownerEpoch) || options.ownerEpoch < 1) {
    return { state: 'preparation-failed', handoffId: options.handoffId, stage: 'session', error: 'execution handoff identity is invalid' }
  }
  let workspace: Awaited<ReturnType<BrowserNativeExecutionHandoffOptions['flushWorkspace']>>
  try {
    workspace = await options.flushWorkspace()
  } catch (error) {
    return { state: 'preparation-failed', handoffId: options.handoffId, stage: 'workspace', error: errorMessage(error) }
  }

  let session: Awaited<ReturnType<BrowserNativeExecutionHandoffOptions['flushSession']>>
  try {
    session = await options.flushSession()
  } catch (error) {
    return { state: 'preparation-failed', handoffId: options.handoffId, stage: 'session', error: errorMessage(error) }
  }

  const checkpoint: BrowserNativeExecutionHandoffCheckpoint = {
    sessionId: options.sessionId,
    ownerId: options.ownerId,
    ownerEpoch: options.ownerEpoch,
    nextSessionSeq: session.nextSeq,
    durableThroughSeq: session.durableThroughSeq,
    workspaceId: workspace.workspaceId,
    workspaceRevision: workspace.revision,
    workspaceFencingToken: workspace.fencingToken,
    pendingWorkspaceReceipts: session.pendingWorkspaceReceipts,
    pendingSessionEvents: session.pendingEvents,
    pendingOperationIds: [],
    pendingExecutionIds: [],
  }

  try {
    if (session.ownerEpoch !== options.ownerEpoch) throw new Error('Session flush observed a different owner epoch')
    assertCheckpoint(checkpoint)
  } catch (error) {
    return { state: 'preparation-failed', handoffId: options.handoffId, stage: 'session', error: errorMessage(error) }
  }

  let nextOwner: BrowserNativeExecutionHandoffOwner
  try {
    nextOwner = await options.handoffSession(checkpoint, options.handoffId)
  } catch (error) {
    return {
      state: options.classifySessionHandoffError(error) === 'rejected' ? 'session-rejected' : 'session-unknown',
      handoffId: options.handoffId,
      checkpoint,
      error: errorMessage(error),
    }
  }

  try {
    await options.releaseWorkspace()
  } catch (error) {
    return { state: 'workspace-release-unknown', handoffId: options.handoffId, checkpoint, nextOwner, error: errorMessage(error) }
  }
  return { state: 'complete', handoffId: options.handoffId, checkpoint, nextOwner }
}
