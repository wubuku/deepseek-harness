/**
 * Durable ledgers for Browser-Native observability evidence.
 *
 * Access denials and provider usage are appended as one hash-chained JSONL
 * envelope per record under `<dataDir>/observability`; the last aggregate
 * metrics snapshot is rewritten atomically. Each ledger also keeps an
 * atomically rewritten `<file>.head.json` with the newest sequence and hash,
 * so a tail truncation shows up as a head/tail mismatch rather than as a
 * shorter but internally consistent chain. Persistence must never change the
 * response a client already received, so write failures are counted instead of
 * thrown.
 */
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

const JOURNAL_VERSION = 1
/** Envelope format version for chained ledger lines; raw records are v1 data and rejected. */
const LEDGER_VERSION = 2
const GENESIS = 'GENESIS'
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024
const MAX_RESTORED_ACCESS_DENIALS = 200
const MAX_RESTORED_USAGE = 1_000
const MAX_RESTORED_COLLABORATION = 200
const ACCESS_DENIALS_FILE = 'access-denials.jsonl'
const USAGE_FILE = 'usage.jsonl'
const COLLABORATION_FILE = 'session-collaboration.jsonl'
const METRICS_FILE = 'metrics.json'

/**
 * Hash one ledger envelope.
 * @param prev - Previous envelope hash, or {@link GENESIS}.
 * @param seq - Monotonic sequence number.
 * @param record - Persisted record.
 * @returns Lowercase SHA-256 hex digest.
 */
function envelopeHash(prev, seq, record) {
  return createHash('sha256').update(`${prev}\n${seq}\n${JSON.stringify(record)}`).digest('hex')
}

/**
 * Parse one ledger, verifying the chain and its head anchor.
 *
 * A line whose envelope fields or hash do not verify is counted as invalid;
 * its record is still returned so an operator can inspect it. The first
 * broken sequence is reported separately.
 * @param raw - Ledger text.
 * @param head - Parsed head anchor, or `undefined` when the file is absent.
 * @returns Records, limit truncation, invalid lines, and integrity details.
 */
function parseLedger(raw, head, decode = line => line) {
  const lines = raw.split('\n').filter(line => line.length > 0)
  const records = []
  let invalidLines = 0
  let brokenAt
  let seq = 0
  let prev = GENESIS
  let last
  for (const line of lines) {
    let envelope
    try {
      envelope = JSON.parse(decode(line))
    } catch {
      // A torn or hand-edited line is reported through invalidLines; it must not stop boot.
      invalidLines += 1
      continue
    }
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)
      || envelope.v !== LEDGER_VERSION || !Number.isSafeInteger(envelope.seq) || envelope.seq <= 0
      || typeof envelope.prev !== 'string' || typeof envelope.hash !== 'string'
      || envelope.record === null || typeof envelope.record !== 'object' || Array.isArray(envelope.record)) {
      invalidLines += 1
      if (Number.isSafeInteger(envelope?.seq) && envelope.seq > 0) {
        brokenAt ??= envelope.seq
        seq = envelope.seq
        last = envelope
      }
      continue
    }
    const linked = envelope.seq === seq + 1 && envelope.prev === prev
    const hashed = envelope.hash === envelopeHash(prev, envelope.seq, envelope.record)
    if (!linked || !hashed) {
      brokenAt ??= envelope.seq
      invalidLines += 1
    }
    seq = envelope.seq
    prev = envelope.hash
    last = envelope
    records.push(envelope.record)
  }
  const headMatches = head === undefined
    ? lines.length === 0
    : head.seq === last?.seq && head.hash === last?.hash
  if (!headMatches) brokenAt ??= last?.seq
  return {
    records,
    invalidLines,
    tail: last,
    integrity: {
      entries: lines.length,
      invalidLines,
      verified: invalidLines === 0 && headMatches,
      brokenAt,
      headMissing: head === undefined && lines.length > 0,
      headSeq: head?.seq,
      tailSeq: last?.seq,
      truncated: !headMatches,
    },
  }
}

/**
 * Read a ledger file, treating absence as empty text.
 * @param path - Ledger or head path.
 * @returns File contents or the empty string when the file does not exist.
 */
