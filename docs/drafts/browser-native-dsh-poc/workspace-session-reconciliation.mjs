const RECEIPT_STATUSES = new Set(['pending', 'committed', 'unknown', 'conflict', 'failed'])

export function createWorkspaceReceipt(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('workspace receipt must be an object')
  const receipt = {
    operationId: value.operationId,
    workspaceId: value.workspaceId,
    baseRevision: value.baseRevision,
    revision: value.revision,
    manifestDigest: value.manifestDigest,
    paths: value.paths,
    status: value.status,
  }
  if (typeof receipt.operationId !== 'string' || typeof receipt.workspaceId !== 'string'
    || !Number.isSafeInteger(receipt.baseRevision) || receipt.baseRevision < 0
    || (receipt.revision !== undefined && (!Number.isSafeInteger(receipt.revision) || receipt.revision < 0))
    || typeof receipt.manifestDigest !== 'string' || !Array.isArray(receipt.paths)
    || receipt.paths.some(path => typeof path !== 'string') || !RECEIPT_STATUSES.has(receipt.status)) {
    throw new Error('workspace receipt is invalid')
  }
  return Object.freeze({ ...receipt, paths: Object.freeze([...receipt.paths]) })
}

/**
 * Compare a persisted Session receipt with its local Workspace operation.
 * @param {object} eventData - Persisted Browser-Native receipt event data.
 * @param {object} receipt - Durable Workspace commit receipt and originating tool call.
 * @param {string} sessionId - Session whose log contains the event.
 * @returns {boolean} Whether every call and commit identity field matches.
 */
export function matchesWorkspaceReceipt(eventData, receipt, sessionId) {
  const operation = receipt?.operation
  return operation !== undefined
    && operation.sessionId === sessionId
    && eventData.turn === operation.turn
    && eventData.step === operation.step
    && eventData.callId === operation.callId
    && eventData.toolName === operation.toolName
    && eventData.toolCallSeq === operation.toolCallSeq
    && eventData.operationId === receipt.operationId
    && eventData.workspaceId === receipt.workspaceId
    && eventData.baseRevision === receipt.baseRevision
    && eventData.revision === receipt.revision
    && eventData.manifestDigest === receipt.manifestDigest
    && eventData.replayed === receipt.replayed
    && Array.isArray(eventData.paths)
    && eventData.paths.length === receipt.paths.length
    && eventData.paths.every((path, index) => path === receipt.paths[index])
}

export function classifyWorkspaceSession({ workspaceStatus, sessionStatus }) {
  if (workspaceStatus === 'committed' && sessionStatus === 'committed') return 'reconciled'
  if (workspaceStatus === 'committed' && sessionStatus === 'pending') return 'workspace-committed-session-pending'
  if (workspaceStatus === 'pending' && sessionStatus === 'committed') return 'session-committed-workspace-pending'
  if (workspaceStatus === 'unknown' || sessionStatus === 'unknown') return 'result-unknown'
  if (workspaceStatus === 'conflict' || sessionStatus === 'conflict') return 'conflict'
  return 'not-reconciled'
}
