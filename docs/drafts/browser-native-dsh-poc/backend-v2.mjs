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
import { WORKSPACE_BLOB_CHUNK_BYTES, WorkspaceError, WorkspaceStore } from './workspace-v2.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PROTOCOL_VERSION = 1
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_WORKSPACE_CHUNK_BODY_BYTES = WORKSPACE_BLOB_CHUNK_BYTES
const MAX_EVENTS = 100_000
const MAX_SESSION_APPEND_EVENTS = 1_024
const MAX_SESSION_APPEND_BYTES = 1 * 1024 * 1024
const MAX_SESSION_READ_EVENTS = 2_048
const MAX_SESSION_READ_BYTES = 2 * 1024 * 1024
const MAX_CATALOG_PAGE_SIZE = 100
const MAX_HANDOFF_ID_LENGTH = 200
const MAX_CHECKPOINT_IDS = 1_000
const MAX_CHECKPOINT_ID_LENGTH = 200
const DEFAULT_OWNER_LEASE_MS = 30_000
const DEFAULT_LLM_TIMEOUT_MS = 60_000
const DATA_DIR_LOCK_NAME = '.browser-native-backend.lock'

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

function catalogCursorFor(sessionId) {
  return Buffer.from(sessionId, 'utf8').toString('base64url')
}

