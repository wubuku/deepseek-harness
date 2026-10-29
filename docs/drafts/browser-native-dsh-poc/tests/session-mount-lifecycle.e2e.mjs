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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-session-mount-')))
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

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url())
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-test=session-mount&preview-fixture=none`)
  await waitForPreview(page)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })

  const response = await testAction({ action: 'session-mount-probe' })
  assert.equal(response?.ok, true, JSON.stringify(response))
  assert.equal(response.sessionMount?.ok, true, JSON.stringify(response))
  assert.equal(response.sessionMount?.mountCount, 3)
  assert.equal(response.sessionMount?.detachedCount, 3)
  assert.equal(response.sessionMount?.parkedExecutionContinued, true)
  assert.equal(response.sessionMount?.duplicate, 'duplicate')
  assert.equal(response.sessionMount?.liveA, 'accepted')
  assert.equal(response.sessionMount?.liveB, 'accepted')
  assert.equal(response.sessionMount?.occupiedRejected, true)
  assert.equal(response.sessionMount?.busyRejected, true)
  assert.equal(response.sessionMount?.unavailableRejected, true)
  assert.equal(response.sessionMount?.reconnectedWorker, 'worker-2')
  assert.equal(response.sessionMount?.oldIdentityRejected, true)
  assert.equal(response.sessionMount?.newIdentityAccepted, 'accepted')
  assert.equal(response.sessionMount?.lateIgnored, true)
  assert.equal(response.sessionMount?.waitingUnknown, true)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'multi-session-mount-park-reconnect-owner-state-and-dispose',
    sessionMount: response.sessionMount,
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
