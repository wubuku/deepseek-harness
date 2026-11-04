/**
 * Browser proof for same-machine process authentication.
 *
 * The preview URL carries a handshake token, the backend sets an HttpOnly
 * cookie and redirects to the token-free page URL, and the Worker keeps using
 * the split API origin through that cookie. Page JavaScript cannot read the
 * token or the cookie.
 */
import assert from 'node:assert/strict'
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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-local-auth-e2e-')))

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
    requireLocalAuth: true,
  })
  previewOrigin = await app.listen(0)
  const apiOrigin = app.apiOrigin
  assert.ok(typeof apiOrigin === 'string', 'split mode exposes the API origin')
  assert.equal(typeof app.authToken, 'string')

  const previewPath = '/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=cross-store&preview-fixture=none'
  const handshake = `${previewOrigin}/auth/handshake?token=${encodeURIComponent(app.authToken)}&next=${encodeURIComponent(previewPath)}`

  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', recorded => {
    const url = new URL(recorded.url())
    if (url.pathname.startsWith('/api/browser-native/')) apiRequests.push({ origin: url.origin, path: url.pathname })
  })
  await openPreview(page, handshake)
  await waitForPreview(page)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })

  const pageOrigin = await page.evaluate(() => globalThis.location.origin)
  assert.equal(pageOrigin, previewOrigin)
  const location = await page.evaluate(() => globalThis.location.href)
  assert.equal(new URL(location).pathname, '/preview.html', 'the handshake removed the token from the page URL')
  assert.equal(new URL(location).searchParams.get('token'), null)
  const visibleCookies = await page.evaluate(() => document.cookie)
  assert.equal(visibleCookies.includes('dsh-browser-native-auth'), false, 'the auth cookie is HttpOnly')

  const probe = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'cross-store-probe',
    path: '/dsh/home/workspace/local-auth.txt',
    content: 'local auth browser path proof\n',
  }))
  assert.equal(probe?.ok, true, JSON.stringify(probe))
  assert.equal(probe?.decision, 'reconciled', JSON.stringify(probe))
  assert.ok(apiRequests.every(recorded => recorded.origin === apiOrigin), JSON.stringify(apiRequests))
  assert.deepEqual(pageErrors, [])

  process.stdout.write('local-process-authentication-e2e: PASS\n')
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
