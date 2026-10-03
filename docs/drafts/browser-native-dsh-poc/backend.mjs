/**
 * Directory-local browser-native PoC backend.
 *
 * It is intentionally a small exact-route HTTP service. It stores only flushed
 * Session state on disk, keeps unflushed events visible to the current backend
 * instance, and never accepts provider credentials from the browser.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_BODY_BYTES,
  MAX_DURABLE_EVENTS,
  MAX_TEXT_BYTES,
  OWNER_LEASE_MS,
  PocError,
  PROTOCOL_VERSION,
  assertEnvelope,
  assertAllowedKeys,
  assertDurableEvents,
  assertEvents,
  assertHeader,
  assertJsonSafe,
  assertMessages,
  assertNoDuplicateJsonKeys,
  assertOwner,
  assertSessionId,
  nonEmptyString,
  safeInteger,
  stableJson,
} from './protocol.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC_ROOT = resolve(HERE, 'public')

const REPLAY_OPERATIONS = new Set(['create', 'open', 'renew', 'read', 'append', 'flush', 'close'])
const DURABLE_REPLAY_OPERATIONS = new Set(['read', 'append', 'flush', 'close'])

/** @param {unknown} value @param {string} sessionId */
function assertReplayTable(value, sessionId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PocError('INVALID_REQUEST', 'durable replay table must be an object')
  }
  const table = Object.create(null)
  for (const [requestId, record] of Object.entries(value)) {
    nonEmptyString(requestId, 'replay.requestId')
    assertAllowedKeys(record, ['operation', 'digest', 'resultDigest', 'nextSeq', 'durableThroughSeq', 'response'], 'replay record')
    nonEmptyString(record.operation, 'replay.operation')
    if (!REPLAY_OPERATIONS.has(record.operation)) throw new PocError('INVALID_REQUEST', 'durable replay operation is unsupported')
    if (!DURABLE_REPLAY_OPERATIONS.has(record.operation)) continue
    nonEmptyString(record.digest, 'replay.digest')
    nonEmptyString(record.resultDigest, 'replay.resultDigest')
    safeInteger(record.nextSeq, 'replay.nextSeq')
    if (record.durableThroughSeq !== -1) safeInteger(record.durableThroughSeq, 'replay.durableThroughSeq')
    if (record.durableThroughSeq >= record.nextSeq) {
      throw new PocError('INVALID_REQUEST', 'durable replay sequence exceeds response sequence')
    }
    if (record.response === null || typeof record.response !== 'object' || Array.isArray(record.response)) {
      throw new PocError('INVALID_REQUEST', 'replay.response must be an object')
    }
    assertJsonSafe(record.response)
    if (record.response.protocolVersion !== PROTOCOL_VERSION
      || record.response.requestId !== requestId
      || record.response.sessionId !== sessionId) {
      throw new PocError('INVALID_REQUEST', 'durable replay response identity is invalid')
    }
    if (record.nextSeq !== record.response.nextSeq
      || (record.response.durableThroughSeq !== undefined
        && record.durableThroughSeq !== record.response.durableThroughSeq)
      || record.resultDigest !== digestFor(record.response)) {
      throw new PocError('INVALID_REQUEST', 'durable replay response receipt is inconsistent')
    }
    table[requestId] = record
  }
  return table
}

