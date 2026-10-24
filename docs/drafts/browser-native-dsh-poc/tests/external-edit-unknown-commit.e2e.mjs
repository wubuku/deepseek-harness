import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-external-edit-unknown-')))
const workspacePath = '/dsh/home/workspace/external-edit-crash.txt'
const marker = 'BROWSER_NATIVE_EXTERNAL_EDIT_CRASH_WINDOW_E2E'

let image
let app
let browser
let context
let page
let origin
let sessionId
let workspaceId
let lostOperationId
let loseNextCommit = false
let commitResponseLost = false
const requests = []
const commits = []
const sessionFlushes = []
const pageErrors = []
const workerErrors = []
const externalRequests = []

async function restartBackend() {
  await app.close()
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(new URL(origin).port)
}

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

async function listEditTemporaryDirectories() {
  return await page.evaluate(async id => {
    const root = await navigator.storage.getDirectory()
    const prefix = `dsh-browser-native-edit-${id}-`
    const names = []
    for await (const [name, handle] of root.entries()) {
      if (handle.kind === 'directory' && name.startsWith(prefix)) names.push(name)
    }
    return names.sort()
  }, workspaceId)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
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
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== new URL(origin).origin) externalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({ path: url.pathname, body })
    if (url.pathname.endsWith('/workspace/commit')) commits.push(body)
  })
  await page.route(`${origin}/api/browser-native/session/flush`, async route => {
    const response = await route.fetch()
    const body = await response.text()
    if (response.ok()) sessionFlushes.push(JSON.parse(body))
    await route.fulfill({ status: response.status(), headers: response.headers(), body })
  })
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    if (!loseNextCommit) {
      await route.continue()
      return
    }
    loseNextCommit = false
    const response = await route.fetch()
    assert.equal(response.status(), 200, 'the backend must commit the external edit before its response is lost')
    const body = await response.json()
    assert.equal(body.replayed, false, JSON.stringify(body))
    lostOperationId = body.operationId
    const durableSession = await waitFor(async () => {
      if (sessionId === undefined) return undefined
      const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
      return session.events.some(event => event.type === 'tool/call' && event.data.name === 'edit')
        ? session
        : undefined
    }, 'durable DSH edit call before Worker termination', 15_000)
    const editCall = durableSession.events.find(event => event.type === 'tool/call' && event.data.name === 'edit')
    assert.ok(editCall)
    assert.ok(sessionFlushes.some(flush => flush.durableThroughSeq >= editCall.seq),
      'the Session tool call must be durably flushed before the Workspace commit')
    await page.evaluate(() => {
      const workers = window.__dshBrowserWorkers
      if (workers.length === 0) throw new Error('Dedicated Worker was not captured')
      for (const worker of workers) worker.terminate()
    })
    await restartBackend()
    commitResponseLost = true
    await route.abort()
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')
  const seeded = await testAction({ action: 'write', path: workspacePath, content: 'before\n' })
  assert.equal(seeded?.ok, true, JSON.stringify(seeded))
  const seedFlush = await testAction({ action: 'flush-workspace' })
  assert.equal(seedFlush?.ok, true, JSON.stringify(seedFlush))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  loseNextCommit = true
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(`${marker}：先读取，再把 before 编辑为 after。`)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()

  const createRequest = await waitFor(
    () => requests.find(request => request.path.endsWith('/session/create')),
    'Session creation for external edit recovery',
  )
  sessionId = createRequest.body.sessionId
  await waitFor(() => commitResponseLost, 'backend external edit commit before response loss', 60_000)
  assert.equal(commits.length, 2, 'the seed and external edit must each make one commit request')
  assert.equal(commits[1].operationId, lostOperationId)

  const beforeReload = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
  const editCalls = beforeReload.events.filter(event => event.type === 'tool/call' && event.data.name === 'edit')
  assert.equal(editCalls.length, 1)
  assert.equal(beforeReload.events.some(event => event.type === 'browser-native/workspace-receipt'
    && event.data.operationId === lostOperationId), false)
  const llmRequestsBeforeRecovery = requests.filter(request => request.path.endsWith('/llm')).length

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 2, undefined, { timeout: 45_000 })
  const recovered = await waitFor(async () => {
    const current = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const receipt = current.events.find(event => event.type === 'browser-native/workspace-receipt'
      && event.data.operationId === lostOperationId)
    const unknownResult = current.events.find(event => event.type === 'tool/result'
      && event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN')
    return receipt === undefined || unknownResult === undefined ? undefined : { current, receipt, unknownResult }
  }, 'external edit receipt and unknown tool settlement', 45_000)
  assert.equal(recovered.receipt.data.callId, editCalls[0].data.callId)
  assert.equal(recovered.receipt.data.toolName, 'edit')
  assert.equal(recovered.receipt.data.revision, 2)
  assert.equal(recovered.current.events.filter(event => event.type === 'browser-native/workspace-receipt'
    && event.data.operationId === lostOperationId).length, 1)
  assert.equal(recovered.current.events.filter(event => event.type === 'tool/call'
    && event.data.name === 'edit').length, 1, 'recovery must not replay the DSH edit')
  assert.equal(requests.filter(request => request.path.endsWith('/llm')).length, llmRequestsBeforeRecovery,
    'recovery must not issue another model request for the interrupted turn')
  assert.deepEqual(await listEditTemporaryDirectories(), [])

  const operation = await page.evaluate(async ({ id, operationId }) => await (await fetch(
    `/api/browser-native/workspace/operation/${encodeURIComponent(operationId)}?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), { id: workspaceId, operationId: lostOperationId })
  assert.equal(operation.found, true)
  assert.equal(operation.receipt.revision, 2)
  const manifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(manifest.revision, 2)
  const entry = manifest.entries.find(item => item.path === 'external-edit-crash.txt')
  assert.ok(entry)
  const remote = await page.evaluate(async ({ id, hash }) => {
    const response = await fetch(`/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)
    return { status: response.status, content: await response.text() }
  }, { id: workspaceId, hash: entry.hash })
  assert.deepEqual(remote, { status: 200, content: 'after\n' })
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors))
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'real-DSH-external-edit-unknown-commit-after-backend-restart',
    sessionId,
    workspaceId,
    operationId: lostOperationId,
    workspaceCommitRequests: commits.length,
    sessionFlushesBeforeWorkspaceCommit: sessionFlushes.map(flush => flush.durableThroughSeq),
    backendRevision: operation.receipt.revision,
    editToolCallCount: editCalls.length,
    unknownResultCode: recovered.unknownResult.data.error.code,
    receiptCount: recovered.current.events.filter(event => event.type === 'browser-native/workspace-receipt').length,
    recoveredContent: remote.content,
    pageErrors,
    workerErrors,
    externalRequests,
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    sessionId,
    workspaceId,
    lostOperationId,
    commits,
    requests: requests.map(request => ({ path: request.path, sessionId: request.body?.sessionId })),
    pageText: page !== undefined && !page.isClosed() ? (await page.locator('body').innerText().catch(() => '')).slice(-2500) : undefined,
    pageErrors,
    workerErrors,
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close().catch(() => {})
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
