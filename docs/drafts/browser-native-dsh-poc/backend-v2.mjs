/**
 * Backend for the browser-native DSH v2 PoC.
 *
 * It serves the already-built DSH preview surface, stores formal Session
 * headers/events, and proxies the Worker-side LLM adapter to a scripted model
 * or an OpenAI-compatible upstream. Credentials are loaded only in this Node
 * process and are never included in responses or logs.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { relative, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { WORKSPACE_BLOB_CHUNK_BYTES, WORKSPACE_CONTENT_LAYOUT, WorkspaceError, WorkspaceStore } from './workspace-v2.mjs'
import { SESSION_APPEND_MAX_BYTES, SESSION_APPEND_MAX_EVENTS } from './session-transport-limits.mjs'
import { CrossStoreLedgerError, CrossStoreOperationLedger } from './cross-store-operation-ledger.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PROTOCOL_VERSION = 1
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_WORKSPACE_CHUNK_BODY_BYTES = WORKSPACE_BLOB_CHUNK_BYTES
const MAX_EVENTS = 100_000
const MAX_SESSION_READ_EVENTS = 2_048
const MAX_SESSION_READ_BYTES = 2 * 1024 * 1024
const MAX_CATALOG_PAGE_SIZE = 100
const MAX_HANDOFF_ID_LENGTH = 200
const MAX_CHECKPOINT_IDS = 1_000
const MAX_CHECKPOINT_ID_LENGTH = 200
const DEFAULT_OWNER_LEASE_MS = 30_000
const DEFAULT_LLM_TIMEOUT_MS = 60_000
const DATA_DIR_LOCK_NAME = '.browser-native-backend.lock'
const PRINCIPAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

class BackendError extends Error {
  constructor(code, message, status = 400, retryAfterMs) {
    super(message)
    this.name = 'BackendError'
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

function clone(value) {
  return structuredClone(value)
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)
}

function fullDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function assertSessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value) || value.length === 0 || value.length > 200) {
    throw new BackendError('INVALID_REQUEST', 'session id is invalid')
  }
  return value
}

function assertRecord(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BackendError('INVALID_REQUEST', `${name} must be an object`)
  }
  return value
}

function timeoutMs(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}

function assertProtocol(body) {
  assertRecord(body, 'request')
  if (body.protocolVersion !== PROTOCOL_VERSION) throw new BackendError('PROTOCOL_UNSUPPORTED', 'unsupported browser-native protocol')
  if (typeof body.requestId !== 'string' || body.requestId.length === 0 || body.requestId.length > 200) throw new BackendError('INVALID_REQUEST', 'requestId is required and must be at most 200 characters')
}

function boundedInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new BackendError('INVALID_REQUEST', `${name} must be a non-negative safe integer at most ${maximum}`)
  }
  return value
}

function boundedString(value, name, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new BackendError('INVALID_REQUEST', `${name} must be a non-empty string at most ${maximum} characters`)
  }
  return value
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function catalogCursorFor(principalId, sessionId) {
  return Buffer.from(JSON.stringify({ version: 1, principalId, sessionId }), 'utf8').toString('base64url')
}

function sessionIdFromCatalogCursor(cursor, principalId) {
  boundedString(cursor, 'cursor', 400)
  let value
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new BackendError('INVALID_REQUEST', 'cursor is invalid')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || value.principalId !== principalId) {
    throw new BackendError('INVALID_REQUEST', 'cursor is invalid')
  }
  assertSessionId(value.sessionId)
  if (catalogCursorFor(principalId, value.sessionId) !== cursor) throw new BackendError('INVALID_REQUEST', 'cursor is invalid')
  return value.sessionId
}

function assertPrincipalId(value) {
  if (typeof value !== 'string' || !PRINCIPAL_ID_PATTERN.test(value)) {
    throw new BackendError('IDENTITY_INVALID', 'Session principal id is invalid', 500)
  }
  return value
}

function checkpointFingerprint(checkpoint) {
  return JSON.stringify({
    sessionId: checkpoint.sessionId,
    ownerId: checkpoint.ownerId,
    epoch: checkpoint.epoch,
    nextSessionSeq: checkpoint.nextSessionSeq,
    workspaceRevision: checkpoint.workspaceRevision,
    pendingOperationIds: checkpoint.pendingOperationIds,
    pendingExecutionIds: checkpoint.pendingExecutionIds,
    durableThroughSeq: checkpoint.durableThroughSeq,
    workspaceId: checkpoint.workspaceId,
    workspaceFencingToken: checkpoint.workspaceFencingToken,
    pendingWorkspaceReceipts: checkpoint.pendingWorkspaceReceipts,
    pendingSessionEvents: checkpoint.pendingSessionEvents,
  })
}

function ownerTokenDigest(ownerToken) {
  return createHash('sha256').update(ownerToken).digest('hex')
}

function matchesOwnerTokenDigest(ownerToken, expectedDigest) {
  if (typeof ownerToken !== 'string' || typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) return false
  return timingSafeEqual(Buffer.from(ownerTokenDigest(ownerToken), 'hex'), Buffer.from(expectedDigest, 'hex'))
}

function normalizeHandoffRecord(handoffId, record) {
  const receipt = record?.receipt
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error(`Session handoff ${handoffId} has an invalid receipt`)
  }
  if (receipt.previous?.ownerToken === undefined && receipt.next?.ownerToken === undefined) {
    if (typeof record.previousOwnerTokenDigest !== 'string') throw new Error(`Session handoff ${handoffId} has no previous owner digest`)
    return { record, migrated: false }
  }
  const previousOwnerToken = receipt.previous?.ownerToken
  if (typeof previousOwnerToken !== 'string' || previousOwnerToken.length === 0) {
    throw new Error(`Session handoff ${handoffId} cannot migrate its previous owner token`)
  }
  return {
    record: {
      fingerprint: record.fingerprint,
      previousOwnerTokenDigest: ownerTokenDigest(previousOwnerToken),
      receipt: {
        sessionId: receipt.sessionId,
        previousOwnerEpoch: receipt.previous?.ownerEpoch,
        ownerEpoch: receipt.next?.ownerEpoch,
        checkpoint: receipt.checkpoint,
        handoffId: receipt.handoffId,
        durabilityReceipt: receipt.durabilityReceipt,
      },
    },
    migrated: true,
  }
}

function validateHandoffCheckpoint(session, checkpoint, ownerToken, ownerEpoch, requireCurrent = true) {
  assertRecord(checkpoint, 'checkpoint')
  const expectedKeys = new Set(['sessionId', 'ownerId', 'epoch', 'nextSessionSeq', 'workspaceRevision', 'pendingOperationIds', 'pendingExecutionIds'])
  const optionalKeys = ['durableThroughSeq', 'workspaceId', 'workspaceFencingToken', 'pendingWorkspaceReceipts', 'pendingSessionEvents']
  for (const key of optionalKeys) expectedKeys.add(key)
  for (const key of Object.keys(checkpoint)) {
    if (!expectedKeys.has(key)) throw new BackendError('CHECKPOINT_INVALID', `checkpoint field ${key} is not supported`)
  }
  if (checkpoint.sessionId !== session.id) throw new BackendError('CHECKPOINT_INVALID', 'checkpoint sessionId does not match the Session')
  boundedString(checkpoint.ownerId, 'checkpoint.ownerId', MAX_CHECKPOINT_ID_LENGTH)
  if (checkpoint.epoch !== ownerEpoch) throw new BackendError('CHECKPOINT_INVALID', 'checkpoint epoch does not match the current owner')
  boundedInteger(checkpoint.nextSessionSeq, 'checkpoint.nextSessionSeq', MAX_EVENTS)
  if (requireCurrent && checkpoint.nextSessionSeq !== session.events.length) throw new BackendError('CHECKPOINT_INVALID', 'checkpoint nextSessionSeq is not the current Session cursor')
  boundedInteger(checkpoint.workspaceRevision, 'checkpoint.workspaceRevision', Number.MAX_SAFE_INTEGER)
  const hasExecutionCheckpoint = optionalKeys.some(key => Object.hasOwn(checkpoint, key))
  if (hasExecutionCheckpoint) {
    if (!Number.isSafeInteger(checkpoint.durableThroughSeq) || checkpoint.durableThroughSeq < -1
      || checkpoint.durableThroughSeq >= MAX_EVENTS) {
      throw new BackendError('CHECKPOINT_INVALID', 'checkpoint.durableThroughSeq is invalid')
    }
    if (checkpoint.durableThroughSeq !== checkpoint.nextSessionSeq - 1) {
      throw new BackendError('CHECKPOINT_INVALID', 'checkpoint Session durability watermark does not cover its cursor')
    }
    boundedString(checkpoint.workspaceId, 'checkpoint.workspaceId', MAX_CHECKPOINT_ID_LENGTH)
    if (!Number.isSafeInteger(checkpoint.workspaceFencingToken) || checkpoint.workspaceFencingToken < 1) {
      throw new BackendError('CHECKPOINT_INVALID', 'checkpoint.workspaceFencingToken is invalid')
    }
    boundedInteger(checkpoint.pendingWorkspaceReceipts, 'checkpoint.pendingWorkspaceReceipts', MAX_CHECKPOINT_IDS)
    boundedInteger(checkpoint.pendingSessionEvents, 'checkpoint.pendingSessionEvents', MAX_CHECKPOINT_IDS)
    if (checkpoint.pendingWorkspaceReceipts > 0 || checkpoint.pendingSessionEvents > 0) {
      throw new BackendError('HANDOFF_BUSY', 'checkpoint has pending Workspace receipts or Session outbox events', 409)
    }
  }
  for (const name of ['pendingOperationIds', 'pendingExecutionIds']) {
    const values = checkpoint[name]
    if (!Array.isArray(values) || values.length > MAX_CHECKPOINT_IDS) throw new BackendError('CHECKPOINT_INVALID', `${name} must contain at most ${MAX_CHECKPOINT_IDS} ids`)
    for (const value of values) boundedString(value, `${name} item`, MAX_CHECKPOINT_ID_LENGTH)
    if (requireCurrent && values.length > 0) {
      throw new BackendError('HANDOFF_BUSY', `${name} must be empty before ownership can be handed off`, 409)
    }
  }
  boundedString(ownerToken, 'ownerToken', 200)
  return clone(checkpoint)
}

function invalidHandoffState(message) {
  throw new BackendError('HANDOFF_STATE_INVALID', message, 409)
}

function positiveEventInteger(value, field, eventType) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalidHandoffState(`${eventType} has an invalid ${field}`)
  }
  return value
}

function handoffToolCallKey(turn, step, callId) {
  return JSON.stringify([turn, step, callId])
}

function handoffEventData(event, eventType) {
  if (event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) {
    invalidHandoffState(`${eventType} has no event data`)
  }
  return event.data
}

function assertHandoffQuiescent(session) {
  let activeTurn
  let activeStep
  let previousTurn = 0
  let previousStep = 0
  const pendingCalls = new Map()
  const settledCalls = new Map()

  for (const [index, event] of session.events.entries()) {
    if (event === null || typeof event !== 'object' || event.seq !== index || typeof event.type !== 'string') {
      invalidHandoffState(`Session event ${index} has an invalid envelope`)
    }

    switch (event.type) {
      case 'turn/start': {
        const data = handoffEventData(event, event.type)
        const turn = positiveEventInteger(data.turn, 'turn', event.type)
        if (activeTurn !== undefined || turn <= previousTurn) invalidHandoffState('turn/start is out of order')
        activeTurn = turn
        previousTurn = turn
        previousStep = 0
        break
      }
      case 'turn/end': {
        const data = handoffEventData(event, event.type)
        const turn = positiveEventInteger(data.turn, 'turn', event.type)
        if (activeTurn !== turn || activeStep !== undefined) invalidHandoffState('turn/end has no matching closed turn')
        if ([...pendingCalls.values()].some(call => call.turn === turn)) {
          invalidHandoffState('turn/end closes a turn with unsettled tool calls')
        }
        activeTurn = undefined
        break
      }
      case 'step/start': {
        const data = handoffEventData(event, event.type)
        const turn = positiveEventInteger(data.turn, 'turn', event.type)
        const step = positiveEventInteger(data.step, 'step', event.type)
        if (activeTurn !== turn || activeStep !== undefined || step <= previousStep) {
          invalidHandoffState('step/start is out of order')
        }
        activeStep = step
        break
      }
      case 'step/end': {
        const data = handoffEventData(event, event.type)
        const turn = positiveEventInteger(data.turn, 'turn', event.type)
        const step = positiveEventInteger(data.step, 'step', event.type)
        if (activeTurn !== turn || activeStep !== step) invalidHandoffState('step/end has no matching step')
        if ([...pendingCalls.values()].some(call => call.turn === turn && call.step === step)) {
          invalidHandoffState('step/end closes a step with unsettled tool calls')
        }
        activeStep = undefined
        previousStep = step
        break
      }
      case 'assistant/message': {
        const data = handoffEventData(event, event.type)
        const turn = positiveEventInteger(data.turn, 'turn', event.type)
        const step = positiveEventInteger(data.step, 'step', event.type)
        if (activeTurn !== turn || activeStep !== step
          || data.message === null || typeof data.message !== 'object'
          || !Array.isArray(data.message.content)) {
          invalidHandoffState('assistant/message is outside its matching step or has invalid content')
        }
        for (const block of data.message.content) {
          if (block?.type !== 'tool-call') continue
          const callId = block.id
          const key = typeof callId === 'string' ? handoffToolCallKey(turn, step, callId) : ''
          if (typeof callId !== 'string' || callId.length === 0 || pendingCalls.has(key) || settledCalls.has(key)) {
            invalidHandoffState('assistant/message has an invalid or duplicate tool call id')
          }
          pendingCalls.set(key, { turn, step, started: false })
        }
        break
      }
      case 'tool/call': {
        const data = handoffEventData(event, event.type)
        const turn = positiveEventInteger(data.turn, 'turn', event.type)
        const step = positiveEventInteger(data.step, 'step', event.type)
        const key = typeof data.callId === 'string' ? handoffToolCallKey(turn, step, data.callId) : ''
        const call = pendingCalls.get(key)
        if (typeof data.callId !== 'string' || call === undefined || call.started
          || activeTurn !== turn || activeStep !== step || call.turn !== turn || call.step !== step) {
          invalidHandoffState('tool/call has no matching assistant tool request')
        }
        call.started = true
        break
      }
      case 'tool/result': {
        const data = handoffEventData(event, event.type)
        const turn = positiveEventInteger(data.turn, 'turn', event.type)
        const step = positiveEventInteger(data.step, 'step', event.type)
        const message = data.message
        const source = message?.source
        const callId = source?.callId
        const key = typeof callId === 'string' ? handoffToolCallKey(turn, step, callId) : ''
        if (source?.kind !== 'tool' || message?.toolCallId !== callId
          || typeof callId !== 'string' || callId.length === 0) {
          invalidHandoffState('tool/result has no matching assistant tool request')
        }
        if (event.surfaceOp === 'append') {
          const call = pendingCalls.get(key)
          if (activeTurn !== turn || activeStep !== step || call === undefined || call.turn !== turn || call.step !== step) {
            invalidHandoffState('tool/result has no matching assistant tool request')
          }
          pendingCalls.delete(key)
          settledCalls.set(key, { turn, step, resultSeq: event.seq })
          break
        }
        if (event.surfaceOp?.op === 'replace') {
          const settled = settledCalls.get(key)
          const { startSeq, endSeq } = event.surfaceOp
          if (settled === undefined || settled.turn !== turn || settled.step !== step
            || !Number.isSafeInteger(startSeq) || startSeq !== settled.resultSeq
            || !Number.isSafeInteger(endSeq) || endSeq !== settled.resultSeq
            || !Array.isArray(event.sourceEventSeqs) || !event.sourceEventSeqs.includes(settled.resultSeq)) {
            invalidHandoffState('tool/result replacement does not reference its settled result')
          }
          settledCalls.set(key, { ...settled, resultSeq: event.seq })
          break
        }
        invalidHandoffState('tool/result has an unsupported surface operation')
      }
      default:
        break
    }
  }

  if (activeTurn !== undefined) {
    throw new BackendError('HANDOFF_BUSY', 'Session has an active DSH turn', 409)
  }
  if (pendingCalls.size > 0) {
    throw new BackendError('HANDOFF_BUSY', 'Session has unsettled DSH tool calls', 409)
  }
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new BackendError('REQUEST_TOO_LARGE', 'request body is too large', 413)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BackendError('INVALID_REQUEST', 'request body is not valid JSON')
  }
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-browser-native-protocol': String(PROTOCOL_VERSION),
    ...headers,
  })
  response.end(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...body }))
}

function sendBytes(response, bytes, headers = {}) {
  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(bytes.byteLength),
    'cache-control': 'no-store',
    'x-browser-native-protocol': String(PROTOCOL_VERSION),
    ...headers,
  })
  response.end(bytes)
}

async function streamWorkspaceBlob(request, response, workspaces, workspaceId, hash, downloadTimeoutMs, controller) {
  let reader
  let closeResult
  const closeReader = () => {
    closeResult ??= Promise.resolve().then(() => reader.close()).then(
      () => ({ ok: true }),
      error => ({ ok: false, error }),
    )
    return closeResult
  }
  const onAbort = () => {
    response.destroy()
    if (reader !== undefined) void closeReader()
  }
  const abort = () => controller.abort()
  const onClose = () => {
    if (!response.writableFinished) abort()
  }
  request.once('aborted', abort)
  response.once('close', onClose)
  response.once('error', abort)
  controller.signal.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(abort, downloadTimeoutMs)
  try {
    if (request.aborted || response.destroyed) abort()
    if (controller.signal.aborted) return
    reader = await workspaces.openBlobRead(request, workspaceId, hash)
    if (controller.signal.aborted || request.aborted || response.destroyed) return
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(reader.totalBytes),
      'x-content-sha256': reader.hash,
      'x-total-bytes': String(reader.totalBytes),
      'cache-control': 'no-store',
      'x-browser-native-protocol': String(PROTOCOL_VERSION),
    })
    await pipeline(Readable.from(reader.chunks(), { objectMode: false, highWaterMark: 1 }), response,
      { signal: controller.signal })
  } finally {
    clearTimeout(timeout)
    request.off('aborted', abort)
    response.off('close', onClose)
    response.off('error', abort)
    controller.signal.removeEventListener('abort', onAbort)
    if (reader !== undefined) {
      const result = await closeReader()
      if (!result.ok) throw result.error
    }
  }
}

async function readRawBody(request, maximumBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maximumBytes) throw new WorkspaceError('REQUEST_TOO_LARGE', 'workspace blob exceeds the upload limit', 413)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function requestExternalBusiness(origin, path, body) {
  let response
  try {
    response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new BackendError('BUSINESS_SERVICE_UNAVAILABLE', 'external business service could not be reached', 503)
  }
  let value
  try { value = await response.json() } catch {
    throw new BackendError('BUSINESS_SERVICE_UNAVAILABLE', 'external business service returned invalid JSON', 503)
  }
  if (!response.ok) {
    const error = value?.error
    throw new BackendError(typeof error?.code === 'string' ? error.code : 'BUSINESS_SERVICE_FAILED',
      typeof error?.message === 'string' ? error.message : 'external business service rejected the request', response.status)
  }
  return value
}

async function queryExternalBusiness(origin, operationId, principalId) {
  let response
  try {
    response = await fetch(`${origin}/v1/effect/${operationId}?principalId=${encodeURIComponent(principalId)}`)
  } catch {
    throw new BackendError('BUSINESS_QUERY_UNAVAILABLE', 'external business status could not be queried', 503)
  }
  let value
  try { value = await response.json() } catch {
    throw new BackendError('BUSINESS_QUERY_UNAVAILABLE', 'external business status was not valid JSON', 503)
  }
  if (!response.ok) {
    const error = value?.error
    throw new BackendError(typeof error?.code === 'string' ? error.code : 'BUSINESS_QUERY_UNAVAILABLE',
      typeof error?.message === 'string' ? error.message : 'external business status query failed', response.status)
  }
  return value
}

function sendError(response, error) {
  const detail = error instanceof BackendError || error instanceof WorkspaceError || error instanceof CrossStoreLedgerError
    ? error
    : new BackendError('INTERNAL', 'browser-native backend failed', 500)
  sendJson(response, detail.status, {
    error: {
      code: detail.code,
      message: detail.message,
      ...(detail.retryAfterMs === undefined ? {} : { retryAfterMs: detail.retryAfterMs }),
      ...(detail.details === undefined ? {} : { details: detail.details }),
    },
  })
}

function revisionOf(session) {
  return `remote-${digest(`${session.id}:${session.events.length}:${session.durableThroughSeq}`)}`
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

async function acquireDataDirLock(dataDir) {
  const root = resolve(dataDir)
  await mkdir(root, { recursive: true })
  const lockPath = join(root, DATA_DIR_LOCK_NAME)
  const token = randomUUID()
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }))
        await handle.sync()
      } finally {
        await handle.close()
      }
      let released = false
      return {
        release: async () => {
          if (released) return
          released = true
          try {
            const current = JSON.parse(await readFile(lockPath, 'utf8'))
            if (current.pid === process.pid && current.token === token) await rm(lockPath)
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error
          }
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let owner
      try {
        owner = JSON.parse(await readFile(lockPath, 'utf8'))
      } catch (readError) {
        throw new BackendError(
          'BACKEND_LOCK_UNREADABLE',
          'browser-native backend dataDir lock is unreadable; refusing startup',
          409,
          undefined,
        )
      }
      if (!Number.isSafeInteger(owner?.pid) || typeof owner.token !== 'string' || owner.token.length === 0) {
        throw new BackendError('BACKEND_LOCK_INVALID', 'browser-native backend dataDir lock is invalid; refusing startup', 409)
      }
      if (isProcessAlive(owner.pid)) {
        throw new BackendError('BACKEND_ALREADY_RUNNING', 'browser-native backend dataDir is owned by a live process', 409)
      }
      const stalePath = `${lockPath}.stale-${randomUUID()}`
      try {
        await rename(lockPath, stalePath)
        await rm(stalePath, { force: true })
      } catch (renameError) {
        if (renameError?.code !== 'ENOENT') throw renameError
      }
    }
  }
}

class FormalSessionStore {
  constructor(dataDir, { ownerLeaseMs = DEFAULT_OWNER_LEASE_MS, now = Date.now, failFlush, failFlushAfterRename } = {}) {
    if (!Number.isSafeInteger(ownerLeaseMs) || ownerLeaseMs < 300) throw new Error('ownerLeaseMs must be an integer of at least 300')
    this.root = resolve(dataDir)
    this.sessionsDir = join(this.root, 'sessions')
    this.sessions = new Map()
    this.locks = new Map()
    this.ownerLeaseMs = ownerLeaseMs
    this.now = now
    this.failFlush = failFlush
    this.failFlushAfterRename = failFlushAfterRename
  }

  async load() {
    await mkdir(this.sessionsDir, { recursive: true })
    for (const entry of await readdir(this.sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const raw = JSON.parse(await readFile(join(this.sessionsDir, entry.name), 'utf8'))
      const id = assertSessionId(raw.id)
      if (raw.header?.id !== id || !Array.isArray(raw.events)) continue
      const principalId = raw.principalId === undefined ? undefined : assertPrincipalId(raw.principalId)
      const handoffs = new Map()
      let handoffsMigrated = false
      for (const [handoffId, record] of Object.entries(raw.handoffs ?? {})) {
        const normalized = normalizeHandoffRecord(handoffId, record)
        handoffs.set(handoffId, clone(normalized.record))
        handoffsMigrated ||= normalized.migrated
      }
      const session = {
        id,
        principalId,
        header: clone(raw.header),
        inheritedEventCount: raw.inheritedEventCount ?? 0,
        events: clone(raw.events),
        durableThroughSeq: raw.durableThroughSeq ?? raw.events.length - 1,
        ownerToken: undefined,
        ownerEpoch: Number.isSafeInteger(raw.ownerEpoch) && raw.ownerEpoch >= 0 ? raw.ownerEpoch : 0,
        ownerExpiresAt: 0,
        writeBlocked: false,
        handoffs,
      }
      this.sessions.set(id, session)
      if (handoffsMigrated) await this.flush(session)
    }
  }

  async exclusive(id, operation) {
    const previous = this.locks.get(id) ?? Promise.resolve()
    let release
    const current = new Promise(resolveRelease => { release = resolveRelease })
    this.locks.set(id, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.locks.get(id) === current) this.locks.delete(id)
    }
  }

  get(id) {
    const session = this.sessions.get(assertSessionId(id))
    if (session === undefined) throw new BackendError('SESSION_NOT_FOUND', 'session does not exist', 404)
    return session
  }

  getForPrincipal(id, principalId) {
    const session = this.get(id)
    if (session.principalId !== principalId) throw new BackendError('SESSION_NOT_FOUND', 'session does not exist', 404)
    return session
  }

  create(id, header, inheritedEventCount, principalId) {
    assertPrincipalId(principalId)
    const existing = this.sessions.get(id)
    if (existing !== undefined) {
      if (existing.principalId !== principalId) throw new BackendError('SESSION_NOT_FOUND', 'session does not exist', 404)
      throw new BackendError('SESSION_ALREADY_EXISTS', 'session already exists', 409)
    }
    if (header.id !== id) throw new BackendError('INVALID_REQUEST', 'header id does not match session id')
    const session = {
      id,
      principalId,
      header: clone(header),
      inheritedEventCount,
      events: [],
      durableThroughSeq: -1,
      ownerToken: undefined,
      ownerEpoch: 0,
      ownerExpiresAt: 0,
      handoffs: new Map(),
    }
    this.sessions.set(id, session)
    return session
  }

  claim(session, requestedOwnerToken, requestedOwnerEpoch) {
    if (session.writeBlocked) throw new BackendError('SESSION_RECOVERY_REQUIRED', 'Session ownership is blocked until the backend reloads its durable state', 503)
    if (session.ownerToken !== undefined && session.ownerExpiresAt > this.now()) {
      if (requestedOwnerToken === session.ownerToken
        && (requestedOwnerEpoch === undefined || requestedOwnerEpoch === session.ownerEpoch)) {
        return this.renew(session, session.ownerToken, true)
      }
      throw new BackendError(
        'SESSION_ALREADY_OWNED',
        'session is already owned by another browser; close that tab or retry after its write lease expires',
        409,
        session.ownerExpiresAt - this.now(),
      )
    }
    session.ownerEpoch += 1
    session.ownerToken = typeof requestedOwnerToken === 'string' ? requestedOwnerToken : randomUUID()
    return this.renew(session, session.ownerToken, true)
  }

  renew(session, ownerToken, initial = false) {
    if (!initial) this.assertOwner(session, ownerToken)
    session.ownerExpiresAt = this.now() + this.ownerLeaseMs
    return {
      ownerToken: session.ownerToken,
      ownerEpoch: session.ownerEpoch,
      leaseDurationMs: this.ownerLeaseMs,
      renewAfterMs: Math.floor(this.ownerLeaseMs / 3),
    }
  }

  assertOwner(session, ownerToken, ownerEpoch) {
    this.assertOwnerToken(session, ownerToken, ownerEpoch)
    if (session.ownerExpiresAt <= this.now()) {
      throw new BackendError('SESSION_OWNERSHIP_LOST', 'session write ownership is no longer valid', 409)
    }
  }

  assertOwnerToken(session, ownerToken, ownerEpoch) {
    if (session.writeBlocked) throw new BackendError('SESSION_RECOVERY_REQUIRED', 'Session writes are blocked until the backend reloads its durable state', 503)
    if (typeof ownerToken !== 'string' || session.ownerToken !== ownerToken
      || (ownerEpoch !== undefined && ownerEpoch !== session.ownerEpoch)) {
      throw new BackendError('SESSION_OWNERSHIP_LOST', 'session write ownership is no longer valid', 409)
    }
  }

  findHandoff(session, handoffId) {
    const record = session.handoffs.get(handoffId)
    return record === undefined ? undefined : clone(record)
  }

  beginHandoff(session, ownerToken, ownerEpoch, handoffId, checkpoint) {
    if (session.writeBlocked) throw new BackendError('SESSION_RECOVERY_REQUIRED', 'Session writes are blocked until the backend reloads its durable state', 503)
    const existing = this.findHandoff(session, handoffId)
    if (existing !== undefined) {
      if (session.ownerEpoch !== existing.receipt.ownerEpoch
        || ownerEpoch !== existing.receipt.previousOwnerEpoch
        || !matchesOwnerTokenDigest(ownerToken, existing.previousOwnerTokenDigest)) {
        throw new BackendError('SESSION_OWNERSHIP_LOST', 'handoff retry does not identify either owner', 409)
      }
      if (existing.fingerprint !== checkpointFingerprint(checkpoint)) {
        throw new BackendError('HANDOFF_CONFLICT', 'handoffId is already bound to a different checkpoint', 409)
      }
      return { replayed: true, receipt: existing.receipt }
    }
    this.assertOwner(session, ownerToken, ownerEpoch)
    const previous = {
      sessionId: session.id,
      ownerToken: session.ownerToken,
      ownerEpoch: session.ownerEpoch,
    }
    const next = {
      sessionId: session.id,
      ownerToken: randomUUID(),
      ownerEpoch: session.ownerEpoch + 1,
      leaseDurationMs: this.ownerLeaseMs,
      renewAfterMs: Math.floor(this.ownerLeaseMs / 3),
    }
    session.ownerEpoch = next.ownerEpoch
    session.ownerToken = next.ownerToken
    session.ownerExpiresAt = this.now() + this.ownerLeaseMs
    const receipt = {
      sessionId: session.id,
      previousOwnerEpoch: previous.ownerEpoch,
      ownerEpoch: next.ownerEpoch,
      checkpoint: clone(checkpoint),
      handoffId,
      durabilityReceipt: `durable-${session.id}-${session.events.length - 1}`,
    }
    session.handoffs.set(handoffId, {
      fingerprint: checkpointFingerprint(checkpoint),
      previousOwnerTokenDigest: ownerTokenDigest(ownerToken),
      receipt,
    })
    return { replayed: false, receipt, owner: next, previous }
  }

  rollbackHandoff(session, previous, handoffId) {
    session.handoffs.delete(handoffId)
    session.ownerToken = previous.ownerToken
    session.ownerEpoch = previous.ownerEpoch
    session.ownerExpiresAt = this.now() + this.ownerLeaseMs
  }

  async flush(session) {
    const target = join(this.sessionsDir, `${session.id}.json`)
    const temporary = `${target}.${randomUUID()}.tmp`
    const record = {
      id: session.id,
      ...(session.principalId === undefined ? {} : { principalId: session.principalId }),
      header: session.header,
      inheritedEventCount: session.inheritedEventCount,
      events: session.events,
      durableThroughSeq: session.events.length - 1,
      ownerEpoch: session.ownerEpoch,
      handoffs: Object.fromEntries(session.handoffs),
    }
    let published = false
    try {
      if (this.failFlush?.(session) === true) throw new BackendError('E2E_INJECTED_SESSION_FLUSH_FAILURE', 'E2E injected Session flush failure', 503)
      await writeFile(temporary, `${JSON.stringify(record)}\n`, 'utf8')
      const file = await open(temporary, 'r+')
      try { await file.sync() } finally { await file.close() }
      await rename(temporary, target)
      published = true
      if (this.failFlushAfterRename?.(session) === true) {
        throw new BackendError('E2E_INJECTED_SESSION_POST_RENAME_FAILURE', 'E2E injected failure after Session file publish', 503)
      }
      const directory = await open(this.sessionsDir, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) {
      await rm(temporary, { force: true })
      if (published) session.writeBlocked = true
      throw new BackendError(
        published ? 'DURABILITY_UNKNOWN' : 'DURABILITY_FAILED',
        `Session flush ${published ? 'outcome is unknown after file publish' : 'failed before file publish'}: ${String(error)}`,
        503,
      )
    }
    session.durableThroughSeq = record.durableThroughSeq
    return `durable-${session.id}-${session.durableThroughSeq}`
  }

  snapshot(session) {
    return {
      header: clone(session.header),
      revision: revisionOf(session),
      eventCount: session.events.length,
    }
  }
}

function sessionResponse(session, extra = {}) {
  return {
    sessionId: session.id,
    header: clone(session.header),
    inheritedEventCount: session.inheritedEventCount,
    nextSeq: session.events.length,
    revision: revisionOf(session),
    ...extra,
  }
}

async function sessionOperation(store, operation, body, principalId, testHooks = {}) {
  assertProtocol(body)
  assertPrincipalId(principalId)
  if (operation === 'list') {
    return store.exclusive('__list__', async () => {
      const limit = body.limit === undefined ? 50 : boundedInteger(body.limit, 'limit', MAX_CATALOG_PAGE_SIZE)
      if (limit === 0) throw new BackendError('INVALID_REQUEST', 'limit must be at least 1')
      const after = body.cursor === undefined ? undefined : sessionIdFromCatalogCursor(body.cursor, principalId)
      const sessions = [...store.sessions.values()]
        .filter(session => session.principalId === principalId)
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      const page = sessions.filter(session => after === undefined || session.id > after).slice(0, limit)
      const snapshots = page.map(session => store.snapshot(session))
      const items = snapshots.map(snapshot => ({
        agentAvailable: false,
        sessionId: snapshot.header.id,
        updatedAt: snapshot.header.createdAt,
        running: false,
        blank: snapshot.eventCount === 0,
        cwd: snapshot.header.cwd,
      }))
      return {
        snapshots,
        items,
        hasMore: page.length > 0 && sessions.some(session => session.id > page.at(-1).id),
        ...(page.length > 0 && sessions.some(session => session.id > page.at(-1).id)
          ? { nextCursor: catalogCursorFor(principalId, page.at(-1).id) }
          : {}),
      }
    })
  }
  const id = assertSessionId(body.sessionId)
  testHooks.onSessionOperationQueued?.(operation, body)
  return store.exclusive(id, async () => {
    await testHooks.beforeSessionOperation?.(operation, body)
    if (operation === 'create') {
      const session = store.create(id, assertRecord(body.header, 'header'), body.inheritedEventCount ?? 0, principalId)
      const owner = store.claim(session)
      return sessionResponse(session, { owner })
    }
    const session = store.getForPrincipal(id, principalId)
    if (operation === 'open') {
      if (body.access !== 'read' && body.access !== 'write') throw new BackendError('INVALID_REQUEST', 'access must be read or write')
      const owner = body.access === 'write' ? store.claim(session, body.ownerToken, body.ownerEpoch) : undefined
      return sessionResponse(session, owner === undefined ? {} : { owner })
    }
    if (operation === 'stat') return sessionResponse(session)
    if (operation === 'read') {
      const offset = body.offset === undefined ? 0 : boundedInteger(body.offset, 'offset', MAX_EVENTS)
      const length = body.length === undefined ? MAX_SESSION_READ_EVENTS : boundedInteger(body.length, 'length', MAX_SESSION_READ_EVENTS)
      if (length === 0) throw new BackendError('INVALID_REQUEST', 'length must be at least 1')
      const events = clone(session.events.slice(offset, offset + length))
      if (jsonBytes(events) > MAX_SESSION_READ_BYTES) throw new BackendError('RESPONSE_TOO_LARGE', 'Session read page exceeds the response byte budget', 413)
      return sessionResponse(session, {
        events,
        eventState: 'shared-frozen',
        durableThroughSeq: session.durableThroughSeq,
        ownerEpoch: session.ownerEpoch,
        hasMore: offset + events.length < session.events.length,
      })
    }
    if (operation === 'close') {
      store.assertOwnerToken(session, body.ownerToken)
      const durabilityReceipt = session.durableThroughSeq < session.events.length - 1
        ? await store.flush(session)
        : undefined
      session.ownerToken = undefined
      session.ownerExpiresAt = 0
      return sessionResponse(session, {
        closed: true,
        durable: true,
        durableThroughSeq: session.durableThroughSeq,
        ...(durabilityReceipt === undefined ? {} : { durabilityReceipt }),
      })
    }
    if (operation === 'handoff') {
      const handoffId = boundedString(body.handoffId, 'handoffId', MAX_HANDOFF_ID_LENGTH)
      const existingHandoff = store.findHandoff(session, handoffId)
      const checkpoint = validateHandoffCheckpoint(
        session,
        body.checkpoint,
        body.ownerToken,
        body.ownerEpoch,
        existingHandoff === undefined,
      )
      if (existingHandoff === undefined) assertHandoffQuiescent(session)
      const result = store.beginHandoff(session, body.ownerToken, body.ownerEpoch, handoffId, checkpoint)
      if (result.replayed) {
        return sessionResponse(session, {
          owner: null,
          handoffId,
          ownerEpoch: result.receipt.ownerEpoch,
          checkpoint: clone(result.receipt.checkpoint),
          durabilityReceipt: result.receipt.durabilityReceipt,
          replayed: true,
          credentialStatus: 'not-replayed',
        })
      }
      try {
        const durabilityReceipt = await store.flush(session)
        return sessionResponse(session, {
          owner: result.owner,
          handoffId,
          ownerEpoch: result.receipt.ownerEpoch,
          checkpoint: clone(result.receipt.checkpoint),
          durabilityReceipt,
          replayed: false,
        })
      } catch (error) {
        if (error?.code !== 'DURABILITY_UNKNOWN') store.rollbackHandoff(session, result.previous, handoffId)
        throw error
      }
    }
    store.assertOwner(session, body.ownerToken, body.ownerEpoch)
    if (operation === 'renew') return sessionResponse(session, { owner: store.renew(session, body.ownerToken) })
    if (operation === 'append') {
      if (testHooks.failSessionAppend?.(body) === true) {
        throw new BackendError('E2E_INJECTED_SESSION_APPEND_FAILURE', 'E2E injected Session append failure', 503)
      }
      if (body.expectedNextSeq !== session.events.length || !Array.isArray(body.events)) {
        throw new BackendError('SEQ_CONFLICT', 'append does not continue the visible log', 409)
      }
      if (body.events.length > SESSION_APPEND_MAX_EVENTS) throw new BackendError('REQUEST_TOO_LARGE', 'Session append event count exceeds the request limit', 413)
      if (jsonBytes(body.events) > SESSION_APPEND_MAX_BYTES) throw new BackendError('REQUEST_TOO_LARGE', 'Session append exceeds the request byte budget', 413)
      if (session.events.length + body.events.length > MAX_EVENTS) throw new BackendError('REQUEST_TOO_LARGE', 'Session event limit exceeded', 413)
      body.events.forEach((event, index) => {
        if (event === null || typeof event !== 'object' || Array.isArray(event) || event.seq !== body.expectedNextSeq + index) {
          throw new BackendError('SEQ_CONFLICT', 'event sequence is not contiguous', 409)
        }
      })
      session.events.push(...clone(body.events))
      return sessionResponse(session, { acceptedCount: body.events.length })
    }
    if (operation === 'flush') {
      const durabilityReceipt = await store.flush(session)
      return sessionResponse(session, { durable: true, durabilityReceipt, durableThroughSeq: session.durableThroughSeq })
    }
    throw new BackendError('INVALID_REQUEST', `unknown Session operation: ${operation}`)
  })
}

function parseDotEnv(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match === null) continue
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return values
}

async function loadEnv(envFile) {
  const values = { ...process.env }
  if (envFile === undefined) return values
  try {
    Object.assign(values, parseDotEnv(await readFile(envFile, 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return values
}

async function createLlmConfig(options) {
  const mode = options.llmMode ?? 'scripted'
  if (mode === 'scripted') {
    const contextWindow = positiveInteger(options.contextWindow, 'contextWindow')
    return { mode, model: 'browser-native-scripted', provider: 'scripted', ...(contextWindow === undefined ? {} : { contextWindow }) }
  }
  if (mode !== 'real') throw new Error(`unsupported LLM mode: ${mode}`)
  const env = await loadEnv(options.envFile)
  const model = options.model ?? env.OPENAI_NEXT_GPT_MODEL
  if (typeof model !== 'string' || model.length === 0) throw new Error('OPENAI_NEXT_GPT_MODEL is required in real mode')
  const grok = model.startsWith('grok-')
  const baseUrl = grok ? (env.OPENAI_NEXT_GROK_BASE_URL ?? env.OPENAI_NEXT_GPT_BASE_URL) : env.OPENAI_NEXT_GPT_BASE_URL
  const path = grok ? (env.OPENAI_NEXT_GROK_COMPLETIONS_PATH ?? env.OPENAI_NEXT_GPT_COMPLETIONS_PATH) : env.OPENAI_NEXT_GPT_COMPLETIONS_PATH
  const apiKey = grok ? env.OPENAI_NEXT_GROK_API_KEY : env.OPENAI_NEXT_GPT_API_KEY
  if (!baseUrl || !path || !apiKey) throw new Error('real LLM mode needs the configured OpenAI Next base URL, completions path, model, and API key')
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (proxy?.startsWith('socks')) throw new Error('real LLM mode needs an HTTP(S) proxy; SOCKS proxy support is not implemented in this PoC')
  const configuredTimeout = options.llmTimeoutMs ?? (env.DSH_POC_LLM_TIMEOUT_MS === undefined
    ? DEFAULT_LLM_TIMEOUT_MS
    : Number(env.DSH_POC_LLM_TIMEOUT_MS))
  const timeout = timeoutMs(configuredTimeout, 'llmTimeoutMs')
  const contextWindow = positiveInteger(options.contextWindow ?? env.DSH_POC_CONTEXT_WINDOW, 'DSH_POC_CONTEXT_WINDOW')
  return {
    mode,
    model,
    provider: grok ? 'grok' : 'gpt',
    url: new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString(),
    apiKey,
    proxyConfigured: proxy !== undefined,
    timeoutMs: timeout,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
}

function positiveInteger(value, name) {
  if (value === undefined) return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`)
  return parsed
}

function textContent(messages) {
  const texts = messages
    .filter(message => message.role === 'user' && typeof message.content === 'string')
    .map(message => message.content)
  const last = texts.at(-1)
  if (last?.startsWith('Generate the session title from this JSON array:')) return 'Browser-native DSH session'
  return [...texts].reverse().find(text => !text.startsWith('Current runtime context.')) ?? last ?? 'the current request'
}

function writeStream(response, item) {
  if (!response.destroyed) response.write(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...item })}\n`)
}

function writeStreamError(response, code, message) {
  if (response.writableEnded || response.destroyed) return
  writeStream(response, { kind: 'error', error: { code, message } })
  response.end()
}

function hasUserMarker(messages, marker) {
  return messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(marker))
}

function lastUserMessageText(messages) {
  return [...messages].reverse().find(message => message.role === 'user'
    && typeof message.content === 'string' && !message.content.startsWith('Current runtime context.'))?.content ?? ''
}

function questionReplyForCall(messages, callId) {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue
    let parsed
    try { parsed = JSON.parse(message.content) } catch { continue }
    if (parsed?.kind === 'answer_to_pending_question' && parsed.callId === callId) return message
  }
  return undefined
}

function hasToolResult(messages) {
  return messages.some(message => message.role === 'tool')
}

function hasTool(tools, name) {
  return Array.isArray(tools) && tools.some(tool => tool?.function?.name === name || tool?.name === name)
}

async function scriptedWorkspaceToolCall(response, { id, name, arguments: toolArguments }) {
  const argumentsText = JSON.stringify(toolArguments)
  writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } })
  writeStream(response, { kind: 'chunk', chunk: {
    type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText,
  } })
  writeStream(response, { kind: 'chunk', chunk: {
    type: 'block-end', index: 0, block: {
      type: 'tool-call', id, name, arguments: argumentsText,
    },
  } })
  writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'tool-calls' } } })
  response.end()
}

async function scriptedWorkspaceToolCalls(response, calls) {
  for (const [index, call] of calls.entries()) {
    const argumentsText = JSON.stringify(call.arguments)
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index, blockType: 'tool-call' } })
    writeStream(response, { kind: 'chunk', chunk: {
      type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: argumentsText,
    } })
    writeStream(response, { kind: 'chunk', chunk: {
      type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: argumentsText },
    } })
  }
  writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'tool-calls' } } })
  response.end()
}

function scriptedText(response, text) {
  writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
  writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text } })
  writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
  writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
  response.end()
}

async function scriptedLlm(response, messages, tools, fault, isClientClosed = () => false, purpose) {
  if (fault?.kind === 'error') {
    writeStreamError(response, fault.code ?? 'SCRIPTED_LLM_ERROR', fault.message ?? 'scripted model request failed')
    return
  }
  if (fault?.kind === 'partial-text') {
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text: fault.text ?? 'partial response' } })
    writeStreamError(response, fault.code ?? 'UPSTREAM_LLM_TRUNCATED', fault.message ?? 'scripted stream truncated after partial text')
    return
  }
  if (fault?.kind === 'partial-tool-call') {
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } })
    writeStream(response, { kind: 'chunk', chunk: {
      type: 'tool-call-delta',
      index: 0,
      id: fault.id ?? 'browser-native-partial-tool-call',
      name: fault.name ?? 'write',
      argumentsDelta: fault.argumentsDelta ?? '{"file_path":"/dsh/home/workspace/partial.txt","content":"partial',
    } })
    writeStreamError(response, fault.code ?? 'UPSTREAM_LLM_TRUNCATED', fault.message ?? 'scripted stream truncated during tool arguments')
    return
  }
  if (fault?.kind === 'barrier-text') {
    await fault.release
    if (isClientClosed()) return
    scriptedText(response, fault.text ?? 'released scripted response')
    return
  }
  if (purpose === 'compaction') {
    const visibleUserText = messages.filter(message => message.role === 'user'
      && typeof message.content === 'string').map(message => message.content).join('\n')
    const markers = [...new Set(visibleUserText.match(/BROWSER_NATIVE_[A-Z0-9_]{8,}/g) ?? [])]
    scriptedText(response, [
      '## Primary Request and Intent', `- Keep ${markers.join(', ') || 'the active task'}.`,
      '## Key Technical Concepts', '- DSH.',
      '## Files and Code', '- Worker VFS.',
      '## Errors and Fixes', '- (none)',
      '## Pending Jobs', '- (none)',
      '## Current Work', '- Validate.',
      '## Next Step', '- Continue.',
      '## Critical Context', '- Session log is authoritative.',
    ].join('\n'))
    return
  }
  if (purpose === 'session-title') {
    scriptedText(response, 'Browser-native timed interaction')
    return
  }
  if (fault?.kind === 'delayed-text') {
    const text = fault.text ?? 'delayed scripted response'
    const split = Math.max(1, Math.floor(text.length / 2))
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text: fault.prefix ?? text.slice(0, split) } })
    await new Promise(resolveDelay => setTimeout(resolveDelay, fault.delayMs ?? 5_000))
    if (isClientClosed()) return
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text: fault.suffix ?? text.slice(split) } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    response.end()
    return
  }
  const latestUserText = [...messages].reverse().find(message => message.role === 'user'
    && typeof message.content === 'string'
    && !message.content.startsWith('Current runtime context.')
    && !message.content.startsWith('Time sampled while preparing turn'))?.content ?? ''
  const workerPlacementMarker = latestUserText.match(/BROWSER_NATIVE_WORKER_PLACEMENT_[A-Z0-9_]+/)?.[0]
  if (workerPlacementMarker !== undefined && hasTool(tools, 'write') && hasTool(tools, 'read')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(workerPlacementMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    const suffix = workerPlacementMarker.slice('BROWSER_NATIVE_WORKER_PLACEMENT_'.length).toLowerCase()
    const path = `/dsh/home/workspace/worker-placement-${suffix}.txt`
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: `browser-native-worker-placement-${suffix}-write`,
        name: 'write',
        arguments: { file_path: path, content: `placement=${suffix}\n` },
      })
      return
    }
    if (toolResults.length === 1) {
      await scriptedWorkspaceToolCall(response, {
        id: `browser-native-worker-placement-${suffix}-read`,
        name: 'read',
        arguments: { file_path: path },
      })
      return
    }
    const text = `${workerPlacementMarker}_DONE`
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    response.end()
    return
  }
  const timedQuestionCases = [
    { marker: 'BROWSER_NATIVE_TIMED_HITL_IN_TIME', callId: 'browser-native-timed-hitl-in-time' },
    { marker: 'BROWSER_NATIVE_TIMED_HITL_LATE_REPLY', callId: 'browser-native-timed-hitl-late-reply' },
    { marker: 'BROWSER_NATIVE_TIMED_HITL_REFRESH', callId: 'browser-native-timed-hitl-refresh' },
    { marker: 'BROWSER_NATIVE_TIMED_HITL_REPLY_REFRESH', callId: 'browser-native-timed-hitl-reply-refresh' },
    { marker: 'BROWSER_NATIVE_TIMED_HITL_STOP', callId: 'browser-native-timed-hitl-stop' },
    { marker: 'BROWSER_NATIVE_LEGACY_HITL_STOP', callId: 'browser-native-legacy-hitl-stop' },
  ]
  const timedQuestionCase = timedQuestionCases.find(item => hasUserMarker(messages, item.marker))
  if (timedQuestionCase !== undefined) {
    const reply = questionReplyForCall(messages, timedQuestionCase.callId)
    if (reply !== undefined) {
      if (timedQuestionCase.marker === 'BROWSER_NATIVE_TIMED_HITL_LATE_REPLY') {
        const replyIndex = messages.lastIndexOf(reply)
        const toolResults = messages.slice(replyIndex + 1).filter(message => message.role === 'tool')
        if (toolResults.length === 0) {
          await scriptedWorkspaceToolCall(response, {
            id: `${timedQuestionCase.callId}-write`,
            name: 'write',
            arguments: {
              file_path: '/dsh/home/workspace/timed-hitl-late-answer.txt',
              content: 'late-answer-authorized-write\n',
            },
          })
          return
        }
      }
      scriptedText(response, `${timedQuestionCase.marker}_ANSWER_ADMITTED`)
      return
    }
    const promptIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(timedQuestionCase.marker))
    const toolResults = messages.slice(promptIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: timedQuestionCase.callId,
        name: 'ask_user_question',
        arguments: {
          questions: [{
            id: timedQuestionCase.marker.toLowerCase(),
            question: `Answer the ${timedQuestionCase.marker} decision.`,
            header: 'Timed confirmation',
            options: [{ label: 'Yes' }, { label: 'No' }],
          }],
        },
      })
      return
    }
    const pendingResult = toolResults.find(message => {
      if (typeof message.content !== 'string') return false
      try { return JSON.parse(message.content).pending === true } catch { return false }
    })
    if (pendingResult !== undefined) {
      scriptedText(response, `${timedQuestionCase.marker}_CONTINUED_WITHOUT_ANSWER`)
      return
    }
    if (timedQuestionCase.marker === 'BROWSER_NATIVE_TIMED_HITL_IN_TIME' && toolResults.length === 1) {
      await scriptedWorkspaceToolCall(response, {
        id: `${timedQuestionCase.callId}-write`,
        name: 'write',
        arguments: {
          file_path: '/dsh/home/workspace/timed-hitl-in-time.txt',
          content: 'in-time-answer-authorized-write\n',
        },
      })
      return
    }
    scriptedText(response, `${timedQuestionCase.marker}_DONE`)
    return
  }
  const compactionMarker = [
    'BROWSER_NATIVE_COMPACTION_PRESSURE_E2E',
    'BROWSER_NATIVE_COMPACTION_SUMMARY_FAILURE_E2E',
    'BROWSER_NATIVE_COMPACTION_END_APPEND_503_E2E',
  ].find(marker => latestUserText.includes(marker))
  if (compactionMarker !== undefined && hasTool(tools, 'read')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(compactionMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: `browser-native-${compactionMarker.toLowerCase().replaceAll('_', '-')}-read`,
        name: 'read',
        arguments: { file_path: '/dsh/home/browser-validation/large.txt' },
      })
      return
    }
    scriptedText(response, `${compactionMarker}_DONE`)
    return
  }
  const parallelToolMarker = [
    'BROWSER_NATIVE_PARALLEL_TOOLS_E2E',
    'BROWSER_NATIVE_PARALLEL_TOOLS_PARTIAL_FAILURE_E2E',
  ].find(marker => textContent(messages).includes(marker))
  if (parallelToolMarker !== undefined && hasTool(tools, 'read')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(parallelToolMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCalls(response, [
        {
          id: 'browser-native-parallel-slow-read',
          name: 'read',
          arguments: { file_path: '/dsh/home/workspace/parallel-slow.txt' },
        },
        {
          id: 'browser-native-parallel-fast-read',
          name: 'read',
          arguments: { file_path: parallelToolMarker.endsWith('PARTIAL_FAILURE_E2E')
            ? '/dsh/home/workspace/parallel-missing.txt'
            : '/dsh/home/workspace/parallel-fast.txt' },
        },
      ])
      return
    }
    if (toolResults.length === 2) {
      scriptedText(response, parallelToolMarker.endsWith('PARTIAL_FAILURE_E2E')
        ? 'BROWSER_NATIVE_PARALLEL_TOOLS_PARTIAL_FAILURE_DONE'
        : 'BROWSER_NATIVE_PARALLEL_TOOLS_DONE')
      return
    }
  }
  const externalEditCrashCases = [
    {
      marker: 'BROWSER_NATIVE_EXTERNAL_EDIT_CRASH_WINDOW_E2E',
      oldString: 'before',
      newString: 'after',
      readArguments: { file_path: '/dsh/home/workspace/external-edit-crash.txt' },
    },
    {
      marker: 'BROWSER_NATIVE_EXTERNAL_EDIT_CRASH_WINDOW_64M_E2E',
      oldString: 'BROWSER_NATIVE_EXTERNAL_EDIT_64M_V1',
      newString: 'BROWSER_NATIVE_EXTERNAL_EDIT_64M_V2',
      readArguments: { file_path: '/dsh/home/workspace/external-edit-crash.txt', offset: 2, limit: 1 },
    },
  ]
  for (const editCase of externalEditCrashCases) {
    if (!textContent(messages).includes(editCase.marker) || !hasTool(tools, 'edit') || !hasTool(tools, 'read')) continue
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(editCase.marker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-external-edit-crash-read',
        name: 'read',
        arguments: editCase.readArguments,
      })
      return
    }
    if (toolResults.length === 1) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-external-edit-crash-window',
        name: 'edit',
        arguments: {
          file_path: '/dsh/home/workspace/external-edit-crash.txt',
          old_string: editCase.oldString,
          new_string: editCase.newString,
        },
      })
      return
    }
    scriptedText(response, `${editCase.marker}_DONE`)
    return
  }

  const oversizedToolMarkers = [
    'BROWSER_NATIVE_TOOL_ARGS_768K_E2E',
    'BROWSER_NATIVE_TOOL_ARGS_1M_E2E',
    'BROWSER_NATIVE_TOOL_ARGS_6M_E2E',
    'BROWSER_NATIVE_TOOL_ARGS_9M_E2E',
  ]
  const continueAfterOversizedMarker = 'BROWSER_NATIVE_AFTER_OVERSIZE_TOOL_CALL_CONTINUE'
  const latestLargeArgumentPrompt = textContent(messages)
  const oversizedToolMarker = oversizedToolMarkers.find(marker => latestLargeArgumentPrompt.includes(marker))
  if (oversizedToolMarker !== undefined && hasTool(tools, 'write')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(oversizedToolMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      const byteLength = oversizedToolMarker.includes('_768K_') ? 768 * 1024
        : (oversizedToolMarker.includes('_1M_') ? 1
          : oversizedToolMarker.includes('_6M_') ? 6 : 9) * 1024 * 1024
      await scriptedWorkspaceToolCall(response, {
        id: `browser-native-${byteLength}-byte-write`,
        name: 'write',
        arguments: {
          file_path: `/dsh/home/workspace/${String(byteLength)}-byte-tool-argument.txt`,
          content: 'x'.repeat(byteLength),
        },
      })
      return
    }
    const text = 'BROWSER_NATIVE_TOOL_ARGS_DONE'
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    response.end()
    return
  }

  if (latestLargeArgumentPrompt.includes(continueAfterOversizedMarker)) {
    const text = 'BROWSER_NATIVE_AFTER_OVERSIZE_TOOL_CALL_CONTINUE_OK'
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    response.end()
    return
  }

  const opfsAgentToolsMarker = 'BROWSER_NATIVE_OPFS_AGENT_TOOLS_E2E'
  const opfsAgentLargeMarker = 'BROWSER_NATIVE_OPFS_AGENT_TOOLS_64M_E2E'
  const opfsAgentToolMarker = textContent(messages).includes(opfsAgentLargeMarker) ? opfsAgentLargeMarker : opfsAgentToolsMarker
  if (textContent(messages).includes(opfsAgentToolMarker)
    && ['read', 'grep', 'edit'].every(name => hasTool(tools, name))) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(opfsAgentToolMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    const sequence = opfsAgentToolMarker === opfsAgentToolsMarker ? [
      {
        id: 'browser-native-opfs-large-read-before',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/opfs-agent-file.txt', offset: 2, limit: 1 },
      },
      {
        id: 'browser-native-opfs-large-grep-before',
        name: 'grep',
        arguments: { pattern: 'BROWSER_NATIVE_OPFS_EDIT_TARGET_V1', path: '/dsh/home/workspace/opfs-agent-file.txt' },
      },
      {
        id: 'browser-native-opfs-large-edit',
        name: 'edit',
        arguments: {
          file_path: '/dsh/home/workspace/opfs-agent-file.txt',
          old_string: 'BROWSER_NATIVE_OPFS_EDIT_TARGET_V1',
          new_string: 'BROWSER_NATIVE_OPFS_EDIT_TARGET_V2',
        },
      },
      {
        id: 'browser-native-opfs-large-read-after',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/opfs-agent-file.txt', offset: 2, limit: 1 },
      },
    ] : [
      {
        id: 'browser-native-opfs-64m-read-before',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/opfs-agent-file.txt', offset: 2, limit: 1 },
      },
      {
        id: 'browser-native-opfs-64m-edit',
        name: 'edit',
        arguments: {
          file_path: '/dsh/home/workspace/opfs-agent-file.txt',
          old_string: 'BROWSER_NATIVE_OPFS_EDIT_TARGET_V1',
          new_string: 'BROWSER_NATIVE_OPFS_EDIT_TARGET_V2',
        },
      },
      {
        id: 'browser-native-opfs-64m-read-after',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/opfs-agent-file.txt', offset: 2, limit: 1 },
      },
    ]
    if (toolResults.length < sequence.length) {
      await scriptedWorkspaceToolCall(response, sequence[toolResults.length])
      return
    }
    const text = opfsAgentToolMarker === opfsAgentToolsMarker
      ? 'BROWSER_NATIVE_OPFS_AGENT_TOOLS_DONE'
      : `${opfsAgentToolMarker}_DONE`
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    response.end()
    return
  }

  const opfsAfterRefreshMarker = 'BROWSER_NATIVE_OPFS_AGENT_AFTER_REFRESH_E2E'
  if (textContent(messages).includes(opfsAfterRefreshMarker) && hasTool(tools, 'read')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(opfsAfterRefreshMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-opfs-large-read-after-refresh',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/opfs-agent-file.txt', offset: 2, limit: 1 },
      })
      return
    }
    const text = 'BROWSER_NATIVE_OPFS_AGENT_AFTER_REFRESH_DONE'
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    response.end()
    return
  }

  const opfsEnvelopeWorksetMarker = 'BROWSER_NATIVE_OPFS_ENVELOPE_WORKSET_E2E'
  const opfsEnvelopeLargeMarker = 'BROWSER_NATIVE_OPFS_ENVELOPE_64M_E2E'
  const opfsEnvelopeScenarios = [
    {
      marker: opfsEnvelopeWorksetMarker,
      path: '/dsh/home/workspace/envelope-16mib-0.txt',
      before: 'BROWSER_NATIVE_OPFS_ENVELOPE_16M_V1',
      after: 'BROWSER_NATIVE_OPFS_ENVELOPE_16M_V2',
      tools: [
        { name: 'read', arguments: { file_path: '/dsh/home/workspace/envelope-16mib-0.txt', offset: 2, limit: 1 } },
        { name: 'grep', arguments: { pattern: 'BROWSER_NATIVE_OPFS_ENVELOPE_16M_V1', path: '/dsh/home/workspace/envelope-16mib-0.txt' } },
        { name: 'edit', arguments: { file_path: '/dsh/home/workspace/envelope-16mib-0.txt', old_string: 'BROWSER_NATIVE_OPFS_ENVELOPE_16M_V1', new_string: 'BROWSER_NATIVE_OPFS_ENVELOPE_16M_V2' } },
        { name: 'read', arguments: { file_path: '/dsh/home/workspace/envelope-16mib-0.txt', offset: 2, limit: 1 } },
      ],
    },
    {
      marker: opfsEnvelopeLargeMarker,
      path: '/dsh/home/workspace/envelope-64mib.txt',
      before: 'BROWSER_NATIVE_OPFS_ENVELOPE_64M_V1',
      after: 'BROWSER_NATIVE_OPFS_ENVELOPE_64M_V2',
      tools: [
        { name: 'read', arguments: { file_path: '/dsh/home/workspace/envelope-64mib.txt', offset: 2, limit: 1 } },
        { name: 'edit', arguments: { file_path: '/dsh/home/workspace/envelope-64mib.txt', old_string: 'BROWSER_NATIVE_OPFS_ENVELOPE_64M_V1', new_string: 'BROWSER_NATIVE_OPFS_ENVELOPE_64M_V2' } },
        { name: 'read', arguments: { file_path: '/dsh/home/workspace/envelope-64mib.txt', offset: 2, limit: 1 } },
      ],
    },
  ]
  for (const scenario of opfsEnvelopeScenarios) {
    if (!textContent(messages).includes(scenario.marker) || !scenario.tools.every(tool => hasTool(tools, tool.name))) continue
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(scenario.marker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length < scenario.tools.length) {
      const tool = scenario.tools[toolResults.length]
      await scriptedWorkspaceToolCall(response, {
        id: `browser-native-opfs-envelope-${scenario.marker.toLowerCase()}-${toolResults.length}`,
        ...tool,
      })
      return
    }
    scriptedText(response, `${scenario.marker}_DONE`)
    return
  }

  const opfsEnvelopeAfterRefreshMarker = 'BROWSER_NATIVE_OPFS_ENVELOPE_AFTER_REFRESH_E2E'
  if (textContent(messages).includes(opfsEnvelopeAfterRefreshMarker) && hasTool(tools, 'read')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(opfsEnvelopeAfterRefreshMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-opfs-envelope-read-after-refresh',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/opfs-agent-file.txt', offset: 2, limit: 1 },
      })
      return
    }
    scriptedText(response, 'BROWSER_NATIVE_OPFS_ENVELOPE_AFTER_REFRESH_DONE')
    return
  }

  const fileToolBoundaryMarker = 'BROWSER_NATIVE_FILE_TOOL_BOUNDARY_E2E'
  if (textContent(messages).includes(fileToolBoundaryMarker) && hasTool(tools, 'grep')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(fileToolBoundaryMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-boundary-grep-many',
        name: 'grep',
        arguments: { pattern: 'BROWSER_NATIVE_BOUNDARY_MATCH', path: '/dsh/home/workspace/boundary.txt' },
      })
      return
    }
    if (toolResults.length === 1) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-boundary-grep-invalid',
        name: 'grep',
        arguments: { pattern: '[', path: '/dsh/home/workspace' },
      })
      return
    }
    if (toolResults.length === 2) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-boundary-grep-binary',
        name: 'grep',
        arguments: { pattern: 'x', path: '/dsh/home/workspace/binary.bin' },
      })
      return
    }
    scriptedText(response, 'BROWSER_NATIVE_FILE_TOOL_BOUNDARY_DONE')
    return
  }

  const workerToolInterruptionCases = [
    {
      marker: 'BROWSER_NATIVE_TOOL_STOP_GREP_E2E',
      id: 'browser-native-stop-grep',
      name: 'grep',
      arguments: { pattern: 'BROWSER_NATIVE_STOP_GREP_TARGET', path: '/dsh/home/workspace/stop-grep.txt' },
    },
    {
      marker: 'BROWSER_NATIVE_TOOL_STOP_EDIT_E2E',
      id: 'browser-native-stop-edit',
      name: 'edit',
      arguments: {
        file_path: '/dsh/home/workspace/stop-edit.txt',
        old_string: 'BROWSER_NATIVE_STOP_EDIT_TARGET',
        new_string: 'BROWSER_NATIVE_STOP_EDIT_REPLACED',
      },
    },
    {
      marker: 'BROWSER_NATIVE_EDIT_STAGE_CRASH_E2E',
      id: 'browser-native-edit-stage-crash',
      name: 'edit',
      arguments: {
        file_path: '/dsh/home/workspace/crash-edit.txt',
        old_string: 'BROWSER_NATIVE_CRASH_EDIT_TARGET',
        new_string: 'BROWSER_NATIVE_CRASH_EDIT_REPLACED',
      },
    },
  ]
  const latestPrompt = lastUserMessageText(messages)
  const workerToolInterruption = workerToolInterruptionCases.find(item => latestPrompt.includes(item.marker))
  if (workerToolInterruption !== undefined && hasTool(tools, workerToolInterruption.name)) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(workerToolInterruption.marker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      if (workerToolInterruption.name === 'edit') {
        await scriptedWorkspaceToolCall(response, {
          id: `${workerToolInterruption.id}-read`,
          name: 'read',
          arguments: { file_path: workerToolInterruption.arguments.file_path },
        })
        return
      }
    }
    if (toolResults.length === (workerToolInterruption.name === 'edit' ? 1 : 0)) {
      await scriptedWorkspaceToolCall(response, workerToolInterruption)
      return
    }
    scriptedText(response, `${workerToolInterruption.marker}_TOOL_SETTLED`)
    return
  }

  const workerToolContinuationCases = [
    {
      marker: 'BROWSER_NATIVE_STOP_GREP_CONTINUE_E2E',
      id: 'browser-native-stop-grep-continue',
      path: '/dsh/home/workspace/stop-grep.txt',
      pattern: 'BROWSER_NATIVE_STOP_GREP_TARGET',
    },
    {
      marker: 'BROWSER_NATIVE_STOP_EDIT_CONTINUE_E2E',
      id: 'browser-native-stop-edit-continue',
      path: '/dsh/home/workspace/stop-edit.txt',
      pattern: 'BROWSER_NATIVE_STOP_EDIT_TARGET',
    },
    {
      marker: 'BROWSER_NATIVE_CRASH_EDIT_CONTINUE_E2E',
      id: 'browser-native-crash-edit-continue',
      path: '/dsh/home/workspace/crash-edit.txt',
      pattern: 'BROWSER_NATIVE_CRASH_EDIT_TARGET',
    },
  ]
  const workerToolContinuation = workerToolContinuationCases.find(item => latestPrompt.includes(item.marker))
  if (workerToolContinuation !== undefined && hasTool(tools, 'grep')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(workerToolContinuation.marker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: workerToolContinuation.id,
        name: 'grep',
        arguments: { pattern: workerToolContinuation.pattern, path: workerToolContinuation.path },
      })
      return
    }
    scriptedText(response, workerToolContinuation.marker.replace('_E2E', '_DONE'))
    return
  }

  const grepCancelMarker = 'BROWSER_NATIVE_GREP_CANCEL_E2E'
  if (textContent(messages).includes(grepCancelMarker) && hasTool(tools, 'grep')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(grepCancelMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-grep-cancel',
        name: 'grep',
        arguments: { pattern: 'BROWSER_NATIVE_GREP_CANCEL_TARGET', path: '/dsh/home/workspace' },
      })
      return
    }
    scriptedText(response, 'BROWSER_NATIVE_GREP_CANCEL_COMPLETED')
    return
  }

  const grepIsolationMarker = 'BROWSER_NATIVE_GREP_ISOLATION_E2E'
  if (textContent(messages).includes(grepIsolationMarker) && hasTool(tools, 'grep')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(grepIsolationMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-grep-unmatched-long-line',
        name: 'grep',
        arguments: { pattern: 'NOT_PRESENT', path: '/dsh/home/workspace/long-no-match.txt' },
      })
      return
    }
    if (toolResults.length === 1) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-grep-backtracking-timeout',
        name: 'grep',
        arguments: { pattern: '^(SAFE_PARTIAL_MUST_NOT_ESCAPE|(a|aa)+)$', path: '/dsh/home/workspace/regex-stress.txt' },
      })
      return
    }
    if (toolResults.length === 2) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-glob-backtracking-timeout',
        name: 'glob',
        arguments: { pattern: '**a**a**a**a**a**a**a**z', path: '/dsh/home/workspace' },
      })
      return
    }
    if (toolResults.length === 3) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-grep-include-backtracking-timeout',
        name: 'grep',
        arguments: {
          pattern: '^SAFE_SEARCH_OK$',
          include: '**a**a**a**a**a**a**a**z',
          path: '/dsh/home/workspace',
        },
      })
      return
    }
    if (toolResults.length === 4) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-grep-after-timeout',
        name: 'grep',
        arguments: { pattern: '^SAFE_SEARCH_OK$', path: '/dsh/home/workspace/regex-safe.txt' },
      })
      return
    }
    if (toolResults.length === 5) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-glob-after-timeout',
        name: 'glob',
        arguments: { pattern: 'regex-safe.txt', path: '/dsh/home/workspace' },
      })
      return
    }
    scriptedText(response, 'BROWSER_NATIVE_GREP_ISOLATION_COMPLETED')
    return
  }

  if (hasUserMarker(messages, 'BROWSER_NATIVE_GREP_CANCEL_CONTINUE_E2E')) {
    scriptedText(response, 'BROWSER_NATIVE_GREP_CANCEL_CONTINUE_OK')
    return
  }

  const editBoundaryMarker = 'BROWSER_NATIVE_EDIT_BOUNDARY_E2E'
  if (textContent(messages).includes(editBoundaryMarker) && hasTool(tools, 'edit')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(editBoundaryMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-boundary-edit-read',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/long-edit.txt' },
      })
      return
    }
    if (toolResults.length === 1) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-boundary-edit-long-line',
        name: 'edit',
        arguments: {
          file_path: '/dsh/home/workspace/long-edit.txt',
          old_string: 'BROWSER_NATIVE_LONG_EDIT_MARKER',
          new_string: 'BROWSER_NATIVE_LONG_EDIT_REPLACED',
        },
      })
      return
    }
    scriptedText(response, 'BROWSER_NATIVE_EDIT_BOUNDARY_DONE')
    return
  }

  if (hasUserMarker(messages, 'BROWSER_NATIVE_FILE_TOOL_BOUNDARY_CONTINUE_E2E')) {
    scriptedText(response, 'BROWSER_NATIVE_FILE_TOOL_BOUNDARY_CONTINUE_OK')
    return
  }

  if (hasUserMarker(messages, 'BROWSER_NATIVE_AFTER_HITL_REFRESH_CONTINUE')) {
    const text = 'BROWSER_NATIVE_AFTER_HITL_REFRESH_CONTINUE_OK'
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    response.end()
    return
  }

  const shellSemanticsMarker = 'BROWSER_NATIVE_SHELL_SEMANTICS_E2E'
  if (latestUserText.includes(shellSemanticsMarker) && hasTool(tools, 'bash')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(shellSemanticsMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    const sequence = [
      {
        id: 'browser-native-shell-pipeline',
        command: "printf 'BROWSER_NATIVE_PIPE_x\\n' | tr x X",
        description: 'Verify the Worker shell pipeline',
      },
      {
        id: 'browser-native-shell-redirect',
        command: "printf 'BROWSER_NATIVE_REDIRECT_OK\\n' > /dsh/home/workspace/shell-redirect.txt",
        description: 'Verify the Worker shell file redirection',
      },
      {
        id: 'browser-native-shell-read-redirect',
        command: 'cat /dsh/home/workspace/shell-redirect.txt',
        description: 'Verify the redirected file can be read in the Worker',
      },
      {
        id: 'browser-native-shell-unsupported',
        command: 'browser-native-host-command-does-not-exist',
        description: 'Verify unsupported host commands fail closed',
      },
    ]
    if (toolResults.length < sequence.length) {
      const next = sequence[toolResults.length]
      await scriptedWorkspaceToolCall(response, {
        id: next.id,
        name: 'bash',
        arguments: { command: next.command, description: next.description },
      })
      return
    }
    scriptedText(response, 'BROWSER_NATIVE_SHELL_SEMANTICS_DONE')
    return
  }

  if (latestUserText.includes('BROWSER_NATIVE_SCRIPTED_E2E_OK')) {
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'BROWSER_NATIVE_SCRIPTED_E2E_OK' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'BROWSER_NATIVE_SCRIPTED_E2E_OK' } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    response.end()
    return
  }

  const capabilityBashMarker = 'BROWSER_NATIVE_CAPABILITY_BASH_E2E'
  if (latestUserText.includes(capabilityBashMarker)) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(capabilityBashMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0 && hasTool(tools, 'bash')) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-capability-bash-write',
        name: 'bash',
        arguments: {
          command: "printf 'BROWSER_NATIVE_CAPABILITY_BASH_DURABLE\\n' > /dsh/home/workspace/capability-bash.txt",
          description: 'Write a Workspace file through the Worker shell',
        },
      })
      return
    }
    scriptedText(response, toolResults.length === 1 ? 'BROWSER_NATIVE_CAPABILITY_BASH_DONE'
      : 'BROWSER_NATIVE_CAPABILITY_BASH_UNEXPECTED_ROSTER')
    return
  }

  const capabilityCloudPendingMarker = 'BROWSER_NATIVE_CAPABILITY_CLOUD_PENDING_E2E'
  if (latestUserText.includes(capabilityCloudPendingMarker)) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(capabilityCloudPendingMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0 && hasTool(tools, 'write')) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-capability-cloud-pending-write',
        name: 'write',
        arguments: {
          file_path: '/dsh/home/workspace/capability-cloud-pending.txt',
          content: 'local durable bytes remain available while cloud commit is pending\n',
        },
      })
      return
    }
    scriptedText(response, toolResults.length === 1 && hasTool(tools, 'write')
      ? 'BROWSER_NATIVE_CAPABILITY_CLOUD_PENDING_DONE'
      : 'BROWSER_NATIVE_CAPABILITY_CLOUD_PENDING_UNEXPECTED_ROSTER')
    return
  }

  const capabilityWithdrawalMarker = 'BROWSER_NATIVE_CAPABILITY_WITHDRAWAL_E2E'
  if (latestUserText.includes(capabilityWithdrawalMarker)) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(capabilityWithdrawalMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0 && hasTool(tools, 'write')) {
      await scriptedWorkspaceToolCalls(response, [
        {
          id: 'browser-native-capability-quota-write',
          name: 'write',
          arguments: {
            file_path: '/dsh/home/workspace/capability-quota-attempt.txt',
            content: 'the injected quota failure must prevent local durability\n',
          },
        },
        {
          id: 'browser-native-capability-late-write',
          name: 'write',
          arguments: {
            file_path: '/dsh/home/workspace/capability-late-attempt.txt',
            content: 'the second call must be denied before dispatch\n',
          },
        },
      ])
      return
    }
    scriptedText(response, toolResults.length === 2 && !hasTool(tools, 'write')
      ? 'BROWSER_NATIVE_CAPABILITY_WITHDRAWAL_DONE'
      : 'BROWSER_NATIVE_CAPABILITY_WITHDRAWAL_UNEXPECTED_ROSTER')
    return
  }

  const capabilityRecoveryMarker = 'BROWSER_NATIVE_CAPABILITY_RECOVERY_E2E'
  if (latestUserText.includes(capabilityRecoveryMarker)) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(capabilityRecoveryMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0 && hasTool(tools, 'read')) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-capability-recovered-read',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/capability-baseline.txt' },
      })
      return
    }
    scriptedText(response, toolResults.length === 1 && hasTool(tools, 'write')
      ? 'BROWSER_NATIVE_CAPABILITY_RECOVERY_DONE'
      : 'BROWSER_NATIVE_CAPABILITY_RECOVERY_UNEXPECTED_ROSTER')
    return
  }

  const observerRevisionRaceMarker = 'BROWSER_NATIVE_WORKSPACE_OBSERVER_REVISION_RACE_E2E'
  const leaseEditRaceMarker = 'BROWSER_NATIVE_WORKSPACE_LEASE_EDIT_RACE_E2E'
  if (latestUserText.includes(leaseEditRaceMarker) && hasTool(tools, 'edit')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(leaseEditRaceMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-workspace-lease-edit-race-read',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/lease-edit-race.txt', offset: 2048, limit: 1 },
      })
      return
    }
    if (toolResults.length === 1) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-workspace-lease-edit-race',
        name: 'edit',
        arguments: {
          file_path: '/dsh/home/workspace/lease-edit-race.txt',
          old_string: 'BROWSER_NATIVE_LEASE_EDIT_OLD',
          new_string: 'BROWSER_NATIVE_LEASE_EDIT_OLD_OWNER',
        },
      })
      return
    }
    const result = toolResults[1]?.content
    const resultText = typeof result === 'string' ? result
      : Array.isArray(result) ? result.filter(item => item?.type === 'text' && typeof item.text === 'string')
        .map(item => item.text).join('\n') : ''
    scriptedText(response, toolResults.length === 2 && /writer lease.*released/i.test(resultText)
      ? 'BROWSER_NATIVE_WORKSPACE_LEASE_EDIT_FENCED'
      : 'BROWSER_NATIVE_WORKSPACE_LEASE_EDIT_UNEXPECTED_RESULT')
    return
  }

  const leaseSuccessorMarker = 'BROWSER_NATIVE_WORKSPACE_LEASE_SUCCESSOR_E2E'
  if (latestUserText.includes(leaseSuccessorMarker) && hasTool(tools, 'write')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(leaseSuccessorMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-workspace-lease-successor-read',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/lease-edit-race.txt', offset: 1, limit: 1 },
      })
      return
    }
    if (toolResults.length === 1) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-workspace-lease-successor-write',
        name: 'write',
        arguments: {
          file_path: '/dsh/home/workspace/lease-edit-race.txt',
          content: 'BROWSER_NATIVE_LEASE_EDIT_NEW_OWNER\n',
        },
      })
      return
    }
    scriptedText(response, toolResults.length === 2
      ? 'BROWSER_NATIVE_WORKSPACE_LEASE_SUCCESSOR_DONE'
      : 'BROWSER_NATIVE_WORKSPACE_LEASE_SUCCESSOR_UNEXPECTED_RESULT')
    return
  }

  if (latestUserText.includes(observerRevisionRaceMarker)) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(observerRevisionRaceMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0 && hasTool(tools, 'read') && !hasTool(tools, 'write')
      && !hasTool(tools, 'edit') && !hasTool(tools, 'bash')) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-workspace-observer-revision-race-read',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/owner-committed.txt' },
      })
      return
    }
    const resultContent = typeof toolResults[0]?.content === 'string' ? toolResults[0].content
      : Array.isArray(toolResults[0]?.content)
        ? toolResults[0].content.filter(item => item?.type === 'text' && typeof item.text === 'string')
          .map(item => item.text).join('\n')
        : ''
    scriptedText(response, toolResults.length === 1 && /stale/i.test(resultContent)
      ? 'BROWSER_NATIVE_WORKSPACE_OBSERVER_REVISION_RACE_REJECTED'
      : 'BROWSER_NATIVE_WORKSPACE_OBSERVER_REVISION_RACE_UNEXPECTED_RESULT')
    return
  }

  const workspaceObserverCases = [
    {
      marker: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_READ_E2E',
      success: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_READ_DONE',
      denied: false,
    },
    {
      marker: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_STALE_E2E',
      success: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_STALE_BLOCKED',
      denied: true,
    },
  ]
  const workspaceObserverCase = workspaceObserverCases.find(item => latestUserText.includes(item.marker))
  if (workspaceObserverCase !== undefined) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(workspaceObserverCase.marker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0 && hasTool(tools, 'read') && !hasTool(tools, 'write') && !hasTool(tools, 'edit')
      && !hasTool(tools, 'bash') && !hasTool(tools, 'working_directory')) {
      await scriptedWorkspaceToolCall(response, {
        id: workspaceObserverCase.denied
          ? 'browser-native-workspace-observer-stale-read'
          : 'browser-native-workspace-observer-read',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/owner-committed.txt' },
      })
      return
    }
    const result = toolResults[0]
    const resultContent = typeof result?.content === 'string' ? result.content : ''
    const settled = workspaceObserverCase.denied
      ? result?.isError === true && /stale/i.test(resultContent)
      : result?.isError !== true && resultContent.includes('owner-committed-value')
    scriptedText(response, settled && toolResults.length === 1
      ? workspaceObserverCase.success
      : `${workspaceObserverCase.success}_UNEXPECTED_STATE`)
    return
  }

  const observerForgedWriteMarker = 'BROWSER_NATIVE_WORKSPACE_OBSERVER_FORGED_WRITE_E2E'
  if (latestUserText.includes(observerForgedWriteMarker)) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(observerForgedWriteMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-workspace-observer-forged-write',
        name: 'write',
        arguments: {
          file_path: '/dsh/home/workspace/observer-forged-write.txt',
          content: 'observer must not write this file\n',
        },
      })
      return
    }
    const resultContent = typeof toolResults[0]?.content === 'string' ? toolResults[0].content : ''
    scriptedText(response, toolResults.length === 1 && toolResults[0]?.isError === true
      && /capability is not currently published|observer cannot execute/i.test(resultContent)
      ? 'BROWSER_NATIVE_WORKSPACE_OBSERVER_FORGED_WRITE_REJECTED'
      : 'BROWSER_NATIVE_WORKSPACE_OBSERVER_FORGED_WRITE_UNEXPECTED_STATE')
    return
  }

  const observerOwnerMarker = 'BROWSER_NATIVE_WORKSPACE_OBSERVER_OWNER_E2E'
  if (latestUserText.includes(observerOwnerMarker)) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(observerOwnerMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0 && hasTool(tools, 'write')) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-workspace-observer-owner-write',
        name: 'write',
        arguments: {
          file_path: '/dsh/home/workspace/owner-committed.txt',
          content: 'owner-committed-value\n',
        },
      })
      return
    }
    scriptedText(response, toolResults.length === 1 ? 'BROWSER_NATIVE_WORKSPACE_OBSERVER_OWNER_DONE'
      : 'BROWSER_NATIVE_WORKSPACE_OBSERVER_OWNER_UNEXPECTED_STATE')
    return
  }

  const observerAfterRefreshMarker = 'BROWSER_NATIVE_WORKSPACE_OBSERVER_AFTER_REFRESH_E2E'
  if (latestUserText.includes(observerAfterRefreshMarker)) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(observerAfterRefreshMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0 && hasTool(tools, 'write')) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-workspace-observer-after-refresh-write',
        name: 'write',
        arguments: {
          file_path: '/dsh/home/workspace/observer-after-refresh.txt',
          content: 'observer-writer-value\n',
        },
      })
      return
    }
    scriptedText(response, toolResults.length === 1 ? 'BROWSER_NATIVE_WORKSPACE_OBSERVER_AFTER_REFRESH_DONE'
      : 'BROWSER_NATIVE_WORKSPACE_OBSERVER_AFTER_REFRESH_UNEXPECTED_STATE')
    return
  }

  if (hasUserMarker(messages, 'BROWSER_NATIVE_QUOTA_GUARD_E2E') && hasTool(tools, 'write')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes('BROWSER_NATIVE_QUOTA_GUARD_E2E'))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-quota-guard-write',
        name: 'write',
        arguments: {
          file_path: '/dsh/home/workspace/quota-guard-attempt.txt',
          content: 'this write must be blocked while local storage is unresolved\n',
        },
      })
      return
    }
    const text = 'BROWSER_NATIVE_QUOTA_GUARD_DONE'
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    response.end()
    return
  }

  if (latestUserText.includes('BROWSER_NATIVE_DEFAULT_PROFILE_TOOL_E2E')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes('BROWSER_NATIVE_DEFAULT_PROFILE_TOOL_E2E'))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0 && hasTool(tools, 'bash')) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-default-profile-bash',
        name: 'bash',
        arguments: { command: "printf 'BROWSER_NATIVE_WORKER_SHELL_OK\\n'", description: 'Verify the Worker shell command table' },
      })
      return
    }
    const text = toolResults.length === 0
      ? 'BROWSER_NATIVE_DEFAULT_PROFILE_BASH_NOT_EXPOSED'
      : 'BROWSER_NATIVE_DEFAULT_PROFILE_TOOL_LOOP_OK'
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    response.end()
    return
  }

  const interactionMarker = 'BROWSER_NATIVE_INTERACTION_TOOLS_E2E'
  if (hasUserMarker(messages, interactionMarker)
    && ['ask_user_question', 'working_directory', 'write'].every(name => hasTool(tools, name))) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(interactionMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    const sequence = [
      {
        id: 'browser-native-interaction-ask-user',
        name: 'ask_user_question',
        arguments: {
          questions: [{
            id: 'continue',
            question: 'May I continue with the file operation?',
            header: 'Confirmation',
            options: [{ label: 'Yes' }, { label: 'No' }],
          }],
        },
      },
      {
        id: 'browser-native-interaction-working-directory',
        name: 'working_directory',
        arguments: { cd: '/dsh/home/workspace/interaction-dir' },
      },
      {
        id: 'browser-native-interaction-write',
        name: 'write',
        arguments: { file_path: 'relative-result.txt', content: 'working-directory-relative-write-ok\n' },
      },
    ]
    if (toolResults.length < sequence.length) {
      await scriptedWorkspaceToolCall(response, sequence[toolResults.length])
      return
    }
    const text = 'BROWSER_NATIVE_INTERACTION_TOOLS_DONE'
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    response.end()
    return
  }

  const handoffPrompt = messages.findLast(message => message.role === 'user'
    && typeof message.content === 'string'
    && (message.content.includes('BROWSER_NATIVE_WRITER_HANDOFF_FIRST_E2E')
      || message.content.includes('BROWSER_NATIVE_WRITER_HANDOFF_SECOND_E2E')))
  const writerHandoffMarker = handoffPrompt?.content.includes('BROWSER_NATIVE_WRITER_HANDOFF_SECOND_E2E') === true
    ? 'BROWSER_NATIVE_WRITER_HANDOFF_SECOND_E2E'
    : handoffPrompt === undefined ? undefined : 'BROWSER_NATIVE_WRITER_HANDOFF_FIRST_E2E'
  if (writerHandoffMarker !== undefined && hasTool(tools, 'write')) {
    const first = writerHandoffMarker.endsWith('FIRST_E2E')
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(writerHandoffMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: first ? 'browser-native-writer-handoff-first-write' : 'browser-native-writer-handoff-second-write',
        name: 'write',
        arguments: {
          file_path: `/dsh/home/workspace/${first ? 'writer-first.txt' : 'writer-second.txt'}`,
          content: `${first ? 'first' : 'second'}-worker-write-ok\n`,
        },
      })
      return
    }
    const text = first ? 'BROWSER_NATIVE_WRITER_HANDOFF_FIRST_DONE' : 'BROWSER_NATIVE_WRITER_HANDOFF_SECOND_DONE'
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    response.end()
    return
  }

  const crashWindowMarker = textContent(messages).includes('BROWSER_NATIVE_WORKSPACE_CRASH_WINDOW_E2E')
  if (crashWindowMarker && hasTool(tools, 'write')) {
    await scriptedWorkspaceToolCall(response, {
      id: 'browser-native-workspace-crash-window-write',
      name: 'write',
      arguments: {
        file_path: '/dsh/home/workspace/crash-window.txt',
        content: 'crash-window-payload\n',
      },
    })
    return
  }

  const durableEditMarker = [
    'BROWSER_NATIVE_DURABLE_EDIT_RETRY_E2E',
    'BROWSER_NATIVE_DURABLE_EDIT_FAILURE_E2E',
  ].find(marker => hasUserMarker(messages, marker))
  if (durableEditMarker !== undefined && hasTool(tools, 'edit')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(durableEditMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: durableEditMarker === 'BROWSER_NATIVE_DURABLE_EDIT_FAILURE_E2E'
          ? 'browser-native-durable-edit-before-read'
          : 'browser-native-durable-edit-retry-before-read',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/durable-edit.txt' },
      })
      return
    }
    if ((durableEditMarker === 'BROWSER_NATIVE_DURABLE_EDIT_FAILURE_E2E' && toolResults.length === 1)
      || (durableEditMarker === 'BROWSER_NATIVE_DURABLE_EDIT_RETRY_E2E' && toolResults.length === 1)) {
      await scriptedWorkspaceToolCall(response, {
        id: durableEditMarker === 'BROWSER_NATIVE_DURABLE_EDIT_FAILURE_E2E'
          ? 'browser-native-durable-edit-failure'
          : 'browser-native-durable-edit-retry',
        name: 'edit',
        arguments: {
          file_path: '/dsh/home/workspace/durable-edit.txt',
          old_string: 'before',
          new_string: 'after',
        },
      })
      return
    }
    if (durableEditMarker === 'BROWSER_NATIVE_DURABLE_EDIT_FAILURE_E2E' && toolResults.length === 2) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-durable-edit-follow-up-read',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/durable-edit.txt' },
      })
      return
    }
    if (durableEditMarker === 'BROWSER_NATIVE_DURABLE_EDIT_FAILURE_E2E' && toolResults.length === 3) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-durable-edit-follow-up-grep',
        name: 'grep',
        arguments: { pattern: 'after', path: '/dsh/home/workspace/durable-edit.txt' },
      })
      return
    }
    if (durableEditMarker === 'BROWSER_NATIVE_DURABLE_EDIT_FAILURE_E2E' && toolResults.length === 4) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-durable-edit-follow-up-glob',
        name: 'glob',
        arguments: { pattern: '**/durable-edit.txt', path: '/dsh/home/workspace' },
      })
      return
    }
    if (durableEditMarker === 'BROWSER_NATIVE_DURABLE_EDIT_FAILURE_E2E' && toolResults.length === 5) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-durable-edit-follow-up-write',
        name: 'write',
        arguments: { file_path: '/dsh/home/workspace/volatile-follow-up.txt', content: 'must not write\n' },
      })
      return
    }
    const text = durableEditMarker === 'BROWSER_NATIVE_DURABLE_EDIT_FAILURE_E2E'
      ? 'BROWSER_NATIVE_DURABLE_EDIT_FAILURE_TURN_DONE'
      : 'BROWSER_NATIVE_DURABLE_EDIT_RETRY_TURN_DONE'
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    response.end()
    return
  }

  const durableAckMarker = [
    'BROWSER_NATIVE_DURABLE_ACK_RETRY_E2E',
    'BROWSER_NATIVE_DURABLE_ACK_FAILURE_E2E',
  ].find(marker => hasUserMarker(messages, marker))
  if (durableAckMarker !== undefined && hasTool(tools, 'write')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(durableAckMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: durableAckMarker === 'BROWSER_NATIVE_DURABLE_ACK_FAILURE_E2E'
          ? 'browser-native-durable-ack-failure-write'
          : 'browser-native-durable-ack-retry-write',
        name: 'write',
        arguments: {
          file_path: '/dsh/home/workspace/durable-ack.txt',
          content: 'durable acknowledgement retry succeeded\n',
        },
      })
      return
    }
    const text = durableAckMarker === 'BROWSER_NATIVE_DURABLE_ACK_FAILURE_E2E'
      ? 'BROWSER_NATIVE_DURABLE_ACK_FAILURE_TURN_DONE'
      : 'BROWSER_NATIVE_DURABLE_ACK_RETRY_TURN_DONE'
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    response.end()
    return
  }

  const principalWorkspaceWrites = [
    { marker: 'BROWSER_NATIVE_PRINCIPAL_SCOPE_A', id: 'browser-native-principal-a-write', content: 'principal-A\n' },
    { marker: 'BROWSER_NATIVE_PRINCIPAL_SCOPE_B', id: 'browser-native-principal-b-write', content: 'principal-B\n' },
  ]
  const principalWorkspaceWrite = principalWorkspaceWrites.find(item => latestUserText.includes(item.marker))
  if (principalWorkspaceWrite !== undefined && hasTool(tools, 'write')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(principalWorkspaceWrite.marker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: principalWorkspaceWrite.id,
        name: 'write',
        arguments: { file_path: '/dsh/home/workspace/account-scope.txt', content: principalWorkspaceWrite.content },
      })
      return
    }
    scriptedText(response, `${principalWorkspaceWrite.marker}_DONE`)
    return
  }

  const principalWorkspaceReadCases = [
    { marker: 'BROWSER_NATIVE_PRINCIPAL_CROSS_READ', id: 'browser-native-principal-cross-read', done: 'BROWSER_NATIVE_PRINCIPAL_CROSS_READ_DONE' },
    { marker: 'BROWSER_NATIVE_PRINCIPAL_RESTORE_A', id: 'browser-native-principal-restore-a-read', done: 'BROWSER_NATIVE_PRINCIPAL_RESTORE_A_DONE' },
  ]
  const principalWorkspaceRead = principalWorkspaceReadCases.find(item => latestUserText.includes(item.marker))
  if (principalWorkspaceRead !== undefined && hasTool(tools, 'read')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(principalWorkspaceRead.marker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: principalWorkspaceRead.id,
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/account-scope.txt' },
      })
      return
    }
    scriptedText(response, principalWorkspaceRead.done)
    return
  }

  if (hasUserMarker(messages, 'BROWSER_NATIVE_WORKSPACE_EDIT_E2E')
    && ['write', 'read', 'edit'].every(name => hasTool(tools, name))) {
    const sequence = [
      {
        id: 'browser-native-edit-sequence-write-initial',
        name: 'write',
        arguments: { file_path: '/dsh/home/workspace/agent-edit.txt', content: 'alpha\nbeta\n' },
      },
      {
        id: 'browser-native-edit-sequence-read-before-edit',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/agent-edit.txt' },
      },
      {
        id: 'browser-native-edit-sequence-edit',
        name: 'edit',
        arguments: { file_path: '/dsh/home/workspace/agent-edit.txt', old_string: 'beta', new_string: 'BETA' },
      },
      {
        id: 'browser-native-edit-sequence-write-second-file',
        name: 'write',
        arguments: { file_path: '/dsh/home/workspace/agent-edit-summary.txt', content: 'edited=agent-edit.txt\n' },
      },
    ]
    const completedCalls = messages.filter(message => message.role === 'tool').length
    if (completedCalls < sequence.length) {
      await scriptedWorkspaceToolCall(response, sequence[completedCalls])
      return
    }
    const text = 'BROWSER_NATIVE_WORKSPACE_EDIT_DONE'
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    response.end()
    return
  }

  const workspaceMarker = [
    'BROWSER_NATIVE_WORKSPACE_TOOL_E2E',
    'BROWSER_NATIVE_WORKSPACE_CRASH_E2E',
  ].find(marker => hasUserMarker(messages, marker))
  if (workspaceMarker !== undefined && !hasToolResult(messages) && hasTool(tools, 'write')) {
    await scriptedWorkspaceToolCall(response, {
      id: 'browser-native-workspace-tool-call',
      name: 'write',
      arguments: {
        file_path: '/dsh/home/workspace/agent-receipt.txt',
        content: 'BROWSER_NATIVE_WORKSPACE_TOOL_OK\n',
      },
    })
    return
  }
  const text = workspaceMarker === 'BROWSER_NATIVE_WORKSPACE_TOOL_E2E'
    ? 'BROWSER_NATIVE_WORKSPACE_TOOL_DONE'
    : workspaceMarker === 'BROWSER_NATIVE_WORKSPACE_CRASH_E2E'
      ? 'BROWSER_NATIVE_WORKSPACE_CRASH_DONE'
      : `Browser-native DSH completed this turn: ${textContent(messages).slice(0, 240)}`
  writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
  for (const part of text.match(/.{1,32}/g) ?? []) {
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text: part } })
    await new Promise(resolveDelay => setTimeout(resolveDelay, 120))
  }
  writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
  writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
  response.end()
}

