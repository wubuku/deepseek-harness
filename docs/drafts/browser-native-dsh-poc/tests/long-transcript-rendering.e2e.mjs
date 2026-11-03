/**
 * Measure main-thread cost of a long transcript: scroll work, DOM growth, and
 * one long assistant message appended as a two-part stream.
 *
 * Turns run through the real composer so the UI builds its own transcript; each
 * checkpoint scrolls the transcript end to end and reads Chrome's long-task and
 * Performance metrics. The long-stream turn uses the PoC scripted fault hook to
 * deliver a multi-kilobyte message in two deltas.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const browserChannel = process.env.DSH_POC_BROWSER ?? 'chrome'

const MARKER = 'BROWSER_NATIVE_LONG_TRANSCRIPT_E2E'
const checkpoints = String(process.env.DSH_POC_RENDER_TURNS ?? '50,150')
  .split(',').map(value => Number(value.trim()))
const scrollSteps = Number(process.env.DSH_POC_RENDER_SCROLL_STEPS ?? 20)
const longTaskBudgetMs = Number(process.env.DSH_POC_RENDER_LONG_TASK_BUDGET_MS ?? 100)
const domNodeBudget = Number(process.env.DSH_POC_RENDER_DOM_BUDGET ?? 60_000)
const scrollBurstBudgetMs = Number(process.env.DSH_POC_RENDER_SCROLL_BURST_MS ?? 800)
const longStreamCharacters = Number(process.env.DSH_POC_RENDER_LONG_STREAM_CHARS ?? 12_000)
const previewUrl = origin => `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`

for (const value of checkpoints) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`checkpoints must be positive integers, got ${String(value)}`)
}
for (let index = 1; index < checkpoints.length; index += 1) {
  if (checkpoints[index] <= checkpoints[index - 1]) throw new Error('DSH_POC_RENDER_TURNS must be strictly increasing')
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const longText = Array.from({ length: Math.ceil(longStreamCharacters / 96) }, (_, index) =>
  `RENDER_LONG_STREAM_E2E line ${String(index + 1)}: the transcript keeps every line so scrolling and appending can be measured.`)
  .join('\n')
  .slice(0, longStreamCharacters)

function createRecorder(page, origin) {
  const requests = []
  const pageErrors = []
  const nonLocalRequests = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.origin.startsWith(origin)) nonLocalRequests.push(`${url.origin}${url.pathname}`)
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = JSON.parse(request.postData() ?? '{}') } catch {}
    requests.push({ path: url.pathname, body })
  })
  return { requests, pageErrors, nonLocalRequests }
}

async function metrics(cdp) {
  const { metrics: values } = await cdp.send('Performance.getMetrics')
  const read = name => (values.find(metric => metric.name === name)?.value ?? 0) * 1_000
  return { task: read('TaskDuration'), script: read('ScriptDuration'), layout: read('LayoutDuration') }
}

async function installLongTaskObserver(page) {
  await page.evaluate(() => {
    const recorder = { entries: [] }
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) recorder.entries.push({ start: entry.startTime, duration: entry.duration })
    })
    observer.observe({ entryTypes: ['longtask'] })
    window.__dshLongTasks = recorder
    window.__dshLongTaskObserver = observer
  })
}

async function resetLongTasks(page) {
  await page.evaluate(() => { window.__dshLongTasks.entries.length = 0 })
}

async function readLongTasks(page) {
  return await page.evaluate(() => {
    const durations = window.__dshLongTasks.entries.map(entry => entry.duration)
    return {
      count: durations.length,
      totalMs: durations.reduce((total, value) => total + value, 0),
      longestMs: durations.length === 0 ? 0 : Math.max(...durations),
    }
  })
}

async function domStats(page) {
  return await page.evaluate(() => {
    const flowItems = document.querySelectorAll('[data-chat-flow-kind]')
    return {
      nodes: document.getElementsByTagName('*').length,
      flowItems: flowItems.length,
      assistantSteps: document.querySelectorAll('[data-chat-flow-kind="assistant-step"]').length,
      textLength: document.body.innerText.length,
    }
  })
}

async function prepareScroller(page) {
  const found = await page.evaluate(() => {
    const candidates = [document.scrollingElement, ...document.querySelectorAll('*')]
    let best
    for (const node of candidates) {
      if (!(node instanceof HTMLElement)) continue
      if (node.clientHeight < 200) continue
      if (!/(auto|scroll)/.test(getComputedStyle(node).overflowY)) continue
      const overflow = node.scrollHeight - node.clientHeight
      if (overflow <= 0) continue
      if (best === undefined || overflow > best.overflow) best = { node, overflow, clientHeight: node.clientHeight }
    }
    if (best === undefined) return undefined
    window.__dshTranscriptScroller = best.node
    return { overflow: best.overflow, clientHeight: best.clientHeight }
  })
  assert.notEqual(found, undefined, 'the transcript must expose a vertical scroller')
  return found
}

/**
 * Scroll the whole transcript once, spending two animation frames per step so
 * layout and paint both land inside the measured window.
 * @param page - Preview page with a prepared scroller.
 * @param steps - Number of scroll steps across the transcript.
 * @returns Per-step frame durations.
 */
