import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-workspace-partial-loss-')))
const testPath = '/dsh/home/workspace/partial-loss.txt'
const testContent = `partial-storage-loss-${crypto.randomUUID()}\n`

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

async function prepareDirtyWorkspace(browser, origin, scenario) {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  const commitAttempts = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    const body = route.request().postDataJSON()
    commitAttempts.push({ operationId: body.operationId, baseRevision: body.baseRevision })
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ protocolVersion: 1, error: { code: 'TEST_COMMIT_BLOCKED', message: 'commit blocked by partial storage loss E2E' } }),
    })
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  const write = await page.evaluate(async ({ path, content }) => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path, content,
  }), { path: testPath, content: testContent })
  assert.equal(write?.ok, true, JSON.stringify(write))
  const flush = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
  assert.equal(flush?.ok, false, 'the injected 503 must leave a retry batch')
  await waitFor(async () => {
    const record = await readWorkspaceRecord(page, workspaceId)
    return record?.retryBatch === undefined ? undefined : record
  }, `${scenario} durable retry`, 30_000)
  const record = await readWorkspaceRecord(page, workspaceId)
  const retry = record.retryBatch.changes.find(change => change.path === 'partial-loss.txt')
  assert.ok(retry?.contentHash)
  assert.ok(commitAttempts.length > 0)
  const manifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(manifest.revision, 0)
  return { context, page, workspaceId, hash: retry.contentHash, commitAttempts, pageErrors }
}