/** @param {string} value */
function revisionFor(value) {
  return `rev-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

/** @param {unknown} value */
function digestFor(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

/** @param {object} value */
function clone(value) {
  return structuredClone(value)
}

/** @param {import('node:http').IncomingMessage} request */
async function readBody(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > MAX_BODY_BYTES) throw new PocError('REQUEST_TOO_LARGE', 'request body exceeds the PoC limit', 413)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const text = Buffer.concat(chunks).toString('utf8')
    const parsed = JSON.parse(text)
    assertNoDuplicateJsonKeys(text)
    return parsed
  } catch {
    throw new PocError('INVALID_REQUEST', 'request body is not valid JSON')
  }
}

/** @param {import('node:http').ServerResponse} response @param {number} status @param {object} body */
function sendJson(response, status, body) {
  const encoded = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-browser-native-protocol': String(PROTOCOL_VERSION),
  })
  response.end(encoded)
}

/** @param {import('node:http').ServerResponse} response @param {PocError|Error} error */
function sendError(response, error) {
  const poc = error instanceof PocError ? error : new PocError('INTERNAL', 'internal PoC backend error', 500)
  sendJson(response, poc.status, {
    protocolVersion: PROTOCOL_VERSION,
    error: { code: poc.code, message: poc.message },
  })
}

class SessionStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = resolve(dataDir)
    this.sessionsDir = join(this.dataDir, 'sessions')
    /** @type {Map<string, any>} */
    this.sessions = new Map()
    /** @type {Map<string, Promise<void>>} */
    this.locks = new Map()
  }

  /** @param {string} key @param {() => Promise<any>} operation */
  async runExclusive(key, operation) {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release
    const current = new Promise(resolveRelease => { release = resolveRelease })
    this.locks.set(key, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.locks.get(key) === current) this.locks.delete(key)
    }
  }

  async load() {
    await mkdir(this.sessionsDir, { recursive: true })
    for (const name of await readdir(this.sessionsDir)) {
      if (extname(name) !== '.json') continue
      try {
        const stored = JSON.parse(await readFile(join(this.sessionsDir, name), 'utf8'))
        const id = assertSessionId(stored.id)
        const events = assertDurableEvents(stored.events)
        const durableThroughSeq = stored.durableThroughSeq ?? events.length - 1
        if (!Number.isSafeInteger(durableThroughSeq) || durableThroughSeq !== events.length - 1) continue
        const generation = stored.generation ?? 0
        if (!Number.isSafeInteger(generation) || generation < 0) continue
        this.sessions.set(id, {
          id,
          header: assertHeader(stored.header, id),
          inheritedEventCount: safeInteger(stored.inheritedEventCount ?? 0, 'inheritedEventCount'),
          events,
          durableThroughSeq,
          replay: assertReplayTable(stored.replay ?? {}, id),
          ownerToken: undefined,
          generation,
          leaseExpiresAt: 0,
        })
      } catch {
        // A malformed file is ignored here; the next request reports not-found
        // instead of exposing arbitrary disk content through the API.
      }
    }
  }

  /** @param {string} id */
  fileFor(id) { return join(this.sessionsDir, `${id}.json`) }

  /** @param {string} id */
  get(id) {
    const session = this.sessions.get(assertSessionId(id))
    if (session === undefined) throw new PocError('SESSION_NOT_FOUND', 'session was not found', 404)
    this.expireOwner(session)
    return session
  }

  /** @param {any} session */
  expireOwner(session) {
    if (session.ownerToken !== undefined && session.leaseExpiresAt <= Date.now()) {
      session.ownerToken = undefined
      session.leaseExpiresAt = 0
    }
  }

  /** @param {any} session */
  ownerReceipt(session) {
    return {
      ownerToken: session.ownerToken,
      generation: session.generation,
      expiresAt: session.leaseExpiresAt,
      backendRevision: this.revision(session),
    }
  }

  /** @param {any} session */
  claim(session) {
    this.expireOwner(session)
    if (session.ownerToken !== undefined) throw new PocError('SESSION_ALREADY_OWNED', 'session already has a write owner', 409)
    session.generation += 1
    session.ownerToken = randomUUID()
    session.leaseExpiresAt = Date.now() + OWNER_LEASE_MS
    return this.ownerReceipt(session)
  }

  /** @param {any} session @param {unknown} ownerToken @param {unknown} generation */
  assertCurrentOwner(session, ownerToken, generation) {
    assertOwner({ ownerToken, generation })
    this.expireOwner(session)
    if (session.ownerToken !== ownerToken || session.generation !== generation) {
      throw new PocError('SESSION_OWNERSHIP_LOST', 'session write ownership is no longer valid', 409)
    }
  }

  /** @param {any} session */
  revision(session) {
    return revisionFor(`${session.id}:${session.events.length}:${session.durableThroughSeq}`)
  }

  /** @param {any} session @param {string} operation @param {string} requestId @param {object} request */
  replay(session, operation, requestId, request) {
    const digest = digestFor(request)
    const previous = Object.prototype.hasOwnProperty.call(session.replay, requestId)
      ? session.replay[requestId]
      : undefined
    if (previous !== undefined) {
      if (previous.operation !== undefined && previous.operation !== operation) {
        throw new PocError('INVALID_REQUEST', 'requestId was reused for a different operation')
      }
      if (previous.digest !== digest) throw new PocError('INVALID_REQUEST', 'requestId was reused with different payload')
      return clone(previous.response)
    }
    return undefined
  }

  /** @param {any} session @param {string} operation @param {string} requestId @param {object} request @param {object} response */
  remember(session, operation, requestId, request, response) {
    session.replay[requestId] = {
      operation,
      digest: digestFor(request),
      resultDigest: digestFor(response),
      nextSeq: response.nextSeq,
      durableThroughSeq: session.durableThroughSeq,
      response: clone(response),
    }
  }

  /** @param {any} session */
  async flush(session) {
    const replay = Object.fromEntries(Object.entries(session.replay)
      .filter(([, record]) => DURABLE_REPLAY_OPERATIONS.has(record.operation)))
    const record = {
      id: session.id,
      header: session.header,
      inheritedEventCount: session.inheritedEventCount,
      events: session.events,
      durableThroughSeq: session.events.length - 1,
      replay,
      generation: session.generation,
    }
    const target = this.fileFor(session.id)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, 'utf8')
      const file = await open(temporary, 'r+')
      try { await file.sync() } finally { await file.close() }
      await rename(temporary, target)
      const directory = await open(this.sessionsDir, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) {
      await rm(temporary, { force: true })
      throw new PocError('DURABILITY_FAILED', 'the Session flush could not be made durable', 503, { cause: error })
    }
    session.durableThroughSeq = record.durableThroughSeq
    return `durable-${session.id}-${record.durableThroughSeq}`
  }

  /** @param {object} header */
  create(header, inheritedEventCount) {
    const id = assertSessionId(header.sessionId)
    if (this.sessions.has(id)) throw new PocError('SESSION_ALREADY_EXISTS', 'session already exists', 409)
    const session = {
      id,
      header: clone(header),
      inheritedEventCount,
      events: [],
      durableThroughSeq: -1,
      replay: Object.create(null),
      ownerToken: undefined,
      generation: 0,
      leaseExpiresAt: 0,
    }
    this.sessions.set(id, session)
    return session
  }

  /** @param {any} session */
  async eraseIfEmpty(session) {
    if (session.events.length !== 0 || session.durableThroughSeq >= 0) return
    this.sessions.delete(session.id)
    await rm(this.fileFor(session.id), { force: true })
  }
}

/**
 * Persist a response replay record together with the already accepted Session
 * state. If the second flush fails, restore the prior replay entry so the
 * caller can retry the same operation while its owner is still valid.
 * @param {SessionStore} store
 * @param {any} session
 * @param {string} operation
 * @param {string} requestId
 * @param {object} request
 * @param {object} response
 */
async function rememberDurably(store, session, operation, requestId, request, response) {
  const previous = session.replay[requestId]
  store.remember(session, operation, requestId, request, response)
  try {
    await store.flush(session)
  } catch (error) {
    if (previous === undefined) delete session.replay[requestId]
    else session.replay[requestId] = previous
    throw error
  }
}

/** @param {any} session @param {any} body */
function append(session, body) {
  const expected = safeInteger(body.expectedNextSeq, 'expectedNextSeq')
  const events = assertEvents(body.events)
  if (expected !== session.events.length) throw new PocError('SEQ_CONFLICT', 'expectedNextSeq does not match the visible log', 409)
  if (events.length > MAX_DURABLE_EVENTS - session.events.length) {
    throw new PocError('REQUEST_TOO_LARGE', 'Session event limit would be exceeded', 413)
  }
  events.forEach((event, index) => {
    if (event.seq !== expected + index) throw new PocError('SEQ_CONFLICT', 'event sequence is not contiguous', 409)
    if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_TEXT_BYTES) {
      throw new PocError('REQUEST_TOO_LARGE', 'event exceeds the PoC limit', 413)
    }
  })
  session.events.push(...clone(events))
  return {
    acceptedFromSeq: expected,
    acceptedCount: events.length,
    nextSeq: session.events.length,
  }
}

/** @param {any} store @param {any} session @param {string} requestId @param {object} extra */
function sessionResponse(store, session, requestId, extra = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    sessionId: session.id,
    nextSeq: session.events.length,
    backendRevision: store.revision(session),
    ...extra,
  }
}

/** @param {any} store @param {any} body @param {string} operation */
async function handleSession(store, body, operation) {
  assertEnvelope(body)
  const requestId = nonEmptyString(body.requestId, 'requestId')
  if (operation === 'create') {
    assertAllowedKeys(body, ['protocolVersion', 'requestId', 'sessionId', 'header', 'inheritedEventCount'])
    const sessionId = assertSessionId(body.sessionId)
    const inheritedEventCount = safeInteger(body.inheritedEventCount, 'inheritedEventCount')
    const header = assertHeader(body.header, sessionId)
    const existing = store.sessions.get(sessionId)
    if (existing !== undefined) {
      const replayed = store.replay(existing, operation, requestId, body)
      if (replayed !== undefined) return replayed
      throw new PocError('SESSION_ALREADY_EXISTS', 'session already exists', 409)
    }
    const session = store.create({ ...header, sessionId }, inheritedEventCount)
    const owner = store.claim(session)
    const response = sessionResponse(store, session, requestId, {
      header: session.header,
      inheritedEventCount: session.inheritedEventCount,
      owner,
    })
    store.remember(session, operation, requestId, body, response)
    return response
  }

  const allowedKeys = {
    open: ['protocolVersion', 'requestId', 'sessionId', 'access'],
    renew: ['protocolVersion', 'requestId', 'sessionId', 'ownerToken', 'generation'],
    read: ['protocolVersion', 'requestId', 'sessionId', 'offset', 'length'],
    append: ['protocolVersion', 'requestId', 'sessionId', 'ownerToken', 'generation', 'expectedNextSeq', 'events'],
    flush: ['protocolVersion', 'requestId', 'sessionId', 'ownerToken', 'generation'],
    close: ['protocolVersion', 'requestId', 'sessionId', 'ownerToken', 'generation'],
  }[operation]
  if (allowedKeys === undefined) throw new PocError('INVALID_REQUEST', 'unknown Session operation')
  assertAllowedKeys(body, allowedKeys)
  const sessionId = assertSessionId(body.sessionId)
  if (operation === 'open' && body.access !== 'read' && body.access !== 'write') {
    throw new PocError('INVALID_REQUEST', 'access must be read or write')
  }
  if (operation === 'renew' || operation === 'append' || operation === 'flush' || operation === 'close') {
    assertOwner(body)
  }
  if (operation === 'read') {
    safeInteger(body.offset ?? 0, 'offset')
    if (body.length !== undefined) safeInteger(body.length, 'length')
  }
  if (operation === 'append') {
    safeInteger(body.expectedNextSeq, 'expectedNextSeq')
    assertEvents(body.events)
  }

  const session = store.get(sessionId)
  const replayed = store.replay(session, operation, requestId, body)
  if (replayed !== undefined) return replayed
  const ownerOperation = operation === 'renew' || operation === 'append' || operation === 'flush' || operation === 'close'
  if (ownerOperation) store.assertCurrentOwner(session, body.ownerToken, body.generation)
  let response
  if (operation === 'open') {
    const access = body.access
    const owner = access === 'write' ? store.claim(session) : undefined
    response = sessionResponse(store, session, requestId, {
      header: session.header,
      inheritedEventCount: session.inheritedEventCount,
      owner,
    })
  } else if (operation === 'renew') {
    session.leaseExpiresAt = Date.now() + OWNER_LEASE_MS
    response = sessionResponse(store, session, requestId, { owner: store.ownerReceipt(session) })
  } else if (operation === 'read') {
    const offset = safeInteger(body.offset ?? 0, 'offset')
    const length = body.length === undefined ? session.events.length : safeInteger(body.length, 'length')
    response = sessionResponse(store, session, requestId, {
      events: clone(session.events.slice(offset, offset + length)),
      eventState: session.ownerToken === undefined ? 'shared-frozen' : 'owned',
      durableThroughSeq: session.durableThroughSeq,
    })
  } else if (operation === 'append') {
    const result = append(session, body)
    response = sessionResponse(store, session, requestId, result)
  } else if (operation === 'flush') {
    const durabilityReceipt = await store.flush(session)
    response = sessionResponse(store, session, requestId, {
      durable: true,
      durabilityReceipt,
      durableThroughSeq: session.durableThroughSeq,
    })
    await rememberDurably(store, session, operation, requestId, body, response)
    return response
  } else if (operation === 'close') {
    const durabilityReceipt = session.durableThroughSeq < session.events.length - 1
      ? await store.flush(session)
      : undefined
    const closeResult = {
      closed: true,
      ownerReleased: true,
      durableThroughSeq: session.durableThroughSeq,
      ...(durabilityReceipt === undefined ? {} : { durabilityReceipt }),
    }
    response = sessionResponse(store, session, requestId, closeResult)
    if (session.events.length !== 0 || session.durableThroughSeq >= 0) {
      await rememberDurably(store, session, operation, requestId, body, response)
    }
    session.ownerToken = undefined
    session.leaseExpiresAt = 0
    await store.eraseIfEmpty(session)
  }
  if (operation !== 'close') store.remember(session, operation, requestId, body, response)
  return response
}

/** @param {any} store @param {any} body @param {import('node:http').ServerResponse} response @param {import('node:http').IncomingMessage} request */
async function handleLlm(store, body, response, request) {
  assertEnvelope(body)
  assertAllowedKeys(body, ['protocolVersion', 'requestId', 'sessionId', 'ownerToken', 'generation', 'model', 'messages'])
  const sessionId = assertSessionId(body.sessionId)
  assertOwner(body)
  nonEmptyString(body.model, 'model')
  assertMessages(body.messages)
  const session = store.get(sessionId)
  store.assertCurrentOwner(session, body.ownerToken, body.generation)
  if (body.model !== 'poc-scripted') throw new PocError('MODEL_NOT_ALLOWED', 'only poc-scripted is available', 403)
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-browser-native-protocol': String(PROTOCOL_VERSION),
  })
  const toolWasReturned = body.messages.some(message => message?.role === 'tool')
  const send = (item) => {
    if (!response.destroyed) response.write(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...item })}\n`)
  }
  const delay = (ms) => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
  try {
    await delay(10)
    if (response.destroyed) return
    if (toolWasReturned) {
      send({ kind: 'chunk', chunk: { type: 'text', text: 'browser_echo completed in the Main Thread.' } })
      await delay(10)
      send({ kind: 'end', finish: 'stop' })
    } else {
      send({ kind: 'chunk', chunk: { type: 'tool-call', callId: 'poc-call-1', name: 'browser_echo', args: { text: 'hello from browser-native DSH' } } })
      await delay(10)
      send({ kind: 'end', finish: 'tool-call' })
    }
    response.end()
  } catch (error) {
    if (!response.destroyed) response.end()
    throw error
  }
}

