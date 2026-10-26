import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-control-payload-')))
const pageErrors = []
const workerErrors = []
const externalRequests = []
let image
let app
let browser
let page

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

async function readEvents() {
  return await page.evaluate(() => window.__dshBrowserControlEvents)
}

async function waitForReady() {
  await page.waitForFunction(() => window.__dshBrowserControlEvents?.ready.length > 0, undefined, { timeout: 30_000 })
  return (await readEvents()).ready.at(-1)
}

async function openFreshChannel(previousChannelId) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  const ready = await waitForReady()
  assert.notEqual(ready.channelId, previousChannelId)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  return ready
}

async function rejectFrameAndRecover(kind, expectedReason, previousChannelId) {
  const before = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
  const response = await testAction({ action: 'control-inject', controlInjection: kind })
  assert.equal(response?.ok, true)
  assert.equal(response?.controlInjection, kind)
  await page.waitForFunction(reason => window.__dshBrowserControlEvents?.invalid.some(event => event.reason === reason), expectedReason)
  const invalid = (await readEvents()).invalid
  assert.deepEqual(invalid, [{ reason: expectedReason }])
  assert.equal(JSON.stringify(invalid).includes('CONTROL_TEST_SECRET'), false)
  assert.equal(JSON.stringify(invalid).includes('x'.repeat(64)), false)
  assert.deepEqual(await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__), before)
  return await openFreshChannel(previousChannelId)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  await page.addInitScript(() => {
    window.__dshBrowserControlEvents = { ready: [], invalid: [] }
    window.addEventListener('dsh-browser-native-control-ready', event => {
      window.__dshBrowserControlEvents.ready.push(event.detail)
    })
    window.addEventListener('dsh-browser-native-control-invalid', event => {
      window.__dshBrowserControlEvents.invalid.push(event.detail)
    })
  })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== new URL(origin).origin) externalRequests.push(request.url())
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  let ready = await waitForReady()
  const initialChannelId = ready.channelId

  const maximumText = await testAction({ action: 'control-inject', controlInjection: 'max-text' })
  assert.equal(maximumText?.ok, true)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.message?.length === 4096)
  assert.deepEqual((await readEvents()).invalid, [])

  const failures = [
    ['oversized-text', 'CONTROL_FIELD_TOO_LARGE'],
    ['escaped-frame-overflow', 'CONTROL_FRAME_TOO_LARGE'],
    ['unknown-field', 'CONTROL_FRAME_INVALID'],
    ['unknown-notice', 'CONTROL_NOTICE_UNSUPPORTED'],
    ['cyclic-extra', 'CONTROL_FRAME_INVALID'],
  ]
  let previousChannelId = initialChannelId
  const recoveredChannelIds = []
  for (const [kind, reason] of failures) {
    ready = await rejectFrameAndRecover(kind, reason, previousChannelId)
    previousChannelId = ready.channelId
    recoveredChannelIds.push(ready.channelId)
  }

  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'control-frame-size-schema-cycle-rejection-and-refresh-recovery',
    acceptedTextBytes: 4096,
    rejectedFrames: failures.map(([kind, reason]) => ({ kind, reason })),
    initialChannelId,
    recoveredChannelIds,
    pageErrors,
    workerErrors,
    externalRequests,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
