import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-idb-forward-version-')))
const blobText = 'forward-version-local-recovery-payload\n'
const sentinel = { key: 'newer-schema-owner-data', value: 'preserve-this-value' }
let image
let app
let browser
let page
let origin
const pageErrors = []
const externalRequests = []
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ acceptDownloads: true, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url())
  })
  await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' })
  const workspaceId = await page.evaluate(async () => (await (await fetch('/api/browser-native/workspace/identity')).json()).workspaceId)
  const setup = await page.evaluate(async ({ id, value }) => {
    const database = await new Promise((resolveDatabase, reject) => {
      const request = indexedDB.open('dsh-browser-native-workspace-v1', 2)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('workspace')) db.createObjectStore('workspace', { keyPath: 'workspaceId' })
        if (!db.objectStoreNames.contains('future-data')) db.createObjectStore('future-data', { keyPath: 'key' })
      }
      request.onsuccess = () => resolveDatabase(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB v2 setup failed'))
    })
    const localBytes = new TextEncoder().encode('forward-version-local-recovery-payload\n')
    const digest = await crypto.subtle.digest('SHA-256', localBytes)
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const transaction = database.transaction(['workspace', 'future-data'], 'readwrite')
    transaction.objectStore('workspace').put({
      version: 1,
      workspaceId: id,
      revision: 0,
      pending: [],
      recoveryMarker: 'retain-existing-record',
    })
    transaction.objectStore('future-data').put(value)
    await new Promise((resolveTransaction, reject) => {
      transaction.oncomplete = () => resolveTransaction()
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB v2 seed failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB v2 seed aborted'))
    })
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`, { create: true })
    const file = await directory.getFileHandle(hash, { create: true })
    const writer = await file.createWritable()
    await writer.write(localBytes)
    await writer.close()
    const version = database.version
    const stores = Array.from(database.objectStoreNames)
    database.close()
    return { version, stores, hash, bytes: localBytes.length }
  }, { id: workspaceId, value: sentinel })
  assert.equal(setup.version, 2)
  assert.deepEqual(setup.stores, ['future-data', 'workspace'])

  await page.goto(`${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'local-newer-version',
    undefined, { timeout: 30_000 })
  assert.equal(await page.getByRole('button', { name: /Download local recovery bundle/ }).isVisible(), true)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Download local recovery bundle/ }).click(),
  ])
  const downloadPath = await download.path()
  assert.ok(downloadPath)
  const bundle = JSON.parse(await readFile(downloadPath, 'utf8'))
  assert.equal(bundle.workspaceId, workspaceId)
  assert.equal(bundle.indexedDbVersion, 2)
  assert.deepEqual(bundle.objectStoreNames, ['future-data', 'workspace'])
  assert.deepEqual(bundle.metadata, {
    version: 1,
    workspaceId,
    revision: 0,
    pending: [],
    recoveryMarker: 'retain-existing-record',
  })
  assert.equal(bundle.blobs.length, 1)
  assert.equal(bundle.blobs[0].name, setup.hash)
  assert.equal(bundle.blobs[0].hashMatches, true)
  const decoded = Buffer.from(bundle.blobs[0].base64, 'base64').toString('utf8')
  assert.equal(decoded, blobText)

  const afterExport = await page.evaluate(async id => await new Promise((resolveRecord, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1')
    request.onerror = () => reject(request.error ?? new Error('IndexedDB verification open failed'))
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction(['workspace', 'future-data'], 'readonly')
      const metadata = transaction.objectStore('workspace').get(id)
      const future = transaction.objectStore('future-data').get('newer-schema-owner-data')
      transaction.oncomplete = () => {
        const result = { version: database.version, metadata: metadata.result, future: future.result }
        database.close()
        resolveRecord(result)
      }
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB verification failed'))
    }
  }), workspaceId)
  assert.equal(afterExport.version, 2)
  assert.deepEqual(afterExport.metadata, bundle.metadata)
  assert.deepEqual(afterExport.future, sentinel)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'IndexedDB-forward-version-fail-closed-and-local-export',
    workspaceId,
    databaseVersion: afterExport.version,
    objectStoreNames: setup.stores,
    recoveryBundleBytes: Buffer.byteLength(JSON.stringify(bundle)),
    exportedBlobCount: bundle.blobs.length,
    exportedBlobHash: bundle.blobs[0].name,
    newerStoreValuePreserved: afterExport.future.value === sentinel.value,
    databaseVersionAfterExport: afterExport.version,
    pageErrors,
    externalRequests,
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    pageText: page !== undefined && !page.isClosed() ? (await page.locator('body').innerText().catch(() => '')).slice(-2500) : undefined,
    pageErrors,
    externalRequests,
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
