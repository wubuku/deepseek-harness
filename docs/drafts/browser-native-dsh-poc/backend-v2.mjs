/**
 * Backend for the browser-native DSH v2 PoC.
 *
 * It serves the already-built DSH preview surface, stores formal Session
 * headers/events, and proxies the Worker-side LLM adapter to a scripted model
 * or an OpenAI-compatible upstream. Credentials are loaded only in this Node
 * process and are never included in responses or logs.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { chmod, link, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { relative, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { WORKSPACE_BLOB_CHUNK_BYTES, WORKSPACE_CONTENT_LAYOUT, WorkspaceError, WorkspaceStore } from './workspace-v2.mjs'
import { SESSION_APPEND_MAX_BYTES, SESSION_APPEND_MAX_EVENTS } from './session-transport-limits.mjs'
import { CrossStoreLedgerError, CrossStoreOperationLedger } from './cross-store-operation-ledger.mjs'
import { createEgressPolicy, EgressError } from './egress-proxy-v2.mjs'
import { AdmissionError, createAdmissionController } from './admission-v2.mjs'
import { DurableTurnError, createDurableTurnHost } from './durable-host-v2.mjs'
import { createMetricsRegistry, metricRoute } from './observability-v2.mjs'
import { createAlertEvaluator } from './observability-alerts.mjs'
import { createObservabilityJournal, redactObservabilityJournal } from './observability-journal.mjs'
import {
  buildBudgetSnapshot,
  buildUsageReport,
  normalizeBudgetLimits,
  normalizeUsagePricing,
  usageReportCsv,
} from './usage-report.mjs'
import { buildPrincipalExport, verifyPrincipalExport } from './principal-export.mjs'
import { SessionShareError, SessionShareStore } from './session-shares.mjs'
import { buildTraceReport, traceIdFor } from './subagent-trace.mjs'
import { TurnRetryLedger } from './turn-retry-ledger.mjs'
import { SessionEventHub } from './session-event-hub.mjs'
import { assertDataFormatReadable } from './hosted/data-format.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PROTOCOL_VERSION = 1
/** Logical Session log format read and written here; mirrors `SESSION_FORMAT_VERSION` in packages/core/session/src/types.ts. */
const SESSION_FORMAT_VERSION = 4
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_WORKSPACE_CHUNK_BODY_BYTES = WORKSPACE_BLOB_CHUNK_BYTES
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024
const MAX_ATTACHMENT_CHUNK_BYTES = 16 * 1024 * 1024
const ATTACHMENT_UPLOAD_TTL_MS = 60 * 60 * 1000
const ATTACHMENT_UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_ATTACHMENT_GC_MIN_AGE_MS = 5 * 60 * 1000
const DEFAULT_ATTACHMENT_GC_SWEEP_MS = 5 * 60 * 1000
const MAX_EVENTS = 100_000
const MAX_SESSION_READ_EVENTS = 2_048
const MAX_SESSION_READ_BYTES = 2 * 1024 * 1024
const MAX_CATALOG_PAGE_SIZE = 100
const MAX_SESSION_APPEND_RECEIPTS = 1_000
const MAX_HANDOFF_ID_LENGTH = 200
const MAX_CHECKPOINT_IDS = 1_000
const MAX_CHECKPOINT_ID_LENGTH = 200
const DEFAULT_OWNER_LEASE_MS = 30_000
const DEFAULT_RETENTION_SWEEP_MS = 5 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_LLM_TIMEOUT_MS = 60_000
const DATA_DIR_LOCK_NAME = '.browser-native-backend.lock'
const PRINCIPAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const CREDENTIAL_QUERY_NAME = /(token|secret|password|credential|authorization|api[-_]?key|access[-_]?key)/i
/** Base64 image data URL produced by the Worker LLM adapter for provider-visible image blocks. */
const IMAGE_DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/
const SAME_ORIGIN_SITE_VALUES = new Set(['same-origin', 'none'])
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
// `sec-fetch-mode` is excluded: Node's fetch sends `cors`, and a non-browser
// client must stay distinguishable from a page. Browsers always send at least
// `sec-fetch-site` on subresource and fetch traffic.
const BROWSER_PROVENANCE_HEADERS = ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-dest']
const ACCESS_AUDIT_LIMIT = 200
const AUTH_TOKEN_FILE_NAME = 'browser-native-auth-token'
const AUTH_TOKEN_HEADER = 'x-browser-native-auth'
const AUTH_COOKIE_NAME = 'dsh-browser-native-auth'
const AUTH_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60

class BackendError extends Error {
  constructor(code, message, status = 400, retryAfterMs, details) {
    super(message)
    this.name = 'BackendError'
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
    this.details = details
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

/**
 * Refuse a Session log whose header version this backend cannot read.
 *
 * The worker writes current-format events only, so an older or newer header
 * means the log belongs to another harness generation. Reading it anyway could
 * reconstruct the wrong conversation; this build ships no migration.
 * @param {string} id - Stored Session identifier.
 * @param {unknown} storedVersion - Version recorded in the stored header.
 * @returns {BackendError} Refusal carrying both versions for the client.
 */
function unsupportedSessionFormat(id, storedVersion) {
  const label = Number.isSafeInteger(storedVersion) ? `v${String(storedVersion)}` : 'an unknown version'
  return new BackendError(
    'SESSION_FORMAT_UNSUPPORTED',
    `session "${id}" uses log format ${label}, but this backend reads only v${String(SESSION_FORMAT_VERSION)}`,
    422,
    undefined,
    {
      ...(Number.isSafeInteger(storedVersion) ? { storedVersion } : {}),
      expectedVersion: SESSION_FORMAT_VERSION,
    },
  )
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

/**
 * Keep one read page inside the response byte budget without skipping events.
 * A single oversized event still advances the page so a reader can make progress.
 * @param {object[]} events - Sequential events already sliced to the requested window.
 * @returns {object[]} The longest prefix that fits, or the first event when even it does not fit.
 */
function truncateReadPage(events) {
  let bytes = 2
  let count = 0
  for (const event of events) {
    const nextBytes = bytes + (count === 0 ? 0 : 1) + jsonBytes([event]) - 2
    if (count > 0 && nextBytes > MAX_SESSION_READ_BYTES) break
    bytes = nextBytes
    count += 1
  }
  return events.slice(0, count)
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

/**
 * Public projection of one durable turn retry intent.
 * @param {object} record - stored intent.
 * @returns {object} response fields for the page.
 */
function turnRetryResponse(record) {
  return {
    retryId: record.retryId,
    sessionId: record.sessionId,
    turn: record.turn,
    prompt: record.prompt,
    requestedAt: record.requestedAt,
    settledAt: record.settledAt,
  }
}

/**
 * Extract the text of one user message content field.
 * @param {unknown} content - string or content-block array.
 * @returns {string | undefined} joined text, or undefined when empty.
 */
function promptText(content) {
  if (typeof content === 'string') return content.length === 0 ? undefined : content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  return text.length === 0 ? undefined : text
}

/**
 * Most recent Agent turn whose terminal reason permits a user-initiated retry.
 * @param {object} session - stored Session carrying its events.
 * @returns {{turn: number, reason: string, code: string} | undefined} The failed turn and its failure code, when its user prompt is recoverable.
 */
function latestRetryableTurn(session) {
  const terminal = session.events.findLast(event => event.type === 'turn/end')
  if (terminal === undefined || !['error', 'aborted', 'interrupted'].includes(terminal.data.reason?.kind)) return undefined
  const userMessage = session.events.slice(0, terminal.seq).findLast(event => event.type === 'user/message')
  if (promptText(userMessage?.data.content ?? userMessage?.data.message?.content) === undefined) return undefined
  const failure = terminal.data.reason?.error
  const code = typeof failure?.code === 'string' && failure.code.length > 0 ? failure.code : 'UNKNOWN_FAILURE'
  return { turn: terminal.data.turn, reason: terminal.data.reason.kind, code }
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

/**
 * Close one listener after dropping its keep-alive connections.
 * @param {import('node:http').Server} server - Listener to close.
 * @returns {Promise<void>} Resolves once the listener is down or was never started.
 */
function closeServer(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolveClose, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolveClose())
  })
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
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
    'x-content-type-options': 'nosniff',
    'x-browser-native-protocol': String(PROTOCOL_VERSION),
    ...headers,
  })
  response.end(bytes)
}

function attachmentName(value) {
  if (value === undefined) return 'file'
  if (typeof value !== 'string' || value.length > 4096) {
    throw new BackendError('INVALID_REQUEST', 'attachment name is invalid')
  }
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  let clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"|?*]/g, '_').trim().replace(/[. ]+$/u, '')
  const dot = clean.indexOf('.')
  const stem = (dot < 0 ? clean : clean.slice(0, dot)).replace(/[. ]+$/u, '')
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)) clean = `_${clean}`
  let nameBytes = 0
  let boundedName = ''
  for (const character of clean) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (nameBytes + characterBytes > 255) break
    boundedName += character
    nameBytes += characterBytes
  }
  clean = boundedName.replace(/[. ]+$/u, '')
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean
}

function attachmentPath(dataDir, workspaceId, hash) {
  return join(dataDir, 'attachments-v1', workspaceId, hash.slice(0, 2), hash)
}

function attachmentUploadRoot(dataDir, workspaceId) {
  return join(dataDir, 'attachment-uploads-v1', workspaceId)
}

function attachmentUploadPartPath(dataDir, workspaceId, uploadId) {
  return join(attachmentUploadRoot(dataDir, workspaceId), `${uploadId}.part`)
}

function attachmentUploadMetaPath(dataDir, workspaceId, uploadId) {
  return join(attachmentUploadRoot(dataDir, workspaceId), `${uploadId}.json`)
}

const ATTACHMENT_HASH_PATTERN = /^sha256:([a-f0-9]{64})$/

function referencedAttachmentHashes(sessions) {
  const referenced = new Set()
  for (const session of sessions) {
    for (const event of session.events) {
      if (event?.type !== 'user/message' || !Array.isArray(event.data?.content)) continue
      for (const block of event.data.content) {
        if (block?.type !== 'file') continue
        const match = ATTACHMENT_HASH_PATTERN.exec(String(block.attachment?.attachmentId))
        if (match?.[1] !== undefined) referenced.add(match[1])
      }
    }
  }
  return referenced
}

const SESSION_BUNDLE_FORMAT = 'dsh-session-bundle'
const SESSION_BUNDLE_VERSION = 1

/**
 * Build a refusal for a portable Session bundle that cannot be interpreted.
 * @param message - Actionable reason shown to the caller.
 * @returns {BackendError} Client-facing validation error.
 */
function invalidBundle(message) {
  return new BackendError('INVALID_BUNDLE', message)
}

/**
 * Map attachment references in a Session log to their sha256 digests.
 * @param events - Session events in stored order.
 * @returns {Map<string, {attachmentId: string, name: string | undefined}>} References keyed by hex digest.
 */
function bundleAttachmentReferences(events) {
  const references = new Map()
  for (const event of events) {
    if (event?.type !== 'user/message' || !Array.isArray(event.data?.content)) continue
    for (const block of event.data.content) {
      if (block?.type !== 'file') continue
      const attachmentId = String(block.attachment?.attachmentId)
      const match = ATTACHMENT_HASH_PATTERN.exec(attachmentId)
      if (match?.[1] === undefined) throw invalidBundle('a Session attachment reference is not a sha256 digest')
      if (!references.has(match[1])) {
        references.set(match[1], {
          attachmentId,
          name: typeof block.attachment?.name === 'string' ? block.attachment.name : undefined,
        })
      }
    }
  }
  return references
}

/**
 * Decode one bundled attachment and verify its declared size and digest.
 * @param entry - Bundle attachment entry with base64 payload.
 * @returns {{hash: string, attachmentId: string, name: string | undefined, bytes: number, data: Buffer}} Verified attachment.
 */
function decodeBundleAttachment(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw invalidBundle('an attachment entry must be an object')
  const match = ATTACHMENT_HASH_PATTERN.exec(String(entry.attachmentId))
  if (match?.[1] === undefined) throw invalidBundle('attachmentId must be a sha256 digest')
  if (typeof entry.data !== 'string' || entry.data.length === 0) throw invalidBundle('attachment data must be non-empty base64')
  const data = Buffer.from(entry.data, 'base64')
  if (data.toString('base64') !== entry.data) throw invalidBundle('attachment data is not canonical base64')
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes !== data.byteLength) {
    throw new BackendError('ATTACHMENT_SIZE_MISMATCH', `attachment ${match[1]} declares ${String(entry.bytes)} bytes but carries ${String(data.byteLength)}`, 409)
  }
  if (createHash('sha256').update(data).digest('hex') !== match[1]) {
    throw new BackendError('ATTACHMENT_DIGEST_MISMATCH', `attachment ${match[1]} does not match its sha256 digest`, 409)
  }
  return {
    hash: match[1],
    attachmentId: String(entry.attachmentId),
    name: typeof entry.name === 'string' ? entry.name : undefined,
    bytes: data.byteLength,
    data,
  }
}

/**
 * Validate a portable Session bundle without touching the store or disk.
 *
 * Rejection is the contract: an unsupported version, a non-contiguous
 * sequence, a missing attachment or a digest mismatch must fail the import
 * rather than produce a session that reads back differently.
 * @param bundle - Parsed JSON request body.
 * @returns {{header: object, inheritedEventCount: number, events: object[], durableThroughSeq: number, attachments: object[], attachmentCount: number}} Normalized bundle.
 */
function assertSessionBundle(bundle) {
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) throw invalidBundle('bundle must be an object')
  if (bundle.format !== SESSION_BUNDLE_FORMAT) throw invalidBundle(`bundle format must be ${SESSION_BUNDLE_FORMAT}`)
  if (!Number.isSafeInteger(bundle.formatVersion)) throw invalidBundle('bundle formatVersion must be an integer')
  if (bundle.formatVersion !== SESSION_BUNDLE_VERSION) {
    throw new BackendError(
      'UNSUPPORTED_BUNDLE_VERSION',
      `bundle format v${String(bundle.formatVersion)} is not supported; this build reads v${String(SESSION_BUNDLE_VERSION)}`,
      409,
    )
  }
  const session = bundle.session
  if (session === null || typeof session !== 'object' || Array.isArray(session)) throw invalidBundle('session must be an object')
  if (typeof session.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(session.id) || session.id.length === 0 || session.id.length > 200) {
    throw invalidBundle('session id is invalid')
  }
  const header = session.header
  if (header === null || typeof header !== 'object' || Array.isArray(header)) throw invalidBundle('session header must be an object')
  if (header.id !== session.id) throw invalidBundle('session header id does not match the bundle session id')
  if (header.version !== SESSION_FORMAT_VERSION) throw unsupportedSessionFormat(session.id, header.version)
  const inheritedEventCount = session.inheritedEventCount ?? 0
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0) throw invalidBundle('inheritedEventCount must be a non-negative integer')
  if (!Array.isArray(session.events)) throw invalidBundle('session events must be an array')
  if (session.events.length > MAX_EVENTS) {
    throw new BackendError('REQUEST_TOO_LARGE', `a Session bundle may carry at most ${String(MAX_EVENTS)} events`, 413)
  }
  for (const [index, event] of session.events.entries()) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) throw invalidBundle(`event ${String(index)} must be an object`)
    if (event.seq !== index) throw invalidBundle(`event ${String(index)} has seq ${String(event.seq)}; sequences must be contiguous from 0`)
    if (typeof event.type !== 'string' || event.type.length === 0 || event.type.length > 200) throw invalidBundle(`event ${String(index)} has no type`)
    if (event.data === undefined) throw invalidBundle(`event ${String(index)} has no data`)
  }
  const references = bundleAttachmentReferences(session.events)
  const entries = bundle.attachments ?? []
  if (!Array.isArray(entries)) throw invalidBundle('attachments must be an array')
  const decoded = new Map()
  for (const entry of entries) {
    const attachment = decodeBundleAttachment(entry)
    const previous = decoded.get(attachment.hash)
    if (previous !== undefined && !previous.data.equals(attachment.data)) {
      throw new BackendError('ATTACHMENT_DIGEST_MISMATCH', `attachment ${attachment.hash} appears twice with different data`, 409)
    }
    decoded.set(attachment.hash, attachment)
  }
  for (const [hash, reference] of references) {
    if (!decoded.has(hash)) {
      throw new BackendError('ATTACHMENT_MISSING', `Session references attachment ${reference.attachmentId} but the bundle does not carry it`, 409)
    }
  }
  const durableThroughSeq = session.durableThroughSeq ?? session.events.length - 1
  if (!Number.isSafeInteger(durableThroughSeq) || durableThroughSeq < -1 || durableThroughSeq >= session.events.length) {
    throw invalidBundle('durableThroughSeq is outside the event range')
  }
  return {
    header,
    inheritedEventCount,
    events: session.events,
    durableThroughSeq,
    attachments: [...decoded.values()],
    attachmentCount: references.size,
  }
}

async function listAttachmentWorkspaces(dataDir) {
  const root = join(dataDir, 'attachments-v1')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isDirectory() && entry.name.length > 0 && entry.name.length <= 200)
    .map(entry => entry.name)
}

async function listAttachmentObjects(dataDir, workspaceId) {
  const root = join(dataDir, 'attachments-v1', workspaceId)
  const objects = []
  for (const prefix of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue
    const directory = join(root, prefix.name)
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !/^[a-f0-9]{64}$/.test(entry.name)) continue
      const info = await stat(join(directory, entry.name)).catch(() => undefined)
      if (info === undefined || !info.isFile()) continue
      objects.push({ hash: entry.name, path: join(directory, entry.name), modifiedAt: info.mtimeMs })
    }
  }
  return objects
}

async function verifyAttachmentObject(path, hash) {
  const info = await stat(path).catch(() => undefined)
  if (info === undefined || !info.isFile() || info.size > MAX_ATTACHMENT_BYTES) return undefined
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex') === hash ? info.size : undefined
}

async function storeAttachmentObject(
  request,
  dataDir,
  workspaceId,
  hash,
  maximumBytes = MAX_ATTACHMENT_BYTES,
  onStage = () => {},
  onChunk = () => {},
  publish = async operation => await operation(),
) {
  const assertRequestActive = () => {
    if (!request.aborted) return
    throw new Error('attachment upload request was aborted')
  }
  const directoryPath = join(dataDir, 'attachments-v1', workspaceId, hash.slice(0, 2))
  await mkdir(directoryPath, { recursive: true, mode: 0o700 })
  const target = attachmentPath(dataDir, workspaceId, hash)
  const existing = await verifyAttachmentObject(target, hash)
  if (existing !== undefined) {
    let received = 0
    const digest = createHash('sha256')
    onStage('upload-body')
    for await (const chunk of request) {
      if (received > maximumBytes - chunk.byteLength) {
        throw new BackendError('ATTACHMENT_TOO_LARGE', 'attachment exceeds the configured byte limit', 413)
      }
      received += chunk.byteLength
      digest.update(chunk)
      await onChunk(chunk.byteLength, { workspaceId, hash })
      assertRequestActive()
    }
    if (received !== existing || digest.digest('hex') !== hash) {
      throw new BackendError('ATTACHMENT_HASH_MISMATCH', 'uploaded bytes do not match the requested SHA-256 digest', 400)
    }
    await publish(async () => {
      if (await verifyAttachmentObject(target, hash) !== existing) {
        throw new BackendError('ATTACHMENT_OBJECT_CONFLICT', 'attachment object was collected during the upload; retry the upload', 409)
      }
    })
    onStage('object-reused')
    return { bytes: existing, reused: true }
  }

  const temporaryPath = join(directoryPath, `${randomUUID()}.part`)
  const handle = await open(temporaryPath, 'wx', 0o600)
  const digest = createHash('sha256')
  let bytes = 0
  let closed = false
  let reused = false
  try {
    onStage('upload-body')
    for await (const chunk of request) {
      if (bytes > maximumBytes - chunk.byteLength) {
        throw new BackendError('ATTACHMENT_TOO_LARGE', 'attachment exceeds the configured byte limit', 413)
      }
      digest.update(chunk)
      await onChunk(chunk.byteLength, { workspaceId, hash })
      assertRequestActive()
      let offset = 0
      while (offset < chunk.byteLength) {
        const result = await handle.write(chunk, offset, chunk.byteLength - offset, bytes + offset)
        if (result.bytesWritten < 1) throw new Error('attachment object store wrote zero bytes')
        offset += result.bytesWritten
      }
      bytes += chunk.byteLength
    }
    if (digest.digest('hex') !== hash) {
      throw new BackendError('ATTACHMENT_HASH_MISMATCH', 'uploaded bytes do not match the requested SHA-256 digest', 400)
    }
    assertRequestActive()
    onStage('body-verified')
    await handle.chmod(0o400)
    await handle.sync()
    await handle.close()
    closed = true
    assertRequestActive()
    await publish(async () => {
      try {
        await link(temporaryPath, target)
      } catch (error) {
        if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
        const committedBytes = await verifyAttachmentObject(target, hash)
        if (committedBytes !== bytes) throw new BackendError('ATTACHMENT_OBJECT_CONFLICT', 'existing attachment object failed verification', 409)
        reused = true
      }
      onStage('object-published')
    })
    const directory = await open(directoryPath, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    return { bytes, reused }
  } catch (error) {
    if (!closed) await handle.close().catch(() => {})
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  } finally {
    if (!closed) await handle.close().catch(() => {})
    await rm(temporaryPath, { force: true })
    if (request.aborted) onStage('upload-aborted')
  }
}

/**
 * Start a chunked attachment upload and create its staging files.
 *
 * The caller declares the final byte length so each appended chunk can be
 * checked against it. Staging lives under `attachment-uploads-v1`; only
 * `commitAttachmentUpload` moves bytes into the content-addressed store.
 * @param {string} dataDir - Backend data directory.
 * @param {string} workspaceId - Workspace that will own the attachment.
 * @param {string} hash - Expected SHA-256 hex digest of the whole object.
 * @param {string} name - Display name stored in the upload receipt.
 * @param {number} bytes - Exact byte length the client will upload.
 * @param {number} maximumBytes - Configured attachment byte ceiling.
 * @returns {Promise<{uploadId: string, chunkBytes: number}>} Upload identifier and the largest accepted chunk.
 */
async function beginAttachmentUpload(dataDir, workspaceId, hash, name, bytes, maximumBytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximumBytes) {
    throw new BackendError('ATTACHMENT_TOO_LARGE', `attachment must declare a byte length from 0 through ${String(maximumBytes)}`, 413)
  }
  const directoryPath = attachmentUploadRoot(dataDir, workspaceId)
  await mkdir(directoryPath, { recursive: true, mode: 0o700 })
  const uploadId = randomUUID()
  const partPath = attachmentUploadPartPath(dataDir, workspaceId, uploadId)
  const metaPath = attachmentUploadMetaPath(dataDir, workspaceId, uploadId)
  const handle = await open(partPath, 'wx', 0o600)
  await handle.close()
  try {
    await writeFile(metaPath, JSON.stringify({
      version: 1,
      uploadId,
      workspaceId,
      hash,
      name,
      bytes,
      createdAt: Date.now(),
    }), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    await rm(partPath, { force: true }).catch(() => {})
    throw error
  }
  return { uploadId, chunkBytes: MAX_ATTACHMENT_CHUNK_BYTES }
}

/**
 * Read and validate staging metadata for one chunked upload.
 * @param {string} dataDir - Backend data directory.
 * @param {string} workspaceId - Workspace owning the upload.
 * @param {string} uploadId - Upload identifier from the begin response.
 * @returns {Promise<{uploadId: string, hash: string, name: string, bytes: number}>} Validated staging metadata.
 */
async function readAttachmentUploadMeta(dataDir, workspaceId, uploadId) {
  let text
  try {
    text = await readFile(attachmentUploadMetaPath(dataDir, workspaceId, uploadId), 'utf8')
  } catch (error) {
    if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
    throw new BackendError('ATTACHMENT_UPLOAD_NOT_FOUND', 'chunked attachment upload does not exist or already settled', 404)
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new BackendError('ATTACHMENT_UPLOAD_CORRUPT', 'chunked attachment upload metadata is unreadable', 500)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || value.uploadId !== uploadId || value.workspaceId !== workspaceId
    || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)
    || typeof value.name !== 'string' || value.name.length === 0
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_ATTACHMENT_BYTES) {
    throw new BackendError('ATTACHMENT_UPLOAD_CORRUPT', 'chunked attachment upload metadata is invalid', 500)
  }
  return value
}

/**
 * Append one chunk to a staged upload.
 *
 * The staged part file's size is the authoritative received offset, so a
 * retried or reordered chunk is rejected instead of silently overwriting.
 * @param {string} dataDir - Backend data directory.
 * @param {string} workspaceId - Workspace owning the upload.
 * @param {string} uploadId - Upload identifier from the begin response.
 * @param {string} hash - Content address named by the request path.
 * @param {number} offset - Declared byte offset where this chunk starts.
 * @param {Buffer} body - Chunk bytes.
 * @param {number} maximumBytes - Configured attachment byte ceiling.
 * @returns {Promise<{uploadId: string, offset: number, received: number, bytes: number}>} Progress after the append.
 */
