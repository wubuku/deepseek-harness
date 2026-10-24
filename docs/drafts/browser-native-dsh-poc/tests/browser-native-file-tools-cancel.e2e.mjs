import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-file-tools-cancel-')))
const pageErrors = []
const workerErrors = []
const externalRequests = []
const requests = []
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
    const url = new URL(request.url())
    if (url.origin !== new URL(origin).origin) externalRequests.push(request.url())
    if (url.pathname.startsWith('/api/browser-native/')) {
      let body
      try { body = request.postDataJSON() } catch {}
      requests.push({ path: url.pathname, body })
    }
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  assert.deepEqual(await testAction({ action: 'set-file-tool-delay', delayMs: 100 }).then(result => ({ ok: result?.ok, delayMs: result?.delayMs })), { ok: true, delayMs: 100 })
  const generated = await testAction({
    action: 'write-pattern',
    path: '/dsh/home/workspace/cancel-search.txt',
    byteLength: 8 * 1024 * 1024,
    byteValue: 0x41,
    lineBytes: 4096,
    markerLine: 2,
    marker: 'BROWSER_NATIVE_GREP_CANCEL_TARGET',
  })
  assert.equal(generated?.ok, true, JSON.stringify(generated))
  assert.equal((await testAction({ action: 'flush-workspace' }))?.ok, true)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 120_000 })

  const canceled = await testAction({
    action: 'cancel-file-search',
    path: '/dsh/home/workspace/cancel-search.txt',
    marker: 'BROWSER_NATIVE_GREP_CANCEL_TARGET',
    delayMs: 1,
  })
  assert.equal(canceled?.ok, true, JSON.stringify(canceled))
  assert.equal(canceled?.canceled, true, JSON.stringify(canceled))

  const continued = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_GREP_CANCEL_E2E: search the large file after a canceled Worker search.',
    marker: 'BROWSER_NATIVE_GREP_CANCEL_COMPLETED',
    timeout: 120_000,
  })
  const calls = continued.session.events.filter(event => event.type === 'tool/call' && event.data.turn === continued.turn)
  assert.deepEqual(calls.map(event => event.data.name), ['grep'])
  assert.equal(assistantText(continued.session, continued.turn).includes('BROWSER_NATIVE_GREP_CANCEL_COMPLETED'), true)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'real-Chrome-Worker-grep-cancellation-and-follow-up',
    canceledWorkerSearch: canceled,
    continuedTurn: continued.turn,
    pageErrors,
    workerErrors,
    externalRequests,
  })}\n`)
} finally {
  await page?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