async function scrollBurst(page, steps) {
  return await page.evaluate(async count => {
    const scroller = window.__dshTranscriptScroller
    scroller.scrollTop = scroller.scrollHeight
    await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))
    const span = scroller.scrollHeight - scroller.clientHeight
    const step = Math.max(1, Math.floor(span / count))
    const frames = []
    for (let index = 0; index < count; index += 1) {
      const startedAt = performance.now()
      scroller.scrollTop = Math.max(0, scroller.scrollTop - step)
      await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))
      frames.push(performance.now() - startedAt)
    }
    scroller.scrollTop = scroller.scrollHeight
    return frames
  }, steps)
}

async function measureScroll(page, cdp, label) {
  const scroller = await prepareScroller(page)
  const dom = await domStats(page)
  await resetLongTasks(page)
  const before = await metrics(cdp)
  const frames = await scrollBurst(page, scrollSteps)
  const after = await metrics(cdp)
  const longTasks = await readLongTasks(page)
  return {
    label,
    scroller,
    dom,
    scroll: {
      steps: scrollSteps,
      taskMs: after.task - before.task,
      scriptMs: after.script - before.script,
      layoutMs: after.layout - before.layout,
      medianFrameMs: median(frames),
      maxFrameMs: Math.max(...frames),
      longTasks,
    },
  }
}

