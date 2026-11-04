/**
 * Durable ledgers for Browser-Native observability evidence.
 *
 * Access denials and provider usage are appended as JSONL under
 * `<dataDir>/observability`, and the last aggregate metrics snapshot is
 * rewritten atomically. Persistence must never change the response a client
 * already received, so write failures are counted instead of thrown.
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const JOURNAL_VERSION = 1
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024
const MAX_RESTORED_ACCESS_DENIALS = 200
const MAX_RESTORED_USAGE = 1_000
const ACCESS_DENIALS_FILE = 'access-denials.jsonl'
const USAGE_FILE = 'usage.jsonl'
const METRICS_FILE = 'metrics.json'

/**
 * Parse a JSONL journal, keeping only object records and the newest entries.
 * @param raw - Journal text.
 * @param limit - Maximum number of newest records to keep.
 * @returns Parsed records plus truncation and invalid-line counts.
 */
function parseJournal(raw, limit) {
  const lines = raw.split('\n').filter(line => line.length > 0)
  const records = []
  let invalidLines = 0
  for (const line of lines) {
    try {
      const record = JSON.parse(line)
      if (record === null || typeof record !== 'object' || Array.isArray(record)) invalidLines += 1
      else records.push(record)
    } catch {
      // A torn or hand-edited line is reported through invalidLines; it must not stop boot.
      invalidLines += 1
    }
  }
  const truncated = records.length > limit
  return { records: records.slice(-limit), truncated, invalidLines }
}

/**
 * Create the observability journal for one backend data directory.
 * @param options - Journal location and clock.
 * @param options.dataDir - Backend data directory that owns the journal.
 * @param options.now - Clock returning epoch milliseconds.
 * @returns Append, restore, and close operations plus current write health.
 */
export function createObservabilityJournal({ dataDir, now = () => Date.now() }) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('observability journal requires dataDir')
  const directory = join(dataDir, 'observability')
  let chain = Promise.resolve()
  let healthy = true
  let writeFailures = 0
  let prepared

  const prepare = () => {
    prepared ??= mkdir(directory, { recursive: true })
    return prepared
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
      if (size > MAX_JOURNAL_BYTES) await rename(path, `${path}.1`)
      await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
    })
    chain = chain.catch(error => {
      healthy = false
      writeFailures += 1
      process.stderr.write(`browser-native observability: ${file} write failed: ${String(error)}\n`)
    })
    return chain
  }

  const readIfExists = async path => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return ''
      throw error
    }
  }

  /**
   * Read back the journals and the last metrics snapshot for restart reconciliation.
   * @returns Restored records, truncation/invalid flags, and the previous snapshot when readable.
   */
  const restore = async () => {
    const denials = parseJournal(await readIfExists(join(directory, ACCESS_DENIALS_FILE)), MAX_RESTORED_ACCESS_DENIALS)
    const usage = parseJournal(await readIfExists(join(directory, USAGE_FILE)), MAX_RESTORED_USAGE)
    let metrics
    let metricsError
    try {
      const parsed = JSON.parse(await readFile(join(directory, METRICS_FILE), 'utf8'))
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
      truncated: denials.truncated || usage.truncated,
      invalidLines: denials.invalidLines + usage.invalidLines,
      metrics,
      metricsError,
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
      await writeFile(temporary, payload, 'utf8')
      await rename(temporary, path)
    })
    chain = chain.catch(error => {
      healthy = false
      writeFailures += 1
      process.stderr.write(`browser-native observability: metrics snapshot write failed: ${String(error)}\n`)
    })
    return chain
  }

  return {
    appendAccessDenial: entry => append(ACCESS_DENIALS_FILE, entry),
    appendUsage: entry => append(USAGE_FILE, entry),
    persistMetrics,
    restore,
    close: () => chain,
    status: () => ({ healthy, writeFailures, path: directory }),
  }
}
