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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-unknown-commit-')))
const prompt = 'BROWSER_NATIVE_WORKSPACE_TOOL_E2E：请使用 write 工具写入工作区，然后确认。'

let image
let app
let browser
let page
let origin
let sessionId
let workspaceId
let interrupted = false
let restarted = false
const requests = []
const commits = []
const pageErrors = []
const externalRequests = []

async function readSession(id) {
  const cookie = (await page.context().cookies(`${origin}/api/browser-native/session/read`))
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

async function restartBackend() {
  await app.close()
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(new URL(origin).port)
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/api/browser-native/health`)).ok
    } catch {
      return false
    }
  }, 'backend health after restart', 10_000)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  await page.addInitScript(() => {
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
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({ path: url.pathname, body })
    if (url.pathname.endsWith('/workspace/commit')) commits.push(body)
  })
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    if (interrupted) {
      await route.continue()
      return
    }
    interrupted = true
    const response = await route.fetch()
    assert.equal(response.status(), 200, 'the backend must commit before the response is lost')
    const body = await response.json()
    assert.equal(body.replayed, false, JSON.stringify(body))
    await page.evaluate(() => {
      const worker = window.__dshBrowserWorkers.at(-1)
      if (worker === undefined) throw new Error('Dedicated Worker was not captured')
      worker.terminate()
    })
    await restartBackend()
    restarted = true
    await route.abort()
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(prompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const createRequest = await waitFor(
    () => requests.find(request => request.path.endsWith('/session/create')),
    'Session creation for unknown commit recovery',
  )
  sessionId = createRequest.body.sessionId
  await waitFor(() => restarted, 'backend commit, restart, and response loss', 45_000)
  assert.equal(commits.length, 1)
  const operationId = commits[0].operationId
  workspaceId = commits[0].workspaceId
  assert.equal(typeof workspaceId, 'string')
  const beforeReload = await readSession(sessionId)
  assert.equal(beforeReload.events.some(event => event.type === 'browser-native/workspace-receipt'), false)
  assert.equal(beforeReload.events.filter(event => event.type === 'tool/call' && event.data.name === 'write').length, 1)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  const recovered = await waitFor(async () => {
    const current = await readSession(sessionId)
    const receipt = current.events.find(event => event.type === 'browser-native/workspace-receipt')
    return receipt === undefined ? undefined : { current, receipt }
  }, 'Workspace operation receipt after backend restart', 45_000)
  const receipt = recovered.receipt
  assert.equal(receipt.data.operationId, operationId)
  assert.equal(recovered.current.events.filter(event => event.type === 'browser-native/workspace-receipt').length, 1)
  const writeCalls = recovered.current.events.filter(event => event.type === 'tool/call' && event.data.name === 'write')
  assert.equal(writeCalls.length, 1, 'recovery must not replay the DSH write tool call')
  const unknownResult = recovered.current.events.find(event => event.type === 'tool/result'
    && event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN')
  assert.ok(unknownResult, 'the interrupted DSH tool call must be settled as unknown')
  const operation = await page.evaluate(async ({ id, operationId: currentOperationId }) => await (await fetch(
    `/api/browser-native/workspace/operation/${currentOperationId}?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), { id: workspaceId, operationId })
  assert.equal(operation.found, true)
  assert.equal(operation.receipt.revision, 1)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  const manifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(manifest.revision, 1)
  assert.equal(manifest.entries.some(entry => entry.path === 'agent-receipt.txt'), true)
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors))
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'real-DSH-write-unknown-commit-after-backend-restart',
    sessionId,
    workspaceId,
    operationId,
    workspaceCommitRequests: commits.length,
    backendRevision: operation.receipt.revision,
    writeToolCallCount: writeCalls.length,
    unknownResultCode: unknownResult.data.error.code,
    receiptCount: recovered.current.events.filter(event => event.type === 'browser-native/workspace-receipt').length,
    pageErrors,
    externalRequests,
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    sessionId,
    workspaceId,
    requests: requests.map(request => ({ path: request.path, sessionId: request.body?.sessionId })),
    pageText: page !== undefined && !page.isClosed() ? (await page.locator('body').innerText().catch(() => '')).slice(-2500) : undefined,
    pageErrors,
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close().catch(() => {})
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
