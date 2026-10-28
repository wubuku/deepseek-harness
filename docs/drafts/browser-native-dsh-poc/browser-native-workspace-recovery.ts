/** Pre-boot recovery rejects mixed revisions and validates acknowledgements without replaying file effects. */
import { Sha256 } from './browser-native-sha256.ts'
import type { PendingBatch, WorkspaceReceipt } from './browser-native-workspace.ts'
import type { DurableWorkspaceSnapshot } from './browser-native-workspace-store.ts'

/** A recovery decision that requires retaining local data and stopping dependent file tools. */
export class WorkspaceRecoveryError extends Error {
  constructor(readonly code: 'WORKSPACE_RECOVERY_CONFLICT' | 'WORKSPACE_RECOVERY_UNKNOWN' | 'WORKSPACE_RECOVERY_INVALID', message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** An unavailable status query never implies that a commit did not happen. */
export type WorkspaceOperationStatus =
  | { readonly state: 'absent' }
  | { readonly state: 'committed'; readonly receipt: WorkspaceReceipt }
  | { readonly state: 'unknown'; readonly cause: unknown }

function digest(bytes: Uint8Array): string {
  return new Sha256().update(bytes).digestHex()
}

/** Compute the backend's canonical request digest from retained changes, without reading current VFS paths.
 * @param batch - Original operation and immutable local content or verified content references.
 * @returns SHA-256 of the canonical base revision and wire changes.
 */
export function workspaceRequestDigest(batch: PendingBatch): string {
  const changes = batch.changes.map(change => {
    if (change.deleted === true) return { path: change.path, deleted: true }
    if (change.kind === 'directory') return { path: change.path, kind: 'directory', mode: change.mode }
    if (change.contentReference === undefined && change.content === undefined) {
      throw new WorkspaceRecoveryError('WORKSPACE_RECOVERY_INVALID', 'Retained operation has no verifiable file content; download the local recovery bundle')
    }
    return { path: change.path, kind: 'file', hash: change.contentReference?.hash ?? digest(change.content!),
      bytes: change.contentReference?.bytes ?? change.content!.byteLength, mode: change.mode }
  }).sort((left, right) => left.path.localeCompare(right.path))
  return digest(new TextEncoder().encode(JSON.stringify({ baseRevision: batch.baseRevision, changes })))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate operation identity, request bytes and receipt fields at the HTTP response boundary.
 * @param value - Successful operation-status JSON response.
 * @param workspaceId - Authorized Workspace being restored.
 * @param batch - Original local retry whose result is being queried.
 * @returns Confirmed absence or a receipt tied to the exact original request.
 * @throws WorkspaceRecoveryError when the backend cannot establish the requested operation's identity.
 */
export function decodeWorkspaceOperation(value: Record<string, unknown>, workspaceId: string, batch: PendingBatch): Exclude<WorkspaceOperationStatus, { state: 'unknown' }> {
  const invalid = (): never => {
    throw new WorkspaceRecoveryError('WORKSPACE_RECOVERY_INVALID', 'Operation status does not match retained Workspace changes; retain local data and download the recovery bundle')
  }
  if (value.workspaceId !== workspaceId || value.operationId !== batch.operationId) return invalid()
  if (value.found === false) return { state: 'absent' }
  if (value.found !== true || value.requestDigest !== workspaceRequestDigest(batch) || !isRecord(value.receipt)) return invalid()
  const receipt = value.receipt
  const paths = batch.changes.map(change => change.path).sort()
  if (receipt.workspaceId !== workspaceId || receipt.operationId !== batch.operationId
    || receipt.revision !== batch.baseRevision + 1 || typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest)
    || !Array.isArray(receipt.changedPaths) || receipt.changedPaths.some(path => typeof path !== 'string')
    || JSON.stringify([...receipt.changedPaths].sort()) !== JSON.stringify(paths)) return invalid()
  return { state: 'committed', receipt: {
    workspaceId, operationId: batch.operationId, baseRevision: batch.baseRevision, revision: batch.baseRevision + 1,
    manifestDigest: receipt.digest, paths, replayed: true,
    ...(batch.operation === undefined ? {} : { operation: batch.operation }),
  } }
}

/** Select a single remote baseline before any hydration, GC or local snapshot replacement.
 * @param snapshot - Verified original local snapshot, retained unchanged on rejection.
 * @param remoteRevision - Current manifest revision observed during startup.
 * @param status - Required result when a retry is present; unknown rejects recovery.
 * @returns Snapshot to replay in separate retry and pending layers. A committed retry is removed and its linked receipt retained.
 * @throws WorkspaceRecoveryError for divergent/rolled-back baselines or an unconfirmed operation result.
 */
export function resolveWorkspaceRecovery(
  snapshot: DurableWorkspaceSnapshot,
  remoteRevision: number,
  status?: WorkspaceOperationStatus,
): DurableWorkspaceSnapshot {
  const retry = snapshot.retryBatch
  if (retry !== undefined && (status === undefined || status.state === 'unknown')) {
    const cause = status?.state === 'unknown' ? status.cause : undefined
    if (cause instanceof WorkspaceRecoveryError) throw cause
    throw new WorkspaceRecoveryError('WORKSPACE_RECOVERY_UNKNOWN', 'Workspace commit status is unknown; local data is retained. Restore connectivity and reload, or download the recovery bundle', { cause })
  }
  const receipt = status?.state === 'committed' ? status.receipt : undefined
  const baseline = receipt?.revision ?? retry?.baseRevision ?? snapshot.revision
  if (remoteRevision < baseline || ((retry !== undefined && receipt === undefined || snapshot.pending.length > 0) && remoteRevision !== baseline)) {
    throw new WorkspaceRecoveryError('WORKSPACE_RECOVERY_CONFLICT', 'Local Workspace changes use a different remote revision; startup is stopped and local data is retained. Download the recovery bundle before resolving the conflict')
  }
  if (retry === undefined || receipt === undefined) return snapshot
  const receipts = [...(snapshot.receipts ?? [])]
  if (receipt.operation !== undefined && !receipts.some(item => item.operationId === receipt.operationId)) receipts.push(receipt)
  return { version: 1, workspaceId: snapshot.workspaceId, revision: remoteRevision, pending: snapshot.pending,
    ...(receipts.length === 0 ? {} : { receipts }) }
}
