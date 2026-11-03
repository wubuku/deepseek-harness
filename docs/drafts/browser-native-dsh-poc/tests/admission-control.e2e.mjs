/**
 * Measure 16 parallel Sessions under backend admission control.
 *
 * Sixteen tabs mount their own Session and submit one turn each at the same time.
 * The backend admits at most eight model requests at once and queues the rest in
 * arrival order; this harness samples the admission endpoint while the burst runs,
 * records each turn's latency, and finally proves a seventeenth mount is rejected.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import {
  openPreview, sessionRequest, submitPrompt, waitFor,
} from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright

const MARKER = 'BROWSER_NATIVE_SESSION_SCALE_TURN_E2E'
const tabs = Number(process.env.DSH_POC_ADMISSION_TABS ?? 16)
const maxTurns = Number(process.env.DSH_POC_ADMISSION_MAX_TURNS ?? 8)
const maxMounts = Number(process.env.DSH_POC_ADMISSION_MAX_MOUNTS ?? 16)
const medianBudgetMs = Number(process.env.DSH_POC_ADMISSION_MEDIAN_BUDGET_MS ?? 2_000)
const previewUrl = origin => `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`

assert.equal(tabs, 16, 'this harness compares exactly sixteen mounted Sessions')

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

function createRecorder(page, origin, store) {
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin || !url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    store.requests.push({ path: url.pathname, body })
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin !== origin) return
    if (url.pathname.endsWith('/session/create') && response.status() !== 200) {
      void response.json().then(payload => { store.createFailure = { status: response.status(), ...payload.error } }).catch(() => {})
    }
  })
  page.on('pageerror', error => store.pageErrors.push(error.message))
  return store
}

async function mountTab(browser, origin, index) {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const store = createRecorder(page, origin, { requests: [], pageErrors: [], createFailure: undefined })
  await openPreview(page, previewUrl(origin))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const sessionId = await waitFor(
    () => store.requests.find(request => request.path.endsWith('/session/create'))?.body.sessionId,
    `Session creation for tab ${String(index)}`,
    30_000,
  )
  return { context, page, store, sessionId, index }
}

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-admission-'))
let image
let browser
let app
const mounted = []
const extraContexts = []
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  let holding = true
  let releaseHold
  const hold = new Promise(resolve => { releaseHold = resolve })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    admission: { maxConcurrentTurns: maxTurns, maxMountedSessions: maxMounts },
    testHooks: {
      // Phase A holds every admitted turn until the test releases it, so queue depth,
      // order and starvation are observable on demand. Phase B applies a fixed model
      // delay only, so its latencies measure admission plus browser contention.
      scriptedLlmFault: body => {
        if (!Array.isArray(body.tools) || body.tools.length === 0) return undefined
        if (holding) return { kind: 'barrier-text', release: hold, text: `ADMISSION_HELD_${body.requestId}` }
        return { kind: 'delayed-text', text: `ADMISSION_TURN_${body.requestId}`, delayMs: 200 }
      },
    },
  })
  const origin = await app.listen(0)

  for (let index = 0; index < tabs; index += 1) mounted.push(await mountTab(browser, origin, index))
  const mountedState = await (await fetch(`${origin}/api/browser-native/admission`)).json()
  assert.equal(mountedState.mounts.active, tabs, 'all sixteen tabs must hold a mount lease')
  assert.equal(mountedState.mounts.limit, maxMounts)

  // Phase A: every tab submits at once; admitted turns stay open until all waiters are queued.
  const phaseAStartedAt = Date.now()
  const phaseAErrors = []
  // Release the hold even if the saturation wait fails, so no request outlives the backend.
  const holdWatchdog = setTimeout(() => {
    holding = false
    releaseHold()
  }, 90_000)
  const heldBurst = Promise.all(mounted.map(tab => submitPrompt({
    page: tab.page,
    origin,
    requests: tab.store.requests,
    prompt: `${MARKER} admission-hold-${String(tab.index)}`,
    sessionId: tab.sessionId,
    timeout: 180_000,
  }).catch(error => {
    phaseAErrors.push({ index: tab.index, message: error.message })
    return undefined
  })))
  const saturated = await waitFor(async () => {
    const state = await (await fetch(`${origin}/api/browser-native/admission`)).json()
    const queuedTurns = state.queue.filter(waiter => waiter.purpose === undefined).length
    return state.activeTurns === maxTurns && queuedTurns >= tabs - maxTurns ? state : undefined
  }, `eight active turns with at least ${String(tabs - maxTurns)} queued turns`, 120_000)
  const heldMs = Date.now() - phaseAStartedAt
  assert.deepEqual(saturated.queue.map(waiter => waiter.position),
    Array.from({ length: saturated.queue.length }, (_, index) => index + 1),
    'queue positions must be contiguous')
  const queueSequences = saturated.queue.map(waiter => waiter.sequence)
  assert.deepEqual([...queueSequences].sort((left, right) => left - right), queueSequences,
    'waiters must be listed in arrival order')
  assert.ok(saturated.queue.every(waiter => waiter.queuedMs >= 0))
  const turnQueue = saturated.queue.filter(waiter => waiter.purpose === undefined)
  assert.ok(turnQueue.length >= tabs - maxTurns, 'all turns beyond the concurrency limit must be queued')
  assert.equal(new Set(turnQueue.map(waiter => waiter.sessionId)).size, turnQueue.length,
    'each queued turn must belong to a distinct Session')
  const holdQueueIds = turnQueue.map(waiter => waiter.requestId)
  holding = false
  releaseHold()
  clearTimeout(holdWatchdog)
  await heldBurst
  assert.deepEqual(phaseAErrors, [], 'every tab must finish its held turn')

  const phaseA = await (await fetch(`${origin}/api/browser-native/admission`)).json()
  assert.equal(phaseA.activeTurns, 0)
  assert.equal(phaseA.queuedTurns, 0)
  assert.equal(phaseA.counters.timedOut, 0, 'no queued turn may starve into a timeout')
  assert.equal(phaseA.counters.aborted, 0)
  assert.ok(phaseA.counters.maxQueueWaitMs >= 0)
  const admittedOrder = phaseA.recentAdmitted.map(entry => entry.requestId)
  const observed = admittedOrder.filter(id => holdQueueIds.includes(id))
  const expected = holdQueueIds.filter(id => admittedOrder.includes(id))
  assert.deepEqual(observed, expected, 'turns observed in the queue must be admitted in the same relative order')
  for (const tab of mounted) {
    const session = await sessionRequest(origin, 'read', { sessionId: tab.sessionId, offset: 0 })
    assert.equal(session.status, 200)
    assert.equal(session.events.some(event => event.type === 'assistant/message'), true)
  }

  // Phase B: measure the 16-way turn latency with only the fixed 200 ms model delay.
  const samples = []
  let polling = true
  const poll = async () => {
    while (polling) {
      try {
        samples.push(await (await fetch(`${origin}/api/browser-native/admission`)).json())
      } catch {
        // A sampling failure only drops one observation; the backend counters remain authoritative.
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
    }
  }
  const pollingDone = poll()
  const submittedAt = Date.now()
  const results = await Promise.all(mounted.map(tab => submitPrompt({
    page: tab.page,
    origin,
    requests: tab.store.requests,
    prompt: `${MARKER} admission-turn-${String(tab.index)}`,
    sessionId: tab.sessionId,
    timeout: 180_000,
  })))
  const elapsedMs = Date.now() - submittedAt
  polling = false
  await pollingDone

  const latencies = results.map(result => result.elapsedMs)
  const medianMs = percentile(latencies, 0.5)
  const p95Ms = percentile(latencies, 0.95)
  const peakActive = Math.max(...samples.map(state => state.activeTurns))
  const peakQueued = Math.max(...samples.map(state => state.queuedTurns))

  const settled = await (await fetch(`${origin}/api/browser-native/admission`)).json()
  assert.equal(settled.activeTurns, 0)
  assert.equal(settled.queuedTurns, 0)
  assert.ok(settled.counters.admitted >= tabs * 2, 'both phases must reach admission')
  assert.equal(settled.counters.timedOut, 0, 'no queued request may starve into a timeout')
  assert.equal(settled.counters.aborted, 0)
  assert.equal(settled.counters.maxActiveTurns, maxTurns, 'the backend must never exceed eight concurrent turns')
  assert.ok(settled.counters.maxQueueWaitMs > 0, 'the burst must actually queue at least one turn')

  assert.ok(medianMs <= medianBudgetMs,
    `16-way median ${String(medianMs)}ms exceeds the ${String(medianBudgetMs)}ms admission budget`)
  assert.ok(p95Ms <= 2_500, `16-way p95 ${String(p95Ms)}ms is beyond the queueing budget`)
  for (const tab of mounted) {
    assert.deepEqual(tab.store.pageErrors, [])
    const session = await sessionRequest(origin, 'read', { sessionId: tab.sessionId, offset: 0 })
    assert.equal(session.status, 200)
    assert.equal(session.events.some(event => event.type === 'assistant/message'), true)
    assert.equal(JSON.stringify(session.events).includes(MARKER), true)
  }

  const extraContext = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 } })
  extraContexts.push(extraContext)
  const extraPage = await extraContext.newPage()
  const extraStore = createRecorder(extraPage, origin, { requests: [], pageErrors: [], createFailure: undefined })
  // The seventeenth tab must boot far enough to request a Session, which the backend then rejects.
  const extraOpening = openPreview(extraPage, previewUrl(origin)).catch(() => {})
  const rejected = await waitFor(() => extraStore.createFailure, 'seventeenth mount rejection', 60_000)
  await extraOpening
  assert.equal(rejected.status, 429)
  assert.equal(rejected.code, 'SESSION_MOUNT_LIMIT')

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'admission-control-16-way',
    tabs,
    limits: settled.limits,
    mounts: { active: settled.mounts.active, limit: settled.mounts.limit, peak: mountedState.mounts.active },
    burst: {
      turns: results.length,
      elapsedMs,
      medianMs,
      p95Ms,
      minMs: Math.min(...latencies),
      maxMs: Math.max(...latencies),
    },
    queue: {
      holdMs: heldMs,
      heldActiveTurns: saturated.activeTurns,
      heldQueuedTurns: saturated.queuedTurns,
      heldQueue: turnQueue,
      heldCounters: phaseA.counters,
      samples: samples.length,
      peakActiveTurns: peakActive,
      peakQueuedTurns: peakQueued,
      counters: settled.counters,
      preservedOrder: true,
    },
    mountLimit: { rejectedStatus: rejected.status, rejectedCode: rejected.code },
    pageErrors: mounted.flatMap(tab => tab.store.pageErrors),
  })}\n`)
} finally {
  for (const context of extraContexts) await context.close().catch(() => {})
  for (const tab of mounted) await tab.context.close().catch(() => {})
  await app?.close()
  await browser?.close()
  await image?.cleanup()
  await rm(dataDir, { recursive: true, force: true })
}
