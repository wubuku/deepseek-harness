import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-attachment-crash-')))
const partialBytes = Buffer.alloc(1024 * 1024, 0x61)
const publishedBytes = Buffer.from('published object survives Worker termination\n')
const hashOf = bytes => createHash('sha256').update(bytes).digest('hex')
const partialHash = hashOf(partialBytes)
const publishedHash = hashOf(publishedBytes)
const deferred = () => {
  let resolve
  const promise = new Promise(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}
const releasePartial = deferred()
const releaseReceipt = deferred()
const apiRequests = []
const sameOriginPaths = []
const failedUploads = []
const uploadResponses = []
const pageErrors = []
const externalRequests = []
const backendStages = []
const attachmentReceipts = []
const ownerRequests = []
const pageRoles = new WeakMap()
const progress = stage => process.env.DSH_POC_VERBOSE === '1'
  ? process.stderr.write(`attachment-worker-crash-recovery: ${stage}\n`)
  : undefined
let partialReached = false
let receiptReached = false
let receiptAbandoned = false
let image
let app
let browser
let context
let ownerPage
let concurrentPage
let origin
let workspaceId

async function listFiles(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await listFiles(path))
    else output.push(path)
  }
  return output
}

function backendObjectPath(workspace, hash) {
  return join(dataDir, 'attachments-v1', workspace, hash.slice(0, 2), hash)
}

async function listOpfsAttachmentFiles(page, id) {
  return await page.evaluate(async workspaceIdValue => {
    const root = await navigator.storage.getDirectory()
    const namespace = await root.getDirectoryHandle('dsh-browser-native-attachments-v1').catch(() => undefined)
    if (namespace === undefined) return []
    const directory = await namespace.getDirectoryHandle(workspaceIdValue).catch(() => undefined)
    if (directory === undefined) return []
    const files = []
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === 'file') files.push(name)
    }
    return files.sort()
  }, id)
}

async function workerRequest(page, request) {
  return await page.evaluate(async value => {
    const invoke = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof invoke !== 'function') throw new Error('Browser-Native Worker test port is unavailable')
    return await invoke(value)
  }, request)
}

async function openRuntime(page) {
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => ['synced', 'read-only'].includes(window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state), undefined, { timeout: 60_000 })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  const id = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof id, 'string')
  return id
}

function observePage(page, role) {
  pageRoles.set(page, role)
  page.on('pageerror', error => pageErrors.push({ role, message: error.message }))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push({ role, url: request.url() })
    else sameOriginPaths.push({ role, path: url.pathname, method: request.method() })
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch {}
    const item = { role, path: url.pathname, method: request.method(), body }
    apiRequests.push(item)
    if (role === 'owner') ownerRequests.push(item)
  })
  page.on('requestfailed', request => {
    if (new URL(request.url()).pathname.includes('/workspace/attachments/')) {
      failedUploads.push({ role, error: request.failure()?.errorText })
    }
  })
  page.on('response', async response => {
    const request = response.request()
    const url = new URL(response.url())
    if (url.pathname.includes('/workspace/attachments/') && request.method() === 'PUT') {
      uploadResponses.push({ role, status: response.status(), body: await response.json().catch(() => ({})) })
    }
  })
}

async function selectFileAndWait(page, file) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname.includes('/workspace/attachments/')
    && response.request().method() === 'PUT', { timeout: 45_000 })
  await page.locator('input[type="file"]').last().setInputFiles(file)
  try {
    return await response
  } catch (error) {
    const visibleText = await page.locator('body').innerText().catch(() => '')
    const role = pageRoles.get(page)
    const paths = apiRequests.filter(item => item.role === role).map(item => item.path).slice(-12)
    throw new Error(`${error instanceof Error ? error.message : String(error)}; API paths=${paths.join(',')}; page errors=${pageErrors.map(item => item.message).join(' | ')}; text=${visibleText.slice(-800)}`)
  }
}

async function terminateHostWorker(page) {
  return await page.evaluate(() => {
    const record = window.__dshBrowserWorkers?.find(worker => worker.name === 'dsh-host' && !worker.terminated)
    if (record === undefined) throw new Error('No active DSH Host Worker was captured')
    record.worker.terminate()
    record.terminated = true
    return { name: record.name, source: record.source }
  })
}

async function seedOrphan(page, id, name) {
  await page.evaluate(async ({ workspaceIdValue, fileName }) => {
    const root = await navigator.storage.getDirectory()
    const namespace = await root.getDirectoryHandle('dsh-browser-native-attachments-v1', { create: true })
    const directory = await namespace.getDirectoryHandle(workspaceIdValue, { create: true })
    const file = await directory.getFileHandle(fileName, { create: true })
    const writer = await file.createWritable({ keepExistingData: false })
    await writer.write('stale staging from a terminated Worker')
    await writer.close()
  }, { workspaceIdValue: id, fileName: name })
}

