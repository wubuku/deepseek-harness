import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-attachment-cancel-')))
const beforeName = 'cancel-before-publish.txt'
const afterName = 'cancel-after-publish.txt'
const stagedName = 'cancel-during-opfs-staging.txt'
const stagedBytes = Buffer.alloc(1024 * 1024, 0x71)
const beforeBytes = Buffer.alloc(1024 * 1024, 0x62)
const afterBytes = Buffer.from('published before receipt; removal cannot undo this object\n')
const beforeHash = createHash('sha256').update(beforeBytes).digest('hex')
const afterHash = createHash('sha256').update(afterBytes).digest('hex')
const deferred = () => {
  let resolve
  const promise = new Promise(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}
const releaseBeforeBody = deferred()
const releaseReceipt = deferred()
const pageErrors = []
const browserRequests = []
const apiRequests = []
const requestFailures = []
const attachmentRequests = []
const attachmentStages = []
const progress = stage => process.env.DSH_POC_VERBOSE === '1'
  ? process.stderr.write(`attachment-cancellation: ${stage}\n`)
  : undefined
let beforeBodyPaused = false
let beforeBodyReached = false
let beforeBodyClean = false
let receiptGateReached = false
let responseWasAbandoned = false
let app
let image
let browser
let context
let page
let sessionId

async function listFiles(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await listFiles(path))
    else output.push(path)
  }
  return output
}

async function listAttachmentOpfsFiles() {
  return await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const namespace = await root.getDirectoryHandle('dsh-browser-native-attachments-v1').catch(() => undefined)
    if (namespace === undefined) return []
    const files = []
    for await (const [workspaceId, entry] of namespace.entries()) {
      if (entry.kind !== 'directory') continue
      for await (const [name, file] of entry.entries()) {
        if (file.kind !== 'file') continue
        files.push({ workspaceId, name })
      }
    }
    return files
  })
}

function assertNoAttachmentBlocks(session) {
  assert.equal(session.events.filter(event => event.type === 'user/message'
    && event.data.content?.some(block => block.type === 'file')).length, 0)
}