async function appendAttachmentUploadChunk(dataDir, workspaceId, uploadId, hash, offset, body, maximumBytes) {
  if (!(body instanceof Buffer) || body.byteLength > MAX_ATTACHMENT_CHUNK_BYTES) {
    throw new BackendError('ATTACHMENT_TOO_LARGE', `attachment chunks must not exceed ${String(MAX_ATTACHMENT_CHUNK_BYTES)} bytes`, 413)
  }
  const meta = await readAttachmentUploadMeta(dataDir, workspaceId, uploadId)
  if (meta.hash !== hash) throw new BackendError('ATTACHMENT_UPLOAD_HASH_MISMATCH', 'upload staging does not belong to this attachment hash', 409)
  const partPath = attachmentUploadPartPath(dataDir, workspaceId, uploadId)
  const info = await stat(partPath).catch(() => undefined)
  if (info === undefined || !info.isFile()) {
    throw new BackendError('ATTACHMENT_UPLOAD_NOT_FOUND', 'chunked attachment upload has no staging file', 404)
  }
  if (offset !== info.size) {
    throw new BackendError('ATTACHMENT_UPLOAD_OFFSET_MISMATCH',
      `chunk offset ${String(offset)} does not continue the staged upload at ${String(info.size)}`, 409)
  }
  if (Math.min(meta.bytes, maximumBytes) < offset + body.byteLength) {
    throw new BackendError('ATTACHMENT_TOO_LARGE', 'attachment chunk exceeds the declared attachment length', 413)
  }
  if (body.byteLength > 0) {
    const handle = await open(partPath, 'r+')
    try {
      let written = 0
      while (written < body.byteLength) {
        const result = await handle.write(body, written, body.byteLength - written, offset + written)
        if (result.bytesWritten < 1) throw new Error('attachment upload chunk wrote zero bytes')
        written += result.bytesWritten
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  const received = offset + body.byteLength
  return { uploadId, offset, received, bytes: meta.bytes }
}

/**
 * Verify a complete staged upload, then publish it into the content-addressed store.
 *
 * A digest mismatch removes staging because it cannot become the requested
 * object. A verified object already present at the target path is reused.
 * @param {string} dataDir - Backend data directory.
 * @param {string} workspaceId - Workspace that owns the attachment.
 * @param {string} uploadId - Upload identifier from the begin response.
 * @param {string} hash - Content address named by the request path.
 * @param {(operation: () => Promise<void>) => Promise<void>} publish - Publishes atomically under the attachment lock.
 * @returns {Promise<{bytes: number, reused: boolean}>} Committed size and whether an existing object served the receipt.
 */
async function commitAttachmentUpload(dataDir, workspaceId, uploadId, hash, publish) {
  const meta = await readAttachmentUploadMeta(dataDir, workspaceId, uploadId)
  if (meta.hash !== hash) throw new BackendError('ATTACHMENT_UPLOAD_HASH_MISMATCH', 'upload staging does not belong to this attachment hash', 409)
  const partPath = attachmentUploadPartPath(dataDir, workspaceId, uploadId)
  const metaPath = attachmentUploadMetaPath(dataDir, workspaceId, uploadId)
  const info = await stat(partPath).catch(() => undefined)
  if (info === undefined || !info.isFile()) {
    await rm(metaPath, { force: true }).catch(() => {})
    throw new BackendError('ATTACHMENT_UPLOAD_NOT_FOUND', 'chunked attachment upload has no staging file', 404)
  }
  if (info.size !== meta.bytes) {
    throw new BackendError('ATTACHMENT_UPLOAD_INCOMPLETE',
      `staged upload holds ${String(info.size)} of ${String(meta.bytes)} declared bytes`, 409)
  }
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(partPath)) digest.update(chunk)
  if (digest.digest('hex') !== meta.hash) {
    await rm(partPath, { force: true }).catch(() => {})
    await rm(metaPath, { force: true }).catch(() => {})
    throw new BackendError('ATTACHMENT_HASH_MISMATCH', 'staged bytes do not match the requested SHA-256 digest', 400)
  }
  const directoryPath = join(dataDir, 'attachments-v1', workspaceId, meta.hash.slice(0, 2))
  await mkdir(directoryPath, { recursive: true, mode: 0o700 })
  const target = attachmentPath(dataDir, workspaceId, meta.hash)
  let reused = false
  await publish(async () => {
    try {
      await link(partPath, target)
    } catch (error) {
      if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      if (await verifyAttachmentObject(target, meta.hash) !== meta.bytes) {
        throw new BackendError('ATTACHMENT_OBJECT_CONFLICT', 'existing attachment object failed verification', 409)
      }
      reused = true
    }
  })
  const directory = await open(directoryPath, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
  await rm(partPath, { force: true }).catch(() => {})
  await rm(metaPath, { force: true }).catch(() => {})
  return { bytes: meta.bytes, reused }
}

/**
 * Discard staging for a chunked upload without touching committed objects.
 * @param {string} dataDir - Backend data directory.
 * @param {string} workspaceId - Workspace owning the upload.
 * @param {string} uploadId - Upload identifier from the begin response.
 * @returns {Promise<{uploadId: string, removed: number}>} How many staging files were deleted.
 */
async function abortAttachmentUpload(dataDir, workspaceId, uploadId) {
  let removed = 0
  for (const path of [
    attachmentUploadPartPath(dataDir, workspaceId, uploadId),
    attachmentUploadMetaPath(dataDir, workspaceId, uploadId),
  ]) {
    const info = await stat(path).catch(() => undefined)
    if (info === undefined) continue
    await rm(path, { force: true })
    removed += 1
  }
  return { uploadId, removed }
}

/**
 * Delete staging files older than the upload TTL.
 *
 * Only `attachment-uploads-v1` is scanned; committed objects under
 * `attachments-v1` are never candidates.
 * @param {string} dataDir - Backend data directory.
 * @param {number} ttlMs - Age after which abandoned staging is removed.
 * @param {number} [now] - Clock reading used for the age comparison.
 * @returns {Promise<{scanned: number, deleted: object[], failures: object[]}>} Sweep evidence.
 */
async function sweepAttachmentUploads(dataDir, ttlMs, now = Date.now()) {
  const root = join(dataDir, 'attachment-uploads-v1')
  const result = { scanned: 0, deleted: [], failures: [] }
  for (const workspaceEntry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!workspaceEntry.isDirectory()) continue
    const workspaceId = workspaceEntry.name
    const directory = join(root, workspaceId)
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.(?:part|json)$/i.test(entry.name)) continue
      const path = join(directory, entry.name)
      const info = await stat(path).catch(() => undefined)
      if (info === undefined) continue
      result.scanned += 1
      if (now - info.mtimeMs < ttlMs) continue
      try {
        await rm(path, { force: true })
        result.deleted.push({ workspaceId, name: entry.name })
      } catch (error) {
        result.failures.push({
          workspaceId,
          name: entry.name,
          code: typeof error?.code === 'string' ? error.code : 'DELETE_FAILED',
        })
      }
    }
  }
  return result
}

async function streamAttachmentObject(request, response, dataDir, workspaceId, hash) {
  const path = attachmentPath(dataDir, workspaceId, hash)
  const bytes = await verifyAttachmentObject(path, hash)
  if (bytes === undefined) throw new BackendError('ATTACHMENT_NOT_FOUND', 'attachment is unavailable', 404)
  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(bytes),
    'cache-control': 'no-store',
    'content-disposition': 'attachment',
    'x-content-type-options': 'nosniff',
    'x-browser-native-protocol': String(PROTOCOL_VERSION),
  })
  await pipeline(createReadStream(path), response)
}

function isSharedStatePath(pathname) {
  return pathname.startsWith('/api/browser-native/workspace/')
    || pathname.startsWith('/api/browser-native/session/')
}

async function proxySharedStateRequest(request, response, origin, secret) {
  const body = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : await readRawBody(request, MAX_BODY_BYTES)
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === 'host' || name === 'connection' || name === 'content-length') continue
    if (typeof value === 'string') headers.set(name, value)
  }
  headers.set('x-browser-native-state-token', secret)
  let upstream
  try {
    upstream = await fetch(`${origin}${request.url ?? '/'}`, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    })
  } catch (error) {
    throw new BackendError('SHARED_STATE_UNAVAILABLE', `shared browser state service is unavailable: ${String(error)}`, 503)
  }
  const responseHeaders = {}
  for (const [name, value] of upstream.headers) {
    if (name === 'connection' || name === 'keep-alive' || name === 'transfer-encoding') continue
    responseHeaders[name] = value
  }
  const setCookies = typeof upstream.headers.getSetCookie === 'function'
    ? upstream.headers.getSetCookie() : []
  if (setCookies.length > 0) responseHeaders['set-cookie'] = setCookies
  response.writeHead(upstream.status, responseHeaders)
  if (upstream.body === null) {
    response.end()
    return
  }
  try {
    await pipeline(Readable.fromWeb(upstream.body), response)
  } catch {
    if (!response.destroyed) response.destroy()
  }
}

async function authorizeRemoteLlm(request, body, origin, secret) {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-browser-native-state-token': secret,
  })
  let upstream
  try {
    upstream = await fetch(`${origin}/api/browser-native/internal/session/authorize-llm`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new BackendError('SHARED_STATE_UNAVAILABLE', `shared Session authority is unavailable: ${String(error)}`, 503)
  }
  if (upstream.ok) return
  let value
  try { value = await upstream.json() } catch { value = undefined }
  const detail = value?.error
  throw new BackendError(
    typeof detail?.code === 'string' ? detail.code : 'SESSION_AUTHORIZATION_FAILED',
    typeof detail?.message === 'string' ? detail.message : 'shared Session authority rejected the model request',
    upstream.status,
  )
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

function requestCookie(header, name) {
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return undefined
}

function auditResourceFor(pathname) {
  if (pathname.startsWith('/api/browser-native/workspace/')) return 'workspace'
  if (pathname.startsWith('/api/browser-native/session/')) return 'session'
  if (pathname.startsWith('/api/browser-native/llm')) return 'llm'
  if (pathname.startsWith('/api/browser-native/egress/')) return 'egress'
  return 'api'
}

/**
 * Parse a browser-supplied origin; `null`, opaque, and malformed values refuse.
 * @param {unknown} value - Header value.
 * @param {string} name - Header name used in the refusal.
 * @returns {string | undefined} Serialized origin, or undefined when absent.
 */
function browserOrigin(value, name) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    throw new BackendError('ORIGIN_FORBIDDEN', `${name} is invalid`, 403)
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new BackendError('ORIGIN_FORBIDDEN', `${name} is invalid`, 403)
  }
  if (parsed.origin === 'null') throw new BackendError('ORIGIN_FORBIDDEN', `${name} is opaque`, 403)
  return parsed.origin
}

/**
 * Refuse a request a foreign web page authored against the loopback API.
 *
 * A request that carries none of the browser-provenance headers is a
 * non-browser client (SDK, curl, test harness); the loopback Host rule and
 * principal authentication are its origin controls. As soon as any provenance
 * header is present, the request is treated as browser authored: a state
 * change must declare an exact serving `Origin` and must not be cross-site, so
 * a cross-site form, a `no-cors` simple request, and a forged `Origin` all
 * fail before any handler runs. Reads may not be cross-site, and same-site
 * reads require an exact allowlisted `Origin`, so a sibling origin cannot read
 * a response with strictly-same-site cookies. `Referer` covers browsers or
 * proxies that strip `Origin` from a read.
 * @param {import('node:http').IncomingMessage} request - Incoming request.
 * @param {URL} selfOrigin - Origin implied by the request Host header.
 * @param {ReadonlySet<string> | undefined} allowedOrigins - Split API allowlist.
 * @param {URL | undefined} publicOrigin - Reverse-proxied external origin.
 * @returns {void} Throws a 403 `BackendError` when the request is refused.
 */
function assertBrowserProvenance(request, selfOrigin, allowedOrigins, publicOrigin) {
  const provenance = BROWSER_PROVENANCE_HEADERS.some(name => {
    const value = request.headers[name]
    return typeof value === 'string' && value.length > 0
  })
  if (!provenance) return
  const exactOrigins = new Set([selfOrigin.origin])
  if (publicOrigin !== undefined) exactOrigins.add(publicOrigin.origin)
  if (allowedOrigins !== undefined) for (const origin of allowedOrigins) exactOrigins.add(origin)
  const declared = browserOrigin(request.headers.origin, 'request origin')
  const site = request.headers['sec-fetch-site']
  const sameSiteAllowlisted = typeof site === 'string' && site === 'same-site'
    && declared !== undefined && allowedOrigins?.has(declared) === true
  if (STATE_CHANGING_METHODS.has(request.method ?? 'GET')) {
    if (declared === undefined) {
      throw new BackendError('ORIGIN_FORBIDDEN', 'state-changing requests must declare a same-origin Origin header', 403)
    }
    if (!exactOrigins.has(declared)) {
      throw new BackendError('ORIGIN_FORBIDDEN', 'request origin does not match the serving origin', 403)
    }
    if (typeof site === 'string' && !SAME_ORIGIN_SITE_VALUES.has(site) && !sameSiteAllowlisted) {
      throw new BackendError('ORIGIN_FORBIDDEN', 'cross-site state changes are not allowed', 403)
    }
    return
  }
  if (declared !== undefined && !exactOrigins.has(declared)) {
    throw new BackendError('ORIGIN_FORBIDDEN', 'request origin does not match the serving origin', 403)
  }
  if (typeof site === 'string' && !SAME_ORIGIN_SITE_VALUES.has(site) && !sameSiteAllowlisted) {
    throw new BackendError('ORIGIN_FORBIDDEN', 'cross-site reads are not allowed', 403)
  }
  if (typeof site === 'string' && site === 'same-site' && declared === undefined) {
    throw new BackendError('ORIGIN_FORBIDDEN', 'same-site reads must declare an exact Origin header', 403)
  }
  if (declared === undefined) {
    const referer = browserOrigin(request.headers.referer, 'request referer')
    if (referer !== undefined && !exactOrigins.has(referer)) {
      throw new BackendError('ORIGIN_FORBIDDEN', 'request referer does not match the serving origin', 403)
    }
  }
}

/**
 * Refuse requests a foreign web page could author against the loopback API.
 *
 * The Host header must name a loopback host: a DNS-rebinding page reaches the
 * server with its own hostname and is refused before any credential is read.
 * API requests additionally pass {@link assertBrowserProvenance}, and
 * credential-shaped query parameters are refused so tokens never enter URL
 * history, Referer headers, or access logs. Server-to-server requests carrying
 * the shared state token bypass the browser-origin checks but not the Host rule.
 * @param {import('node:http').IncomingMessage} request - Incoming request.
 * @param {URL} url - Parsed request URL.
 * @param {boolean} internal - The request proved the shared state token.
 * @param {ReadonlySet<string> | undefined} allowedOrigins - Additional page origins
 * admitted by the split API listener; only those may send `same-site` browser requests.
 * @param {URL | undefined} publicOrigin - Externally served origin when a TLS reverse
 * proxy terminates the connection; its host is the only additional host admitted.
 * @returns {void} Throws a 403 or 400 BackendError when the request is refused.
 */
function assertLocalRequest(request, url, internal, allowedOrigins, publicOrigin) {
  const host = request.headers.host
  if (typeof host !== 'string' || host.length === 0) throw new BackendError('HOST_FORBIDDEN', 'request host is required', 403)
  let selfOrigin
  try {
    selfOrigin = new URL(`http://${host}`)
  } catch {
    throw new BackendError('HOST_FORBIDDEN', 'request host is invalid', 403)
  }
  const proxied = publicOrigin !== undefined && selfOrigin.host === publicOrigin.host
  if (!LOOPBACK_HOSTNAMES.has(selfOrigin.hostname) && !proxied) {
    throw new BackendError('HOST_FORBIDDEN', 'browser-native is reachable only through a loopback host or the configured public origin', 403)
  }
  if (!url.pathname.startsWith('/api/browser-native/')) return
  if (!internal) assertBrowserProvenance(request, selfOrigin, allowedOrigins, publicOrigin)
  for (const name of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_NAME.test(name)) {
      throw new BackendError('CREDENTIAL_IN_QUERY', 'credentials must not be sent in the request URL', 400)
    }
  }
}

/**
 * Parse the origin a TLS reverse proxy forwards to the backend.
 *
 * Only a bare http/https origin is accepted: paths, query strings, fragments,
 * and userinfo would make the host rule ambiguous, so they refuse startup.
 * @param {unknown} value - Configured external origin.
 * @returns {URL} Parsed public origin.
 */
function parsePublicOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) {
    throw new Error('publicOrigin must be a non-empty http or https origin')
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('publicOrigin must be a valid URL origin')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== ''
    || parsed.username !== '' || parsed.password !== '') {
    throw new Error('publicOrigin must be a bare http or https origin without a path, query, or credentials')
  }
  return parsed
}

