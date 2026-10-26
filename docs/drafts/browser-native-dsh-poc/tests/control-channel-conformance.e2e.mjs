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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-control-channel-')))
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

async function readControlEvents() {
  return await page.evaluate(() => window.__dshBrowserControlEvents)
}

async function waitForControlReady() {
  await page.waitForFunction(() => window.__dshBrowserControlEvents?.ready.length > 0, undefined, { timeout: 30_000 })
  return (await readControlEvents()).ready.at(-1)
}

async function openControlPreview(origin) {
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  return await waitForControlReady()
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  await page.addInitScript(() => {
    window.__dshBrowserControlEvents = { ready: [], invalid: [] }
    window.addEventListener('dsh-browser-native-control-ready', event => {
      window.__dshBrowserControlEvents.ready.push(event.detail)
    })
    window.addEventListener('dsh-browser-native-control-invalid', event => {
      window.__dshBrowserControlEvents.invalid.push(event.detail.reason)
    })
  })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== new URL(origin).origin) externalRequests.push(request.url())
  })

  const firstReady = await openControlPreview(origin)
  assert.equal(firstReady.seq, 0)
  assert.equal(typeof firstReady.channelId, 'string')
  assert.deepEqual((await readControlEvents()).invalid, [])

  const duplicate = await testAction({ action: 'control-inject', controlInjection: 'duplicate' })
  assert.equal(duplicate?.ok, true)
  assert.equal(duplicate?.controlInjection, 'duplicate')

  const gap = await testAction({ action: 'control-inject', controlInjection: 'gap' })
  assert.equal(gap?.ok, true)
  assert.equal(gap?.controlInjection, 'gap')
  await page.waitForFunction(() => window.__dshBrowserControlEvents?.invalid.includes('CONTROL_SEQUENCE_GAP'))
  assert.deepEqual((await readControlEvents()).invalid, ['CONTROL_SEQUENCE_GAP'])

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  const secondReady = await waitForControlReady()
  assert.notEqual(secondReady.channelId, firstReady.channelId)
  assert.deepEqual((await readControlEvents()).invalid, [])

  const conflict = await testAction({ action: 'control-inject', controlInjection: 'conflict' })
  assert.equal(conflict?.ok, true)
  assert.equal(conflict?.controlInjection, 'conflict')
  await page.waitForFunction(() => window.__dshBrowserControlEvents?.invalid.includes('CONTROL_SEQUENCE_CONFLICT'))
  assert.deepEqual((await readControlEvents()).invalid, ['CONTROL_SEQUENCE_CONFLICT'])

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  const thirdReady = await waitForControlReady()
  assert.notEqual(thirdReady.channelId, secondReady.channelId)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  assert.deepEqual((await readControlEvents()).invalid, [])
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'control-ready-sequence-deduplication-gap-conflict-and-refresh',
    channelIds: [firstReady.channelId, secondReady.channelId, thirdReady.channelId],
    gapInvalid: 'CONTROL_SEQUENCE_GAP',
    conflictInvalid: 'CONTROL_SEQUENCE_CONFLICT',
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