/** @param {any} store @param {URLSearchParams} search */
function statResponse(store, search) {
  for (const key of search.keys()) {
    if (key !== 'protocolVersion' && key !== 'sessionId') {
      throw new PocError('INVALID_REQUEST', `stat.${key} is not supported by this PoC`)
    }
  }
  if (search.get('protocolVersion') !== String(PROTOCOL_VERSION)) {
    throw new PocError('PROTOCOL_UNSUPPORTED', 'unsupported browser-native PoC protocol version')
  }
  assertSessionId(search.get('sessionId') ?? '')
  const session = store.get(search.get('sessionId'))
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: session.id,
    header: session.header,
    nextSeq: session.events.length,
    durableThroughSeq: session.durableThroughSeq,
    backendRevision: store.revision(session),
    ownerActive: session.ownerToken !== undefined,
  }
}

/** @param {string} url */
function publicFile(url) {
  let requested
  try {
    requested = decodeURIComponent(new URL(url, 'http://poc.invalid').pathname)
  } catch {
    throw new PocError('NOT_FOUND', 'file not found', 404)
  }
  const relativePath = requested === '/' ? 'index.html' : requested.slice(1)
  const absolute = resolve(PUBLIC_ROOT, relativePath)
  if (relative(PUBLIC_ROOT, absolute).startsWith('..')) throw new PocError('NOT_FOUND', 'file not found', 404)
  return absolute
}

