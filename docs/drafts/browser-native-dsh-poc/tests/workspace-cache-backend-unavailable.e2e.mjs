import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-cache-outage-')))
const workspacePath = '/dsh/home/workspace/cache-outage-anchor.txt'
const content = 'backend remains authoritative while browser cache is empty\n'
const databaseName = 'dsh-browser-native-workspace-v1'
const cookieName = 'dsh-browser-native-principal'
let image
let app
let browser
let context
let page
const pageErrors = []
const manifestFailures = []
const externalRequests = []

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url())
  })
  page.on('response', response => {
    if (response.url().includes('/api/browser-native/workspace/manifest')) {
      manifestFailures.push(response.status())
    }
  })

  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await openPreview(page, previewUrl)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const identity = await page.evaluate(async () => await (await fetch('/api/browser-native/workspace/identity')).json())
  const write = await page.evaluate(async ({ path, body }) => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path, content: body,
  }), { path: workspacePath, body: content })
  assert.equal(write?.ok, true, JSON.stringify(write))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  const cookieBefore = (await context.cookies()).find(cookie => cookie.name === cookieName)
  assert.ok(cookieBefore, 'the test identity cookie must exist before clearing browser storage')
  assert.equal(identity.workspaceId, await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId))

  await page.route(`${origin}/api/browser-native/workspace/manifest*`, async route => {
    return await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'INJECTED_BACKEND_UNAVAILABLE', message: 'injected manifest outage' } }),
    })
  })
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })))
  const cleared = await page.evaluate(async database => {
    const root = await navigator.storage.getDirectory()
    const opfs = []
    for await (const [name] of root.entries()) {
      await root.removeEntry(name, { recursive: true })
      opfs.push(name)
    }
    await new Promise((resolveDelete, rejectDelete) => {
      const request = indexedDB.deleteDatabase(database)
      request.onsuccess = () => resolveDelete(undefined)
      request.onerror = () => rejectDelete(request.error ?? new Error('IndexedDB delete failed'))
      request.onblocked = () => rejectDelete(new Error('IndexedDB deletion was blocked'))
    })
    return { opfs }
  }, databaseName)
  assert.ok(cleared.opfs.length > 0)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'error', undefined, { timeout: 30_000 })

  const status = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
  const identityAfterReset = await page.evaluate(async () => await (await fetch('/api/browser-native/workspace/identity')).json())
  const cookieAfter = (await context.cookies()).find(cookie => cookie.name === cookieName)
  assert.equal(identityAfterReset.workspaceId, identity.workspaceId, 'clearing OPFS/IndexedDB must retain the authenticated Workspace identity')
  assert.ok(cookieAfter, 'the identity cookie must survive the browser storage reset')
  assert.equal(status.workspaceId, identity.workspaceId)
  assert.notEqual(status.state, 'synced')
  assert.match(status.message ?? '', /503|outage|unavailable/i)
  assert.equal(status.state, 'error', 'an empty local VFS must remain unavailable while the backend cannot hydrate it')
  const visibleStatus = page.locator('[data-browser-native-workspace-status]')
  await visibleStatus.waitFor({ state: 'visible' })
  assert.equal(await visibleStatus.getAttribute('data-state'), 'error')
  assert.match(await visibleStatus.innerText(), /503|outage|unavailable/i)
  assert.deepEqual(manifestFailures, [200, 503])
  assert.equal(pageErrors.length, 1, `expected one preview boot rejection after the injected 503: ${JSON.stringify(pageErrors)}`)
  assert.match(pageErrors[0], /boot payload failed with HTTP 503/)
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'cleared-OPFS-IndexedDB-backend-manifest-outage-fail-closed',
    workspaceId: identity.workspaceId,
    cookieRetained: true,
    removedOpfsEntries: cleared.opfs.length,
    manifestStatuses: manifestFailures,
    finalWorkspaceState: status.state,
    errorMessage: status.message,
    noEmptyWorkspaceReportedAsSynced: true,
    pageErrors,
    externalRequests,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
