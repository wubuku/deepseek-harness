/**
 * Consolidated performance gate for the browser-native PoC.
 *
 * Runs the measured suites (cold start/hydrate, long-transcript render, 9,990
 * file Workspace sync, weak-network first token) in child processes, extracts
 * one metric set from each JSON report, and compares every metric with the
 * recorded baseline and the gate budget. Any suite failure or budget breach
 * exits non-zero.
 *
 * Budgets keep the documented defaults and stay overridable through the same
 * environment variables the individual suites already read.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const BASELINE_FILE = join(HERE, '..', 'perf-gate-baseline.json')
const SUITE_TIMEOUT_MS = Number(process.env.DSH_POC_PERF_GATE_TIMEOUT_MS ?? 1_200_000)

function budget(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got ${raw}`)
  return value
}

const budgets = {
  coldStartMs: budget('DSH_POC_PERF_COLD_BUDGET_MS', 60_000),
  hydrateMs: budget('DSH_POC_PERF_HYDRATE_BUDGET_MS', 45_000),
  turnMedianMs: budget('DSH_POC_PERF_TURN_BUDGET_MS', 5_000),
  domNodes: budget('DSH_POC_RENDER_DOM_BUDGET', 20_000),
  scrollTaskMs: budget('DSH_POC_RENDER_SCROLL_BURST_MS', 350),
  appendTaskMs: budget('DSH_POC_RENDER_APPEND_BUDGET_MS', 500),
  longTaskMs: budget('DSH_POC_RENDER_LONG_TASK_BUDGET_MS', 100),
  sync9990Ms: budget('DSH_POC_PERF_SYNC_BUDGET_MS', 15_000),
  firstTokenMs: budget('DSH_POC_PERF_FIRST_TOKEN_BUDGET_MS', 2_000),
  transportOverheadMs: budget('DSH_POC_PERF_TRANSPORT_OVERHEAD_BUDGET_MS', 2_000),
  weakTurnCompletionMs: budget('DSH_POC_PERF_WEAK_TURN_BUDGET_MS', 20_000),
  abortAckMs: budget('DSH_POC_PERF_ABORT_ACK_BUDGET_MS', 2_000),
}

const suites = [
  {
    name: 'baseline',
    script: 'performance-baseline.e2e.mjs',
    env: () => ({
      DSH_POC_PERF_COLD_BUDGET_MS: String(budgets.coldStartMs),
      DSH_POC_PERF_HYDRATE_BUDGET_MS: String(budgets.hydrateMs),
    }),
    extract(report) {
      const one = report.scales.find(scale => scale.sessions === 1)
      const four = report.scales.find(scale => scale.sessions === 4)
      assert.ok(one && four, 'baseline report must contain the 1 and 4 Session scales')
      return {
        coldStartMs: one.cold.medianSyncedMs,
        hydrateMs: one.hydrate.medianSyncedMs,
        turnMedianMs: one.cold.medianTurnMs,
        fourSessionColdStartMs: four.cold.medianSyncedMs,
        fourSessionHydrateMs: four.hydrate.medianSyncedMs,
      }
    },
  },
  {
    name: 'render',
    script: 'long-transcript-rendering.e2e.mjs',
    env: () => ({
      DSH_POC_RENDER_DOM_BUDGET: String(budgets.domNodes),
      DSH_POC_RENDER_SCROLL_BURST_MS: String(budgets.scrollTaskMs),
      DSH_POC_RENDER_APPEND_BUDGET_MS: String(budgets.appendTaskMs),
      DSH_POC_RENDER_LONG_TASK_BUDGET_MS: String(budgets.longTaskMs),
    }),
    extract(report) {
      assert.ok(report.measurements.length > 0, 'render report must contain scroll checkpoints')
      return {
        domNodes: Math.max(...report.measurements.map(checkpoint => checkpoint.dom.nodes)),
        scrollTaskMs: Math.max(...report.measurements.map(checkpoint => checkpoint.scroll.taskMs)),
        appendTaskMs: report.longAppend.taskMs,
        longTaskMs: Math.max(
          report.longAppend.longTasks.longestMs,
          ...report.measurements.map(checkpoint => checkpoint.scroll.longTasks.longestMs),
        ),
      }
    },
  },
  {
    name: 'sync',
    script: 'large-workspace-sync.e2e.mjs',
    env: () => ({ DSH_POC_WORKSPACE_FILES: '9990' }),
    extract(report) {
      assert.equal(report.files, 9_990, 'sync report must cover the 9,990 file baseline')
      return { sync9990Ms: report.sync.ms }
    },
  },
  {
    name: 'network',
    script: 'weak-network-profile.e2e.mjs',
    env: () => ({}),
    extract(report) {
      const phase = report.measurements.find(entry => entry.phase === 'scripted')
      assert.ok(phase, 'network report must contain the scripted phase')
      return {
        firstTokenMs: phase.firstTokenMs,
        transportOverheadMs: phase.transportOverheadMs,
        weakTurnCompletionMs: phase.turnCompletionMs,
        abortAckMs: Math.max(...phase.cancellations.map(cancellation => cancellation.abortAckMs)),
      }
    },
  },
]

const selected = (process.env.DSH_POC_PERF_GATE_SUITES ?? suites.map(suite => suite.name).join(','))
  .split(',').map(value => value.trim()).filter(value => value.length > 0)
const unknownSuite = selected.find(name => !suites.some(suite => suite.name === name))
assert.equal(unknownSuite, undefined, `unknown perf-gate suite: ${String(unknownSuite)}`)

/**
 * Parse the last JSON object printed by a suite. Reports may be pretty-printed,
 * so scan backwards for the final top-level `{`.
 */