function sendError(response, error) {
  const detail = error instanceof BackendError || error instanceof WorkspaceError || error instanceof CrossStoreLedgerError
    || error instanceof EgressError || error instanceof AdmissionError || error instanceof DurableTurnError
    || error instanceof SessionShareError
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

/**
 * Run one model request while holding an admission slot for its whole stream.
 * A browser that disconnects while queued cancels its place instead of leaking it.
 * @param {import('node:http').ServerResponse} response - Response the request will stream into.
 * @param {object|undefined} admission - Admission controller, or undefined when disabled.
 * @param {object} body - LLM request body carrying requestId, sessionId and purpose.
 * @param {() => Promise<void>} run - Streams the model response.
 * @param {(waitMs: number) => void} [onWait] - Called with the admission wait once a slot is granted.
 * @returns {Promise<void>} Resolves after the slot is released or the client disconnected.
 */
async function withAdmission(response, admission, body, run, onWait) {
  if (admission === undefined) {
    await run()
    return
  }
  const abort = new AbortController()
  const onClose = () => {
    if (!response.writableEnded) abort.abort()
  }
  response.on('close', onClose)
  const queuedAt = Date.now()
  let lease
  try {
    lease = await admission.acquireTurn({
      requestId: body.requestId,
      sessionId: body.sessionId,
      purpose: body.purpose,
    }, abort.signal)
    onWait?.(Date.now() - queuedAt)
  } catch (error) {
    if (error instanceof AdmissionError && error.code === 'ADMISSION_ABORTED') {
      response.destroy()
      return
    }
    throw error
  } finally {
    response.off('close', onClose)
  }
  try {
    await run()
  } finally {
    lease.release()
  }
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

/** Epoch milliseconds for a Session timestamp that may be numeric or ISO text. */
function activityAt(value) {
  if (Number.isSafeInteger(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** Whether a journal record carries an `at` timestamp that has left the retention window. */
function recordExpired(record, cutoff) {
  const at = record?.at
  return Number.isSafeInteger(at) && at <= cutoff
}

/** Durable record shape written to `sessions/<id>.json` and returned by exports. */
function recordOf(session) {
  return {
    id: session.id,
    ...(session.principalId === undefined ? {} : { principalId: session.principalId }),
    header: session.header,
    inheritedEventCount: session.inheritedEventCount,
    events: session.events,
    durableThroughSeq: session.events.length - 1,
    ownerEpoch: session.ownerEpoch,
    handoffs: Object.fromEntries(session.handoffs),
    ...(session.branch === undefined ? {} : { branch: session.branch }),
  }
}

class FormalSessionStore {
  constructor(dataDir, { ownerLeaseMs = DEFAULT_OWNER_LEASE_MS, now = Date.now, retentionMs = 0, failFlush, failFlushAfterRename } = {}) {
    if (!Number.isSafeInteger(ownerLeaseMs) || ownerLeaseMs < 300) throw new Error('ownerLeaseMs must be an integer of at least 300')
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new Error('retentionMs must be a non-negative safe integer')
    this.root = resolve(dataDir)
    this.sessionsDir = join(this.root, 'sessions')
    this.sessions = new Map()
    this.unsupported = new Map()
    this.locks = new Map()
    this.ownerLeaseMs = ownerLeaseMs
    this.now = now
    this.retentionMs = retentionMs
    this.failFlush = failFlush
    this.failFlushAfterRename = failFlushAfterRename
  }

  async load() {
    await mkdir(this.sessionsDir, { recursive: true })
    for (const entry of await readdir(this.sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const entryPath = join(this.sessionsDir, entry.name)
      const raw = JSON.parse(await readFile(entryPath, 'utf8'))
      const modifiedAt = await stat(entryPath).then(info => Math.floor(info.mtimeMs)).catch(() => 0)
      const id = assertSessionId(raw.id)
      if (raw.header?.id !== id || !Array.isArray(raw.events)) continue
      const principalId = raw.principalId === undefined ? undefined : assertPrincipalId(raw.principalId)
      if (raw.header.version !== SESSION_FORMAT_VERSION) {
        this.unsupported.set(id, { principalId, header: clone(raw.header), eventCount: raw.events.length, version: raw.header.version })
        process.stderr.write(`browser-native backend: session "${id}" uses log format ${String(raw.header.version)}, not v${String(SESSION_FORMAT_VERSION)}; stored but refused until a compatible harness reads it\n`)
        continue
      }
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
        ...(raw.branch === undefined ? {} : { branch: clone(raw.branch) }),
        events: clone(raw.events),
        durableThroughSeq: raw.durableThroughSeq ?? raw.events.length - 1,
        ownerToken: undefined,
        ownerEpoch: Number.isSafeInteger(raw.ownerEpoch) && raw.ownerEpoch >= 0 ? raw.ownerEpoch : 0,
        ownerExpiresAt: 0,
        editorToken: undefined,
        editorEpoch: 0,
        editorExpiresAt: 0,
        editorPrincipalId: undefined,
        writeBlocked: false,
        handoffs,
        lastActivityAt: Math.max(activityAt(raw.header?.createdAt), modifiedAt),
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

  /** Whether this Session's retention window has elapsed since its last write. */
  isExpired(session) {
    return this.retentionMs > 0 && this.now() >= session.lastActivityAt + this.retentionMs
  }

  /**
   * Read one Session, refusing retained data whose window has elapsed.
   * @param id - Session id.
   * @returns Stored Session record.
   */
  get(id) {
    const session = this.sessions.get(assertSessionId(id))
    if (session === undefined) {
      const unsupported = this.unsupported.get(id)
      if (unsupported !== undefined) throw unsupportedSessionFormat(id, unsupported.version)
      throw new BackendError('SESSION_NOT_FOUND', 'session does not exist', 404)
    }
    if (this.isExpired(session)) {
      throw new BackendError('SESSION_EXPIRED', 'session retention window has elapsed', 410)
    }
    return session
  }

  getForPrincipal(id, principalId) {
    const session = this.sessions.get(assertSessionId(id))
    if (session !== undefined) {
      if (session.principalId !== principalId) throw new BackendError('SESSION_NOT_FOUND', 'session does not exist', 404)
      if (this.isExpired(session)) {
        throw new BackendError('SESSION_EXPIRED', 'session retention window has elapsed', 410)
      }
      return session
    }
    const unsupported = this.unsupported.get(id)
    if (unsupported === undefined || unsupported.principalId !== principalId) {
      throw new BackendError('SESSION_NOT_FOUND', 'session does not exist', 404)
    }
    throw unsupportedSessionFormat(id, unsupported.version)
  }

  /**
   * Summarize owner-lease and recovery state for operator metrics.
   * @returns {{sessions: number, held: number, expired: number, writeBlocked: number, unsupportedFormats: number}} Lease counts without owner credentials.
   */
  leaseSnapshot() {
    const now = this.now()
    let held = 0
    let expired = 0
    let editorsHeld = 0
    let writeBlocked = 0
    for (const session of this.sessions.values()) {
      if (session.ownerToken !== undefined) {
        if (session.ownerExpiresAt > now) held += 1
        else expired += 1
      }
      if (session.editorPrincipalId !== undefined && session.editorExpiresAt > now) editorsHeld += 1
      if (session.writeBlocked) writeBlocked += 1
    }
    return {
      sessions: this.sessions.size,
      held,
      expired,
      editorsHeld,
      writeBlocked,
      unsupportedFormats: this.unsupported.size,
    }
  }

  create(id, header, inheritedEventCount, principalId) {
    assertPrincipalId(principalId)
    const existing = this.sessions.get(id)
    if (existing !== undefined) {
      if (existing.principalId !== principalId) throw new BackendError('SESSION_NOT_FOUND', 'session does not exist', 404)
      throw new BackendError('SESSION_ALREADY_EXISTS', 'session already exists', 409)
    }
    const unsupported = this.unsupported.get(id)
    if (unsupported !== undefined) {
      if (unsupported.principalId !== principalId) throw new BackendError('SESSION_NOT_FOUND', 'session does not exist', 404)
      throw unsupportedSessionFormat(id, unsupported.version)
    }
    if (header.id !== id) throw new BackendError('INVALID_REQUEST', 'header id does not match session id')
    if (header.version !== SESSION_FORMAT_VERSION) throw unsupportedSessionFormat(id, header.version)
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
      editorToken: undefined,
      editorEpoch: 0,
      editorExpiresAt: 0,
      editorPrincipalId: undefined,
      handoffs: new Map(),
      lastActivityAt: this.now(),
    }
    this.sessions.set(id, session)
    return session
  }

  /**
   * Create a child Session from an inclusive source prefix that ends a turn.
   *
   * The child inherits the source events unchanged, appends the child-owned
   * end-seed marker, and records the workspace revision observed at the cut.
   * The source Session is never mutated; append-only lineage stays readable.
   * @param source - Session whose prefix is inherited.
   * @param newId - Id for the child Session.
   * @param boundarySeq - Inclusive source event seq; must be a `turn/end`.
   * @param branchMeta - Intent, boundary turn, and workspace revision at the cut.
   * @returns The persisted child Session.
   */
  async branch(source, newId, boundarySeq, branchMeta) {
    const boundary = source.events[boundarySeq]
    if (boundary === undefined) {
      throw new BackendError('SESSION_BRANCH_BOUNDARY_INVALID', 'branch boundary is outside the Session log', 400, undefined, {
        sessionId: source.id, boundarySeq, nextSeq: source.events.length,
      })
    }
    if (boundary.type !== 'turn/end') {
      throw new BackendError('SESSION_BRANCH_BOUNDARY_INVALID', 'branch boundary must be a completed turn', 400, undefined, {
        sessionId: source.id, boundarySeq, eventType: boundary.type,
      })
    }
    const inheritedEventCount = boundarySeq + 1
    const header = {
      ...clone(source.header),
      id: newId,
      createdAt: this.now(),
      parentSession: source.id,
      isSeeded: true,
    }
    const session = this.create(newId, header, inheritedEventCount, source.principalId)
    session.events = clone(source.events.slice(0, inheritedEventCount))
    session.events.push({
      type: 'session/end-seed', seq: inheritedEventCount, time: boundary.time, data: { inherited: true },
    })
    session.branch = {
      intent: branchMeta.intent,
      parentSessionId: source.id,
      boundarySeq,
      boundaryTurn: boundary.data.turn,
      workspaceRevision: branchMeta.workspaceRevision,
    }
    await this.flush(session)
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

  /**
   * Grant the single editor lease to a principal with an editor share.
   * @param session - Session receiving editor writes.
   * @param principalId - Editor principal requesting the lease.
   * @param requestedEditorToken - Token to keep when retrying the same claim.
   * @param requestedEditorEpoch - Epoch to keep when retrying the same claim.
   * @returns Editor token, epoch, and renewal timing.
   */
  claimEditor(session, principalId, requestedEditorToken, requestedEditorEpoch) {
    if (session.writeBlocked) throw new BackendError('SESSION_RECOVERY_REQUIRED', 'Session ownership is blocked until the backend reloads its durable state', 503)
    if (session.editorPrincipalId !== undefined && session.editorExpiresAt > this.now()) {
      if (session.editorPrincipalId === principalId
        && (requestedEditorToken === undefined || requestedEditorToken === session.editorToken)
        && (requestedEditorEpoch === undefined || requestedEditorEpoch === session.editorEpoch)) {
        return this.renewEditor(session, principalId, session.editorToken, session.editorEpoch, true)
      }
      throw new BackendError(
        'SESSION_EDITOR_LEASE_HELD',
        'another editor holds the Session write lease',
        409,
        session.editorExpiresAt - this.now(),
        { sessionId: session.id },
      )
    }
    session.editorEpoch += 1
    session.editorPrincipalId = principalId
    session.editorToken = typeof requestedEditorToken === 'string' ? requestedEditorToken : randomUUID()
    return this.renewEditor(session, principalId, session.editorToken, session.editorEpoch, true)
  }

  /**
   * Extend an editor lease after verifying its token and principal.
   * @param session - Session holding the lease.
   * @param principalId - Editor principal.
   * @param editorToken - Lease token.
   * @param editorEpoch - Lease epoch, checked when provided.
   * @param initial - Skip verification for a just-granted lease.
   * @returns Editor token, epoch, and renewal timing.
   */
  renewEditor(session, principalId, editorToken, editorEpoch, initial = false) {
    if (!initial) this.assertEditor(session, principalId, editorToken, editorEpoch)
    session.editorExpiresAt = this.now() + this.ownerLeaseMs
    return {
      editorToken: session.editorToken,
      editorEpoch: session.editorEpoch,
      leaseDurationMs: this.ownerLeaseMs,
      renewAfterMs: Math.floor(this.ownerLeaseMs / 3),
    }
  }

  /**
   * Verify that a principal still holds the active editor lease.
   * @param session - Session receiving the write.
   * @param principalId - Editor principal.
   * @param editorToken - Lease token.
   * @param editorEpoch - Lease epoch, checked when provided.
   */
  assertEditor(session, principalId, editorToken, editorEpoch) {
    if (session.writeBlocked) throw new BackendError('SESSION_RECOVERY_REQUIRED', 'Session writes are blocked until the backend reloads its durable state', 503)
    if (typeof editorToken !== 'string' || session.editorToken !== editorToken
      || session.editorPrincipalId !== principalId
      || (editorEpoch !== undefined && editorEpoch !== session.editorEpoch)) {
      throw new BackendError('SESSION_EDITOR_LEASE_LOST', 'the Session editor lease is no longer valid', 409)
    }
    if (session.editorExpiresAt <= this.now()) {
      throw new BackendError('SESSION_EDITOR_LEASE_LOST', 'the Session editor lease is no longer valid', 409)
    }
  }

  /**
   * Release an editor lease held by the calling principal.
   * @param session - Session holding the lease.
   * @param principalId - Editor principal.
   * @param editorToken - Lease token.
   * @param editorEpoch - Lease epoch, checked when provided.
   * @returns The released epoch.
   */
  releaseEditor(session, principalId, editorToken, editorEpoch) {
    this.assertEditor(session, principalId, editorToken, editorEpoch)
    const editorEpochReleased = session.editorEpoch
    session.editorToken = undefined
    session.editorExpiresAt = 0
    session.editorPrincipalId = undefined
    return { released: true, editorEpoch: editorEpochReleased }
  }

  /**
   * Revoke any editor lease. Owner-only; used for handoff and ownership transfer.
   * @param session - Session whose editor lease is revoked.
   * @returns Whether a lease existed and its epoch.
   */
  revokeEditor(session) {
    const existed = session.editorPrincipalId !== undefined && session.editorExpiresAt > this.now()
    const editorEpoch = session.editorEpoch
    session.editorToken = undefined
    session.editorExpiresAt = 0
    session.editorPrincipalId = undefined
    return { revoked: existed, editorEpoch }
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
    const record = recordOf(session)
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
    session.lastActivityAt = this.now()
    return `durable-${session.id}-${session.durableThroughSeq}`
  }

  /**
   * Delete Sessions whose retention window elapsed and report their ids.
   * @returns Removed Session ids in store order.
   */
  async purgeExpired() {
    const removed = []
    for (const session of [...this.sessions.values()]) {
      if (!this.isExpired(session)) continue
      this.sessions.delete(session.id)
      this.locks.delete(session.id)
      await rm(join(this.sessionsDir, `${session.id}.json`), { force: true })
      removed.push(session.id)
    }
    return removed
  }

  /**
   * Serialize one Session for an export bundle without owner leases.
   * @param session - Stored Session record.
   * @returns Durable Session record.
   */
  recordFor(session) {
    return recordOf(session)
  }

  snapshot(session) {
    return {
      header: clone(session.header),
      revision: revisionOf(session),
      eventCount: session.events.length,
    }
  }
}

/**
 * Summarize a Session log without copying prompts, assistant text, tool
 * arguments, or attachment bytes. Only event types, turn outcome kinds, failure
 * codes, and tool names leave the log.
 * @param {object[]} events - Sequential Session events.
 * @returns {object} Event counts and failure facts sufficient to locate a turn.
 */
function supportBundleEventSummary(events) {
  const eventTypes = {}
  const turnOutcomes = { completed: 0, aborted: 0, blocked: 0, error: 0, 'max-tokens': 0, interrupted: 0, forked: 0 }
  const errorCodes = {}
  const toolNames = {}
  for (const event of events) {
    if (typeof event?.type !== 'string') continue
    eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1
    if (event.type === 'turn/end') {
      const kind = event.data?.reason?.kind
      if (typeof kind === 'string') turnOutcomes[kind] = (turnOutcomes[kind] ?? 0) + 1
      const code = event.data?.reason?.error?.code
      if (typeof code === 'string') errorCodes[code] = (errorCodes[code] ?? 0) + 1
    }
    if (event.type === 'tool/call' && typeof event.data?.name === 'string') {
      toolNames[event.data.name] = (toolNames[event.data.name] ?? 0) + 1
    }
  }
  return { eventCount: events.length, eventTypes, turnOutcomes, errorCodes, toolNames }
}

/**
 * Aggregate the provider usage ledger for one Session without request ids or
 * message content.
 * @param {object[]} entries - Recorded usage entries.
 * @param {string} sessionId - Session whose usage is summarized.
 * @returns {object} Per-provider counts and token totals plus a bounded log.
 */
function supportBundleUsageSummary(entries, sessionId) {
  const providers = {}
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, fallbackRequests: 0 }
  const log = []
  for (const entry of entries) {
    if (entry.sessionId !== sessionId) continue
    const provider = typeof entry.provider === 'string' ? entry.provider : 'unknown'
    const bucket = providers[provider] ??= { requests: 0, inputTokens: 0, outputTokens: 0, fallbackRequests: 0 }
    const inputTokens = Number.isSafeInteger(entry.inputTokens) ? entry.inputTokens : 0
    const outputTokens = Number.isSafeInteger(entry.outputTokens) ? entry.outputTokens : 0
    for (const target of [bucket, totals]) {
      target.requests += 1
      target.inputTokens += inputTokens
      target.outputTokens += outputTokens
      if (entry.fallbackUsed === true) target.fallbackRequests += 1
    }
    log.push({
      at: entry.at ?? null,
      kind: 'usage',
      provider,
      purpose: entry.purpose ?? 'turn',
      attempt: entry.attempt ?? 1,
      fallbackUsed: entry.fallbackUsed === true,
      inputTokens,
      outputTokens,
    })
  }
  return { providers, totals, log }
}

function sessionResponse(session, extra = {}) {
  return {
    sessionId: session.id,
    header: clone(session.header),
    inheritedEventCount: session.inheritedEventCount,
    nextSeq: session.events.length,
    revision: revisionOf(session),
    ...(session.branch === undefined ? {} : { branch: clone(session.branch) }),
    ...extra,
  }
}

/** Operations a Session viewer may perform; everything else requires the owner or editor lease. */
const SHARED_READ_OPERATIONS = new Set(['open', 'read', 'stat'])
/** Operations a Session editor may perform under an active editor lease. */
const SHARED_EDITOR_OPERATIONS = new Set(['open', 'read', 'stat', 'editor-lease', 'append', 'flush'])

/** Stable, non-reversible actor identifier for collaboration audit records. */
function collaborationPrincipalDigest(principalId) {
  return createHash('sha256').update(principalId).digest('hex').slice(0, 16)
}

async function sessionOperation(store, operation, body, principalId, shares, testHooks = {}, admission, appendReceipts, collaborationAudit, branchReceipts, workspaceRevisionOf, createReceipts) {
  assertProtocol(body)
  assertPrincipalId(principalId)
  if (operation === 'list') {
    return store.exclusive('__list__', async () => {
      const limit = body.limit === undefined ? 50 : boundedInteger(body.limit, 'limit', MAX_CATALOG_PAGE_SIZE)
      if (limit === 0) throw new BackendError('INVALID_REQUEST', 'limit must be at least 1')
      const after = body.cursor === undefined ? undefined : sessionIdFromCatalogCursor(body.cursor, principalId)
      const sessions = [...store.sessions.values()]
        .filter(session => session.principalId === principalId && !store.isExpired(session))
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
      const receiptKey = `${principalId}\u0000create\u0000${body.requestId}`
      const header = assertRecord(body.header, 'header')
      const requestDigest = fullDigest({ header, inheritedEventCount: body.inheritedEventCount ?? 0 })
      const replay = createReceipts?.get(receiptKey)
      if (replay !== undefined) {
        if (replay.digest !== requestDigest) {
          throw new BackendError('IDEMPOTENCY_CONFLICT', 'requestId was reused with a different Session header', 409)
        }
        return clone(replay.result)
      }
      admission?.mountSession(id)
      try {
        const session = store.create(id, header, body.inheritedEventCount ?? 0, principalId)
        const owner = store.claim(session)
        const result = sessionResponse(session, { owner })
        createReceipts?.set(receiptKey, { digest: requestDigest, result: clone(result) })
        while (createReceipts !== undefined && createReceipts.size > MAX_SESSION_APPEND_RECEIPTS) {
          createReceipts.delete(createReceipts.keys().next().value)
        }
        return result
      } catch (error) {
        admission?.releaseMount(id)
        throw error
      }
    }
    if (operation === 'branch') {
      let source
      try {
        source = store.getForPrincipal(id, principalId)
      } catch (error) {
        const role = shares.roleOf(id, principalId)
        if (role === undefined) throw error
        throw new BackendError(
          role === 'editor' ? 'SESSION_OWNER_REQUIRED' : 'SESSION_READ_ONLY',
          role === 'editor' ? 'this operation requires the Session owner lease' : 'a shared Session is read-only for its viewer',
          403, undefined, { sessionId: id },
        )
      }
      store.assertOwner(source, body.ownerToken, body.ownerEpoch)
      const newId = assertSessionId(body.newSessionId)
      if (newId === id) throw new BackendError('INVALID_REQUEST', 'branch target must differ from the source Session')
      const intent = body.intent ?? 'branch'
      if (intent !== 'branch' && intent !== 'rollback') throw new BackendError('INVALID_REQUEST', 'intent must be branch or rollback')
      let boundarySeq
      if (body.atSeq !== undefined) {
        boundarySeq = boundedInteger(body.atSeq, 'atSeq', Math.max(0, source.events.length - 1))
      }
      if (body.atTurn !== undefined) {
        const atTurn = boundedInteger(body.atTurn, 'atTurn', 1_000_000)
        const boundary = source.events.findLastIndex(event => event.type === 'turn/end' && event.data.turn === atTurn)
        if (boundary < 0) {
          throw new BackendError('SESSION_BRANCH_BOUNDARY_INVALID', 'Session has no completed turn with that number', 400, undefined, {
            sessionId: id, atTurn, lastTurn: source.events.findLast(event => event.type === 'turn/end')?.data.turn,
          })
        }
        if (boundarySeq !== undefined && boundarySeq !== boundary) {
          throw new BackendError('SESSION_BRANCH_BOUNDARY_INVALID', 'atSeq and atTurn select different boundaries', 400)
        }
        boundarySeq = boundary
      }
      if (boundarySeq === undefined) throw new BackendError('INVALID_REQUEST', 'atSeq or atTurn is required')
      if (source.events[boundarySeq]?.type !== 'turn/end' || source.events[boundarySeq].seq !== boundarySeq) {
        throw new BackendError('SESSION_BRANCH_BOUNDARY_INVALID', 'branch boundary must be a completed turn', 400, undefined, {
          sessionId: id, boundarySeq, eventType: source.events[boundarySeq]?.type,
        })
      }
      const receiptKey = `${principalId}\u0000branch\u0000${body.requestId}`
      const replay = branchReceipts.get(receiptKey)
      if (replay !== undefined) return clone(replay)
      const workspaceRevision = workspaceRevisionOf(principalId)
      const child = await store.branch(source, newId, boundarySeq, { intent, workspaceRevision })
      const result = sessionResponse(child)
      branchReceipts.set(receiptKey, clone(result))
      while (branchReceipts.size > MAX_SESSION_APPEND_RECEIPTS) branchReceipts.delete(branchReceipts.keys().next().value)
      return result
    }
    let session
    let shared
    const audit = collaborationAudit ?? (() => {})
    try {
      session = store.getForPrincipal(id, principalId)
    } catch (error) {
      const role = error?.code === 'SESSION_NOT_FOUND' ? shares.roleOf(id, principalId) : undefined
      if (role === undefined) throw error
      const allowed = role === 'editor' ? SHARED_EDITOR_OPERATIONS : SHARED_READ_OPERATIONS
      if (!allowed.has(operation) || (operation === 'open' && body.access === 'write' && role !== 'editor')) {
        throw new BackendError(
          role === 'editor' ? 'SESSION_OWNER_REQUIRED' : 'SESSION_READ_ONLY',
          role === 'editor'
            ? 'this operation requires the Session owner lease'
            : 'a shared Session is read-only for its viewer',
          403,
          undefined,
          { sessionId: id },
        )
      }
      session = store.get(id)
      shared = role
    }
    if (operation === 'open') {
      if (body.access !== 'read' && body.access !== 'write') throw new BackendError('INVALID_REQUEST', 'access must be read or write')
      if (body.access === 'write') {
        if (shared === 'editor') {
          try {
            const editor = store.claimEditor(session, principalId, body.editorToken, body.editorEpoch)
            await audit({
              action: 'editor-lease.claim', sessionId: id, principalDigest: collaborationPrincipalDigest(principalId),
              role: 'editor', outcome: 'granted', editorEpoch: editor.editorEpoch,
            })
            return sessionResponse(session, { editor, shared: true, role: 'editor' })
          } catch (error) {
            await audit({
              action: 'editor-lease.claim', sessionId: id, principalDigest: collaborationPrincipalDigest(principalId),
              role: 'editor', outcome: 'denied', code: error?.code ?? 'UNKNOWN',
            })
            throw error
          }
        }
        admission?.mountSession(id)
        try {
          return sessionResponse(session, { owner: store.claim(session, body.ownerToken, body.ownerEpoch) })
        } catch (error) {
          admission?.releaseMount(id)
          throw error
        }
      }
      return sessionResponse(session, shared === undefined ? {} : { shared: true, role: shared })
    }
    if (operation === 'stat') return sessionResponse(session, shared === undefined ? {} : { shared: true, role: shared })
    if (operation === 'read') {
      const offset = body.offset === undefined ? 0 : boundedInteger(body.offset, 'offset', MAX_EVENTS)
      const length = body.length === undefined ? MAX_SESSION_READ_EVENTS : boundedInteger(body.length, 'length', MAX_SESSION_READ_EVENTS)
      if (length === 0) throw new BackendError('INVALID_REQUEST', 'length must be at least 1')
      const events = clone(session.events.slice(offset, offset + length))
      const page = truncateReadPage(events)
      return sessionResponse(session, {
        events: page,
        eventState: 'shared-frozen',
        durableThroughSeq: session.durableThroughSeq,
        ownerEpoch: session.ownerEpoch,
        hasMore: offset + page.length < session.events.length,
        ...(shared === undefined ? {} : { shared: true, role: shared }),
      })
    }
    if (operation === 'authorize-llm') {
      store.assertOwner(session, body.ownerToken, body.ownerEpoch)
      return { authorized: true, ownerEpoch: session.ownerEpoch }
    }
    if (operation === 'close') {
      store.assertOwnerToken(session, body.ownerToken)
      const durabilityReceipt = session.durableThroughSeq < session.events.length - 1
        ? await store.flush(session)
        : undefined
      session.ownerToken = undefined
      session.ownerExpiresAt = 0
      admission?.releaseMount(id)
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
    if (shared === 'editor') {
      if (operation === 'editor-lease') {
        try {
          let result
          if (body.action === 'claim') {
            result = { editor: store.claimEditor(session, principalId, body.editorToken, body.editorEpoch) }
          } else if (body.action === 'renew') {
            result = { editor: store.renewEditor(session, principalId, body.editorToken, body.editorEpoch) }
          } else if (body.action === 'release') {
            result = store.releaseEditor(session, principalId, body.editorToken, body.editorEpoch)
          } else {
            throw new BackendError('INVALID_REQUEST', 'action must be claim, renew, or release')
          }
          await audit({
            action: `editor-lease.${body.action}`, sessionId: id, principalDigest: collaborationPrincipalDigest(principalId),
            role: 'editor', outcome: body.action === 'release' ? 'released' : 'granted',
            editorEpoch: result.editor?.editorEpoch ?? result.editorEpoch,
          })
          return { sessionId: id, role: 'editor', ...result }
        } catch (error) {
          await audit({
            action: `editor-lease.${String(body.action)}`, sessionId: id, principalDigest: collaborationPrincipalDigest(principalId),
            role: 'editor', outcome: 'denied', code: error?.code ?? 'UNKNOWN',
          })
          throw error
        }
      }
      store.assertEditor(session, principalId, body.editorToken, body.editorEpoch)
    } else if (operation === 'editor-lease') {
      if (body.action !== 'revoke') throw new BackendError('INVALID_REQUEST', 'only the Session owner may revoke an editor lease')
      store.assertOwner(session, body.ownerToken, body.ownerEpoch)
      const result = store.revokeEditor(session)
      await audit({
        action: 'editor-lease.revoke', sessionId: id, principalDigest: collaborationPrincipalDigest(principalId),
        role: 'owner', outcome: result.revoked ? 'revoked' : 'none', editorEpoch: result.editorEpoch,
      })
      return sessionResponse(session, result)
    } else {
      store.assertOwner(session, body.ownerToken, body.ownerEpoch)
    }
    if (operation === 'renew') {
      admission?.renewMount(id)
      return sessionResponse(session, { owner: store.renew(session, body.ownerToken) })
    }
    if (operation === 'append') {
      const receiptKey = `${principalId}\u0000${body.requestId}`
      const receipt = appendReceipts?.get(receiptKey)
      if (receipt !== undefined) {
        if (fullDigest(receipt.request) !== fullDigest(body)) {
          throw new BackendError('IDEMPOTENCY_CONFLICT', 'requestId was reused with different append content', 409)
        }
        return { ...clone(receipt.result), replayed: true }
      }
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
      const result = sessionResponse(session, { acceptedCount: body.events.length })
      appendReceipts?.set(receiptKey, { request: clone(body), result })
      while (appendReceipts !== undefined && appendReceipts.size > MAX_SESSION_APPEND_RECEIPTS) {
        appendReceipts.delete(appendReceipts.keys().next().value)
      }
      return result
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
  const kind = options.llmProviderKind ?? env.DSH_POC_LLM_PROVIDER ?? 'openai'
  if (kind !== 'openai' && kind !== 'anthropic') {
    throw new Error('real LLM mode needs DSH_POC_LLM_PROVIDER=openai or DSH_POC_LLM_PROVIDER=anthropic')
  }
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (proxy?.startsWith('socks')) throw new Error('real LLM mode needs an HTTP(S) proxy; SOCKS proxy support is not implemented in this PoC')
  const configuredTimeout = options.llmTimeoutMs ?? (env.DSH_POC_LLM_TIMEOUT_MS === undefined
    ? DEFAULT_LLM_TIMEOUT_MS
    : Number(env.DSH_POC_LLM_TIMEOUT_MS))
  const timeout = timeoutMs(configuredTimeout, 'llmTimeoutMs')
  const contextWindow = positiveInteger(options.contextWindow ?? env.DSH_POC_CONTEXT_WINDOW, 'DSH_POC_CONTEXT_WINDOW')
  if (kind === 'anthropic') {
    const model = options.model ?? env.ANTHROPIC_MODEL
    if (typeof model !== 'string' || model.length === 0) throw new Error('ANTHROPIC_MODEL is required for an Anthropic-compatible endpoint')
    const baseUrl = options.llmBaseUrl ?? env.ANTHROPIC_BASE_URL
    const path = options.llmCompletionsPath ?? env.ANTHROPIC_MESSAGES_PATH ?? 'v1/messages'
    const apiKey = options.llmApiKey ?? env.ANTHROPIC_API_KEY
    if (!baseUrl || !apiKey) throw new Error('Anthropic-compatible mode needs ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY')
    const apiVersion = options.llmApiVersion ?? env.ANTHROPIC_VERSION ?? '2023-06-01'
    const defaultMaxTokens = positiveInteger(options.llmMaxTokens ?? env.DSH_POC_LLM_MAX_TOKENS ?? 4096, 'llmMaxTokens')
    const primary = {
      mode,
      kind,
      model,
      provider: 'anthropic-compatible',
      url: new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString(),
      apiKey,
      apiVersion,
      defaultMaxTokens,
      proxyConfigured: proxy !== undefined,
      timeoutMs: timeout,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    }
    const fallback = fallbackConfig(options.llmFallback, env, { kind, apiVersion, defaultMaxTokens, proxy, timeout, contextWindow, includeUsage: false })
    return fallback === undefined ? primary : { ...primary, fallback }
  }
  const model = options.model ?? env.OPENAI_NEXT_GPT_MODEL
  if (typeof model !== 'string' || model.length === 0) throw new Error('OPENAI_NEXT_GPT_MODEL is required in real mode')
  const grok = model.startsWith('grok-')
  const baseUrl = options.llmBaseUrl
    ?? (grok ? (env.OPENAI_NEXT_GROK_BASE_URL ?? env.OPENAI_NEXT_GPT_BASE_URL) : env.OPENAI_NEXT_GPT_BASE_URL)
  const path = options.llmCompletionsPath
    ?? (grok ? (env.OPENAI_NEXT_GROK_COMPLETIONS_PATH ?? env.OPENAI_NEXT_GPT_COMPLETIONS_PATH) : env.OPENAI_NEXT_GPT_COMPLETIONS_PATH)
  const apiKey = options.llmApiKey ?? (grok ? env.OPENAI_NEXT_GROK_API_KEY : env.OPENAI_NEXT_GPT_API_KEY)
  if (!baseUrl || !path || !apiKey) throw new Error('real LLM mode needs the configured OpenAI Next base URL, completions path, model, and API key')
  const includeUsage = options.llmIncludeUsage === true
  const primary = {
    mode,
    kind,
    model,
    provider: grok ? 'grok' : 'gpt',
    url: new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString(),
    apiKey,
    proxyConfigured: proxy !== undefined,
    timeoutMs: timeout,
    includeUsage,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
  const fallback = fallbackConfig(options.llmFallback, env, { kind, apiVersion: env.ANTHROPIC_VERSION ?? '2023-06-01', defaultMaxTokens: 4096, proxy, timeout, contextWindow, includeUsage })
  return fallback === undefined ? primary : { ...primary, fallback }
}

/**
 * Build the secondary provider used when the primary fails before any output.
 *
 * Configuration is explicit: every field comes from `DSH_POC_LLM_FALLBACK_*` or
 * from the `llmFallback` test option. A partially configured fallback is a load
 * error, never a silent single-provider deployment.
 * @param {object | undefined} override - Per-field overrides from server options.
 * @param {Record<string, string | undefined>} env - Loaded environment.
 * @param {object} defaults - Values shared with the primary provider.
 * @returns {object | undefined} Provider config with the primary's field shape.
 */
function fallbackConfig(override, env, defaults) {
  const settings = override ?? {}
  const kind = settings.kind ?? env.DSH_POC_LLM_FALLBACK_PROVIDER ?? defaults.kind
  if (kind !== 'openai' && kind !== 'anthropic') throw new Error('fallback LLM provider must be openai or anthropic')
  const model = settings.model ?? env.DSH_POC_LLM_FALLBACK_MODEL
  const baseUrl = settings.baseUrl ?? env.DSH_POC_LLM_FALLBACK_BASE_URL
  const apiKey = settings.apiKey ?? env.DSH_POC_LLM_FALLBACK_API_KEY
  const path = settings.path ?? env.DSH_POC_LLM_FALLBACK_PATH
  if (model === undefined && baseUrl === undefined && apiKey === undefined) return undefined
  if (!model || !baseUrl || !apiKey) {
    throw new Error('fallback LLM needs DSH_POC_LLM_FALLBACK_MODEL, DSH_POC_LLM_FALLBACK_BASE_URL, and DSH_POC_LLM_FALLBACK_API_KEY')
  }
  const resolvedPath = path ?? (kind === 'anthropic' ? 'v1/messages' : 'chat/completions')
  const url = new URL(resolvedPath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
  if (kind === 'anthropic') {
    return {
      mode: 'real', kind, model,
      provider: settings.provider ?? 'anthropic-compatible',
      url, apiKey,
      apiVersion: settings.apiVersion ?? defaults.apiVersion,
      defaultMaxTokens: settings.defaultMaxTokens ?? defaults.defaultMaxTokens,
      proxyConfigured: defaults.proxy !== undefined,
      timeoutMs: settings.timeoutMs === undefined ? defaults.timeout : timeoutMs(settings.timeoutMs, 'llmFallbackTimeoutMs'),
      ...(defaults.contextWindow === undefined ? {} : { contextWindow: defaults.contextWindow }),
    }
  }
  return {
    mode: 'real', kind, model,
    provider: settings.provider ?? (model.startsWith('grok-') ? 'grok' : 'gpt'),
    url, apiKey,
    proxyConfigured: defaults.proxy !== undefined,
    timeoutMs: settings.timeoutMs === undefined ? defaults.timeout : timeoutMs(settings.timeoutMs, 'llmFallbackTimeoutMs'),
    includeUsage: defaults.includeUsage,
    ...(defaults.contextWindow === undefined ? {} : { contextWindow: defaults.contextWindow }),
  }
}

/** Map an OpenAI-compatible usage object to the adapter's token usage fields. */
function streamUsage(value) {
  if (value === null || typeof value !== 'object') return undefined
  const promptTokens = value.prompt_tokens
  const outputTokens = value.completion_tokens
  if (!Number.isSafeInteger(promptTokens) || !Number.isSafeInteger(outputTokens)) return undefined
  const cached = value.prompt_tokens_details?.cached_tokens ?? value.prompt_cache_hit_tokens
  const written = value.prompt_tokens_details?.cache_write_tokens
  const cacheReadTokens = Number.isSafeInteger(cached) && cached >= 0 ? cached : undefined
  const cacheWriteTokens = Number.isSafeInteger(written) && written >= 0 ? written : undefined
  return {
    inputTokens: cacheReadTokens === undefined ? promptTokens : Math.max(0, promptTokens - cacheReadTokens),
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(Number.isSafeInteger(value.total_tokens) ? { totalTokens: value.total_tokens } : {}),
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

function toolResultIsError(result) {
  if (result?.isError === true || result?.message?.isError === true) return true
  const content = typeof result?.content === 'string' ? result.content
    : Array.isArray(result?.content) ? result.content.filter(item => item?.type === 'text' && typeof item.text === 'string')
      .map(item => item.text).join('\n')
    : ''
  return /^\s*Error:/i.test(content) || /\b(file access denied|permission denied|approval rejected)\b/i.test(content)
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
  if (fault?.kind === 'tool-call') {
    await scriptedWorkspaceToolCall(response, fault.call)
    return
  }
  if (fault?.kind === 'barrier-tool-call') {
    await fault.release
    fault.onReleased?.()
    if (isClientClosed()) return
    await scriptedWorkspaceToolCall(response, fault.call)
    return
  }
  if (fault?.kind === 'text') {
    scriptedText(response, fault.text ?? 'scripted response')
    return
  }
  if (fault?.kind === 'barrier-text') {
    await fault.release
    fault.onReleased?.()
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
  const imageMarker = 'BROWSER_NATIVE_IMAGE_APPLICATION_E2E'
  const imagePrompt = [...messages].reverse().find(message => message.role === 'user'
    && (typeof message.content === 'string' || Array.isArray(message.content))
    && (typeof message.content === 'string'
      ? message.content.includes(imageMarker)
      : message.content.some(part => part?.type === 'text' && typeof part.text === 'string' && part.text.includes(imageMarker))))
  if (imagePrompt !== undefined) {
    const parts = Array.isArray(imagePrompt.content) ? imagePrompt.content : []
    const imagePart = parts.find(part => part?.type === 'image_url' && typeof part.image_url?.url === 'string')
    if (imagePart === undefined) {
      scriptedText(response, 'BROWSER_NATIVE_IMAGE_APPLICATION_MISSING')
      return
    }
    const match = IMAGE_DATA_URL.exec(imagePart.image_url.url)
    if (match === null) {
      scriptedText(response, 'BROWSER_NATIVE_IMAGE_APPLICATION_INVALID')
      return
    }
    const bytes = Buffer.from(match[2], 'base64')
    const digest = createHash('sha256').update(bytes).digest('hex')
    scriptedText(response, `BROWSER_NATIVE_IMAGE_APPLICATION_APPLIED:${match[1]}:${bytes.length}:${digest.slice(0, 16)}`)
    return
  }
  const skillPrompt = [...messages].reverse().find(message => message.role === 'user'
    && typeof message.content === 'string' && /BROWSER_NATIVE_SKILL_/.test(message.content))
  const skillMarker = typeof skillPrompt?.content === 'string'
    ? skillPrompt.content.match(/BROWSER_NATIVE_SKILL_(EMPTY_CATALOG|ROOT_CREATED|LOAD_INITIAL|EDIT_AND_RELOAD|AFTER_REFRESH|AFTER_DELETE|VOLATILE|AFTER_VOLATILE_REFRESH)/)?.[0]
    : undefined
  if (skillMarker !== undefined) {
    const markerIndex = messages.lastIndexOf(skillPrompt)
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    const currentCatalog = [...messages].reverse().find(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes('<available_skills>'))?.content ?? ''
    if (skillMarker === 'BROWSER_NATIVE_SKILL_EMPTY_CATALOG' || skillMarker === 'BROWSER_NATIVE_SKILL_ROOT_CREATED') {
      scriptedText(response, `${skillMarker}_DONE`)
      return
    }
    if ((skillMarker === 'BROWSER_NATIVE_SKILL_AFTER_DELETE' && !currentCatalog.includes('- `browser-proof`'))
      || (skillMarker === 'BROWSER_NATIVE_SKILL_AFTER_VOLATILE_REFRESH' && !currentCatalog.includes('- `volatile-proof`'))) {
      scriptedText(response, `${skillMarker}_DONE`)
      return
    }
    if (skillMarker === 'BROWSER_NATIVE_SKILL_VOLATILE') {
      if (toolResults.length === 0) {
        await scriptedWorkspaceToolCall(response, {
          id: 'browser-native-skill-volatile-write',
          name: 'write',
          arguments: {
            file_path: '/dsh/home/workspace/.agents/skills/volatile-proof/SKILL.md',
            content: `---\nname: volatile-proof\ndescription: Unconfirmed browser skill\n---\n\nUncommitted instruction marker: BROWSER_SKILL_VOLATILE_BODY\n`,
          },
        })
        return
      }
      if (hasTool(tools, 'skill')) {
        await scriptedWorkspaceToolCall(response, {
          id: 'browser-native-skill-volatile-load',
          name: 'skill',
          arguments: { name: 'volatile-proof' },
        })
        return
      }
      scriptedText(response, `${skillMarker}_DONE`)
      return
    }
    if (skillMarker === 'BROWSER_NATIVE_SKILL_EDIT_AND_RELOAD' && toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-skill-edit-read',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/.agents/skills/browser-proof/SKILL.md' },
      })
      return
    }
    if (skillMarker === 'BROWSER_NATIVE_SKILL_EDIT_AND_RELOAD' && toolResults.length === 1) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-skill-edit-description',
        name: 'edit',
        arguments: {
          file_path: '/dsh/home/workspace/.agents/skills/browser-proof/SKILL.md',
          old_string: 'description: Browser worker integration fixture',
          new_string: 'description: Updated browser worker integration fixture',
        },
      })
      return
    }
    if (skillMarker === 'BROWSER_NATIVE_SKILL_EDIT_AND_RELOAD' && toolResults.length === 2) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-skill-edit-body',
        name: 'edit',
        arguments: {
          file_path: '/dsh/home/workspace/.agents/skills/browser-proof/SKILL.md',
          old_string: 'Instruction marker: BROWSER_SKILL_BODY_INITIAL',
          new_string: 'Updated instruction marker: BROWSER_SKILL_BODY_UPDATED',
        },
      })
      return
    }
    if (toolResults.length === 0 || skillMarker === 'BROWSER_NATIVE_SKILL_EDIT_AND_RELOAD' && toolResults.length === 3) {
      await scriptedWorkspaceToolCall(response, {
        id: `browser-native-${skillMarker.toLowerCase()}-load`,
        name: 'skill',
        arguments: { name: 'browser-proof' },
      })
      return
    }
    scriptedText(response, `${skillMarker}_DONE`)
    return
  }
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
  const scaleTurnMarker = 'BROWSER_NATIVE_SESSION_SCALE_TURN_E2E'
  if (latestUserText.includes(scaleTurnMarker) && hasTool(tools, 'read')) {
    const turnIndex = Number(latestUserText.match(/scale-turn-(\d+)/)?.[1])
    if (!Number.isSafeInteger(turnIndex)) {
      scriptedText(response, `${scaleTurnMarker}_CONTINUE`)
      return
    }
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(scaleTurnMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: `browser-native-scale-read-${String(turnIndex)}`,
        name: 'read',
        arguments: { file_path: '/dsh/home/browser-validation/scale-input.txt' },
      })
      return
    }
    const wantsWorkspaceWrite = Number.isSafeInteger(turnIndex) && turnIndex % 20 === 0 && hasTool(tools, 'write')
    if (wantsWorkspaceWrite && toolResults.length === 1) {
      await scriptedWorkspaceToolCall(response, {
        id: `browser-native-scale-write-${String(turnIndex)}`,
        name: 'write',
        arguments: {
          file_path: `/dsh/home/workspace/scale-turn-${String(turnIndex)}.txt`,
          content: `scale-turn-${String(turnIndex)}\n${'S'.repeat(32_000)}`,
        },
      })
      return
    }
    scriptedText(response, `${scaleTurnMarker}_${String(turnIndex)}_DONE`)
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

  const attachmentReadMarker = 'BROWSER_NATIVE_ATTACHMENT_READ_E2E'
  if (latestUserText.includes(attachmentReadMarker) && hasTool(tools, 'read')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(attachmentReadMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      const filePath = latestUserText.match(/\/dsh\/home\/attachments\/v1\/files\/[a-f0-9]{2}\/[a-f0-9]{64}\/[^\s"'`]+/)?.[0]
        ?.replace(/[.,;:!?]+$/u, '')
      if (filePath === undefined) {
        scriptedText(response, 'BROWSER_NATIVE_ATTACHMENT_PATH_MISSING')
        return
      }
      await scriptedWorkspaceToolCall(response, {
        id: `browser-native-attachment-read-${String(markerIndex)}`,
        name: 'read',
        arguments: { file_path: filePath, offset: 1, limit: 1 },
      })
      return
    }
    scriptedText(response, 'BROWSER_NATIVE_ATTACHMENT_READ_DONE')
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
    scriptedText(response, toolResults.length === 2
      && /writer lease.*released|local writer was invalidated/i.test(resultText)
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

  const permissionWriteMarker = [
    'BROWSER_NATIVE_PERMISSION_READ_ONLY_E2E',
    'BROWSER_NATIVE_PERMISSION_WORKSPACE_WRITE_E2E',
    'BROWSER_NATIVE_PERMISSION_DANGER_E2E',
  ].find(marker => latestUserText.includes(marker))
  if (permissionWriteMarker !== undefined && hasTool(tools, 'write')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(permissionWriteMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: `browser-native-permission-${permissionWriteMarker.toLowerCase().replaceAll('_', '-')}`,
        name: 'write',
        arguments: {
          file_path: `/dsh/home/workspace/${permissionWriteMarker.toLowerCase()}.txt`,
          content: `${permissionWriteMarker}_WRITE_OK\n`,
        },
      })
      return
    }
    scriptedText(response, toolResultIsError(toolResults[0])
      ? `${permissionWriteMarker}_BLOCKED`
      : `${permissionWriteMarker}_DONE`)
    return
  }

  const quotaToolMarker = 'BROWSER_NATIVE_QUOTA_TOOL_E2E'
  if (latestUserText.includes(quotaToolMarker) && hasTool(tools, 'write')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(quotaToolMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-quota-write',
        name: 'write',
        arguments: {
          file_path: '/dsh/home/workspace/quota-tool.txt',
          content: 'quota-tool-first-attempt\n',
        },
      })
      return
    }
    scriptedText(response, `${quotaToolMarker}_DONE`)
    return
  }

  const isolationToolMarker = 'BROWSER_NATIVE_ISOLATION_TOOL_E2E'
  if (latestUserText.includes(isolationToolMarker) && hasTool(tools, 'bash')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(isolationToolMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-isolation-bash',
        name: 'bash',
        arguments: {
          command: "printf 'BROWSER_NATIVE_ISOLATION_TOOL_OK\\n'",
          description: 'Verify Worker tool dispatch under response security headers.',
        },
      })
      return
    }
    scriptedText(response, `${isolationToolMarker}_DONE`)
    return
  }

  const quotaReloadRetryMarker = 'BROWSER_NATIVE_QUOTA_RELOAD_RETRY_E2E'
  if (latestUserText.includes(quotaReloadRetryMarker) && hasTool(tools, 'write')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(quotaReloadRetryMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-quota-reload-retry-write',
        name: 'write',
        arguments: {
          file_path: '/dsh/home/workspace/quota-tool-retry.txt',
          content: 'quota-tool-retry-succeeded\n',
        },
      })
      return
    }
    scriptedText(response, `${quotaReloadRetryMarker}_DONE`)
    return
  }

  const quotaRetryMarker = 'BROWSER_NATIVE_QUOTA_RETRY_E2E'
  if (latestUserText.includes(quotaRetryMarker) && hasTool(tools, 'write')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(quotaRetryMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-quota-retry-write',
        name: 'write',
        arguments: {
          file_path: '/dsh/home/workspace/quota-tool.txt',
          content: 'quota-tool-retry-succeeded\n',
        },
      })
      return
    }
    scriptedText(response, `${quotaRetryMarker}_DONE`)
    return
  }

  const reloadToolMarker = 'BROWSER_NATIVE_RELOAD_DURING_TOOL_E2E'
  if (latestUserText.includes(reloadToolMarker) && hasTool(tools, 'bash')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(reloadToolMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-reload-bash',
        name: 'bash',
        arguments: {
          command: "sleep 8; printf 'BROWSER_NATIVE_RELOAD_RESIDUAL\\n' > /dsh/home/workspace/reload-residual.txt",
          description: 'Write after a delay so the page can reload during execution.',
          sandbox_permissions: 'workspace-write',
        },
      })
      return
    }
    scriptedText(response, `${reloadToolMarker}_DONE`)
    return
  }

  const reloadContinueMarker = 'BROWSER_NATIVE_RELOAD_CONTINUE_E2E'
  if (latestUserText.includes(reloadContinueMarker)) {
    scriptedText(response, `${reloadContinueMarker}_DONE`)
    return
  }

  const tabCloseToolMarker = 'BROWSER_NATIVE_TAB_CLOSE_DURING_TOOL_E2E'
  if (latestUserText.includes(tabCloseToolMarker) && hasTool(tools, 'bash')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(tabCloseToolMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-tab-close-bash',
        name: 'bash',
        arguments: {
          command: "sleep 8; printf 'BROWSER_NATIVE_TAB_CLOSE_RESIDUAL\\n' > /dsh/home/workspace/tab-close-residual.txt",
          description: 'Write after a delay so the tab can close during execution.',
          sandbox_permissions: 'workspace-write',
        },
      })
      return
    }
    scriptedText(response, `${tabCloseToolMarker}_DONE`)
    return
  }

  const permissionApprovalMarker = [
    'BROWSER_NATIVE_PERMISSION_APPROVAL_RECOVERY_E2E',
    'BROWSER_NATIVE_PERMISSION_APPROVAL_E2E',
  ].find(marker => hasUserMarker(messages, marker))
  if (permissionApprovalMarker !== undefined && hasTool(tools, 'bash')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(permissionApprovalMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      await scriptedWorkspaceToolCall(response, {
        id: permissionApprovalMarker.endsWith('RECOVERY_E2E')
          ? 'browser-native-permission-approval-recovery-bash'
          : 'browser-native-permission-approval-bash',
        name: 'bash',
        arguments: {
          command: permissionApprovalMarker.endsWith('RECOVERY_E2E')
            ? "printf 'BROWSER_NATIVE_PERMISSION_APPROVAL_RECOVERY_WRITE_OK\\n' > /dsh/home/workspace/approval-recovery-result.txt"
            : "printf 'BROWSER_NATIVE_PERMISSION_APPROVAL_WRITE_OK\\n' > /dsh/home/workspace/approval-result.txt",
          description: 'Write the approval lifecycle fixture in the Worker workspace.',
          sandbox_permissions: 'danger-full-access',
          justification: 'The permission lifecycle test requests one approved Worker workspace write.',
        },
      })
      return
    }
    const resultMarker = permissionApprovalMarker.endsWith('RECOVERY_E2E')
      ? 'BROWSER_NATIVE_PERMISSION_APPROVAL_RECOVERY'
      : 'BROWSER_NATIVE_PERMISSION_APPROVAL'
    scriptedText(response, toolResultIsError(toolResults[0])
      ? `${resultMarker}_REJECTED`
      : `${resultMarker}_ALLOWED`)
    return
  }

  const skillApplicationMarker = 'BROWSER_NATIVE_SKILL_APPLICATION_PROBE'
  if (hasUserMarker(messages, skillApplicationMarker)) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(skillApplicationMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    const catalog = messages.findLast(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes('<available_skills>'))?.content ?? ''
    const catalogHasSkill = catalog.includes('browser-proof')
    if (toolResults.length === 0) {
      if (catalogHasSkill && hasTool(tools, 'skill')) {
        await scriptedWorkspaceToolCall(response, {
          id: 'browser-native-skill-application-load',
          name: 'skill',
          arguments: { name: 'browser-proof' },
        })
      } else {
        scriptedText(response, 'BROWSER_NATIVE_SKILL_APPLICATION_ABSENT')
      }
      return
    }
    if (toolResults.length === 1) {
      await scriptedWorkspaceToolCall(response, {
        id: 'browser-native-skill-application-read',
        name: 'read',
        arguments: { file_path: '/dsh/home/workspace/proof.txt' },
      })
      return
    }
    const readText = toolResults.at(-1)?.content
    const contents = typeof readText === 'string'
      ? readText.match(/BROWSER_SKILL_APPLICATION_CODEWORD_[A-Z0-9]+/)?.[0]
      : undefined
    scriptedText(response, contents === undefined
      ? 'BROWSER_NATIVE_SKILL_APPLICATION_READ_FAILED'
      : `BROWSER_NATIVE_SKILL_APPLICATION_APPLIED:${contents}`)
    return
  }

  const approvalSettlementMarker = [
    'BROWSER_NATIVE_APPROVAL_ALLOW_ONCE_E2E',
    'BROWSER_NATIVE_APPROVAL_QUEUE_E2E',
    'BROWSER_NATIVE_APPROVAL_CANCEL_E2E',
  ].find(marker => latestUserText.includes(marker))
  if (approvalSettlementMarker !== undefined && hasTool(tools, 'bash')) {
    const markerIndex = messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(approvalSettlementMarker))
    const toolResults = messages.slice(markerIndex + 1).filter(message => message.role === 'tool')
    const toolCall = (id, path, content, justification) => ({
      id,
      name: 'bash',
      arguments: {
        command: `printf '${content}\\n' > /dsh/home/workspace/${path}`,
        description: 'Write one Browser-Native approval settlement fixture.',
        sandbox_permissions: 'danger-full-access',
        justification,
      },
    })
    if (toolResults.length === 0) {
      if (approvalSettlementMarker === 'BROWSER_NATIVE_APPROVAL_QUEUE_E2E') {
        await scriptedWorkspaceToolCalls(response, [
          toolCall('browser-native-approval-queue-first', 'approval-queue-first.txt', 'APPROVAL_QUEUE_FIRST_OK', 'FIFO_FIRST: approve this first queued operation.'),
          toolCall('browser-native-approval-queue-second', 'approval-queue-second.txt', 'APPROVAL_QUEUE_SECOND_OK', 'FIFO_SECOND: reject this second queued operation.'),
        ])
      } else {
        const cancel = approvalSettlementMarker === 'BROWSER_NATIVE_APPROVAL_CANCEL_E2E'
        await scriptedWorkspaceToolCall(response, toolCall(
          cancel ? 'browser-native-approval-cancel' : 'browser-native-approval-allow-once',
          cancel ? 'approval-cancel-result.txt' : 'approval-allow-once-result.txt',
          cancel ? 'APPROVAL_CANCEL_MUST_NOT_WRITE' : 'APPROVAL_ALLOW_ONCE_WRITE_OK',
          cancel ? 'CANCEL_PENDING: stop this operation before approval.' : 'ALLOW_ONCE: approve this operation exactly once.',
        ))
      }
      return
    }
    if (approvalSettlementMarker === 'BROWSER_NATIVE_APPROVAL_QUEUE_E2E' && toolResults.length !== 2) {
      scriptedText(response, 'BROWSER_NATIVE_APPROVAL_QUEUE_UNEXPECTED_RESULT_COUNT')
      return
    }
    scriptedText(response, `${approvalSettlementMarker}_${toolResults.some(toolResultIsError) ? 'SETTLED_WITH_ERROR' : 'SETTLED'}`)
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

