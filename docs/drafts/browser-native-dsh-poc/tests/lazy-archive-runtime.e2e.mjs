import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-lazy-archive-`))
const lazyPath = '/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js'
let image
let app
let browser
let page
let abortFirstArchive = true
const archiveRequests = []
const failedRequests = []
const pageErrors = []
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('requestfailed', request => failedRequests.push(new URL(request.url()).pathname))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.includes('/preview/lazy/')) archiveRequests.push(url.pathname)
  })
  await page.route('**/preview/lazy/*.tar.gz', async route => {
    if (!abortFirstArchive) return await route.continue()
    abortFirstArchive = false
    await route.abort('connectionreset')
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  const load = async () => await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'load-lazy-client-chunk', path,
  }), lazyPath)
  const first = await load()
  assert.equal(first?.ok, false, JSON.stringify(first))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const retry = await load()
  assert.equal(retry?.ok, true, JSON.stringify(retry))
  assert.equal(retry.path, lazyPath)
  assert.ok(retry.bytes > 0)
  assert.match(retry.digest, /^[0-9a-f]{64}$/)
  const cached = await load()
  assert.deepEqual({ ok: cached.ok, path: cached.path, bytes: cached.bytes, digest: cached.digest }, {
    ok: retry.ok, path: retry.path, bytes: retry.bytes, digest: retry.digest,
  })
  assert.equal(archiveRequests.length, 2, JSON.stringify(archiveRequests))
  assert.equal(archiveRequests[0], archiveRequests[1])
  assert.equal(failedRequests.length, 1, JSON.stringify(failedRequests))
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'worker-vfs-lazy-archive-fail-retry-cache',
    lazyPath,
    archivePath: archiveRequests[0],
    firstReadFailed: true,
    retryBytes: retry.bytes,
    retrySha256: retry.digest,
    archiveRequests: archiveRequests.length,
    cachedReadRefetched: false,
    pageErrors,
  })}\n`)
} finally {
  await page?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
