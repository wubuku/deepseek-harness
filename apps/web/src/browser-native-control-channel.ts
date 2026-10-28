/**
 * Versioned page/Worker control frames for Browser-Native lifecycle state.
 * Session events use the DSH Session log and do not pass through this channel.
 */

export const BROWSER_NATIVE_CONTROL_PROTOCOL_VERSION = 1
/** Maximum UTF-8 size of one serialized control frame. */
export const BROWSER_NATIVE_CONTROL_MAX_FRAME_BYTES = 16 * 1024
/** Maximum UTF-8 size of any free-form control notice text. */
export const BROWSER_NATIVE_CONTROL_MAX_TEXT_BYTES = 4 * 1024

const MAX_IDENTIFIER_BYTES = 256
const MAX_TOKEN_BYTES = 512

/** Page-visible Session owner lifecycle notices. */
export type BrowserNativeOwnerNotice =
  | {
    readonly type: 'owner'
    readonly sessionId: string
    readonly ownerToken: string
    readonly ownerEpoch: number
  }
  | { readonly type: 'released'; readonly sessionId: string }
  | { readonly type: 'unavailable'; readonly sessionId: string; readonly message: string }

export interface BrowserNativeWorkspaceStatus {
  readonly type: 'workspace'
  readonly state: 'loading' | 'synced' | 'dirty' | 'syncing' | 'error' | 'conflict'
    | 'local-corrupt' | 'local-newer-version' | 'lease-conflict' | 'recovery-conflict' | 'recovery-unavailable'
    | 'identity-missing' | 'identity-mismatch' | 'read-only' | 'stale'
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key))
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string' || value.length > maxBytes) return false
  return new TextEncoder().encode(value).byteLength <= maxBytes
}

function hasBoundedOptionalString(value: Record<string, unknown>, key: string, maxBytes: number): boolean {
  return !Object.hasOwn(value, key) || isBoundedString(value[key], maxBytes)
}

