import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-offline-recovery-')))
const workspacePath = 'offline-retry.txt'
const content = `offline-workspace-${randomUUID()}\n`

async function readSnapshot(page, workspaceId) {
  return await page.evaluate(async id => await new Promise((resolveSnapshot, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1')
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('workspace', 'readonly')
      const get = transaction.objectStore('workspace').get(id)
      get.onerror = () => reject(get.error ?? new Error('IndexedDB read failed'))
      get.onsuccess = () => {
        database.close()
        resolveSnapshot(get.result ?? null)
      }
    }
  }), workspaceId)
}

let image
let app
let browser
let context
let page
const commitAttempts = []
const pageErrors = []
const nonLocalRequests = []
const failedRequests = []
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }))
  page.on('request', request => {
    if (new URL(request.url()).origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
  })
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    const body = route.request().postDataJSON()
    commitAttempts.push({ operationId: body.operationId, baseRevision: body.baseRevision })
    return await route.continue()
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')
  const remoteBeforeOffline = app.workspaces.workspaces.get(workspaceId)
  assert.equal(remoteBeforeOffline?.revision, 0)
  assert.equal(remoteBeforeOffline?.entries.has(workspacePath), false)

  await context.setOffline(true)
  const write = await page.evaluate(async input => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: `/dsh/home/workspace/${input.path}`, content: input.content,
  }), { path: workspacePath, content })
  assert.equal(write?.ok, true, JSON.stringify(write))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'error', undefined, { timeout: 30_000 })
  const offlineSnapshot = await readSnapshot(page, workspaceId)
  const retry = offlineSnapshot?.retryBatch
  assert.equal(retry?.changes?.[0]?.path, workspacePath)
  assert.equal(typeof retry.operationId, 'string')
  assert.equal(retry.baseRevision, 0)
  const localBlob = await page.evaluate(async ({ id, hash }) => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
    return await (await directory.getFileHandle(hash)).getFile().then(async file => ({ text: await file.text(), bytes: file.size }))
  }, { id: workspaceId, hash: retry.changes[0].contentHash })
  assert.deepEqual(localBlob, { text: content, bytes: Buffer.byteLength(content) })
  assert.notEqual((await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)).state, 'synced')
  const remoteWhileOffline = app.workspaces.workspaces.get(workspaceId)
  assert.equal(remoteWhileOffline?.revision, 0)
  assert.equal(remoteWhileOffline?.entries.has(workspacePath), false)
  const firstOperationId = retry.operationId

  await context.setOffline(false)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 30_000 })
  await waitFor(() => commitAttempts.length >= 1, 'offline operation retry after page refresh', 30_000)
  assert.equal(commitAttempts[0].operationId, firstOperationId)
  assert.equal(commitAttempts[0].baseRevision, 0)
  assert.equal(commitAttempts.length, 1)
  const manifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(manifest.revision, 1)
  assert.ok(manifest.entries.some(entry => entry.path === workspacePath))
  const recoveredSnapshot = await readSnapshot(page, workspaceId)
  assert.equal(recoveredSnapshot.retryBatch, undefined)
  assert.deepEqual(recoveredSnapshot.pending, [])
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'offline-durable-retry-and-refresh',
    workspaceId,
    operationId: firstOperationId,
    offlineCommitAttempts: commitAttempts.length > 1 ? commitAttempts.length - 1 : commitAttempts.length,
    commitAttempts: commitAttempts.length,
    finalRevision: manifest.revision,
    durableLocalRetry: true,
    failedRequestCount: failedRequests.length,
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
