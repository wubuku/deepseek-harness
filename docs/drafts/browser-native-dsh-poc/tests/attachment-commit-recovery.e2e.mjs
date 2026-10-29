import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-attachment-recovery-')))
const marker = 'BROWSER_NATIVE_ATTACHMENT_COMMIT_RECOVERY'
const content = Buffer.alloc(256 * 1024, 0x61)
Buffer.from(`${marker}\n`).copy(content)
for (let offset = 1023; offset < content.byteLength; offset += 1024) content[offset] = 0x0a
const hash = createHash('sha256').update(content).digest('hex')
const fileName = 'attachment-recovery-fixture.txt'
const filePath = `/dsh/home/attachments/v1/files/${hash.slice(0, 2)}/${hash}/${fileName}`
const pageErrors = []
const browserRequests = []
const apiRequests = []
const uploadRequests = []
const uploadResponses = []
const requestFailures = []
let failUpload = true
let dropUploadResponse = true
let dropFileBlockAppend = true
let injectedUploadFailures = 0
let droppedUploadResponses = 0
let fileBlockAppendAttempts = 0
let app
let image
let browser
let context
let page
let cdp

function containsFileBlock(body) {
  return body.events?.some(event => event.type === 'user/message'
    && Array.isArray(event.data?.content)
    && event.data.content.some(block => block.type === 'file')) === true
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: {
      failAttachmentUpload: ({ name }) => {
        if (!failUpload || name !== fileName) return false
        failUpload = false
        injectedUploadFailures += 1
        return true
      },
      dropAttachmentUploadResponse: ({ name }) => {
        if (!dropUploadResponse || name !== fileName) return false
        dropUploadResponse = false
        droppedUploadResponses += 1
        return true
      },
      dropSessionAppendResponse: body => {
        if (!containsFileBlock(body)) return false
        fileBlockAppendAttempts += 1
        if (!dropFileBlockAppend) return false
        dropFileBlockAppend = false
        return true
      },
    },
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('response', response => {
    if (new URL(response.url()).pathname.includes('/workspace/attachments/')) {
      uploadResponses.push({ status: response.status(), url: response.url() })
    }
  })
  page.on('requestfailed', request => {
    if (new URL(request.url()).pathname.includes('/workspace/attachments/')) {
      requestFailures.push({ url: request.url(), error: request.failure()?.errorText })
    }
  })
  page.on('request', request => {
    const url = new URL(request.url())
    browserRequests.push({ url: request.url(), method: request.method() })
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    const captured = { path: url.pathname, body }
    apiRequests.push(captured)
    if (url.pathname.includes('/workspace/attachments/') && request.method() === 'PUT') {
      uploadRequests.push({ method: request.method(), name: url.searchParams.get('name') })
    }
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const prior = await page.evaluate(async () => {
    const identity = await (await fetch('/api/browser-native/workspace/identity')).json()
    const manifest = await (await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${identity.workspaceId}`)).json()
    return { workspaceId: identity.workspaceId, manifest }
  })

  cdp = await context.newCDPSession(page)
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 64 * 1024 })
  await page.locator('input[type="file"]').last().setInputFiles({
    name: fileName,
    mimeType: 'text/plain',
    buffer: content,
  })
  const retryName = `Retry uploading ${fileName}`
  await page.getByRole('button', { name: retryName }).waitFor({ timeout: 60_000 })
  assert.equal(uploadRequests.length, 0, 'OPFS quota failure must happen before a backend upload')
  assert.equal((await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).isDisabled()), true,
    'a failed file draft must block prompt submission')

  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1024 * 1024 * 1024 })
  await page.getByRole('button', { name: retryName }).click()
  await page.getByRole('button', { name: retryName }).waitFor({ timeout: 60_000 })
  assert.equal(uploadRequests.length, 1, 'the first backend attempt must be the injected 503')

  await page.getByRole('button', { name: retryName }).click()
  await page.getByRole('button', { name: retryName }).waitFor({ timeout: 20_000 }).catch(async error => {
    process.stderr.write(`${JSON.stringify({
      retryError: error.message,
      injectedUploadFailures,
      droppedUploadResponses,
      uploadRequests,
      uploadResponses,
      requestFailures,
      bodyText: (await page.locator('body').innerText()).slice(-2500),
      pageErrors,
    })}\n`)
    throw error
  })
  assert.equal(uploadRequests.length, 2, 'the second backend attempt publishes bytes and loses its response')

  await page.getByRole('button', { name: retryName }).click()
  await waitFor(async () => uploadRequests.length === 3 ? true : undefined,
    'content-addressed upload retry after response loss', 60_000)
  await waitFor(async () => uploadResponses.filter(response => response.status === 200).length >= 2 ? true : undefined,
    'successful response for the reused attachment object', 60_000)
  await page.getByText(fileName, { exact: true }).last().waitFor({ timeout: 60_000 })
  await page.getByText('TXT 256KB', { exact: true }).waitFor({ timeout: 60_000 })
  await page.getByRole('button', { name: retryName }).waitFor({ state: 'detached', timeout: 60_000 })
  assert.equal(uploadRequests.length, 3, 'the third backend attempt reuses the content-addressed object')
  const durableObjects = await page.evaluate(async () => {
    const identity = await (await fetch('/api/browser-native/workspace/identity')).json()
    return identity.workspaceId
  })
  assert.equal(durableObjects, prior.workspaceId)

  const result = await sendTurn({
    page,
    origin,
    requests: apiRequests,
    prompt: `BROWSER_NATIVE_ATTACHMENT_READ_E2E ${marker}: read ${filePath} with the standard read tool and report its content.`,
    marker: 'BROWSER_NATIVE_ATTACHMENT_READ_DONE',
    timeout: 120_000,
  })
  assert.equal(dropFileBlockAppend, false, 'the backend must accept the FileBlock append before dropping its response')
  assert.equal(fileBlockAppendAttempts, 1,
    'the unknown append must be reconciled by readback, not sent a second time')
  assert.equal(result.session.events.filter(event => event.type === 'user/message'
    && event.data.content?.some(block => block.type === 'file' && block.attachment.attachmentId === `sha256:${hash}`)).length, 1,
  'Session history must contain exactly one reference to the file')
  assert.equal(result.session.events.filter(event => event.type === 'user/message'
    && event.data.content?.some(block => block.type === 'text' && block.text.includes(marker))).length, 1,
  'the prompt must be appended exactly once')
  const reads = result.session.events.filter(event => event.type === 'tool/call'
    && event.data.turn === result.turn && event.data.name === 'read')
  assert.equal(reads.length, 1, 'the Agent turn must execute one standard read')
  const readResult = result.session.events.find(event => event.type === 'tool/result'
    && event.data.turn === result.turn && event.data.message?.toolCallId === reads[0].data.callId)
  assert.ok(readResult)
  assert.notEqual(readResult.data.message.isError, true)
  assert.match(readResult.data.message.content.map(block => block.text ?? '').join('\n'), new RegExp(marker))
  assert.match(assistantText(result.session, result.turn), /BROWSER_NATIVE_ATTACHMENT_READ_DONE/)

  const manifest = await page.evaluate(async workspaceId => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${workspaceId}`,
  )).json(), prior.workspaceId)
  assert.equal(manifest.revision, prior.manifest.revision)
  assert.deepEqual(manifest.entries, prior.manifest.entries)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(browserRequests.filter(request => new URL(request.url).origin !== origin), [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    browserVersion: browser.version(),
    uploadAttempts: uploadRequests.length,
    injectedUpload503: true,
    committedUploadResponseDropped: true,
    injectedUploadFailures,
    droppedUploadResponses,
    uploadResponses,
    requestFailures,
    contentAddressedRetry: true,
    droppedFileBlockAppendResponses: 1,
    fileBlockAppendAttempts,
    fileBlocks: 1,
    promptEvents: 1,
    readCalls: reads.length,
    workspaceRevision: manifest.revision,
    pageErrors,
  })}\n`)
} finally {
  await cdp?.detach().catch(() => {})
  await page?.close().catch(() => {})
  await context?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
