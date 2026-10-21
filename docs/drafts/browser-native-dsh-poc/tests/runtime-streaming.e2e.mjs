/** Long-output UI experiment over the real DSH Worker; no artificial delay is applied to real model traffic. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium, webkit } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
const mode = process.env.DSH_POC_LLM ?? 'scripted'
if (!['chrome', 'chromium', 'webkit'].includes(browserName)) throw new Error('Invalid DSH_POC_BROWSER')
if (!['scripted', 'real'].includes(mode)) throw new Error('Invalid DSH_POC_LLM')
if (mode === 'real' && process.env.DSH_POC_ENV_FILE === undefined) throw new Error('Real mode requires DSH_POC_ENV_FILE')
const localNoProxy = new Set((process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').filter(Boolean))
localNoProxy.add('127.0.0.1')
localNoProxy.add('localhost')
process.env.NO_PROXY = [...localNoProxy].join(',')
process.env.no_proxy = process.env.NO_PROXY
const dataDir = await mkdtemp(join(tmpdir(), 'dsh-streaming-data-'))
const evidenceDir = resolve(process.env.DSH_POC_EVIDENCE_DIR ?? join('.artifacts', `browser-streaming-${browserName}-${mode}-${Date.now()}`))
const marker = `STREAM_FINISHED_${crypto.randomUUID().replaceAll('-', '')}`
const prompt = mode === 'real'
  ? `Without tools, write 80 numbered lines about browser runtime engineering. Each line must contain at least 15 English words. Include a short concrete example in each line. Do not summarize or skip lines. End with exactly ${marker}.`
  : `Reply with ${marker} and ${'browser-runtime-stream-check '.repeat(7)}`
const requests = []
const pageErrors = []
const llmStatuses = []
let image
let app
let browser
let page
let summary
let phase = 'setup'
try {
  await mkdir(evidenceDir, { recursive: true })
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: mode, envFile: process.env.DSH_POC_ENV_FILE })
  const origin = await app.listen(0)
  const launcher = browserName === 'webkit' ? webkit : chromium
  browser = await launcher.launch({ headless: true, ...(browserName === 'chrome' ? { channel: 'chrome' } : {}) })
  page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (request.url().endsWith('/api/browser-native/session/create')) requests.push({ path: '/session/create', body: request.postDataJSON() })
  })
  page.on('response', response => {
    if (response.url().endsWith('/api/browser-native/llm')) llmStatuses.push(response.status())
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&preview-fixture=none`)
  phase = 'streaming'
  await page.evaluate(() => {
    const capture = { samples: [], active: true, frame: 0, longTasks: [], previous: '', startedAt: performance.now() }
    const tick = () => {
      if (!capture.active) return
      const current = [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')].map(node => node.textContent ?? '').join('')
      if (current !== '' && current !== capture.previous) {
        capture.previous = current
        capture.samples.push({ elapsedMs: performance.now() - capture.startedAt, textLength: current.length })
      }
      capture.frame = requestAnimationFrame(tick)
    }
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      capture.observer = new PerformanceObserver(list => {
        capture.longTasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration })))
      })
      capture.observer.observe({ type: 'longtask' })
    }
    window.__dshStreamingExperiment = capture
    capture.frame = requestAnimationFrame(tick)
  })
  const result = await sendTurn({ page, origin, requests, prompt, timeout: mode === 'real' ? 300_000 : 45_000,
    probeWhileRunning: async () => {
      const stop = page.getByRole('button', { name: /^(Stop generating|停止生成)$/ }).last()
      await stop.waitFor({ timeout: 30_000 })
      assert.equal(await stop.isEnabled(), true)
      const startedAt = Date.now()
      const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
      await composer.fill('Draft entered while the DSH Worker is running')
      assert.match(await composer.innerText(), /Draft entered/)
      await composer.fill('')
      return { draftInteractionMs: Date.now() - startedAt, stopEnabled: true }
    },
  })
  const capture = await page.evaluate(() => {
    const capture = window.__dshStreamingExperiment
    capture.active = false
    cancelAnimationFrame(capture.frame)
    capture.observer?.disconnect()
    return { samples: capture.samples, longTasks: capture.longTasks }
  })
  const terminal = result.session.events.findLast(event => event.type === 'turn/end')
  assert.equal(terminal.data.reason.kind, 'completed')
  const userMessages = result.session.events.filter(event => event.type === 'user/message')
    .map(event => ({ seq: event.seq, time: event.time, content: event.data.content }))
  assert.equal(result.session.events.filter(event => event.type === 'tool/call').length, 0)
  const text = assistantText(result.session, result.turn)
  assert.ok(text.includes(marker), 'final assistant output must contain the marker')
  assert.deepEqual(pageErrors, [])
  assert.ok(llmStatuses.length > 0 && llmStatuses.every(status => status === 200))
  await waitFor(async () => {
    const stored = JSON.parse(await readFile(join(dataDir, 'sessions', `${result.sessionId}.json`), 'utf8'))
    return stored.durableThroughSeq >= terminal.seq
  }, 'terminal event durability')
  const scroll = await page.evaluate(() => {
    let node = document.querySelector('[data-chat-flow-kind="assistant-step"]')
    while (node && !(node.scrollHeight > node.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY))) node = node.parentElement
    if (!node) return { available: false }
    const before = node.scrollTop
    node.scrollTop = before > 0 ? 0 : node.scrollHeight
    return { available: true, before, after: node.scrollTop, changed: node.scrollTop !== before }
  })
  const first = capture.samples[0]
  const last = capture.samples.at(-1)
  summary = { browser: browserName, mode, model: app.llm.model, sessionId: result.sessionId, phase,
    assistantTextLength: text.length, frameSamples: capture.samples, frameGrowth: first !== undefined && last.textLength > first.textLength,
    streamSpanMs: first === undefined ? 0 : last.elapsedMs - first.elapsedMs, input: result.runningProbe,
    scroll, longTasks: capture.longTasks, longTaskObserverSupported: await page.evaluate(() => PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false),
    llmStatuses, pageErrors, terminal: terminal.data.reason.kind,
    elapsedMs: result.elapsedMs, observedUserMessages: userMessages, evidenceDir }
  await page.screenshot({ path: join(evidenceDir, 'completed.png') })
  await writeFile(join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  assert.ok(capture.samples.length >= 2 && summary.frameGrowth,
    `Expected multiple growing animation-frame samples: ${JSON.stringify(summary)}`)
  if (mode === 'real') assert.ok(scroll.available && scroll.changed, 'long output must support actual scrolling')
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} catch (error) {
  await writeFile(join(evidenceDir, 'failure.json'), `${JSON.stringify({ phase, error: error.message, summary, pageErrors, llmStatuses }, null, 2)}\n`)
  throw error
} finally {
  await page?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  await rm(dataDir, { recursive: true, force: true })
}
