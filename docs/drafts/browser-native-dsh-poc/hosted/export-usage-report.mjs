#!/usr/bin/env node

/**
 * Export the tenant cost report from a running hosted backend.
 *
 * Reads the owner-only local auth token from the data directory, fetches either
 * JSON or CSV, and writes it to a file or stdout. Diagnostics stay on stderr so
 * piping the CSV remains clean.
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const HELP = `Usage: node docs/drafts/browser-native-dsh-poc/hosted/export-usage-report.mjs --origin <url> [options]

Options:
  --origin <url>     Running backend origin, for example http://127.0.0.1:4185
  --data-dir <path>  Data directory holding browser-native-auth-token (default: DSH_POC_DATA_DIR or ./browser-native-data)
  --format json|csv  Report format (default: csv)
  --out <path>       Output file; omit to write the report to stdout
  --help             Show this message
`

/** Parse the supported arguments without accepting unknown options. */
function parseArgs(argv) {
  const values = { format: 'csv' }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return undefined
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${option} needs a value`)
    if (option === '--origin') values.origin = value
    else if (option === '--data-dir') values.dataDir = value
    else if (option === '--format') values.format = value
    else if (option === '--out') values.out = value
    else throw new Error(`unknown option: ${option}`)
    index += 1
  }
  if (values.origin === undefined) throw new Error('--origin is required')
  if (values.format !== 'json' && values.format !== 'csv') throw new Error('--format must be json or csv')
  return values
}

/** Fetch the report with the local process token and persist it. */
async function main() {
  const values = parseArgs(process.argv.slice(2))
  if (values === undefined) {
    process.stdout.write(HELP)
    return 0
  }
  const dataDir = resolve(values.dataDir ?? process.env.DSH_POC_DATA_DIR ?? join(REPO_ROOT, 'browser-native-data'))
  const tokenPath = join(dataDir, 'browser-native-auth-token')
  if (!existsSync(tokenPath)) throw new Error(`no local auth token at ${tokenPath}`)
  const token = (await readFile(tokenPath, 'utf8')).trim()
  const base = values.origin.replace(/\/+$/, '')
  const response = await fetch(`${base}/api/browser-native/usage-report?format=${values.format}`, {
    headers: { 'x-browser-native-auth': token },
  })
  if (!response.ok) throw new Error(`usage report failed: HTTP ${String(response.status)} ${await response.text()}`)
  const body = await response.text()
  if (values.out === undefined) {
    process.stdout.write(body.endsWith('\n') ? body : `${body}\n`)
  } else {
    await writeFile(values.out, body.endsWith('\n') ? body : `${body}\n`, 'utf8')
  }
  if (values.format === 'json') {
    const report = JSON.parse(body)
    const destination = values.out === undefined ? 'stdout' : values.out
    process.stderr.write(`usage-report: ${String(report.principals.length)} principals, ${String(report.totals.requests)} requests, ${String(report.totals.totalTokens)} tokens, cost ${report.totals.costUsd === null ? 'n/a' : `$${report.totals.costUsd.toFixed(6)}`} -> ${destination}\n`)
  } else {
    process.stderr.write(`usage-report: csv ${String(body.split('\n').filter(line => line.length > 0).length - 1)} data rows -> ${values.out ?? 'stdout'}\n`)
  }
  return 0
}

main().then(code => {
  process.exitCode = code
}, error => {
  process.stderr.write(`usage-report: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
