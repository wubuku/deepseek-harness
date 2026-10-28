import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-content-chunking-backend-')))
const resultFile = process.env.DSH_POC_RESULT_FILE ?? join(tmpdir(), `dsh-content-chunking-${Date.now()}.json`)
const pageErrors = []
const scenarios = buildScenarios()
let image
let app
let browser
let context
let page

async function test(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

  const results = []
  for (const scenario of scenarios) {
    if (scenario.byteLength === 64 * 1024 * 1024) {
      await page.evaluate(() => {
        const monitor = { previous: performance.now(), maximumFrameGapMs: 0, frames: 0, active: true, frame: 0 }
        const sample = now => {
          if (!monitor.active) return
          monitor.maximumFrameGapMs = Math.max(monitor.maximumFrameGapMs, now - monitor.previous)
          monitor.previous = now
          monitor.frames += 1
          monitor.frame = requestAnimationFrame(sample)
        }
        window.__dshCdcFrameMonitor = monitor
        monitor.frame = requestAnimationFrame(sample)
      })
    }
    const pending = test({
      action: 'content-chunking-probe',
      byteLength: scenario.byteLength,
      contentKind: scenario.contentKind,
      editKind: scenario.editKind,
      editPosition: scenario.editPosition,
      minimumChunkBytes: 32 * 1024,
      averageChunkBytes: scenario.averageChunkBytes,
      alternateAverageChunkBytes: scenario.alternateAverageChunkBytes,
      maximumChunkBytes: scenario.maximumChunkBytes,
    })
    const result = await pending
    assert.equal(result?.ok, true, JSON.stringify({ scenario, result }))
    assert.equal(result.storage, 'DSH Worker OPFS sync access handles')
    assert.equal(result.sourceHash === result.targetHash, false)
    assert.equal(result.results.length, 3)
    const mainThread = scenario.byteLength === 64 * 1024 * 1024
      ? await page.evaluate(() => {
        const monitor = window.__dshCdcFrameMonitor
        if (monitor === undefined) return undefined
        monitor.active = false
        cancelAnimationFrame(monitor.frame)
        return { maximumFrameGapMs: monitor.maximumFrameGapMs, frames: monitor.frames }
      })
      : undefined
    results.push({ ...scenario, ...result, ...(mainThread === undefined ? {} : { mainThread }) })
  }
  assert.deepEqual(pageErrors, [])

  const evidence = {
    result: 'passed',
    browser: 'Chrome Dedicated Worker with OPFS sync access handles',
    userAgent: await page.evaluate(() => navigator.userAgent),
    model: 'not used; this probe does not enter ctx.agentLoop',
    pageErrors,
    scenarios: results,
  }
  await writeFile(resultFile, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({
    result: evidence.result,
    browser: evidence.browser,
    userAgent: evidence.userAgent,
    rawResults: resultFile,
    scenarios: results.map(summarizeScenario),
    pageErrors,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}

function buildScenarios() {
  const mib = 1024 * 1024
  return [
    { name: 'text-same-size-head', contentKind: 'text', editKind: 'replace', editPosition: 'head', byteLength: 16 * mib },
    { name: 'text-same-size-middle', contentKind: 'text', editKind: 'replace', editPosition: 'middle', byteLength: 16 * mib },
    { name: 'text-same-size-tail', contentKind: 'text', editKind: 'replace', editPosition: 'tail', byteLength: 16 * mib },
    { name: 'text-insert-head', contentKind: 'text', editKind: 'insert', editPosition: 'head', byteLength: 16 * mib },
    { name: 'text-insert-middle', contentKind: 'text', editKind: 'insert', editPosition: 'middle', byteLength: 16 * mib },
    { name: 'text-insert-tail', contentKind: 'text', editKind: 'insert', editPosition: 'tail', byteLength: 16 * mib },
    { name: 'text-delete-head', contentKind: 'text', editKind: 'delete', editPosition: 'head', byteLength: 16 * mib },
    { name: 'text-delete-middle', contentKind: 'text', editKind: 'delete', editPosition: 'middle', byteLength: 16 * mib },
    { name: 'text-delete-tail', contentKind: 'text', editKind: 'delete', editPosition: 'tail', byteLength: 16 * mib },
    { name: 'text-64m-replace-middle', contentKind: 'text', editKind: 'replace', editPosition: 'middle', byteLength: 64 * mib },
    { name: 'binary-replace-middle', contentKind: 'binary', editKind: 'replace', editPosition: 'middle', byteLength: 16 * mib },
    { name: 'binary-insert-head', contentKind: 'binary', editKind: 'insert', editPosition: 'head', byteLength: 16 * mib },
    { name: 'binary-insert-middle', contentKind: 'binary', editKind: 'insert', editPosition: 'middle', byteLength: 16 * mib },
    { name: 'binary-delete-head', contentKind: 'binary', editKind: 'delete', editPosition: 'head', byteLength: 16 * mib },
    { name: 'binary-delete-middle', contentKind: 'binary', editKind: 'delete', editPosition: 'middle', byteLength: 16 * mib },
    { name: 'binary-48m-insert-middle', contentKind: 'binary', editKind: 'insert', editPosition: 'middle', byteLength: 48 * mib },
    { name: 'repetitive-replace-middle', contentKind: 'repetitive', editKind: 'replace', editPosition: 'middle', byteLength: 16 * mib },
    { name: 'repetitive-insert-middle', contentKind: 'repetitive', editKind: 'insert', editPosition: 'middle', byteLength: 16 * mib },
  ].map(scenario => ({
    ...scenario,
    averageChunkBytes: 128 * 1024,
    alternateAverageChunkBytes: 512 * 1024,
    maximumChunkBytes: 1024 * 1024,
  }))
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.floor(ordered.length / 2)]
}

function summarizeStrategy(runs) {
  return {
    uploadedBytes: median(runs.map(run => run.uploadedBytes)),
    uploadedChunks: median(runs.map(run => run.uploadedChunks)),
    chunkCount: median(runs.map(run => run.chunkCount)),
    descriptorBytes: median(runs.map(run => run.descriptorBytes)),
    sourceChunkSizes: summarizeChunkSizes(runs, 'sourceChunkSizes'),
    targetChunkSizes: summarizeChunkSizes(runs, 'targetChunkSizes'),
    targetChunkingMs: median(runs.map(run => run.targetChunkingMs)),
    targetReadAndHashMs: median(runs.map(run => run.targetReadAndHashMs)),
    sourceIndexBuildMs: median(runs.map(run => run.sourceIndexBuildMs)),
    targetPreparationMs: median(runs.map(run => run.targetPreparationMs)),
    sourceBytesRead: median(runs.map(run => run.sourceBytesRead)),
    targetBytesRead: median(runs.map(run => run.targetBytesRead)),
    sourceReadCalls: median(runs.map(run => run.sourceReadCalls)),
    targetReadCalls: median(runs.map(run => run.targetReadCalls)),
    maximumChunkBytes: median(runs.map(run => run.maximumChunkBytes)),
  }
}

function summarizeChunkSizes(runs, field) {
  return Object.fromEntries(['minimumBytes', 'medianBytes', 'meanBytes', 'maximumBytes']
    .map(metric => [metric, median(runs.map(run => run[field][metric]))]))
}

function summarizeScenario(scenario) {
  return {
    name: scenario.name,
    sourceBytes: scenario.sourceBytes,
    targetBytes: scenario.targetBytes,
    fixed: summarizeStrategy(scenario.results.map(run => run.fixed)),
    cdc128k: summarizeStrategy(scenario.results.map(run => run.cdc)),
    cdc512k: summarizeStrategy(scenario.results.map(run => run.alternateCdc)),
  }
}