async function waitForReady(page) {
  await waitForPreview(page)
  await page.waitForFunction(() => ['synced', 'read-only'].includes(window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state), undefined, { timeout: 60_000 })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: {
      onAttachmentChunk: async (_bytes, contextValue) => {
        if (contextValue.hash !== partialHash || partialReached) return
        partialReached = true
        await releasePartial.promise
      },
      beforeAttachmentReceipt: async ({ hash, stored }) => {
        attachmentReceipts.push({ hash, bytes: stored.bytes, reused: stored.reused })
        if (hash !== publishedHash) return
        receiptReached = true
        await releaseReceipt.promise
      },
      onAttachmentStage: stage => {
        backendStages.push(stage)
        if (stage === 'response-abandoned') receiptAbandoned = true
      },
    },
  })
  origin = await app.listen(0)
  progress('backend ready')
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => {
    const workers = []
    Object.defineProperty(window, '__dshBrowserWorkers', { value: workers })
    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args, target)
        workers.push({ worker, name: args[1]?.name, source: String(args[0]), terminated: false })
        return worker
      },
    })
  })
  ownerPage = await context.newPage()
  observePage(ownerPage, 'owner')
  workspaceId = await openRuntime(ownerPage)
  progress('owner Worker ready')
  const sessionAppendCountBeforeRecovery = apiRequests.filter(request => request.path.endsWith('/session/append')).length

  const stagingWait = workerRequest(ownerPage, { action: 'wait-attachment-opfs-staging-write' })
  void stagingWait.catch(() => {})
  await ownerPage.locator('input[type="file"]').last().setInputFiles({
    name: 'crash-during-opfs.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024 * 1024, 0x74),
  })
  const staging = await stagingWait
  assert.equal(staging.ok, true, JSON.stringify(staging))
  assert.ok(staging.bytesWritten > 0)
  const stagingNames = await listOpfsAttachmentFiles(ownerPage, workspaceId)
  const activeUpload = stagingNames.find(name => /^upload-[0-9a-f-]{36}$/iu.test(name))
  assert.ok(activeUpload, JSON.stringify(stagingNames))
  assert.ok(stagingNames.includes(`${activeUpload}.crswap`), JSON.stringify(stagingNames))
  progress('OPFS upload paused with temporary file lock held')

  concurrentPage = await context.newPage()
  observePage(concurrentPage, 'concurrent')
  const concurrentWorkspace = await openRuntime(concurrentPage)
  assert.equal(concurrentWorkspace, workspaceId)
  const concurrentScan = await workerRequest(concurrentPage, { action: 'reconcile-attachment-staging' })
  assert.equal(concurrentScan.ok, true, JSON.stringify(concurrentScan))
  const whileOwnerPaused = await listOpfsAttachmentFiles(concurrentPage, workspaceId)
  assert.ok(whileOwnerPaused.includes(activeUpload), JSON.stringify(whileOwnerPaused))
  assert.ok(whileOwnerPaused.includes(`${activeUpload}.crswap`), JSON.stringify(whileOwnerPaused))
  await concurrentPage.locator('input[type="file"]').last().setInputFiles({
    name: 'concurrent-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('read-only upload must be rejected\n'),
  })
  await concurrentPage.getByText('Upload failed; click to retry', { exact: false }).waitFor({ timeout: 20_000 })
  const afterConcurrentAttempt = await listOpfsAttachmentFiles(concurrentPage, workspaceId)
  assert.ok(afterConcurrentAttempt.includes(activeUpload), JSON.stringify(afterConcurrentAttempt))
  assert.ok(afterConcurrentAttempt.includes(`${activeUpload}.crswap`), JSON.stringify(afterConcurrentAttempt))
  assert.equal(afterConcurrentAttempt.some(name => name.startsWith('upload-')
    && name !== activeUpload && name !== `${activeUpload}.crswap`), false,
    JSON.stringify(afterConcurrentAttempt))
  assert.equal(apiRequests.filter(request => request.path.endsWith('/session/append')).length,
    sessionAppendCountBeforeRecovery, 'file selection and recovery scans must not append Session events')
  progress('read-only second Worker rejected upload and skipped active staging')

  await concurrentPage.close()
  concurrentPage = undefined
  await terminateHostWorker(ownerPage)
  await ownerPage.reload({ waitUntil: 'domcontentloaded' })
  await waitForReady(ownerPage)
  const resumedOwner = await workerRequest(ownerPage, { action: 'lease-info' })
  progress(`reloaded worker access mode: ${String(resumedOwner.accessMode)}`)
  await seedOrphan(ownerPage, workspaceId, 'upload-00000000-0000-4000-8000-000000000001')
  const recoveredScan = await workerRequest(ownerPage, { action: 'reconcile-attachment-staging' })
  assert.equal(recoveredScan.ok, true, JSON.stringify(recoveredScan))
  const afterScan = await listOpfsAttachmentFiles(ownerPage, workspaceId)
  assert.equal(afterScan.some(name => name === activeUpload || name === `${activeUpload}.crswap`), false,
    JSON.stringify(afterScan))
  assert.equal(afterScan.includes('upload-00000000-0000-4000-8000-000000000001'), false,
    JSON.stringify(afterScan))
  assert.equal(afterScan.some(name => name.endsWith('.crswap')), false, JSON.stringify(afterScan))
  progress('new Worker reclaimed abandoned OPFS staging')
  await ownerPage.close()
  ownerPage = await context.newPage()
  observePage(ownerPage, 'owner')
  const reopenedWorkspace = await openRuntime(ownerPage)
  assert.equal(reopenedWorkspace, workspaceId)

  await ownerPage.locator('input[type="file"]').last().setInputFiles({
    name: 'crash-during-backend-upload.bin', mimeType: 'application/octet-stream', buffer: partialBytes,
  })
  const partialReady = await waitFor(async () => partialReached ? true : undefined,
    'backend receives partial attachment body', 30_000).catch(async error => {
      const details = await ownerPage.evaluate(() => ({
        inputs: [...document.querySelectorAll('input[type="file"]')].map(input => ({ disabled: input.disabled, accept: input.accept })),
        text: document.body.innerText.slice(-1200),
      }))
      throw new Error(`${error instanceof Error ? error.message : String(error)}; details=${JSON.stringify(details)}; same-origin paths=${sameOriginPaths.filter(item => item.role === 'owner').slice(-20).map(item => `${item.method} ${item.path}`).join(',')}; worker errors=${JSON.stringify(pageErrors)}`)
    })
  assert.equal(partialReady, true)
  const activeUploadFiles = await listOpfsAttachmentFiles(ownerPage, workspaceId)
  assert.ok(activeUploadFiles.includes(partialHash), JSON.stringify(activeUploadFiles))
  assert.equal(activeUploadFiles.some(name => /^upload-/iu.test(name)), false,
    'the immutable OPFS content object replaces staging before backend transfer starts')
  concurrentPage = await context.newPage()
  observePage(concurrentPage, 'concurrent')
  assert.equal(await openRuntime(concurrentPage), workspaceId)
  const activeTransferScan = await workerRequest(concurrentPage, { action: 'reconcile-attachment-staging' })
  assert.equal(activeTransferScan.ok, true, JSON.stringify(activeTransferScan))
  assert.ok((await listOpfsAttachmentFiles(concurrentPage, workspaceId)).includes(partialHash),
    'the concurrent Worker must retain the immutable source while backend upload is active')
  await concurrentPage.close()
  concurrentPage = undefined
  const backendStageCountBeforeCrash = backendStages.length
  await terminateHostWorker(ownerPage)
  releasePartial.resolve()
  const firstUploadOutcome = await waitFor(async () => {
    const stages = backendStages.slice(backendStageCountBeforeCrash)
    if (stages.includes('object-published')) return { kind: 'published' }
    if (stages.includes('upload-aborted')) return { kind: 'aborted' }
    return undefined
  }, 'backend settles the in-flight attachment after Worker termination', 30_000)
  const attachmentDirectory = join(dataDir, 'attachments-v1', workspaceId)
  if (firstUploadOutcome.kind === 'published') {
    assert.deepEqual(await readFile(backendObjectPath(workspaceId, partialHash)), partialBytes,
      'a request that outlives its Worker may publish a complete object')
  } else {
    assert.deepEqual(await listFiles(attachmentDirectory), [],
      'an aborted request must remove its partial object')
  }
  const partialBackendReceipt = firstUploadOutcome.kind === 'published'
    ? await waitFor(async () => {
      const stages = backendStages.slice(backendStageCountBeforeCrash)
      if (stages.includes('response-abandoned')) return { kind: 'abandoned', receipt: attachmentReceipts.findLast(receipt => receipt.hash === partialHash) }
      if (stages.includes('receipt-sent')) return { kind: 'sent', receipt: attachmentReceipts.findLast(receipt => receipt.hash === partialHash) }
      return undefined
    }, 'backend sends or abandons the partial upload receipt after Worker termination', 30_000)
    : { kind: 'not-published' }
  await ownerPage.close()
  ownerPage = await context.newPage()
  observePage(ownerPage, 'owner')
  assert.equal(await openRuntime(ownerPage), workspaceId)
  const partialRetry = await selectFileAndWait(ownerPage, {
    name: 'crash-during-backend-upload.bin', mimeType: 'application/octet-stream', buffer: partialBytes,
  })
  assert.equal(partialRetry.status(), 200)
  const partialRetryReceipt = attachmentReceipts.findLast(receipt => receipt.hash === partialHash)
  assert.equal(partialRetryReceipt?.reused, firstUploadOutcome.kind === 'published', JSON.stringify(partialRetryReceipt))
  assert.equal((await readFile(backendObjectPath(workspaceId, partialHash))).byteLength, partialBytes.byteLength)
  progress(`backend upload after Worker termination: ${firstUploadOutcome.kind}; receipt reused=${String(partialRetryReceipt?.reused)}`)
  progress('partial upload succeeded after explicit file re-selection')

  const receiptStageCount = backendStages.length
  await ownerPage.locator('input[type="file"]').last().setInputFiles({
    name: 'crash-after-object-publish.txt', mimeType: 'text/plain', buffer: publishedBytes,
  })
  await waitFor(async () => receiptReached, 'backend publishes the object before blocking its receipt', 30_000)
  assert.deepEqual(await readFile(backendObjectPath(workspaceId, publishedHash)), publishedBytes)
  await terminateHostWorker(ownerPage)
  releaseReceipt.resolve()
  const receiptOutcome = await waitFor(async () => {
    const stages = backendStages.slice(receiptStageCount)
    if (stages.includes('response-abandoned')) return { kind: 'abandoned' }
    if (stages.includes('receipt-sent')) return { kind: 'sent' }
    return undefined
  }, 'backend settles the published-object receipt after Worker termination', 30_000)
  progress(`published object survived Worker termination; receipt ${receiptOutcome.kind}`)

  await ownerPage.close()
  ownerPage = await context.newPage()
  observePage(ownerPage, 'owner')
  assert.equal(await openRuntime(ownerPage), workspaceId)
  const publishedRetry = await selectFileAndWait(ownerPage, {
    name: 'crash-after-object-publish.txt', mimeType: 'text/plain', buffer: publishedBytes,
  })
  assert.equal(publishedRetry.status(), 200)
  const reused = attachmentReceipts.findLast(receipt => receipt.hash === publishedHash)
  assert.equal(reused?.reused, true, JSON.stringify(reused))
  progress('same-content retry reused the published object')
  assert.deepEqual(await readFile(backendObjectPath(workspaceId, publishedHash)), publishedBytes)
  const prePromptEvents = ownerRequests.filter(request => request.path.endsWith('/session/append'))
    .flatMap(request => request.body?.events ?? [])
  assert.equal(prePromptEvents.some(event => event.type === 'user/message'
    && (event.data.content ?? []).some(block => block.type === 'file')), false,
  'file re-selection must not append a FileBlock before an explicit prompt')

  const finalTurn = await sendTurn({
    page: ownerPage,
    origin,
    requests: ownerRequests,
    prompt: 'BROWSER_NATIVE_ATTACHMENT_CRASH_RECOVERY confirm the selected attachment is ready.',
    timeout: 90_000,
  })
  const userMessages = finalTurn.session.events.filter(event => event.type === 'user/message')
  const submitted = userMessages.filter(event => event.data.content?.some(block => block.type === 'text'
    && block.text.includes('BROWSER_NATIVE_ATTACHMENT_CRASH_RECOVERY')))
  const fileBlocks = userMessages.flatMap(event => event.data.content ?? []).filter(block => block.type === 'file')
  assert.equal(submitted.length, 1)
  assert.equal(fileBlocks.length, 1)
  assert.equal(fileBlocks[0].attachment.attachmentId, `sha256:${publishedHash}`)
  assert.equal(finalTurn.session.events.filter(event => event.type === 'tool/call' && event.data.name === 'read').length, 0,
    'scripted recovery case does not claim an attachment-read model decision')
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    browserVersion: browser.version(),
    workspaceId,
    activeUploadProtectedDuringConcurrentTab: true,
    immutableSourceProtectedDuringConcurrentTransfer: true,
    opfsCrashCleanup: 'orphan upload and crswap removed after a new Worker acquired the per-file Web Lock',
    backendPartialUpload: firstUploadOutcome.kind,
    backendPartialUploadReceipt: partialBackendReceipt.kind,
    backendPublishedObjectReceipt: receiptOutcome,
    backendPublishedObjectRetry: reused?.reused,
    userPromptEvents: submitted.length,
    sessionFileBlocks: fileBlocks.length,
    backendStages,
    pageErrors,
    externalRequests: externalRequests.length,
  })}\n`)
} finally {
  releasePartial.resolve()
  releaseReceipt.resolve()
  await ownerPage?.close().catch(() => {})
  await concurrentPage?.close().catch(() => {})
  await context?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
