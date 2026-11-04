#!/usr/bin/env node

/**
 * Single regression entry for the browser-native PoC.
 *
 * Runs four groups in order: every Node contract test, the declared product-path
 * E2E roster (or every E2E file when requested), the performance gate, and the
 * chaos suite. Each item runs in its own child process, so one failure cannot
 * hide another. The gate prints one PASS/FAIL line and duration per item, then a
 * group summary and a final JSON block, and exits non-zero when any item fails.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../../..')
const BASELINE_FILE = join(HERE, '..', 'poc-gate-baseline.json')
const PREVIEW_IMAGE = join(REPO_ROOT, 'apps/web/dist/preview/vfs-image.tar.gz')
const ITEM_TIMEOUT_MS = 300_000
const GATE_TIMEOUT_MS = 1_500_000
const require = createRequire(import.meta.url)

/**
 * Product-path E2E files that run without an external provider or special
 * infrastructure. The exhaustive `.e2e.mjs` set is opt-in because many files
 * need MinIO, WebKit, real credentials, or host-level fault injection.
 */
const E2E_ROSTER = [
  'cold-start.e2e.mjs',
  'browser-native-v2.e2e.mjs',
  'cold-hydrate-integrity.e2e.mjs',
  'session-mount-lifecycle.e2e.mjs',
  'session-sharing.e2e.mjs',
  'offline-reconnect.e2e.mjs',
  'principal-data.e2e.mjs',
  'data-erasure.e2e.mjs',
  'tool-capability-matrix.e2e.mjs',
  'session-transport-resilience.e2e.mjs',
]

const GROUP_ALIASES = {
  contract: 'contract',
  e2e: 'e2e',
  perf: 'perf',
  chaos: 'chaos',
}

const HELP = `Usage: node docs/drafts/browser-native-dsh-poc/tests/poc-gate.mjs [options]

Options:
  --group <list>       Comma-separated groups: contract,e2e,perf,chaos (default: all)
  --filter <substring> Run only item ids containing the substring
  --prepare            Build the Web preview before browser items
  --list               Print item ids without running them
  --help               Show this message

Environment:
  DSH_POC_GATE_FULL_E2E=1          Run every .e2e.mjs file instead of the roster
  DSH_POC_GATE_E2E_ROSTER          Comma-separated E2E file names to override the roster
  DSH_POC_GATE_UPDATE_BASELINE=1   Rewrite poc-gate-baseline.json after an all-green run
  DSH_POC_BROWSER                  Chromium channel for browser items (default: chrome)
  DSH_POC_PLAYWRIGHT_MODULE        Installed Playwright entry; resolved locally when absent

Every item runs sequentially in its own process. Exit code: 0 when every selected
item passes, 1 when any item fails or times out, 2 when the gate itself cannot run.
`

/** Parse the supported arguments without accepting unknown options. */
function parseArgs(argv) {
  const values = { groups: undefined, filter: undefined, list: false, prepare: false }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return undefined
    if (option === '--list') {
      values.list = true
      continue
    }
    if (option === '--prepare') {
      values.prepare = true
      continue
    }
    if (option === '--group') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--group needs a value')
      values.groups = value.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
      index += 1
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

/** Resolve the selected groups in their fixed execution order. */
function selectGroups(requested) {
  const names = requested ?? Object.keys(GROUP_ALIASES)
  const unknown = names.find(name => GROUP_ALIASES[name] === undefined)
  if (unknown !== undefined) throw new Error(`unknown group: ${unknown}`)
  return Object.keys(GROUP_ALIASES).filter(name => names.includes(name))
}

/** Whether a file imports `node:test`, which decides the child invocation. */
async function usesNodeTest(path) {
  const source = await readFile(path, 'utf8')
  return /from\s+'node:test'/.test(source)
}

/** Build the contract items from every `.test.mjs` file in this directory. */
async function contractItems() {
  const entries = await readdir(HERE, { withFileTypes: true })
  const files = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => entry.name)
    .sort()
  const items = []
  for (const file of files) {
    const path = join(HERE, file)
    const args = await usesNodeTest(path) ? ['--test', path] : [path]
    items.push({
      group: 'contract',
      id: `contract/${file}`,
      args,
      timeoutMs: ITEM_TIMEOUT_MS,
    })
  }
  return items
}

