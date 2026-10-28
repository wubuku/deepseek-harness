import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-external-edit-unknown-')))
const workspacePath = '/dsh/home/workspace/external-edit-crash.txt'
const fileBytes = Number(process.env.DSH_POC_EXTERNAL_EDIT_FILE_BYTES ?? '0')
const largeFile = fileBytes !== 0
const marker = largeFile
  ? 'BROWSER_NATIVE_EXTERNAL_EDIT_CRASH_WINDOW_64M_E2E'
  : 'BROWSER_NATIVE_EXTERNAL_EDIT_CRASH_WINDOW_E2E'
const beforeContent = 'BROWSER_NATIVE_EXTERNAL_EDIT_64M_V1'
const afterContent = 'BROWSER_NATIVE_EXTERNAL_EDIT_64M_V2'
if (largeFile && fileBytes !== 64 * 1024 * 1024) throw new Error('DSH_POC_EXTERNAL_EDIT_FILE_BYTES must be 67108864')

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
const uploadRequests = []

async function restartBackend() {
  await app.close()
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(new URL(origin).port)
}

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

async function readSessionWithBrowserCookie(id) {
  const cookie = (await context.cookies(`${origin}/api/browser-native/session/read`))
    .find(item => item.name === 'dsh-browser-native-session-principal')
  assert.ok(cookie, 'Browser Session principal cookie is missing')
  const response = await fetch(`${origin}/api/browser-native/session/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${cookie.name}=${cookie.value}` },
    body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), sessionId: id, offset: 0 }),
  })
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  return body
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

async function readBlobSummary(hash) {
  const cookie = (await context.cookies(`${origin}/api/browser-native/workspace`))
    .find(item => item.name === 'dsh-browser-native-principal')
  assert.ok(cookie, 'Browser Workspace principal cookie is missing')
  const response = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`, {
    headers: { cookie: `${cookie.name}=${cookie.value}` },
  })
  assert.equal(response.status, 200)
  const digest = createHash('sha256')
  let bytes = 0
  let prefix = Buffer.alloc(0)
  for await (const chunk of response.body) {
    const value = Buffer.from(chunk)
    digest.update(value)
    bytes += value.byteLength
    if (prefix.byteLength < 16 * 1024) prefix = Buffer.concat([prefix, value]).subarray(0, 16 * 1024)
  }
  return { bytes, digest: digest.digest('hex'), prefix: prefix.toString('utf8') }
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
    if (url.pathname.includes('/workspace/blob-upload/') && request.method() === 'PUT') {
      uploadRequests.push(request.postDataBuffer()?.byteLength ?? 0)
    }
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
      const session = await readSessionWithBrowserCookie(sessionId)
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
  const seeded = largeFile
    ? await testAction({
      action: 'write-pattern', path: workspacePath, byteLength: fileBytes, byteValue: 0x41,
      lineBytes: 4096, markerLine: 2, marker: beforeContent,
    })
    : await testAction({ action: 'write', path: workspacePath, content: 'before\n' })
  assert.equal(seeded?.ok, true, JSON.stringify(seeded))
  const seedFlush = await testAction({ action: 'flush-workspace' })
  assert.equal(seedFlush?.ok, true, JSON.stringify(seedFlush))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  const seededUploadCount = uploadRequests.length

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  loseNextCommit = true
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(largeFile
    ? `${marker}：先读取第二行，再把 ${beforeContent} 替换为 ${afterContent}。`
    : `${marker}：先读取，再把 before 编辑为 after。`)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()

  const createRequest = await waitFor(
    () => requests.find(request => request.path.endsWith('/session/create')),
    'Session creation for external edit recovery',
  )
  sessionId = createRequest.body.sessionId
  await waitFor(() => commitResponseLost, 'backend external edit commit before response loss', 60_000)
  assert.equal(commits.length, 2, 'the seed and external edit must each make one commit request')
  assert.equal(commits[1].operationId, lostOperationId)
  const editUploadBytes = uploadRequests.slice(seededUploadCount).reduce((sum, bytes) => sum + bytes, 0)
  if (largeFile) assert.equal(editUploadBytes, fileBytes, '64 MiB file-level edit must upload the complete changed blob')

  const beforeReload = await readSessionWithBrowserCookie(sessionId)
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
    const current = await readSessionWithBrowserCookie(sessionId)
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
  assert.equal(commits.length, 3, 'recovery must make one idempotent replay after the seed and lost-response commit')
  assert.equal(commits[1].operationId, lostOperationId)
  assert.equal(commits[2].operationId, lostOperationId)
  assert.equal(commits[2].baseRevision, commits[1].baseRevision)
  assert.deepEqual(commits[2].changes, commits[1].changes)
  const manifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(manifest.revision, 2)
  const entry = manifest.entries.find(item => item.path === 'external-edit-crash.txt')
  assert.ok(entry)
  const remote = largeFile
    ? await readBlobSummary(entry.hash)
    : await page.evaluate(async ({ id, hash }) => {
      const response = await fetch(`/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)
      return { status: response.status, content: await response.text() }
    }, { id: workspaceId, hash: entry.hash })
  if (largeFile) {
    assert.equal(remote.bytes, fileBytes)
    assert.equal(remote.digest, entry.hash)
    assert.ok(remote.prefix.includes(afterContent))
  } else {
    assert.deepEqual(remote, { status: 200, content: 'after\n' })
  }
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
    recoveredContent: largeFile ? afterContent : remote.content,
    recoveredBlobBytes: largeFile ? remote.bytes : undefined,
    recoveredBlobHash: largeFile ? remote.digest : undefined,
    editUploadBytes,
    editUploadChunkCount: uploadRequests.slice(seededUploadCount).length,
    commitOperationIds: commits.map(commit => commit.operationId),
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
    commitCount: commits.length,
    operationIds: commits.map(commit => commit.operationId),
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
