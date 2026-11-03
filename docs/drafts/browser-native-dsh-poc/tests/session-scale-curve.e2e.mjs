/**
 * Measure how Session length changes hydrate cost, event volume, browser storage and compaction.
 *
 * One Session grows to the configured checkpoints while every turn issues a tool event; a second
 * Session grows under a declared context window so the automatic compactor reports its pressure
 * turn. Numbers come from the real Chrome preview, the same-origin backend and the Worker Session.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, rememberSessionPrincipal, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright

const MARKER = 'BROWSER_NATIVE_SESSION_SCALE_TURN_E2E'
const checkpoints = String(process.env.DSH_POC_SCALE_TURNS ?? '100,300')
  .split(',').map(value => Number(value.trim()))
const compactionWindows = String(process.env.DSH_POC_SCALE_COMPACTION_WINDOWS ?? '4096,8192')
  .split(',').map(value => Number(value.trim()))
const compactionTurns = Number(process.env.DSH_POC_SCALE_COMPACTION_TURNS ?? 16)
const hydrateBudgetMs = Number(process.env.DSH_POC_SCALE_HYDRATE_BUDGET_MS ?? 30_000)
const heapBudgetBytes = Number(process.env.DSH_POC_SCALE_HEAP_BUDGET_MB ?? 512) * 1024 * 1024
const previewUrl = origin => `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`

for (const value of [...checkpoints, ...compactionWindows]) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`scale values must be positive integers, got ${String(value)}`)
}
for (let index = 1; index < checkpoints.length; index += 1) {
  if (checkpoints[index] <= checkpoints[index - 1]) throw new Error('DSH_POC_SCALE_TURNS must be strictly increasing')
}
if (!Number.isSafeInteger(compactionTurns) || compactionTurns < 4) throw new Error('DSH_POC_SCALE_COMPACTION_TURNS must be at least 4')

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

function createRecorder(page, origin) {
  const requests = []
  const external = []
  const pageErrors = []
  const logs = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => logs.push(`${message.type()}: ${message.text()}`))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) {
      external.push(request.url())
      return
    }
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    requests.push({ request, path: url.pathname, body, requestBytes: Buffer.byteLength(request.postData() ?? ''), at: Date.now() })
  })
  page.on('response', response => {
    const record = requests.find(candidate => candidate.request === response.request())
    if (record === undefined) return
    void response.body().then(body => { record.responseBytes = body.byteLength }).catch(() => {})
  })
  return { requests, external, pageErrors, logs }
}

function createOwnerCapture(page) {
  const state = { ownerToken: undefined }
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname
    if (!pathname.endsWith('/session/create') && !pathname.endsWith('/session/open')) return
    void response.json().then(payload => {
      if (typeof payload.owner?.ownerToken === 'string') state.ownerToken = payload.owner.ownerToken
    }).catch(() => {})
  })
  return state
}

async function readAllSession(origin, sessionId) {
  const events = []
  let offset = 0
  let durableThroughSeq = -1
  while (offset < 1_000_000) {
    const page = await sessionRequest(origin, 'read', { sessionId, offset, length: 2_048 })
    assert.equal(page.status, 200, JSON.stringify(page))
    events.push(...page.events)
    durableThroughSeq = Math.max(durableThroughSeq, page.durableThroughSeq)
    if (page.hasMore !== true) break
    offset = events.length
  }
  return { events, durableThroughSeq }
}

async function readOutboxSummary(page, sessionId) {
  return await page.evaluate(id => new Promise((resolveRecord, reject) => {
    const request = indexedDB.open('dsh-browser-native-session-outbox-v1', 2)
    request.onerror = () => reject(request.error ?? new Error('Session outbox IndexedDB open failed'))
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction(['events', 'sessions'], 'readonly')
      const eventRows = transaction.objectStore('events').getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))
      const session = transaction.objectStore('sessions').get(id)
      let rows
      let metadata
      eventRows.onsuccess = () => { rows = eventRows.result }
      session.onsuccess = () => { metadata = session.result }
      transaction.oncomplete = () => {
        database.close()
        resolveRecord({
          metadata: metadata === undefined ? undefined : { eventCount: metadata.eventCount, pendingBytes: metadata.pendingBytes },
          eventCount: (rows ?? []).length,
          storedBytes: (rows ?? []).reduce((total, row) => total + JSON.stringify(row.event).length, 0),
        })
      }
      transaction.onerror = () => reject(transaction.error ?? new Error('Session outbox IndexedDB read failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Session outbox IndexedDB read aborted'))
    }
  }), sessionId)
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

async function workspaceBytes(page) {
  const listing = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'list', path: '/dsh/home/workspace/',
  }))
  if (listing?.ok !== true) return { entries: 0, bytes: 0 }
  const files = listing.entries.filter(name => name.startsWith('scale-turn-'))
  let bytes = 0
  for (const file of files) {
    const stats = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
      action: 'stat', path,
    }), `/dsh/home/workspace/${file}`)
    bytes += stats?.bytes ?? 0
  }
  return { entries: files.length, bytes }
}

async function waitForAssistantMarker(page, marker, timeout = 60_000) {
  await page.waitForFunction(value => [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')]
    .some(node => node.textContent?.includes(value)), marker, { timeout })
}

/**
 * Submit one composer turn and wait for its terminal event from a bounded Session tail read.
 * @param {object} options - Page, backend, recorder, mutable scale state and prompt.
 * @returns {Promise<{turn: number, elapsedMs: number}>} Settled turn result.
 */