function parseReport(stdout) {
  for (let index = stdout.lastIndexOf('{'); index !== -1; index = stdout.lastIndexOf('{', index - 1)) {
    try {
      return JSON.parse(stdout.slice(index))
    } catch {}
  }
  return undefined
}

function runSuite(suite) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(HERE, suite.script)], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...suite.env() },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      stderr += `\nperf-gate: ${suite.name} exceeded ${String(SUITE_TIMEOUT_MS)} ms`
      child.kill('SIGKILL')
    }, SUITE_TIMEOUT_MS)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

async function readBaseline() {
  try {
    return JSON.parse(await readFile(BASELINE_FILE, 'utf8'))
  } catch {
    return undefined
  }
}

const baseline = await readBaseline()
const results = {}
const measurements = {}
const failures = []

for (const name of selected) {
  const suite = suites.find(entry => entry.name === name)
  process.stderr.write(`perf-gate: running ${name}\n`)
  const run = await runSuite(suite)
  const report = parseReport(run.stdout)
  if (run.code !== 0 || report === undefined || report.result !== 'passed') {
    const tail = run.stderr.trim().split('\n').slice(-6).join('\n')
    results[name] = { status: 'failed', exitCode: run.code, tail }
    failures.push(`${name}: suite failed (exit ${String(run.code)})`)
    continue
  }
  try {
    results[name] = { status: 'passed' }
    Object.assign(measurements, suite.extract(report))
  } catch (error) {
    results[name] = { status: 'invalid', message: error.message }
    failures.push(`${name}: ${error.message}`)
  }
}

for (const [metric, value] of Object.entries(measurements)) {
  const limit = budgets[metric]
  if (limit === undefined) continue
  if (value > limit) failures.push(`${metric}: ${String(value)} exceeds budget ${String(limit)}`)
}

const rows = Object.entries(measurements).map(([metric, value]) => {
  const limit = budgets[metric]
  const previous = baseline?.metrics?.[metric]
  return {
    metric,
    measured: Math.round(value * 10) / 10,
    baseline: typeof previous === 'number' ? Math.round(previous * 10) / 10 : null,
    budget: limit ?? null,
    headroom: limit === undefined ? null : Math.round((limit - value) * 10) / 10,
    status: limit !== undefined && value > limit ? 'fail' : 'pass',
  }
})

const width = rows.reduce((longest, row) => Math.max(longest, row.metric.length), 8)
process.stdout.write(`${'metric'.padEnd(width)}  ${'measured'.padStart(10)}  ${'baseline'.padStart(10)}  ${'budget'.padStart(10)}  ${'headroom'.padStart(10)}  status\n`)
for (const row of rows) {
  process.stdout.write(
    `${row.metric.padEnd(width)}  ${String(row.measured).padStart(10)}  ${String(row.baseline ?? '-').padStart(10)}  `
    + `${String(row.budget ?? '-').padStart(10)}  ${String(row.headroom ?? '-').padStart(10)}  ${row.status}\n`,
  )
}

if (process.env.DSH_POC_PERF_GATE_UPDATE_BASELINE === '1' && failures.length === 0) {
  await writeFile(BASELINE_FILE, `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    note: 'Green perf-gate baseline. Regenerate with DSH_POC_PERF_GATE_UPDATE_BASELINE=1.',
    metrics: Object.fromEntries(Object.entries(measurements).map(([metric, value]) => [metric, Math.round(value * 10) / 10])),
  }, null, 2)}\n`)
}

const summary = {
  result: failures.length === 0 ? 'passed' : 'failed',
  suites: results,
  measurements: Object.fromEntries(Object.entries(measurements).map(([metric, value]) => [metric, Math.round(value * 10) / 10])),
  budgets,
  baseline: baseline?.metrics ?? null,
  failures,
}
process.stdout.write(`${JSON.stringify(summary)}\n`)
assert.deepEqual(failures, [])