try {
  progress('building runtime image')
  image = await createRuntimeValidationDist({ roster: 'browser' })
  progress('starting backend')
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: {
      onAttachmentChunk: async (_bytes, context) => {
        if (context.hash !== beforeHash || beforeBodyPaused) return
        beforeBodyPaused = true
        beforeBodyReached = true
        await releaseBeforeBody.promise
      },
      onAttachmentStage: stage => {
        attachmentStages.push(stage)
        if (stage === 'upload-aborted') {
          beforeBodyClean = true
        }
        if (stage === 'response-abandoned') {
          responseWasAbandoned = true
        }
      },
      beforeAttachmentReceipt: async ({ hash }) => {
        if (hash !== afterHash) return
        receiptGateReached = true
        await releaseReceipt.promise
      },
    },
  })
  const origin = await app.listen(0)
  progress(`backend listening on ${new URL(origin).port}`)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    browserRequests.push({ url: request.url(), method: request.method() })
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/browser-native/')) {
      let body
      try { body = request.postDataJSON() } catch {}
      apiRequests.push({ path: url.pathname, body })
    }
    if (url.pathname.includes('/workspace/attachments/') && request.method() === 'PUT') {
      attachmentRequests.push(request)
    }
  })
  page.on('requestfailed', request => {
    if (new URL(request.url()).pathname.includes('/workspace/attachments/')) {
      requestFailures.push({ url: request.url(), error: request.failure()?.errorText })
    }
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  progress('preview and Worker ready')

  const stagingWait = page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'wait-attachment-opfs-staging-write',
  }))
  await page.locator('input[type="file"]').last().setInputFiles({
    name: stagedName,
    mimeType: 'text/plain',
    buffer: stagedBytes,
  })
  let stagingTimeout
  const staging = await Promise.race([
    stagingWait,
    new Promise(resolveTimeout => {
      stagingTimeout = setTimeout(() => resolveTimeout({ ok: false, error: 'timed out waiting for partial OPFS staging' }), 30_000)
      stagingTimeout.unref?.()
    }),
  ])
  clearTimeout(stagingTimeout)
  assert.equal(staging?.ok, true, JSON.stringify(staging))
  assert.equal(staging.stage, 'partial-opfs-staging-write')
  assert.ok(staging.bytesWritten > 0 && staging.bytesWritten < stagedBytes.byteLength, JSON.stringify(staging))
  const stagedOpfsFiles = await listAttachmentOpfsFiles()
  const stagedUpload = stagedOpfsFiles.find(file => /^upload-[0-9a-f-]+$/i.test(file.name))
  assert.ok(stagedUpload, JSON.stringify(stagedOpfsFiles))
  assert.ok(stagedOpfsFiles.every(file => file.workspaceId === stagedUpload.workspaceId
    && (file.name === stagedUpload.name || file.name === `${stagedUpload.name}.crswap`)), JSON.stringify(stagedOpfsFiles))
  progress('OPFS staging write paused')
  await page.getByRole('button', { name: `Remove file ${stagedName}` }).click()
  await page.getByText(stagedName, { exact: true }).waitFor({ state: 'detached' })
  await waitFor(async () => {
    const state = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
      action: 'attachment-opfs-write-state',
    }))
    return state?.outcome === 'aborted' ? state : undefined
  }, 'composer removal aborts the Worker OPFS staging wait')
  await waitFor(async () => (await listAttachmentOpfsFiles()).length === 0,
    'cancelled OPFS staging file is removed')
  assert.equal(attachmentRequests.length, 0, 'cancellation during OPFS staging must happen before any backend upload request')
  progress('OPFS staging cancellation and cleanup observed')
  const stagedTurn = await sendTurn({
    page,
    origin,
    requests: apiRequests,
    prompt: 'BROWSER_NATIVE_CANCEL_DURING_OPFS continue with text only',
    timeout: 90_000,
  })
  sessionId = stagedTurn.sessionId
  progress('post-OPFS-cancel scripted turn complete')
  assertNoAttachmentBlocks(stagedTurn.session)
  assert.equal(stagedTurn.session.events.filter(event => event.type === 'user/message'
    && event.data.content?.some(block => block.type === 'text'
      && block.text.includes('BROWSER_NATIVE_CANCEL_DURING_OPFS'))).length, 1)

  const beforeFailure = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname.includes('/workspace/attachments/'), { timeout: 30_000 })
  await page.locator('input[type="file"]').last().setInputFiles({
    name: beforeName,
    mimeType: 'text/plain',
    buffer: beforeBytes,
  })
  await waitFor(async () => beforeBodyReached, 'backend receives the pre-publish upload chunk')
  progress('backend pre-publish barrier reached')
  await page.getByRole('button', { name: `Remove file ${beforeName}` }).click()
  await page.getByText(beforeName, { exact: true }).waitFor({ state: 'detached' })
  releaseBeforeBody.resolve()
  await beforeFailure
  await waitFor(async () => beforeBodyClean, 'backend removes the cancelled upload staging object')
  progress('backend pre-publish cancellation settled')
  assert.equal(await page.getByText(beforeName, { exact: true }).count(), 0,
    'a late upload failure must not restore a removed draft')
  assert.deepEqual(await listFiles(join(dataDir, 'attachments-v1')), [],
    'cancel before atomic publish must remove both partial and committed files')

  const first = await sendTurn({
    page,
    origin,
    requests: apiRequests,
    sessionId,
    prompt: 'BROWSER_NATIVE_CANCEL_BEFORE_PUBLISH continue with this text only',
    timeout: 90_000,
  })
  sessionId = first.sessionId
  progress('post-backend-cancel scripted turn complete')
  assertNoAttachmentBlocks(first.session)
  assert.equal(first.session.events.filter(event => event.type === 'user/message'
    && event.data.content?.some(block => block.type === 'text'
      && block.text.includes('BROWSER_NATIVE_CANCEL_BEFORE_PUBLISH'))).length, 1)

  const afterFailure = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname.includes('/workspace/attachments/'), { timeout: 30_000 })
  await page.locator('input[type="file"]').last().setInputFiles({
    name: afterName,
    mimeType: 'text/plain',
    buffer: afterBytes,
  })
  await waitFor(async () => receiptGateReached, 'backend publishes object before waiting to send its receipt')
  progress('backend post-publish receipt barrier reached')
  await page.getByRole('button', { name: `Remove file ${afterName}` }).click()
  await page.getByText(afterName, { exact: true }).waitFor({ state: 'detached' })
  releaseReceipt.resolve()
  await afterFailure
  await waitFor(async () => responseWasAbandoned, 'backend observes that cancellation closed the receipt response')
  progress('backend post-publish cancellation settled')
  assert.equal(await page.getByText(afterName, { exact: true }).count(), 0,
    'a late successful receipt must not restore a removed draft')

  const publishedObject = await readFile(join(dataDir, 'attachments-v1', (await page.evaluate(async () => {
    const identity = await (await fetch('/api/browser-native/workspace/identity', { headers: { 'x-browser-native-identity-mode': 'existing' } })).json()
    return identity.workspaceId
  })), afterHash.slice(0, 2), afterHash))
  assert.deepEqual(publishedObject, afterBytes,
    'abort after publication must not claim that the immutable backend object was rolled back')

  const second = await sendTurn({
    page,
    origin,
    requests: apiRequests,
    sessionId,
    prompt: 'BROWSER_NATIVE_CANCEL_AFTER_PUBLISH continue without the removed attachment',
    timeout: 90_000,
  })
  progress('final scripted turn complete')
  assert.equal(second.sessionId, sessionId)
  assertNoAttachmentBlocks(second.session)
  assert.equal(second.session.events.filter(event => event.type === 'user/message'
    && event.data.content?.some(block => block.type === 'text'
      && block.text.includes('BROWSER_NATIVE_CANCEL_AFTER_PUBLISH'))).length, 1)
  assert.equal(second.session.events.filter(event => event.type === 'user/message'
    && event.data.content?.some(block => block.type === 'text'
      && block.text.includes('BROWSER_NATIVE_CANCEL_BEFORE_PUBLISH'))).length, 1)
  assert.equal(second.session.events.filter(event => event.type === 'user/message'
    && event.data.content?.some(block => block.type === 'text'
      && block.text.includes('BROWSER_NATIVE_CANCEL_DURING_OPFS'))).length, 1)
  assert.equal(second.session.events.filter(event => event.type === 'tool/call'
    && event.data.name === 'read').length, 0, 'cancelled draft bytes must not become an Agent tool input')
  assert.equal(attachmentRequests.length, 2)
  assert.equal(requestFailures.length, 2)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(browserRequests.filter(request => new URL(request.url).origin !== origin), [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    browserVersion: browser.version(),
    attachmentUploadRequests: attachmentRequests.length,
    cancelledRequests: requestFailures.length,
    beforePublishObjectCount: 0,
    afterPublishObjectRetained: true,
    sessionId,
    promptEvents: second.session.events.filter(event => event.type === 'user/message').length,
    opfsStagingCancellation: 'aborted; temporary OPFS entry removed; no backend PUT started',
    opfsTemporaryEntriesAtPause: stagedOpfsFiles.map(file => file.name),
    verifiedPromptMarkers: ['BROWSER_NATIVE_CANCEL_DURING_OPFS', 'BROWSER_NATIVE_CANCEL_BEFORE_PUBLISH', 'BROWSER_NATIVE_CANCEL_AFTER_PUBLISH'],
    userMessages: second.session.events.filter(event => event.type === 'user/message')
      .map(event => event.data.content?.filter(block => block.type === 'text').map(block => block.text).join('')),
    fileBlocks: second.session.events.filter(event => event.type === 'user/message'
      && event.data.content?.some(block => block.type === 'file')).length,
    readCalls: second.session.events.filter(event => event.type === 'tool/call' && event.data.name === 'read').length,
    attachmentStages,
    pageErrors,
  })}\n`)
} finally {
  progress('releasing barriers and disposing test resources')
  releaseBeforeBody.resolve()
  releaseReceipt.resolve()
  await page?.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'release-attachment-opfs-write',
  })).catch(() => {})
  await page?.close().catch(() => {})
  await context?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
  progress('teardown complete')
}