/** Build the E2E items from the roster or the full `.e2e.mjs` set. */
async function e2eItems() {
  const override = process.env.DSH_POC_GATE_E2E_ROSTER
  const full = process.env.DSH_POC_GATE_FULL_E2E === '1'
  if (full && override !== undefined) throw new Error('DSH_POC_GATE_FULL_E2E and DSH_POC_GATE_E2E_ROSTER are mutually exclusive')
  const files = full
    ? (await readdir(HERE, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.e2e.mjs'))
        .map(entry => entry.name)
        .sort()
    : (override === undefined ? E2E_ROSTER : override.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0))
  const items = []
  for (const file of files) {
    const path = join(HERE, file)
    try {
      await access(path)
    } catch {
      throw new Error(`E2E entry does not exist: ${file}`)
    }
    items.push({ group: 'e2e', id: `e2e/${file}`, args: [path], timeoutMs: ITEM_TIMEOUT_MS })
  }
  return items
}

/** Build the two aggregate gate items. */
function aggregateItems(groups) {
  const items = []
  if (groups.includes('perf')) {
    items.push({ group: 'perf', id: 'perf/perf-gate', args: [join(HERE, 'perf-gate.mjs')], timeoutMs: GATE_TIMEOUT_MS })
  }
  if (groups.includes('chaos')) {
    items.push({ group: 'chaos', id: 'chaos/chaos-suite', args: [join(HERE, 'chaos-suite.mjs')], timeoutMs: GATE_TIMEOUT_MS })
  }
  return items
}

/** Merge group selections into one ordered item list. */
async function collectItems(groups) {
  const items = []
  if (groups.includes('contract')) items.push(...await contractItems())
  if (groups.includes('e2e')) items.push(...await e2eItems())
  items.push(...aggregateItems(groups))
  return items
}

/** Verify the shared Web preview exists before any browser-dependent group. */
async function requirePreview(groups) {
  if (!groups.some(group => group === 'e2e' || group === 'perf' || group === 'chaos')) return
  try {
    await access(PREVIEW_IMAGE)
  } catch {
    throw new Error(`missing ${PREVIEW_IMAGE}; run "pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview" or rerun with --prepare`)
  }
}

/** Build the Web preview at the repository root, streaming its output. */
async function buildPreview() {
  process.stdout.write('poc-gate: preparing Web preview\n')
  const code = await new Promise(resolveCode => {
    const child = spawn('pnpm', ['--filter', '@deepseek-ai/dsh-web-frontend', 'run', 'build:preview'], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
    })
    child.once('exit', exitCode => resolveCode(exitCode ?? 1))
  })
  if (code !== 0) throw new Error(`preview build failed with exit ${String(code)}`)
}

/** Build the child environment shared by every item. */
function childEnvironment() {
  const env = { ...process.env }
  env.DSH_POC_BROWSER ??= 'chrome'
  if (env.DSH_POC_PLAYWRIGHT_MODULE === undefined) {
    try {
      env.DSH_POC_PLAYWRIGHT_MODULE = require.resolve('playwright')
    } catch {}
  }
  return env
}

/** Run one item with its own timeout and captured output. */
function runItem(item, env) {
  return new Promise(resolveResult => {
    const startedAt = Date.now()
    const output = []
    let timedOut = false
    const child = spawn(process.execPath, item.args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => output.push(String(chunk)))
    child.stderr.on('data', chunk => output.push(String(chunk)))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, item.timeoutMs)
    child.once('exit', code => {
      clearTimeout(timer)
      resolveResult({
        id: item.id,
        group: item.group,
        code: timedOut ? null : code,
        timedOut,
        durationMs: Date.now() - startedAt,
        output: output.join(''),
      })
    })
  })
}

