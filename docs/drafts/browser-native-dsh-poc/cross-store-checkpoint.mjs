import { createHash } from 'node:crypto'

export const CROSS_STORE_STATUSES = Object.freeze(['pending', 'committed', 'unknown', 'conflict', 'failed'])
export const CROSS_STORE_RECEIPT_KINDS = Object.freeze(['workspace', 'session', 'business'])

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function record(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

function id(value, name) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID`)
  return value
}

function text(value, name, maximum = 200) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new Error(`${name} is invalid`)
  return value
}

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}

function nonNegative(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return value
}

function status(value, name) {
  if (!CROSS_STORE_STATUSES.includes(value)) throw new Error(`${name} is invalid`)
  return value
}

export function digestCrossStoreValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function createCrossStoreIdentity(value) {
  record(value, 'operation identity')
  return Object.freeze({
    operationId: id(value.operationId, 'operationId'),
    principalId: id(value.principalId, 'principalId'),
    sessionId: id(value.sessionId, 'sessionId'),
    workspaceId: id(value.workspaceId, 'workspaceId'),
    ownerEpoch: positive(value.ownerEpoch, 'ownerEpoch'),
    workspaceFencingToken: positive(value.workspaceFencingToken, 'workspaceFencingToken'),
    turn: positive(value.turn, 'turn'),
    step: positive(value.step, 'step'),
    callId: text(value.callId, 'callId'),
    toolName: text(value.toolName, 'toolName', 100),
    toolCallSeq: positive(value.toolCallSeq, 'toolCallSeq'),
  })
}

export function createCrossStoreIntent(value) {
  record(value, 'operation intent')
  const identity = createCrossStoreIdentity(value)
  return Object.freeze({
    ...identity,
    operationKind: text(value.operationKind, 'operationKind', 100),
    payloadDigest: text(value.payloadDigest, 'payloadDigest', 128),
    ...(value.payloadBytes === undefined ? {} : { payloadBytes: nonNegative(value.payloadBytes, 'payloadBytes') }),
  })
}

export function createCrossStoreCheckpoint(value) {
  record(value, 'checkpoint')
  const checkpoint = {
    operationId: id(value.operationId, 'operationId'),
    sessionId: id(value.sessionId, 'sessionId'),
    workspaceId: id(value.workspaceId, 'workspaceId'),
    ownerEpoch: positive(value.ownerEpoch, 'ownerEpoch'),
    workspaceFencingToken: positive(value.workspaceFencingToken, 'workspaceFencingToken'),
    nextSessionSeq: nonNegative(value.nextSessionSeq, 'nextSessionSeq'),
    durableThroughSeq: value.durableThroughSeq === undefined ? undefined : nonNegative(value.durableThroughSeq, 'durableThroughSeq'),
    workspaceRevision: nonNegative(value.workspaceRevision, 'workspaceRevision'),
    workspaceStatus: status(value.workspaceStatus, 'workspaceStatus'),
    sessionStatus: status(value.sessionStatus, 'sessionStatus'),
    businessStatus: status(value.businessStatus, 'businessStatus'),
  }
  if (checkpoint.durableThroughSeq !== undefined && checkpoint.durableThroughSeq > checkpoint.nextSessionSeq) {
    throw new Error('durableThroughSeq cannot exceed nextSessionSeq')
  }
  return Object.freeze(checkpoint)
}

export function reconcileCrossStoreState(value) {
  record(value, 'reconciliation state')
  const workspaceStatus = status(value.workspaceStatus, 'workspaceStatus')
  const sessionStatus = status(value.sessionStatus, 'sessionStatus')
  const businessStatus = status(value.businessStatus, 'businessStatus')
  const statuses = [workspaceStatus, sessionStatus, businessStatus]
  if (statuses.includes('conflict')) return 'conflict'
  if (statuses.includes('unknown')) return 'unknown'
  if (statuses.includes('failed')) return 'failed'
  if (statuses.every(item => item === 'committed')) return 'reconciled'
  if (businessStatus === 'pending') return 'business-pending'
  if (workspaceStatus === 'committed' && sessionStatus === 'pending') return 'workspace-committed-session-pending'
  if (workspaceStatus === 'pending' && sessionStatus === 'committed') return 'session-committed-workspace-pending'
  return 'pending'
}

export function reconcileCrossStoreRecord(recordValue) {
  record(recordValue, 'operation record')
  const identity = createCrossStoreIdentity(recordValue.identity)
  const receipts = recordValue.receipts ?? {}
  const result = reconcileCrossStoreState({
    workspaceStatus: receipts.workspace?.status ?? 'pending',
    sessionStatus: receipts.session?.status ?? 'pending',
    businessStatus: receipts.business?.status ?? 'pending',
  })
  return {
    operationId: identity.operationId,
    identity,
    decision: result,
    statuses: {
      workspace: receipts.workspace?.status ?? 'pending',
      session: receipts.session?.status ?? 'pending',
      business: receipts.business?.status ?? 'pending',
    },
  }
}