/** OpenAI-compatible Chat Completions request body carrying the Worker wire request unchanged. */
function openAiRequestBody(config, body) {
  return {
    model: config.model,
    messages: body.messages,
    tools: body.tools,
    temperature: body.temperature,
    max_tokens: body.maxTokens,
    reasoning_effort: body.reasoningEffort,
    stream: true,
    ...(config.includeUsage ? { stream_options: { include_usage: true } } : {}),
  }
}

/** Parse historical tool arguments for a tool_use block; unrepresentable input becomes an empty object. */
function anthropicToolInput(argumentsText) {
  if (typeof argumentsText !== 'string' || argumentsText.length === 0) return {}
  try {
    const parsed = JSON.parse(argumentsText)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Merge one translated message into the Anthropic conversation.
 * @param messages - Anthropic-format conversation accumulated so far.
 * @param role - Anthropic role for the new content blocks.
 * @param blocks - Content blocks in provider order; empty lists are dropped.
 * @returns Nothing; the last message absorbs consecutive same-role blocks.
 */
function appendAnthropicMessage(messages, role, blocks) {
  if (blocks.length === 0) return
  const previous = messages.at(-1)
  if (previous === undefined || previous.role !== role) messages.push({ role, content: blocks })
  else previous.content.push(...blocks)
}

/**
 * Convert one Worker wire message body into Anthropic content blocks.
 *
 * The Worker emits a string for text-only messages and an OpenAI-shaped part
 * array when the message carries images, so the same translator serves both
 * request generations. Image parts become base64 image sources; a URL that is
 * not a base64 data URL is rejected instead of sending a reference the provider
 * could fetch.
 * @param {string | readonly object[]} content - Worker wire content.
 * @returns {object[]} Anthropic text and image blocks in wire order.
 */
function anthropicContentBlocks(content) {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const blocks = []
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      blocks.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type !== 'image_url' || typeof part.image_url?.url !== 'string') continue
    const match = IMAGE_DATA_URL.exec(part.image_url.url)
    if (match === null) throw new BackendError('INVALID_REQUEST', 'image_url must be a base64 data URL for an Anthropic provider')
    blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
  }
  return blocks
}

/** Translate the Worker's OpenAI-shaped wire request into an Anthropic Messages body. */
function anthropicRequestBody(config, body) {
  const system = []
  const messages = []
  for (const message of body.messages ?? []) {
    if (message.role === 'system' || message.role === 'developer') {
      if (typeof message.content === 'string' && message.content.length > 0) system.push(message.content)
      continue
    }
    if (message.role === 'tool') {
      appendAnthropicMessage(messages, 'user', [{
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: typeof message.content === 'string' ? message.content : '',
      }])
      continue
    }
    const blocks = anthropicContentBlocks(message.content)
    for (const call of message.tool_calls ?? []) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: anthropicToolInput(call.function.arguments) })
    }
    appendAnthropicMessage(messages, message.role === 'assistant' ? 'assistant' : 'user', blocks)
  }
  // A cache breakpoint after the system block covers the preceding tools and
  // system prompt, so the wire opt-in adds exactly one marker.
  const systemPayload = system.length === 0
    ? {}
    : {
        system: body.promptCaching === true
          ? [{ type: 'text', text: system.join('\n\n'), cache_control: { type: 'ephemeral' } }]
          : system.join('\n\n'),
      }
  return {
    model: config.model,
    max_tokens: body.maxTokens ?? config.defaultMaxTokens,
    ...systemPayload,
    messages,
    ...(Array.isArray(body.tools) && body.tools.length > 0 ? {
      tools: body.tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      })),
    } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    stream: true,
  }
}

/** Provider headers: Anthropic uses `x-api-key` plus an API version; OpenAI uses bearer auth. */
function upstreamHeaders(config) {
  const common = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'user-agent': 'deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)',
  }
  return config.kind === 'anthropic'
    ? { ...common, 'x-api-key': config.apiKey, 'anthropic-version': config.apiVersion }
    : { ...common, authorization: `Bearer ${config.apiKey}` }
}

