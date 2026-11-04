/**
 * Durable retry-intent ledger for failed or interrupted turns.
 *
 * A retry is keyed by the failed Session, its turn number, and the original
 * prompt, so a duplicated request (a double click, or two tabs) returns the
 * first record instead of scheduling a second turn. Settlement is also
 * idempotent: the first call stamps `settledAt`, later calls report a duplicate
 * and never move the timestamp. Records live in one JSON file per intent under
 * the PoC data directory and are written through a temporary file plus rename.
 *
 * This is a PoC-local single-process store. It deliberately does not claim
 * cross-process atomicity or multi-host idempotency.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_IDENTIFIER_LENGTH = 128
const MAX_PROMPT_CHARACTERS = 16_384

function assertIdentifier(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new TypeError(`turn retry ${name} must be a non-empty string of at most ${MAX_IDENTIFIER_LENGTH} characters`)
  }
}

function assertTurn(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('turn retry turn must be a positive integer')
  }
}

function assertPrompt(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PROMPT_CHARACTERS) {
    throw new TypeError(`turn retry prompt must be a non-empty string of at most ${MAX_PROMPT_CHARACTERS} characters`)
  }
}

/** One durable retry intent. */
export class TurnRetryLedger {
  #dir
  #now
  #queue = Promise.resolve()

  /**
   * Create a ledger rooted at `dir`; no files are touched until `load`.
   * @param {{ dir: string, now?: () => number }} options - storage root and clock.
   */
  constructor({ dir, now = Date.now }) {
    this.#dir = dir
    this.#now = now
  }

  /** Create the storage root. */
  async load() {
    await mkdir(this.#dir, { recursive: true })
  }

  /**
   * Run one filesystem mutation at a time so concurrent requests cannot both
   * observe a missing record and both report creation.
   * @param {() => Promise<object>} operation - queued unit of work.
   * @returns {Promise<object>} the operation result.
   */
  #serial(operation) {
    const next = this.#queue.then(operation, operation)
    this.#queue = next.then(() => undefined, () => undefined)
    return next
  }

  #path(retryId) {
    return join(this.#dir, `${retryId}.json`)
  }

  async #read(retryId) {
    try {
      return JSON.parse(await readFile(this.#path(retryId), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  }

  async #write(record) {
    const target = this.#path(record.retryId)
    const temporary = `${target}.tmp`
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }

  /**
   * Record a retry intent, or return the existing intent for the same failed turn.
   * @param {{ sessionId: string, turn: number, prompt: string }} intent - failed turn identity.
   * @returns {Promise<{ created: boolean, record: object }>} creation flag and durable record.
   */
  async request({ sessionId, turn, prompt }) {
    assertIdentifier(sessionId, 'sessionId')
    assertTurn(turn)
    assertPrompt(prompt)
    const retryId = createHash('sha256')
      .update(`${sessionId}\u0000${turn}\u0000${prompt}`)
      .digest('hex')
      .slice(0, 32)
    return await this.#serial(async () => {
      const existing = await this.#read(retryId)
      if (existing !== undefined) return { created: false, record: existing }
      const record = {
        retryId,
        sessionId,
        turn,
        prompt,
        requestedAt: this.#now(),
        settledAt: null,
      }
      await this.#write(record)
      return { created: true, record }
    })
  }

  /**
   * Read one intent by identity.
   * @param {{ retryId: string }} query - retry identity.
   * @returns {Promise<object | undefined>} the record, or undefined when absent.
   */
  async get({ retryId }) {
    assertIdentifier(retryId, 'retryId')
    return await this.#read(retryId)
  }

  /**
   * Mark a retry attempt settled exactly once.
   * @param {{ retryId: string }} request - retry identity.
   * @returns {Promise<{ settled: boolean, record: object }>} settlement flag and durable record.
   */
  async settle({ retryId }) {
    assertIdentifier(retryId, 'retryId')
    return await this.#serial(async () => {
      const record = await this.#read(retryId)
      if (record === undefined) throw new RangeError(`turn retry ${retryId} is unknown`)
      if (record.settledAt !== null) return { settled: false, record }
      record.settledAt = this.#now()
      await this.#write(record)
      return { settled: true, record }
    })
  }

  /**
   * List retry intents for one session, oldest first.
   * @param {{ sessionId: string }} query - session filter.
   * @returns {Promise<object[]>} matching durable records.
   */
  async list({ sessionId }) {
    assertIdentifier(sessionId, 'sessionId')
    const files = await readdir(this.#dir)
    const records = []
    for (const name of files) {
      if (!name.endsWith('.json')) continue
      try {
        const record = JSON.parse(await readFile(join(this.#dir, name), 'utf8'))
        if (record.sessionId === sessionId) records.push(record)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    return records.sort((left, right) => left.requestedAt - right.requestedAt)
  }
}
