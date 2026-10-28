import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  createCrossStoreCheckpoint,
  createCrossStoreIdentity,
  createCrossStoreIntent,
  digestCrossStoreValue,
  reconcileCrossStoreRecord,
  CROSS_STORE_RECEIPT_KINDS,
  CROSS_STORE_STATUSES,
} from './cross-store-checkpoint.mjs'

const LEDGER_VERSION = 1

export class CrossStoreLedgerError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'CrossStoreLedgerError'
    this.code = code
    this.status = status
  }
}

function clone(value) {
  return structuredClone(value)
}

function assertPrincipal(value) {
  try { return createCrossStoreIdentity({ principalId: value, operationId: value, sessionId: value, workspaceId: value, ownerEpoch: 1, workspaceFencingToken: 1, turn: 1, step: 1, callId: 'validation', toolName: 'validation', toolCallSeq: 1 }).principalId } catch {
    throw new CrossStoreLedgerError('IDENTITY_INVALID', 'principal id is invalid', 401)
  }
}

function assertReceipt(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CrossStoreLedgerError('RECEIPT_INVALID', 'receipt must be an object')
  }
  if (JSON.stringify(value).length > 100_000) throw new CrossStoreLedgerError('RECEIPT_TOO_LARGE', 'receipt exceeds the ledger limit', 413)
  return clone(value)
}

function digestIntent(intent) {
  return digestCrossStoreValue({ ...intent })
}

