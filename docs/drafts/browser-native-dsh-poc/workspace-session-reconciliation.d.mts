export interface BrowserNativeWorkspaceReceiptEvent {
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly toolName: string
  readonly toolCallSeq: number
  readonly operationId: string
  readonly workspaceId: string
  readonly baseRevision: number
  readonly revision: number
  readonly manifestDigest: string
  readonly paths: readonly string[]
  readonly replayed: boolean
}

export interface WorkspaceReceiptForReconciliation {
  readonly operationId: string
  readonly workspaceId: string
  readonly baseRevision: number
  readonly revision: number
  readonly manifestDigest: string
  readonly paths: readonly string[]
  readonly replayed: boolean
  readonly operation?: {
    readonly sessionId: string
    readonly turn: number
    readonly step: number
    readonly callId: string
    readonly toolName: string
    readonly toolCallSeq: number
  }
}

export function matchesWorkspaceReceipt(
  eventData: BrowserNativeWorkspaceReceiptEvent,
  receipt: WorkspaceReceiptForReconciliation,
  sessionId: string,
): boolean