async function submitScaleTurn({ page, origin, recorder, state, prompt, turnIndex, marker, timeout = 180_000 }) {
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(prompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  if (state.sessionId === undefined) {
    state.sessionId = await waitFor(() => recorder.requests.find(request => request.path.endsWith('/session/create'))?.body.sessionId,
      'Session creation', 30_000)
    await rememberSessionPrincipal(page, origin, state.sessionId)
  }
  const startedAt = Date.now()
  const terminal = await waitFor(async () => {
    const slice = await sessionRequest(origin, 'read', { sessionId: state.sessionId, offset: state.offset, length: 400 })
    assert.equal(slice.status, 200, JSON.stringify(slice))
    const index = (slice.events ?? []).findIndex(event => event.type === 'turn/end')
    if (index < 0) return undefined
    const end = slice.events[index]
    state.offset = Math.max(...slice.events.map(event => event.seq), end.seq) + 1
    return end
  }, `turn ${String(turnIndex)} terminal event`, timeout)
  assert.equal(terminal.data.reason.kind, 'completed', `turn ${String(turnIndex)} ended as ${JSON.stringify(terminal.data.reason)}`)
  if (marker === undefined) await waitForAssistantMarker(page, `${MARKER}_${String(turnIndex)}_DONE`, 30_000)
  else if (marker !== null) await waitForAssistantMarker(page, marker, 30_000)
  return { turn: terminal.data.turn, elapsedMs: Date.now() - startedAt }
}

async function measureCheckpoint({ page, context, browserCdp, origin, recorder, sessionId, dataDir, ownerToken, turnIndex }) {
  const flush = await sessionRequest(origin, 'flush', { sessionId, ownerToken })
  assert.equal(flush.status, 200, JSON.stringify(flush))
  const session = await readAllSession(origin, sessionId)
  const eventTypes = {}
  for (const event of session.events) eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1
  const durableBytes = (await stat(join(dataDir, 'sessions', `${sessionId}.json`))).size
  const storage = await page.evaluate(async () => await navigator.storage.estimate())
  const outbox = await readOutboxSummary(page, sessionId)
  const workspace = await workspaceBytes(page)
  const pageHeap = await pageHeapBytes(context, page)
  const workers = await workerHeaps(browserCdp)
  const llmCount = recorder.requests.filter(request => request.path.endsWith('/llm')).length
  const reloadStartedAt = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const syncedMs = Date.now() - reloadStartedAt
  await waitForAssistantMarker(page, `${MARKER}_${String(turnIndex)}_DONE`, 60_000)
  const projectedMs = Date.now() - reloadStartedAt
  await waitFor(async () => recorder.requests.filter(request => request.at >= reloadStartedAt
    && request.path.endsWith('/session/read')).every(request => request.responseBytes !== undefined),
  'hydrate read response bytes', 60_000)
  const reads = recorder.requests.filter(request => request.at >= reloadStartedAt && request.path.endsWith('/session/read'))
  return {
    turn: turnIndex,
    eventCount: session.events.length,
    eventTypes,
    durableBytes,
    durableThroughSeq: session.durableThroughSeq,
    storage,
    outbox,
    workspace,
    pageHeapBytes: pageHeap,
    workerHeapBytes: workers.reduce((total, worker) => total + (worker.usedSize ?? 0), 0),
    workerCount: workers.length,
    hydrate: {
      syncedMs,
      projectedMs,
      readCount: reads.length,
      readRequestBytes: reads.reduce((total, request) => total + request.requestBytes, 0),
      readResponseBytes: reads.reduce((total, request) => total + (request.responseBytes ?? 0), 0),
      llmCountBefore: llmCount,
      llmCountAfter: recorder.requests.filter(request => request.path.endsWith('/llm')).length,
    },
  }
}

async function runScaleScenario({ image, browser, browserCdp }) {
  const dataDir = await mkdtemp(`${tmpdir()}/dsh-browser-scale-`)
  const state = { sessionId: undefined, offset: 0 }
  let app
  let context
  let page
  try {
    app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
    const origin = await app.listen(0)
    context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
    page = await context.newPage()
    const recorder = createRecorder(page, origin)
    const owner = createOwnerCapture(page)
    await openPreview(page, previewUrl(origin))
    await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
    const checkpointsOut = []
    const turnDurations = []
    const lastTurn = checkpoints.at(-1)
    let previous = 0
    for (const checkpoint of checkpoints) {
      for (let index = previous + 1; index <= checkpoint; index += 1) {
        const turn = await submitScaleTurn({
          page, origin, recorder, state,
          prompt: `${MARKER} scale-turn-${String(index)}: keep the Session history and the tool trace.`,
          turnIndex: index,
        })
        turnDurations.push(turn.elapsedMs)
      }
      previous = checkpoint
      const ownerToken = await waitFor(() => owner.ownerToken, 'Session write owner receipt', 30_000)
      checkpointsOut.push(await measureCheckpoint({
        page, context, browserCdp, origin, recorder, sessionId: state.sessionId,
        dataDir, ownerToken, turnIndex: checkpoint,
      }))
    }
    const followup = await submitScaleTurn({
      page, origin, recorder, state,
      prompt: `${MARKER} scale-turn-${String(lastTurn + 1)}: continue after the final hydrate.`,
      turnIndex: lastTurn + 1,
    })
    assert.equal(followup.turn, lastTurn + 1)
    const session = await readAllSession(origin, state.sessionId)
    assert.equal(session.events.filter(event => event.type === 'user/message'
      && eventText(event).includes('scale-turn-')).length, lastTurn + 1)
    assert.ok(session.events.filter(event => event.type === 'tool/call').length >= lastTurn)
    assert.equal(session.events.some(event => event.type === 'compaction/start'), false,
      'without a declared context window the Session must not compact')
    const durableBytesAfterFollowup = (await stat(join(dataDir, 'sessions', `${state.sessionId}.json`))).size
    assert.deepEqual(recorder.external, [])
    assert.deepEqual(recorder.pageErrors, [])
    const first = checkpointsOut[0]
    const final = checkpointsOut.at(-1)
    assert.ok(final.eventCount > first.eventCount)
    assert.ok(final.durableBytes > first.durableBytes)
    for (const measured of checkpointsOut) {
      assert.equal(measured.outbox.metadata?.pendingBytes ?? 0, 0, 'flushed Session must leave no pending outbox bytes')
      assert.equal(measured.outbox.eventCount, 0, 'flush must clear local outbox rows')
      assert.ok(measured.hydrate.syncedMs < hydrateBudgetMs,
        `hydrate at turn ${String(measured.turn)} took ${String(measured.hydrate.syncedMs)}ms, budget ${String(hydrateBudgetMs)}ms`)
      assert.equal(measured.hydrate.llmCountAfter, measured.hydrate.llmCountBefore,
        'hydrate must not replay a model request')
      assert.ok(measured.durableThroughSeq >= measured.eventCount - 1)
      assert.ok(measured.pageHeapBytes < heapBudgetBytes)
    }
    return {
      scope: 'session-length-scale-curve',
      sessionId: state.sessionId,
      checkpoints: checkpointsOut,
      turnLatencyMedianMs: median(turnDurations),
      turnLatencyMaxMs: Math.max(...turnDurations),
      followupTurn: followup.turn,
      durableBytesAfterFollowup,
      externalRequests: recorder.external.length,
      warnings: recorder.logs.filter(line => line.startsWith('warning:') || line.startsWith('error:')),
      pageErrors: recorder.pageErrors,
    }
  } finally {
    await page?.close().catch(() => {})
    await context?.close().catch(() => {})
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}

async function runCompactionScenario({ image, browser, contextWindow }) {
  const dataDir = await mkdtemp(`${tmpdir()}/dsh-browser-scale-compaction-`)
  const state = { sessionId: undefined, offset: 0 }
  let app
  let context
  let page
  try {
    app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted', contextWindow })
    const origin = await app.listen(0)
    context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
    page = await context.newPage()
    const recorder = createRecorder(page, origin)
    await openPreview(page, previewUrl(origin))
    await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
    const filler = 'Retain this exact Browser-native scale fact. '.repeat(60)
    for (let index = 1; index <= compactionTurns; index += 1) {
      await submitScaleTurn({
        page, origin, recorder, state,
        prompt: `${MARKER} scale-turn-${String(index)}: ${filler}`,
        turnIndex: index,
        marker: null,
      })
    }
    const session = await readAllSession(origin, state.sessionId)
    const starts = session.events.filter(event => event.type === 'compaction/start')
    const summaries = session.events.filter(event => event.type === 'compaction/summary')
    const ends = session.events.filter(event => event.type === 'compaction/end')
    assert.ok(starts.length > 0, `declared context window ${String(contextWindow)} must trigger pressure compaction`)
    const turnsBefore = session.events.filter(event => event.type === 'user/message' && event.seq <= starts[0].seq
      && eventText(event).includes('scale-turn-')).length
    assert.equal(session.events.filter(event => event.type === 'tool/call').length, compactionTurns,
      'compaction must not repeat a tool side effect')
    assert.deepEqual(recorder.external, [])
    assert.deepEqual(recorder.pageErrors, [])
    assert.deepEqual(recorder.logs.filter(line => line.includes('headroom tokens')), [],
      'the validation profile must give the declared window a positive compaction pressure budget')
    return {
      contextWindow,
      turns: compactionTurns,
      eventCount: session.events.length,
      firstCompactionTurn: turnsBefore,
      compactionStarts: starts.length,
      compactionSummaries: summaries.length,
      compactionEnds: ends.length,
      toolCalls: session.events.filter(event => event.type === 'tool/call').length,
      pageErrors: recorder.pageErrors,
    }
  } finally {
    await page?.close().catch(() => {})
    await context?.close().catch(() => {})
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}

let image
let browser
let browserCdp
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  browser = await chromium.launch({
    headless: true,
    channel: process.env.DSH_POC_BROWSER ?? 'chrome',
    args: ['--enable-precise-memory-info'],
  })
  browserCdp = await browser.newBrowserCDPSession()
  const scale = await runScaleScenario({ image, browser, browserCdp })
  const compaction = []
  for (const contextWindow of compactionWindows) {
    compaction.push(await runCompactionScenario({ image, browser, contextWindow }))
  }
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'session-scale-hydrate-storage-compaction',
    budgets: { hydrateMs: hydrateBudgetMs, perTabHeapBytes: heapBudgetBytes },
    scale,
    compaction,
  })}\n`)
} finally {
  await browser?.close()
  await image?.cleanup()
}
