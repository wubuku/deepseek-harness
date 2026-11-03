/**
 * Measure whether spawning the Host Worker during workspace selection shortens
 * cold start, and what the overlap costs in memory.
 *
 * Baseline and prewarm runs use identical scripted backends, profiles and
 * durable Workspaces. Two selection delays are sampled: the harness clicking
 * the chooser as fast as possible, and a fixed 1.5 s pause that stands in for a
 * person reading the dialog. Boot phases come from page-relative marks exposed
 * by `browser-native-boot-timings=1`.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright

const SAMPLES = 3
const SELECTION_DELAYS_MS = [0, 1500]
const coldBudgetMs = Number(process.env.DSH_POC_PERF_COLD_BUDGET_MS ?? 60_000)
const modes = [
  { name: 'baseline', prewarm: false },
  { name: 'prewarm', prewarm: true },
]

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function previewUrl(origin, prewarm) {
  const parameters = new URLSearchParams({
    'browser-native': '1',
    'browser-native-durable': '1',
    'browser-native-test': 'workspace-recovery',
    'browser-native-boot-timings': '1',
    'preview-fixture': 'none',
  })
  if (prewarm) parameters.set('browser-native-prewarm', '1')
  return `${origin}/preview.html?${parameters.toString()}`
}

/**
 * Wait until the workspace chooser is on screen, optionally pause, then finish selection.
 * @param page - Preview page after navigation.
 * @param delayMs - Simulated time the user spends in the chooser.
 * @returns {Promise<void>} Composer is ready.
 */
async function selectWorkspace(page, delayMs) {
  await page.waitForSelector('[class*="frame"]', { timeout: 45_000 })
  const chooser = page.getByRole('textbox', { name: /^(Choose workspace|选择工作区)$/ }).first()
  await chooser.waitFor({ state: 'visible', timeout: 30_000 })
  if (delayMs > 0) await page.waitForTimeout(delayMs)
  await waitForPreview(page)
}

async function pageHeapBytes(context, page) {
  const session = await context.newCDPSession(page)
  await session.send('Performance.enable')
  await session.send('HeapProfiler.collectGarbage')
  const metrics = await session.send('Performance.getMetrics')
  const used = metrics.metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value ?? null
  await session.detach()
  return used
}

async function workerHeaps(browserCdp) {
  const { targetInfos } = await browserCdp.send('Target.getTargets')
  const workers = targetInfos.filter(target => target.type === 'worker')
  const totals = []
  for (const worker of workers) {
    let attached
    try {
      attached = await browserCdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: false })
    } catch { continue }
    let nextMessageId = 0
    const callWorker = method => new Promise(resolveReply => {
      const messageId = nextMessageId += 1
      const listener = event => {
        if (event.sessionId !== attached.sessionId) return
        const message = JSON.parse(event.message)
        if (message.id !== messageId) return
        clearTimeout(timer)
        browserCdp.off('Target.receivedMessageFromTarget', listener)
        resolveReply(message.result)
      }
      const timer = setTimeout(() => {
        browserCdp.off('Target.receivedMessageFromTarget', listener)
        resolveReply(undefined)
      }, 5_000)
      browserCdp.on('Target.receivedMessageFromTarget', listener)
      browserCdp.send('Target.sendMessageToTarget', {
        sessionId: attached.sessionId,
        message: JSON.stringify({ id: messageId, method, params: {} }),
      }).catch(() => {})
    })
    await callWorker('HeapProfiler.collectGarbage')
    const reply = await callWorker('Runtime.getHeapUsage')
    await browserCdp.send('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => {})
    totals.push(reply?.usedSize ?? null)
  }
  return totals.filter(value => value !== null)
}

/**
 * Run one cold start and return wall-clock, phase marks and mid-selection memory.
 * @param options - Browser, origin, mode and simulated selection delay.
 * @returns {Promise<object>} One sample.
 */
async function sample({ browser, browserCdp, origin, prewarm, delayMs }) {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const startedAt = Date.now()
  let selectionHeap
  try {
    await page.goto(previewUrl(origin, prewarm), { waitUntil: 'domcontentloaded' })
    if (delayMs > 0) {
      await page.waitForSelector('[class*="frame"]', { timeout: 45_000 })
      const chooser = page.getByRole('textbox', { name: /^(Choose workspace|选择工作区)$/ }).first()
      await chooser.waitFor({ state: 'visible', timeout: 30_000 })
      await page.waitForTimeout(delayMs)
      selectionHeap = {
        pageBytes: await pageHeapBytes(context, page),
        workerBytes: (await workerHeaps(browserCdp)).reduce((total, value) => total + value, 0),
      }
      await waitForPreview(page)
    } else {
      await selectWorkspace(page, 0)
    }
    const composerMs = Date.now() - startedAt
    const outcome = await waitFor(async () => {
      const status = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__).catch(() => undefined)
      return status?.state === 'synced' ? status : undefined
    }, 'durable Workspace sync', 60_000)
    const syncedMs = Date.now() - startedAt
    const marks = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_BOOT_TIMINGS__ ?? {})
    assert.equal(typeof marks.bootStart, 'number', 'boot timings must expose bootStart')
    assert.equal(typeof marks.sourceChosen, 'number', 'boot timings must expose sourceChosen')
    assert.equal(typeof marks.hostConnected, 'number', 'boot timings must expose hostConnected')
    const workerSpawned = marks.workerSpawned ?? null
    const workerProbed = marks.workerProbed ?? null
    if (prewarm) {
      assert.ok(workerSpawned !== null && workerSpawned < marks.sourceChosen,
        `prewarm must spawn the Worker before workspace selection: ${JSON.stringify(marks)}`)
    } else {
      assert.ok(workerSpawned !== null && workerSpawned > marks.sourceChosen,
        `baseline must spawn the Worker after workspace selection: ${JSON.stringify(marks)}`)
    }
    return {
      composerMs,
      syncedMs,
      revision: outcome.revision,
      marks,
      phases: {
        selectionMs: marks.sourceChosen - marks.bootStart,
        workerSpawnMs: workerProbed === null ? null : workerProbed - workerSpawned,
        probeMs: workerProbed === null ? null : workerProbed - workerSpawned,
        postSelectionMs: marks.hostConnected - marks.sourceChosen,
        overlapMs: workerProbed === null ? 0 : Math.max(0, workerProbed - marks.sourceChosen),
      },
      midSelectionHeapBytes: selectionHeap ?? null,
      pageErrors: [...new Set(pageErrors)],
    }
  } finally {
    await context.close().catch(() => {})
  }
}

