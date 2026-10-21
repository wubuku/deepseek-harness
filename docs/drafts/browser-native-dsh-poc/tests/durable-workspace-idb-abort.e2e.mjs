import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitFor, waitForPreview } from './runtime-test-support.mjs'

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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-idb-abort-e2e-')))

async function readWorkspaceRecord(page, workspaceId) {
  return await page.evaluate(async id => await new Promise((resolveRecord, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1', 1)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('workspace', 'readonly')
      const get = transaction.objectStore('workspace').get(id)
      get.onerror = () => reject(get.error ?? new Error('IndexedDB read failed'))
      get.onsuccess = () => {
        database.close()
        resolveRecord(get.result ?? null)
      }
    }
  }), workspaceId)
}

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')

let image
let app
let browser
let page
let blobUploadResolve
const blobUploadSeen = new Promise(resolveBlobUpload => { blobUploadResolve = resolveBlobUpload })
const commits = []
const pageErrors = []
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(port)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/workspace/commit')) commits.push(request.postDataJSON())
  })
  await page.route(`${origin}/api/browser-native/workspace/blob/**`, async route => {
    if (route.request().method() !== 'PUT') {
      await route.continue()
      return
    }
    blobUploadResolve(true)
    await route.abort().catch(() => {})
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await waitForPreview(page)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId !== undefined, undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.workspaceId)

  const armed = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'abort-next-metadata-transaction',
  }))
  assert.equal(armed?.ok, true)
  const write = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write',
    path: '/dsh/home/workspace/transaction-abort.txt',
    content: 'IndexedDB transaction abort recovery\n',
  }))
  assert.equal(write?.ok, false)
  assert.match(write?.error ?? '', /abort/i)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'error', undefined, { timeout: 10_000 })

  await waitFor(() => blobUploadSeen, 'retry upload after the aborted IndexedDB transaction', 30_000)
  const localRecord = await readWorkspaceRecord(page, workspaceId)
  assert.equal(localRecord?.retryBatch?.changes.some(change => change.path === 'transaction-abort.txt'), true)
  assert.equal(commits.length, 0, 'a failed blob upload must not advance the Workspace manifest')
  const manifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(manifest.entries.some(entry => entry.path === 'transaction-abort.txt'), false)
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'Worker-OPFS-IndexedDB-transaction-abort',
    workspaceId,
    initialWriteError: write.error,
    localRetryBatchRetained: true,
    manifestCommitCount: commits.length,
    pageErrors,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
