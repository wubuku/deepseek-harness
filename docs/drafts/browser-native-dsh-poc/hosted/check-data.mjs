#!/usr/bin/env node

/**
 * Read-only compatibility check for a hosted data directory.
 *
 * Reports the Session log format, Workspace metadata version, identity metadata,
 * storage layout, and backend lock so an operator can decide whether this build
 * can start on the directory before upgrading. It never writes, migrates, or
 * deletes data.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SESSION_FORMAT_VERSION = 4
const WORKSPACE_METADATA_VERSION = 1
const IDENTITY_METADATA_VERSION = 1
const CROSS_STORE_LEDGER_VERSION = 1
const BACKEND_LOCK_NAME = '.browser-native-backend.lock'

const HELP = `Usage: node docs/drafts/browser-native-dsh-poc/hosted/check-data.mjs [options]

Options:
  --data-dir <path>  Data directory to inspect (default: DSH_POC_DATA_DIR or ./browser-native-data)
  --json             Print the report as JSON
  --help             Show this message

Exit codes: 0 compatible, 1 incompatible, 2 missing data directory or usage error.
`

/** Parse the two supported arguments without accepting unknown options. */
function parseArgs(argv) {
  const values = { dataDir: process.env.DSH_POC_DATA_DIR, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return undefined
    if (option === '--json') {
      values.json = true
      continue
    }
    if (option === '--data-dir') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--data-dir needs a value')
      values.dataDir = value
      index += 1
      continue
    }
    throw new Error(`unknown option: ${option}`)
  }
  return values
}

/** Parse one JSON file, reporting unreadable files instead of throwing. */
async function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(await readFile(path, 'utf8')) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Scan Session logs and classify their header format version. */
async function checkSessions(dataDir) {
  const directory = join(dataDir, 'sessions')
  const result = { total: 0, supported: 0, unsupported: [], invalid: [] }
  if (!existsSync(directory)) return result
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    result.total += 1
    const parsed = await readJson(join(directory, entry.name))
    const version = parsed.ok ? parsed.value?.header?.version : undefined
    if (parsed.ok && version === SESSION_FORMAT_VERSION) {
      result.supported += 1
      continue
    }
    const id = parsed.ok && typeof parsed.value?.id === 'string' ? parsed.value.id : entry.name.slice(0, -'.json'.length)
    if (parsed.ok && typeof version === 'number') result.unsupported.push({ id, version })
    else result.invalid.push({ id, reason: parsed.ok ? 'missing header.version' : parsed.error })
  }
  return result
}

/** Scan Workspace metadata files and classify their recorded version. */
async function checkWorkspaces(dataDir) {
  const directory = join(dataDir, 'workspace-v2', 'workspaces')
  const result = { total: 0, supported: 0, unsupported: [], invalid: [] }
  if (!existsSync(directory)) return result
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    result.total += 1
    const parsed = await readJson(join(directory, entry.name))
    const version = parsed.ok ? parsed.value?.version : undefined
    if (parsed.ok && version === WORKSPACE_METADATA_VERSION) {
      result.supported += 1
      continue
    }
    const id = entry.name.slice(0, -'.json'.length)
    if (parsed.ok && typeof version === 'number') result.unsupported.push({ id, version })
    else result.invalid.push({ id, reason: parsed.ok ? 'missing version' : parsed.error })
  }
  return result
}

/** Read the identity metadata version without treating absence as a failure. */
async function checkIdentity(dataDir) {
  const path = join(dataDir, 'workspace-v2', 'identities.json')
  if (!existsSync(path)) return { present: false, supported: true }
  const parsed = await readJson(path)
  if (!parsed.ok) return { present: true, supported: false, reason: parsed.error }
  if (parsed.value?.version !== IDENTITY_METADATA_VERSION) {
    return { present: true, supported: false, version: parsed.value?.version ?? null }
  }
  return { present: true, supported: true, version: IDENTITY_METADATA_VERSION }
}

/** Read the cross-store operation ledger version when the file exists. */
async function checkLedger(dataDir) {
  const path = join(dataDir, 'cross-store-operation-ledger.json')
  if (!existsSync(path)) return { present: false, supported: true }
  const parsed = await readJson(path)
  if (!parsed.ok) return { present: true, supported: false, reason: parsed.error }
  if (parsed.value?.version !== CROSS_STORE_LEDGER_VERSION) {
    return { present: true, supported: false, version: parsed.value?.version ?? null }
  }
  return { present: true, supported: true, version: CROSS_STORE_LEDGER_VERSION }
}

