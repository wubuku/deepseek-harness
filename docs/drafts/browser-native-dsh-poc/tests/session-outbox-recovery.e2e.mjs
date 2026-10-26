import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-session-outbox-')))
const beforeAppendMarker = 'BROWSER_NATIVE_OUTBOX_BEFORE_APPEND_E2E'
const afterFlushMarker = 'BROWSER_NATIVE_OUTBOX_AFTER_FLUSH_E2E'
const abortMarker = 'BROWSER_NATIVE_OUTBOX_ABORT_E2E'
const continueMarker = 'BROWSER_NATIVE_OUTBOX_CONTINUE_E2E'

function deferred() {
  let resolvePromise
  const promise = new Promise(resolve => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

async function readOutboxSummary(page, sessionId) {
  return await page.evaluate(id => new Promise((resolveRecord, reject) => {
    const request = indexedDB.open('dsh-browser-native-session-outbox-v1', 2)
    request.onerror = () => reject(request.error ?? new Error('Session outbox IndexedDB open failed'))
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction(['events', 'sessions'], 'readonly')
      const eventRows = transaction.objectStore('events').getAll(
        IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]),
      )
      const session = transaction.objectStore('sessions').get(id)
      let rows
      let metadata
      eventRows.onsuccess = () => { rows = eventRows.result }
      session.onsuccess = () => { metadata = session.result }
      transaction.oncomplete = () => {
        database.close()
        resolveRecord({
          metadata: metadata === undefined ? undefined : {
            ownerEpoch: metadata.ownerEpoch,
            eventCount: metadata.eventCount,
            pendingBytes: metadata.pendingBytes,
          },
          seqs: (rows ?? []).map(row => row.seq),
          eventCount: (rows ?? []).length,
          containsBeforeAppendMarker: (rows ?? []).some(row => JSON.stringify(row.event).includes('BROWSER_NATIVE_OUTBOX_BEFORE_APPEND_E2E')),
          containsAfterFlushMarker: (rows ?? []).some(row => JSON.stringify(row.event).includes('BROWSER_NATIVE_OUTBOX_AFTER_FLUSH_E2E')),
          containsAbortMarker: (rows ?? []).some(row => JSON.stringify(row.event).includes('BROWSER_NATIVE_OUTBOX_ABORT_E2E')),
        })
      }
      transaction.onerror = () => reject(transaction.error ?? new Error('Session outbox IndexedDB read failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Session outbox IndexedDB read aborted'))
    }
  }), sessionId)
}

function countLoggedMarkerEvents(session, marker) {
  return session.events.filter(event => JSON.stringify(event).includes(marker)).length
}

