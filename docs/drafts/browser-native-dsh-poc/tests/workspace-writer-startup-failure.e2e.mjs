import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-writer-startup-failure-')))
const leaseDurationMs = 1_500
const leaseTraffic = []
const pageErrors = []
let image
let app
let browser
let context
let page
let origin
let workspaceId
let identityCookie
let claimAt
let manifestFailureInjected = false

async function postLease(operation, credentials = {}) {
  const response = await fetch(`${origin}/api/browser-native/workspace/lease`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: identityCookie },
    body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), workspaceId, operation, ...credentials }),
  })
  return { status: response.status, body: await response.json() }
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: { workspaceWriterLeaseMs: leaseDurationMs },
  })
  const openIdentity = app.workspaces.openIdentity.bind(app.workspaces)
  app.workspaces.openIdentity = async (...args) => {
    const identity = await openIdentity(...args)
    workspaceId = identity.workspaceId
    identityCookie = identity.cookie.split(';', 1)[0]
    return identity
  }
  const lease = app.workspaces.lease.bind(app.workspaces)
  app.workspaces.lease = async (request, body) => {
    leaseTraffic.push({ operation: body.operation, at: Date.now() })
    return await lease(request, body)
  }
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route(`${origin}/api/browser-native/workspace/manifest*`, async route => {
    if (manifestFailureInjected) {
      await route.continue()
      return
    }
    manifestFailureInjected = true
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'E2E_MANIFEST_FAILURE', message: 'injected Workspace manifest failure' } }),
    })
  })

  await page.goto(
    `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&preview-fixture=none`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'error',
    undefined, { timeout: 30_000 })
  assert.equal(manifestFailureInjected, true)
  const initialClaim = leaseTraffic.find(request => request.operation === 'claim')
  claimAt = initialClaim?.at
  assert.equal(claimAt !== undefined, true, JSON.stringify(leaseTraffic))
  assert.equal(typeof workspaceId, 'string')

  const acquired = await waitFor(async () => {
    const result = await postLease('claim')
    if (result.status === 409) return undefined
    return result
  }, 'writer lease expiry after failed Worker startup', leaseDurationMs * 5)
  assert.ok(Date.now() - claimAt >= leaseDurationMs - 100, `lease was claimed too early: ${Date.now() - claimAt}ms`)
  assert.equal(acquired.status, 200, JSON.stringify(acquired))

  const released = await postLease('release', {
    writerToken: acquired.body.writerToken,
    fencingToken: acquired.body.fencingToken,
  })
  assert.equal(released.status, 200, JSON.stringify(released))
  assert.deepEqual(leaseTraffic.filter(request => request.operation === 'renew'), [])
  assert.equal(pageErrors.length, 1, JSON.stringify(pageErrors))
  assert.match(pageErrors[0], /injected Workspace manifest failure/)
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'failed-Workspace-prepare-stops-lease-heartbeat',
    workspaceId,
    leaseDurationMs,
    competitorClaimStatus: acquired.status,
    elapsedFromOriginalClaimMs: Date.now() - claimAt,
    leaseTraffic: leaseTraffic.map(({ operation, status }) => ({ operation, status })),
    pageErrors,
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    workspaceId,
    leaseTraffic,
    pageText: page !== undefined && !page.isClosed() ? (await page.locator('body').innerText().catch(() => '')).slice(-2500) : undefined,
    pageErrors,
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