function sessionIdFromCatalogCursor(cursor) {
  boundedString(cursor, 'cursor', 400)
  let value
  try {
    value = Buffer.from(cursor, 'base64url').toString('utf8')
  } catch {
    throw new BackendError('INVALID_REQUEST', 'cursor is invalid')
  }
  assertSessionId(value)
  if (catalogCursorFor(value) !== cursor) throw new BackendError('INVALID_REQUEST', 'cursor is invalid')
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
  for (const key of Object.keys(checkpoint)) {
    if (!expectedKeys.has(key)) throw new BackendError('CHECKPOINT_INVALID', `checkpoint field ${key} is not supported`)
  }
  if (checkpoint.sessionId !== session.id) throw new BackendError('CHECKPOINT_INVALID', 'checkpoint sessionId does not match the Session')
  boundedString(checkpoint.ownerId, 'checkpoint.ownerId', MAX_CHECKPOINT_ID_LENGTH)
  if (checkpoint.epoch !== ownerEpoch) throw new BackendError('CHECKPOINT_INVALID', 'checkpoint epoch does not match the current owner')
  boundedInteger(checkpoint.nextSessionSeq, 'checkpoint.nextSessionSeq', MAX_EVENTS)
  if (requireCurrent && checkpoint.nextSessionSeq !== session.events.length) throw new BackendError('CHECKPOINT_INVALID', 'checkpoint nextSessionSeq is not the current Session cursor')
  boundedInteger(checkpoint.workspaceRevision, 'checkpoint.workspaceRevision', Number.MAX_SAFE_INTEGER)
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

function sendError(response, error) {
  const detail = error instanceof BackendError || error instanceof WorkspaceError
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
      const handoffs = new Map()
      let handoffsMigrated = false
      for (const [handoffId, record] of Object.entries(raw.handoffs ?? {})) {
        const normalized = normalizeHandoffRecord(handoffId, record)
        handoffs.set(handoffId, clone(normalized.record))
        handoffsMigrated ||= normalized.migrated
      }
      const session = {
        id,
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

  create(id, header, inheritedEventCount) {
    if (this.sessions.has(id)) throw new BackendError('SESSION_ALREADY_EXISTS', 'session already exists', 409)
    if (header.id !== id) throw new BackendError('INVALID_REQUEST', 'header id does not match session id')
    const session = {
      id,
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

async function sessionOperation(store, operation, body, testHooks = {}) {
  assertProtocol(body)
  if (operation === 'list') {
    return store.exclusive('__list__', async () => {
      const limit = body.limit === undefined ? 50 : boundedInteger(body.limit, 'limit', MAX_CATALOG_PAGE_SIZE)
      if (limit === 0) throw new BackendError('INVALID_REQUEST', 'limit must be at least 1')
      const after = body.cursor === undefined ? undefined : sessionIdFromCatalogCursor(body.cursor)
      const sessions = [...store.sessions.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
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
          ? { nextCursor: catalogCursorFor(page.at(-1).id) }
          : {}),
      }
    })
  }
  const id = assertSessionId(body.sessionId)
  testHooks.onSessionOperationQueued?.(operation, body)
  return store.exclusive(id, async () => {
    await testHooks.beforeSessionOperation?.(operation, body)
    if (operation === 'create') {
      const session = store.create(id, assertRecord(body.header, 'header'), body.inheritedEventCount ?? 0)
      const owner = store.claim(session)
      return sessionResponse(session, { owner })
    }
    const session = store.get(id)
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
      return sessionResponse(session, { closed: true, ...(durabilityReceipt === undefined ? {} : { durabilityReceipt }) })
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
      if (body.events.length > MAX_SESSION_APPEND_EVENTS) throw new BackendError('REQUEST_TOO_LARGE', 'Session append event count exceeds the request limit', 413)
      if (jsonBytes(body.events) > MAX_SESSION_APPEND_BYTES) throw new BackendError('REQUEST_TOO_LARGE', 'Session append exceeds the request byte budget', 413)
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
  const externalEditCrashMarker = 'BROWSER_NATIVE_EXTERNAL_EDIT_CRASH_WINDOW_E2E'
  if (textContent(messages).includes(externalEditCrashMarker) && hasTool(tools, 'edit')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(externalEditCrashMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-external-edit-crash-read',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/external-edit-crash.txt' },
      })
      return
    }
    if (toolResults.length === 1) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-external-edit-crash-window',
        name: 'edit',
        arguments: {
          file_path: '/dsh/home/workspace/external-edit-crash.txt',
          old_string: 'before',
          new_string: 'after',
        },
      })
      return
    }
    scriptedText(response, 'BROWSER_NATIVE_EXTERNAL_EDIT_CRASH_DONE')
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
  if (textContent(messages).includes(opfsAgentToolsMarker)
    && ['read', 'grep', 'edit'].every(name => hasTool(tools, name))) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(opfsAgentToolsMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    const sequence = [
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
    ]
    if (toolResults.length < sequence.length) {
      await scriptedWorkspaceToolCall(response, sequence[toolResults.length])
      return
    }
    const text = 'BROWSER_NATIVE_OPFS_AGENT_TOOLS_DONE'
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

export async function createBrowserNativeV2Server(options) {
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
  })
  await workspaces.load()
  const llm = await createLlmConfig(options)
  const distRoot = resolve(options.distRoot ?? join(HERE, '../../../apps/web/dist'))
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
        const identity = await workspaces.openIdentity(request, request.socket.encrypted === true)
        sendJson(response, 200, { workspaceId: identity.workspaceId }, { 'set-cookie': identity.cookie })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/workspace/manifest') {
        if (url.searchParams.get('protocolVersion') !== String(PROTOCOL_VERSION)) {
          throw new WorkspaceError('PROTOCOL_UNSUPPORTED', 'unsupported browser-native protocol')
        }
        sendJson(response, 200, workspaces.manifest(request, url.searchParams.get('workspaceId')))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/workspace/blob-upload/start') {
        const body = await readBody(request)
        assertProtocol(body)
        sendJson(response, 200, await workspaces.startBlobUpload(request, body))
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
        sendJson(response, 200, await workspaces.lease(request, body))
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
      if (request.method === 'POST' && url.pathname === '/api/browser-native/workspace/commit') {
        const body = await readBody(request)
        assertProtocol(body)
        sendJson(response, 200, await workspaces.commit(request, body))
        return
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/browser-native/session/')) {
        const operation = url.pathname.split('/').at(-1)
        const body = await readBody(request)
        const result = await sessionOperation(store, operation, body, options.testHooks)
        if (operation === 'handoff' && options.testHooks?.dropSessionHandoffResponse?.(body, result) === true) {
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
      if (!response.headersSent) sendError(response, error)
      else response.destroy()
    }
  })
  return {
    server,
    store,
    workspaces,
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
        await new Promise((resolveClose, reject) => {
          server.closeAllConnections()
          server.close(error => error ? reject(error) : resolveClose())
        })
      } finally {
        await releaseDataDirLock()
      }
    },
  }
  } catch (error) {
    await releaseDataDirLock().catch(() => {})
    throw error
  }
}
