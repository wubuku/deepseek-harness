import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-corruption-e2e-')))

async function readLocalRecord(page, workspaceId) {
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

async function waitForPending(page, workspaceId) {
  return await waitFor(async () => {
    const record = await readLocalRecord(page, workspaceId)
    return record?.retryBatch === undefined ? false : record
  }, 'durable local retry snapshot', 30_000)
}

async function corruptSnapshot(page, workspaceId) {
  await page.evaluate(async id => await new Promise((resolveWrite, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1')
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('workspace', 'readwrite')
      const store = transaction.objectStore('workspace')
      const get = store.get(id)
      get.onerror = () => reject(get.error ?? new Error('IndexedDB read failed'))
      get.onsuccess = () => {
        const record = get.result
        record.version = 999
        store.put(record)
      }
      transaction.oncomplete = () => {
        database.close()
        resolveWrite()
      }
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB corruption write failed'))
    }
  }), workspaceId)
}

async function removeLocalBlob(page, workspaceId, hash) {
  await page.evaluate(async ({ id, blobHash }) => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
    await directory.removeEntry(blobHash)
  }, { id: workspaceId, blobHash: hash })
}

async function corruptLocalBlob(page, workspaceId, hash) {
  await page.evaluate(async ({ id, blobHash }) => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
    const file = await directory.getFileHandle(blobHash)
    const writable = await file.createWritable()
    await writable.write(new TextEncoder().encode('wrong bytes\n'))
    await writable.close()
  }, { id: workspaceId, blobHash: hash })
}

async function downloadRecoveryBundle(page, workspaceId) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-browser-native-recovery-export]').click(),
  ])
  assert.equal(download.suggestedFilename(), `dsh-workspace-recovery-${workspaceId}.json`)
  const path = await download.path()
  assert.ok(path, 'Chrome must materialize the user-requested recovery download')
  return JSON.parse(await readFile(path, 'utf8'))
}

function decodeBlob(bundle, hash) {
  const blob = bundle.blobs.find(candidate => candidate.name === hash)
  assert.ok(blob, `recovery bundle must contain OPFS blob ${hash}`)
  const bytes = Buffer.from(blob.base64, 'base64')
  assert.equal(bytes.byteLength, blob.byteLength)
  return bytes.toString('utf8')
}

async function openBlockedPage(context, origin) {
  const page = await context.newPage()
  const pageErrors = []
  const nonLocalRequests = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
  })
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ protocolVersion: 1, error: { code: 'TEST_COMMIT_BLOCKED', message: 'commit blocked by corruption E2E' } }),
    })
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId !== undefined, undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.workspaceId)
  assert.equal(typeof workspaceId, 'string')
  return { page, workspaceId, pageErrors, nonLocalRequests }
}

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')

