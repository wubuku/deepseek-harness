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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-recovery-e2e-')))
const recoveryPath = '/dsh/home/workspace/recovery.txt'
const recoveryContent = `browser-native-recovery-${crypto.randomUUID()}\n`

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')

async function browserStorageSnapshot(page, workspaceId) {
  return await page.evaluate(async id => {
    const record = await new Promise((resolve, reject) => {
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
    const retry = record?.retryBatch?.changes?.find(change => change.path === 'recovery.txt')
    let localBlob
    if (retry?.contentHash && typeof navigator.storage?.getDirectory === 'function') {
      try {
        const root = await navigator.storage.getDirectory()
        const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
        const file = await (await directory.getFileHandle(retry.contentHash)).getFile()
        localBlob = { hash: retry.contentHash, text: await file.text() }
      } catch (error) {
        localBlob = { error: error instanceof Error ? error.message : String(error) }
      }
    }
    return { record, retry, localBlob }
  }, workspaceId)
}

let image
let app
let browser
let page
const commits = []
let blocked = false
const pageErrors = []
const nonLocalRequests = []
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(port)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
  })
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    const body = route.request().postDataJSON()
    commits.push({ operationId: body.operationId, baseRevision: body.baseRevision, changes: body.changes })
    if (!blocked) {
      blocked = true
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ protocolVersion: 1, error: { code: 'TEST_COMMIT_BLOCKED', message: 'commit blocked by durable recovery E2E' } }),
      })
      return
    }
    await route.continue()
  })

  const url = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await openPreview(page, url)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId !== undefined, undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')

  const writeResult = await page.evaluate(async ({ path, content }) => {
    return await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'write', path, content })
  }, { path: recoveryPath, content: recoveryContent })
  assert.deepEqual(
    { ok: writeResult?.ok, path: writeResult?.path, content: writeResult?.content },
    { ok: true, path: recoveryPath, content: recoveryContent },
  )
  await waitFor(() => blocked && commits.length >= 1, 'the first Workspace commit to be fault-injected', 30_000)
  const firstOperationId = commits[0].operationId
  assert.equal(typeof firstOperationId, 'string')

  const beforeRefresh = await browserStorageSnapshot(page, workspaceId)
  assert.equal(beforeRefresh.record?.workspaceId, workspaceId)
  assert.equal(beforeRefresh.record?.retryBatch?.operationId, firstOperationId)
  assert.equal(beforeRefresh.retry?.path, 'recovery.txt')
  assert.deepEqual(beforeRefresh.localBlob, { hash: beforeRefresh.retry.contentHash, text: recoveryContent })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 30_000 })
  await waitFor(() => commits.length >= 2, 'the restored Workspace commit retry', 30_000)
  assert.equal(commits[1].operationId, firstOperationId)
  assert.equal(commits[1].baseRevision, commits[0].baseRevision)

  const afterRefresh = await browserStorageSnapshot(page, workspaceId)
  assert.equal(afterRefresh.record?.workspaceId, workspaceId)
  assert.equal(afterRefresh.record?.retryBatch, undefined)
  assert.deepEqual(afterRefresh.record?.pending, [])
  assert.equal(afterRefresh.record?.revision, 1)
  const manifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  const entry = manifest.entries.find(item => item.path === 'recovery.txt')
  assert.ok(entry)
  const blob = await page.evaluate(async ({ id, hash }) => {
    const response = await fetch(`/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)
    return { status: response.status, text: await response.text() }
  }, { id: workspaceId, hash: entry.hash })
  assert.deepEqual(blob, { status: 200, text: recoveryContent })
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'Worker-OPFS-IndexedDB-recovery',
    workspaceId,
    operationId: firstOperationId,
    commitAttempts: commits.length,
    revisions: [commits[0].baseRevision, manifest.revision],
    localBlobHash: beforeRefresh.localBlob.hash,
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
