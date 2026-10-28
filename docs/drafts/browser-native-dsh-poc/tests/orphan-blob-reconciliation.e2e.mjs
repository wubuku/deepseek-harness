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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-orphan-')))

async function listLocalBlobs(page, workspaceId) {
  return await page.evaluate(async id => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
    const entries = []
    for await (const [name, entry] of directory.entries()) {
      if (entry.kind === 'file') entries.push({ name, bytes: (await entry.getFile()).size })
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name))
  }, workspaceId)
}

async function readRecord(page, workspaceId) {
  return await page.evaluate(async id => await new Promise((resolveRecord, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1')
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
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(Number(process.env.DSH_POC_PORT ?? '0'))
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.workspaceId)
  const baseline = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: '/dsh/home/workspace/retained.txt', content: 'retained blob\n',
  }))
  assert.equal(baseline?.ok, true, JSON.stringify(baseline))
  const baselineCommit = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
  assert.equal(baselineCommit?.ok, true, JSON.stringify(baselineCommit))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  const retained = (await listLocalBlobs(page, workspaceId))[0]
  assert.ok(retained)
  const oldRecord = await readRecord(page, workspaceId)
  assert.equal(oldRecord.pending.length, 0)

  const armed = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'abort-next-metadata-transaction',
  }))
  assert.equal(armed?.ok, true)
  const failed = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: '/dsh/home/workspace/orphan.txt', content: 'orphan bytes\n',
  }))
  assert.equal(failed?.ok, false, JSON.stringify(failed))
  assert.match(failed.error, /abort/i)
  const orphaned = await listLocalBlobs(page, workspaceId)
  assert.equal(orphaned.length, 2, JSON.stringify(orphaned))
  const orphan = orphaned.find(item => item.name !== retained.name)
  assert.ok(orphan)
  const validMetadata = await readRecord(page, workspaceId)
  assert.deepEqual(validMetadata.pending, [])
  assert.equal(validMetadata.retryBatch, undefined)

  assert.equal((await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'close-vfs' }))).ok, true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const reconciled = await listLocalBlobs(page, workspaceId)
  assert.deepEqual(reconciled, [retained])

  await page.evaluate(async id => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1')
    await new Promise((resolveRequest, rejectRequest) => {
      request.onerror = () => rejectRequest(request.error ?? new Error('IndexedDB open failed'))
      request.onsuccess = () => resolveRequest(request.result)
    }).then(database => {
      const transaction = database.transaction('workspace', 'readwrite')
      transaction.objectStore('workspace').delete(id)
      return new Promise((resolveDelete, rejectDelete) => {
        transaction.oncomplete = resolveDelete
        transaction.onerror = () => rejectDelete(transaction.error)
        transaction.onabort = () => rejectDelete(transaction.error ?? new Error('delete aborted'))
      }).finally(() => database.close())
    })
  }, workspaceId)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'local-corrupt', undefined, { timeout: 30_000 })
  assert.equal((await listLocalBlobs(page, workspaceId)).length, 1, 'metadata-missing must leave the retained blob untouched')
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'opfs-orphan-reconciliation',
    workspaceId,
    retainedBlob: retained.name,
    removedOrphan: orphan.name,
    metadataMissingState: await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state),
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
