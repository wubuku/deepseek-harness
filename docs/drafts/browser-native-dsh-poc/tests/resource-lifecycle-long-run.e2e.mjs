/**
 * Long-run resource convergence for 16 Sessions and 100+ turns.
 *
 * Seeds 16 persisted Sessions, then cycles through every Session for seven
 * rounds (112 real Agent turns), switching and re-projecting each Session on
 * every turn. Between rounds it collects garbage and records:
 * - Dedicated Worker target count from CDP;
 * - page and Worker JavaScript heaps;
 * - live event listeners and timers counted by the page and Worker test channels.
 *
 * The test fails when Worker count changes, a heap budget is exceeded, or
 * listener/timer growth over the whole run is unbounded. This is JavaScript
 * heap and registration growth, not OS RSS or a production capacity claim.
 *
 * Usage:
 *   DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/resource-lifecycle-long-run.e2e.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, submitPrompt, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const SESSIONS = 16
const SEEDED_SESSIONS = SESSIONS - 1
const CYCLES = Number(process.env.DSH_POC_RESOURCE_CYCLES ?? 7)
const TURNS = SESSIONS * CYCLES + 1
const OWN_MARKER = 'RESOURCE_SESSION_OWN'
const PAGE_HEAP_BUDGET_BYTES = Number(process.env.DSH_POC_RESOURCE_PAGE_HEAP_BUDGET_MB ?? 64) * 1024 * 1024
const WORKER_HEAP_BUDGET_BYTES = Number(process.env.DSH_POC_RESOURCE_WORKER_HEAP_BUDGET_MB ?? 48) * 1024 * 1024
const LISTENER_GROWTH_BUDGET = Number(process.env.DSH_POC_RESOURCE_LISTENER_GROWTH ?? 64)
const TIMER_GROWTH_BUDGET = Number(process.env.DSH_POC_RESOURCE_TIMER_GROWTH ?? 16)

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-resource-lifecycle-'))
const pageErrors = []
let image
let app
let browser
let browserCdp
let page
let ownSessionId
const requests = []

function requestPath(url) {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

async function openSession(sessionId, marker) {
  const row = page.locator(`[data-row-key="session:${sessionId}"]`).first()
  await row.waitFor()
  // The header export control overlaps the first row's pointer box, so invoke
  // the row's own click handler instead of a coordinate click.
  await row.evaluate(node => node.click())
  // Scope the marker to the transcript: the sidebar row title also carries the
  // first user message, and waiting on it can race the Session projection swap.
  await page.locator('[data-chat-flow-kind="user"]').filter({ hasText: marker }).last()
    .waitFor({ timeout: 15_000 })
}

function seededSessionId(index) {
  return `resource-session-${String(index).padStart(2, '0')}`
}

function sessionMarker(index) {
  return `RESOURCE_SESSION_${String(index).padStart(2, '0')}`
}

async function openSeeded(index) {
  await openSession(seededSessionId(index), sessionMarker(index))
}

async function workerRequest(request) {
  return await page.evaluate(async value => {
    const invoke = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof invoke !== 'function') throw new Error('Browser-Native Worker test port is unavailable')
    return await invoke(value)
  }, request)
}

async function pageStats() {
  return await page.evaluate(() => window.__DSH_POC_RESOURCE_STATS__?.())
}

async function pageHeapBytes(context) {
  const session = await context.newCDPSession(page)
  await session.send('Performance.enable')
  await session.send('HeapProfiler.collectGarbage')
  const metrics = await session.send('Performance.getMetrics')
  const found = metrics.metrics.find(metric => metric.name === 'JSHeapUsedSize')
  await session.detach()
  return found?.value ?? null
}

async function workerHeaps() {
  const { targetInfos } = await browserCdp.send('Target.getTargets')
  const workers = targetInfos.filter(target => target.type === 'worker')
  const heaps = []
  for (const worker of workers) {
    let attached
    try {
      attached = await browserCdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: false })
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
    heaps.push({ usedSize: reply?.usedSize ?? null })
  }
  return heaps
}

async function collectCheckpoint(label) {
  // Let fire-and-forget debounce timers settle so live timers exclude pending
  // work that a later checkpoint would no longer see.
  await new Promise(resolve => setTimeout(resolve, 1_000))
  const context = page.context()
  const [pageHeap, heaps, pageResourceStats, workerResource] = await Promise.all([
    pageHeapBytes(context),
    workerHeaps(),
    pageStats(),
    workerRequest({ action: 'resource-stats' }),
  ])
  assert.equal(workerResource.ok, true, JSON.stringify(workerResource))
  return {
    label,
    workerCount: heaps.length,
    pageHeapBytes: pageHeap,
    workerHeapBytes: heaps.reduce((total, heap) => total + (heap.usedSize ?? 0), 0),
    page: pageResourceStats,
    worker: workerResource.resourceStats,
  }
}

function growth(first, last, read) {
  return read(last) - read(first)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({
    headless: true,
    channel: process.env.DSH_POC_BROWSER ?? 'chrome',
    args: ['--enable-precise-memory-info'],
  })
  browserCdp = await browser.newBrowserCDPSession()
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const path = requestPath(request.url())
    if (!path.startsWith('/api/browser-native/session/')) return
    let body
    try {
      body = JSON.parse(request.postData() ?? 'null')
    } catch {
      body = null
    }
    requests.push({ path, body })
  })
  await page.addInitScript(() => {
    const listeners = { added: 0, removed: 0, live: 0 }
    const listenersByType = new Map()
    const timers = { scheduled: 0, cancelled: 0, fired: 0, live: 0 }
    const liveTimers = new Set()
    const shortTimers = new Set()
    const trackTimer = (handle, _kind, delay) => {
      liveTimers.add(handle)
      if (typeof delay !== 'number' || delay < 60_000) shortTimers.add(handle)
    }
    const releaseTimer = handle => {
      shortTimers.delete(handle)
      return liveTimers.delete(handle)
    }
    const prototype = EventTarget.prototype
    const addListener = prototype.addEventListener
    const removeListener = prototype.removeEventListener
    const registrations = new WeakMap()
    const normalize = options => typeof options === 'boolean'
      ? { capture: options, once: false }
      : { capture: options?.capture === true, once: options?.once === true, signal: options?.signal }
    const keyFor = (type, capture) => `${type}|${capture ? 'capture' : 'bubble'}`
    const lookup = (target, type, listener, capture) =>
      registrations.get(target)?.get(keyFor(type, capture))?.get(listener)
    prototype.addEventListener = function (type, listener, options) {
      // Element listeners are reclaimed with their DOM subtree; only global
      // listeners outlive a Session switch and can leak across the run.
      if (this !== window && this !== document) {
        addListener.call(this, type, listener, options)
        return
      }
      const normalized = normalize(options)
      if (normalized.signal?.aborted) {
        addListener.call(this, type, listener, options)
        return
      }
      const key = keyFor(type, normalized.capture)
      let byType = registrations.get(this)
      if (byType === undefined) {
        byType = new Map()
        registrations.set(this, byType)
      }
      let byListener = byType.get(key)
      if (byListener === undefined) {
        byListener = new Map()
        byType.set(key, byListener)
      }
      if (byListener.has(listener)) {
        addListener.call(this, type, listener, options)
        return
      }
      const removeRegistration = () => {
        if (byListener.delete(listener)) {
          listeners.live -= 1
          listeners.removed += 1
          listenersByType.set(type, (listenersByType.get(type) ?? 1) - 1)
        }
      }
      const invoke = event => typeof listener === 'function'
        ? listener.call(this, event)
        : listener.handleEvent(event)
      const wrapped = normalized.once
        ? event => { removeRegistration(); invoke(event) }
        : event => { invoke(event) }
      byListener.set(listener, { wrapped })
      listeners.added += 1
      listeners.live += 1
      listenersByType.set(type, (listenersByType.get(type) ?? 0) + 1)
      addListener.call(this, type, wrapped, options)
      normalized.signal?.addEventListener('abort', removeRegistration, { once: true })
    }
    prototype.removeEventListener = function (type, listener, options) {
      if (this !== window && this !== document) {
        removeListener.call(this, type, listener, options)
        return
      }
      const capture = typeof options === 'boolean' ? options : options?.capture === true
      const entry = lookup(this, type, listener, capture)
      if (entry === undefined) {
        removeListener.call(this, type, listener, options)
        return
      }
      removeListener.call(this, type, entry.wrapped, options)
      const byListener = registrations.get(this)?.get(keyFor(type, capture))
      if (byListener?.delete(listener)) {
        listeners.live -= 1
        listeners.removed += 1
        listenersByType.set(type, (listenersByType.get(type) ?? 1) - 1)
      }
    }
    const setTimeoutRaw = window.setTimeout.bind(window)
    const setIntervalRaw = window.setInterval.bind(window)
    const clearTimeoutRaw = window.clearTimeout.bind(window)
    const clearIntervalRaw = window.clearInterval.bind(window)
    window.setTimeout = function (handler, timeout, ...args) {
      if (typeof handler !== 'function') return setTimeoutRaw(handler, timeout, ...args)
      let handle
      const wrapped = (...callbackArgs) => {
        releaseTimer(handle)
        timers.fired += 1
        return handler(...callbackArgs)
      }
      handle = setTimeoutRaw(wrapped, timeout, ...args)
      trackTimer(handle, 'timeout', timeout)
      timers.scheduled += 1
      return handle
    }
    window.setInterval = function (handler, timeout, ...args) {
      const handle = setIntervalRaw(handler, timeout, ...args)
      trackTimer(handle, 'interval', timeout)
      timers.scheduled += 1
      return handle
    }
    window.clearTimeout = function (handle) {
      if (releaseTimer(handle)) timers.cancelled += 1
      return clearTimeoutRaw(handle)
    }
    window.clearInterval = function (handle) {
      if (releaseTimer(handle)) timers.cancelled += 1
      return clearIntervalRaw(handle)
    }
    window.__DSH_POC_RESOURCE_STATS__ = () => ({
      listeners: { ...listeners, liveByType: Object.fromEntries(listenersByType) },
      timers: { ...timers, live: liveTimers.size, liveShort: shortTimers.size },
    })
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=resource-lifecycle&preview-fixture=none`)
  await waitForPreview(page)
  await submitPrompt({ page, origin, requests, prompt: OWN_MARKER, timeout: 60_000 })
  ownSessionId = requests.find(request => request.path.endsWith('/session/create'))?.body?.sessionId
  assert.equal(typeof ownSessionId, 'string', 'the preview must create its own Session')

  const seeded = await page.evaluate(async count => {
    const ids = []
    for (let index = 0; index < count; index += 1) {
      const id = `resource-session-${String(index).padStart(2, '0')}`
      const marker = `RESOURCE_SESSION_${String(index).padStart(2, '0')}`
      const poster = async (operation, body) => {
        const response = await fetch(`/api/browser-native/session/${operation}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), ...body }),
        })
        const payload = await response.json()
        if (response.status !== 200) throw new Error(`${operation} failed: ${JSON.stringify(payload)}`)
        return payload
      }
      const created = await poster('create', {
        sessionId: id,
        header: { version: 4, id, createdAt: Date.now(), isSeeded: false, cwd: '/dsh/home/' },
      })
      await poster('append', {
        sessionId: id,
        ownerToken: created.owner.ownerToken,
        ownerEpoch: created.owner.ownerEpoch,
        expectedNextSeq: 0,
        events: [{
          seq: 0,
          type: 'user/message',
          time: Date.now(),
          surfaceOp: 'append',
          data: { id: `${id}-message`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: marker }] },
        }],
      })
      await poster('close', { sessionId: id, ownerToken: created.owner.ownerToken })
      ids.push(id)
    }
    return ids
  }, SEEDED_SESSIONS)
  assert.equal(seeded.length, SEEDED_SESSIONS)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await waitFor(async () => await page.locator('[data-row-key^="session:"]').count() >= 5, 'dashboard rows', 15_000)
  const lastSeededRow = page.locator(`[data-row-key="session:${seededSessionId(SEEDED_SESSIONS - 1)}"]`)
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const showMore = page.getByRole('button', { name: /^Show \d+ more sessions$/ })
    if (await showMore.count() === 0) break
    await showMore.first().click()
    await waitFor(async () => await lastSeededRow.count() > 0, 'dashboard expansion', 10_000)
  }

  const checkpoints = [await collectCheckpoint('baseline')]
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    // The preview's own Session consumes one of the backend's 16 mounted-Session
    // slots, so the other 15 are seeded rows.
    await openSession(ownSessionId, OWN_MARKER)
    await submitPrompt({
      page,
      origin,
      requests,
      sessionId: ownSessionId,
      prompt: `RESOURCE_LONG_RUN_C${String(cycle)}_OWN`,
      timeout: 60_000,
    })
    for (let index = 0; index < SEEDED_SESSIONS; index += 1) {
      await openSeeded(index)
      await submitPrompt({
        page,
        origin,
        requests,
        sessionId: seededSessionId(index),
        prompt: `RESOURCE_LONG_RUN_C${String(cycle)}_S${String(index)}`,
        timeout: 60_000,
      })
    }
    checkpoints.push(await collectCheckpoint(`cycle-${String(cycle + 1)}`))
  }

  const baseline = checkpoints[0]
  const last = checkpoints.at(-1)
  const observed = {
    pageHeapBytes: last.pageHeapBytes - baseline.pageHeapBytes,
    workerHeapBytes: last.workerHeapBytes - baseline.workerHeapBytes,
    pageListeners: growth(baseline, last, checkpoint => checkpoint.page.listeners.live),
    workerListeners: growth(baseline, last, checkpoint => checkpoint.worker.listeners.live),
    pageTimers: growth(baseline, last, checkpoint => checkpoint.page.timers.liveShort),
    pageTimersTotal: growth(baseline, last, checkpoint => checkpoint.page.timers.live),
    workerTimers: growth(baseline, last, checkpoint => checkpoint.worker.timers.live),
    pageListenerTypes: Object.fromEntries(Object.keys({ ...baseline.page.listeners.liveByType, ...last.page.listeners.liveByType })
      .map(type => [type, (last.page.listeners.liveByType[type] ?? 0) - (baseline.page.listeners.liveByType[type] ?? 0)])
      .filter(([, delta]) => delta !== 0)),
    workerListenerTypes: Object.fromEntries(Object.keys({ ...baseline.worker.listeners.liveByType, ...last.worker.listeners.liveByType })
      .map(type => [type, (last.worker.listeners.liveByType[type] ?? 0) - (baseline.worker.listeners.liveByType[type] ?? 0)])
      .filter(([, delta]) => delta !== 0)),
  }
  assert.equal(TURNS >= 100, true)
  assert.equal(checkpoints.slice(1).every(checkpoint => checkpoint.workerCount === baseline.workerCount), true,
    `Worker count changed: ${checkpoints.map(checkpoint => `${checkpoint.label}=${checkpoint.workerCount}`).join(', ')}`)
  assert.equal(baseline.workerCount, 1, 'the preview must run one Dedicated Worker')
  assert.ok(last.pageHeapBytes - baseline.pageHeapBytes <= PAGE_HEAP_BUDGET_BYTES,
    `page heap grew ${String(last.pageHeapBytes - baseline.pageHeapBytes)} bytes over ${String(TURNS)} turns; budget ${String(PAGE_HEAP_BUDGET_BYTES)}`)
  assert.ok(last.workerHeapBytes - baseline.workerHeapBytes <= WORKER_HEAP_BUDGET_BYTES,
    `Worker heap grew ${String(last.workerHeapBytes - baseline.workerHeapBytes)} bytes over ${String(TURNS)} turns; budget ${String(WORKER_HEAP_BUDGET_BYTES)}`)
  assert.ok(growth(baseline, last, checkpoint => checkpoint.page.listeners.live) <= LISTENER_GROWTH_BUDGET,
    `page listeners grew ${String(growth(baseline, last, checkpoint => checkpoint.page.listeners.live))}; budget ${String(LISTENER_GROWTH_BUDGET)}`)
  assert.ok(growth(baseline, last, checkpoint => checkpoint.worker.listeners.live) <= LISTENER_GROWTH_BUDGET,
    `Worker listeners grew ${String(growth(baseline, last, checkpoint => checkpoint.worker.listeners.live))}; budget ${String(LISTENER_GROWTH_BUDGET)}`)
  assert.ok(growth(baseline, last, checkpoint => checkpoint.page.timers.liveShort) <= TIMER_GROWTH_BUDGET,
    `page timers grew ${String(growth(baseline, last, checkpoint => checkpoint.page.timers.liveShort))}; budget ${String(TIMER_GROWTH_BUDGET)}`)
  assert.ok(growth(baseline, last, checkpoint => checkpoint.worker.timers.live) <= TIMER_GROWTH_BUDGET,
    `Worker timers grew ${String(growth(baseline, last, checkpoint => checkpoint.worker.timers.live))}; budget ${String(TIMER_GROWTH_BUDGET)}`)
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'))

  console.log(JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'sixteen-session-100-plus-turn-mount-switch-resource-convergence',
    sessions: SESSIONS,
    cycles: CYCLES,
    turns: TURNS,
    budgets: {
      pageHeapBytes: PAGE_HEAP_BUDGET_BYTES,
      workerHeapBytes: WORKER_HEAP_BUDGET_BYTES,
      listenerGrowth: LISTENER_GROWTH_BUDGET,
      timerGrowth: TIMER_GROWTH_BUDGET,
    },
    checkpoints,
    growth: observed,
    pageErrors,
    note: 'Heaps are JavaScript heap after forced GC, not OS RSS. Page listeners count window/document registrations only; element listeners are reclaimed with their DOM subtree. Page timer growth counts delays under 60 seconds; the long-lived local-midnight timers of mounted message rows scale with transcript size and clear on unmount. Worker listeners count all EventTarget registrations and remain an upper bound for once/AbortSignal registrations. Scripted LLM turns exclude provider latency and this is not a production capacity claim.',
  }, null, 2))
} finally {
  await page?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