let image
let app
let browser
let browserCdp
const dataDirs = []
const report = []

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  const dataDir = await mkdtemp(`${tmpdir()}/dsh-browser-prewarm-`)
  dataDirs.push(dataDir)
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({
    headless: true,
    channel: process.env.DSH_POC_BROWSER ?? 'chrome',
    args: ['--enable-precise-memory-info'],
  })
  browserCdp = await browser.newBrowserCDPSession()
  for (const delayMs of SELECTION_DELAYS_MS) {
    for (const mode of modes) {
      const samples = []
      for (let index = 0; index < SAMPLES; index += 1) {
        process.stderr.write(`prewarm: delay=${String(delayMs)} mode=${mode.name} sample=${String(index)}\n`)
        samples.push(await sample({ browser, browserCdp, origin, prewarm: mode.prewarm, delayMs }))
      }
      const summary = {
        delayMs,
        mode: mode.name,
        samples,
        medianComposerMs: median(samples.map(entry => entry.composerMs)),
        medianSyncedMs: median(samples.map(entry => entry.syncedMs)),
        medianPostSelectionMs: median(samples.map(entry => entry.phases.postSelectionMs)),
        medianProbeMs: median(samples.map(entry => entry.phases.probeMs ?? 0)),
        medianOverlapMs: median(samples.map(entry => entry.phases.overlapMs)),
        maxMidSelectionHeapBytes: Math.max(...samples.map(entry => (entry.midSelectionHeapBytes?.pageBytes ?? 0)
          + (entry.midSelectionHeapBytes?.workerBytes ?? 0))),
      }
      assert.ok(summary.medianSyncedMs < coldBudgetMs,
        `${mode.name} cold start median ${String(summary.medianSyncedMs)}ms exceeds ${String(coldBudgetMs)}ms`)
      report.push(summary)
    }
  }
  const verdicts = []
  for (const delayMs of SELECTION_DELAYS_MS) {
    const baseline = report.find(entry => entry.delayMs === delayMs && entry.mode === 'baseline')
    const prewarm = report.find(entry => entry.delayMs === delayMs && entry.mode === 'prewarm')
    const gainMs = baseline.medianSyncedMs - prewarm.medianSyncedMs
    assert.ok(prewarm.medianSyncedMs <= baseline.medianSyncedMs + 150,
      `prewarm regressed cold start at delay=${String(delayMs)}: ${String(prewarm.medianSyncedMs)}ms vs ${String(baseline.medianSyncedMs)}ms`)
    if (delayMs > 0) {
      assert.ok(prewarm.medianOverlapMs > 0, 'prewarm must overlap the Worker probe with a longer selection')
    }
    assert.ok(prewarm.medianPostSelectionMs < baseline.medianPostSelectionMs,
      `prewarm must shorten the path after workspace selection at delay=${String(delayMs)}: ${String(prewarm.medianPostSelectionMs)}ms vs ${String(baseline.medianPostSelectionMs)}ms`)
    verdicts.push({
      delayMs,
      baselineSyncedMs: baseline.medianSyncedMs,
      prewarmSyncedMs: prewarm.medianSyncedMs,
      gainMs,
      baselinePostSelectionMs: baseline.medianPostSelectionMs,
      prewarmPostSelectionMs: prewarm.medianPostSelectionMs,
      overlapMs: prewarm.medianOverlapMs,
      probeMs: prewarm.medianProbeMs,
      midSelectionHeapBytes: prewarm.maxMidSelectionHeapBytes,
    })
  }
  console.log(JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'cold-start-prewarm',
    note: 'A 1.5 s selection delay stands in for human chooser time; the 0 ms row is the harness clicking immediately.',
    samplesPerCell: SAMPLES,
    cells: report.map(entry => ({
      delayMs: entry.delayMs,
      mode: entry.mode,
      medianComposerMs: entry.medianComposerMs,
      medianSyncedMs: entry.medianSyncedMs,
      medianPostSelectionMs: entry.medianPostSelectionMs,
      medianProbeMs: entry.medianProbeMs,
      medianOverlapMs: entry.medianOverlapMs,
      maxMidSelectionHeapBytes: entry.maxMidSelectionHeapBytes,
      samples: entry.samples.map(entry => ({
        composerMs: entry.composerMs,
        syncedMs: entry.syncedMs,
        phases: entry.phases,
        midSelectionHeapBytes: entry.midSelectionHeapBytes,
        pageErrors: entry.pageErrors,
      })),
    })),
    verdicts,
  }))
} finally {
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup()
  for (const dataDir of dataDirs) await rm(dataDir, { recursive: true, force: true })
}
