/**
 * Compressed cold storage for inactive Browser-Native Sessions.
 *
 * Active Sessions live as one JSON file each under `sessions/` and are parsed
 * in full at startup. Sessions that have left the active working set are moved
 * to `<dataDir>/archives-v1/<id>.json.gz`; only a small metadata index is read
 * at startup, so list and retention queries still see them while their events
 * stay compressed on disk until a read, open, export, or durable turn needs
 * them.
 *
 * Every archive file is one gzip envelope containing the durable Session record
 * and the attachment objects the Session references, so restoring a Session
 * also restores its attachment bytes when the live Workspace objects are gone.
 * When at-rest encryption is configured, both the archive file and the index
 * use the same envelope format as Session files.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import { applyStorageFault } from './storage-fault.mjs'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

/** Fixed on-disk archive format version. */
export const SESSION_ARCHIVE_VERSION = 1
const ARCHIVE_DIRECTORY = 'archives-v1'
const INDEX_NAME = 'index.json'

/**
 * Root of compressed Session storage.
 * @param dataDir - Backend data directory.
 * @returns Archive directory path.
 */
export function archiveDirectory(dataDir) {
  return join(dataDir, ARCHIVE_DIRECTORY)
}

/**
 * Compressed archive file for one Session.
 * @param dataDir - Backend data directory.
 * @param id - Session id.
 * @returns Archive file path.
 */
export function archiveFilePath(dataDir, id) {
  return join(archiveDirectory(dataDir), `${id}.json.gz`)
}

function archiveIndexPath(dataDir) {
  return join(archiveDirectory(dataDir), INDEX_NAME)
}

async function readBytes(path, cipher, context) {
  try {
    return cipher === undefined ? await readFile(path) : await cipher.readFile(path, context)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function writeAtomic(path, bytes, { cipher, context, storageFault, mode = 0o600 }) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await applyStorageFault(storageFault, 'archive')
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    if (cipher === undefined) await writeFile(temporary, bytes, { mode })
    else await cipher.writeFile(temporary, bytes, context, mode)
    const file = await open(temporary, 'r+')
    try {
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Read the archive metadata index without decompressing any Session.
 *
 * A missing index means no Session has been archived. A present but invalid
 * index fails startup explicitly; skipping it would hide archived Sessions.
 * @param dataDir - Backend data directory.
 * @param options - Optional at-rest cipher and storage fault hook.
 * @returns `{ version, entries }` with one metadata entry per archived Session.
 */
export async function readArchiveIndex(dataDir, { cipher } = {}) {
  const prefix = 'archive-index/'
  const raw = await readBytes(archiveIndexPath(dataDir), cipher, `${prefix}${INDEX_NAME}`)
  if (raw === undefined) return { version: SESSION_ARCHIVE_VERSION, entries: [] }
  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    throw new BackendError('SESSION_ARCHIVE_INDEX_INVALID', `archive index is not valid JSON: ${String(error)}`, 500)
  }
  if (parsed?.version !== SESSION_ARCHIVE_VERSION || !Array.isArray(parsed.entries)) {
    throw new BackendError('SESSION_ARCHIVE_INDEX_INVALID', 'archive index has an unsupported format', 500)
  }
  for (const entry of parsed.entries) {
    if (typeof entry?.id !== 'string' || entry.id.length === 0
      || typeof entry.header !== 'object' || entry.header === null
      || !Number.isSafeInteger(entry.eventCount) || entry.eventCount < 0
      || typeof entry.revision !== 'string'
      || !Number.isSafeInteger(entry.archivedAt) || entry.archivedAt < 0) {
      throw new BackendError('SESSION_ARCHIVE_INDEX_INVALID', 'archive index contains an invalid entry', 500)
    }
  }
  return { version: SESSION_ARCHIVE_VERSION, entries: parsed.entries }
}

/**
 * Replace the archive metadata index atomically.
 * @param dataDir - Backend data directory.
 * @param entries - Metadata entries for every archived Session.
 * @param options - Optional at-rest cipher and storage fault hook.
 * @returns Resolves after the new index is durable.
 */
export async function writeArchiveIndex(dataDir, entries, { cipher, storageFault } = {}) {
  const ordered = [...entries].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  const bytes = Buffer.from(`${JSON.stringify({ version: SESSION_ARCHIVE_VERSION, entries: ordered })}\n`)
  await applyStorageFault(storageFault, 'archive-index')
  await writeAtomic(archiveIndexPath(dataDir), bytes, {
    cipher,
    context: `archive-index/${INDEX_NAME}`,
    storageFault: undefined,
  })
}

/**
 * Write one compressed archive envelope.
 * @param dataDir - Backend data directory.
 * @param id - Session id.
 * @param payload - `{ archivedAt, session, attachments }`.
 * @param options - Optional at-rest cipher and storage fault hook.
 * @returns Compressed byte count.
 */
export async function writeArchivedSession(dataDir, id, payload, { cipher, storageFault } = {}) {
  const bytes = await gzipAsync(Buffer.from(JSON.stringify({
    version: SESSION_ARCHIVE_VERSION,
    ...payload,
  })))
  await writeAtomic(archiveFilePath(dataDir, id), bytes, {
    cipher,
    context: `archive/${id}.json.gz`,
    storageFault,
  })
  return bytes.byteLength
}

/**
 * Read and decompress one archive envelope.
 * @param dataDir - Backend data directory.
 * @param id - Session id.
 * @param options - Optional at-rest cipher.
 * @returns `{ archivedAt, session, attachments }`.
 */
export async function readArchivedSession(dataDir, id, { cipher } = {}) {
  const raw = await readBytes(archiveFilePath(dataDir, id), cipher, `archive/${id}.json.gz`)
  if (raw === undefined) {
    throw new BackendError('SESSION_ARCHIVE_MISSING', 'archived Session file is missing', 404)
  }
  let parsed
  try {
    parsed = JSON.parse((await gunzipAsync(raw)).toString('utf8'))
  } catch (error) {
    throw new BackendError('SESSION_ARCHIVE_INVALID', `archived Session is not readable: ${String(error)}`, 500)
  }
  if (parsed?.version !== SESSION_ARCHIVE_VERSION || parsed.session?.id !== id || !Array.isArray(parsed.attachments)) {
    throw new BackendError('SESSION_ARCHIVE_INVALID', 'archived Session has an unsupported format', 500)
  }
  return { archivedAt: parsed.archivedAt, session: parsed.session, attachments: parsed.attachments }
}

/**
 * Typed HTTP failure used by archive readers.
 *
 * @internal Archive storage is read during request handling, so failures must
 * carry the same status and code fields as `BackendError` without importing
 * the backend module and creating a cycle.
 */
class BackendError extends Error {
  constructor(code, message, status) {
    super(message)
    this.name = 'BackendError'
    this.code = code
    this.status = status
  }
}
