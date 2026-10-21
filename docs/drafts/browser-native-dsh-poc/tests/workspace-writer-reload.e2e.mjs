import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const port = Number(process.env.DSH_POC_PORT ?? '0')
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-writer-reload-')))
const leaseStoragePrefix = 'dsh.browser-native.workspace-lease.'

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')

let image
let app
let browser
let context
let page
let secondPage
const pageErrors = []
const nonLocalRequests = []
const resumeRequests = []
let abortFirstResumeResponse = true
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(port)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  secondPage = await context.newPage()
  for (const currentPage of [page, secondPage]) {
    currentPage.on('pageerror', error => pageErrors.push(error.message))
    currentPage.on('request', request => {
      if (new URL(request.url()).origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
    })
  }

  await page.route(`${origin}/api/browser-native/workspace/lease`, async route => {
    const body = route.request().postDataJSON()
    if (body.operation !== 'resume') return await route.continue()
    resumeRequests.push({ requestId: body.requestId, resumeId: body.resumeId })
    if (abortFirstResumeResponse) {
      abortFirstResumeResponse = false
      const response = await route.fetch()
      assert.equal(response.ok(), true)
      return await route.abort('connectionreset')
    }
    return await route.continue()
  })

  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await openPreview(page, previewUrl)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const firstLease = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
  assert.equal(firstLease?.ok, true, JSON.stringify(firstLease))
  assert.equal(firstLease.fencingToken, 1)
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')
  const storageKey = `${leaseStoragePrefix}${encodeURIComponent(workspaceId)}`
  const savedLease = await page.waitForFunction(key => {
    const value = window.sessionStorage.getItem(key)
    return value === null ? undefined : JSON.parse(value)
  }, storageKey)
  const savedLeaseValue = await savedLease.jsonValue()
  assert.equal(savedLeaseValue.workspaceId, workspaceId)
  assert.equal(savedLeaseValue.writerToken, firstLease.writerToken)
  assert.equal(savedLeaseValue.fencingToken, firstLease.fencingToken)
  assert.match(savedLeaseValue.resumeId, /^[0-9a-f-]{36}$/i)

  await secondPage.goto(`${origin}/api/browser-native/health`, { waitUntil: 'domcontentloaded' })
  const blockedClaim = await secondPage.evaluate(async id => {
    const response = await fetch('/api/browser-native/workspace/lease', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), workspaceId: id, operation: 'claim' }),
    })
    return { status: response.status, body: await response.json() }
  }, workspaceId)
  assert.equal(blockedClaim.status, 409)
  assert.equal(blockedClaim.body.error.code, 'WORKSPACE_ALREADY_OWNED')

  await page.evaluate(key => {
    const lease = JSON.parse(window.sessionStorage.getItem(key) ?? '{}')
    delete lease.resumeId
    window.sessionStorage.setItem(key, JSON.stringify(lease))
  }, storageKey)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const resumedLease = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
  assert.equal(resumedLease?.ok, true, JSON.stringify(resumedLease))
  assert.equal(resumedLease.fencingToken, firstLease.fencingToken + 1)
  assert.notEqual(resumedLease.writerToken, firstLease.writerToken)
  assert.equal(resumeRequests.length, 2)
  assert.match(resumeRequests[0].resumeId, /^[0-9a-f-]{36}$/i)
  assert.notEqual(resumeRequests[0].resumeId, savedLeaseValue.resumeId)
  assert.equal(resumeRequests[1].resumeId, resumeRequests[0].resumeId)
  assert.notEqual(resumeRequests[0].requestId, resumeRequests[1].requestId)

  const staleRenew = await page.evaluate(async ({ id, lease }) => {
    const response = await fetch('/api/browser-native/workspace/lease', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        workspaceId: id,
        operation: 'renew',
        writerToken: lease.writerToken,
        fencingToken: lease.fencingToken,
      }),
    })
    return { status: response.status, body: await response.json() }
  }, { id: workspaceId, lease: firstLease })
  assert.equal(staleRenew.status, 409)
  assert.equal(staleRenew.body.error.code, 'WORKSPACE_OWNERSHIP_LOST')

  const staleCommit = await page.evaluate(async ({ id, lease, operationId }) => {
    const response = await fetch('/api/browser-native/workspace/commit', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        workspaceId: id,
        operationId,
        baseRevision: 0,
        changes: [{ path: 'stale-token-probe', kind: 'directory', mode: 493 }],
        writerToken: lease.writerToken,
        fencingToken: lease.fencingToken,
      }),
    })
    return { status: response.status, body: await response.json() }
  }, { id: workspaceId, lease: firstLease, operationId: randomUUID() })
  assert.equal(staleCommit.status, 409, JSON.stringify(staleCommit))
  assert.equal(staleCommit.body.error.code, 'WORKSPACE_OWNERSHIP_LOST')

  const secondClaim = await secondPage.evaluate(async id => {
    const response = await fetch('/api/browser-native/workspace/lease', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), workspaceId: id, operation: 'claim' }),
    })
    return { status: response.status, body: await response.json() }
  }, workspaceId)
  assert.equal(secondClaim.status, 409)
  assert.equal(secondClaim.body.error.code, 'WORKSPACE_ALREADY_OWNED')

  const release = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'release-lease' }))
  assert.equal(release?.ok, true)
  await page.waitForFunction(key => window.sessionStorage.getItem(key) === null, storageKey)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'same-tab-reload-Workspace-lease-resume-and-fencing',
    workspaceId,
    firstFencingToken: firstLease.fencingToken,
    resumedFencingToken: resumedLease.fencingToken,
    tokenRotated: resumedLease.writerToken !== firstLease.writerToken,
    droppedResumeResponseRetried: resumeRequests.length === 2,
    stableResumeId: resumeRequests[0].resumeId === resumeRequests[1].resumeId,
    resumeEpochAdvancedOnce: resumedLease.fencingToken === firstLease.fencingToken + 1,
    firstSecondTabClaimStatus: blockedClaim.status,
    staleRenewStatus: staleRenew.status,
    staleCommitStatus: staleCommit.status,
    secondTabAfterResumeStatus: secondClaim.status,
    sessionStorageClearedAfterRelease: true,
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