let image
let app
let browser
const pages = []
const cases = []
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(port)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })

  const invalidContext = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const invalid = await openBlockedPage(invalidContext, origin)
  cases.push(invalid)
  pages.push(invalid.page)
  await invalid.page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: '/dsh/home/workspace/invalid-snapshot.txt', content: 'snapshot corruption\n',
  }))
  const invalidRecord = await waitForPending(invalid.page, invalid.workspaceId)
  assert.equal(typeof invalidRecord.retryBatch.operationId, 'string')
  await corruptSnapshot(invalid.page, invalid.workspaceId)
  await invalid.page.reload({ waitUntil: 'domcontentloaded' })
  await invalid.page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'local-corrupt', undefined, { timeout: 30_000 })
  assert.equal(await invalid.page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.state), 'local-corrupt')
  assert.equal(await invalid.page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.message.includes('local durable snapshot is invalid')), true)
  const invalidBundle = await downloadRecoveryBundle(invalid.page, invalid.workspaceId)
  await invalid.page.waitForFunction(() => document.querySelector('[data-browser-native-recovery-result]')?.textContent?.includes('downloaded'))
  assert.equal(invalidBundle.format, 'dsh-browser-native-workspace-recovery-v1')
  assert.equal(invalidBundle.metadata.version, 999)
  const invalidHash = invalidRecord.retryBatch.changes.find(change => change.path === 'invalid-snapshot.txt')?.contentHash
  assert.equal(typeof invalidHash, 'string')
  assert.equal(decodeBlob(invalidBundle, invalidHash), 'snapshot corruption\n')
  assert.deepEqual(invalidBundle.corruptBlobs, [])
  assert.deepEqual(invalidBundle.missingBlobs, [])
  assert.equal((await readLocalRecord(invalid.page, invalid.workspaceId)).version, 999,
    'export must not repair or clear invalid metadata')

  const blobContext = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const missingBlob = await openBlockedPage(blobContext, origin)
  cases.push(missingBlob)
  pages.push(missingBlob.page)
  await missingBlob.page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: '/dsh/home/workspace/missing-blob.txt', content: 'blob corruption\n',
  }))
  const blobRecord = await waitForPending(missingBlob.page, missingBlob.workspaceId)
  const blobHash = blobRecord.retryBatch.changes.find(change => change.path === 'missing-blob.txt')?.contentHash
  assert.equal(typeof blobHash, 'string')
  await removeLocalBlob(missingBlob.page, missingBlob.workspaceId, blobHash)
  await missingBlob.page.reload({ waitUntil: 'domcontentloaded' })
  await missingBlob.page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'local-corrupt', undefined, { timeout: 30_000 })
  assert.equal(await missingBlob.page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.state), 'local-corrupt')
  assert.equal(await missingBlob.page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.message.includes('local blob is missing')), true)
  const missingBundle = await downloadRecoveryBundle(missingBlob.page, missingBlob.workspaceId)
  await missingBlob.page.waitForFunction(() => document.querySelector('[data-browser-native-recovery-result]')?.textContent?.includes('downloaded'))
  assert.deepEqual(missingBundle.missingBlobs, [blobHash])
  assert.deepEqual(missingBundle.corruptBlobs, [])
  assert.equal(missingBundle.blobs.some(blob => blob.name === blobHash), false)

  const corruptContext = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const corruptBlob = await openBlockedPage(corruptContext, origin)
  cases.push(corruptBlob)
  pages.push(corruptBlob.page)
  await corruptBlob.page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: '/dsh/home/workspace/corrupt-blob.txt', content: 'blob hash corruption\n',
  }))
  const corruptRecord = await waitForPending(corruptBlob.page, corruptBlob.workspaceId)
  const corruptHash = corruptRecord.retryBatch.changes.find(change => change.path === 'corrupt-blob.txt')?.contentHash
  assert.equal(typeof corruptHash, 'string')
  await corruptLocalBlob(corruptBlob.page, corruptBlob.workspaceId, corruptHash)
  await corruptBlob.page.reload({ waitUntil: 'domcontentloaded' })
  await corruptBlob.page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'local-corrupt', undefined, { timeout: 30_000 })
  assert.equal(await corruptBlob.page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.state), 'local-corrupt')
  assert.equal(await corruptBlob.page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.message.includes('hash mismatch')), true)
  const corruptBundle = await downloadRecoveryBundle(corruptBlob.page, corruptBlob.workspaceId)
  await corruptBlob.page.waitForFunction(() => document.querySelector('[data-browser-native-recovery-result]')?.textContent?.includes('downloaded'))
  assert.equal(decodeBlob(corruptBundle, corruptHash), 'wrong bytes\n')
  assert.deepEqual(corruptBundle.corruptBlobs.map(blob => blob.name), [corruptHash])
  assert.deepEqual(corruptBundle.missingBlobs, [])

  for (const testCase of cases) {
    const manifest = await testCase.page.evaluate(async id => await (await fetch(
      `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
    )).json(), testCase.workspaceId)
    assert.equal(manifest.revision, 0, 'corrupt local state must not overwrite the remote Workspace')
  }

  for (const page of pages) {
    assert.deepEqual(await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.state), 'local-corrupt')
  }
  assert.deepEqual(cases.flatMap(testCase => testCase.pageErrors), [],
    'fail-closed Workspace boot must leave a usable local recovery page without an uncaught bootstrap error')
  assert.deepEqual(cases.flatMap(testCase => testCase.nonLocalRequests), [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'Worker-OPFS-IndexedDB-local-corruption',
    cases: ['invalid-snapshot-exported', 'missing-blob-exported', 'hash-mismatch-exported'],
    pageErrors: cases.flatMap(testCase => testCase.pageErrors),
    nonLocalRequests: cases.flatMap(testCase => testCase.nonLocalRequests),
  })}\n`)
} finally {
  for (const page of pages) await page.close().catch(() => {})
  if (browser !== undefined) await browser.close()
  if (app !== undefined) await app.close()
  if (image !== undefined) await image.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
