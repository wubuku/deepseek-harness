import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
const port = Number(process.env.DSH_POC_PORT ?? '0')
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-lifecycle-e2e-')))

async function readRecord(page, workspaceId) {
  return await page.evaluate(async id => await new Promise((resolveRecord, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1')
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
const commits = []
let firstCommit = true
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(port)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    const body = route.request().postDataJSON()
    commits.push({ operationId: body.operationId, baseRevision: body.baseRevision })
    if (firstCommit) {
      firstCommit = false
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ protocolVersion: 1, error: { code: 'TEST_LIFECYCLE_INTERRUPTION', message: 'commit interrupted before response' } }),
      })
      return
    }
    await route.continue()
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId !== undefined, undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.workspaceId)
  const write = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: '/dsh/home/workspace/lifecycle.txt', content: 'survive worker termination\n',
  }))
  assert.equal(write?.ok, true, JSON.stringify(write))
  await waitFor(async () => {
    const record = await readRecord(page, workspaceId)
    return commits.length === 1 && record?.retryBatch?.operationId === commits[0].operationId
  }, 'interrupted commit durable snapshot', 30_000)
  const firstOperationId = commits[0].operationId
  const firstRevision = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.revision)

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 30_000 })
  await waitFor(() => commits.length >= 2, 'post-termination retry commit', 30_000)
  assert.equal(commits[1].operationId, firstOperationId)
  assert.equal(commits[1].baseRevision, firstRevision)
  const restored = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'read', path: '/dsh/home/workspace/lifecycle.txt',
  }))
  assert.deepEqual(
    { ok: restored?.ok, path: restored?.path, content: restored?.content },
    { ok: true, path: '/dsh/home/workspace/lifecycle.txt', content: 'survive worker termination\n' },
  )
  const finalRecord = await readRecord(page, workspaceId)
  assert.equal(finalRecord.retryBatch, undefined)
  assert.deepEqual(finalRecord.pending, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'Worker-termination-and-retry-recovery',
    workspaceId,
    operationId: firstOperationId,
    commitAttempts: commits.length,
    revision: await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.revision),
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
