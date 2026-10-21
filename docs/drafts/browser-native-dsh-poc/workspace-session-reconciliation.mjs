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

export function classifyWorkspaceSession({ workspaceStatus, sessionStatus }) {
  if (workspaceStatus === 'committed' && sessionStatus === 'committed') return 'reconciled'
  if (workspaceStatus === 'committed' && sessionStatus === 'pending') return 'workspace-committed-session-pending'
  if (workspaceStatus === 'pending' && sessionStatus === 'committed') return 'session-committed-workspace-pending'
  if (workspaceStatus === 'unknown' || sessionStatus === 'unknown') return 'result-unknown'
  if (workspaceStatus === 'conflict' || sessionStatus === 'conflict') return 'conflict'
  return 'not-reconciled'
}