async function run() {
  const image = await createRuntimeValidationDist({ roster: 'original' })
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-long-transcript-'))
  let browser
  let context
  let page
  let app
  try {
    app = await createBrowserNativeV2Server({
      dataDir,
      distRoot: image.distRoot,
      llmMode: 'scripted',
      testHooks: {
        scriptedLlmFault: body => {
          if (!Array.isArray(body.tools) || body.tools.length === 0) return undefined
          const prompt = (body.messages ?? [])
            .filter(message => message.role === 'user' && typeof message.content === 'string')
            .map(message => message.content)
            .join('\n')
          if (!prompt.includes('RENDER_LONG_STREAM_E2E')) return undefined
          const split = Math.floor(longText.length / 2)
          return { kind: 'delayed-text', text: longText, prefix: longText.slice(0, split), delayMs: 120 }
        },
      },
    })
    const origin = await app.listen(0)
    browser = await chromium.launch({ headless: true, channel: browserChannel })
    context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
    page = await context.newPage()
    const recorder = createRecorder(page, origin)
    await openPreview(page, previewUrl(origin))
    await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
    await installLongTaskObserver(page)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable')

    const state = { sessionId: undefined }
    const turnDurations = []
    const checkpointsOut = []
    const lastTurn = checkpoints.at(-1)
    let previous = 0
    for (const checkpoint of checkpoints) {
      for (let index = previous + 1; index <= checkpoint; index += 1) {
        const turn = await sendTurn({
          page,
          origin,
          requests: recorder.requests,
          prompt: `${MARKER} render-turn-${String(index)}: keep the transcript complete.`,
          marker: 'Browser-native DSH completed this turn',
          ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
        })
        state.sessionId = turn.sessionId
        turnDurations.push(turn.elapsedMs)
      }
      previous = checkpoint
      checkpointsOut.push(await measureScroll(page, cdp, `${String(checkpoint)}-turns`))
    }

    const domBeforeLong = await domStats(page)
    await prepareScroller(page)
    await resetLongTasks(page)
    const beforeLong = await metrics(cdp)
    const longTurn = await sendTurn({
      page,
      origin,
      requests: recorder.requests,
      prompt: 'RENDER_LONG_STREAM_E2E: reply with the long streamed message.',
      marker: 'RENDER_LONG_STREAM_E2E line 1',
      sessionId: state.sessionId,
      captureStream: true,
      timeout: 240_000,
    })
    const afterLong = await metrics(cdp)
    const longTasks = await readLongTasks(page)
    const streamFrames = longTurn.streamSamples.map((sample, index, all) =>
      index === 0 ? sample.elapsedMs : sample.elapsedMs - all[index - 1].elapsedMs)
    const domAfterLong = await domStats(page)
    const longAppend = {
      appendedCharacters: longText.length,
      deltaNodes: domAfterLong.nodes - domBeforeLong.nodes,
      taskMs: afterLong.task - beforeLong.task,
      scriptMs: afterLong.script - beforeLong.script,
      layoutMs: afterLong.layout - beforeLong.layout,
      streamSamples: longTurn.streamSamples.length,
      maxFrameMs: streamFrames.length === 0 ? 0 : Math.max(...streamFrames),
      longTasks,
      turnMs: longTurn.elapsedMs,
    }
    const afterLongScroll = await measureScroll(page, cdp, `${String(lastTurn)}-turns-after-long-append`)

    const failures = []
    const check = (condition, label) => { if (!condition) failures.push(label) }
    for (const checkpoint of checkpointsOut) {
      check(checkpoint.dom.nodes <= domNodeBudget,
        `${checkpoint.label}: DOM nodes ${String(checkpoint.dom.nodes)} exceed ${String(domNodeBudget)}`)
      check(checkpoint.scroll.longTasks.longestMs <= longTaskBudgetMs,
        `${checkpoint.label}: longest task ${String(checkpoint.scroll.longTasks.longestMs)} ms exceeds ${String(longTaskBudgetMs)} ms`)
      check(checkpoint.scroll.taskMs <= scrollBurstBudgetMs,
        `${checkpoint.label}: scroll burst ${String(Math.round(checkpoint.scroll.taskMs))} ms exceeds ${String(scrollBurstBudgetMs)} ms`)
    }
    check(afterLongScroll.dom.nodes <= domNodeBudget,
      `${afterLongScroll.label}: DOM nodes ${String(afterLongScroll.dom.nodes)} exceed ${String(domNodeBudget)}`)
    check(afterLongScroll.scroll.longTasks.longestMs <= longTaskBudgetMs,
      `${afterLongScroll.label}: longest task ${String(afterLongScroll.scroll.longTasks.longestMs)} ms exceeds ${String(longTaskBudgetMs)} ms`)
    check(longAppend.longTasks.longestMs <= longTaskBudgetMs,
      `long append: longest task ${String(longAppend.longTasks.longestMs)} ms exceeds ${String(longTaskBudgetMs)} ms`)
    check(recorder.pageErrors.length === 0, 'the page must not report errors')
    check(recorder.nonLocalRequests.length === 0, 'the browser must not issue any non-local request')

    const report = {
      result: failures.length === 0 ? 'passed' : 'failed',
      browser: browserChannel,
      checkpoints,
      viewport: { width: 1440, height: 1000 },
      budgets: { longTaskMs: longTaskBudgetMs, domNodes: domNodeBudget, scrollBurstMs: scrollBurstBudgetMs, scrollSteps },
      turns: {
        completed: turnDurations.length,
        medianMs: median(turnDurations),
        maxMs: Math.max(...turnDurations),
      },
      measurements: checkpointsOut,
      longAppend,
      afterLongScroll,
      pageErrors: recorder.pageErrors,
      nonLocalRequests: recorder.nonLocalRequests,
      failures,
    }
    console.log(JSON.stringify(report))
    assert.deepEqual(failures, [])
  } finally {
    if (page !== undefined) await page.close().catch(() => {})
    if (context !== undefined) await context.close().catch(() => {})
    if (browser !== undefined) await browser.close().catch(() => {})
    if (app !== undefined) await app.close().catch(() => {})
  }
}

await run()
