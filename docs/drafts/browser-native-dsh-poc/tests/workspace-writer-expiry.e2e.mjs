import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-writer-expiry-')))
const leaseDurationMs = 1_200

async function leaseRequest(page, workspaceId, operation, lease) {
  return await page.evaluate(async ({ id, action, credentials, requestId }) => {
    const response = await fetch('/api/browser-native/workspace/lease', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: requestId,
        workspaceId: id,
        operation: action,
        ...credentials,
      }),
    })
    return { status: response.status, body: await response.json() }
  }, { id: workspaceId, action: operation, credentials: lease ?? {}, requestId: randomUUID() })
}

let image
let app
let browser
let context
let page
let secondPage
const leaseTraffic = []
const pageErrors = []
const nonLocalRequests = []
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: { workspaceWriterLeaseMs: leaseDurationMs },
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  secondPage = await context.newPage()
  for (const currentPage of [page, secondPage]) {
    currentPage.on('pageerror', error => pageErrors.push(error.message))
    currentPage.on('request', request => {
      if (new URL(request.url()).origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
      if (request.url().endsWith('/api/browser-native/workspace/lease')) {
        leaseTraffic.push({ operation: request.postDataJSON()?.operation })
      }
    })
    currentPage.on('response', response => {
      if (response.url().endsWith('/api/browser-native/workspace/lease')) {
        const request = response.request()
        const item = leaseTraffic.findLast(entry => entry.operation === request.postDataJSON()?.operation && entry.status === undefined)
        if (item !== undefined) item.status = response.status()
      }
    })
  }

  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await page.goto(previewUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const firstLease = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
  assert.equal(firstLease?.ok, true, JSON.stringify(firstLease))
  assert.equal(firstLease.fencingToken, 1)
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')
  const savedLease = await page.evaluate(id => {
    const key = `dsh.browser-native.workspace-lease.${encodeURIComponent(id)}`
    return JSON.parse(sessionStorage.getItem(key) ?? 'null')
  }, workspaceId)
  assert.equal(savedLease.writerToken, firstLease.writerToken)
  assert.equal(savedLease.fencingToken, firstLease.fencingToken)
  assert.equal(typeof savedLease.resumeId, 'string')

  await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' })
  await secondPage.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' })
  const claim = await waitFor(async () => {
    const result = await leaseRequest(secondPage, workspaceId, 'claim')
    if (result.status === 200) return result
    assert.equal(result.status, 409, JSON.stringify(result))
    assert.equal(result.body.error.code, 'WORKSPACE_ALREADY_OWNED')
    return undefined
  }, 'lease expiry and second-tab claim', 15_000)
  const secondLease = claim.body
  assert.equal(secondLease.fencingToken, 2)
  assert.ok(secondLease.leaseDurationMs === leaseDurationMs)

  await page.goto(previewUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'error', undefined, { timeout: 30_000 })
  const staleResume = leaseTraffic.find(item => item.operation === 'resume' && item.status === 409)
  const blockedOldTabClaim = leaseTraffic.find(item => item.operation === 'claim' && item.status === 409)
  assert.ok(staleResume, JSON.stringify(leaseTraffic))
  assert.ok(blockedOldTabClaim, JSON.stringify(leaseTraffic))
  const clearedCredentials = await page.evaluate(id => sessionStorage.getItem(
    `dsh.browser-native.workspace-lease.${encodeURIComponent(id)}`,
  ), workspaceId)
  assert.equal(clearedCredentials, null)

  const staleRenew = await leaseRequest(page, workspaceId, 'renew', {
    writerToken: firstLease.writerToken,
    fencingToken: firstLease.fencingToken,
  })
  assert.equal(staleRenew.status, 409, JSON.stringify(staleRenew))
  assert.equal(staleRenew.body.error.code, 'WORKSPACE_OWNERSHIP_LOST')
  const staleCommit = await page.evaluate(async ({ id, writerToken, fencingToken, requestId, operationId }) => {
    const response = await fetch('/api/browser-native/workspace/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId,
        workspaceId: id,
        baseRevision: 0,
        operationId,
        changes: [{ path: 'workspace/stale.txt', deleted: true }],
        writerToken,
        fencingToken,
      }),
    })
    return { status: response.status, body: await response.json() }
  }, {
    id: workspaceId,
    writerToken: firstLease.writerToken,
    fencingToken: firstLease.fencingToken,
    requestId: randomUUID(),
    operationId: randomUUID(),
  })
  assert.equal(staleCommit.status, 409, JSON.stringify(staleCommit))
  assert.equal(staleCommit.body.error.code, 'WORKSPACE_OWNERSHIP_LOST')

  const released = await leaseRequest(secondPage, workspaceId, 'release', {
    writerToken: secondLease.writerToken,
    fencingToken: secondLease.fencingToken,
  })
  assert.equal(released.status, 200, JSON.stringify(released))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const reclaimed = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
  assert.equal(reclaimed?.ok, true, JSON.stringify(reclaimed))
  assert.equal(reclaimed.fencingToken, 3)
  assert.ok(reclaimed.fencingToken > secondLease.fencingToken)
  assert.deepEqual(pageErrors, [
    'web-preview tunnel: boot payload failed with HTTP 503: Error: Workspace is already owned by another browser writer',
  ])
  assert.deepEqual(nonLocalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'expired-writer-lease-takeover-and-stale-tab-fencing',
    workspaceId,
    leaseDurationMs,
    firstFencingToken: firstLease.fencingToken,
    secondFencingToken: secondLease.fencingToken,
    reclaimedFencingToken: reclaimed.fencingToken,
    staleResumeRejected: true,
    staleRenewStatus: staleRenew.status,
    staleCommitStatus: staleCommit.status,
    staleTabBootRejected: true,
    expectedPageErrors: pageErrors,
    leaseOperations: leaseTraffic.map(({ operation, status }) => ({ operation, status })),
    pageErrors,
    nonLocalRequests,
  })}\n`)
} finally {
  await secondPage?.close().catch(() => {})
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
