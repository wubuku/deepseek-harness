import type {} from '@deepseek-ai/dsh-session'

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

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'browser-native/workspace-receipt': BrowserNativeWorkspaceReceiptEvent
  }
}