function hasBoundedOptionalInteger(value: Record<string, unknown>, key: string, minimum: number): boolean {
  if (!Object.hasOwn(value, key)) return true
  const field = value[key]
  return typeof field === 'number' && Number.isSafeInteger(field) && field >= minimum
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isNotice(value: unknown): value is BrowserNativeControlNotice {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'owner') {
    return hasExactKeys(value, ['type', 'sessionId', 'ownerToken', 'ownerEpoch'])
      && isBoundedString(value.sessionId, MAX_IDENTIFIER_BYTES) && value.sessionId.length > 0
      && isBoundedString(value.ownerToken, MAX_TOKEN_BYTES) && value.ownerToken.length > 0
      && typeof value.ownerEpoch === 'number' && Number.isSafeInteger(value.ownerEpoch) && value.ownerEpoch >= 0
  }
  if (value.type === 'released') {
    return hasExactKeys(value, ['type', 'sessionId'])
      && isBoundedString(value.sessionId, MAX_IDENTIFIER_BYTES) && value.sessionId.length > 0
  }
  if (value.type === 'unavailable') {
    return hasExactKeys(value, ['type', 'sessionId', 'message'])
      && isBoundedString(value.sessionId, MAX_IDENTIFIER_BYTES) && value.sessionId.length > 0
      && isBoundedString(value.message, BROWSER_NATIVE_CONTROL_MAX_TEXT_BYTES)
  }
  if (value.type === 'workspace') {
    return hasExactKeys(value, ['type', 'state', 'dirtyCount'], ['workspaceId', 'revision', 'message', 'retryAfterMs'])
      && typeof value.state === 'string'
      && ['loading', 'synced', 'dirty', 'syncing', 'error', 'conflict', 'local-corrupt', 'local-newer-version', 'lease-conflict', 'recovery-conflict', 'recovery-unavailable', 'identity-missing', 'identity-mismatch', 'read-only', 'stale'].includes(value.state)
      && typeof value.dirtyCount === 'number' && Number.isSafeInteger(value.dirtyCount) && value.dirtyCount >= 0
      && hasBoundedOptionalString(value, 'workspaceId', MAX_IDENTIFIER_BYTES)
      && hasBoundedOptionalInteger(value, 'revision', 0)
      && hasBoundedOptionalString(value, 'message', BROWSER_NATIVE_CONTROL_MAX_TEXT_BYTES)
      && hasBoundedOptionalInteger(value, 'retryAfterMs', 0)
  }
  if (value.type === 'workspace-lease') {
    return hasExactKeys(value, ['type', 'workspaceId', 'writerToken', 'fencingToken'])
      && isBoundedString(value.workspaceId, MAX_IDENTIFIER_BYTES) && value.workspaceId.length > 0
      && isBoundedString(value.writerToken, MAX_TOKEN_BYTES) && value.writerToken.length > 0
      && typeof value.fencingToken === 'number' && Number.isSafeInteger(value.fencingToken) && value.fencingToken >= 0
  }
  if (value.type === 'workspace-lease-released') {
    return hasExactKeys(value, ['type', 'workspaceId'])
      && isBoundedString(value.workspaceId, MAX_IDENTIFIER_BYTES) && value.workspaceId.length > 0
  }
  if (value.type === 'pagehide-ack') {
    return hasExactKeys(value, ['type', 'requestId', 'localPersisted', 'writerReleased'], ['error'])
      && isUuid(value.requestId) && typeof value.localPersisted === 'boolean'
      && typeof value.writerReleased === 'boolean'
      && hasBoundedOptionalString(value, 'error', BROWSER_NATIVE_CONTROL_MAX_TEXT_BYTES)
  }
  return false
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

/** Validate exact fields, values, and serialized byte limits before projection.
 * @param value The structured-clone value received from the Worker.
 * @returns Whether the value is a supported, bounded control frame.
 */
export function isBrowserNativeControlFrame(value: unknown): value is BrowserNativeControlFrame {
  return browserNativeControlFrameError(value) === undefined
}

function browserNativeControlFrameError(value: unknown): string | undefined {
  if (!isPlainRecord(value)) return 'CONTROL_FRAME_INVALID'
  if (value.type !== 'control-ready' && value.type !== 'control-frame') return 'CONTROL_FRAME_UNSUPPORTED'
  if (value.protocolVersion !== BROWSER_NATIVE_CONTROL_PROTOCOL_VERSION) return 'CONTROL_PROTOCOL_UNSUPPORTED'
  if (typeof value.channelId !== 'string' || !isUuid(value.channelId)
    || typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq)) return 'CONTROL_FRAME_INVALID'
  if (value.type === 'control-ready') {
    return hasExactKeys(value, ['type', 'protocolVersion', 'channelId', 'seq']) && value.seq === 0
      ? undefined
      : 'CONTROL_FRAME_INVALID'
  }
  if (!hasExactKeys(value, ['type', 'protocolVersion', 'channelId', 'seq', 'notice']) || value.seq <= 0) {
    return 'CONTROL_FRAME_INVALID'
  }
  if (!isPlainRecord(value.notice) || typeof value.notice.type !== 'string') return 'CONTROL_FRAME_INVALID'
  const knownNotice = ['owner', 'released', 'unavailable', 'workspace', 'workspace-lease', 'workspace-lease-released', 'pagehide-ack']
  if (!knownNotice.includes(value.notice.type)) return 'CONTROL_NOTICE_UNSUPPORTED'
  if (!isNotice(value.notice)) return hasOversizedNoticeString(value.notice) ? 'CONTROL_FIELD_TOO_LARGE' : 'CONTROL_FRAME_INVALID'
  try {
    const serialized = JSON.stringify(value)
    return new TextEncoder().encode(serialized).byteLength <= BROWSER_NATIVE_CONTROL_MAX_FRAME_BYTES
      ? undefined
      : 'CONTROL_FRAME_TOO_LARGE'
  } catch {
    return 'CONTROL_FRAME_INVALID'
  }
}

function hasOversizedNoticeString(value: Record<string, unknown>): boolean {
  for (const key of ['sessionId', 'workspaceId']) {
    if (typeof value[key] === 'string' && !isBoundedString(value[key], MAX_IDENTIFIER_BYTES)) return true
  }
  for (const key of ['ownerToken', 'writerToken']) {
    if (typeof value[key] === 'string' && !isBoundedString(value[key], MAX_TOKEN_BYTES)) return true
  }
  for (const key of ['message', 'error']) {
    if (typeof value[key] === 'string' && !isBoundedString(value[key], BROWSER_NATIVE_CONTROL_MAX_TEXT_BYTES)) return true
  }
  return false
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
    if (!isBrowserNativeControlFrame(value)) return this.reject(browserNativeControlFrameError(value) ?? 'CONTROL_FRAME_INVALID')
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