let image
let app
let browser
let context
let page
let releaseAppend
let releaseFlush
const pageErrors = []
const nonLocalRequests = []
const requestSummaries = []
const createdSessions = []
const llmMarkerCounts = new Map([[beforeAppendMarker, 0], [afterFlushMarker, 0], [abortMarker, 0], [continueMarker, 0]])
const markerAppendRequests = new Map([[beforeAppendMarker, 0], [afterFlushMarker, 0], [abortMarker, 0], [continueMarker, 0]])
let beforeAppendIntercepted
let afterFlushIntercepted
let flushResponse
let flushResponseBody
let flushHoldEnabled = false
let flushHoldUsed = false

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => {
    const workers = []
    Object.defineProperty(window, '__dshBrowserWorkers', { value: workers })
    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args, target)
        workers.push(worker)
        return worker
      },
    })
  })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requestSummaries.push({
      path: url.pathname,
      sessionId: body?.sessionId,
      ownerEpoch: body?.ownerEpoch,
      eventTypes: Array.isArray(body?.events) ? body.events.map(event => event.type) : undefined,
      eventSeqs: Array.isArray(body?.events) ? body.events.map(event => event.seq) : undefined,
      hasBeforeAppendMarker: JSON.stringify(body?.events ?? body?.messages ?? []).includes(beforeAppendMarker),
    })
    if (url.pathname.endsWith('/session/create')) createdSessions.push(body?.sessionId)
    if (url.pathname.endsWith('/session/append')) {
      const serialized = JSON.stringify(body?.events ?? [])
      for (const marker of markerAppendRequests.keys()) {
        if (serialized.includes(marker)) markerAppendRequests.set(marker, markerAppendRequests.get(marker) + 1)
      }
    }
    if (url.pathname.endsWith('/llm')) {
      const serialized = JSON.stringify(body?.messages ?? [])
      for (const marker of llmMarkerCounts.keys()) {
        if (serialized.includes(marker)) llmMarkerCounts.set(marker, llmMarkerCounts.get(marker) + 1)
      }
    }
  })

  const appendGate = deferred()
  releaseAppend = appendGate.resolve
  const appendObserved = deferred()
  const flushGate = deferred()
  releaseFlush = flushGate.resolve
  const flushObserved = deferred()
  await page.route(`${origin}/api/browser-native/session/append`, async route => {
    const body = route.request().postDataJSON()
    if (beforeAppendIntercepted === undefined && JSON.stringify(body.events ?? []).includes(beforeAppendMarker)) {
      beforeAppendIntercepted = { sessionId: body.sessionId, seqs: body.events.map(event => event.seq) }
      appendObserved.resolve()
      await appendGate.promise
      await route.abort('failed')
      return
    }
    await route.continue()
  })
  await page.route(`${origin}/api/browser-native/session/flush`, async route => {
    const body = route.request().postDataJSON()
    if (flushHoldEnabled && !flushHoldUsed) {
      flushHoldUsed = true
      const result = await route.fetch()
      flushResponse = await result.json()
      flushResponseBody = JSON.stringify(flushResponse)
      afterFlushIntercepted = { sessionId: body.sessionId }
      flushObserved.resolve()
      await flushGate.promise
      await route.fulfill({ response: result, body: flushResponseBody })
      return
    }
    await route.continue()
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  const probe = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'session-outbox-probe' }))
  assert.equal(probe?.ok, true, JSON.stringify(probe))
  assert.equal(probe?.staleWriterRejected, true)
  assert.equal(probe?.conflictRejected, true)
  assert.deepEqual(probe?.remainingSeq, [1])

  const firstPrompt = `请简短回答：${beforeAppendMarker}`
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(firstPrompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  await waitFor(() => beforeAppendIntercepted, 'Session append paused after local journal', 45_000)
  const sessionId = beforeAppendIntercepted.sessionId
  assert.equal(typeof sessionId, 'string')
  const beforeAppendLocal = await readOutboxSummary(page, sessionId)
  assert.equal(beforeAppendLocal.containsBeforeAppendMarker, true, JSON.stringify(beforeAppendLocal))
  assert.ok(beforeAppendLocal.eventCount > 0)
  await page.evaluate(() => {
    const worker = window.__dshBrowserWorkers.at(-1)
    if (worker === undefined) throw new Error('Dedicated Worker was not captured')
    worker.terminate()
  })
  appendGate.resolve()
  await appendObserved.promise
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)

  let afterAppendRecovery
  try {
    afterAppendRecovery = await waitFor(async () => {
      const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
      const local = await readOutboxSummary(page, sessionId)
      return countLoggedMarkerEvents(session, beforeAppendMarker) === 1
        && session.durableThroughSeq === session.nextSeq - 1 && local.eventCount === 0
        ? { session, local } : undefined
    }, 'pre-append Worker recovery and durable outbox cleanup', 60_000)
  } catch (error) {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const local = await readOutboxSummary(page, sessionId)
    process.stderr.write(`${JSON.stringify({
      recoveryDiagnostic: error instanceof Error ? error.message : String(error),
      remote: {
        status: session.status,
        nextSeq: session.nextSeq,
        durableThroughSeq: session.durableThroughSeq,
        eventTypes: (session.events ?? []).map(event => event.type),
        originalMarkerEventCount: countLoggedMarkerEvents(session, beforeAppendMarker),
      },
      localOutbox: local,
      llmMarkerCounts: Object.fromEntries(llmMarkerCounts),
      requestSummaries,
      pageErrors,
    })}\n`)
    throw error
  }
  assert.equal(llmMarkerCounts.get(beforeAppendMarker), 0, 'recovery must not replay the original user prompt')
  assert.equal(afterAppendRecovery.session.events.every((event, index) => event.seq === index), true)

  const continued = await sendTurn({
    page,
    origin,
    requests: createdSessions.map(sessionId => ({ path: '/api/browser-native/session/create', body: { sessionId } })),
    sessionId,
    prompt: `故障恢复后显式开始新一轮：${continueMarker}`,
    timeout: 60_000,
  })
  assert.ok(continued.session.events.some(event => event.type === 'assistant/message' && event.data.turn === continued.turn))
  assert.equal(countLoggedMarkerEvents(continued.session, beforeAppendMarker), 1)

  flushHoldEnabled = true
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(`请简短回答：${afterFlushMarker}`)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  await waitFor(() => afterFlushIntercepted, 'backend durable flush response interception', 45_000)
  assert.equal(afterFlushIntercepted.sessionId, sessionId)
  const beforeFlushResponseLocal = await readOutboxSummary(page, sessionId)
  assert.equal(beforeFlushResponseLocal.containsAfterFlushMarker, true, JSON.stringify(beforeFlushResponseLocal))
  assert.ok(flushResponse.durableThroughSeq >= Math.max(...beforeFlushResponseLocal.seqs))
  const appendCountBeforeFlushRecovery = markerAppendRequests.get(afterFlushMarker)
  assert.equal(appendCountBeforeFlushRecovery, 1)
  await page.evaluate(() => {
    const worker = window.__dshBrowserWorkers.at(-1)
    if (worker === undefined) throw new Error('Dedicated Worker was not captured')
    worker.terminate()
  })
  flushGate.resolve()
  await flushObserved.promise
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)

  const afterFlushRecovery = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const local = await readOutboxSummary(page, sessionId)
    return countLoggedMarkerEvents(session, afterFlushMarker) === 1
      && session.durableThroughSeq === session.nextSeq - 1 && local.eventCount === 0
      ? { session, local } : undefined
  }, 'post-flush Worker recovery without duplicate append', 60_000)
  assert.equal(markerAppendRequests.get(afterFlushMarker), appendCountBeforeFlushRecovery,
    'a backend-durable event must not be appended again after response loss')
  assert.equal(llmMarkerCounts.get(afterFlushMarker), 0, 'the interrupted request must not be replayed')
  assert.equal(afterFlushRecovery.session.events.every((event, index) => event.seq === index), true)

  const abortRequest = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'abort-session-outbox-appends',
    count: 100,
  }))
  assert.equal(abortRequest?.ok, true, JSON.stringify(abortRequest))
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(`不得越过失败的本地 journal：${abortMarker}`)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  await page.waitForTimeout(4_000)
  const afterAbort = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
  assert.equal(countLoggedMarkerEvents(afterAbort, abortMarker), 0, 'failed local journal must not publish the prompt event remotely')
  assert.equal(llmMarkerCounts.get(abortMarker), 0, 'failed local journal must block model dispatch')
  const afterAbortLocal = await readOutboxSummary(page, sessionId)
  assert.equal(afterAbortLocal.containsAbortMarker, false)

  await page.evaluate(() => {
    const worker = window.__dshBrowserWorkers.at(-1)
    if (worker === undefined) throw new Error('Dedicated Worker was not captured')
    worker.terminate()
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  const finalTurn = await sendTurn({
    page,
    origin,
    requests: createdSessions.map(createdSessionId => ({ path: '/api/browser-native/session/create', body: { sessionId: createdSessionId } })),
    sessionId,
    prompt: `本地存储恢复后显式继续：${continueMarker}-after-abort`,
    timeout: 60_000,
  })
  assert.ok(finalTurn.session.events.some(event => event.type === 'assistant/message' && event.data.turn === finalTurn.turn))
  assert.equal(countLoggedMarkerEvents(finalTurn.session, abortMarker), 0)
  assert.equal(finalTurn.session.durableThroughSeq, finalTurn.session.nextSeq - 1)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'real-DSH-session-outbox-worker-termination-pre-append-post-durable-flush-owner-fencing-idb-abort',
    sessionId,
    outboxEpochProbe: {
      staleWriterRejected: probe.staleWriterRejected,
      conflictingSeqRejected: probe.conflictRejected,
      emptyFenceEvicted: probe.emptyFenceEvicted,
      pendingSessionCapacityRejected: probe.pendingSessionCapacityRejected,
      totalPendingByteCapacityRejected: probe.totalPendingByteCapacityRejected,
      versionOneMigrationPreservedPendingEvents: probe.versionOneMigrationPreservedPendingEvents,
    },
    preAppendRecovery: {
      originalMarkerEventCount: countLoggedMarkerEvents(afterAppendRecovery.session, beforeAppendMarker),
      llmRequestsForOriginalPrompt: llmMarkerCounts.get(beforeAppendMarker),
      recoveredEventCount: afterAppendRecovery.session.nextSeq,
    },
    postFlushRecovery: {
      markerEventCount: countLoggedMarkerEvents(afterFlushRecovery.session, afterFlushMarker),
      appendRequestsBeforeAndAfterRecovery: markerAppendRequests.get(afterFlushMarker),
      llmRequestsForInterruptedPrompt: llmMarkerCounts.get(afterFlushMarker),
      durableThroughSeq: afterFlushRecovery.session.durableThroughSeq,
    },
    idbAbort: {
      remoteMarkerEventCount: countLoggedMarkerEvents(afterAbort, abortMarker),
      llmRequests: llmMarkerCounts.get(abortMarker),
    },
    explicitContinuationTurn: finalTurn.turn,
    pageErrors,
    nonLocalRequests,
  })}\n`)
} finally {
  releaseAppend?.()
  releaseFlush?.()
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
