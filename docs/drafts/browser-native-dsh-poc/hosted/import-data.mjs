#!/usr/bin/env node

/**
 * Restore a hosted data directory from a verified backup bundle.
 *
 * The bundle manifest is checked in full and the stores are checked against this
 * build before anything is written; the target directory must be empty. See
 * hosted-deployment.md for the backup and restore procedure.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importDataDir, describeManifest, BackupError } from './data-backup.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const HELP = `Usage: node docs/drafts/browser-native-dsh-poc/hosted/import-data.mjs --bundle <bundle dir> [options]

Options:
  --bundle <path>    Backup bundle written by export-data.mjs
  --data-dir <path>  Empty target data directory (default: DSH_POC_DATA_DIR)
  --json             Print the restored manifest as JSON
  --help             Show this message

Exit codes: 0 restored, 1 bundle rejected or incompatible, 2 usage error, 4 target not empty.
`

function parseArgs(argv) {
  const values = { bundle: undefined, dataDir: process.env.DSH_POC_DATA_DIR, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return undefined
    if (option === '--json') { values.json = true; continue }
    if (option === '--bundle' || option === '--data-dir') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${option} needs a value`)
      if (option === '--bundle') values.bundle = value
      else values.dataDir = value
      index += 1
      continue
    }
    throw new Error(`unknown option: ${option}`)
  }
  if (values.bundle === undefined || values.dataDir === undefined) throw new Error('--bundle and --data-dir are required')
  return values
}

async function main() {
  const values = parseArgs(process.argv.slice(2))
  if (values === undefined) {
    process.stdout.write(HELP)
    return 0
  }
  const dataDir = values.dataDir === undefined ? join(REPO_ROOT, 'browser-native-data') : resolve(values.dataDir)
  if (!existsSync(values.bundle)) throw new BackupError('BUNDLE_MISSING', `no backup bundle at ${values.bundle}`)
  const { manifest } = await importDataDir({ bundleDir: values.bundle, dataDir })
  if (values.json) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
  } else {
    process.stdout.write(`import-data: restored ${String(manifest.files.length)} files into ${dataDir}\n`)
    process.stdout.write(`import-data: ${describeManifest(manifest)}\n`)
  }
  return 0
}

main().then(code => {
  process.exitCode = code
}, error => {
  process.stderr.write(`import-data: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = error instanceof BackupError
    ? { TARGET_NOT_EMPTY: 4 }[error.code] ?? 1
    : 2
})