async function readIfExists(path, cipher, context) {
  try {
    return cipher === undefined ? await readFile(path, 'utf8') : await cipher.readText(path, context)
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

/** Encode one ledger line for storage, encrypted when a cipher is configured. */
function encodeLine(cipher, context, text) {
  return `${cipher === undefined ? text : cipher.encryptText(text, context)}\n`
}

/** Decode one stored ledger line, accepting legacy plaintext. */
function decodeLine(cipher, context) {
  return cipher === undefined ? line => line : line => cipher.decryptText(line, context)
}

/**
 * Rewrite both ledgers without matching records and re-anchor their chains.
 *
 * Erasure needs the records gone rather than hidden, so surviving envelopes are
 * re-linked from {@link GENESIS} and both the ledger and its head anchor are
 * replaced atomically. A subsequent restore verifies the new chain; the previous
 * chain is intentionally not retained.
 * @param options - Journal location and record predicate.
 * @param options.dataDir - Backend data directory that owns the journal.
 * @param options.shouldRemove - Predicate receiving the record and ledger name.
 * @returns Removed record counts per ledger.
 */
export async function redactObservabilityJournal({ dataDir, shouldRemove, cipher }) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('observability redaction requires dataDir')
  if (typeof shouldRemove !== 'function') throw new TypeError('observability redaction requires shouldRemove')
  const directory = join(dataDir, 'observability')
  const removed = { accessDenials: 0, usage: 0, collaboration: 0 }
  for (const [file, name] of [[ACCESS_DENIALS_FILE, 'accessDenials'], [USAGE_FILE, 'usage'], [COLLABORATION_FILE, 'collaboration']]) {
    const path = join(directory, file)
    const raw = await readIfExists(path, cipher, `observability/${file}`)
    const parsed = parseLedger(raw, undefined, decodeLine(cipher, `observability/${file}`))
    const kept = []
    for (const record of parsed.records) {
      if (shouldRemove(record, name)) removed[name] += 1
      else kept.push(record)
    }
    if (removed[name] === 0) continue
    let prev = GENESIS
    const rebuilt = []
    for (const [index, record] of kept.entries()) {
      const seq = index + 1
      const hash = envelopeHash(prev, seq, record)
      rebuilt.push(JSON.stringify({ v: LEDGER_VERSION, seq, prev, hash, record }))
      prev = hash
    }
    const temporary = `${path}.${randomUUID()}.tmp`
    const rebuiltText = rebuilt.length === 0 ? '' : rebuilt.map(line => encodeLine(cipher, `observability/${file}`, line)).join('')
    if (cipher === undefined) await writeFile(temporary, rebuiltText, 'utf8')
    else await cipher.writeFile(temporary, rebuiltText, `observability/${file}`)
    await rename(temporary, path)
    const head = join(directory, `${file}.head.json`)
    if (kept.length === 0) {
      await rm(head, { force: true })
    } else {
      const headTemporary = `${head}.${randomUUID()}.tmp`
      const headText = `${JSON.stringify({ version: LEDGER_VERSION, seq: kept.length, hash: prev })}\n`
      if (cipher === undefined) await writeFile(headTemporary, headText, 'utf8')
      else await cipher.writeFile(headTemporary, headText, `observability/${file}.head`)
      await rename(headTemporary, head)
    }
  }
  return removed
}

/**
 * Create the observability journal for one backend data directory.
 * @param options - Journal location and clock.
 * @param options.dataDir - Backend data directory that owns the journal.
 * @param options.now - Clock returning epoch milliseconds.
 * @returns Append, restore, and close operations plus current write health.
 */
export function createObservabilityJournal({ dataDir, now = () => Date.now(), cipher }) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('observability journal requires dataDir')
  const directory = join(dataDir, 'observability')
  const contextFor = file => `observability/${file}`
  let chain = Promise.resolve()
  let healthy = true
  let writeFailures = 0
  let prepared
  /** Newest envelope per ledger, loaded from disk on the first append after a restart. */
  const tails = new Map()

  const prepare = () => {
    prepared ??= mkdir(directory, { recursive: true })
    return prepared
  }

  const headPath = file => join(directory, `${file}.head.json`)

  const writeHead = async state => {
    const path = headPath(state.file)
    const temporary = `${path}.${randomUUID()}.tmp`
    const text = `${JSON.stringify({ version: LEDGER_VERSION, seq: state.seq, hash: state.hash })}\n`
    if (cipher === undefined) await writeFile(temporary, text, 'utf8')
    else await cipher.writeFile(temporary, text, contextFor(`${state.file}.head`))
    await rename(temporary, path)
  }

  const ensureTail = async file => {
    const cached = tails.get(file)
    if (cached !== undefined) return cached
    const parsed = parseLedger(await readIfExists(join(directory, file), cipher, contextFor(file)), undefined,
      decodeLine(cipher, contextFor(file)))
    const tail = parsed.tail
    const state = tail === undefined
      ? { file, seq: 0, hash: GENESIS }
      : { file, seq: tail.seq, hash: tail.hash }
    tails.set(file, state)
    return state
  }

  const append = (file, record) => {
    chain = chain.then(async () => {
      await prepare()
      const path = join(directory, file)
      let size = 0
      try {
        size = (await stat(path)).size
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      if (size > MAX_JOURNAL_BYTES) {
        await rename(path, `${path}.1`)
        tails.set(file, { file, seq: 0, hash: GENESIS })
      }
      const state = await ensureTail(file)
      const seq = state.seq + 1
      const hash = envelopeHash(state.hash, seq, record)
      await appendFile(path, encodeLine(cipher, contextFor(file), JSON.stringify({ v: LEDGER_VERSION, seq, prev: state.hash, hash, record })), 'utf8')
      const next = { file, seq, hash }
      tails.set(file, next)
      await writeHead(next)
    })
    chain = chain.catch(error => {
      healthy = false
      writeFailures += 1
      process.stderr.write(`browser-native observability: ${file} write failed: ${String(error)}\n`)
    })
    return chain
  }

  const readHead = async file => {
    try {
      const text = cipher === undefined
        ? await readFile(headPath(file), 'utf8') : await cipher.readText(headPath(file), contextFor(`${file}.head`))
      const parsed = JSON.parse(text)
      if (parsed?.version !== LEDGER_VERSION || !Number.isSafeInteger(parsed.seq)
        || parsed.seq <= 0 || typeof parsed.hash !== 'string') {
        return { invalid: true }
      }
      return { seq: parsed.seq, hash: parsed.hash }
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      return { invalid: true }
    }
  }

  const readLedger = async (file, limit) => {
    const head = await readHead(file)
    if (head?.invalid === true) {
      const parsed = parseLedger(await readIfExists(join(directory, file), cipher, contextFor(file)), undefined,
        decodeLine(cipher, contextFor(file)))
      return { ...parsed, integrity: { ...parsed.integrity, verified: false, headInvalid: true } }
    }
    const parsed = parseLedger(await readIfExists(join(directory, file), cipher, contextFor(file)), head,
      decodeLine(cipher, contextFor(file)))
    const truncated = parsed.records.length > limit
    return { ...parsed, records: parsed.records.slice(-limit), truncated }
  }

  /**
   * Read back the journals and the last metrics snapshot for restart reconciliation.
   * @returns Restored records, limit/integrity flags, and the previous snapshot when readable.
   */
  const restore = async () => {
    const denials = await readLedger(ACCESS_DENIALS_FILE, MAX_RESTORED_ACCESS_DENIALS)
    const usage = await readLedger(USAGE_FILE, MAX_RESTORED_USAGE)
    const collaboration = await readLedger(COLLABORATION_FILE, MAX_RESTORED_COLLABORATION)
    let metrics
    let metricsError
    try {
      const text = cipher === undefined
        ? await readFile(join(directory, METRICS_FILE), 'utf8')
        : await cipher.readText(join(directory, METRICS_FILE), contextFor(METRICS_FILE))
      const parsed = JSON.parse(text)
      if (parsed?.version !== JOURNAL_VERSION || !Number.isSafeInteger(parsed.capturedAt)
        || parsed.view === null || typeof parsed.view !== 'object' || Array.isArray(parsed.view)) {
        throw new Error('metrics snapshot is not a v1 record')
      }
      metrics = { capturedAt: parsed.capturedAt, view: parsed.view }
    } catch (error) {
      if (error?.code !== 'ENOENT') metricsError = error instanceof Error ? error.message : String(error)
    }
    return {
      accessDenials: denials.records,
      usage: usage.records,
      collaboration: collaboration.records,
      truncated: denials.truncated || usage.truncated || collaboration.truncated,
      invalidLines: denials.invalidLines + usage.invalidLines + collaboration.invalidLines,
      metrics,
      metricsError,
      integrity: {
        accessDenials: denials.integrity,
        usage: usage.integrity,
        collaboration: collaboration.integrity,
        verified: denials.integrity.verified && usage.integrity.verified && collaboration.integrity.verified,
      },
    }
  }

  /**
   * Rewrite the aggregate metrics snapshot atomically.
   * @param view - Metrics view returned to observability readers.
   * @returns Promise resolving after the snapshot is durable or the failure is counted.
   */
  const persistMetrics = view => {
    const payload = `${JSON.stringify({ version: JOURNAL_VERSION, capturedAt: now(), view })}\n`
    chain = chain.then(async () => {
      await prepare()
      const path = join(directory, METRICS_FILE)
      const temporary = `${path}.${randomUUID()}.tmp`
      if (cipher === undefined) await writeFile(temporary, payload, 'utf8')
      else await cipher.writeFile(temporary, payload, contextFor(METRICS_FILE))
      await rename(temporary, path)
    })
    chain = chain.catch(error => {
      healthy = false
      writeFailures += 1
      process.stderr.write(`browser-native observability: metrics snapshot write failed: ${String(error)}\n`)
    })
    return chain
  }

  /**
   * Drop matching records and re-anchor both ledgers without racing appends.
   * @param shouldRemove - Predicate receiving the record and ledger name.
   * @returns Promise resolving to removed record counts per ledger.
   */
  const redact = shouldRemove => {
    const run = chain.then(async () => {
      tails.clear()
      const removed = await redactObservabilityJournal({ dataDir, shouldRemove, cipher })
      await Promise.all([ACCESS_DENIALS_FILE, USAGE_FILE, COLLABORATION_FILE].map(file => ensureTail(file)))
      return removed
    })
    chain = run.then(() => undefined, error => {
      healthy = false
      writeFailures += 1
      process.stderr.write(`browser-native observability: redaction failed: ${String(error)}\n`)
    })
    return run
  }

  return {
    appendAccessDenial: entry => append(ACCESS_DENIALS_FILE, entry),
    appendUsage: entry => append(USAGE_FILE, entry),
    appendCollaboration: entry => append(COLLABORATION_FILE, entry),
    persistMetrics,
    restore,
    redact,
    close: () => chain,
    status: () => ({ healthy, writeFailures, path: directory }),
  }
}
