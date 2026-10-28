import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const port = Number(process.env.DSH_POC_PORT ?? '0')
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-receipt-recovery-e2e-')))
const prompt = 'BROWSER_NATIVE_WORKSPACE_CRASH_E2E：请使用 write 工具写入工作区。'

async function readWorkspaceRecord(page, workspaceId) {
  return await page.evaluate(async id => await new Promise((resolveRecord, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1', 1)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('workspace', 'readonly')
      const get = transaction.objectStore('workspace').get(id)
      get.onerror = () => reject(get.error ?? new Error('IndexedDB read failed'))
      get.onsuccess = () => {
        database.close()
        resolveRecord(get.result ?? null)
      }
    }
  }), workspaceId)
}

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')

let image
let app
let browser
let context
let page
let origin
let sessionId
let workspaceId
let receiptEvent
let interruptedFlush = false
let durableFlushReceipt
let agentLlmRequestCountAtCrash
const commits = []
const requests = []
const responses = []
const pageErrors = []
let agentLlmRequestCount = 0

async function restartBackend() {
  const port = new URL(origin).port
  await app.close()
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(Number(port))
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/api/browser-native/health`)).ok
    } catch {
      return false
    }
  }, 'backend health after restart', 10_000)
}

async function readSessionFromBackend(id) {
  const cookie = (await context.cookies(`${origin}/api/browser-native/session/read`))
    .find(item => item.name === 'dsh-browser-native-session-principal')
  if (cookie === undefined) throw new Error('Browser Session principal cookie is missing')
  const response = await fetch(`${origin}/api/browser-native/session/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${cookie.name}=${cookie.value}` },
    body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId: id, offset: 0 }),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(JSON.stringify(value))
  return value
}
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(port)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
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
    if (!request.url().includes('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({
      path: new URL(request.url()).pathname,
      body,
      eventTypes: body?.events?.map(event => event.type),
    })
    const path = new URL(request.url()).pathname
    if (path.endsWith('/workspace/commit')) commits.push(body)
    if (path.endsWith('/llm') && body?.purpose === undefined) agentLlmRequestCount += 1
  })
  page.on('response', response => {
    if (new URL(response.url()).pathname.endsWith('/session/append')) {
      const request = response.request()
      let body
      try { body = request.postDataJSON() } catch { body = undefined }
      responses.push({ status: response.status(), eventTypes: body?.events?.map(event => event.type) })
    }
  })
  await page.route(`${origin}/api/browser-native/session/append`, async route => {
    const body = route.request().postDataJSON()
    receiptEvent = body.events?.find(event => event.type === 'browser-native/workspace-receipt') ?? receiptEvent
    await route.continue()
  })
  await page.route(`${origin}/api/browser-native/session/flush`, async route => {
    const response = await route.fetch()
    const value = await response.json()
    if (!interruptedFlush && receiptEvent !== undefined && value.durableThroughSeq >= receiptEvent.seq) {
      interruptedFlush = true
      durableFlushReceipt = value
      agentLlmRequestCountAtCrash = agentLlmRequestCount
      await page.evaluate(() => {
        const worker = window.__dshBrowserWorkers.at(-1)
        if (worker === undefined) throw new Error('Dedicated Worker was not captured')
        worker.terminate()
      })
      await restartBackend()
      await route.abort().catch(() => {})
      return
    }
    await route.fulfill({ response, body: JSON.stringify(value) })
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(prompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const createRequest = await waitFor(
    () => requests.find(request => request.path.endsWith('/session/create')),
    'DSH Session creation',
  )
  sessionId = createRequest.body.sessionId
  await waitFor(() => interruptedFlush, 'durable Workspace receipt flush response loss', 45_000)
  assert.ok(receiptEvent, 'the real DSH turn must append a Workspace receipt')
  assert.ok(durableFlushReceipt.durableThroughSeq >= receiptEvent.seq,
    'the backend flush must make the receipt durable before its response is lost')

  workspaceId = commits[0]?.workspaceId
  assert.equal(typeof workspaceId, 'string')
  const operationId = receiptEvent.data.operationId
  const beforeCrash = await readWorkspaceRecord(page, workspaceId)
  assert.deepEqual(beforeCrash.receipts?.map(receipt => receipt.operationId), [operationId],
    'the local receipt outbox remains until the durable flush acknowledgement reaches the Worker')
  assert.equal(commits.length, 1, 'the DSH write tool must commit exactly once before the crash')
  assert.equal(commits[0].operationId, operationId)
  const sessionBeforeCrash = await readSessionFromBackend(sessionId)
  assert.equal(sessionBeforeCrash.events.filter(event => event.type === 'browser-native/workspace-receipt').length, 1,
    'the receipt must be present in the durable Session log before Worker termination')
  assert.equal(sessionBeforeCrash.events.some(event => event.type === 'tool/result'), true,
    'the actual DSH tool result must be persisted with the receipt')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)

  await waitFor(async () => {
    const latest = await readSessionFromBackend(sessionId)
    const receipts = latest.events.filter(event => event.type === 'browser-native/workspace-receipt')
    return receipts.length === 1 ? { latest, receipt: receipts[0] } : undefined
  }, 'same-Session receipt recovery after Worker restart', 20_000)
  const recoveredSession = await readSessionFromBackend(sessionId)
  const recoveredReceipts = recoveredSession.events.filter(event => event.type === 'browser-native/workspace-receipt')
  assert.equal(recoveredReceipts.length, 1)
  assert.deepEqual(recoveredReceipts[0].data, receiptEvent.data)
  assert.equal(recoveredReceipts[0].ignorable, true)
  assert.equal(commits.length, 1, 'receipt recovery must not replay the Workspace side effect')
  const afterRecovery = await readWorkspaceRecord(page, workspaceId)
  assert.deepEqual(afterRecovery.receipts ?? [], [], 'the outbox clears only after Session flush succeeds')
  assert.equal(recoveredSession.events.every((event, index) => event.seq === index), true)
  assert.equal(recoveredSession.durableThroughSeq, recoveredSession.nextSeq - 1)
  assert.equal(recoveredSession.events.filter(event => event.type === 'tool/call' && event.data.name === 'write').length, 1)
  assert.equal(recoveredSession.events.filter(event => event.type === 'tool/result').length, 1)
  assert.equal(recoveredSession.events.filter(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(prompt)).length, 1)
  assert.equal(agentLlmRequestCount, agentLlmRequestCountAtCrash,
    'refresh must not automatically replay the interrupted prompt to the model')
  assert.equal(requests.filter(request => request.path.endsWith('/session/append')
    && request.eventTypes?.includes('browser-native/workspace-receipt')).length, 1,
  'refresh must not append the durable receipt again')
  assert.equal(requests.filter(request => request.path.endsWith('/workspace/commit')).length, 1)
  const workspaceOperation = await page.evaluate(async ({ id, operation }) => await (await fetch(
    `/api/browser-native/workspace/operation/${operation}?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), { id: workspaceId, operation: operationId })
  assert.equal(workspaceOperation.found, true)
  assert.equal(workspaceOperation.receipt.revision, 1)
  assert.equal(workspaceOperation.receipt.operationId, operationId)
  const openRequest = requests.find(request => request.path.endsWith('/session/open') && request.body.sessionId === sessionId)
  assert.ok(openRequest, 'the refreshed Browser-Native Worker must reopen the same DSH Session')
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors))
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'Durable-Session-receipt-flush-response-loss-worker-and-backend-restart',
    sessionId,
    workspaceId,
    operationId,
    receiptSeq: receiptEvent.seq,
    receiptCountAfterRecovery: recoveredReceipts.length,
    durableThroughSeq: recoveredSession.durableThroughSeq,
    agentLlmRequestsBeforeAndAfterRecovery: [agentLlmRequestCountAtCrash, agentLlmRequestCount],
    workspaceCommitCount: commits.length,
    outboxAfterRecovery: afterRecovery.receipts ?? [],
    workspaceRevision: workspaceOperation.receipt.revision,
    pageErrors,
  })}\n`)
} catch (error) {
  const session = origin !== undefined && sessionId !== undefined
    ? await readSessionFromBackend(sessionId).catch(() => undefined)
    : undefined
  const localRecord = page !== undefined && !page.isClosed() && workspaceId !== undefined
    ? await readWorkspaceRecord(page, workspaceId).catch(() => undefined)
    : undefined
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    sessionId,
    sessionEvents: session?.events?.map(event => ({ type: event.type, seq: event.seq })),
    localReceiptOutbox: localRecord?.receipts,
    responses,
    requests: requests.map(request => ({ path: request.path, sessionId: request.body?.sessionId, access: request.body?.access, eventTypes: request.eventTypes })),
    bodyText: page !== undefined && !page.isClosed() ? (await page.locator('body').innerText().catch(() => '')).slice(-3000) : undefined,
    pageErrors,
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
