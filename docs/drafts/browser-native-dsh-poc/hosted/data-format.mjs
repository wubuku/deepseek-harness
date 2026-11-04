/**
 * Versioned dataset marker for hosted browser-native DSH.
 *
 * A data directory records the store generations it was last upgraded to in
 * `data-format.json`. The backend refuses to start on a newer marker, and the
 * upgrade/rollback scripts use the marker plus a versioned backup bundle to
 * make a format change reversible. Older directories without a marker are read
 * as version 1 and are only stamped when an upgrade runs.
 */
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Marker file holding the dataset generation and the store versions it implies. */
export const DATA_FORMAT_FILE_NAME = 'data-format.json'
/** Dataset generation this build writes and reads. */
export const CURRENT_DATASET_VERSION = 2
/** Generation implied by a directory written before the marker existed. */
export const LEGACY_DATASET_VERSION = 1
/** Session log format this build reads; mirrors `SESSION_FORMAT_VERSION` in `packages/core/session/src/types.ts`. */
export const SESSION_FORMAT_VERSION = 4
/** Share-file version written by {@link SessionShareStore}; v1 files are upgraded in place. */
export const SHARE_FILE_VERSION = 2

/** Typed failure for unreadable or newer dataset markers. */
export class DataFormatError extends Error {
  /**
   * @param {string} code - Stable failure code.
   * @param {string} message - Operator-facing message.
   * @param {object} [details] - Machine-readable context.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DataFormatError'
    this.code = code
    this.details = details
  }
}

/** Validate one marker object and return a normalized copy. */
function normalizedMarker(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DataFormatError('DATA_FORMAT_INVALID', `${DATA_FORMAT_FILE_NAME} must be an object`)
  }
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    throw new DataFormatError('DATA_FORMAT_INVALID', `${DATA_FORMAT_FILE_NAME} has no valid version`)
  }
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    throw new DataFormatError('DATA_FORMAT_INVALID', `${DATA_FORMAT_FILE_NAME} has no valid createdAt`)
  }
  return value
}

/**
 * Read a data directory's dataset marker.
 * @param dataDir - Data directory to inspect.
 * @returns The recorded marker, or an inferred v1 marker when the file is absent.
 */
export async function readDataFormat(dataDir) {
  const path = join(dataDir, DATA_FORMAT_FILE_NAME)
  if (!existsSync(path)) {
    return {
      version: LEGACY_DATASET_VERSION,
      inferred: true,
      sessionFormatVersion: SESSION_FORMAT_VERSION,
      shareFileVersion: 1,
    }
  }
  let parsed
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new DataFormatError('DATA_FORMAT_INVALID', `${DATA_FORMAT_FILE_NAME} is not valid JSON: ${error.message}`)
  }
  return normalizedMarker(parsed)
}

/**
 * Build the marker this build writes after an upgrade.
 * @param changedFrom - Dataset generation the directory was upgraded from.
 * @returns Marker fields with the current dataset and store versions.
 */
export function currentDataFormat(changedFrom = LEGACY_DATASET_VERSION) {
  const createdAt = new Date().toISOString()
  return {
    version: CURRENT_DATASET_VERSION,
    sessionFormatVersion: SESSION_FORMAT_VERSION,
    shareFileVersion: SHARE_FILE_VERSION,
    createdAt,
    upgradedFrom: changedFrom,
  }
}

/**
 * Write the dataset marker atomically.
 * @param dataDir - Data directory to stamp.
 * @param format - Marker object, usually from {@link currentDataFormat}.
 */
export async function writeDataFormat(dataDir, format) {
  const path = join(dataDir, DATA_FORMAT_FILE_NAME)
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(format, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

/**
 * Refuse to run on a dataset generation this build does not read.
 *
 * Called before the backend takes the data directory lock so a newer dataset
 * is refused without creating or changing any file.
 * @param dataDir - Data directory the backend would serve.
 * @returns The readable marker.
 * @throws DataFormatError when the marker is newer than this build or malformed.
 */
export async function assertDataFormatReadable(dataDir) {
  const format = await readDataFormat(dataDir)
  if (format.version > CURRENT_DATASET_VERSION) {
    throw new DataFormatError(
      'DATA_FORMAT_TOO_NEW',
      `data directory records dataset v${String(format.version)}; this build reads v${String(CURRENT_DATASET_VERSION)}. Roll back to a versioned backup before starting this build`,
      { version: format.version, supported: CURRENT_DATASET_VERSION },
    )
  }
  return format
}
