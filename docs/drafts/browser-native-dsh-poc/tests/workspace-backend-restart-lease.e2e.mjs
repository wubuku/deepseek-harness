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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-lease-restart-')))
const workspacePath = 'restart-lease.txt'
const content = `restart-lease-${randomUUID()}\n`

let image
let app
let browser
let context
let page
const commits = []
const pageErrors = []
const nonLocalRequests = []
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  const port = Number(new URL(origin).port)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
    if (request.url().endsWith('/api/browser-native/workspace/commit')) commits.push(request.postDataJSON())
  })

  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await openPreview(page, previewUrl)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')
  const firstLease = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
  assert.equal(firstLease?.ok, true, JSON.stringify(firstLease))
  assert.equal(firstLease.fencingToken, 1)

  const write = await page.evaluate(async input => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: `/dsh/home/workspace/${input.path}`, content: input.content,
  }), { path: workspacePath, content })
  assert.equal(write?.ok, true, JSON.stringify(write))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  assert.equal(commits.length, 1)
  const originalOperationId = commits[0].operationId

  await app.close()
  app = undefined
  await page.goto('about:blank', { waitUntil: 'domcontentloaded' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const restartedOrigin = await app.listen(port)
  assert.equal(restartedOrigin, origin)

  await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' })
  const staleRenew = await page.evaluate(async ({ id, writerToken, fencingToken }) => {
    const response = await fetch('/api/browser-native/workspace/lease', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        workspaceId: id,
        operation: 'renew',
        writerToken,
        fencingToken,
      }),
    })
    return { status: response.status, body: await response.json() }
  }, { id: workspaceId, writerToken: firstLease.writerToken, fencingToken: firstLease.fencingToken })
  assert.equal(staleRenew.status, 409, JSON.stringify(staleRenew))
  assert.equal(staleRenew.body.error.code, 'WORKSPACE_OWNERSHIP_LOST')

  await openPreview(page, previewUrl)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  const recoveredLease = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
  assert.equal(recoveredLease?.ok, true, JSON.stringify(recoveredLease))
  assert.equal(recoveredLease.fencingToken, 2)
  const recoveredFile = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'read', path }), `/dsh/home/workspace/${workspacePath}`)
  assert.deepEqual({ ok: recoveredFile?.ok, content: recoveredFile?.content }, { ok: true, content })
  assert.equal(commits.length, 1, 'refresh after backend restart must not replay the completed operation')
  assert.equal(commits[0].operationId, originalOperationId)
  assert.equal(app.workspaces.workspaces.get(workspaceId)?.revision, 1)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'backend-restart-persisted-workspace-and-lease-fencing',
    workspaceId,
    revisionAfterRestart: app.workspaces.workspaces.get(workspaceId)?.revision,
    oldFencingToken: firstLease.fencingToken,
    recoveredFencingToken: recoveredLease.fencingToken,
    staleRenewStatus: staleRenew.status,
    commitCount: commits.length,
    originalOperationId,
    pageErrors,
    nonLocalRequests,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
