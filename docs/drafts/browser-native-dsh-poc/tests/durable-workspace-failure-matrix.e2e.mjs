import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-failure-matrix-`))

async function browserStorageSnapshot(page, workspaceId) {
  return await page.evaluate(async id => {
    return await new Promise((resolve, reject) => {
      const request = indexedDB.open('dsh-browser-native-workspace-v1', 1)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('workspace', 'readonly')
        const get = transaction.objectStore('workspace').get(id)
        get.onerror = () => reject(get.error ?? new Error('IndexedDB read failed'))
        get.onsuccess = () => {
          database.close()
          resolve(get.result ?? null)
        }
      }
    })
  }, workspaceId)
}

let image
let app
let browser
let page
const pageErrors = []
const nonLocalRequests = []
const failedRequests = []
const requestedUrls = []
const uploads = []
const commits = []
const operationQueries = []
let failFirstUpload = true
let abortSecondCommitResponse = true
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), failure: request.failure()?.errorText }))
  page.on('request', request => requestedUrls.push({ method: request.method(), url: request.url() }))
  page.on('request', request => {
    if (new URL(request.url()).origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
  })
  await page.route(`${origin}/api/browser-native/workspace/blob/*`, async route => {
    if (route.request().method() !== 'PUT') return await route.continue()
    uploads.push(route.request().url())
    if (failFirstUpload) {
      failFirstUpload = false
      return await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ protocolVersion: 1, error: { code: 'TEST_UPLOAD_BLOCKED', message: 'upload blocked by failure matrix E2E' } }),
      })
    }
    return await route.continue()
  })
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    const body = route.request().postDataJSON()
    commits.push({ operationId: body.operationId, baseRevision: body.baseRevision })
    if (commits.length === 2 && abortSecondCommitResponse) {
      abortSecondCommitResponse = false
      const response = await route.fetch()
      assert.equal(response.ok(), true)
      return await route.abort('connectionreset')
    }
    return await route.continue()
  })
  await page.route(`${origin}/api/browser-native/workspace/operation/*`, async route => {
    operationQueries.push(route.request().url())
    return await route.continue()
  })

  const url = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await openPreview(page, url)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId !== undefined, undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')

  const uploadFailureWrite = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: '/dsh/home/workspace/upload-retry.txt', content: 'upload retry survives\n',
  }))
  assert.equal(uploadFailureWrite?.ok, true, JSON.stringify(uploadFailureWrite))
  await waitFor(() => uploads.length >= 1, 'first injected blob upload failure', 30_000)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'error', undefined, { timeout: 30_000 })
  const uploadRecovery = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
  assert.equal(uploadRecovery?.ok, true, JSON.stringify(uploadRecovery))
  assert.equal(uploads.length, 2)
  assert.equal(commits.length, 1)

  const unknownWrite = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: '/dsh/home/workspace/unknown-commit.txt', content: 'commit result was unknown\n',
  }))
  assert.equal(unknownWrite?.ok, true, JSON.stringify(unknownWrite))
  try {
    await waitFor(() => operationQueries.length >= 1, 'operation lookup after ambiguous commit response', 30_000)
  } catch (error) {
    throw new Error(`${error.message}; commits=${JSON.stringify(commits)}; failedRequests=${JSON.stringify(failedRequests)}; requested=${JSON.stringify(requestedUrls.filter(item => item.url.includes('/workspace/')))}; status=${JSON.stringify(await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__))}`)
  }
  const unknownRecovery = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
  assert.equal(unknownRecovery?.ok, true, JSON.stringify(unknownRecovery))
  assert.equal(commits.length, 2)
  assert.notEqual(commits[1].operationId, commits[0].operationId)
  assert.equal(operationQueries.some(url => url.includes(commits[1].operationId)), true)
  const storage = await browserStorageSnapshot(page, workspaceId)
  assert.deepEqual(storage?.pending, [])
  assert.equal(storage?.retryBatch, undefined)
  const manifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.deepEqual(
    manifest.entries.filter(entry => entry.path.endsWith('.txt')).map(entry => entry.path).sort(),
    ['unknown-commit.txt', 'upload-retry.txt'],
  )
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'Workspace-upload-failure-and-commit-unknown',
    workspaceId,
    uploadAttempts: uploads.length,
    commitAttempts: commits.length,
    operationLookups: operationQueries.length,
    revision: manifest.revision,
    pageErrors,
    nonLocalRequests,
  })}\n`)
} finally {
  await page?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
