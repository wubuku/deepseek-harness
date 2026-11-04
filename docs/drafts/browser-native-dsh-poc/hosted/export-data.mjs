#!/usr/bin/env node

/**
 * Export a stopped hosted data directory into a verifiable backup bundle.
 *
 * See hosted-deployment.md for the backup and restore procedure.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportDataDir, describeManifest, BackupError } from './data-backup.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const HELP = `Usage: node docs/drafts/browser-native-dsh-poc/hosted/export-data.mjs --out <bundle dir> [options]

Options:
  --data-dir <path>  Data directory to export (default: DSH_POC_DATA_DIR)
  --out <path>       New bundle directory; must be empty and outside the data directory
  --json             Print the manifest as JSON
  --help             Show this message

Exit codes: 0 exported, 1 export failed, 2 usage error, 3 backend running, 4 output not empty.
`

function parseArgs(argv) {
  const values = { dataDir: process.env.DSH_POC_DATA_DIR, out: undefined, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return undefined
    if (option === '--json') { values.json = true; continue }
    if (option === '--data-dir' || option === '--out') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${option} needs a value`)
      if (option === '--data-dir') values.dataDir = value
      else values.out = value
      index += 1
      continue
    }
    throw new Error(`unknown option: ${option}`)
  }
  if (values.dataDir === undefined || values.out === undefined) throw new Error('--data-dir and --out are required')
  return values
}

async function main() {
  const values = parseArgs(process.argv.slice(2))
  if (values === undefined) {
    process.stdout.write(HELP)
    return 0
  }
  const dataDir = values.dataDir === undefined ? join(REPO_ROOT, 'browser-native-data') : resolve(values.dataDir)
  if (!existsSync(dataDir)) throw new BackupError('DATA_DIR_MISSING', `no data directory at ${dataDir}`)
  const manifest = await exportDataDir({ dataDir, outputDir: values.out })
  if (values.json) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
  } else {
    process.stdout.write(`export-data: wrote ${String(manifest.files.length)} files to ${resolve(values.out)}\n`)
    process.stdout.write(`export-data: ${describeManifest(manifest)}\n`)
  }
  return 0
}

main().then(code => {
  process.exitCode = code
}, error => {
  process.stderr.write(`export-data: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = error instanceof BackupError
    ? { BACKEND_RUNNING: 3, OUTPUT_NOT_EMPTY: 4 }[error.code] ?? 1
    : 2
})
