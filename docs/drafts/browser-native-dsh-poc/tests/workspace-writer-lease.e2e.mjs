import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-writer-lease-`))

let image
let app
let browser
let context
let page
let secondPage
const pageErrors = []
const nonLocalRequests = []
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
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

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  const firstLease = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
  assert.equal(firstLease?.ok, true, JSON.stringify(firstLease))
  assert.equal(typeof firstLease.writerToken, 'string')
  assert.equal(firstLease.fencingToken, 1)
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')

  const renewed = await page.evaluate(async ({ id, token, fencingToken }) => {
    const response = await fetch('/api/browser-native/workspace/lease', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        workspaceId: id,
        operation: 'renew',
        writerToken: token,
        fencingToken,
      }),
    })
    return { status: response.status, body: await response.json() }
  }, { id: workspaceId, token: firstLease.writerToken, fencingToken: firstLease.fencingToken })
  assert.equal(renewed.status, 200, JSON.stringify(renewed))

  await secondPage.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' })
  const blockedClaim = await secondPage.evaluate(async id => {
    const response = await fetch('/api/browser-native/workspace/lease', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), workspaceId: id, operation: 'claim' }),
    })
    return { status: response.status, body: await response.json() }
  }, workspaceId)
  assert.equal(blockedClaim.status, 409, JSON.stringify(blockedClaim))
  assert.equal(blockedClaim.body.error.code, 'WORKSPACE_ALREADY_OWNED')

  const released = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'release-lease' }))
  assert.equal(released?.ok, true, JSON.stringify(released))
  const secondLease = await secondPage.evaluate(async id => {
    const response = await fetch('/api/browser-native/workspace/lease', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), workspaceId: id, operation: 'claim' }),
    })
    return { status: response.status, body: await response.json() }
  }, workspaceId)
  assert.equal(secondLease.status, 200, JSON.stringify(secondLease))
  assert.equal(secondLease.body.fencingToken, 2)

  const staleRenew = await page.evaluate(async ({ id, token, fencingToken }) => {
    const response = await fetch('/api/browser-native/workspace/lease', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        workspaceId: id,
        operation: 'renew',
        writerToken: token,
        fencingToken,
      }),
    })
    return { status: response.status, body: await response.json() }
  }, { id: workspaceId, token: firstLease.writerToken, fencingToken: firstLease.fencingToken })
  assert.equal(staleRenew.status, 409, JSON.stringify(staleRenew))
  assert.equal(staleRenew.body.error.code, 'WORKSPACE_OWNERSHIP_LOST')

  const cleanup = await secondPage.evaluate(async ({ id, token, fencingToken }) => {
    const response = await fetch('/api/browser-native/workspace/lease', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        workspaceId: id,
        operation: 'release',
        writerToken: token,
        fencingToken,
      }),
    })
    return { status: response.status, body: await response.json() }
  }, { id: workspaceId, token: secondLease.body.writerToken, fencingToken: secondLease.body.fencingToken })
  assert.equal(cleanup.status, 200, JSON.stringify(cleanup))
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'Worker-backed-Workspace-writer-lease-and-fencing',
    workspaceId,
    firstFencingToken: firstLease.fencingToken,
    secondFencingToken: secondLease.body.fencingToken,
    blockedClaimStatus: blockedClaim.status,
    staleRenewStatus: staleRenew.status,
    pageErrors,
    nonLocalRequests,
  })}\n`)
} finally {
  await secondPage?.close()
  await page?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
