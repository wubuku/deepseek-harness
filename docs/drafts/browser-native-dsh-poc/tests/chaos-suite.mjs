#!/usr/bin/env node

/**
 * Repeatable chaos regression suite.
 *
 * Runs the previously validated fault injections in sequence and prints either
 * an all-green summary or the failing case list with captured diagnostics. Each
 * case keeps its own temporary data directory and cleans up after itself.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../../..')
const require = createRequire(import.meta.url)

const CASES = [
  { id: 'stream-cut', file: 'llm-stream-failure.e2e.mjs', runtime: 'esm', timeoutMs: 180_000 },
  { id: 'worker-crash', file: 'worker-crash-during-tool.e2e.mjs', runtime: 'esm', timeoutMs: 180_000 },
  { id: 'opfs-quota', file: 'opfs-quota-tool-failure.e2e.mjs', runtime: 'esm', timeoutMs: 180_000 },
  { id: 'durable-restart', file: 'durable-host-restart.test.mjs', runtime: 'node-test', timeoutMs: 180_000 },
  { id: 'lease-loss', file: 'page-freeze-lease-fencing.e2e.mjs', runtime: 'esm', timeoutMs: 240_000 },
  { id: 'audit-truncation', file: 'observability-persistence.test.mjs', runtime: 'node-test', timeoutMs: 120_000 },
]

const HELP = `Usage: node docs/drafts/browser-native-dsh-poc/tests/chaos-suite.mjs [options]

Options:
  --list                  Print the case ids without running them
  --filter <substring>    Run only case ids containing the substring
  --help                  Show this message

Environment:
  DSH_POC_BROWSER                 Chromium channel for browser cases (default: chrome)
  DSH_POC_PLAYWRIGHT_MODULE       Installed Playwright entry; resolved locally when absent

Exit code: 0 when every selected case passes, 1 when any case fails or times out.
`

/** Parse the supported arguments without accepting unknown options. */
function parseArgs(argv) {
  const values = { list: false, filter: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return undefined
    if (option === '--list') {
      values.list = true
      continue
    }
    if (option === '--filter') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--filter needs a value')
      values.filter = value
      index += 1
      continue
    }
    throw new Error(`unknown option: ${option}`)
  }
  return values
}

/** Build the child environment with Chrome and Playwright defaults. */
function childEnvironment() {
  const env = { ...process.env }
  env.DSH_POC_BROWSER ??= 'chrome'
  env.DSH_POC_PLAYWRIGHT_MODULE ??= require.resolve('playwright')
  return env
}

/** Run one case with its own timeout and captured output. */
function runCase(testCase, env) {
  const args = testCase.runtime === 'node-test' ? ['--test', join(HERE, testCase.file)] : [join(HERE, testCase.file)]
  return new Promise(resolveResult => {
    const startedAt = Date.now()
    const output = []
    let timedOut = false
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => output.push(String(chunk)))
    child.stderr.on('data', chunk => output.push(String(chunk)))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, testCase.timeoutMs)
    child.once('exit', code => {
      clearTimeout(timer)
      resolveResult({ id: testCase.id, code: timedOut ? null : code, timedOut, elapsedMs: Date.now() - startedAt, output: output.join('') })
    })
  })
}

/** Print the diagnostics of a failed case, keeping the tail only. */
function printFailure(result) {
  const lines = result.output.trimEnd().split(/\r?\n/)
  const tail = lines.slice(-40)
  process.stdout.write(`chaos: ${result.id} FAIL${result.timedOut ? ' (timeout)' : ` (exit ${String(result.code)})`} in ${(result.elapsedMs / 1_000).toFixed(1)}s\n`)
  if (tail.length > 0) process.stdout.write(`  ${tail.join('\n  ')}\n`)
  else process.stdout.write('  (no captured output)\n')
}

/** Run the selected cases in order and return the process exit code. */
async function main() {
  const values = parseArgs(process.argv.slice(2))
  if (values === undefined) {
    process.stdout.write(HELP)
    return 0
  }
  const selected = values.filter === undefined
    ? CASES
    : CASES.filter(testCase => testCase.id.includes(values.filter))
  if (selected.length === 0) throw new Error(`no case matches filter "${String(values.filter)}"`)
  if (values.list) {
    for (const testCase of selected) process.stdout.write(`${testCase.id}\t${testCase.file}\n`)
    return 0
  }
  const env = childEnvironment()
  const failures = []
  for (const testCase of selected) {
    const result = await runCase(testCase, env)
    if (result.code === 0 && !result.timedOut) {
      process.stdout.write(`chaos: ${result.id} PASS in ${(result.elapsedMs / 1_000).toFixed(1)}s\n`)
      continue
    }
    failures.push(result)
    printFailure(result)
  }
  if (failures.length === 0) {
    process.stdout.write(`chaos-suite: PASS ${String(selected.length)}/${String(selected.length)}\n`)
    return 0
  }
  process.stdout.write(`chaos-suite: FAIL ${String(failures.length)}/${String(selected.length)}: ${failures.map(result => result.id).join(', ')}\n`)
  return 1
}

main().then(code => {
  process.exitCode = code
}, error => {
  process.stderr.write(`chaos-suite: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
})
