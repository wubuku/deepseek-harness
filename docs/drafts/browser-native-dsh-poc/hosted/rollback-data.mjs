#!/usr/bin/env node

/**
 * Roll a stopped hosted browser-native data directory back to a versioned
 * backup bundle.
 *
 * The bundle is fully verified, imported into a staging sibling, and only then
 * swapped into place. A damaged or newer bundle is refused before the current
 * directory is renamed, and the pre-rollback directory is preserved rather
 * than deleted.
 */
import { existsSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importDataDir, inspectBackupManifest } from './data-backup.mjs'
import { CURRENT_DATASET_VERSION, DataFormatError } from './data-format.mjs'

const BACKEND_LOCK_NAME = '.browser-native-backend.lock'

const HELP = `Usage: node docs/drafts/browser-native-dsh-poc/hosted/rollback-data.mjs --data-dir <path> --bundle <path>

Stops required: the backend must not hold the data directory lock.
The bundle must record its dataset generation and must not be newer than this build.
Exit codes: 0 rolled back, 1 refused or failed, 2 usage error.
`

/** Timestamp suffix safe for directory names. */
function stampOf(now) {
  return new Date(now()).toISOString().replaceAll(':', '-').replace('.', '-')
}

/**
 * Replace a data directory with the contents of a versioned backup.
 * @param request - `dataDir`, `bundleDir`, and an optional `now` clock.
 * @returns Rollback summary with the preserved previous directory.
 * @throws DataFormatError when the backend runs, the bundle is unversioned or too new, or the swap fails.
 */
export async function rollbackDataDir({ dataDir, bundleDir, now = Date.now }) {
  const target = resolve(dataDir)
  const bundle = resolve(bundleDir)
  if (!existsSync(target)) throw new DataFormatError('DATA_DIR_MISSING', `no data directory at ${target}`)
  if (existsSync(join(target, BACKEND_LOCK_NAME))) {
    throw new DataFormatError('BACKEND_RUNNING', 'stop the backend before rolling back; the data directory lock is held')
  }
  const manifest = await inspectBackupManifest(bundle)
  if (manifest.dataset === undefined) {
    throw new DataFormatError('BACKUP_UNVERSIONED', `backup ${bundle} records no dataset generation; recreate it with export-data`, { bundleDir: bundle })
  }
  if (manifest.dataset.version > CURRENT_DATASET_VERSION) {
    throw new DataFormatError(
      'BACKUP_TOO_NEW',
      `backup records dataset v${String(manifest.dataset.version)}; this build reads v${String(CURRENT_DATASET_VERSION)}`,
      { version: manifest.dataset.version, supported: CURRENT_DATASET_VERSION },
    )
  }

  const stamp = stampOf(now)
  const staging = `${target}.rollback-staging-${stamp}`
  const preserved = `${target}.pre-rollback-${stamp}`
  if (existsSync(staging) || existsSync(preserved)) {
    throw new DataFormatError('ROLLBACK_TARGET_EXISTS', `staging or preserved directory already exists for ${stamp}`, { staging, preserved })
  }

  await importDataDir({ bundleDir: bundle, dataDir: staging })
  await rename(target, preserved)
  try {
    await rename(staging, target)
  } catch (error) {
    await rename(preserved, target).catch(() => undefined)
    throw new DataFormatError(
      'ROLLBACK_SWAP_FAILED',
      `could not move the restored directory into place; the previous directory is at ${preserved}`,
      { bundleDir: bundle, preservedDir: preserved, error: error.message },
    )
  }
  return {
    status: 'rolled-back',
    datasetVersion: manifest.dataset.version,
    bundleDir: bundle,
    files: manifest.files.length,
    preservedDir: preserved,
  }
}

/** Parse the two required arguments. */
function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return undefined
    if (option === '--data-dir' || option === '--bundle') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${option} needs a value`)
      values[option === '--data-dir' ? 'dataDir' : 'bundleDir'] = value
      index += 1
      continue
    }
    throw new Error(`unknown option: ${option}`)
  }
  if (values.dataDir === undefined) throw new Error('--data-dir is required')
  if (values.bundleDir === undefined) throw new Error('--bundle is required')
  return values
}

/** Run the rollback and print one JSON summary. */
async function main() {
  const values = parseArgs(process.argv.slice(2))
  if (values === undefined) {
    process.stdout.write(HELP)
    return 0
  }
  const summary = await rollbackDataDir(values)
  process.stdout.write(`${JSON.stringify(summary)}\n`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => {
    process.exitCode = code
  }, error => {
    process.stderr.write(`rollback-data: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
