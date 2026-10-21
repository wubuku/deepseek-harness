import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest, submitPrompt, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium, webkit } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chromium'
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-lifecycle-e2e-')))
const port = Number(process.env.DSH_POC_PORT ?? '0')
let listenPort = port
const failureMarker = 'INJECT_ONE_BROWSER_NATIVE_LLM_FAILURE'
const recoveredMarker = 'BROWSER_NATIVE_FAILURE_RECOVERY_OK'
let failNextMatchingRequest = true
let image
let app
let browser
let context
let page
let origin
const requests = []
const pageErrors = []
const httpErrors = []
let lifecyclePhase = 'setup'

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')

async function startBackend() {
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    ownerLeaseMs: 5_000,
    testHooks: {
      failLlmRequest: body => {
        if (failNextMatchingRequest && JSON.stringify(body.messages).includes(failureMarker)) {
          failNextMatchingRequest = false
          return true
        }
        return false
      },
    },
  })
  origin = await app.listen(listenPort)
  listenPort = Number(new URL(origin).port)
}

function capturePage(pageToCapture) {
  pageToCapture.on('request', request => {
    if (request.url().includes('/api/browser-native/')) {
      const raw = request.postData()
      let body
      if (raw !== null) {
        try { body = JSON.parse(raw) } catch {}
      }
      requests.push({ path: new URL(request.url()).pathname, body })
    }
  })
  pageToCapture.on('pageerror', error => pageErrors.push({ message: error.message, phase: lifecyclePhase }))
  pageToCapture.on('response', response => {
    if (response.status() >= 400) httpErrors.push({ path: new URL(response.url()).pathname, status: response.status() })
  })
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  await startBackend()
  const browserType = browserName === 'webkit' ? webkit : chromium
  browser = await browserType.launch({ headless: true, ...(browserName === 'chrome' ? { channel: 'chrome' } : {}) })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => {
    const workerInstances = []
    Object.defineProperty(window, '__dshBrowserWorkers', { value: workerInstances })
    Object.defineProperty(window, '__dshFixtureResponseReceived', { value: false, writable: true })
    const nativeFetch = window.fetch.bind(window)
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args)
      const requestUrl = args[0] instanceof Request ? args[0].url : String(args[0])
      if (new URL(requestUrl, location.href).pathname.endsWith('/fixtures.json')) {
        window.__dshFixtureResponseReceived = true
      }
      return response
    }
    const lifecycleKey = 'dsh-browser-native-lifecycle-trace'
    const record = entry => {
      if (location.origin === 'null') return
      const trace = JSON.parse(sessionStorage.getItem(lifecycleKey) ?? '[]')
      trace.push({ ...entry, at: Date.now() })
      sessionStorage.setItem(lifecycleKey, JSON.stringify(trace))
    }
    window.addEventListener('pagehide', event => record({ event: 'pagehide', persisted: event.persisted }), true)
    const nativeWorker = window.Worker
    window.Worker = new Proxy(nativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args, target)
        const entry = { url: String(args[0]), worker, terminateCalls: 0 }
        const terminate = worker.terminate.bind(worker)
        worker.terminate = () => {
          entry.terminateCalls += 1
          record({ event: 'worker-terminate', url: entry.url })
          terminate()
        }
        workerInstances.push(entry)
        return worker
      },
    })
  })
  const chooserUrl = `${origin}/preview.html?browser-native=1&preview-fixture=vfs-example`
  const url = `${origin}/preview.html?browser-native=1&preview-fixture=none`
  const pendingPage = await context.newPage()
  let releaseManifest
  let manifestRequestedResolve
  const manifestRequested = new Promise(resolve => { manifestRequestedResolve = resolve })
  const holdManifest = new Promise(resolve => { releaseManifest = resolve })
  await pendingPage.route('**/preview/fixtures.json', async route => {
    manifestRequestedResolve()
    await holdManifest
    await route.continue()
  })
  await pendingPage.goto(chooserUrl, { waitUntil: 'domcontentloaded' })
  await manifestRequested
  await pendingPage.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })))
  releaseManifest()
  await pendingPage.waitForFunction(() => window.__dshFixtureResponseReceived, { timeout: 15_000 })
  assert.equal(await pendingPage.evaluate(() => window.__dshBrowserWorkers.length), 0,
    'source selection resolving after unload must not create a Worker')
  await pendingPage.close()

  page = await context.newPage()
  capturePage(page)
  lifecyclePhase = 'initial boot'
  await openPreview(page, url)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
  assert.equal(await page.evaluate(() => window.__dshBrowserWorkers.at(-1)?.terminateCalls), 0,
    'a BFCache pagehide must preserve the active Worker')
  const initial = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'Please reply with BROWSER_NATIVE_REFRESH_FIRST_OK',
    marker: 'BROWSER_NATIVE_REFRESH_FIRST_OK',
  })
  const sessionId = initial.sessionId
  lifecyclePhase = 'page refresh'
  await page.reload({ waitUntil: 'domcontentloaded' })
  const unloadTrace = await page.evaluate(() => JSON.parse(sessionStorage.getItem('dsh-browser-native-lifecycle-trace') ?? '[]'))
  assert.equal(unloadTrace.filter(event => event.event === 'pagehide' && event.persisted === false).length, 1,
    'the actual refresh must deliver one non-persisted pagehide')
  assert.equal(unloadTrace.filter(event => event.event === 'worker-terminate').length, 1,
    'the Worker must terminate on refresh after a persisted pagehide')
  lifecyclePhase = 'refresh reconnect'
  await waitForPreview(page)
  const afterRefresh = await sendTurn({
    page,
    origin,
    requests,
    sessionId,
    prompt: 'Please reply with BROWSER_NATIVE_REFRESH_CONTINUED_OK',
    marker: 'BROWSER_NATIVE_REFRESH_CONTINUED_OK',
  })
  const stopPrompt = `Keep streaming this response until the UI stop button cancels the turn: ${'continue writing '.repeat(16)}`
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(stopPrompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const stopButton = page.getByRole('button', { name: /^(Stop generating|停止生成)$/ })
  await stopButton.waitFor({ state: 'visible', timeout: 10_000 })
  await stopButton.click()
  const afterStop = await waitFor(async () => {
    const current = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    return current.events?.filter(event => event.type === 'turn/end').length === 3 ? current : undefined
  }, 'user stop turn settlement', 20_000)
  const stoppedTurn = afterStop.events.filter(event => event.type === 'turn/end').at(-1)
  assert.equal(stoppedTurn.data.reason.kind, 'aborted')
  const competingPage = await context.newPage()
  await competingPage.goto(`${origin}/api/browser-native/health`, { waitUntil: 'domcontentloaded' })
  const competingWrite = await competingPage.evaluate(async currentSessionId => {
    const response = await fetch('/api/browser-native/session/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId: currentSessionId, access: 'write' }),
    })
    return { status: response.status, body: await response.json() }
  }, sessionId)
  await competingPage.close()
  assert.equal(competingWrite.status, 409)
  assert.equal(competingWrite.body.error?.code, 'SESSION_ALREADY_OWNED')

  lifecyclePhase = 'injected LLM error and recovery'
  const failed = await submitPrompt({
    page,
    origin,
    requests,
    sessionId,
    prompt: `This turn intentionally triggers the test-only backend error: ${failureMarker}`,
    expectedReason: 'error',
  })
  const failedTurn = failed.session.events.filter(event => event.type === 'turn/end').at(-1)
  assert.equal(failedTurn?.data.reason.kind, 'error')
  assert.equal(failNextMatchingRequest, false, 'the injected failure did not reach the LLM request')
  const recovered = await sendTurn({
    page,
    origin,
    requests,
    sessionId,
    prompt: `Please reply with ${recoveredMarker}`,
    marker: recoveredMarker,
  })
  const recoveredTurn = recovered.session.events.findLast(event => event.type === 'turn/end' && event.data.turn === recovered.turn)
  assert.equal(recoveredTurn?.data.reason.kind, 'completed')
  await waitFor(async () => {
    const persisted = JSON.parse(await readFile(join(dataDir, 'sessions', `${sessionId}.json`), 'utf8'))
    return persisted.durableThroughSeq >= recovered.session.events.length - 1
      && assistantText({ events: persisted.events }).includes(recoveredMarker)
      ? persisted
      : undefined
  }, 'recovered turn durability', 20_000)

  lifecyclePhase = 'backend shutdown'
  await page.close()
  await app.close()
  await startBackend()
  const restartedUrl = `${origin}/preview.html?browser-native=1&preview-fixture=none`
  page = await context.newPage()
  capturePage(page)
  lifecyclePhase = 'backend restart boot'
  await openPreview(page, restartedUrl)
  await page.getByText(recoveredMarker, { exact: false }).last().waitFor({ timeout: 20_000 })
  const afterBackendRestart = await sendTurn({
    page,
    origin,
    requests,
    sessionId,
    prompt: 'Please reply with BROWSER_NATIVE_BACKEND_RESTART_OK',
    marker: 'BROWSER_NATIVE_BACKEND_RESTART_OK',
  })
  const pageErrorsBeforeWorkerTerminate = [...pageErrors]
  lifecyclePhase = 'forced Worker termination'
  const terminatedWorker = await page.evaluate(() => {
    const instance = window.__dshBrowserWorkers.at(-1)
    if (instance === undefined) throw new Error('the page did not create a Dedicated Worker')
    instance.worker.terminate()
    return instance.url
  })
  const reclaimToken = randomUUID()
  const reclaimed = await waitFor(async () => {
    const response = await sessionRequest(origin, 'open', { sessionId, access: 'write', ownerToken: reclaimToken })
    if (response.status === 200) return response
    assert.equal(response.status, 409, JSON.stringify(response))
    return undefined
  }, 'abandoned Worker lease expiry', 10_000)
  await sessionRequest(origin, 'close', { sessionId, ownerToken: reclaimed.owner.ownerToken })
  lifecyclePhase = 'Worker termination reload'
  await page.reload({ waitUntil: 'domcontentloaded' })
  lifecyclePhase = 'Worker termination recovery'
  await waitForPreview(page)
  const afterWorkerRestart = await sendTurn({
    page,
    origin,
    requests,
    sessionId,
    prompt: 'Please reply with BROWSER_NATIVE_WORKER_RESTART_OK',
    marker: 'BROWSER_NATIVE_WORKER_RESTART_OK',
  })
  const persisted = JSON.parse(await readFile(join(dataDir, 'sessions', `${sessionId}.json`), 'utf8'))
  assert.equal(persisted.durableThroughSeq, persisted.events.length - 1)
  assert.equal(persisted.events.filter(event => event.type === 'turn/end').length, 7)
  assert.equal(assistantText({ events: persisted.events }).includes(recoveredMarker), true)
  assert.equal(afterBackendRestart.session.events.filter(event => event.type === 'turn/end').length, 6)
  assert.equal(afterWorkerRestart.session.events.filter(event => event.type === 'turn/end').length, 7)
  const toleratedWebKitTeardownError = error => browserName === 'webkit'
    && error.message === 'web-preview tunnel: boot payload failed with HTTP 503: TypeError: Load failed'
    && ['page refresh', 'backend shutdown', 'Worker termination reload'].includes(error.phase)
  assert.deepEqual(pageErrors.filter(error => !toleratedWebKitTeardownError(error)), [],
    `unexpected page errors: ${JSON.stringify(pageErrors)}`)
  assert.equal(pageErrorsBeforeWorkerTerminate.every(toleratedWebKitTeardownError), true,
    `unexpected page errors before forced Worker termination: ${JSON.stringify(pageErrorsBeforeWorkerTerminate)}`)
  process.stdout.write(`${JSON.stringify({
    mode: 'scripted',
    browser: browserName,
    sessionId,
    turns: persisted.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind),
    refreshContinued: afterRefresh.session.events.filter(event => event.type === 'turn/end').length === 2,
    stopSettled: stoppedTurn.data.reason.kind,
    writeLeaseConflict: competingWrite.body.error.code,
    failedTurnRecovered: recovered.session.events.filter(event => event.type === 'turn/end').at(-1).data.reason.kind === 'completed',
    backendRestartContinued: afterBackendRestart.session.events.filter(event => event.type === 'turn/end').length === 6,
    workerTerminateRecovered: afterWorkerRestart.session.events.filter(event => event.type === 'turn/end').length === 7,
    terminatedWorkerUrl: terminatedWorker,
    durableThroughSeq: persisted.durableThroughSeq,
    pageErrors,
    pageErrorsBeforeWorkerTerminate,
    httpErrors,
  })}\n`)
} catch (error) {
  const sessionId = requests.find(request => request.path.endsWith('/session/create'))?.body.sessionId
  const latest = sessionId && origin ? await sessionRequest(origin, 'read', { sessionId, offset: 0 }) : undefined
  process.stderr.write(`${JSON.stringify({
    failure: error.message,
    sessionId,
    turnReasons: latest?.events?.filter(event => event.type === 'turn/end').map(event => event.data.reason),
    eventTypes: latest?.events?.map(event => event.type),
    pageText: page && !page.isClosed() ? (await page.locator('body').innerText()).slice(-5000) : undefined,
    pageErrors,
    httpErrors,
  })}\n`)
  throw error
} finally {
  await page?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