function retryAfterMsOf(value) {
  if (value === null) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

/**
 * Classify an upstream HTTP failure so the UI can distinguish credentials,
 * quota, and availability from an unclassified provider error.
 * @param upstream - Non-OK provider response.
 * @returns BackendError preserving the provider status in details.
 */
async function upstreamFailure(upstream) {
  const status = upstream.status
  const retryAfterMs = retryAfterMsOf(upstream.headers.get('retry-after'))
  let providerErrorType
  try {
    const payload = await upstream.json()
    if (typeof payload?.error?.type === 'string') providerErrorType = payload.error.type
  } catch {
    // A non-JSON error body still carries its HTTP status; keep the classification.
  }
  const details = { providerStatus: status, ...(providerErrorType === undefined ? {} : { providerErrorType }) }
  if (status === 401 || status === 403) {
    return new BackendError('UPSTREAM_LLM_AUTH_FAILED', `upstream LLM rejected credentials with HTTP ${status}`, 502, undefined, details)
  }
  if (status === 429) {
    return new BackendError('UPSTREAM_LLM_RATE_LIMITED', 'upstream LLM rate limit or quota was exceeded', 503, retryAfterMs, details)
  }
  if (status === 503 || status === 529) {
    return new BackendError('UPSTREAM_LLM_UNAVAILABLE', `upstream LLM is unavailable with HTTP ${status}`, 503, retryAfterMs, details)
  }
  if (status === 408 || status === 504) {
    return new BackendError('UPSTREAM_LLM_TIMEOUT', `upstream LLM timed out with HTTP ${status}`, 504, retryAfterMs, details)
  }
  return new BackendError('UPSTREAM_LLM_FAILED', `upstream LLM returned HTTP ${status}`, 502, retryAfterMs, details)
}

/** OpenAI-compatible SSE to DSH stream-chunk translation, preserving the finish/usage ordering. */
function createOpenAiStream(response, config) {
  const toolCalls = new Map()
  let nextIndex = 0
  let textIndex
  let text = ''
  let reasoningIndex
  let reasoning = ''
  let finished = false
  let pendingFinish
  const finishStream = finishReason => {
    if (toolCalls.size === 0 && textIndex === undefined && reasoningIndex === undefined) {
      writeStream(response, { kind: 'error', error: { code: 'UPSTREAM_LLM_EMPTY', message: 'upstream LLM completed without text or tool calls' } })
      finished = true
      return true
    }
    if (reasoningIndex !== undefined) writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoning } } })
    if (textIndex !== undefined) writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: textIndex, block: { type: 'text', text } } })
    for (const { index, ...toolCall } of toolCalls.values()) writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index, block: { type: 'tool-call', ...toolCall } } })
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: finishReason === 'length' ? { kind: 'max-tokens' } : toolCalls.size > 0 ? { kind: 'tool-calls' } : { kind: 'stop' } } })
    finished = true
    return true
  }
  const consume = data => {
    if (data === '[DONE]') return finished || finishStream(pendingFinish ?? (toolCalls.size > 0 ? 'tool_calls' : 'stop'))
    const item = JSON.parse(data)
    const usage = streamUsage(item.usage)
    if (usage !== undefined) writeStream(response, { kind: 'chunk', chunk: { type: 'usage', usage } })
    const delta = item.choices?.[0]?.delta
    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      if (reasoningIndex === undefined) {
        reasoningIndex = nextIndex++
        writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' } })
      }
      reasoning += delta.reasoning_content
      writeStream(response, { kind: 'chunk', chunk: { type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content } })
    }
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
        toolCall = {
          index: nextIndex++,
          id: typeof providerCall.id === 'string' && providerCall.id.length > 0 ? providerCall.id : randomUUID(),
          name: '',
          arguments: '',
        }
        toolCalls.set(providerIndex, toolCall)
        writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: toolCall.index, blockType: 'tool-call' } })
      }
      if (typeof providerCall.id === 'string' && providerCall.id.length > 0) toolCall.id = providerCall.id
      toolCall.name += providerCall.function?.name ?? ''
      if (providerCall.function?.arguments) {
        toolCall.arguments += providerCall.function.arguments
        writeStream(response, { kind: 'chunk', chunk: { type: 'tool-call-delta', index: toolCall.index, id: toolCall.id, name: toolCall.name, argumentsDelta: providerCall.function.arguments } })
      }
    }
    const finish = item.choices?.[0]?.finish_reason
    if (finish !== undefined && finish !== null) {
      pendingFinish = finish
      // OpenAI-compatible providers send the usage chunk after finish_reason when asked.
      if (!config.includeUsage) return finishStream(finish)
    }
    return false
  }
  return {
    get finished() { return finished },
    consume,
    finishAtEof() {
      if (!finished && config.includeUsage && pendingFinish !== undefined) finishStream(pendingFinish)
      return finished
    },
  }
}

const ANTHROPIC_STREAM_ERROR_CODES = new Map([
  ['authentication_error', 'UPSTREAM_LLM_AUTH_FAILED'],
  ['permission_error', 'UPSTREAM_LLM_AUTH_FAILED'],
  ['rate_limit_error', 'UPSTREAM_LLM_RATE_LIMITED'],
  ['overloaded_error', 'UPSTREAM_LLM_UNAVAILABLE'],
  ['invalid_request_error', 'UPSTREAM_LLM_FAILED'],
  ['not_found_error', 'UPSTREAM_LLM_FAILED'],
  ['api_error', 'UPSTREAM_LLM_STREAM_FAILED'],
])

/** Anthropic Messages SSE to DSH stream-chunk translation. */
function createAnthropicStream(response) {
  const blocks = new Map()
  let finished = false
  let stopReason
  let inputTokens
  let outputTokens
  let cacheReadTokens
  let cacheWriteTokens
  const writeUsage = () => {
    if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return
    // Anthropic reports `input_tokens` as the uncached portion; the DSH usage
    // event keeps the same split and derives its total from all four counts.
    const usage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0),
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    }
    writeStream(response, { kind: 'chunk', chunk: { type: 'usage', usage } })
  }
  const finishStream = () => {
    if (blocks.size === 0) {
      writeStream(response, { kind: 'error', error: { code: 'UPSTREAM_LLM_EMPTY', message: 'upstream LLM completed without text or tool calls' } })
      finished = true
      return true
    }
    writeUsage()
    const reason = stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded'
      ? { kind: 'max-tokens' }
      : stopReason === 'tool_use' ? { kind: 'tool-calls' } : { kind: 'stop' }
    writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason } })
    finished = true
    return true
  }
  const consume = data => {
    const item = JSON.parse(data)
    switch (item.type) {
      case 'message_start': {
        const usage = item.message?.usage
        if (Number.isSafeInteger(usage?.input_tokens)) inputTokens = usage.input_tokens
        if (Number.isSafeInteger(usage?.output_tokens)) outputTokens = usage.output_tokens
        if (Number.isSafeInteger(usage?.cache_read_input_tokens)) cacheReadTokens = usage.cache_read_input_tokens
        if (Number.isSafeInteger(usage?.cache_creation_input_tokens)) cacheWriteTokens = usage.cache_creation_input_tokens
        return false
      }
      case 'content_block_start': {
        const block = item.content_block ?? {}
        if (block.type === 'text') {
          blocks.set(item.index, { kind: 'text', text: '' })
          writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: item.index, blockType: 'text' } })
        } else if (block.type === 'thinking') {
          blocks.set(item.index, { kind: 'reasoning', text: '' })
          writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: item.index, blockType: 'reasoning' } })
        } else if (block.type === 'tool_use') {
          blocks.set(item.index, { kind: 'tool-call', id: block.id, name: block.name ?? '', arguments: '' })
          writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: item.index, blockType: 'tool-call' } })
        }
        return false
      }
      case 'content_block_delta': {
        const block = blocks.get(item.index)
        if (block === undefined) return false
        if (block.kind === 'text' && item.delta?.type === 'text_delta' && typeof item.delta.text === 'string') {
          block.text += item.delta.text
          writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: item.index, text: item.delta.text } })
        } else if (block.kind === 'reasoning' && item.delta?.type === 'thinking_delta' && typeof item.delta.thinking === 'string') {
          block.text += item.delta.thinking
          writeStream(response, { kind: 'chunk', chunk: { type: 'reasoning-delta', index: item.index, text: item.delta.thinking } })
        } else if (block.kind === 'tool-call' && item.delta?.type === 'input_json_delta') {
          const partial = typeof item.delta.partial_json === 'string' ? item.delta.partial_json : ''
          if (partial.length > 0) {
            block.arguments += partial
            writeStream(response, { kind: 'chunk', chunk: { type: 'tool-call-delta', index: item.index, id: block.id, name: block.name, argumentsDelta: partial } })
          }
        }
        return false
      }
      case 'content_block_stop': {
        const block = blocks.get(item.index)
        if (block === undefined) return false
        writeStream(response, {
          kind: 'chunk',
          chunk: block.kind === 'text'
            ? { type: 'block-end', index: item.index, block: { type: 'text', text: block.text } }
            : block.kind === 'reasoning'
              ? { type: 'block-end', index: item.index, block: { type: 'reasoning', text: block.text } }
              : { type: 'block-end', index: item.index, block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments } },
        })
        return false
      }
      case 'message_delta': {
        if (typeof item.delta?.stop_reason === 'string') stopReason = item.delta.stop_reason
        if (Number.isSafeInteger(item.usage?.input_tokens)) inputTokens = item.usage.input_tokens
        if (Number.isSafeInteger(item.usage?.output_tokens)) outputTokens = item.usage.output_tokens
        if (Number.isSafeInteger(item.usage?.cache_read_input_tokens)) cacheReadTokens = item.usage.cache_read_input_tokens
        if (Number.isSafeInteger(item.usage?.cache_creation_input_tokens)) cacheWriteTokens = item.usage.cache_creation_input_tokens
        return false
      }
      case 'message_stop':
        return finished || finishStream()
      case 'error': {
        const type = typeof item.error?.type === 'string' ? item.error.type : ''
        const message = typeof item.error?.message === 'string' ? item.error.message : 'upstream LLM reported a stream error'
        writeStreamError(response, ANTHROPIC_STREAM_ERROR_CODES.get(type) ?? 'UPSTREAM_LLM_STREAM_FAILED', message)
        finished = true
        return true
      }
      case 'ping':
        return false
      default:
        return false
    }
  }
  return {
    get finished() { return finished },
    consume,
    finishAtEof() { return finished },
  }
}

const NDJSON_RESPONSE_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
  'x-browser-native-protocol': String(PROTOCOL_VERSION),
}

/**
 * Defer the 200 response head until the first stream item reaches the client.
 *
 * A provider that fails before its first item leaves the response untouched, so
 * the caller can retry on the secondary provider without rewriting a partial
 * body. `emitted` records whether the client already saw text or a tool call.
 * @param {import('node:http').ServerResponse} response - Client response.
 * @returns {object} Sink accepted by the stream translators.
 */
function createStreamSink(response) {
  let headersWritten = false
  const sink = {
    emitted: false,
    /**
     * Write one NDJSON line, opening the 200 response first when needed.
     * @param {string} line - Serialized stream item.
     * @returns {void}
     */
    write(line) {
      if (response.destroyed) return
      if (!headersWritten) {
        response.writeHead(200, NDJSON_RESPONSE_HEADERS)
        headersWritten = true
      }
      sink.emitted = true
      response.write(line)
    },
    /**
     * End the response; an empty, successful stream still gets a 200 head.
     * @returns {void}
     */
    end() {
      if (response.destroyed || response.writableEnded) return
      if (!headersWritten) {
        response.writeHead(200, NDJSON_RESPONSE_HEADERS)
        headersWritten = true
      }
      response.end()
    },
    get headersWritten() { return headersWritten },
    get destroyed() { return response.destroyed },
    get writableEnded() { return response.writableEnded },
  }
  return sink
}

/**
 * Decide whether an attempt may move to the secondary provider.
 *
 * Only availability faults qualify: 5xx, 408/504, unreachable upstreams, and
 * pre-output stream breaks. Credential, quota, invalid-request, and empty
 * completion faults are the provider's answer and must surface unchanged.
 * @param {unknown} error - Attempt failure.
 * @returns {boolean} Whether the next attempt may run.
 */
function retryableFailure(error) {
  const status = error?.details?.providerStatus
  if (Number.isSafeInteger(status)) return status >= 500 || status === 408 || status === 504
  return error?.code === 'UPSTREAM_LLM_UNAVAILABLE' || error?.code === 'UPSTREAM_LLM_TIMEOUT'
    || error?.code === 'UPSTREAM_LLM_TRUNCATED' || error?.code === 'UPSTREAM_LLM_STREAM_FAILED'
}

/**
 * Run one provider attempt and translate its stream for the client.
 *
 * An attempt that fails before emitting anything reports `retry` when a
 * secondary provider is configured. An attempt that emitted text or a tool
 * call never retries: a second provider would duplicate the visible output and
 * could execute the same tool twice. Usage is reported only by the attempt that
 * produced the client response, so one request cannot be billed twice.
 * @param {import('node:http').ServerResponse} response - Client response.
 * @param {import('node:http').IncomingMessage} request - Client request.
 * @param {object} config - Provider config for this attempt.
 * @param {object} body - Model request body.
 * @param {{ canRetry: boolean }} options - Whether a secondary provider follows.
 * @returns {Promise<{ status: 'retry', error: Error } | { status: 'complete', usage?: object }>} Attempt result.
 */
async function runLlmAttempt(response, request, config, body, { canRetry }) {
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
  const sink = createStreamSink(response)
  let auditInput
  let auditOutput
  let auditCacheRead
  let auditCacheWrite
  // `inputTokens` stays the provider's full prompt count so the ledger and cost
  // report keep one billing total; the cache breakdown is reported beside it.
  const usage = () => (Number.isSafeInteger(auditInput) && Number.isSafeInteger(auditOutput)
    ? {
        inputTokens: auditInput,
        outputTokens: auditOutput,
        ...(Number.isSafeInteger(auditCacheRead) ? { cacheReadTokens: auditCacheRead } : {}),
        ...(Number.isSafeInteger(auditCacheWrite) ? { cacheWriteTokens: auditCacheWrite } : {}),
      }
    : undefined)
  const timeoutFailure = () => new BackendError('UPSTREAM_LLM_TIMEOUT', `upstream LLM did not respond within ${config.timeoutMs}ms`, 504)
  // Serialize before the transport try so a malformed wire message reports a
  // request error rather than an unreachable upstream.
  const upstreamBody = JSON.stringify(config.kind === 'anthropic' ? anthropicRequestBody(config, body) : openAiRequestBody(config, body))
  let upstream
  try {
    try {
      upstream = await fetch(config.url, {
        method: 'POST',
        headers: upstreamHeaders(config),
        body: upstreamBody,
        signal: controller.signal,
      })
    } catch (error) {
      if (clientClosed) return { status: 'complete' }
      const failure = timedOut ? timeoutFailure() : new BackendError('UPSTREAM_LLM_UNAVAILABLE', 'upstream LLM could not be reached', 502)
      if (canRetry) return { status: 'retry', error: failure }
      throw failure
    }
    if (!upstream.ok || upstream.body === null) {
      const failure = await upstreamFailure(upstream)
      if (canRetry && retryableFailure(failure)) return { status: 'retry', error: failure }
      throw failure
    }
    const stream = config.kind === 'anthropic' ? createAnthropicStream(sink) : createOpenAiStream(sink, config)
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const part = await reader.read()
      buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data !== '[DONE]') {
            try {
              const item = JSON.parse(data)
              const reported = item.usage ?? item.message?.usage
              const input = reported?.prompt_tokens ?? reported?.input_tokens
              const output = reported?.completion_tokens ?? reported?.output_tokens
              const details = reported?.prompt_tokens_details
              const cached = details?.cached_tokens ?? reported?.prompt_cache_hit_tokens ?? reported?.cache_read_input_tokens
              const written = details?.cache_write_tokens ?? reported?.prompt_cache_write_tokens ?? reported?.cache_creation_input_tokens
              if (Number.isSafeInteger(input)) auditInput = config.kind === 'anthropic'
                ? input + (Number.isSafeInteger(cached) ? cached : 0) + (Number.isSafeInteger(written) ? written : 0)
                : input
              if (Number.isSafeInteger(output)) auditOutput = output
              if (Number.isSafeInteger(cached)) auditCacheRead = cached
              if (Number.isSafeInteger(written)) auditCacheWrite = written
            } catch {
              // A provider heartbeat line that is not JSON carries no usage.
            }
          }
          if (stream.consume(data)) {
            sink.end()
            return { status: 'complete', usage: usage() }
          }
        }
        newline = buffer.indexOf('\n')
      }
      if (part.done) break
    }
    if (!stream.finished && !clientClosed) {
      if (timedOut) {
        const failure = timeoutFailure()
        if (canRetry && !sink.emitted) return { status: 'retry', error: failure }
        writeStreamError(sink, 'UPSTREAM_LLM_TIMEOUT', `upstream LLM did not finish within ${config.timeoutMs}ms`)
      } else if (!stream.finishAtEof()) {
        const failure = new BackendError('UPSTREAM_LLM_TRUNCATED', 'upstream LLM stream ended before a finish event', 502)
        if (canRetry && !sink.emitted) return { status: 'retry', error: failure }
        writeStreamError(sink, 'UPSTREAM_LLM_TRUNCATED', 'upstream LLM stream ended before a finish event')
      }
    }
    if (!response.writableEnded) sink.end()
    return { status: 'complete', usage: usage() }
  } catch (error) {
    if (clientClosed) return { status: 'complete' }
    if (sink.emitted) {
      // Text or a tool call already reached the loop; a retry would duplicate it.
      if (timedOut) writeStreamError(sink, 'UPSTREAM_LLM_TIMEOUT', `upstream LLM did not finish within ${config.timeoutMs}ms`)
      else writeStreamError(sink, 'UPSTREAM_LLM_STREAM_FAILED', 'upstream LLM stream failed before completion')
      return { status: 'complete', usage: usage() }
    }
    const failure = timedOut ? timeoutFailure() : error
    if (canRetry && retryableFailure(failure)) return { status: 'retry', error: failure }
    throw failure
  } finally {
    clearTimeout(timeout)
    request.off('aborted', abortForClient)
    response.off('close', abortForResponseClose)
    if (!upstream?.body?.locked) await upstream?.body?.cancel?.().catch(() => {})
  }
}

/**
 * Proxy a real provider request, falling back once before any client output.
 *
 * Usage is recorded at most once per client request, by the attempt that
 * produced the response, and carries the provider that answered.
 * @param {import('node:http').ServerResponse} response - Client response.
 * @param {import('node:http').IncomingMessage} request - Client request.
 * @param {object} config - Primary provider config, optionally with `fallback`.
 * @param {object} body - Model request body.
 * @param {(entry: object) => void} recordUsage - Ledger sink for provider usage.
 * @returns {Promise<void>} Resolves after the client response ends.
 */
async function realLlm(response, request, config, body, recordUsage = () => {}) {
  const attempts = config.fallback === undefined ? [config] : [config, config.fallback]
  let lastFailure
  for (const [index, attempt] of attempts.entries()) {
    const result = await runLlmAttempt(response, request, attempt, body, { canRetry: index + 1 < attempts.length })
    if (result.status === 'retry') {
      lastFailure = result.error
      continue
    }
    if (result.usage !== undefined) {
      recordUsage({
        requestId: body.requestId,
        sessionId: body.sessionId,
        at: Date.now(),
        ...(body.purpose === undefined ? {} : { purpose: body.purpose }),
        provider: attempt.provider,
        attempt: index + 1,
        ...(index > 0 ? { fallbackUsed: true } : {}),
        ...result.usage,
      })
    }
    return
  }
  throw lastFailure ?? new BackendError('UPSTREAM_LLM_FAILED', 'every configured LLM provider failed', 502)
}

async function safeStaticPath(root, pathname) {
  const relativePath = pathname === '/' ? 'preview.html' : pathname.slice(1)
  const file = resolve(root, relativePath)
  if (relative(root, file).startsWith('..')) throw new BackendError('NOT_FOUND', 'file not found', 404)
  const realRoot = await realpath(root).catch(() => root)
  const realFile = await realpath(file).catch(error => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return file
    throw error
  })
  const withinRoot = relative(realRoot, realFile)
  if (withinRoot === '' || withinRoot.startsWith('..')) throw new BackendError('NOT_FOUND', 'file not found', 404)
  return realFile
}