async function realLlm(response, request, config, body) {
  const controller = new AbortController()
  let clientClosed = false
  let timedOut = false
  const abortForClient = () => {
    clientClosed = true
    controller.abort()
  }
  const abortForResponseClose = () => {
    if (!response.writableEnded) abortForClient()
  }
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, config.timeoutMs)
  request.on('aborted', abortForClient)
  response.on('close', abortForResponseClose)
  try {
    let upstream
    try {
      upstream = await fetch(config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${config.apiKey}`,
          'user-agent': 'deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)',
        },
        body: JSON.stringify({
          model: config.model,
          messages: body.messages,
          tools: body.tools,
          temperature: body.temperature,
          max_tokens: body.maxTokens,
          reasoning_effort: body.reasoningEffort,
          stream: true,
        }),
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut) throw new BackendError('UPSTREAM_LLM_TIMEOUT', `upstream LLM did not respond within ${config.timeoutMs}ms`, 504)
      if (clientClosed) return
      throw new BackendError('UPSTREAM_LLM_UNAVAILABLE', 'upstream LLM could not be reached', 502)
    }
    if (!upstream.ok || upstream.body === null) {
      throw new BackendError('UPSTREAM_LLM_FAILED', `upstream LLM returned HTTP ${upstream.status}`, 502)
    }
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-browser-native-protocol': String(PROTOCOL_VERSION),
    })
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    const toolCalls = new Map()
    let nextIndex = 0
    let textIndex
    let finished = false
    const finishStream = finishReason => {
      if (toolCalls.size === 0 && textIndex === undefined) {
        writeStream(response, { kind: 'error', error: { code: 'UPSTREAM_LLM_EMPTY', message: 'upstream LLM completed without text or tool calls' } })
        finished = true
        return true
      }
      if (textIndex !== undefined) writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: textIndex, block: { type: 'text', text } } })
      for (const { index, ...toolCall } of toolCalls.values()) writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index, block: { type: 'tool-call', ...toolCall } } })
      writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: finishReason === 'length' ? { kind: 'max-tokens' } : toolCalls.size > 0 ? { kind: 'tool-calls' } : { kind: 'stop' } } })
      finished = true
      return true
    }
    const consume = data => {
      if (data === '[DONE]') return finished || finishStream(toolCalls.size > 0 ? 'tool_calls' : 'stop')
      const item = JSON.parse(data)
      const delta = item.choices?.[0]?.delta
      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        if (textIndex === undefined) {
          textIndex = nextIndex++
          writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: textIndex, blockType: 'text' } })
        }
        text += delta.content
        writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: textIndex, text: delta.content } })
      }
      for (const providerCall of delta?.tool_calls ?? []) {
        const providerIndex = providerCall.index ?? 0
        let toolCall = toolCalls.get(providerIndex)
        if (toolCall === undefined) {
          toolCall = { index: nextIndex++, id: providerCall.id ?? randomUUID(), name: '', arguments: '' }
          toolCalls.set(providerIndex, toolCall)
          writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: toolCall.index, blockType: 'tool-call' } })
        }
        if (providerCall.id !== undefined) toolCall.id = providerCall.id
        toolCall.name += providerCall.function?.name ?? ''
        if (providerCall.function?.arguments) {
          toolCall.arguments += providerCall.function.arguments
          writeStream(response, { kind: 'chunk', chunk: { type: 'tool-call-delta', index: toolCall.index, id: toolCall.id, name: toolCall.name, argumentsDelta: providerCall.function.arguments } })
        }
      }
      const finish = item.choices?.[0]?.finish_reason
      if (finish !== undefined && finish !== null) {
        return finishStream(finish)
      }
      return false
    }
    while (true) {
      const part = await reader.read()
      buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:') && consume(line.slice(5).trim())) {
          response.end()
          return
        }
        newline = buffer.indexOf('\n')
      }
      if (part.done) break
    }
    if (!finished && !clientClosed) {
      if (timedOut) writeStreamError(response, 'UPSTREAM_LLM_TIMEOUT', `upstream LLM did not finish within ${config.timeoutMs}ms`)
      else writeStreamError(response, 'UPSTREAM_LLM_TRUNCATED', 'upstream LLM stream ended before a finish event')
    } else if (!response.writableEnded) {
      response.end()
    }
  } catch (error) {
    if (clientClosed) return
    if (timedOut && response.headersSent) {
      writeStreamError(response, 'UPSTREAM_LLM_TIMEOUT', `upstream LLM did not finish within ${config.timeoutMs}ms`)
      return
    }
    if (response.headersSent) {
      writeStreamError(response, 'UPSTREAM_LLM_STREAM_FAILED', 'upstream LLM stream failed before completion')
      return
    }
    throw error
  } finally {
    clearTimeout(timeout)
    request.off('aborted', abortForClient)
    response.off('close', abortForResponseClose)
  }
}

function safeStaticPath(root, pathname) {
  const relativePath = pathname === '/' ? 'preview.html' : pathname.slice(1)
  const file = resolve(root, relativePath)
  if (relative(root, file).startsWith('..')) throw new BackendError('NOT_FOUND', 'file not found', 404)
  return file
}

async function serveStatic(response, root, pathname) {
  let body
  try {
    body = await readFile(safeStaticPath(root, pathname))
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EISDIR') throw new BackendError('NOT_FOUND', 'file not found', 404)
    throw error
  }
  const file = pathname.toLowerCase()
  const contentType = file.endsWith('.html') ? 'text/html; charset=utf-8'
    : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.json') ? 'application/json; charset=utf-8'
          : file.endsWith('.gz') ? 'application/gzip'
            : 'application/octet-stream'
  response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
  response.end(body)
}

/**
 * Create the PoC server. Verified downloads require explicit chunk-object mode.
 * @param {object} options - Server configuration; workspaceVerifiedDownloads defaults
 * to false, workspaceDownloadMaxReaders to 4, and workspaceDownloadTimeoutMs to 30000.
 * Reader limits include verification; deadlines include verification and transmission.
 * Cancellation destroys the connection immediately; in-progress descriptor/chunk
 * verification finishes before its returned reader can be closed and its slot released.
 * @returns {Promise<object>} Server and stores; close waits for download cleanup.
 */
export async function createBrowserNativeV2Server(options) {
  if (options.workspaceChunkObjects !== undefined && typeof options.workspaceChunkObjects !== 'boolean') {
    throw new TypeError('workspaceChunkObjects must be a boolean')
  }
  if (options.workspaceVerifiedDownloads !== undefined && typeof options.workspaceVerifiedDownloads !== 'boolean') {
    throw new TypeError('workspaceVerifiedDownloads must be a boolean')
  }
  if (options.workspaceVerifiedDownloads === true && options.workspaceChunkObjects !== true) {
    throw new TypeError('workspaceVerifiedDownloads requires workspaceChunkObjects: true')
  }
  const workspaceDownloadMaxReaders = timeoutMs(options.workspaceDownloadMaxReaders === undefined ? 4
    : options.workspaceDownloadMaxReaders, 'workspaceDownloadMaxReaders')
  const workspaceDownloadTimeoutMs = timeoutMs(options.workspaceDownloadTimeoutMs === undefined ? 30_000
    : options.workspaceDownloadTimeoutMs, 'workspaceDownloadTimeoutMs')
  if (workspaceDownloadTimeoutMs > 2_147_483_647) {
    throw new TypeError('workspaceDownloadTimeoutMs exceeds the Node timer limit')
  }
  const dataDirLock = await acquireDataDirLock(options.dataDir)
  let released = false
  const releaseDataDirLock = async () => {
    if (released) return
    released = true
    await dataDirLock.release()
  }
  try {
  const store = new FormalSessionStore(options.dataDir, {
    ownerLeaseMs: options.ownerLeaseMs,
    now: options.testHooks?.now,
    failFlush: options.testHooks?.failSessionFlush,
    failFlushAfterRename: options.testHooks?.failSessionFlushAfterRename,
  })
  await store.load()
  const workspaces = new WorkspaceStore(options.dataDir, {
    writerLeaseMs: options.testHooks?.workspaceWriterLeaseMs,
    now: options.testHooks?.workspaceNow ?? options.testHooks?.now,
    pendingUploadTtlMs: options.pendingUploadTtlMs,
    blobStore: options.workspaceBlobStore,
    chunkObjects: options.workspaceChunkObjects === true,
  })
  await workspaces.load()
  const crossStoreLedger = new CrossStoreOperationLedger(options.dataDir, { now: options.testHooks?.now })
  await crossStoreLedger.load()
  const businessServiceOrigin = options.businessServiceOrigin === undefined
    ? undefined
    : new URL(options.businessServiceOrigin).origin
  const llm = await createLlmConfig(options)
  const distRoot = resolve(options.distRoot ?? join(HERE, '../../../apps/web/dist'))
  const workspaceDownloads = new Map()
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://browser-native.invalid')
      if (request.method === 'GET' && url.pathname === '/api/browser-native/health') {
        sendJson(response, 200, { ok: true, llmMode: llm.mode, model: llm.model, ...(llm.timeoutMs === undefined ? {} : { llmTimeoutMs: llm.timeoutMs }) })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/config') {
        sendJson(response, 200, {
          llmMode: llm.mode,
          provider: llm.provider,
          model: llm.model,
          ...(llm.contextWindow === undefined ? {} : { contextWindow: llm.contextWindow }),
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/workspace/identity') {
        if (request.headers['x-browser-native-identity-mode'] === 'existing') {
          sendJson(response, 200, workspaces.lookupIdentity(request))
          return
        }
        const identity = await workspaces.openIdentity(request, request.socket.encrypted === true)
        sendJson(response, 200, { workspaceId: identity.workspaceId }, { 'set-cookie': identity.cookies })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/workspace/upload-capabilities') {
        for (const [key, value] of url.searchParams) {
          if (key !== 'protocolVersion' || value !== String(PROTOCOL_VERSION)) {
            throw new WorkspaceError('PROTOCOL_UNSUPPORTED', 'unsupported upload capability parameter')
          }
        }
        sendJson(response, 200, { contentLayout: WORKSPACE_CONTENT_LAYOUT,
          ...(options.workspaceChunkObjects === true ? { fileStorage: { version: 1, kind: 'chunk-objects' } } : {}),
          ...(options.workspaceVerifiedDownloads === true ? { fileDownload: { version: 1, kind: 'verified-stream' } } : {}) })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/workspace/manifest') {
        if (url.searchParams.get('protocolVersion') !== String(PROTOCOL_VERSION)) {
          throw new WorkspaceError('PROTOCOL_UNSUPPORTED', 'unsupported browser-native protocol')
        }
        sendJson(response, 200, workspaces.manifest(request, url.searchParams.get('workspaceId')))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/workspace/revision') {
        if (url.searchParams.get('protocolVersion') !== String(PROTOCOL_VERSION)) {
          throw new WorkspaceError('PROTOCOL_UNSUPPORTED', 'unsupported browser-native protocol')
        }
        sendJson(response, 200, workspaces.revision(request, url.searchParams.get('workspaceId')))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/workspace/blob-upload/start') {
        const body = await readBody(request)
        assertProtocol(body)
        sendJson(response, 200, await workspaces.startBlobUpload(request, body))
        return
      }
      const uploadReuse = url.pathname.match(/^\/api\/browser-native\/workspace\/blob-upload\/([0-9a-f-]{36})-([a-f0-9]{64})\/reuse$/i)
      if (request.method === 'POST' && uploadReuse !== null) {
        const body = await readBody(request)
        assertProtocol(body)
        sendJson(response, 200, await workspaces.reuseBlobChunks(
          request, body.workspaceId, uploadReuse[1], uploadReuse[2], body,
        ))
        return
      }
      const uploadStatus = url.pathname.match(/^\/api\/browser-native\/workspace\/blob-upload\/([0-9a-f-]{36})-([a-f0-9]{64})$/i)
      if (request.method === 'GET' && uploadStatus !== null) {
        if (url.searchParams.get('protocolVersion') !== String(PROTOCOL_VERSION)) {
          throw new WorkspaceError('PROTOCOL_UNSUPPORTED', 'unsupported browser-native protocol')
        }
        sendJson(response, 200, await workspaces.blobUploadStatus(
          request,
          url.searchParams.get('workspaceId'),
          uploadStatus[1],
          uploadStatus[2],
        ))
        return
      }
      const uploadChunk = url.pathname.match(/^\/api\/browser-native\/workspace\/blob-upload\/([0-9a-f-]{36})-([a-f0-9]{64})\/([0-9]+)$/i)
      if (request.method === 'PUT' && uploadChunk !== null) {
        if (request.headers['x-browser-native-protocol'] !== String(PROTOCOL_VERSION)) {
          throw new WorkspaceError('PROTOCOL_UNSUPPORTED', 'unsupported browser-native protocol')
        }
        const workspaceId = request.headers['x-workspace-id']
        const requestId = request.headers['x-request-id']
        const chunkHash = request.headers['x-chunk-sha256']
        if (typeof requestId !== 'string' || requestId.length === 0) throw new WorkspaceError('INVALID_REQUEST', 'requestId is required')
        if (typeof chunkHash !== 'string') throw new WorkspaceError('INVALID_REQUEST', 'chunk SHA-256 is required')
        const bytes = await readRawBody(request, MAX_WORKSPACE_CHUNK_BODY_BYTES)
        sendJson(response, 200, await workspaces.putBlobChunk(
          request,
          workspaceId,
          uploadChunk[1],
          uploadChunk[2],
          Number(uploadChunk[3]),
          bytes,
          chunkHash,
        ))
        return
      }
      const uploadComplete = url.pathname.match(/^\/api\/browser-native\/workspace\/blob-upload\/([0-9a-f-]{36})-([a-f0-9]{64})\/complete$/i)
      if (request.method === 'POST' && uploadComplete !== null) {
        const body = await readBody(request)
        assertProtocol(body)
        sendJson(response, 200, await workspaces.completeBlobUpload(
          request,
          body.workspaceId,
          uploadComplete[1],
          uploadComplete[2],
        ))
        return
      }
      const blobStream = url.pathname.match(/^\/api\/browser-native\/workspace\/blob\/([a-f0-9]{64})\/stream$/)
      if (request.method === 'GET' && blobStream !== null) {
        if (options.workspaceVerifiedDownloads !== true) throw new BackendError('NOT_FOUND', 'route not found', 404)
        if (url.searchParams.get('protocolVersion') !== String(PROTOCOL_VERSION)
          || [...url.searchParams.keys()].some(key => key !== 'protocolVersion' && key !== 'workspaceId')
          || url.searchParams.getAll('protocolVersion').length !== 1 || url.searchParams.getAll('workspaceId').length !== 1) {
          throw new WorkspaceError('PROTOCOL_UNSUPPORTED', 'unsupported file download query')
        }
        if (workspaceDownloads.size >= workspaceDownloadMaxReaders) {
          throw new WorkspaceError('FILE_DOWNLOAD_BUSY', 'too many active file downloads; retry after a download finishes', 429)
        }
        const controller = new AbortController()
        const download = streamWorkspaceBlob(request, response, workspaces, url.searchParams.get('workspaceId'),
          blobStream[1], workspaceDownloadTimeoutMs, controller)
        workspaceDownloads.set(download, controller)
        try { await download } finally { workspaceDownloads.delete(download) }
        return
      }
      const blobLayout = url.pathname.match(/^\/api\/browser-native\/workspace\/blob\/([a-f0-9]{64})\/layout$/i)
      if (request.method === 'GET' && blobLayout !== null) {
        if (url.searchParams.get('protocolVersion') !== String(PROTOCOL_VERSION)
          || [...url.searchParams.keys()].some(key => key !== 'protocolVersion' && key !== 'workspaceId')
          || url.searchParams.getAll('protocolVersion').length !== 1 || url.searchParams.getAll('workspaceId').length !== 1) {
          throw new WorkspaceError('PROTOCOL_UNSUPPORTED', 'unsupported content layout query')
        }
        sendJson(response, 200, await workspaces.getContentLayout(request, url.searchParams.get('workspaceId'), blobLayout[1]))
        return
      }
      const blobChunk = url.pathname.match(/^\/api\/browser-native\/workspace\/blob\/([a-f0-9]{64})\/chunk\/([0-9]+)$/i)
      if (request.method === 'GET' && blobChunk !== null) {
        if (url.searchParams.get('protocolVersion') !== String(PROTOCOL_VERSION)) {
          throw new WorkspaceError('PROTOCOL_UNSUPPORTED', 'unsupported browser-native protocol')
        }
        const result = await workspaces.getBlobChunk(
          request,
          url.searchParams.get('workspaceId'),
          blobChunk[1],
          Number(blobChunk[2]),
        )
        sendBytes(response, result.bytes, {
          'x-content-sha256': result.chunkHash,
          'x-chunk-index': String(result.chunkIndex),
          'x-chunk-count': String(result.chunkCount),
          'x-total-bytes': String(result.totalBytes),
        })
        return
      }
      if (request.method === 'GET' && /^\/api\/browser-native\/workspace\/blob\/[a-f0-9]{64}$/.test(url.pathname)) {
        if (url.searchParams.get('protocolVersion') !== String(PROTOCOL_VERSION)) {
          throw new WorkspaceError('PROTOCOL_UNSUPPORTED', 'unsupported browser-native protocol')
        }
        const hash = url.pathname.split('/').at(-1)
        const bytes = await workspaces.getBlob(request, url.searchParams.get('workspaceId'), hash)
        sendBytes(response, bytes)
        return
      }
      if (request.method === 'PUT' && /^\/api\/browser-native\/workspace\/blob\/[a-f0-9]{64}$/.test(url.pathname)) {
        if (request.headers['x-browser-native-protocol'] !== String(PROTOCOL_VERSION)) {
          throw new WorkspaceError('PROTOCOL_UNSUPPORTED', 'unsupported browser-native protocol')
        }
        const hash = url.pathname.split('/').at(-1)
        const workspaceId = request.headers['x-workspace-id']
        const requestId = request.headers['x-request-id']
        if (typeof requestId !== 'string' || requestId.length === 0) throw new WorkspaceError('INVALID_REQUEST', 'requestId is required')
        const bytes = await readRawBody(request, MAX_BODY_BYTES)
        sendJson(response, 200, await workspaces.putBlob(request, workspaceId, hash, bytes))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/workspace/lease') {
        const body = await readBody(request)
        assertProtocol(body)
        const result = await workspaces.lease(request, body)
        if (body.operation === 'release' && options.testHooks?.dropWorkspaceLeaseReleaseResponse?.(body, result) === true) {
          response.destroy()
          return
        }
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'GET' && /^\/api\/browser-native\/workspace\/operation\/[0-9a-f-]{36}$/i.test(url.pathname)) {
        if (url.searchParams.get('protocolVersion') !== String(PROTOCOL_VERSION)) {
          throw new WorkspaceError('PROTOCOL_UNSUPPORTED', 'unsupported browser-native protocol')
        }
        const operationId = url.pathname.split('/').at(-1)
        sendJson(response, 200, workspaces.operation(request, url.searchParams.get('workspaceId'), operationId))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/workspace/cross-store-operation/intent') {
        const body = await readBody(request)
        assertProtocol(body)
        const principalId = workspaces.principalFromRequest(request)
        workspaces.requireWorkspace(principalId, body.workspaceId)
        const result = await crossStoreLedger.intent(principalId, { ...body, principalId: body.principalId ?? principalId })
        if (businessServiceOrigin !== undefined) {
          await requestExternalBusiness(businessServiceOrigin, '/v1/intent', {
            operationId: body.operationId,
            principalId,
            payloadDigest: body.payloadDigest,
          })
        }
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/workspace/cross-store-operation/receipt') {
        const body = await readBody(request)
        assertProtocol(body)
        const principalId = workspaces.principalFromRequest(request)
        sendJson(response, 200, await crossStoreLedger.receipt(
          principalId, body.operationId, body.kind, body.status, body.receipt, body.identity,
        ))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/workspace/cross-store-operation/business') {
        const body = await readBody(request)
        assertProtocol(body)
        const principalId = workspaces.principalFromRequest(request)
        let result
        if (businessServiceOrigin === undefined) {
          result = await crossStoreLedger.businessEffect(principalId, body.operationId, body.payload, body.identity)
          if (options.testHooks?.failAfterCrossStoreBusinessEffect?.(body, result) === true) {
            throw new BackendError('E2E_INJECTED_BUSINESS_RESPONSE_FAILURE', 'E2E injected response failure after business effect', 503)
          }
        } else {
          const current = crossStoreLedger.query(principalId, body.operationId)
          const payloadDigest = fullDigest(body.payload)
          if (current.intent.payloadDigest !== payloadDigest) {
            throw new CrossStoreLedgerError('OPERATION_ID_REUSED', 'business payload differs from the operation intent', 409)
          }
          const external = await requestExternalBusiness(businessServiceOrigin, '/v1/effect', {
            operationId: body.operationId,
            principalId,
            payloadDigest,
          })
          if (options.testHooks?.failAfterExternalBusinessEffectBeforeLedger?.(body, external) === true) {
            throw new BackendError('E2E_INJECTED_EXTERNAL_BUSINESS_LEDGER_FAILURE', 'E2E injected failure after external business effect', 503)
          }
          result = await crossStoreLedger.businessReceipt(principalId, body.operationId, external.receipt, body.identity)
          result = { ...result, externalBusinessReplayed: external.replayed === true }
        }
        if (options.testHooks?.dropCrossStoreBusinessResponse?.(body, result) === true) {
          response.destroy()
          return
        }
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'GET' && /^\/api\/browser-native\/workspace\/cross-store-operation\/[0-9a-f-]{36}$/i.test(url.pathname)) {
        if (url.searchParams.get('protocolVersion') !== String(PROTOCOL_VERSION)) {
          throw new CrossStoreLedgerError('PROTOCOL_UNSUPPORTED', 'unsupported browser-native protocol')
        }
        const principalId = workspaces.principalFromRequest(request)
        const operationId = url.pathname.split('/').at(-1)
        let result = crossStoreLedger.query(principalId, operationId)
        if (businessServiceOrigin !== undefined && result.receipts.business?.status !== 'committed') {
          try {
            const external = await queryExternalBusiness(businessServiceOrigin, operationId, principalId)
            if (external.status === 'committed' && external.receipt !== undefined) {
              result = await crossStoreLedger.businessReceipt(principalId, operationId, external.receipt)
            }
          } catch (error) {
            if (!(error instanceof BackendError)
              || (error.code !== 'BUSINESS_QUERY_UNAVAILABLE' && error.code !== 'BUSINESS_SERVICE_UNAVAILABLE')) throw error
          }
        }
        if (url.searchParams.get('workspaceId') !== result.identity.workspaceId
          || url.searchParams.get('sessionId') !== result.identity.sessionId) {
          throw new CrossStoreLedgerError('OPERATION_IDENTITY_MISMATCH', 'operation query identity does not match the intent', 409)
        }
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/workspace/commit') {
        const body = await readBody(request)
        assertProtocol(body)
        sendJson(response, 200, await workspaces.commit(request, body))
        return
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/browser-native/session/')) {
        const operation = url.pathname.split('/').at(-1)
        const body = await readBody(request)
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        if (operation === 'handoff' && body.checkpoint !== null && typeof body.checkpoint === 'object'
          && Object.hasOwn(body.checkpoint, 'durableThroughSeq')) {
          const checkpoint = body.checkpoint
          const writerToken = boundedString(body.workspaceWriterToken, 'workspaceWriterToken', 200)
          await workspaces.validateExecutionHandoff(request, {
            workspaceId: boundedString(checkpoint.workspaceId, 'checkpoint.workspaceId', MAX_CHECKPOINT_ID_LENGTH),
            writerToken,
            fencingToken: checkpoint.workspaceFencingToken,
            revision: checkpoint.workspaceRevision,
          })
        }
        const result = await sessionOperation(store, operation, body, principalId, options.testHooks)
        if (operation === 'handoff' && options.testHooks?.dropSessionHandoffResponse?.(body, result) === true) {
          response.destroy()
          return
        }
        if (operation === 'append' && options.testHooks?.dropSessionAppendResponse?.(body, result) === true) {
          response.destroy()
          return
        }
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/llm') {
        const body = await readBody(request)
        assertProtocol(body)
        if (!Array.isArray(body.messages)) throw new BackendError('INVALID_REQUEST', 'messages must be an array')
        if (body.purpose !== undefined && body.purpose !== 'compaction' && body.purpose !== 'session-title') {
          throw new BackendError('INVALID_REQUEST', 'purpose must be compaction or session-title')
        }
        if (body.sessionId !== undefined) {
          const session = store.get(body.sessionId)
          if (typeof body.ownerToken !== 'string' || body.ownerToken.length === 0) {
            throw new BackendError('SESSION_NOT_FOUND', 'session does not exist', 404)
          }
          store.assertOwner(session, body.ownerToken, body.ownerEpoch)
        }
        if (options.testHooks?.failLlmRequest?.(body) === true) {
          throw new BackendError('E2E_INJECTED_LLM_FAILURE', 'E2E injected model request failure', 400)
        }
        if (llm.mode === 'scripted') {
          response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
          let clientClosed = false
          const onClose = () => {
            if (response.writableEnded) return
            clientClosed = true
            options.testHooks?.onLlmClientClose?.(body)
          }
          response.on('close', onClose)
          try {
            await scriptedLlm(
              response,
              body.messages,
              body.tools,
              options.testHooks?.scriptedLlmFault?.(body),
              () => clientClosed,
              body.purpose,
            )
          } finally {
            response.off('close', onClose)
          }
        } else {
          await realLlm(response, request, llm, body)
        }
        return
      }
      if (request.method === 'GET') {
        await serveStatic(response, distRoot, url.pathname)
        return
      }
      throw new BackendError('NOT_FOUND', 'route not found', 404)
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendError(response, error)
      else response.destroy()
    }
  })
  return {
    server,
    store,
    workspaces,
    crossStoreLedger,
    llm,
    listen: (port = options.port ?? 4175, host = options.host ?? '127.0.0.1') => new Promise((resolveListen, reject) => {
      const onError = async error => {
        await releaseDataDirLock().catch(() => {})
        reject(error)
      }
      server.once('error', onError)
      server.listen(port, host, () => {
        server.off('error', onError)
        const address = server.address()
        resolveListen(`http://${host}:${address.port}`)
      })
    }),
    close: async () => {
      try {
        for (const controller of workspaceDownloads.values()) controller.abort()
        await new Promise((resolveClose, reject) => {
          server.closeAllConnections()
          server.close(error => error ? reject(error) : resolveClose())
        })
      } finally {
        try { await Promise.allSettled([...workspaceDownloads.keys()]) } finally { await releaseDataDirLock() }
      }
    },
  }
  } catch (error) {
    await releaseDataDirLock().catch(() => {})
    throw error
  }
}
