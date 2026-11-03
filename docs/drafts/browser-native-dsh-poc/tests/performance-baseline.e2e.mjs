/**
 * Measure cold-start and hydrate cost with one and four concurrent Sessions.
 *
 * Each Session runs in its own BrowserContext with a durable Workspace, so the
 * numbers describe per-tab cost and contention, not a single shared Worker.
 * Memory is the page CDP `JSHeapUsedSize` plus Dedicated Worker heaps from
 * `Runtime.getHeapUsage`; it is JavaScript heap, not OS RSS.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { sendTurn, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright

const MARKER = 'BROWSER_NATIVE_SCRIPTED_E2E_OK'
const SCALES = [1, 4]
const SAMPLES_PER_SCALE = 3
const coldBudgetMs = Number(process.env.DSH_POC_PERF_COLD_BUDGET_MS ?? 60_000)
const hydrateBudgetMs = Number(process.env.DSH_POC_PERF_HYDRATE_BUDGET_MS ?? 45_000)
const heapBudgetBytes = Number(process.env.DSH_POC_PERF_HEAP_BUDGET_MB ?? 512) * 1024 * 1024
const previewUrl = origin => `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

async function measurePage(page, origin, requests) {
  const startedAt = Date.now()
  await page.goto(previewUrl(origin), { waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  const composerMs = Date.now() - startedAt
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const syncedMs = Date.now() - startedAt
  const status = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
  assert.equal(typeof status?.revision, 'number', 'a synced Workspace must report its revision')
  const turn = await sendTurn({
    page,
    origin,
    requests,
    prompt: `${MARKER} perf baseline turn`,
    marker: MARKER,
    timeout: 60_000,
  })
  return { composerMs, syncedMs, turnMs: turn.elapsedMs, revision: status.revision, sessionId: turn.sessionId }
}

async function reloadPage(page) {
  const startedAt = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  const composerMs = Date.now() - startedAt
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const syncedMs = Date.now() - startedAt
  const markerVisible = await page.evaluate(marker => [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')]
    .some(node => node.textContent?.includes(marker)), MARKER)
  return { composerMs, syncedMs, markerVisible }
}

async function pageHeapBytes(context, page) {
  const session = await context.newCDPSession(page)
  await session.send('Performance.enable')
  await session.send('HeapProfiler.collectGarbage')
  const metrics = await session.send('Performance.getMetrics')
  const found = metrics.metrics.find(metric => metric.name === 'JSHeapUsedSize')
  await session.detach()
  return found?.value ?? null
}

async function workerHeaps(session) {
  const { targetInfos } = await session.send('Target.getTargets')
  const workers = targetInfos.filter(target => target.type === 'worker')
  const heaps = []
  for (const worker of workers) {
    let attached
    try {
      attached = await session.send('Target.attachToTarget', { targetId: worker.targetId, flatten: false })
    } catch {
      continue
    }
    let nextMessageId = 0
    const callWorker = method => new Promise(resolveReply => {
      const messageId = nextMessageId += 1
      const listener = event => {
        if (event.sessionId !== attached.sessionId) return
        const message = JSON.parse(event.message)
        if (message.id !== messageId) return
        clearTimeout(timer)
        session.off('Target.receivedMessageFromTarget', listener)
        resolveReply(message.result)
      }
      const timer = setTimeout(() => {
        session.off('Target.receivedMessageFromTarget', listener)
        resolveReply(undefined)
      }, 5_000)
      session.on('Target.receivedMessageFromTarget', listener)
      session.send('Target.sendMessageToTarget', {
        sessionId: attached.sessionId,
        message: JSON.stringify({ id: messageId, method, params: {} }),
      }).catch(() => {})
    })
    await callWorker('HeapProfiler.collectGarbage')
    const reply = await callWorker('Runtime.getHeapUsage')
    await session.send('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => {})
    heaps.push({ url: worker.url, usedSize: reply?.usedSize ?? null })
  }
  return heaps
}

let image
let app
let browser
let browserCdp
const dataDirs = []

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  const dataDir = await mkdtemp(`${tmpdir()}/dsh-browser-perf-`)
  dataDirs.push(dataDir)
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({
    headless: true,
    channel: process.env.DSH_POC_BROWSER ?? 'chrome',
    args: ['--enable-precise-memory-info'],
  })
  browserCdp = await browser.newBrowserCDPSession()
  const scales = []
  for (const scale of SCALES) {
    const coldSamples = []
    const hydrateSamples = []
    const heapSamples = []
    for (let sample = 0; sample < SAMPLES_PER_SCALE; sample += 1) {
      process.stderr.write(`perf baseline: sessions=${String(scale)} sample=${String(sample)}\n`)
      const tabs = await Promise.all(Array.from({ length: scale }, async () => {
        const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
        const page = await context.newPage()
        const requests = []
        page.on('request', request => {
          const url = new URL(request.url())
          if (!url.pathname.startsWith('/api/browser-native/')) return
          let body
          try { body = request.postDataJSON() } catch { body = undefined }
          requests.push({ path: url.pathname, body })
        })
        return { context, page, requests }
      }))
      try {
        const cold = await Promise.all(tabs.map(tab => measurePage(tab.page, origin, tab.requests)))
        coldSamples.push(...cold)
        const hydrate = await Promise.all(tabs.map(tab => reloadPage(tab.page)))
        hydrateSamples.push(...hydrate)
        for (const entry of hydrate) {
          assert.equal(entry.markerVisible, true, 'hydrate must project the persisted assistant message')
        }
        const pageHeaps = await Promise.all(tabs.map(tab => pageHeapBytes(tab.context, tab.page)))
        const workers = await workerHeaps(browserCdp)
        assert.ok(workers.length >= scale,
          `expected at least ${String(scale)} Worker targets, saw ${String(workers.length)}`)
        heapSamples.push({
          pageHeapBytes: pageHeaps.filter(value => value !== null),
          workerHeaps: workers,
        })
      } finally {
        await Promise.all(tabs.map(async tab => {
          await tab.page.close().catch(() => {})
          await tab.context.close()
        }))
      }
    }
    const cold = {
      samples: coldSamples,
      medianComposerMs: median(coldSamples.map(sample => sample.composerMs)),
      medianSyncedMs: median(coldSamples.map(sample => sample.syncedMs)),
      medianTurnMs: median(coldSamples.map(sample => sample.turnMs)),
      maxSyncedMs: Math.max(...coldSamples.map(sample => sample.syncedMs)),
    }
    const hydrate = {
      samples: hydrateSamples,
      medianComposerMs: median(hydrateSamples.map(sample => sample.composerMs)),
      medianSyncedMs: median(hydrateSamples.map(sample => sample.syncedMs)),
      maxSyncedMs: Math.max(...hydrateSamples.map(sample => sample.syncedMs)),
    }
    const workerTotals = heapSamples.map(sample => sample.workerHeaps.reduce((total, worker) => total + (worker.usedSize ?? 0), 0))
    const pageHeaps = heapSamples.flatMap(sample => sample.pageHeapBytes)
    const memory = {
      pageHeapSamples: pageHeaps,
      pageHeapMedianBytes: median(pageHeaps),
      workerHeapTotalSamples: workerTotals,
      workerHeapMedianTotalBytes: median(workerTotals),
      workerHeapMedianPerTabBytes: median(workerTotals) / scale,
      workerCounts: heapSamples.map(sample => sample.workerHeaps.length),
    }
    assert.ok(cold.medianSyncedMs < coldBudgetMs,
      `cold start median ${String(cold.medianSyncedMs)}ms exceeds ${String(coldBudgetMs)}ms`)
    assert.ok(hydrate.medianSyncedMs < hydrateBudgetMs,
      `hydrate median ${String(hydrate.medianSyncedMs)}ms exceeds ${String(hydrateBudgetMs)}ms`)
    const worstTabBytes = Math.max(...pageHeaps) + memory.workerHeapMedianTotalBytes / scale
    assert.ok(worstTabBytes < heapBudgetBytes,
      `per-tab JavaScript heap ${String(Math.round(worstTabBytes))} bytes exceeds ${String(heapBudgetBytes)} bytes`)
    scales.push({ sessions: scale, cold, hydrate, memory, worstTabHeapBytes: Math.round(worstTabBytes) })
  }
  const scaleOne = scales.find(entry => entry.sessions === 1)
  const scaleFour = scales.find(entry => entry.sessions === 4)
  console.log(JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'cold-start-and-hydrate-baseline',
    budgets: { coldMs: coldBudgetMs, hydrateMs: hydrateBudgetMs, perTabHeapBytes: heapBudgetBytes },
    scales,
    verdict: {
      coldStartMedianMs: scaleOne.cold.medianSyncedMs,
      hydrateMedianMs: scaleOne.hydrate.medianSyncedMs,
      fourSessionColdStartMedianMs: scaleFour.cold.medianSyncedMs,
      fourSessionHydrateMedianMs: scaleFour.hydrate.medianSyncedMs,
      coldStartScalingRatio: scaleFour.cold.medianSyncedMs / scaleOne.cold.medianSyncedMs,
      hydrateScalingRatio: scaleFour.hydrate.medianSyncedMs / scaleOne.hydrate.medianSyncedMs,
      perTabWorkerHeapBytesAtOneSession: Math.round(scaleOne.memory.workerHeapMedianPerTabBytes),
      perTabWorkerHeapBytesAtFourSessions: Math.round(scaleFour.memory.workerHeapMedianPerTabBytes),
      perTabWorkerHeapFlat: Math.abs(scaleFour.memory.workerHeapMedianPerTabBytes - scaleOne.memory.workerHeapMedianPerTabBytes)
        / scaleOne.memory.workerHeapMedianPerTabBytes < 0.1,
      perTabHeapBytesAtFourSessions: scaleFour.worstTabHeapBytes,
      allSessionsSynced: true,
      hydrateProjectedHistory: true,
    },
    note: 'Each Session runs in its own BrowserContext with a durable OPFS Workspace, so four Sessions mean four tabs and four Dedicated Workers. Cold start covers navigation, composer readiness and Workspace sync; hydrate covers the same path after reload with a persisted Session and Workspace. Memory is JavaScript heap (page CDP JSHeapUsedSize plus Worker Runtime.getHeapUsage), not OS RSS, and scripted LLM turns exclude real provider latency.',
  }, null, 2))
} finally {
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  await Promise.all(dataDirs.map(dir => rm(dir, { recursive: true, force: true })))
}
