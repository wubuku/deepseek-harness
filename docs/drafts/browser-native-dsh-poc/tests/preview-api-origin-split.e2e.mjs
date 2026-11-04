import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-preview-api-origin-e2e-')))

/** Issue one HTTP request and return its status, JSON body, and response headers. */
async function httpRequest(origin, path, init = {}) {
  const url = new URL(path, origin)
  return await new Promise((resolveRequest, reject) => {
    const call = request(url, { method: init.method ?? 'GET', headers: init.headers ?? {} }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body
        try { body = JSON.parse(text) } catch { body = undefined }
        resolveRequest({ status: response.statusCode, headers: response.headers, body, text })
      })
    })
    call.on('error', reject)
    call.end()
  })
}

let image
let app
let browser
let context
let page
let previewOrigin
const pageErrors = []
const apiRequests = []

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    apiPort: 0,
  })
  previewOrigin = await app.listen(0)
  const apiOrigin = app.apiOrigin
  assert.ok(typeof apiOrigin === 'string', 'split mode exposes the API origin')
  assert.notEqual(new URL(apiOrigin).origin, new URL(previewOrigin).origin, 'API and preview use different origins')

  const discovery = await httpRequest(previewOrigin, '/preview-api-origin')
  assert.equal(discovery.status, 200)
  assert.equal(discovery.body?.origin, apiOrigin)
  assert.equal(discovery.headers['cache-control'], 'no-store')

  const allowed = await httpRequest(apiOrigin, '/api/browser-native/health', {
    headers: { origin: previewOrigin },
  })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.headers['access-control-allow-origin'], previewOrigin)
  assert.equal(allowed.headers['access-control-allow-credentials'], 'true')

  const refused = await httpRequest(apiOrigin, '/api/browser-native/health', {
    headers: { origin: 'https://evil.invalid' },
  })
  assert.equal(refused.status, 403)
  assert.equal(refused.headers['access-control-allow-origin'], undefined)

  const preflight = await httpRequest(apiOrigin, '/api/browser-native/session/read', {
    method: 'OPTIONS',
    headers: {
      origin: previewOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers['access-control-allow-origin'], previewOrigin)
  assert.match(String(preflight.headers['access-control-allow-headers']), /content-type/)

  const previewApi = await httpRequest(previewOrigin, '/api/browser-native/health')
  assert.equal(previewApi.status, 404, 'the preview listener does not serve API routes')

  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', recorded => {
    const url = new URL(recorded.url())
    if (url.pathname.startsWith('/api/browser-native/')) apiRequests.push({ origin: url.origin, path: url.pathname })
  })
  await openPreview(page, `${previewOrigin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=cross-store&preview-fixture=none`)
  await waitForPreview(page)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })

  const pageOrigin = await page.evaluate(() => globalThis.location.origin)
  assert.equal(pageOrigin, previewOrigin)

  const pageFetch = await page.evaluate(async origin => {
    const response = await fetch(`${origin}/api/browser-native/health`, { credentials: 'include' })
    return { ok: response.ok, status: response.status }
  }, apiOrigin)
  assert.equal(pageFetch.ok, true, 'the preview page reads the allowlisted API origin')

  const probe = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'cross-store-probe',
    path: '/dsh/home/workspace/origin-split.txt',
    content: 'origin split browser path proof\n',
  }))
  assert.equal(probe?.ok, true, JSON.stringify(probe))
  assert.equal(probe?.decision, 'reconciled', JSON.stringify(probe))
  assert.ok(apiRequests.every(recorded => recorded.origin === apiOrigin), JSON.stringify(apiRequests))
  assert.ok(apiRequests.some(recorded => recorded.path === '/api/browser-native/workspace/identity'))
  assert.deepEqual(pageErrors, [])

  process.stdout.write('preview-api-origin-split: PASS\n')
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    previewOrigin,
    apiOrigin: app?.apiOrigin,
    pageErrors,
    apiRequests,
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