function publicRecord(record) {
  const workspaceReceipt = record.receipts.workspace?.receipt
  const sessionReceipt = record.receipts.session?.receipt
  const checkpoint = createCrossStoreCheckpoint({
    operationId: record.identity.operationId,
    sessionId: record.identity.sessionId,
    workspaceId: record.identity.workspaceId,
    ownerEpoch: record.identity.ownerEpoch,
    workspaceFencingToken: record.identity.workspaceFencingToken,
    nextSessionSeq: Number.isSafeInteger(sessionReceipt?.seq) && sessionReceipt.seq >= 0 ? sessionReceipt.seq + 1 : 0,
    ...(Number.isSafeInteger(sessionReceipt?.durableThroughSeq) && sessionReceipt.durableThroughSeq >= 0
      ? { durableThroughSeq: sessionReceipt.durableThroughSeq } : {}),
    workspaceRevision: Number.isSafeInteger(workspaceReceipt?.revision) && workspaceReceipt.revision >= 0
      ? workspaceReceipt.revision : 0,
    workspaceStatus: record.receipts.workspace?.status ?? 'pending',
    sessionStatus: record.receipts.session?.status ?? 'pending',
    businessStatus: record.receipts.business?.status ?? 'pending',
  })
  return {
    operationId: record.identity.operationId,
    identity: clone(record.identity),
    intent: clone(record.intent),
    receipts: clone(record.receipts),
    checkpoint,
    decision: reconcileCrossStoreRecord(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    businessEffectCount: record.businessEffectCount,
  }
}

export class CrossStoreOperationLedger {
  constructor(dataDir, { now = Date.now } = {}) {
    this.path = join(dataDir, 'cross-store-operation-ledger.json')
    this.records = new Map()
    this.locks = new Map()
    this.now = now
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
    if (raw?.version !== LEDGER_VERSION || !Array.isArray(raw.records)) throw new Error('cross-store operation ledger metadata is invalid')
    for (const value of raw.records) {
      if (value?.identity?.operationId === undefined || value.intent === undefined || value.receipts === undefined) {
        throw new Error('cross-store operation ledger record is invalid')
      }
      const identity = createCrossStoreIdentity(value.identity)
      this.records.set(identity.operationId, {
        identity,
        intent: createCrossStoreIntent({ ...identity, ...value.intent }),
        receipts: clone(value.receipts),
        businessEffectCount: value.businessEffectCount ?? 0,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      })
    }
  }

  async exclusive(operationId, operation) {
    const previous = this.locks.get(operationId) ?? Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    this.locks.set(operationId, current)
    await previous
    try { return await operation() } finally {
      release()
      if (this.locks.get(operationId) === current) this.locks.delete(operationId)
    }
  }

  async persist() {
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify({ version: LEDGER_VERSION, records: [...this.records.values()] })}\n`, 'utf8')
    try { await rename(temporary, this.path) } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  get(principalId, operationId) {
    assertPrincipal(principalId)
    const record = this.records.get(operationId)
    if (record === undefined || record.identity.principalId !== principalId) {
      throw new CrossStoreLedgerError('OPERATION_NOT_FOUND', 'cross-store operation does not exist', 404)
    }
    return record
  }

  async intent(principalId, input) {
    assertPrincipal(principalId)
    let intent
    try { intent = createCrossStoreIntent(input) } catch (error) {
      throw new CrossStoreLedgerError('INTENT_INVALID', error instanceof Error ? error.message : String(error))
    }
    const identity = createCrossStoreIdentity(intent)
    if (identity.principalId !== principalId) throw new CrossStoreLedgerError('OPERATION_FORBIDDEN', 'operation principal does not match the browser identity', 403)
    return await this.exclusive(intent.operationId, async () => {
      const previous = this.records.get(intent.operationId)
      const digest = digestIntent(intent)
      if (previous !== undefined) {
        if (previous.identity.principalId !== principalId) throw new CrossStoreLedgerError('OPERATION_NOT_FOUND', 'cross-store operation does not exist', 404)
        if (previous.intentDigest !== digest) throw new CrossStoreLedgerError('OPERATION_ID_REUSED', 'operationId was reused with a different intent', 409)
        return { ...publicRecord(previous), replayed: true }
      }
      const now = this.now()
      const created = {
        identity,
        intent: {
          operationKind: intent.operationKind,
          payloadDigest: intent.payloadDigest,
          ...(intent.payloadBytes === undefined ? {} : { payloadBytes: intent.payloadBytes }),
        },
        intentDigest: digest,
        receipts: {},
        businessEffectCount: 0,
        createdAt: now,
        updatedAt: now,
      }
      this.records.set(intent.operationId, created)
      await this.persist()
      return { ...publicRecord(created), replayed: false }
    })
  }

  async receipt(principalId, operationId, kind, status, receipt, identity) {
    assertPrincipal(principalId)
    if (!CROSS_STORE_RECEIPT_KINDS.includes(kind)) throw new CrossStoreLedgerError('RECEIPT_INVALID', 'receipt kind is invalid')
    if (!CROSS_STORE_STATUSES.includes(status)) throw new CrossStoreLedgerError('RECEIPT_INVALID', 'receipt status is invalid')
    const value = assertReceipt(receipt)
    return await this.exclusive(operationId, async () => {
      const current = this.get(principalId, operationId)
      if (identity !== undefined) {
        let candidate
        try { candidate = createCrossStoreIdentity(identity) } catch (error) {
          throw new CrossStoreLedgerError('RECEIPT_INVALID', error instanceof Error ? error.message : String(error))
        }
        if (JSON.stringify(candidate) !== JSON.stringify(current.identity)) {
          throw new CrossStoreLedgerError('RECEIPT_IDENTITY_MISMATCH', 'receipt identity does not match the operation intent', 409)
        }
      }
      const previous = current.receipts[kind]
      const next = { status, receipt: value, digest: digestCrossStoreValue({ status, receipt: value }) }
      if (previous !== undefined) {
        if (previous.digest !== next.digest && previous.status === 'committed') {
          throw new CrossStoreLedgerError('RECEIPT_CONFLICT', 'committed receipt cannot be replaced', 409)
        }
        if (previous.digest === next.digest) return { ...publicRecord(current), replayed: true }
      }
      current.receipts[kind] = next
      current.updatedAt = this.now()
      await this.persist()
      return { ...publicRecord(current), replayed: false }
    })
  }

  async businessEffect(principalId, operationId, payload, identity) {
    const payloadDigest = digestCrossStoreValue(payload)
    return await this.exclusive(operationId, async () => {
      const current = this.get(principalId, operationId)
      if (current.intent.payloadDigest !== payloadDigest) throw new CrossStoreLedgerError('OPERATION_ID_REUSED', 'business payload differs from the operation intent', 409)
      const previous = current.receipts.business
      if (previous !== undefined) return { ...publicRecord(current), businessReceipt: clone(previous.receipt), replayed: true }
      if (identity !== undefined) {
        let candidate
        try { candidate = createCrossStoreIdentity(identity) } catch (error) {
          throw new CrossStoreLedgerError('RECEIPT_INVALID', error instanceof Error ? error.message : String(error))
        }
        if (JSON.stringify(candidate) !== JSON.stringify(current.identity)) throw new CrossStoreLedgerError('RECEIPT_IDENTITY_MISMATCH', 'business identity does not match the operation intent', 409)
      }
      current.businessEffectCount += 1
      const businessReceipt = { effectId: randomUUID(), payloadDigest, responseDigest: digestCrossStoreValue({ operationId, payload }) }
      current.receipts.business = { status: 'committed', receipt: businessReceipt, digest: digestCrossStoreValue({ status: 'committed', receipt: businessReceipt }) }
      current.updatedAt = this.now()
      await this.persist()
      return { ...publicRecord(current), businessReceipt, replayed: false }
    })
  }

  query(principalId, operationId) {
    return publicRecord(this.get(principalId, operationId))
  }
}
