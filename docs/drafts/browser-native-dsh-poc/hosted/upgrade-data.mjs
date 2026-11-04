#!/usr/bin/env node

/**
 * Upgrade a stopped hosted browser-native data directory one dataset
 * generation at a time.
 *
 * The script first writes a versioned backup bundle outside the data directory,
 * then applies every registered migration whose source generation is still
 * below the current one, then stamps `data-format.json`. If a migration throws,
 * the data directory is replaced by the verified backup and the partial
 * directory is preserved for diagnosis, so a failed upgrade never leaves a
 * half-migrated directory that the backend would serve.
 */
import { existsSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportDataDir, importDataDir } from './data-backup.mjs'
import {
  CURRENT_DATASET_VERSION, DataFormatError, currentDataFormat, readDataFormat, writeDataFormat,
} from './data-format.mjs'
import { SessionShareStore } from '../session-shares.mjs'

const BACKEND_LOCK_NAME = '.browser-native-backend.lock'

const HELP = `Usage: node docs/drafts/browser-native-dsh-poc/hosted/upgrade-data.mjs --data-dir <path> --backup-root <path>

Stops required: the backend must not hold the data directory lock.
Exit codes: 0 upgraded or already current, 1 refused or failed, 2 usage error.
`

/**
 * Migrations keyed by their source generation. Each `apply` receives the
 * stopped data directory and returns JSON-serializable evidence.
 */
export const DEFAULT_MIGRATIONS = [
  {
    id: 'session-shares-v2',
    from: 1,
    to: 2,
    apply: async ({ dataDir }) => {
      const path = join(dataDir, 'session-shares.json')
      if (!existsSync(path)) return { changed: false, reason: 'no share file' }
      const store = new SessionShareStore(dataDir)
      await store.load()
      await store.save()
      return { changed: true, shareFileVersion: 2 }
    },
  },
]

/** Timestamp suffix safe for directory names. */
function stampOf(now) {
  return new Date(now()).toISOString().replaceAll(':', '-').replace('.', '-')
}

/**
 * Upgrade a stopped data directory to the current dataset generation.
 * @param request - `dataDir`, `backupRoot`, optional `now` clock, and optional migration list for tests.
 * @returns Upgrade summary with the backup path and per-step evidence.
 * @throws DataFormatError when the directory is newer, needs an unregistered migration, or a step fails.
 */
export async function upgradeDataDir({ dataDir, backupRoot, now = Date.now, migrations = DEFAULT_MIGRATIONS }) {
  const source = resolve(dataDir)
  if (!existsSync(source)) throw new DataFormatError('DATA_DIR_MISSING', `no data directory at ${source}`)
  if (existsSync(join(source, BACKEND_LOCK_NAME))) {
    throw new DataFormatError('BACKEND_RUNNING', 'stop the backend before upgrading; the data directory lock is held')
  }
  const format = await readDataFormat(source)
  if (format.version > CURRENT_DATASET_VERSION) {
    throw new DataFormatError(
      'DATA_FORMAT_TOO_NEW',
      `data directory records dataset v${String(format.version)}; this build upgrades only to v${String(CURRENT_DATASET_VERSION)}`,
      { version: format.version, supported: CURRENT_DATASET_VERSION },
    )
  }
  if (format.version === CURRENT_DATASET_VERSION) {
    return { status: 'up-to-date', from: format.version, to: format.version, backupDir: null, steps: [] }
  }

  const required = []
  for (let expected = format.version; expected < CURRENT_DATASET_VERSION; expected += 1) {
    const step = migrations.find(candidate => candidate.from === expected)
    if (step === undefined || step.to !== expected + 1) {
      throw new DataFormatError('DATA_FORMAT_NO_MIGRATION', `no migration from dataset v${String(expected)} to v${String(expected + 1)}`, { from: expected })
    }
    required.push(step)
  }

  const stamp = stampOf(now)
  const targetRoot = resolve(backupRoot)
  await mkdir(targetRoot, { recursive: true })
  let backupDir = join(targetRoot, `dsh-data-v${String(format.version)}-${stamp}`)
  for (let suffix = 2; existsSync(backupDir); suffix += 1) {
    backupDir = join(targetRoot, `dsh-data-v${String(format.version)}-${stamp}-${String(suffix)}`)
  }
  const backupManifest = await exportDataDir({ dataDir: source, outputDir: backupDir })

  const completed = []
  try {
    for (const step of required) {
      completed.push({ id: step.id, from: step.from, to: step.to, ...await step.apply({ dataDir: source, format, backupDir }) })
    }
  } catch (error) {
    const failed = required[completed.length]
    const preservedDir = `${source}.upgrade-failed-${stamp}`
    await rename(source, preservedDir)
    try {
      await importDataDir({ bundleDir: backupDir, dataDir: source })
    } catch (restoreError) {
      await rename(preservedDir, source)
      throw new DataFormatError(
        'UPGRADE_FAILED_RESTORE_FAILED',
        `migration ${failed.id} failed and the backup could not be restored; recover from ${backupDir}`,
        { failedStep: failed.id, backupDir, preservedDir, migrationError: error.message, restoreError: restoreError.message },
      )
    }
    throw new DataFormatError(
      'UPGRADE_FAILED_ROLLED_BACK',
      `migration ${failed.id} failed (${error.message}); the data directory was restored from ${backupDir}`,
      { failedStep: failed.id, backupDir, preservedDir, migrationError: error.message, completedSteps: completed },
    )
  }

  const marker = {
    ...currentDataFormat(format.version),
    backup: resolve(backupDir),
    steps: completed.map(step => ({ id: step.id, to: step.to, changed: step.changed !== false })),
  }
  await writeDataFormat(source, marker)
  return {
    status: 'upgraded',
    from: format.version,
    to: CURRENT_DATASET_VERSION,
    backupDir: resolve(backupDir),
    backupFiles: backupManifest.files.length,
    steps: completed,
  }
}

/** Parse the two required arguments. */
function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return undefined
    if (option === '--data-dir' || option === '--backup-root') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${option} needs a value`)
      values[option === '--data-dir' ? 'dataDir' : 'backupRoot'] = value
      index += 1
      continue
    }
    throw new Error(`unknown option: ${option}`)
  }
  if (values.dataDir === undefined) throw new Error('--data-dir is required')
  if (values.backupRoot === undefined) throw new Error('--backup-root is required')
  return values
}

/** Run the upgrade and print one JSON summary. */
async function main() {
  const values = parseArgs(process.argv.slice(2))
  if (values === undefined) {
    process.stdout.write(HELP)
    return 0
  }
  const summary = await upgradeDataDir(values)
  process.stdout.write(`${JSON.stringify(summary)}\n`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => {
    process.exitCode = code
  }, error => {
    process.stderr.write(`upgrade-data: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