/** @param {import('node:http').ServerResponse} response @param {string} path */
async function serveStatic(response, path) {
  let body
  try {
    body = await readFile(path)
  } catch (error) {
    if (error !== null && typeof error === 'object' && ('code' in error)
      && (error.code === 'ENOENT' || error.code === 'EISDIR')) {
      throw new PocError('NOT_FOUND', 'file not found', 404)
    }
    throw error
  }
  const contentType = path.endsWith('.html') ? 'text/html; charset=utf-8'
    : path.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : 'application/octet-stream'
  response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
  response.end(body)
}

/**
 * Create the directory-local HTTP server.
 * @param {{ dataDir: string, port?: number, host?: string }} options
 */
export async function createBrowserNativeServer(options) {
  const store = new SessionStore(options.dataDir)
  await store.load()
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://browser-native-poc.invalid')
      if (request.method === 'GET' && url.pathname === '/api/browser-native/health') {
        sendJson(response, 200, { protocolVersion: PROTOCOL_VERSION, ok: true })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/browser-native/session/stat') {
        const sessionId = url.searchParams.get('sessionId')
        const lockKey = typeof sessionId === 'string' ? sessionId : `invalid-${randomUUID()}`
        const result = await store.runExclusive(lockKey, () => statResponse(store, url.searchParams))
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/browser-native/session/')) {
        const operation = url.pathname.split('/').at(-1)
        const body = await readBody(request)
        const lockKey = typeof body?.sessionId === 'string' ? body.sessionId : `invalid-${randomUUID()}`
        const result = await store.runExclusive(lockKey, () => handleSession(store, body, operation))
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/llm') {
        const body = await readBody(request)
        await handleLlm(store, body, response, request)
        return
      }
      if (request.method === 'GET') {
        await serveStatic(response, publicFile(request.url ?? '/'))
        return
      }
      throw new PocError('NOT_FOUND', 'route not found', 404)
    } catch (error) {
      if (!response.headersSent) sendError(response, error)
      else response.destroy()
    }
  })
  return {
    server,
    store,
    /** @param {number} [port] @param {string} [host] */
    listen: (port = options.port ?? 0, host = options.host ?? '127.0.0.1') => new Promise((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        const address = server.address()
        if (address === null || typeof address === 'string') return reject(new Error('backend did not expose a TCP address'))
        resolveListen(`http://${host}:${address.port}`)
      })
    }),
    close: () => new Promise((resolveClose, reject) => {
      server.closeAllConnections()
      server.close(error => error ? reject(error) : resolveClose())
    }),
  }
}

export { OWNER_LEASE_MS }
