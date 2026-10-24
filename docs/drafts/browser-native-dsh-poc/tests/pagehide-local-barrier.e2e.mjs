import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-pagehide-')))

async function readRecord(page, workspaceId) {
  return await page.evaluate(async id => await new Promise((resolveRecord, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1', 1)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('workspace', 'readonly')
      const get = transaction.objectStore('workspace').get(id)
      get.onerror = () => reject(get.error ?? new Error('IndexedDB read failed'))
      get.onsuccess = () => { database.close(); resolveRecord(get.result ?? null) }
    }
  }), workspaceId)
}

let image
let app
let browser
let page
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted', ownerLeaseMs: 5_000 })
  const origin = await app.listen(Number(process.env.DSH_POC_PORT ?? '0'))
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.workspaceId)
  const armed = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'pause-local-save', stage: 'after',
  }))
  assert.equal(armed?.ok, true, JSON.stringify(armed))
  const writePromise = page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: '/dsh/home/workspace/pagehide.txt', content: 'pagehide local barrier\n',
  }))
  await page.waitForFunction(async () => (await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'local-save-state' }))?.stage === 'after', undefined, { timeout: 30_000 })
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })))
  await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  const stillAlive = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'local-save-state' }))
  assert.equal(stillAlive?.stage, 'after', JSON.stringify(stillAlive))
  await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'release-local-save' }))
  const write = await writePromise
  assert.equal(write?.ok, true, JSON.stringify(write))
  const beforeReload = await readRecord(page, workspaceId)
  assert.ok(beforeReload.pending.some(change => change.path === 'pagehide.txt')
    || beforeReload.retryBatch?.changes.some(change => change.path === 'pagehide.txt'), JSON.stringify(beforeReload))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const restored = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'read', path: '/dsh/home/workspace/pagehide.txt',
  }))
  assert.deepEqual({ ok: restored?.ok, content: restored?.content }, { ok: true, content: 'pagehide local barrier\n' })
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
  await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  const bfcacheWorkerStillAlive = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'usage' }))
  assert.equal(bfcacheWorkerStillAlive?.ok, true, JSON.stringify(bfcacheWorkerStillAlive))
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'pagehide-local-persistence-barrier',
    workspaceId,
    localSnapshotRetained: true,
    bfcacheWorkerPreserved: true,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
