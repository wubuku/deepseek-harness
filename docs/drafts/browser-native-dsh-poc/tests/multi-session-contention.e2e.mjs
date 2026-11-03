/**
 * Measure CPU contention, scheduling fairness and per-Session latency at 1, 8 and 16 parallel Sessions.
 *
 * Every Session runs in its own BrowserContext and Dedicated Worker, submits one turn at the same
 * time as its peers, and reports wall latency, per-page main-thread task time and JavaScript heap.
 * A final 16-Session pass caps admission at the configured queue width to compare against no cap.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, rememberSessionPrincipal, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright

const MARKER = 'BROWSER_NATIVE_SESSION_SCALE_TURN_E2E'
const scales = String(process.env.DSH_POC_CONTENTION_SCALES ?? '1,8,16')
  .split(',').map(value => Number(value.trim()))
const samplesPerScale = Number(process.env.DSH_POC_CONTENTION_SAMPLES ?? 3)
const queueWidth = Number(process.env.DSH_POC_CONTENTION_QUEUE ?? 8)
const turnBudgetMs = Number(process.env.DSH_POC_CONTENTION_TURN_BUDGET_MS ?? 20_000)
const heapBudgetBytes = Number(process.env.DSH_POC_CONTENTION_HEAP_BUDGET_MB ?? 512) * 1024 * 1024
const previewUrl = origin => `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`

for (const scale of scales) {
  if (!Number.isSafeInteger(scale) || scale < 1) throw new Error(`DSH_POC_CONTENTION_SCALES values must be positive integers, got ${String(scale)}`)
}
if (!Number.isSafeInteger(samplesPerScale) || samplesPerScale < 1) throw new Error('DSH_POC_CONTENTION_SAMPLES must be a positive integer')
if (!Number.isSafeInteger(queueWidth) || queueWidth < 1) throw new Error('DSH_POC_CONTENTION_QUEUE must be a positive integer')

function percentile(values, ratio) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))
  return sorted[index]
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function standardDeviation(values) {
  if (values.length === 0) return null
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  return Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length)
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

function createRecorder(page, origin) {
  const requests = []
  const external = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) {
      external.push(request.url())
      return
    }
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    requests.push({ path: url.pathname, body })
  })
  return { requests, external, pageErrors }
}

async function waitForAssistantMarker(page, marker, timeout) {
  await page.waitForFunction(value => [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')]
    .some(node => node.textContent?.includes(value)), marker, { timeout })
}

async function enableMetrics(page) {
  const session = await page.context().newCDPSession(page)
  await session.send('Performance.enable')
  return session
}

async function readMetrics(session) {
  const { metrics } = await session.send('Performance.getMetrics')
  return Object.fromEntries(metrics.map(metric => [metric.name, metric.value]))
}

async function submitTurn(tab, origin) {
  const { page, recorder, state } = tab
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(`${MARKER} scale-turn-1: contention probe`)
  const startedAt = Date.now()
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  if (state.sessionId === undefined) {
    state.sessionId = await waitFor(() => recorder.requests.find(request => request.path.endsWith('/session/create'))?.body.sessionId,
      'Session creation', 30_000)
    await rememberSessionPrincipal(page, origin, state.sessionId)
  }
  const terminal = await waitFor(async () => {
    const slice = await sessionRequest(origin, 'read', { sessionId: state.sessionId, offset: state.offset, length: 200 })
    assert.equal(slice.status, 200, JSON.stringify(slice))
    const index = (slice.events ?? []).findIndex(event => event.type === 'turn/end')
    if (index < 0) return undefined
    const end = slice.events[index]
    state.offset = Math.max(...slice.events.map(event => event.seq), end.seq) + 1
    return end
  }, `terminal turn for ${state.sessionId}`, 120_000)
  assert.equal(terminal.data.reason.kind, 'completed', `turn ended as ${JSON.stringify(terminal.data.reason)}`)
  const turnEndedMs = Date.now() - startedAt
  await waitForAssistantMarker(page, `${MARKER}_1_DONE`, 30_000)
  return { turnMs: turnEndedMs, renderedMs: Date.now() - startedAt }
}

async function measureScale({ browser, browserCdp, origin, scale, limit = scale }) {
  const coldSamples = []
  const coldAttempts = []
  const coldBootFailures = []
  const turnSamples = []
  const renderedSamples = []
  const taskDurationSamples = []
  const heapSamples = []
  const cpuSamples = []
  const budgetViolations = []
  const pageErrors = []
  const external = []
  for (let sample = 0; sample < samplesPerScale; sample += 1) {
    process.stderr.write(`contention: sessions=${String(scale)} sample=${String(sample)}\n`)
    const tabs = await Promise.all(Array.from({ length: scale }, async () => {
      const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 } })
      const page = await context.newPage()
      const recorder = createRecorder(page, origin)
      return { context, page, recorder, state: { sessionId: undefined, offset: 0 }, metricSession: undefined }
    }))
    try {
      const cold = await Promise.all(tabs.map(async tab => {
        const startedAt = Date.now()
        const bootFailures = []
        let lastError
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await openPreview(tab.page, previewUrl(origin))
            await tab.page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 90_000 })
            tab.recorder.pageErrors.length = 0
            return { ms: Date.now() - startedAt, attempts: attempt + 1, bootFailures }
          } catch (error) {
            lastError = error
            bootFailures.push(...tab.recorder.pageErrors)
            tab.recorder.pageErrors.length = 0
          }
        }
        throw lastError
      }))
      coldSamples.push(...cold.map(entry => entry.ms))
      coldAttempts.push(...cold.map(entry => entry.attempts))
      coldBootFailures.push(...cold.flatMap(entry => entry.bootFailures))
      for (const tab of tabs) tab.metricSession = await enableMetrics(tab.page)
      const before = await browserCdp.send('SystemInfo.getProcessInfo')
      const beforeTotal = before.processInfo.reduce((total, entry) => total + entry.cpuTime, 0)
      const cpuStartedAt = Date.now()
      const turns = await runWithConcurrency(tabs, limit, async tab => await submitTurn(tab, origin))
      const wallMs = Date.now() - cpuStartedAt
      const after = await browserCdp.send('SystemInfo.getProcessInfo')
      const afterTotal = after.processInfo.reduce((total, entry) => total + entry.cpuTime, 0)
      turnSamples.push(...turns.map(turn => turn.turnMs))
      renderedSamples.push(...turns.map(turn => turn.renderedMs))
      const metrics = await Promise.all(tabs.map(async tab => await readMetrics(tab.metricSession)))
      taskDurationSamples.push(...metrics.map(value => value.TaskDuration * 1000))
      const heaps = await Promise.all(tabs.map(async tab => {
        await tab.metricSession.send('HeapProfiler.collectGarbage')
        return (await readMetrics(tab.metricSession)).JSHeapUsedSize
      }))
      heapSamples.push(...heaps)
      pageErrors.push(...tabs.flatMap(tab => tab.recorder.pageErrors))
      external.push(...tabs.flatMap(tab => tab.recorder.external))
      assert.equal(turnSamples.every(value => value > 0), true)
      if (turnSamples.some(value => value >= turnBudgetMs)) {
        budgetViolations.push({ budget: 'turnMs', limit: turnBudgetMs, observedMax: Math.max(...turnSamples) })
      }
      if (heaps.some(value => value >= heapBudgetBytes)) {
        budgetViolations.push({ budget: 'perSessionHeapBytes', limit: heapBudgetBytes, observedMax: Math.max(...heaps) })
      }
      cpuSamples.push({ cpuPercentOfOneCore: ((afterTotal - beforeTotal) / (wallMs / 1000)) * 100, wallMs })
      await Promise.all(tabs.map(async tab => await tab.metricSession.detach().catch(() => {})))
    } finally {
      await Promise.all(tabs.map(async tab => {
        await tab.page.close().catch(() => {})
        await tab.context.close()
      }))
    }
  }
  const timing = samples => ({
    samples,
    median: median(samples),
    p95: percentile(samples, 0.95),
    max: Math.max(...samples),
    min: Math.min(...samples),
    standardDeviation: standardDeviation(samples),
    coefficientOfVariation: standardDeviation(samples) / median(samples),
  })
  return {
    sessions: scale,
    coldMs: { samples: coldSamples, median: median(coldSamples), max: Math.max(...coldSamples), attempts: coldAttempts },
    coldBootFailures,
    turnMs: timing(turnSamples),
    renderedMs: timing(renderedSamples),
    taskDurationMs: { median: median(taskDurationSamples), p95: percentile(taskDurationSamples, 0.95) },
    pageHeapBytes: { median: median(heapSamples), max: Math.max(...heapSamples) },
    cpuPercentOfOneCore: cpuSamples.map(sample => Math.round(sample.cpuPercentOfOneCore * 100) / 100),
    cpuWallMs: cpuSamples.map(sample => sample.wallMs),
    budgetViolations,
    pageErrors,
    external,
  }
}

let image
let browser
let browserCdp
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  const dataDir = await mkdtemp(`${tmpdir()}/dsh-browser-contention-`)
  const app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({
    headless: true,
    channel: process.env.DSH_POC_BROWSER ?? 'chrome',
    args: ['--enable-precise-memory-info'],
  })
  browserCdp = await browser.newBrowserCDPSession()
  try {
    const unbounded = []
    for (const scale of scales) {
      unbounded.push(await measureScale({ browser, browserCdp, origin, scale }))
    }
    const largestScale = Math.max(...scales)
    const capped = await measureScale({ browser, browserCdp, origin, scale: largestScale, limit: queueWidth })
    const unboundedMax = unbounded.find(entry => entry.sessions === largestScale)
    const allRuns = [...unbounded, capped]
    const violations = allRuns.flatMap(entry => entry.budgetViolations.map(violation => ({ sessions: entry.sessions, ...violation })))
    process.stdout.write(`${JSON.stringify({
      result: violations.length === 0 ? 'passed' : 'budget-exceeded',
      browser: browser.version(),
      scope: 'multi-session-contention-and-fairness',
      budgets: { turnMs: turnBudgetMs, perSessionHeapBytes: heapBudgetBytes },
      scales: unbounded,
      queueComparison: {
        queueWidth,
        unboundedSessions: unboundedMax.sessions,
        unbounded: {
          turnMs: unboundedMax.turnMs,
          renderedMs: unboundedMax.renderedMs,
          coldMs: unboundedMax.coldMs,
          cpuPercentOfOneCore: unboundedMax.cpuPercentOfOneCore,
        },
        capped,
      },
      budgetViolations: violations,
    })}\n`)
    assert.deepEqual(allRuns.flatMap(entry => entry.pageErrors), [])
    assert.deepEqual(allRuns.flatMap(entry => entry.external), [])
    assert.deepEqual(violations, [], 'measured latency or heap exceeded the configured budget')
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
} finally {
  await browser?.close()
  await image?.cleanup()
}
