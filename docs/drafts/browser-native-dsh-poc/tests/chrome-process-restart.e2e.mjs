import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-process-restart-')))
const profileDir = await mkdtemp(join(tmpdir(), 'dsh-browser-process-profile-'))
const path = 'process-restart.txt'
const content = `chrome-profile-restart-${crypto.randomUUID()}\n`
const digest = createHash('sha256').update(content).digest('hex')
const pageErrors = []
const nonLocalRequests = []
let image
let app
let context
let page
let origin
let browserVersion
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  const port = Number(new URL(origin).port)
  context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    channel: process.env.DSH_POC_BROWSER ?? 'chrome',
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
  })
  page = context.pages()[0] ?? await context.newPage()
  browserVersion = await page.evaluate(() => navigator.userAgent)
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) nonLocalRequests.push(request.url())
  })
  const url = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await openPreview(page, url)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  const write = await page.evaluate(async input => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: `/dsh/home/workspace/${input.path}`, content: input.content,
  }), { path, content })
  assert.equal(write?.ok, true, JSON.stringify(write))
  const flush = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
  assert.equal(flush?.ok, true, JSON.stringify(flush))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision >= 1, undefined, { timeout: 30_000 })
  const before = await page.evaluate(async id => {
    const manifestResponse = await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)
    const manifest = await manifestResponse.json()
    const request = indexedDB.open('dsh-browser-native-workspace-v1', 1)
    const record = await new Promise((resolveRecord, reject) => {
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('workspace', 'readonly')
        const get = transaction.objectStore('workspace').get(id)
        get.onerror = () => reject(get.error ?? new Error('IndexedDB read failed'))
        get.onsuccess = () => { database.close(); resolveRecord(get.result ?? null) }
      }
    })
    return { manifest, record }
  }, workspaceId)
  const entry = before.manifest.entries.find(item => item.path === path)
  assert.ok(entry)
  assert.equal(entry.hash, digest)
  assert.equal(before.manifest.revision, 1)
  assert.equal(before.record?.workspaceId, workspaceId)

  const restartStartedAt = Date.now()
  await context.close()
  context = undefined
  await app.close()
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const restartedOrigin = await app.listen(port)
  assert.equal(restartedOrigin, origin)
  context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    channel: process.env.DSH_POC_BROWSER ?? 'chrome',
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
  })
  page = context.pages()[0] ?? await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) nonLocalRequests.push(request.url())
  })
  await openPreview(page, url)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  try {
    await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
      && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 15_000 })
  } catch (error) {
    const diagnostics = await page.evaluate(async () => ({
      status: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__,
      identity: await (await fetch('/api/browser-native/workspace/identity')).json(),
      storage: await navigator.storage.estimate(),
    }))
    process.stderr.write(`${JSON.stringify({
      failure: error instanceof Error ? error.message : String(error),
      diagnostics,
      backendWorkspaceIds: [...app.workspaces.workspaces.keys()],
      backendWorkspaceRevisions: [...app.workspaces.workspaces.values()].map(workspace => workspace.revision),
      cookies: (await context.cookies(origin)).map(cookie => cookie.name),
      bodyText: (await page.locator('body').innerText()).slice(-1600),
      pageErrors,
    })}\n`)
    throw error
  }
  const restored = await page.evaluate(async ({ id, path, hash }) => {
    const result = await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'read', path: `/dsh/home/workspace/${path}` })
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
    const blob = await (await directory.getFileHandle(hash)).getFile()
    return { result, blobText: await blob.text(), blobBytes: blob.size }
  }, { id: workspaceId, path, hash: digest })
  assert.deepEqual({ ok: restored.result?.ok, content: restored.result?.content }, { ok: true, content })
  assert.deepEqual({ blobText: restored.blobText, blobBytes: restored.blobBytes }, { blobText: content, blobBytes: Buffer.byteLength(content) })
  const afterManifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(afterManifest.revision, 1)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'clean-chrome-process-and-backend-restart',
    userAgent: browserVersion,
    workspaceId,
    sameOriginAfterRestart: restartedOrigin === origin,
    recoveredPath: path,
    recoveredContentHash: digest,
    indexedDbRecordRestored: true,
    opfsBlobRestored: true,
    backendManifestRevision: afterManifest.revision,
    restartAndRecoveryMs: Date.now() - restartStartedAt,
    pageErrors,
    nonLocalRequests,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
  await rm(profileDir, { recursive: true, force: true })
}
