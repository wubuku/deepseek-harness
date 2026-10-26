/**
 * Versioned page/Worker control frames for Browser-Native lifecycle state.
 * Session events use the DSH Session log and do not pass through this channel.
 */

export const BROWSER_NATIVE_CONTROL_PROTOCOL_VERSION = 1

export interface BrowserNativeOwnerNotice {
  readonly type: 'owner' | 'released' | 'unavailable'
  readonly sessionId: string
  readonly ownerToken?: string
  readonly ownerEpoch?: number
  readonly message?: string
}

export interface BrowserNativeWorkspaceStatus {
  readonly type: 'workspace'
  readonly state: 'loading' | 'synced' | 'dirty' | 'syncing' | 'error' | 'conflict'
    | 'local-corrupt' | 'local-newer-version' | 'lease-conflict'
  readonly workspaceId?: string
  readonly revision?: number
  readonly dirtyCount: number
  readonly message?: string
  readonly retryAfterMs?: number
}

export interface BrowserNativeWorkspaceLease {
  readonly type: 'workspace-lease'
  readonly workspaceId: string
  readonly writerToken: string
  readonly fencingToken: number
}

export interface BrowserNativeWorkspaceLeaseReleased {
  readonly type: 'workspace-lease-released'
  readonly workspaceId: string
}

export interface BrowserNativePagehideAck {
  readonly type: 'pagehide-ack'
  readonly requestId: string
  readonly localPersisted: boolean
  readonly writerReleased: boolean
  readonly error?: string
}

export type BrowserNativeControlNotice = BrowserNativeOwnerNotice | BrowserNativeWorkspaceStatus
  | BrowserNativeWorkspaceLease | BrowserNativeWorkspaceLeaseReleased | BrowserNativePagehideAck

export interface BrowserNativeControlReadyFrame {
  readonly type: 'control-ready'
  readonly protocolVersion: typeof BROWSER_NATIVE_CONTROL_PROTOCOL_VERSION
  readonly channelId: string
  readonly seq: 0
}

export interface BrowserNativeControlNoticeFrame {
  readonly type: 'control-frame'
  readonly protocolVersion: typeof BROWSER_NATIVE_CONTROL_PROTOCOL_VERSION
  readonly channelId: string
  readonly seq: number
  readonly notice: BrowserNativeControlNotice
}

export type BrowserNativeControlFrame = BrowserNativeControlReadyFrame | BrowserNativeControlNoticeFrame

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isNotice(value: unknown): value is BrowserNativeControlNotice {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'owner' || value.type === 'released' || value.type === 'unavailable') {
    return typeof value.sessionId === 'string' && value.sessionId.length > 0
      && (value.ownerToken === undefined || typeof value.ownerToken === 'string')
      && (value.ownerEpoch === undefined || (typeof value.ownerEpoch === 'number' && Number.isSafeInteger(value.ownerEpoch)))
      && (value.message === undefined || typeof value.message === 'string')
  }
  if (value.type === 'workspace') {
    return ['loading', 'synced', 'dirty', 'syncing', 'error', 'conflict', 'local-corrupt', 'local-newer-version', 'lease-conflict'].includes(String(value.state))
      && typeof value.dirtyCount === 'number' && Number.isSafeInteger(value.dirtyCount) && value.dirtyCount >= 0
      && (value.workspaceId === undefined || typeof value.workspaceId === 'string')
      && (value.revision === undefined || (typeof value.revision === 'number' && Number.isSafeInteger(value.revision)))
      && (value.message === undefined || typeof value.message === 'string')
      && (value.retryAfterMs === undefined || (typeof value.retryAfterMs === 'number' && Number.isSafeInteger(value.retryAfterMs)))
  }
  if (value.type === 'workspace-lease') {
    return typeof value.workspaceId === 'string' && value.workspaceId.length > 0
      && typeof value.writerToken === 'string' && value.writerToken.length > 0
      && typeof value.fencingToken === 'number' && Number.isSafeInteger(value.fencingToken) && value.fencingToken >= 0
  }
  if (value.type === 'workspace-lease-released') {
    return typeof value.workspaceId === 'string' && value.workspaceId.length > 0
  }
  if (value.type === 'pagehide-ack') {
    return isUuid(value.requestId) && typeof value.localPersisted === 'boolean'
      && typeof value.writerReleased === 'boolean'
      && (value.error === undefined || typeof value.error === 'string')
  }
  return false
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function isBrowserNativeControlFrame(value: unknown): value is BrowserNativeControlFrame {
  if (!isRecord(value) || value.protocolVersion !== BROWSER_NATIVE_CONTROL_PROTOCOL_VERSION
    || typeof value.channelId !== 'string' || !isUuid(value.channelId)
    || typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq)) return false
  if (value.type === 'control-ready') return value.seq === 0
  return value.type === 'control-frame' && value.seq > 0 && isNotice(value.notice)
}

export type BrowserNativeControlReceiveResult =
  | { readonly kind: 'ready'; readonly frame: BrowserNativeControlReadyFrame }
  | { readonly kind: 'notice'; readonly frame: BrowserNativeControlNoticeFrame }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'invalid'; readonly reason: string }

/** Enforces one control-channel baseline and a contiguous, deduplicated sequence. */
export class BrowserNativeControlReceiver {
  private channelId: string | undefined
  private nextSeq = 0
  private readonly seen = new Map<number, string>()
  private invalid = false

  receive(value: unknown): BrowserNativeControlReceiveResult {
    if (!isBrowserNativeControlFrame(value)) return this.reject('CONTROL_FRAME_INVALID')
    if (this.invalid) return { kind: 'invalid', reason: 'CONTROL_CHANNEL_INVALID' }
    if (value.type === 'control-ready') {
      if (this.channelId === undefined && this.nextSeq === 0) {
        this.channelId = value.channelId
        this.seen.set(0, stableJson(value))
        return { kind: 'ready', frame: value }
      }
      return this.reject('CONTROL_BASELINE_REPEATED')
    }
    if (this.channelId === undefined) return this.reject('CONTROL_BASELINE_MISSING')
    if (value.channelId !== this.channelId) return this.reject('CONTROL_CHANNEL_CHANGED')
    const encoded = stableJson(value)
    const prior = this.seen.get(value.seq)
    if (prior !== undefined) return prior === encoded ? { kind: 'duplicate' } : this.reject('CONTROL_SEQUENCE_CONFLICT')
    if (value.seq !== this.nextSeq + 1) return this.reject('CONTROL_SEQUENCE_GAP')
    this.nextSeq = value.seq
    this.seen.set(value.seq, encoded)
    if (this.seen.size > 256) {
      const oldest = this.seen.keys().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    return { kind: 'notice', frame: value }
  }

  private reject(reason: string): BrowserNativeControlReceiveResult {
    this.invalid = true
    return { kind: 'invalid', reason }
  }
}