/** Report whether a backend process currently holds the data directory lock. */
async function checkLock(dataDir) {
  const path = join(dataDir, BACKEND_LOCK_NAME)
  if (!existsSync(path)) return { present: false }
  const parsed = await readJson(path)
  return parsed.ok
    ? { present: true, pid: parsed.value?.pid, createdAt: parsed.value?.createdAt }
    : { present: true, unreadable: true }
}

/** Print the human-readable report and return the compatibility exit code. */
function printReport(report) {
  process.stdout.write(`data dir: ${report.dataDir}\n`)
  process.stdout.write(`sessions: ${String(report.sessions.total)} total, ${String(report.sessions.supported)} format v${String(SESSION_FORMAT_VERSION)}, unsupported ${String(report.sessions.unsupported.length)}, unreadable ${String(report.sessions.invalid.length)}\n`)
  process.stdout.write(`workspaces: ${String(report.workspaces.total)} total, ${String(report.workspaces.supported)} metadata v${String(WORKSPACE_METADATA_VERSION)}, unsupported ${String(report.workspaces.unsupported.length)}, unreadable ${String(report.workspaces.invalid.length)}\n`)
  process.stdout.write(`identity metadata: ${report.identity.present ? (report.identity.supported ? `v${String(IDENTITY_METADATA_VERSION)}` : 'unsupported') : 'absent'}\n`)
  process.stdout.write(`cross-store ledger: ${report.ledger.present ? (report.ledger.supported ? `v${String(CROSS_STORE_LEDGER_VERSION)}` : 'unsupported') : 'absent'}\n`)
  process.stdout.write(`storage: ${report.storage.chunkObjects ? 'chunk objects' : 'plain blobs'}\n`)
  process.stdout.write(`backend lock: ${report.lock.present ? `held${report.lock.pid === undefined ? '' : ` by pid ${String(report.lock.pid)}`} (stop the server before upgrading)` : 'free'}\n`)
  if (report.storage.chunkObjects) {
    process.stdout.write('required flags: DSH_POC_WORKSPACE_CHUNK_OBJECTS=1\n')
  }
  for (const entry of report.sessions.unsupported) process.stdout.write(`unsupported session: ${entry.id} (format v${String(entry.version)})\n`)
  for (const entry of report.workspaces.unsupported) process.stdout.write(`unsupported workspace: ${entry.id} (metadata v${String(entry.version)})\n`)
  for (const entry of report.sessions.invalid) process.stdout.write(`unreadable session: ${entry.id} (${entry.reason})\n`)
  for (const entry of report.workspaces.invalid) process.stdout.write(`unreadable workspace: ${entry.id} (${entry.reason})\n`)
  process.stdout.write(`verdict: ${report.compatible ? 'compatible with this build' : 'incompatible with this build'}\n`)
}

/** Inspect a data directory and print one report. */
async function main() {
  const values = parseArgs(process.argv.slice(2))
  if (values === undefined) {
    process.stdout.write(HELP)
    return 0
  }
  const dataDir = resolve(values.dataDir ?? join(REPO_ROOT, 'browser-native-data'))
  if (!existsSync(dataDir)) {
    process.stderr.write(`check-data: no data directory at ${dataDir}\n`)
    return 2
  }
  const report = {
    dataDir,
    sessions: await checkSessions(dataDir),
    workspaces: await checkWorkspaces(dataDir),
    identity: await checkIdentity(dataDir),
    ledger: await checkLedger(dataDir),
    storage: { chunkObjects: existsSync(join(dataDir, 'workspace-v2', 'chunk-objects')) },
    lock: await checkLock(dataDir),
  }
  report.compatible = report.sessions.unsupported.length === 0
    && report.sessions.invalid.length === 0
    && report.workspaces.unsupported.length === 0
    && report.workspaces.invalid.length === 0
    && report.identity.supported
    && report.ledger.supported
  if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else printReport(report)
  return report.compatible ? 0 : 1
}

main().then(code => {
  process.exitCode = code
}, error => {
  process.stderr.write(`check-data: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
})