let image
let app
let browser
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })

  const opfsCase = await prepareDirtyWorkspace(browser, origin, 'OPFS-only deletion')
  const opfsBefore = opfsCase.commitAttempts.length
  const removedBlob = await opfsCase.page.evaluate(async ({ id, hash }) => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
    await directory.removeEntry(hash)
    return !(await directory.getFileHandle(hash).then(() => true, () => false))
  }, { id: opfsCase.workspaceId, hash: opfsCase.hash })
  assert.equal(removedBlob, true)
  await opfsCase.page.reload({ waitUntil: 'domcontentloaded' })
  await opfsCase.page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'local-corrupt', undefined, { timeout: 30_000 })
  const opfsOutcome = await opfsCase.page.evaluate(async id => {
    const status = window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__
    const response = await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)
    const manifest = await response.json()
    return { state: status?.state, dirtyCount: status?.dirtyCount, revision: manifest.revision, entries: manifest.entries.length }
  }, opfsCase.workspaceId)
  assert.deepEqual(opfsOutcome, { state: 'local-corrupt', dirtyCount: 0, revision: 0, entries: 0 })
  const [recoveryDownload] = await Promise.all([
    opfsCase.page.waitForEvent('download'),
    opfsCase.page.locator('[data-browser-native-recovery-export]').click(),
  ])
  const recoveryBundle = JSON.parse(await readFile(await recoveryDownload.path(), 'utf8'))
  assert.equal(recoveryBundle.workspaceId, opfsCase.workspaceId)
  assert.equal(recoveryBundle.metadata.retryBatch.operationId, opfsCase.commitAttempts[0].operationId)
  assert.deepEqual(recoveryBundle.missingBlobs, [opfsCase.hash])
  assert.deepEqual(recoveryBundle.blobs, [])
  assert.ok(opfsCase.commitAttempts.length >= opfsBefore)
  assert.deepEqual(opfsCase.pageErrors, [])
  await opfsCase.context.close()

  const metadataCase = await prepareDirtyWorkspace(browser, origin, 'IndexedDB-row-only deletion')
  const metadataBefore = await metadataCase.page.evaluate(async ({ id, hash }) => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
    const file = await (await directory.getFileHandle(hash)).getFile()
    const database = await new Promise((resolveDatabase, reject) => {
      const request = indexedDB.open('dsh-browser-native-workspace-v1', 1)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
      request.onsuccess = () => resolveDatabase(request.result)
    })
    const transaction = database.transaction('workspace', 'readwrite')
    transaction.objectStore('workspace').delete(id)
    await new Promise((resolveTransaction, reject) => {
      transaction.oncomplete = () => resolveTransaction(undefined)
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB delete aborted'))
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB delete failed'))
    })
    database.close()
    return { blobBytes: file.size, blobText: await file.text(), record: await readRecordAfterDelete(id) }

    async function readRecordAfterDelete(workspaceId) {
      const reopened = await new Promise((resolveDatabase, reject) => {
        const request = indexedDB.open('dsh-browser-native-workspace-v1', 1)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB reopen failed'))
        request.onsuccess = () => resolveDatabase(request.result)
      })
      const readTransaction = reopened.transaction('workspace', 'readonly')
      const request = readTransaction.objectStore('workspace').get(workspaceId)
      const value = await new Promise((resolveRecord, reject) => {
        request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'))
        request.onsuccess = () => resolveRecord(request.result ?? null)
      })
      reopened.close()
      return value
    }
  }, { id: metadataCase.workspaceId, hash: metadataCase.hash })
  assert.equal(metadataBefore.blobBytes, new TextEncoder().encode(testContent).byteLength)
  assert.equal(metadataBefore.blobText, testContent)
  assert.equal(metadataBefore.record, null)
  await metadataCase.page.reload({ waitUntil: 'domcontentloaded' })
  await metadataCase.page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'local-corrupt', undefined, { timeout: 30_000 })
  const metadataOutcome = await metadataCase.page.evaluate(async ({ id, path, hash }) => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
    const orphan = await (await directory.getFileHandle(hash)).getFile()
    const manifest = await (await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)).json()
    const record = await new Promise((resolveRecord, reject) => {
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
    })
    return {
      state: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state,
      dirtyCount: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount,
      message: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.message,
      orphanBytes: orphan.size,
      hasMetadata: record !== null,
      remoteRevision: manifest.revision,
      remoteEntries: manifest.entries.length,
    }
  }, { id: metadataCase.workspaceId, path: testPath, hash: metadataCase.hash })
  assert.deepEqual(metadataOutcome, {
    state: 'local-corrupt', dirtyCount: 0,
    message: 'browser-native workspace: local OPFS blobs exist without IndexedDB metadata',
    orphanBytes: new TextEncoder().encode(testContent).byteLength,
    hasMetadata: false, remoteRevision: 0, remoteEntries: 0,
  })
  const orphanDownload = await Promise.all([
    metadataCase.page.waitForEvent('download'),
    metadataCase.page.locator('[data-browser-native-recovery-export]').click(),
  ]).then(([download]) => download)
  const orphanBundle = JSON.parse(await readFile(await orphanDownload.path(), 'utf8'))
  assert.equal(orphanBundle.workspaceId, metadataCase.workspaceId)
  assert.equal(orphanBundle.metadata, null)
  assert.deepEqual(orphanBundle.blobs.map(blob => ({ name: blob.name, byteLength: blob.byteLength, hashMatches: blob.hashMatches })), [
    { name: metadataCase.hash, byteLength: new TextEncoder().encode(testContent).byteLength, hashMatches: true },
  ])
  assert.deepEqual(metadataCase.pageErrors, [])
  await metadataCase.context.close()

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'opfs-single-blob-loss-and-indexeddb-single-row-loss',
    opfsBlobLoss: {
      workspaceId: opfsCase.workspaceId,
      contentHash: opfsCase.hash,
      outcome: opfsOutcome,
      recoveryExport: { retryOperationId: recoveryBundle.metadata.retryBatch.operationId, missingBlobs: recoveryBundle.missingBlobs },
      commitAttemptsBeforeReload: opfsBefore,
      commitAttemptsAfterReload: opfsCase.commitAttempts.length,
    },
    indexedDbMetadataLoss: {
      workspaceId: metadataCase.workspaceId,
      contentHash: metadataCase.hash,
      outcome: metadataOutcome,
      recoveryExport: { metadata: orphanBundle.metadata, blobs: orphanBundle.blobs.map(blob => ({ name: blob.name, hashMatches: blob.hashMatches })) },
      conclusion: 'the runtime fails closed and exports orphan bytes by hash, but lost metadata means original file paths are unavailable',
    },
  })}\n`)
} finally {
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