/** Print the tail of a failed item so the operator sees the actual assertion. */
function printFailureTail(result) {
  const lines = result.output.trimEnd().split(/\r?\n/)
  const tail = lines.slice(-30)
  if (tail.length === 0) return
  process.stdout.write(`  ${tail.join('\n  ')}\n`)
}

/** Format a duration for the per-item line. */
function seconds(milliseconds) {
  return `${(milliseconds / 1_000).toFixed(1)}s`
}

/** Run the selected items and return the aggregate result. */
async function main() {
  const values = parseArgs(process.argv.slice(2))
  if (values === undefined) {
    process.stdout.write(HELP)
    return 0
  }
  const groups = selectGroups(values.groups)
  if (values.prepare) await buildPreview()
  await requirePreview(groups)

  let items = await collectItems(groups)
  if (values.filter !== undefined) {
    items = items.filter(item => item.id.includes(values.filter))
    if (items.length === 0) throw new Error(`no item matches filter "${values.filter}"`)
  }
  if (values.list) {
    for (const item of items) process.stdout.write(`${item.id}\t${String(item.timeoutMs)}ms\n`)
    return 0
  }

  const env = childEnvironment()
  const startedAt = Date.now()
  const results = []
  for (const item of items) {
    process.stdout.write(`poc-gate: running ${item.id}\n`)
    const result = await runItem(item, env)
    const passed = result.code === 0 && !result.timedOut
    results.push(result)
    process.stdout.write(`poc-gate: ${result.id} ${passed ? 'PASS' : 'FAIL'} ${seconds(result.durationMs)}${result.timedOut ? ' (timeout)' : ''}\n`)
    if (!passed) printFailureTail(result)
  }
  const totalDurationMs = Date.now() - startedAt

  const summaries = []
  for (const group of groups) {
    const selected = results.filter(result => result.group === group)
    if (selected.length === 0) continue
    const passed = selected.filter(result => result.code === 0 && !result.timedOut).length
    const durationMs = selected.reduce((sum, result) => sum + result.durationMs, 0)
    summaries.push({ group, passed, total: selected.length, durationMs })
    process.stdout.write(`poc-gate: ${group} ${passed === selected.length ? 'PASS' : 'FAIL'} ${String(passed)}/${String(selected.length)} ${seconds(durationMs)}\n`)
  }

  const failures = results.filter(result => result.code !== 0 || result.timedOut)
  const summary = {
    result: failures.length === 0 ? 'passed' : 'failed',
    groups: summaries.map(entry => ({ ...entry, durationMs: Math.round(entry.durationMs / 100) / 10 })),
    items: results.map(result => ({
      id: result.id,
      group: result.group,
      status: result.code === 0 && !result.timedOut ? 'passed' : result.timedOut ? 'timeout' : 'failed',
      exitCode: result.code,
      durationMs: Math.round(result.durationMs / 100) / 10,
    })),
    totalDurationMs: Math.round(totalDurationMs / 100) / 10,
    failures: failures.map(result => result.id),
  }

  if (process.env.DSH_POC_GATE_UPDATE_BASELINE === '1' && failures.length === 0) {
    await writeFile(BASELINE_FILE, `${JSON.stringify({
      capturedAt: new Date().toISOString(),
      note: 'Green poc-gate baseline. Regenerate with DSH_POC_GATE_UPDATE_BASELINE=1.',
      groups: summary.groups,
      items: summary.items,
      totalDurationMs: summary.totalDurationMs,
    }, null, 2)}\n`)
  }

  process.stdout.write(`${JSON.stringify(summary)}\n`)
  assert.deepEqual(failures, [], `${String(failures.length)} gate item(s) failed`)
  process.stdout.write(`poc-gate: PASS ${String(results.length)}/${String(results.length)} ${seconds(totalDurationMs)}\n`)
  return 0
}

main().then(code => {
  process.exitCode = code
}, error => {
  process.stderr.write(`poc-gate: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
