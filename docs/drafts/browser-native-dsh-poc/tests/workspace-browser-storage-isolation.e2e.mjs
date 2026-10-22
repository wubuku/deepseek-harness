import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-storage-isolation-')))
const workspacePath = 'same-path.txt'
const contentA = `context-a-${randomUUID()}\n`
const contentB = `context-b-${randomUUID()}\n`
const cookieName = 'dsh-browser-native-principal'

async function indexedRecord(page, workspaceId) {
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

async function opfsContent(page, workspaceId, hash) {
  return await page.evaluate(async ({ id, blobHash }) => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
    const file = await (await directory.getFileHandle(blobHash)).getFile()
    return await file.text()
  }, { id: workspaceId, blobHash: hash })
}

let image
let app
let browser
let context
let page
const pageErrors = []
const nonLocalRequests = []
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
  })
  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`

  await openPreview(page, previewUrl)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceA = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  const writeA = await page.evaluate(async input => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: `/dsh/home/workspace/${input.path}`, content: input.content,
  }), { path: workspacePath, content: contentA })
  assert.equal(writeA?.ok, true, JSON.stringify(writeA))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  const recordA = await indexedRecord(page, workspaceA)
  assert.equal(recordA?.workspaceId, workspaceA)
  assert.equal(recordA?.revision, 1)
  const hashA = createHash('sha256').update(contentA).digest('hex')
  assert.equal(await opfsContent(page, workspaceA, hashA), contentA)

  await page.goto('about:blank', { waitUntil: 'domcontentloaded' })
  await context.clearCookies({ name: cookieName })
  await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' })
  const identityB = await page.evaluate(async () => await (await fetch('/api/browser-native/workspace/identity', { credentials: 'same-origin' })).json())
  const workspaceB = identityB.workspaceId
  assert.equal(typeof workspaceB, 'string')
  assert.notEqual(workspaceB, workspaceA)
  const cookieB = (await context.cookies()).find(cookie => cookie.name === cookieName)
  assert.ok(cookieB)

  await openPreview(page, previewUrl)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ !== undefined, undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  assert.equal(await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId), workspaceB)
  const writeB = await page.evaluate(async input => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: `/dsh/home/workspace/${input.path}`, content: input.content,
  }), { path: workspacePath, content: contentB })
  assert.equal(writeB?.ok, true, JSON.stringify(writeB))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })

  const recordB = await indexedRecord(page, workspaceB)
  assert.equal(recordB?.workspaceId, workspaceB)
  assert.equal(recordB?.revision, 1)
  const hashB = createHash('sha256').update(contentB).digest('hex')
  assert.notEqual(hashA, hashB)
  assert.deepEqual(await indexedRecord(page, workspaceA), recordA)
  assert.equal(await opfsContent(page, workspaceA, hashA), contentA)
  assert.equal(await opfsContent(page, workspaceB, hashB), contentB)

  const forbiddenManifest = await page.evaluate(async id => {
    const response = await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)
    return { status: response.status, body: await response.json() }
  }, workspaceA)
  assert.equal(forbiddenManifest.status, 403, JSON.stringify(forbiddenManifest))
  const forbiddenBlob = await page.evaluate(async ({ id, hash }) => {
    const response = await fetch(`/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)
    return { status: response.status, body: await response.json() }
  }, { id: workspaceA, hash: hashA })
  assert.equal(forbiddenBlob.status, 403, JSON.stringify(forbiddenBlob))
  const ownManifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceB)
  assert.equal(ownManifest.revision, 1)
  const ownEntry = ownManifest.entries.find(entry => entry.path === workspacePath)
  assert.equal(ownEntry.hash, hashB)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  const recoveredB = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'read', path }), `/dsh/home/workspace/${workspacePath}`)
  assert.deepEqual({ ok: recoveredB?.ok, content: recoveredB?.content }, { ok: true, content: contentB })
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'same-origin-workspace-identity-storage-isolation',
    workspaceA,
    workspaceB,
    sameRelativePath: workspacePath,
    localSnapshotsIsolated: true,
    opfsNamespacesIsolated: true,
    crossIdentityManifestStatus: forbiddenManifest.status,
    crossIdentityBlobStatus: forbiddenBlob.status,
    refreshedWorkspaceBContent: recoveredB.content,
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
