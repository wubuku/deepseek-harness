import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const STORE_VERSION = 1
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_BODY_BYTES = 1 * 1024 * 1024

export class ExternalBusinessError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ExternalBusinessError'
    this.code = code
    this.status = status
  }
}

function clone(value) {
  return structuredClone(value)
}

function assertUuid(value, name) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new ExternalBusinessError('INVALID_REQUEST', `${name} must be a UUID`)
  return value
}

function assertDigest(value, name) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new ExternalBusinessError('INVALID_REQUEST', `${name} must be a SHA-256 digest`)
  return value.toLowerCase()
}

function assertObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ExternalBusinessError('INVALID_REQUEST', `${name} must be an object`)
  return value
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function publicRecord(record) {
  return {
    operationId: record.operationId,
    principalId: record.principalId,
    payloadDigest: record.payloadDigest,
    status: record.status,
    ...(record.receipt === undefined ? {} : { receipt: clone(record.receipt) }),
    effectCount: record.effectCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new ExternalBusinessError('REQUEST_TOO_LARGE', 'business request exceeds the limit', 413)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ExternalBusinessError('INVALID_REQUEST', 'business request is not valid JSON')
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function sendError(response, error) {
  const detail = error instanceof ExternalBusinessError
    ? error
    : new ExternalBusinessError('INTERNAL', 'external business service failed', 500)
  sendJson(response, detail.status, { error: { code: detail.code, message: detail.message } })
}

export class ExternalBusinessStore {
  constructor(dataDir, { now = Date.now, testHooks = {} } = {}) {
    this.path = join(resolve(dataDir), 'business-service.json')
    this.records = new Map()
    this.locks = new Map()
    this.now = now
    this.testHooks = testHooks
  }

  async load() {
    await mkdir(dirname(this.path), { recursive: true })
    let raw
    try {
      raw = JSON.parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    if (raw?.version !== STORE_VERSION || !Array.isArray(raw.records)) throw new Error('business service store is invalid')
    for (const record of raw.records) {
      assertUuid(record.operationId, 'operationId')
      assertUuid(record.principalId, 'principalId')
      assertDigest(record.payloadDigest, 'payloadDigest')
      if (record.status !== 'ready' && record.status !== 'committed') throw new Error('business service record status is invalid')
      this.records.set(record.operationId, clone(record))
    }
  }

  async exclusive(operationId, operation) {
    const previous = this.locks.get(operationId) ?? Promise.resolve()
    let release
    const current = new Promise(resolveRelease => { release = resolveRelease })
    this.locks.set(operationId, current)
    await previous
    try { return await operation() } finally {
      release()
      if (this.locks.get(operationId) === current) this.locks.delete(operationId)
    }
  }

  async persist() {
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify({ version: STORE_VERSION, records: [...this.records.values()] })}\n`, 'utf8')
    try { await rename(temporary, this.path) } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  async intent(input) {
    assertObject(input, 'business intent')
    const operationId = assertUuid(input.operationId, 'operationId')
    const principalId = assertUuid(input.principalId, 'principalId')
    const payloadDigest = assertDigest(input.payloadDigest, 'payloadDigest')
    return await this.exclusive(operationId, async () => {
      const previous = this.records.get(operationId)
      if (previous !== undefined) {
        if (previous.principalId !== principalId || previous.payloadDigest !== payloadDigest) {
          throw new ExternalBusinessError('IDEMPOTENCY_CONFLICT', 'operationId is bound to a different principal or payload', 409)
        }
        return { ...publicRecord(previous), replayed: true }
      }
      const now = this.now()
      const record = { operationId, principalId, payloadDigest, status: 'ready', effectCount: 0, createdAt: now, updatedAt: now }
      this.records.set(operationId, record)
      await this.persist()
      return { ...publicRecord(record), replayed: false }
    })
  }

  async effect(input) {
    assertObject(input, 'business effect')
    const operationId = assertUuid(input.operationId, 'operationId')
    const principalId = assertUuid(input.principalId, 'principalId')
    const payloadDigest = assertDigest(input.payloadDigest, 'payloadDigest')
    return await this.exclusive(operationId, async () => {
      const record = this.records.get(operationId)
      if (record === undefined) throw new ExternalBusinessError('INTENT_REQUIRED', 'business intent must be registered before effect', 409)
      if (record.principalId !== principalId || record.payloadDigest !== payloadDigest) {
        throw new ExternalBusinessError('IDEMPOTENCY_CONFLICT', 'operationId is bound to a different principal or payload', 409)
      }
      if (record.status === 'committed') return { ...publicRecord(record), replayed: true }
      if (this.testHooks.failBeforeEffect?.(input) === true) throw new ExternalBusinessError('BUSINESS_UNAVAILABLE', 'business effect was not accepted', 503)
      const receipt = {
        effectId: randomUUID(),
        operationId,
        principalId,
        payloadDigest,
        effectCount: 1,
        responseDigest: digest({ operationId, principalId, payloadDigest }),
      }
      record.status = 'committed'
      record.receipt = receipt
      record.effectCount = 1
      record.updatedAt = this.now()
      await this.persist()
      return { ...publicRecord(record), replayed: false }
    })
  }

  query(operationId, principalId) {
    assertUuid(operationId, 'operationId')
    assertUuid(principalId, 'principalId')
    if (this.testHooks.failQuery?.(operationId, principalId) === true) throw new ExternalBusinessError('BUSINESS_QUERY_UNAVAILABLE', 'business operation status is unavailable', 503)
    const record = this.records.get(operationId)
    if (record === undefined || record.principalId !== principalId) return { operationId, principalId, status: 'absent' }
    return publicRecord(record)
  }
}

export async function createExternalBusinessService({ dataDir, port = 0, host = '127.0.0.1', now, testHooks = {} }) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('dataDir is required')
  const store = new ExternalBusinessStore(dataDir, { now, testHooks })
  await store.load()
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://business.invalid')
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/intent') {
        sendJson(response, 200, await store.intent(await readBody(request)))
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/effect') {
        const result = await store.effect(await readBody(request))
        if (testHooks.dropEffectResponse?.(result) === true) {
          response.destroy()
          return
        }
        sendJson(response, 200, result)
        return
      }
      const match = url.pathname.match(/^\/v1\/effect\/([0-9a-f-]{36})$/i)
      if (request.method === 'GET' && match !== null) {
        sendJson(response, 200, store.query(match[1], url.searchParams.get('principalId') ?? ''))
        return
      }
      throw new ExternalBusinessError('NOT_FOUND', 'business route not found', 404)
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendError(response, error)
      else response.destroy()
    }
  })
  let origin
  return {
    server,
    store,
    listen: () => new Promise((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        const address = server.address()
        origin = `http://${host}:${address.port}`
        resolveListen(origin)
      })
    }),
    origin: () => origin,
    close: () => new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())),
  }
}