async function serveStatic(response, root, pathname) {
  let body
  try {
    body = await readFile(await safeStaticPath(root, pathname))
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
  response.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  response.end(body)
}

async function serveMobilePage(response) {
  const body = await readFile(join(HERE, 'mobile-ui-only.html'))
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  response.end(body)
}

const HOSTED_TOKEN_MAX_BYTES = 8_192
const HOSTED_SECRET_MIN_BYTES = 32
const HOSTED_CLOCK_TOLERANCE_SECONDS = 30

function unauthenticated(message) {
  return new WorkspaceError('UNAUTHENTICATED', message, 401)
}

function decodeHostedSegment(segment) {
  try {
    const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Map a token subject to a stable UUID-shaped principal id.
 * The shape keeps the existing Workspace/Session persistence validation intact
 * while never storing the raw subject in cookies or on disk.
 * @param {string} issuer - Verified issuer claim.
 * @param {string} subject - Verified subject claim.
 * @returns {string} UUID-shaped principal id.
 */
function hostedPrincipalId(issuer, subject) {
  const hex = createHash('sha256').update(`${issuer}\n${subject}`).digest('hex')
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`
}

function audienceMatches(audience, expected) {
  if (typeof audience === 'string') return audience === expected
  return Array.isArray(audience) && audience.includes(expected)
}

/**
 * Verify HS256 JWTs carrying issuer, audience, subject, and expiry claims.
 * A request without an Authorization header stays anonymous; anything else
 * fails closed with 401 before the cookie path is considered.
 * @param {{issuer: string, audience: string, secret: string, clockToleranceSeconds?: number, now?: () => number}} options - Verifier configuration.
 * @returns {{principalFromRequest: (request: object) => string | undefined}} Authenticator.
 */
function createHostedAuthenticator(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('hostedAuth must be an object')
  if (typeof options.issuer !== 'string' || options.issuer.length === 0) {
    throw new TypeError('hostedAuth.issuer must be a non-empty string')
  }
  if (typeof options.audience !== 'string' || options.audience.length === 0) {
    throw new TypeError('hostedAuth.audience must be a non-empty string')
  }
  if (typeof options.secret !== 'string' || Buffer.byteLength(options.secret) < HOSTED_SECRET_MIN_BYTES) {
    throw new TypeError(`hostedAuth.secret must contain at least ${String(HOSTED_SECRET_MIN_BYTES)} bytes`)
  }
  const toleranceSeconds = options.clockToleranceSeconds ?? HOSTED_CLOCK_TOLERANCE_SECONDS
  if (!Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 0 || toleranceSeconds > 3_600) {
    throw new TypeError('hostedAuth.clockToleranceSeconds must be an integer from 0 through 3600')
  }
  const toleranceMs = toleranceSeconds * 1_000
  const now = options.now ?? Date.now
  return {
    principalFromRequest(request) {
      const header = request.headers.authorization
      if (header === undefined) return undefined
      const match = /^Bearer ([^ ]+)$/.exec(header)
      if (match === null) throw unauthenticated('authorization header must contain one Bearer token')
      const token = match[1]
      if (Buffer.byteLength(token) > HOSTED_TOKEN_MAX_BYTES) throw unauthenticated('hosted token is too large')
      const segments = token.split('.')
      if (segments.length !== 3) throw unauthenticated('hosted token is not a compact JWT')
      const [head, payload, signature] = segments
      const tokenHeader = decodeHostedSegment(head)
      if (tokenHeader?.alg !== 'HS256' || (tokenHeader.typ !== undefined && tokenHeader.typ !== 'JWT')) {
        throw unauthenticated('hosted token must use the HS256 algorithm')
      }
      const expected = createHmac('sha256', options.secret).update(`${head}.${payload}`).digest()
      const actual = Buffer.from(signature, 'base64url')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw unauthenticated('hosted token signature is invalid')
      }
      const claims = decodeHostedSegment(payload)
      if (claims === undefined || claims.iss !== options.issuer) throw unauthenticated('hosted token issuer is invalid')
      if (!audienceMatches(claims.aud, options.audience)) throw unauthenticated('hosted token audience is invalid')
      if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 256) {
        throw unauthenticated('hosted token subject is invalid')
      }
      if (!Number.isSafeInteger(claims.exp)) throw unauthenticated('hosted token expiry is missing')
      const current = now()
      if (current > claims.exp * 1_000 + toleranceMs) throw unauthenticated('hosted token has expired')
      if (claims.nbf !== undefined
        && (!Number.isSafeInteger(claims.nbf) || current < claims.nbf * 1_000 - toleranceMs)) {
        throw unauthenticated('hosted token is not valid yet')
      }
      return hostedPrincipalId(options.issuer, claims.sub)
    },
  }
}

/**
 * Create the PoC server. Verified downloads require explicit chunk-object mode.
 * @param {object} options - Server configuration; workspaceVerifiedDownloads defaults
 * to false, workspaceDownloadMaxReaders to 4, and workspaceDownloadTimeoutMs to 30000.
 * `llmIncludeUsage` asks the real upstream for provider-reported token usage.
 * Reader limits include verification; deadlines include verification and transmission.
 * Cancellation destroys the connection immediately; in-progress descriptor/chunk
 * verification finishes before its returned reader can be closed and its slot released.
 * `hostedAuth` maps verified HS256 JWTs to stable principals; it is off by default.
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
  const usagePricing = normalizeUsagePricing(options.usagePricing)
  const budgetLimits = normalizeBudgetLimits(options.budgetLimits)
  const sharedStateOrigin = options.stateAuthorityOrigin === undefined
    ? undefined : new URL(options.stateAuthorityOrigin).origin
  const sharedStateToken = options.stateAuthorityToken
  if (sharedStateOrigin !== undefined
    && (typeof sharedStateToken !== 'string' || sharedStateToken.length < 32 || sharedStateToken.length > 200)) {
    throw new TypeError('stateAuthorityToken must contain 32 to 200 characters when stateAuthorityOrigin is configured')
  }
  if (sharedStateOrigin === undefined
    && sharedStateToken !== undefined
    && (typeof sharedStateToken !== 'string' || sharedStateToken.length < 32 || sharedStateToken.length > 200)) {
    throw new TypeError('stateAuthorityToken must contain 32 to 200 characters')
  }
  const mcpServers = options.mcpServers === undefined ? {} : options.mcpServers
  if (mcpServers === null || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
    throw new TypeError('mcpServers must be a map of server ids to transport config')
  }
  for (const [serverId, serverConfig] of Object.entries(mcpServers)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(serverId)) throw new TypeError('mcpServers ids must match [A-Za-z0-9._-]{1,64}')
    if (serverConfig === null || typeof serverConfig !== 'object' || Array.isArray(serverConfig)) {
      throw new TypeError(`mcpServers.${serverId} must be an object`)
    }
    if (typeof serverConfig.url !== 'string') throw new TypeError(`mcpServers.${serverId}.url must be an absolute URL`)
    let upstream
    try { upstream = new URL(serverConfig.url) } catch { throw new TypeError(`mcpServers.${serverId}.url must be an absolute URL`) }
    if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
      throw new TypeError(`mcpServers.${serverId}.url must use http or https`)
    }
    if (serverConfig.headers !== undefined
      && (serverConfig.headers === null || typeof serverConfig.headers !== 'object' || Array.isArray(serverConfig.headers))) {
      throw new TypeError(`mcpServers.${serverId}.headers must be a string map`)
    }
  }
  const workspaceDownloadMaxReaders = timeoutMs(options.workspaceDownloadMaxReaders === undefined ? 4
    : options.workspaceDownloadMaxReaders, 'workspaceDownloadMaxReaders')
  const workspaceDownloadTimeoutMs = timeoutMs(options.workspaceDownloadTimeoutMs === undefined ? 30_000
    : options.workspaceDownloadTimeoutMs, 'workspaceDownloadTimeoutMs')
  const attachmentMaxBytes = options.attachmentMaxBytes === undefined
    ? MAX_ATTACHMENT_BYTES : options.attachmentMaxBytes
  if (!Number.isSafeInteger(attachmentMaxBytes) || attachmentMaxBytes < 1 || attachmentMaxBytes > MAX_ATTACHMENT_BYTES) {
    throw new TypeError(`attachmentMaxBytes must be an integer from 1 through ${String(MAX_ATTACHMENT_BYTES)}`)
  }
  const attachmentGcMinAgeMs = options.attachmentGcMinAgeMs === undefined
    ? DEFAULT_ATTACHMENT_GC_MIN_AGE_MS : options.attachmentGcMinAgeMs
  if (!Number.isSafeInteger(attachmentGcMinAgeMs) || attachmentGcMinAgeMs < 0) {
    throw new TypeError('attachmentGcMinAgeMs must be a non-negative safe integer')
  }
  const attachmentGcSweepIntervalMs = options.attachmentGcSweepIntervalMs === undefined
    ? DEFAULT_ATTACHMENT_GC_SWEEP_MS : options.attachmentGcSweepIntervalMs
  if (!Number.isSafeInteger(attachmentGcSweepIntervalMs) || attachmentGcSweepIntervalMs < 0) {
    throw new TypeError('attachmentGcSweepIntervalMs must be a non-negative safe integer')
  }
  const attachmentGcNow = options.testHooks?.attachmentGcNow ?? Date.now
  const attachmentGcInstance = randomUUID()
  const attachmentGenerations = new Map()
  const attachmentLocks = new Map()
  const attachmentGenerationFor = workspaceId => attachmentGenerations.get(workspaceId) ?? 0
  const bumpAttachmentGeneration = workspaceId => {
    attachmentGenerations.set(workspaceId, attachmentGenerationFor(workspaceId) + 1)
  }
  const attachmentUploadLocks = new Map()
  const withKeyedLock = async (locks, key, operation) => {
    const previous = locks.get(key) ?? Promise.resolve()
    let release
    const current = new Promise(resolveRelease => { release = resolveRelease })
    locks.set(key, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (locks.get(key) === current) locks.delete(key)
    }
  }
  const withAttachmentLock = async (workspaceId, operation) => await withKeyedLock(attachmentLocks, workspaceId, operation)
  const attachmentGcToken = workspaceId => `${attachmentGcInstance}:${String(attachmentGenerationFor(workspaceId))}`
  const parseAttachmentGcToken = token => {
    const match = /^([0-9a-f-]{36}):([0-9]{1,16})$/.exec(token)
    if (match === null) return undefined
    const generation = Number(match[2])
    return Number.isSafeInteger(generation) ? { instance: match[1], generation } : undefined
  }
  const publishAttachment = async (workspaceId, operation) => await withAttachmentLock(workspaceId, async () => {
    const result = await operation()
    bumpAttachmentGeneration(workspaceId)
    return result
  })
  const staleAttachmentGc = workspaceId => ({
    token: attachmentGcToken(workspaceId),
    generation: attachmentGenerationFor(workspaceId),
    scanned: 0,
    kept: 0,
    deleted: [],
    skipped: 'scan-stale',
    failures: [],
  })
  const collectAttachments = async (workspaceId, expectedGeneration, sessions) => {
    const referenced = referencedAttachmentHashes(sessions)
    const objects = await listAttachmentObjects(options.dataDir, workspaceId)
    const now = attachmentGcNow()
    const candidates = objects.filter(object => !referenced.has(object.hash)
      && now - object.modifiedAt >= attachmentGcMinAgeMs)
    const deleted = []
    const failures = []
    let skipped
    await withAttachmentLock(workspaceId, async () => {
      if (attachmentGenerationFor(workspaceId) !== expectedGeneration) {
        skipped = 'scan-stale'
        return
      }
      for (const candidate of candidates) {
        try {
          await rm(candidate.path, { force: true })
          deleted.push(candidate.hash)
        } catch (error) {
          failures.push({ hash: candidate.hash, code: typeof error?.code === 'string' ? error.code : 'DELETE_FAILED' })
        }
      }
    })
    return {
      token: attachmentGcToken(workspaceId),
      generation: attachmentGenerationFor(workspaceId),
      scanned: objects.length,
      kept: objects.length - deleted.length,
      deleted,
      ...(skipped === undefined ? {} : { skipped }),
      failures,
    }
  }
  if (workspaceDownloadTimeoutMs > 2_147_483_647) {
    throw new TypeError('workspaceDownloadTimeoutMs exceeds the Node timer limit')
  }
  await assertDataFormatReadable(options.dataDir)
  const dataDirLock = await acquireDataDirLock(options.dataDir)
  let released = false
  const releaseDataDirLock = async () => {
    if (released) return
    released = true
    await dataDirLock.release()
  }
  try {
  const requireLocalAuth = options.requireLocalAuth === true
  const publicOrigin = options.publicOrigin === undefined ? undefined : parsePublicOrigin(options.publicOrigin)
  const authTokenPath = requireLocalAuth ? join(options.dataDir, AUTH_TOKEN_FILE_NAME) : undefined
  const authToken = requireLocalAuth ? randomBytes(32).toString('base64url') : undefined
  if (authTokenPath !== undefined) {
    const staging = `${authTokenPath}.${process.pid}.tmp`
    await writeFile(staging, `${authToken}\n`, { mode: 0o600 })
    await chmod(staging, 0o600)
    await rename(staging, authTokenPath)
    await chmod(authTokenPath, 0o600)
  }
  const retentionDays = options.retentionDays === undefined ? 0 : options.retentionDays
  if (typeof retentionDays !== 'number' || !Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new TypeError('retentionDays must be a non-negative finite number of days')
  }
  const retentionMs = Math.round(retentionDays * DAY_MS)
  if (retentionDays > 0 && retentionMs < 1) throw new TypeError('retentionDays must be at least one millisecond')
  const retentionSweepMs = options.retentionSweepMs === undefined
    ? DEFAULT_RETENTION_SWEEP_MS : options.retentionSweepMs
  if (!Number.isSafeInteger(retentionSweepMs) || retentionSweepMs < 250) {
    throw new TypeError('retentionSweepMs must be an integer of at least 250')
  }
  const retentionClock = options.testHooks?.retentionNow ?? options.testHooks?.now ?? Date.now
  const store = new FormalSessionStore(options.dataDir, {
    ownerLeaseMs: options.ownerLeaseMs,
    now: options.testHooks?.now ?? options.testHooks?.retentionNow,
    retentionMs,
    failFlush: options.testHooks?.failSessionFlush,
    failFlushAfterRename: options.testHooks?.failSessionFlushAfterRename,
  })
  await store.load()
  if (retentionMs > 0) {
    await store.purgeExpired()
    await redactObservabilityJournal({
      dataDir: options.dataDir,
      shouldRemove: record => recordExpired(record, retentionClock() - retentionMs),
    })
  }
  const hostedAuth = options.hostedAuth === undefined ? undefined : createHostedAuthenticator(options.hostedAuth)
  const workspaces = new WorkspaceStore(options.dataDir, {
    writerLeaseMs: options.testHooks?.workspaceWriterLeaseMs,
    now: options.testHooks?.workspaceNow ?? options.testHooks?.now,
    pendingUploadTtlMs: options.pendingUploadTtlMs,
    blobStore: options.workspaceBlobStore,
    chunkObjects: options.workspaceChunkObjects === true,
    hostedAuth,
  })
  await workspaces.load()
  const crossStoreLedger = new CrossStoreOperationLedger(options.dataDir, { now: options.testHooks?.now })
  await crossStoreLedger.load()
  const sessionShares = new SessionShareStore(options.dataDir, { now: options.testHooks?.now })
  await sessionShares.load()
  const turnRetries = new TurnRetryLedger({ dir: join(options.dataDir, 'turn-retries'), now: options.testHooks?.now })
  await turnRetries.load()
  const sessionEvents = new SessionEventHub()
  const sessionAppendReceipts = new Map()
  const sweepAttachments = async () => {
    const workspaces = []
    for (const workspaceId of await listAttachmentWorkspaces(options.dataDir)) {
      try {
        workspaces.push({
          workspaceId,
          ...await collectAttachments(workspaceId, attachmentGenerationFor(workspaceId), store.sessions.values()),
        })
      } catch (error) {
        workspaces.push({
          workspaceId,
          generation: attachmentGenerationFor(workspaceId),
          scanned: 0,
          kept: 0,
          deleted: [],
          failures: [{ code: typeof error?.code === 'string' ? error.code : 'SWEEP_FAILED', message: error instanceof Error ? error.message : String(error) }],
        })
      }
    }
    return { sweptAt: attachmentGcNow(), workspaces, uploads: await sweepAttachmentUploads(options.dataDir, ATTACHMENT_UPLOAD_TTL_MS, attachmentGcNow()) }
  }
  await sweepAttachmentUploads(options.dataDir, ATTACHMENT_UPLOAD_TTL_MS)
  const attachmentGcSweepTimer = attachmentGcSweepIntervalMs === 0 ? undefined : setInterval(() => {
    void sweepAttachments().catch(() => {})
  }, attachmentGcSweepIntervalMs)
  attachmentGcSweepTimer?.unref()
  const businessServiceOrigin = options.businessServiceOrigin === undefined
    ? undefined
    : new URL(options.businessServiceOrigin).origin
  const llm = await createLlmConfig(options)
  const distRoot = resolve(options.distRoot ?? join(HERE, '../../../apps/web/dist'))
  const workspaceDownloads = new Map()
  const responseHeaders = options.responseHeaders ?? {}
  const egress = options.egress === undefined ? undefined : createEgressPolicy(options.egress)
  const admission = options.admission === false ? undefined : createAdmissionController({
    maxConcurrentTurns: 8,
    maxMountedSessions: 16,
    queueTimeoutMs: 30_000,
    mountLeaseMs: options.ownerLeaseMs ?? DEFAULT_OWNER_LEASE_MS,
    now: options.testHooks?.now,
    ...options.admission,
  })
  if (responseHeaders === null || typeof responseHeaders !== 'object' || Array.isArray(responseHeaders)) {
    throw new TypeError('responseHeaders must be an object')
  }
  for (const [name, value] of Object.entries(responseHeaders)) {
    if (typeof name !== 'string' || name.length === 0 || typeof value !== 'string') {
      throw new TypeError('responseHeaders must map non-empty header names to string values')
    }
  }
  if (options.accessAuditSink !== undefined && typeof options.accessAuditSink !== 'function') {
    throw new TypeError('accessAuditSink must be a function')
  }
  const accessAuditEntries = []
  // Prompt-free operational log: failures and denials only, bounded for exports.
  const diagnosticLog = []
  const recordAccessDenial = (url, request, error) => {
    const status = typeof error.status === 'number' ? error.status : 500
    const principal = workspaces.auditPrincipal(request)
    if (!(status === 401 || status === 403 || (status === 404 && principal !== undefined))) return
    const entry = {
      at: Date.now(),
      method: request.method,
      route: url.pathname,
      resource: auditResourceFor(url.pathname),
      resourceId: url.searchParams.get('workspaceId')
        ?? (typeof error.details?.sessionId === 'string' ? error.details.sessionId : null),
      principalDigest: principal === undefined ? null
        : createHash('sha256').update(principal).digest('hex').slice(0, 16),
      code: typeof error.code === 'string' ? error.code : 'UNKNOWN',
      status,
    }
    accessAuditEntries.push(entry)
    if (accessAuditEntries.length > ACCESS_AUDIT_LIMIT) accessAuditEntries.shift()
    try {
      options.accessAuditSink?.(structuredClone(entry))
    } catch {} // A failing sink must not change the denial the client already received.
    void observabilityJournal.appendAccessDenial(structuredClone(entry))
  }
  /**
   * Read denial evidence for unauthorized or cross-principal requests.
   * @param {number} [limit] - Number of newest entries to return, at most 200.
   * @returns {object[]} Entries with route, resource, principal digest, code, and status.
   */
  const accessAudit = limit => {
    boundedInteger(limit ?? ACCESS_AUDIT_LIMIT, 'accessAudit limit', ACCESS_AUDIT_LIMIT)
    return accessAuditEntries.slice(-(limit ?? ACCESS_AUDIT_LIMIT)).map(clone)
  }
  const collaborationAuditEntries = []
  /**
   * Record one editor lease, append, or share arbitration outcome.
   * @param entry - Action, Session, actor digest, role, outcome, and optional details.
   */
  const recordCollaboration = entry => {
    const record = { at: Date.now(), ...entry }
    collaborationAuditEntries.push(record)
    if (collaborationAuditEntries.length > ACCESS_AUDIT_LIMIT) collaborationAuditEntries.shift()
    return observabilityJournal.appendCollaboration(structuredClone(record))
  }
  /**
   * Read collaboration audit evidence newest-first ordering preserved.
   * @param {number} [limit] - Number of newest entries to return, at most 200.
   * @returns {object[]} Editor lease and write arbitration records.
   */
  const collaborationAudit = limit => {
    boundedInteger(limit ?? ACCESS_AUDIT_LIMIT, 'collaborationAudit limit', ACCESS_AUDIT_LIMIT)
    return collaborationAuditEntries.slice(-(limit ?? ACCESS_AUDIT_LIMIT)).map(clone)
  }
  const MAX_DURABLE_TOOL_WRITE_BYTES = 1 * 1024 * 1024
  const MAX_DURABLE_TOOL_READ_BYTES = 2 * 1024 * 1024
  const DURABLE_WORKSPACE_ROOT = '/dsh/home/workspace/'
  const DURABLE_TOOL_DEFINITIONS = [
    {
      type: 'function',
      function: {
        name: 'write',
        description: 'Write a UTF-8 text file into the caller Workspace. The path is workspace-relative or under /dsh/home/workspace/.',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string' }, content: { type: 'string' } },
          required: ['file_path', 'content'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read',
        description: 'Read a UTF-8 text file from the caller Workspace. The path is workspace-relative or under /dsh/home/workspace/.',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
          additionalProperties: false,
        },
      },
    },
  ]
  const workspaceToolPath = value => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1_000) {
      throw new DurableTurnError('DURABLE_TOOL_INVALID', 'file_path must be a non-empty string of at most 1000 characters', 400)
    }
    if (value.startsWith(DURABLE_WORKSPACE_ROOT)) return value.slice(DURABLE_WORKSPACE_ROOT.length)
    if (value.startsWith('/')) {
      throw new DurableTurnError('DURABLE_TOOL_PATH_FORBIDDEN', `durable tools can only reach ${DURABLE_WORKSPACE_ROOT}`, 403)
    }
    return value
  }
  /**
   * Execute one advertised Workspace tool against the caller's own Workspace.
   *
   * The durable turn runs without an HTTP request of its own, so the executor
   * synthesizes the same principal cookie the workspace routes read. A tool
   * failure returns `isError` text to the model instead of aborting the turn.
   * @param {{principalId: string, name: string, arguments: string}} call - Tool name, raw JSON arguments, and the principal that owns the turn.
   * @returns {Promise<{text: string, isError?: boolean}>} Tool result text.
   */
  const executeDurableTool = async ({ principalId, name, arguments: raw }) => {
    let input
    try {
      input = JSON.parse(raw)
    } catch {
      return { text: `tool ${name} received arguments that are not valid JSON`, isError: true }
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { text: `tool ${name} requires a JSON object argument`, isError: true }
    }
    if (name !== 'read' && name !== 'write') {
      return { text: `the durable host does not implement tool ${name}`, isError: true }
    }
    const request = { headers: { cookie: `dsh-browser-native-principal=${principalId}` } }
    try {
      const workspaceId = workspaces.workspaceIdForPrincipal(principalId)
      const path = workspaceToolPath(input.file_path ?? input.path)
      if (name === 'read') {
        const snapshot = workspaces.manifest(request, workspaceId)
        const entry = snapshot.entries.find(candidate => candidate.path === path && candidate.kind === 'file')
        if (entry === undefined) return { text: `no readable file at ${path}`, isError: true }
        if (entry.bytes > MAX_DURABLE_TOOL_READ_BYTES) {
          return { text: `file ${path} is ${String(entry.bytes)} bytes, above the readable limit`, isError: true }
        }
        const bytes = await workspaces.getBlob(request, workspaceId, entry.hash)
        return { text: bytes.toString('utf8') }
      }
      if (typeof input.content !== 'string') return { text: 'write requires a string content argument', isError: true }
      const bytes = Buffer.from(input.content, 'utf8')
      if (bytes.byteLength > MAX_DURABLE_TOOL_WRITE_BYTES) {
        return { text: `content is ${String(bytes.byteLength)} bytes, above the writable limit`, isError: true }
      }
      const hash = createHash('sha256').update(bytes).digest('hex')
      await workspaces.putBlob(request, workspaceId, hash, bytes)
      const { revision } = workspaces.revision(request, workspaceId)
      await workspaces.commit(request, {
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        workspaceId,
        operationId: randomUUID(),
        baseRevision: revision,
        changes: [{ path, kind: 'file', hash, bytes: bytes.byteLength, mode: 0o644 }],
      })
      return { text: `wrote ${path} (${String(bytes.byteLength)} bytes)` }
    } catch (error) {
      if (error instanceof DurableTurnError) throw error
      return { text: `tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`, isError: true }
    }
  }
  const durableTurnTimeoutMs = timeoutMs(options.durableTurnTimeoutMs === undefined
    ? (options.llmTimeoutMs ?? 120_000) : options.durableTurnTimeoutMs, 'durableTurnTimeoutMs')
  const durableApprovalTimeoutMs = timeoutMs(options.durableApprovalTimeoutMs ?? 60_000, 'durableApprovalTimeoutMs')
  const requestTimeoutMs = timeoutMs(options.requestTimeoutMs ?? 30_000, 'requestTimeoutMs')
  const headersTimeoutMs = timeoutMs(options.headersTimeoutMs ?? 15_000, 'headersTimeoutMs')
  const keepAliveTimeoutMs = timeoutMs(options.keepAliveTimeoutMs ?? 5_000, 'keepAliveTimeoutMs')
  const maxConnections = timeoutMs(options.maxConnections ?? 128, 'maxConnections')
  const maxConcurrentRequests = timeoutMs(options.maxConcurrentRequests ?? 64, 'maxConcurrentRequests')
  const connectionsCheckingIntervalMs = timeoutMs(options.connectionsCheckingIntervalMs ?? 1_000, 'connectionsCheckingIntervalMs')
  let activeRequests = 0
  let servedOrigin
  let servedPreviewOrigin
  let servedApiOrigin
  if (options.apiPort !== undefined && (!Number.isInteger(options.apiPort) || options.apiPort < 0 || options.apiPort > 65_535)) {
    throw new Error('apiPort must be a TCP port')
  }
  const apiPort = options.apiPort
  const splitApi = apiPort !== undefined
  const startedAt = Date.now()
  const metrics = createMetricsRegistry()
  const usageAudit = []
  const observabilityJournal = createObservabilityJournal({ dataDir: options.dataDir })
  const observabilityRestore = await observabilityJournal.restore()
  accessAuditEntries.push(...observabilityRestore.accessDenials)
  if (accessAuditEntries.length > ACCESS_AUDIT_LIMIT) {
    accessAuditEntries.splice(0, accessAuditEntries.length - ACCESS_AUDIT_LIMIT)
  }
  collaborationAuditEntries.push(...observabilityRestore.collaboration)
  if (collaborationAuditEntries.length > ACCESS_AUDIT_LIMIT) {
    collaborationAuditEntries.splice(0, collaborationAuditEntries.length - ACCESS_AUDIT_LIMIT)
  }
  usageAudit.push(...observabilityRestore.usage)
  const durableHost = createDurableTurnHost({
    store,
    admission,
    model: llm.model,
    originOf: () => servedOrigin,
    authToken,
    timeoutMs: durableTurnTimeoutMs,
    approvalTimeoutMs: durableApprovalTimeoutMs,
    requiresApproval: call => call.name === 'write',
    tools: DURABLE_TOOL_DEFINITIONS,
    executeTool: executeDurableTool,
    journalPath: join(options.dataDir, 'durable-runs.json'),
  })
  const durableRecovery = await durableHost.recover()
  const metricsView = () => metrics.snapshot({
    startedAt,
    activeRequests,
    admission: admission === undefined ? undefined : admission.snapshot(),
    leases: store.leaseSnapshot(),
    durable: durableHost.snapshot(),
  })
  const metricsSnapshotTimer = setInterval(() => {
    void observabilityJournal.persistMetrics(metricsView())
  }, 10_000)
  metricsSnapshotTimer.unref()
  const alertEvaluator = createAlertEvaluator({
    config: options.alerts,
    pricing: usagePricing,
    usage: () => usageAudit,
    queue: () => admission === undefined ? undefined : admission.snapshot(),
    now: options.testHooks?.now,
  })
  alertEvaluator.start()
  const observabilityReconciliation = {
    processStartedAt: new Date(startedAt).toISOString(),
    recoveredTurns: durableRecovery.recovered,
    durableJournalHealthy: durableRecovery.journalHealthy,
    restored: {
      accessDenials: observabilityRestore.accessDenials.length,
      usageEntries: observabilityRestore.usage.length,
      truncated: observabilityRestore.truncated,
      invalidLines: observabilityRestore.invalidLines,
      integrity: observabilityRestore.integrity,
      ...(observabilityRestore.metricsError === undefined ? {} : { metricsError: observabilityRestore.metricsError }),
    },
    previousProcess: observabilityRestore.metrics ?? null,
  }

  /**
   * Usage entries still inside the retention window. Reads use this even when
   * the sweep has not run, so elapsed data cannot be read back.
   * @returns Retained usage entries.
   */
  const retainedUsage = () => retentionMs === 0
    ? usageAudit
    : usageAudit.filter(entry => !recordExpired(entry, retentionClock() - retentionMs))

  let lastRetentionSweep = {
    at: retentionClock(),
    cutoff: retentionMs === 0 ? undefined : retentionClock() - retentionMs,
    sessions: [],
    usageEntries: 0,
    journal: { accessDenials: 0, usage: 0 },
  }

  /**
   * Purge Sessions, usage entries, and observability records past the window.
   * @returns Sweep summary with the removed Session ids and record counts.
   */
  const sweepRetention = async () => {
    if (retentionMs === 0) return lastRetentionSweep
    const cutoff = retentionClock() - retentionMs
    const sessions = await store.purgeExpired()
    const retained = usageAudit.filter(entry => !recordExpired(entry, cutoff))
    const usageEntries = usageAudit.length - retained.length
    usageAudit.splice(0, usageAudit.length, ...retained)
    const journal = await observabilityJournal.redact(record => recordExpired(record, cutoff))
    lastRetentionSweep = { at: retentionClock(), cutoff, sessions, usageEntries, journal }
    return lastRetentionSweep
  }
  const retentionTimer = retentionMs === 0 ? undefined : setInterval(() => {
    void sweepRetention().catch(error => {
      process.stderr.write(`browser-native backend: retention sweep failed: ${String(error)}\n`)
    })
  }, retentionSweepMs)
  retentionTimer?.unref()

  /**
   * Serialize a Session and the attachments its log references from one Workspace.
   * @param session - Stored Session record.
   * @param workspaceId - Workspace that owns the attachment objects.
   * @returns {Promise<object>} Portable bundle ready to send as JSON.
   */
  const buildSessionBundle = async (session, workspaceId) => {
    const references = bundleAttachmentReferences(session.events)
    const attachments = []
    for (const [hash, reference] of references) {
      const path = attachmentPath(options.dataDir, workspaceId, hash)
      const bytes = await verifyAttachmentObject(path, hash)
      if (bytes === undefined) {
        throw new BackendError('ATTACHMENT_MISSING', `Session references attachment ${reference.attachmentId} but the Workspace does not store it`, 409)
      }
      attachments.push({
        attachmentId: reference.attachmentId,
        ...(reference.name === undefined ? {} : { name: reference.name }),
        bytes,
        data: (await readFile(path)).toString('base64'),
      })
    }
    return {
      format: SESSION_BUNDLE_FORMAT,
      formatVersion: SESSION_BUNDLE_VERSION,
      sessionFormatVersion: SESSION_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      workspaceId,
      session: {
        id: session.id,
        header: session.header,
        inheritedEventCount: session.inheritedEventCount,
        events: session.events,
        durableThroughSeq: session.durableThroughSeq,
      },
      attachments,
    }
  }

  const writeBundleAttachment = async (workspaceId, attachment) => await publishAttachment(workspaceId, async () => {
    const directoryPath = join(options.dataDir, 'attachments-v1', workspaceId, attachment.hash.slice(0, 2))
    await mkdir(directoryPath, { recursive: true, mode: 0o700 })
    const target = attachmentPath(options.dataDir, workspaceId, attachment.hash)
    if (await verifyAttachmentObject(target, attachment.hash) !== undefined) return
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, attachment.data, { mode: 0o600 })
    await rename(temporary, target)
  })

  /**
   * Validate a bundle, then create the Session and publish its attachments.
   *
   * Validation completes before any write. A duplicate id or a failed flush
   * removes the in-memory Session, so a rejected import leaves no partial
   * Session; content-addressed attachments may remain for later garbage
   * collection because they are unreferenced.
   * @param bundle - Untrusted request payload.
   * @param workspaceId - Target Workspace that receives attachments.
   * @param principalId - Principal recorded as the Session owner.
   * @returns {Promise<object>} Session response with import counts.
   */
  const importSessionBundle = async (bundle, workspaceId, principalId) => {
    const validated = assertSessionBundle(bundle)
    return await store.exclusive(validated.header.id, async () => {
      admission?.mountSession(validated.header.id)
      let session
      try {
        session = store.create(validated.header.id, validated.header, validated.inheritedEventCount, principalId)
        for (const attachment of validated.attachments) await writeBundleAttachment(workspaceId, attachment)
        session.events.push(...validated.events)
        session.durableThroughSeq = validated.durableThroughSeq
        const durabilityReceipt = await store.flush(session)
        return sessionResponse(session, {
          imported: true,
          eventCount: session.events.length,
          attachmentCount: validated.attachmentCount,
          durabilityReceipt,
        })
      } catch (error) {
        if (session !== undefined) store.sessions.delete(session.id)
        admission?.releaseMount(validated.header.id)
        throw error
      }
    })
  }

  const assertProcessAuth = (request, url, internal) => {
    if (!requireLocalAuth || internal) return
    // CORS preflights never carry credentials; the actual request is checked.
    if (request.method === 'OPTIONS' && typeof request.headers['access-control-request-method'] === 'string') return
    const gated = url.pathname.startsWith('/api/browser-native/') || url.pathname === '/preview-api-origin'
    if (!gated) return
    const provided = request.headers[AUTH_TOKEN_HEADER] ?? requestCookie(request.headers.cookie, AUTH_COOKIE_NAME)
    if (typeof provided !== 'string' || provided.length !== authToken.length
      || !timingSafeEqual(Buffer.from(provided), Buffer.from(authToken))) {
      throw new BackendError('AUTH_REQUIRED', 'local process authentication is required', 401)
    }
  }
  const branchReceipts = new Map()
  const createReceipts = new Map()
  const handleRequest = async (role, request, response) => {
    let url
    activeRequests += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      activeRequests -= 1
    }
    response.on('close', release)
    const requestStartedAt = Date.now()
    let routeLabel = 'unmatched'
    let metricRecorded = false
    const recordRequestMetric = () => {
      if (metricRecorded) return
      metricRecorded = true
      metrics.recordRequest({
        route: routeLabel,
        method: request.method ?? 'GET',
        status: response.statusCode,
        durationMs: Date.now() - requestStartedAt,
        aborted: !response.writableFinished,
      })
      alertEvaluator.recordRequest({
        status: response.statusCode,
        aborted: !response.writableFinished,
      })
    }
    response.on('finish', recordRequestMetric)
    response.on('close', recordRequestMetric)
    for (const [name, value] of Object.entries(responseHeaders)) response.setHeader(name, value)
    try {
      if (activeRequests > maxConcurrentRequests) {
        release()
        metrics.recordFailure({ code: 'SERVER_BUSY' })
        sendJson(response, 503, {
          error: { code: 'SERVER_BUSY', message: `the backend already handles ${String(maxConcurrentRequests)} concurrent requests` },
        }, { 'retry-after': '1' })
        return
      }
      url = new URL(request.url ?? '/', 'http://browser-native.invalid')
      routeLabel = metricRoute(url.pathname)
      if (url.pathname.startsWith('/api/browser-native/')) {
        // Refuse cross-origin embedding (img/script/link) so a foreign page
        // cannot observe an API response even when the request guard is bypassed.
        response.setHeader('cross-origin-resource-policy', 'same-origin')
        response.setHeader('referrer-policy', 'no-referrer')
      }
      const internalStateRequest = sharedStateToken !== undefined
        && request.headers['x-browser-native-state-token'] === sharedStateToken
      const apiOrigin = servedApiOrigin
      const previewOrigin = servedPreviewOrigin
      const allowedOrigins = role === 'api' && apiOrigin !== undefined && previewOrigin !== undefined
        ? new Set([previewOrigin]) : undefined
      assertLocalRequest(request, url, internalStateRequest, allowedOrigins, publicOrigin)
      assertProcessAuth(request, url, internalStateRequest)
      if (role === 'api') {
        const requestedOrigin = request.headers.origin
        if (typeof requestedOrigin === 'string' && previewOrigin !== undefined && requestedOrigin === previewOrigin) {
          response.setHeader('access-control-allow-origin', requestedOrigin)
          response.setHeader('access-control-allow-credentials', 'true')
          response.setHeader('vary', 'origin')
          if (request.method === 'OPTIONS') {
            response.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
            response.setHeader('access-control-allow-headers',
              request.headers['access-control-request-headers'] ?? 'content-type, x-browser-native-protocol, x-browser-native-identity-mode')
            response.setHeader('access-control-max-age', '600')
            response.writeHead(204)
            response.end()
            return
          }
        }
      }
      if (splitApi && role === 'api' && !url.pathname.startsWith('/api/browser-native/')) {
        throw new BackendError('NOT_FOUND', 'route not found', 404)
      }
      if (splitApi && role === 'preview' && url.pathname.startsWith('/api/browser-native/')) {
        throw new BackendError('NOT_FOUND', 'route not found', 404)
      }
      if (sharedStateOrigin !== undefined && !internalStateRequest && isSharedStatePath(url.pathname)) {
        await proxySharedStateRequest(request, response, sharedStateOrigin, sharedStateToken)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/health') {
        sendJson(response, 200, {
          ok: true,
          llmMode: llm.mode,
          model: llm.model,
          ...(llm.kind === undefined ? {} : { providerKind: llm.kind }),
          ...(llm.timeoutMs === undefined ? {} : { llmTimeoutMs: llm.timeoutMs }),
        })
        return
      }
      const mcpMatch = url.pathname.match(/^\/api\/browser-native\/mcp\/([A-Za-z0-9._-]{1,64})$/)
      if (mcpMatch !== null) {
        if (request.method !== 'POST' && request.method !== 'GET' && request.method !== 'DELETE') {
          throw new BackendError('METHOD_NOT_ALLOWED', 'MCP proxy accepts POST, GET and DELETE', 405)
        }
        const serverConfig = mcpServers[mcpMatch[1]]
        if (serverConfig === undefined) {
          throw new BackendError('MCP_SERVER_UNKNOWN', `no MCP server is configured under "${mcpMatch[1]}"`, 404)
        }
        const body = request.method === 'POST' ? await readBody(request) : undefined
        const controller = new AbortController()
        response.on('close', () => {
          if (!response.writableFinished) controller.abort()
        })
        let upstream
        try {
          upstream = await fetch(serverConfig.url, {
            method: request.method,
            headers: {
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
              accept: typeof request.headers.accept === 'string'
                ? request.headers.accept : 'application/json, text/event-stream',
              ...(typeof request.headers['mcp-session-id'] === 'string'
                ? { 'mcp-session-id': request.headers['mcp-session-id'] } : {}),
              ...(typeof request.headers['mcp-protocol-version'] === 'string'
                ? { 'mcp-protocol-version': request.headers['mcp-protocol-version'] } : {}),
              ...(typeof request.headers['last-event-id'] === 'string'
                ? { 'last-event-id': request.headers['last-event-id'] } : {}),
              ...(serverConfig.headers ?? {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'error',
            signal: controller.signal,
          })
        } catch {
          if (controller.signal.aborted) return
          throw new BackendError('MCP_UPSTREAM_UNAVAILABLE', `MCP upstream "${mcpMatch[1]}" is unreachable`, 502)
        }
        const forwardedHeaders = {}
        for (const name of ['content-type', 'mcp-session-id', 'cache-control', 'retry-after', 'www-authenticate', 'last-event-id']) {
          const value = upstream.headers.get(name)
          if (value !== null) forwardedHeaders[name] = value
        }
        if (forwardedHeaders['content-type'] === undefined) {
          forwardedHeaders['content-type'] = 'application/json; charset=utf-8'
        }
        response.writeHead(upstream.status, forwardedHeaders)
        if (upstream.body === null) {
          response.end()
          return
        }
        try {
          await pipeline(Readable.fromWeb(upstream.body), response)
        } catch (error) {
          if (!response.destroyed) response.destroy(error)
        }
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/config') {
        sendJson(response, 200, {
          llmMode: llm.mode,
          provider: llm.provider,
          model: llm.model,
          ...(llm.kind === undefined ? {} : { providerKind: llm.kind }),
          ...(llm.contextWindow === undefined ? {} : { contextWindow: llm.contextWindow }),
          ...(llm.fallback === undefined ? {} : {
            fallbackProvider: llm.fallback.provider,
            fallbackModel: llm.fallback.model,
            fallbackProviderKind: llm.fallback.kind,
          }),
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/session/budget') {
        if (llm.mode !== 'real') {
          sendJson(response, 404, { error: 'budget usage is available only in real-LLM mode' })
          return
        }
        if (budgetLimits === undefined) {
          sendJson(response, 200, { configured: false, sessionId: null, tenantId: null })
          return
        }
        const sessionId = assertSessionId(url.searchParams.get('sessionId'))
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        store.getForPrincipal(sessionId, principalId)
        sendJson(response, 200, buildBudgetSnapshot(retainedUsage(), {
          sessionId,
          principalId,
          limits: budgetLimits,
          pricing: usagePricing,
        }))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/usage-audit') {
        if (llm.mode !== 'real') {
          sendJson(response, 404, { error: 'usage audit is available only in real-LLM mode' })
          return
        }
        const sessionId = url.searchParams.get('sessionId')
        const entries = retainedUsage()
        sendJson(response, 200, {
          entries: sessionId === null ? entries : entries.filter(entry => entry.sessionId === sessionId),
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/session/turn-retry') {
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const body = await readBody(request)
        const sessionId = assertSessionId(body.sessionId)
        const turn = body.turn
        if (!Number.isSafeInteger(turn) || turn < 1) {
          throw new BackendError('INVALID_REQUEST', 'turn retry requires a positive integer turn')
        }
        let session
        try {
          session = store.getForPrincipal(sessionId, principalId)
        } catch (error) {
          const role = sessionShares.roleOf(sessionId, principalId)
          if (role !== undefined) {
            throw new BackendError('SESSION_READ_ONLY', 'a shared Session cannot be retried by its viewer', 403)
          }
          throw error
        }
        const retryable = latestRetryableTurn(session)
        if (retryable === undefined || retryable.turn !== turn) {
          throw new BackendError('TURN_RETRY_INVALID', 'turn retry requires the latest turn to have failed or been interrupted', 400, undefined, {
            sessionId, turn, reason: retryable?.reason, code: retryable?.code,
          })
        }
        const terminal = session.events.findLast(event => event.type === 'turn/end')
        const userMessage = session.events.slice(0, terminal.seq).findLast(event => event.type === 'user/message')
        const prompt = promptText(userMessage?.data.content ?? userMessage?.data.message?.content)
        if (prompt === undefined) {
          throw new BackendError('TURN_RETRY_INVALID', 'turn retry requires the original user prompt', 400)
        }
        const outcome = await turnRetries.request({ sessionId, turn, prompt })
        sendJson(response, 200, {
          ok: true,
          created: outcome.created,
          retry: turnRetryResponse(outcome.record),
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/session/turn-retry/settle') {
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const body = await readBody(request)
        const retryId = body.retryId
        if (typeof retryId !== 'string' || retryId.length === 0) {
          throw new BackendError('INVALID_REQUEST', 'retryId is required')
        }
        const record = await turnRetries.get({ retryId })
        if (record === undefined) throw new BackendError('TURN_RETRY_UNKNOWN', 'retry intent is unknown', 404)
        store.getForPrincipal(record.sessionId, principalId)
        const outcome = await turnRetries.settle({ retryId })
        sendJson(response, 200, { ok: true, settled: outcome.settled, retry: turnRetryResponse(outcome.record) })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/session/trace') {
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const sessionId = url.searchParams.get('sessionId')
        if (sessionId === null) throw new BackendError('INVALID_REQUEST', 'sessionId is required')
        const session = store.getForPrincipal(sessionId, principalId)
        sendJson(response, 200, buildTraceReport(store, retainedUsage(), {
          pricing: usagePricing,
          model: llm.model,
          now: retentionClock(),
          accessDenials: accessAuditEntries,
        }, session))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/session/turn-retry') {
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const sessionId = url.searchParams.get('sessionId')
        if (sessionId === null) throw new BackendError('INVALID_REQUEST', 'sessionId is required')
        const session = store.getForPrincipal(sessionId, principalId)
        const retryable = latestRetryableTurn(session)
        sendJson(response, 200, {
          ...(retryable === undefined ? {} : { retryable }),
          retries: (await turnRetries.list({ sessionId })).map(turnRetryResponse),
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/retention') {
        sendJson(response, 200, {
          retentionDays,
          sweepIntervalMs: retentionSweepMs,
          lastSweep: lastRetentionSweep,
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/workspace/principal-export') {
        const principalId = workspaces.principalFromRequest(request)
        const sessions = [...store.sessions.values()]
          .filter(session => session.principalId === principalId && !store.isExpired(session))
          .map(session => store.recordFor(session))
        const usage = retainedUsage().filter(entry => entry.principalId === principalId)
        const bundle = await buildPrincipalExport({
          dataDir: options.dataDir,
          principalId,
          workspaceId: workspaces.workspaceIdForPrincipal(principalId),
          sessions,
          usage,
          accessDenials: accessAuditEntries,
          pricing: usagePricing,
          model: llm.model,
          now: retentionClock,
        })
        verifyPrincipalExport(bundle)
        sendJson(response, 200, bundle)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/usage-report') {
        const format = url.searchParams.get('format') ?? 'json'
        if (format !== 'json' && format !== 'csv') throw new BackendError('INVALID_REQUEST', 'format must be json or csv')
        const report = buildUsageReport(retainedUsage(), { pricing: usagePricing, model: llm.model })
        if (format === 'csv') {
          const filename = `usage-report-${report.generatedAt.slice(0, 10)}.csv`
          response.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${filename}"`,
            'cache-control': 'no-store',
          })
          response.end(usageReportCsv(report))
          return
        }
        sendJson(response, 200, report)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/session/support-bundle') {
        const sessionId = assertSessionId(url.searchParams.get('sessionId') ?? '')
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const events = []
        let offset = 0
        let durableThroughSeq = -1
        for (;;) {
          const page = await sessionOperation(
            store, 'read',
            { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), sessionId, offset, length: MAX_SESSION_READ_EVENTS },
            principalId, sessionShares,
          )
          events.push(...page.events)
          durableThroughSeq = page.durableThroughSeq
          if (!page.hasMore || page.events.length === 0) break
          offset += page.events.length
        }
        const usage = supportBundleUsageSummary(retainedUsage(), sessionId)
        const accessDenials = accessAuditEntries
          .filter(entry => entry.resourceId === sessionId)
          .map(entry => ({ method: entry.method, route: entry.route, code: entry.code, status: entry.status }))
        sendJson(response, 200, {
          format: 'dsh-browser-native-support-bundle-v1',
          formatVersion: 1,
          generatedAt: new Date().toISOString(),
          environment: {
            node: process.version,
            platform: process.platform,
            protocolVersion: PROTOCOL_VERSION,
            sessionFormatVersion: SESSION_FORMAT_VERSION,
            llmMode: llm.mode,
            provider: llm.provider,
            model: llm.model,
            ...(llm.fallback === undefined ? {} : { fallbackProvider: llm.fallback.provider, fallbackModel: llm.fallback.model }),
          },
          state: {
            leases: store.leaseSnapshot(),
            observability: metricsView(),
          },
          session: {
            sessionId,
            ...supportBundleEventSummary(events),
            durableThroughSeq,
          },
          logs: [
            ...usage.log,
            ...diagnosticLog.filter(entry => entry.sessionId === sessionId),
            ...accessDenials.map(entry => ({ kind: 'access-denial', ...entry })),
            ...collaborationAudit().filter(entry => entry.sessionId === sessionId).map(entry => ({ kind: 'collaboration', ...entry })),
          ].slice(-100),
          audit: {
            usage: { providers: usage.providers, totals: usage.totals },
            accessDenials,
            collaboration: collaborationAudit().filter(entry => entry.sessionId === sessionId),
          },
        }, {
          'content-disposition': `attachment; filename="dsh-support-bundle-${sessionId}.json"`,
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/auth/exchange') {
        const principalId = workspaces.hostedPrincipalFor(request)
        if (principalId === undefined) {
          throw new WorkspaceError('UNAUTHENTICATED', 'token exchange requires a Bearer token', 401)
        }
        const identity = await workspaces.bindHostedPrincipal(principalId, request.socket.encrypted === true)
        sendJson(response, 200, {
          principalId,
          workspaceId: identity.workspaceId,
          workspaceIds: identity.workspaceIds,
        }, { 'set-cookie': identity.cookies })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/workspace/identity') {
        if (request.headers['x-browser-native-identity-mode'] === 'existing') {
          sendJson(response, 200, workspaces.lookupIdentity(request))
          return
        }
        const identity = await workspaces.openIdentity(request, request.socket.encrypted === true)
        sendJson(response, 200, { workspaceId: identity.workspaceId, workspaceIds: identity.workspaceIds }, { 'set-cookie': identity.cookies })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/workspace/list') {
        sendJson(response, 200, workspaces.listWorkspaces(request))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/workspace/create') {
        const body = await readBody(request)
        assertProtocol(body)
        sendJson(response, 200, await workspaces.createWorkspace(request, body.requestId))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/workspace/select') {
        const body = await readBody(request)
        assertProtocol(body)
        sendJson(response, 200, await workspaces.selectWorkspace(request, body.workspaceId))
        return
      }
      const attachmentMatch = url.pathname.match(/^\/api\/browser-native\/workspace\/attachments\/([a-f0-9]{64})$/)
      if (attachmentMatch !== null && (request.method === 'PUT' || request.method === 'GET')) {
        const workspaceId = url.searchParams.get('workspaceId')
        const principalId = workspaces.principalFromRequest(request)
        workspaces.requireWorkspace(principalId, workspaceId)
        const hash = attachmentMatch[1]
        if (request.method === 'PUT') {
          const contentType = request.headers['content-type']
          if (contentType !== 'application/octet-stream') {
            throw new BackendError('INVALID_REQUEST', 'attachment uploads require application/octet-stream')
          }
          const name = attachmentName(url.searchParams.get('name') ?? undefined)
          if (options.testHooks?.failAttachmentUpload?.({ workspaceId, hash, name }) === true) {
            throw new BackendError('ATTACHMENT_UPLOAD_UNAVAILABLE', 'E2E injected attachment upload failure', 503)
          }
          const stored = await storeAttachmentObject(
            request,
            options.dataDir,
            workspaceId,
            hash,
            attachmentMaxBytes,
            options.testHooks?.onAttachmentStage,
            options.testHooks?.onAttachmentChunk,
            operation => publishAttachment(workspaceId, operation),
          )
          await options.testHooks?.beforeAttachmentReceipt?.({ workspaceId, hash, name, stored })
          if (response.destroyed) {
            options.testHooks?.onAttachmentStage?.('response-abandoned')
            return
          }
          if (options.testHooks?.dropAttachmentUploadResponse?.({ workspaceId, hash, name, stored }) === true) {
            response.writeHead(200, { 'content-type': 'application/json', 'content-length': '256' })
            response.write('{"attachmentId":')
            await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
            request.socket.destroy()
            return
          }
          sendJson(response, 200, {
            attachmentId: `sha256:${hash}`,
            name,
            bytes: stored.bytes,
            reused: stored.reused,
          })
          options.testHooks?.onAttachmentStage?.('receipt-sent')
          return
        }
        await streamAttachmentObject(request, response, options.dataDir, workspaceId, hash)
        return
      }
      const attachmentUploadBegin = url.pathname.match(/^\/api\/browser-native\/workspace\/attachments\/([a-f0-9]{64})\/uploads$/)
      if (request.method === 'POST' && attachmentUploadBegin !== null) {
        const workspaceId = url.searchParams.get('workspaceId')
        const principalId = workspaces.principalFromRequest(request)
        workspaces.requireWorkspace(principalId, workspaceId)
        const hash = attachmentUploadBegin[1]
        const name = attachmentName(url.searchParams.get('name') ?? undefined)
        const body = await readBody(request)
        if (!Number.isSafeInteger(body.bytes)) {
          throw new BackendError('INVALID_REQUEST', 'chunked attachment uploads require an integer bytes field')
        }
        sendJson(response, 200, { name, ...await beginAttachmentUpload(
          options.dataDir, workspaceId, hash, name, body.bytes, attachmentMaxBytes,
        ) })
        return
      }
      const attachmentUploadOperation = url.pathname.match(
        /^\/api\/browser-native\/workspace\/attachments\/([a-f0-9]{64})\/uploads\/([0-9a-f-]{36})(?:\/(chunks\/([0-9]+)|commit))?$/i)
      if (attachmentUploadOperation !== null) {
        const workspaceId = url.searchParams.get('workspaceId')
        const principalId = workspaces.principalFromRequest(request)
        workspaces.requireWorkspace(principalId, workspaceId)
        const [, hash, uploadId, action, offsetText] = attachmentUploadOperation
        if (!ATTACHMENT_UPLOAD_ID_PATTERN.test(uploadId)) throw new BackendError('INVALID_REQUEST', 'upload id is invalid')
        if (action !== undefined && action.startsWith('chunks/')) {
          if (request.method !== 'PUT') throw new BackendError('NOT_FOUND', 'route not found', 404)
          if (request.headers['content-type'] !== 'application/octet-stream') {
            throw new BackendError('INVALID_REQUEST', 'attachment chunks require application/octet-stream')
          }
          let body
          try {
            body = await readRawBody(request, MAX_ATTACHMENT_CHUNK_BYTES)
          } catch (error) {
            if (typeof error?.code !== 'string' || error.code !== 'REQUEST_TOO_LARGE') throw error
            throw new BackendError('ATTACHMENT_TOO_LARGE', `attachment chunks must not exceed ${String(MAX_ATTACHMENT_CHUNK_BYTES)} bytes`, 413)
          }
          const offset = Number(offsetText)
          if (!Number.isSafeInteger(offset) || offset < 0) throw new BackendError('INVALID_REQUEST', 'chunk offset is invalid')
          const appended = await withKeyedLock(attachmentUploadLocks, uploadId, async () =>
            await appendAttachmentUploadChunk(options.dataDir, workspaceId, uploadId, hash, offset, body, attachmentMaxBytes))
          await options.testHooks?.onAttachmentUploadChunk?.({
            workspaceId, hash, uploadId, offset, received: appended.received,
          })
          sendJson(response, 200, appended)
          return
        }
        if (action === 'commit') {
          if (request.method !== 'POST') throw new BackendError('NOT_FOUND', 'route not found', 404)
          await readBody(request)
          const committed = await withKeyedLock(attachmentUploadLocks, uploadId, async () => {
            const meta = await readAttachmentUploadMeta(options.dataDir, workspaceId, uploadId)
            return {
              meta,
              stored: await commitAttachmentUpload(options.dataDir, workspaceId, uploadId, hash,
                operation => publishAttachment(workspaceId, operation)),
            }
          })
          sendJson(response, 200, {
            attachmentId: `sha256:${committed.meta.hash}`,
            name: committed.meta.name,
            bytes: committed.stored.bytes,
            reused: committed.stored.reused,
          })
          return
        }
        if (request.method === 'DELETE') {
          sendJson(response, 200, await withKeyedLock(attachmentUploadLocks, uploadId, async () =>
            await abortAttachmentUpload(options.dataDir, workspaceId, uploadId)))
          return
        }
        throw new BackendError('NOT_FOUND', 'route not found', 404)
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/workspace/attachments/gc-token') {
        const workspaceId = url.searchParams.get('workspaceId')
        const principalId = workspaces.principalFromRequest(request)
        workspaces.requireWorkspace(principalId, workspaceId)
        sendJson(response, 200, {
          token: attachmentGcToken(workspaceId),
          generation: attachmentGenerationFor(workspaceId),
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/workspace/attachments/gc') {
        const body = await readBody(request)
        assertProtocol(body)
        const workspaceId = boundedString(body.workspaceId, 'workspaceId', MAX_CHECKPOINT_ID_LENGTH)
        const token = boundedString(body.token, 'token', MAX_HANDOFF_ID_LENGTH)
        const principalId = workspaces.principalFromRequest(request)
        workspaces.requireWorkspace(principalId, workspaceId)
        const issued = parseAttachmentGcToken(token)
        if (issued === undefined || issued.instance !== attachmentGcInstance
          || issued.generation !== attachmentGenerationFor(workspaceId)) {
          sendJson(response, 200, staleAttachmentGc(workspaceId))
          return
        }
        sendJson(response, 200, await collectAttachments(workspaceId, issued.generation, store.sessions.values()))
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
        if (url.searchParams.has('limit') || url.searchParams.has('offset')) {
          const offset = url.searchParams.get('offset') ?? '0'
          const limit = url.searchParams.get('limit') ?? '1000'
          sendJson(response, 200, workspaces.manifestPage(
            request,
            url.searchParams.get('workspaceId'),
            Number(offset),
            Number(limit),
          ))
          return
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
      if (request.method === 'POST' && url.pathname === '/api/browser-native/workspace/blob-batch') {
        const body = await readBody(request)
        assertProtocol(body)
        sendJson(response, 200, await workspaces.getBlobs(request, body.workspaceId, body.hashes))
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
        const result = await workspaces.commit(request, body)
        if (options.testHooks?.dropWorkspaceCommitResponse?.(body, result) === true) {
          response.destroy()
          return
        }
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/internal/session/authorize-llm') {
        if (!internalStateRequest) throw new BackendError('NOT_FOUND', 'route not found', 404)
        const body = await readBody(request)
        assertProtocol(body)
        const session = store.get(body.sessionId)
        store.assertOwner(session, body.ownerToken, body.ownerEpoch)
        sendJson(response, 200, { authorized: true, ownerEpoch: session.ownerEpoch })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/session/durable') {
        const body = await readBody(request)
        assertProtocol(body)
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const sessionId = assertSessionId(body.sessionId)
        const turnId = boundedString(body.turnId, 'turnId', MAX_HANDOFF_ID_LENGTH)
        const prompt = boundedString(body.prompt, 'prompt', 10_000)
        const header = body.header === undefined
          ? { id: sessionId, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), cwd: '/workspace' }
          : assertRecord(body.header, 'header')
        const durable = await durableHost.start({ sessionId, principalId, turnId, prompt, header })
        sendJson(response, durable.replayed === true ? 200 : 202, durable)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/session/durable') {
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const turnId = boundedString(url.searchParams.get('turnId') ?? undefined, 'turnId', MAX_HANDOFF_ID_LENGTH)
        sendJson(response, 200, durableHost.status({ turnId, principalId }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/session/durable/stop') {
        const body = await readBody(request)
        assertProtocol(body)
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const turnId = boundedString(body.turnId, 'turnId', MAX_HANDOFF_ID_LENGTH)
        const cancelRequested = durableHost.cancel({ turnId, principalId })
        sendJson(response, 202, { protocolVersion: PROTOCOL_VERSION, ...cancelRequested })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/session/durable/approve') {
        const body = await readBody(request)
        assertProtocol(body)
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const turnId = boundedString(body.turnId, 'turnId', MAX_HANDOFF_ID_LENGTH)
        const approvalId = boundedString(body.approvalId, 'approvalId', MAX_HANDOFF_ID_LENGTH)
        const decision = boundedString(body.decision, 'decision', 16)
        const decided = durableHost.decide({ turnId, principalId, approvalId, decision })
        sendJson(response, 202, { protocolVersion: PROTOCOL_VERSION, ...decided })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/session/durable/stream') {
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const turnId = boundedString(url.searchParams.get('turnId') ?? undefined, 'turnId', MAX_HANDOFF_ID_LENGTH)
        const fromSeqParam = url.searchParams.get('fromSeq')
        const fromSeq = fromSeqParam === null ? 0 : boundedInteger(Number(fromSeqParam), 'fromSeq', 1_000_000)
        const abort = new AbortController()
        response.on('close', () => abort.abort())
        const subscription = durableHost.subscribe({ turnId, principalId, fromSeq, signal: abort.signal })
        response.writeHead(200, {
          'content-type': 'application/x-ndjson',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        })
        while (!abort.signal.aborted && !response.writableEnded) {
          const event = await subscription.next()
          if (event === undefined) break
          response.write(`${JSON.stringify({ kind: 'event', ...event })}\n`)
        }
        if (!abort.signal.aborted && !response.writableEnded) {
          response.write(`${JSON.stringify({ kind: 'settled', ...subscription.status() })}\n`)
          response.end()
        }
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/session/events') {
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const sessionId = assertSessionId(url.searchParams.get('sessionId') ?? undefined)
        const fromSeqParam = url.searchParams.get('fromSeq')
        const fromSeq = fromSeqParam === null ? 0 : boundedInteger(Number(fromSeqParam), 'fromSeq', MAX_EVENTS)
        const subscription = sessionEvents.subscribe(sessionId)
        let snapshot
        try {
          snapshot = await store.exclusive(sessionId, async () => {
            let session
            let sharedRole
            try {
              session = store.getForPrincipal(sessionId, principalId)
            } catch (error) {
              sharedRole = error?.code === 'SESSION_NOT_FOUND' ? sessionShares.roleOf(sessionId, principalId) : undefined
              if (sharedRole === undefined) throw error
              session = store.get(sessionId)
            }
            if (fromSeq > session.events.length) throw new BackendError('INVALID_REQUEST', 'fromSeq is beyond the Session log')
            return { events: clone(session.events.slice(fromSeq)), role: sharedRole ?? 'owner' }
          })
        } catch (error) {
          subscription.close()
          throw error
        }
        const abort = new AbortController()
        response.on('close', () => abort.abort())
        response.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        })
        let nextSeq = fromSeq + snapshot.events.length
        response.write(`${JSON.stringify({
          kind: 'ready',
          sessionId,
          role: snapshot.role,
          nextSeq,
        })}\n`)
        for (const event of snapshot.events) response.write(`${JSON.stringify({ kind: 'event', event })}\n`)
        try {
          while (!abort.signal.aborted && !response.writableEnded) {
            const batch = await subscription.next()
            if (batch === undefined) break
            for (const event of batch) {
              if (event.seq < nextSeq) continue
              response.write(`${JSON.stringify({ kind: 'event', event })}\n`)
              nextSeq = event.seq + 1
            }
          }
        } finally {
          subscription.close()
        }
        response.end()
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/session/transfer') {
        const body = await readBody(request)
        assertProtocol(body)
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const sessionId = assertSessionId(body.sessionId)
        const toPrincipalId = assertPrincipalId(body.toPrincipalId)
        if (!workspaces.identities.has(toPrincipalId)) {
          throw new BackendError('PRINCIPAL_NOT_FOUND', 'the target principal does not exist', 404)
        }
        const result = await store.exclusive(sessionId, async () => {
          const session = store.getForPrincipal(sessionId, principalId)
          if (!sessionShares.isViewer(sessionId, toPrincipalId)) {
            throw new BackendError('SHARE_REQUIRED', 'the target principal has no viewer grant for this Session', 409)
          }
          if (session.principalId === toPrincipalId) {
            throw new BackendError('INVALID_REQUEST', 'the target principal already owns the Session')
          }
          const fromPrincipalId = assertPrincipalId(session.principalId)
          const previous = {
            principalId: session.principalId,
            ownerToken: session.ownerToken,
            ownerExpiresAt: session.ownerExpiresAt,
          }
          session.principalId = toPrincipalId
          session.ownerToken = undefined
          session.ownerExpiresAt = 0
          store.revokeEditor(session)
          let share
          try {
            share = await sessionShares.grant({ sessionId, ownerPrincipalId: toPrincipalId, viewerPrincipalId: fromPrincipalId })
            await store.flush(session)
          } catch (error) {
            session.principalId = previous.principalId
            session.ownerToken = previous.ownerToken
            session.ownerExpiresAt = previous.ownerExpiresAt
            try { await sessionShares.revoke({ sessionId, viewerPrincipalId: fromPrincipalId }) } catch { /* The transfer error is reported; a leftover additive grant does not change ownership. */ }
            throw error
          }
          return sessionResponse(session, {
            transferred: true,
            fromPrincipalId,
            toPrincipalId,
            share: clone(share),
            shares: clone(sessionShares.listForOwner(sessionId, toPrincipalId)),
          })
        })
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/session/share-link') {
        const body = await readBody(request)
        assertProtocol(body)
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const sessionId = assertSessionId(body.sessionId)
        const expiresInMs = body.expiresInMs === undefined
          ? 60 * 60 * 1000
          : boundedInteger(body.expiresInMs, 'expiresInMs', 30 * DAY_MS)
        if (expiresInMs === 0) throw new BackendError('INVALID_REQUEST', 'expiresInMs must be at least 1')
        const result = await store.exclusive(sessionId, async () => {
          store.getForPrincipal(sessionId, principalId)
          const link = await sessionShares.createLink({
            sessionId,
            ownerPrincipalId: principalId,
            expiresAt: (options.testHooks?.now ?? Date.now)() + expiresInMs,
          })
          await recordCollaboration({
            action: 'share.link.create', sessionId, principalDigest: collaborationPrincipalDigest(principalId),
            role: 'viewer', outcome: 'created', linkId: link.linkId, expiresAt: link.expiresAt,
          })
          return { sessionId, link }
        })
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/session/share-link/redeem') {
        const body = await readBody(request)
        assertProtocol(body)
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const token = boundedString(body.token, 'token', 200)
        const inspected = sessionShares.inspectLink({ token })
        const result = await store.exclusive(inspected.sessionId, async () => {
          store.get(inspected.sessionId)
          const redeemed = await sessionShares.redeemLink({ token, viewerPrincipalId: principalId })
          await recordCollaboration({
            action: 'share.link.redeem', sessionId: inspected.sessionId, principalDigest: collaborationPrincipalDigest(principalId),
            role: 'viewer', outcome: 'granted', linkId: inspected.linkId,
            granteeDigest: collaborationPrincipalDigest(principalId), expiresAt: redeemed.link.expiresAt,
          })
          return { sessionId: inspected.sessionId, role: 'viewer', share: clone(redeemed.share), link: redeemed.link }
        })
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/session/share-link/revoke') {
        const body = await readBody(request)
        assertProtocol(body)
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const sessionId = assertSessionId(body.sessionId)
        const linkId = boundedString(body.linkId, 'linkId', 200)
        const result = await store.exclusive(sessionId, async () => {
          store.getForPrincipal(sessionId, principalId)
          const outcome = await sessionShares.revokeLink({ sessionId, linkId, ownerPrincipalId: principalId })
          await recordCollaboration({
            action: 'share.link.revoke', sessionId, principalDigest: collaborationPrincipalDigest(principalId),
            role: 'viewer', outcome: outcome.revoked ? 'revoked' : 'unchanged', linkId,
          })
          return {
            revoked: outcome.revoked,
            link: clone(outcome.link),
            shares: clone(sessionShares.listForOwner(sessionId, principalId)),
          }
        })
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/browser-native/session/')) {
        const operation = url.pathname.split('/').at(-1)
        const body = await readBody(request)
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        if (operation === 'share') {
          const sessionId = assertSessionId(body.sessionId)
          const viewerPrincipalId = assertPrincipalId(body.viewerPrincipalId)
          const role = body.role === undefined ? 'viewer' : body.role
          if (role !== 'viewer' && role !== 'editor') throw new BackendError('INVALID_REQUEST', 'role must be viewer or editor')
          const result = await store.exclusive(sessionId, async () => {
            const session = store.getForPrincipal(sessionId, principalId)
            if (!workspaces.identities.has(viewerPrincipalId)) {
              throw new BackendError('PRINCIPAL_NOT_FOUND', 'the viewer principal does not exist', 404)
            }
            const share = await sessionShares.grant({ sessionId, ownerPrincipalId: principalId, viewerPrincipalId, role })
            await recordCollaboration({
              action: 'share.grant', sessionId, principalDigest: collaborationPrincipalDigest(principalId),
              role, outcome: 'granted', granteeDigest: collaborationPrincipalDigest(viewerPrincipalId),
            })
            return sessionResponse(session, {
              share: clone(share),
              shares: clone(sessionShares.listForOwner(sessionId, principalId)),
            })
          })
          sendJson(response, 200, result)
          return
        }
        if (operation === 'export' || operation === 'import') {
          const workspaceId = boundedString(body.workspaceId, 'workspaceId', MAX_CHECKPOINT_ID_LENGTH)
          // The Workspace cookie is path-scoped to /workspace, so this Session route
          // authorizes both resources with the identity's Session cookie.
          workspaces.requireWorkspace(principalId, workspaceId)
          if (operation === 'export') {
            const session = store.getForPrincipal(assertSessionId(body.sessionId), principalId)
            const bundle = await store.exclusive(session.id, async () => await buildSessionBundle(session, workspaceId))
            sendJson(response, 200, bundle)
            return
          }
          sendJson(response, 200, await importSessionBundle(body.bundle, workspaceId, principalId))
          return
        }
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
        const result = await sessionOperation(
          store, operation, body, principalId, sessionShares, options.testHooks, admission,
          sessionAppendReceipts, recordCollaboration, branchReceipts,
          ownerPrincipalId => workspaces.revision(
            { headers: { cookie: `dsh-browser-native-principal=${ownerPrincipalId}` } },
            workspaces.workspaceIdForPrincipal(ownerPrincipalId),
          ).revision,
          createReceipts,
        )
        if (operation === 'append' && result.replayed !== true) {
          sessionEvents.publish(result.sessionId, body.events)
          await recordCollaboration({
            action: 'session.append', sessionId: result.sessionId,
            principalDigest: collaborationPrincipalDigest(principalId),
            role: sessionShares.roleOf(result.sessionId, principalId) ?? 'owner',
            outcome: 'accepted',
            fromSeq: result.nextSeq - body.events.length,
            toSeq: result.nextSeq - 1,
          })
        }
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
          if (typeof body.ownerToken !== 'string' || body.ownerToken.length === 0) {
            throw new BackendError('SESSION_NOT_FOUND', 'session does not exist', 404)
          }
          if (sharedStateOrigin === undefined) {
            const session = store.get(body.sessionId)
            store.assertOwner(session, body.ownerToken, body.ownerEpoch)
          } else {
            await authorizeRemoteLlm(request, body, sharedStateOrigin, sharedStateToken)
          }
        }
        if (options.testHooks?.failLlmRequest?.(body) === true) {
          throw new BackendError('E2E_INJECTED_LLM_FAILURE', 'E2E injected model request failure', 400)
        }
        const modelStartedAt = Date.now()
        let modelOutcome = 'completed'
        let modelQueueWaitMs
        let modelStarted = false
        try {
          await withAdmission(response, admission, body, async () => {
            modelStarted = true
            if (llm.mode === 'scripted') {
              response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
              let clientClosed = false
              const onClose = () => {
                if (response.writableEnded) return
                clientClosed = true
                options.testHooks?.onLlmClientClose?.(body)
              }
              response.on('close', onClose)
              const fault = options.testHooks?.scriptedLlmFault?.(body)
              try {
                await scriptedLlm(
                  response,
                  body.messages,
                  body.tools,
                  fault,
                  () => clientClosed,
                  body.purpose,
                )
              } finally {
                response.off('close', onClose)
              }
              if (fault?.kind === 'error') {
                modelOutcome = typeof fault.code === 'string' ? fault.code : 'MODEL_FAILED'
                diagnosticLog.push({
                  at: Date.now(),
                  kind: 'model-failure',
                  sessionId: body.sessionId,
                  purpose: body.purpose ?? 'turn',
                  code: modelOutcome,
                  provider: llm.mode,
                })
                if (diagnosticLog.length > 200) diagnosticLog.shift()
              }
            } else {
              let usagePrincipalId = workspaces.auditPrincipal(request)
              if (usagePrincipalId === undefined && typeof body.sessionId === 'string') {
                // The LLM proxy is outside the path-scoped identity cookies, so attribute
                // usage through the Session owner recorded at Session creation.
                try {
                  usagePrincipalId = store.get(body.sessionId).principalId
                } catch {
                  // Unknown or unsupported Session ids leave this entry unattributed.
                }
              }
              await realLlm(response, request, llm, body, entry => {
                let traceId
                try {
                  traceId = traceIdFor(store, store.get(body.sessionId))
                } catch {
                  // Unknown Session ids leave the usage entry attributed by principal only.
                }
                const recorded = {
                  ...entry,
                  ...(usagePrincipalId === undefined ? {} : { principalId: usagePrincipalId }),
                  ...(traceId === undefined ? {} : { traceId }),
                }
                usageAudit.push(recorded)
                void observabilityJournal.appendUsage(recorded)
              })
            }
          }, waitMs => { modelQueueWaitMs = waitMs })
        } catch (error) {
          modelOutcome = typeof error?.code === 'string' ? error.code : 'MODEL_FAILED'
          diagnosticLog.push({
            at: Date.now(),
            kind: 'model-failure',
            sessionId: body.sessionId,
            purpose: body.purpose ?? 'turn',
            code: modelOutcome,
            provider: llm.mode,
          })
          if (diagnosticLog.length > 200) diagnosticLog.shift()
          throw error
        } finally {
          if (modelStarted || modelOutcome !== 'completed') {
            metrics.recordModelRequest({
              outcome: modelOutcome,
              durationMs: Date.now() - modelStartedAt,
              ...(modelQueueWaitMs === undefined ? {} : { queueWaitMs: modelQueueWaitMs }),
            })
          }
        }
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/egress/fetch') {
        if (egress === undefined) throw new BackendError('NOT_FOUND', 'route not found', 404)
        const body = await readBody(request)
        assertProtocol(body)
        sendJson(response, 200, await egress.proxy(body))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/admission') {
        if (admission === undefined) throw new BackendError('NOT_FOUND', 'route not found', 404)
        sendJson(response, 200, { protocolVersion: PROTOCOL_VERSION, ...admission.snapshot() })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/observability/metrics') {
        const view = metricsView()
        void observabilityJournal.persistMetrics(view)
        if (url.searchParams.get('format') === 'prometheus') {
          response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' })
          response.end(metrics.prometheus(view))
          return
        }
        sendJson(response, 200, view)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/observability/alerts') {
        await alertEvaluator.run()
        sendJson(response, 200, alertEvaluator.snapshot())
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/observability/reconciliation') {
        workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const { healthy, writeFailures } = observabilityJournal.status()
        sendJson(response, 200, {
          protocolVersion: PROTOCOL_VERSION,
          capturedAt: Date.now(),
          ...observabilityReconciliation,
          journal: { healthy, writeFailures, integrity: observabilityRestore.integrity },
          current: {
            usageEntries: usageAudit.length,
            accessDenials: accessAuditEntries.length,
            metrics: metricsView(),
          },
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/observability/failure') {
        const principalId = workspaces.principalFromRequest(request, 'dsh-browser-native-session-principal')
        const turnId = boundedString(url.searchParams.get('turnId') ?? undefined, 'turnId', MAX_HANDOFF_ID_LENGTH)
        const turn = durableHost.status({ turnId, principalId })
        const session = store.getForPrincipal(turn.sessionId, principalId)
        const now = Date.now()
        const turnEvents = session.events.filter(event => event.data?.turn === turn.turn)
        const principalDigest = createHash('sha256').update(principalId).digest('hex').slice(0, 16)
        sendJson(response, 200, {
          evidenceVersion: 1,
          capturedAt: now,
          turn: {
            turnId: turn.turnId,
            sessionId: turn.sessionId,
            status: turn.status,
            model: turn.model,
            ...(turn.turn === undefined ? {} : { turn: turn.turn }),
            startedAt: turn.startedAt,
            ...(turn.settledAt === undefined ? {} : { settledAt: turn.settledAt, elapsedMs: turn.elapsedMs }),
            ...(turn.error === undefined ? {} : { error: turn.error }),
            ...(turn.startSeqs === undefined ? {} : { startSeqs: turn.startSeqs, endSeqs: turn.endSeqs, nextSeq: turn.nextSeq }),
          },
          events: turnEvents.slice(-12).map(event => ({
            seq: event.seq,
            type: event.type,
            ...(typeof event.data?.step === 'number' ? { step: event.data.step } : {}),
            ...(typeof event.data?.reason?.kind === 'string' ? { reason: event.data.reason.kind } : {}),
            ...(typeof event.data?.reason?.error?.code === 'string' ? { errorCode: event.data.reason.error.code } : {}),
            ...(typeof event.data?.callId === 'string' ? { callId: event.data.callId, tool: event.data.name } : {}),
            ...(typeof event.data?.message?.toolCallId === 'string'
              ? { toolCallId: event.data.message.toolCallId, isError: event.data.message.isError === true }
              : {}),
          })),
          lease: {
            held: session.ownerToken !== undefined && session.ownerExpiresAt > now,
            expiresInMs: session.ownerToken === undefined ? 0 : Math.max(0, session.ownerExpiresAt - now),
            writeBlocked: session.writeBlocked === true,
            eventCount: session.events.length,
            durableThroughSeq: session.durableThroughSeq,
          },
          accessDenials: accessAuditEntries
            .filter(entry => entry.principalDigest === principalDigest)
            .slice(-8)
            .map(clone),
          metrics: metrics.snapshot({
            startedAt,
            activeRequests,
            admission: admission === undefined ? undefined : admission.snapshot(),
            leases: store.leaseSnapshot(),
            durable: durableHost.snapshot(),
            now,
          }),
        })
        return
      }
      if (role === 'preview' && request.method === 'GET' && url.pathname === '/auth/handshake') {
        if (!requireLocalAuth) throw new BackendError('NOT_FOUND', 'route not found', 404)
        const presented = url.searchParams.get('token')
        if (typeof presented !== 'string' || presented.length !== authToken.length
          || !timingSafeEqual(Buffer.from(presented), Buffer.from(authToken))) {
          throw new BackendError('AUTH_REQUIRED', 'local process authentication is required', 401)
        }
        const requestedNext = url.searchParams.get('next') ?? '/preview.html?browser-native=1&preview-fixture=none'
        const next = requestedNext.startsWith('/') && !requestedNext.startsWith('//') ? requestedNext : '/'
        response.writeHead(302, {
          location: next,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'set-cookie': `${AUTH_COOKIE_NAME}=${authToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(AUTH_COOKIE_MAX_AGE_SECONDS)}${request.socket.encrypted === true || publicOrigin?.protocol === 'https:' ? '; Secure' : ''}`,
        })
        response.end()
        return
      }
      if (role === 'preview' && request.method === 'GET' && url.pathname === '/preview-api-origin') {
        response.setHeader('cache-control', 'no-store')
        // The validated Host names the origin the browser actually reached, which
        // differs from the listen address when the backend binds a wildcard
        // address behind a container port mapping or TLS proxy.
        const requestOrigin = `http://${String(request.headers.host)}`
        sendJson(response, 200, { origin: publicOrigin?.origin ?? servedApiOrigin ?? requestOrigin })
        return
      }
      if (request.method === 'GET' && (url.pathname === '/mobile' || url.pathname === '/mobile.html')) {
        await serveMobilePage(response)
        return
      }
      if (request.method === 'GET') {
        await serveStatic(response, distRoot, url.pathname)
        return
      }
      throw new BackendError('NOT_FOUND', 'route not found', 404)
    } catch (error) {
      metrics.recordFailure({ code: typeof error?.code === 'string' ? error.code : 'INTERNAL' })
      if (url !== undefined) recordAccessDenial(url, request, error)
      if (!response.headersSent && !response.destroyed) sendError(response, error)
      else response.destroy()
    }
  }
  const previewServer = createServer({ connectionsCheckingInterval: connectionsCheckingIntervalMs },
    (request, response) => { void handleRequest('preview', request, response) })
  const apiServer = createServer({ connectionsCheckingInterval: connectionsCheckingIntervalMs },
    (request, response) => { void handleRequest('api', request, response) })
  for (const server of [previewServer, apiServer]) {
    server.requestTimeout = requestTimeoutMs
    server.headersTimeout = headersTimeoutMs
    server.keepAliveTimeout = keepAliveTimeoutMs
    server.maxConnections = maxConnections
  }
  return {
    server: previewServer,
    get apiOrigin() { return servedApiOrigin },
    authToken,
    authTokenPath,
    store,
    workspaces,
    crossStoreLedger,
    llm,
    egress,
    accessAudit,
    collaborationAudit,
    sweepAttachments,
    durableHost,
    durableRecovery,
    listen: (port = options.port ?? 4175, host = options.host ?? '127.0.0.1') => new Promise((resolveListen, reject) => {
      const onError = async error => {
        await Promise.allSettled([closeServer(previewServer), closeServer(apiServer)])
        await releaseDataDirLock().catch(() => {})
        reject(error)
      }
      previewServer.once('error', onError)
      previewServer.listen(port, host, () => {
        previewServer.off('error', onError)
        const address = previewServer.address()
        servedPreviewOrigin = `http://${host}:${address.port}`
        servedOrigin = servedPreviewOrigin
        if (apiPort === undefined) {
          servedApiOrigin = undefined
          resolveListen(servedOrigin)
          return
        }
        apiServer.once('error', onError)
        apiServer.listen(apiPort, host, () => {
          apiServer.off('error', onError)
          const apiAddress = apiServer.address()
          servedApiOrigin = `http://${host}:${apiAddress.port}`
          resolveListen(servedOrigin)
        })
      })
    }),
    close: async () => {
      try {
        if (attachmentGcSweepTimer !== undefined) clearInterval(attachmentGcSweepTimer)
        if (retentionTimer !== undefined) clearInterval(retentionTimer)
        clearInterval(metricsSnapshotTimer)
        alertEvaluator.stop()
        for (const controller of workspaceDownloads.values()) controller.abort()
        await Promise.all([closeServer(previewServer), closeServer(apiServer)])
      } finally {
        try {
          await observabilityJournal.persistMetrics(metricsView())
          await observabilityJournal.close()
          await Promise.allSettled([...workspaceDownloads.keys()])
        } finally {
          if (authTokenPath !== undefined) await rm(authTokenPath, { force: true })
          await releaseDataDirLock()
        }
      }
    },
  }
  } catch (error) {
    await releaseDataDirLock().catch(() => {})
    throw error
  }
}
