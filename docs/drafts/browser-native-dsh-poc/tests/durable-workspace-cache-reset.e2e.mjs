import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
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
const port = Number(process.env.DSH_POC_PORT ?? '0')
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-cache-reset-')))
const workspacePath = '/dsh/home/workspace/cache-reset.txt'
const expectedContent = 'restore committed Workspace from the backend\n'

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')

let image
let app
let browser
let context
let page
const commits = []
const pageErrors = []
const nonLocalRequests = []
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(port)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
    if (url.pathname === '/api/browser-native/workspace/commit') commits.push(request.postDataJSON())
  })

  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await openPreview(page, previewUrl)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })

  const identity = await page.evaluate(async () => await (await fetch('/api/browser-native/workspace/identity')).json())
  const write = await page.evaluate(async ({ path, content }) => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path, content,
  }), { path: workspacePath, content: expectedContent })
  assert.equal(write?.ok, true, JSON.stringify(write))
  const flush = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
  assert.equal(flush?.ok, true, JSON.stringify(flush))
  assert.equal(flush.receipts?.length, 1)
  assert.equal(commits.length, 1, 'the initial local write must commit exactly once')

  const remoteBeforeReset = await page.evaluate(async workspaceId => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
  )).json(), identity.workspaceId)
  const remoteEntry = remoteBeforeReset.entries.find(entry => entry.path === 'cache-reset.txt')
  assert.ok(remoteEntry, 'the backend manifest must contain the committed file')
  assert.equal(remoteBeforeReset.revision, 1)
  const remoteBlob = await page.evaluate(async ({ workspaceId, hash }) => {
    const response = await fetch(
      `/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
    )
    return { status: response.status, content: await response.text() }
  }, { workspaceId: identity.workspaceId, hash: remoteEntry.hash })
  assert.equal(remoteBlob.status, 200)
  assert.equal(remoteBlob.content, expectedContent)

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })))
  const cleared = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const removedEntries = []
    for await (const [name] of root.entries()) {
      await root.removeEntry(name, { recursive: true })
      removedEntries.push(name)
    }
    const databaseNames = await indexedDB.databases()
    const removedDatabases = []
    for (const database of databaseNames) {
      if (database.name === undefined) continue
      await new Promise((resolveDelete, rejectDelete) => {
        const request = indexedDB.deleteDatabase(database.name)
        request.onsuccess = () => resolveDelete(undefined)
        request.onerror = () => rejectDelete(request.error ?? new Error(`failed to delete ${database.name}`))
        request.onblocked = () => rejectDelete(new Error(`database deletion blocked: ${database.name}`))
      })
      removedDatabases.push(database.name)
    }
    return { removedEntries, removedDatabases }
  })
  assert.ok(cleared.removedEntries.length > 0, 'the test must remove OPFS workspace blobs')
  assert.ok(cleared.removedDatabases.includes('dsh-browser-native-workspace-v1'), 'the test must remove the durable metadata database')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 30_000 })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  const restored = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'read', path }), workspacePath)
  assert.deepEqual(
    { ok: restored?.ok, path: restored?.path, content: restored?.content },
    { ok: true, path: workspacePath, content: expectedContent },
  )
  const remoteAfterReset = await page.evaluate(async workspaceId => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
  )).json(), identity.workspaceId)
  assert.equal(remoteAfterReset.revision, remoteBeforeReset.revision)
  assert.equal(commits.length, 1, 'rehydration must not issue another Workspace commit')
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'OPFS-IndexedDB-cleared-cloud-Workspace-rebuild',
    workspaceId: identity.workspaceId,
    revision: remoteAfterReset.revision,
    path: restored.path,
    contentBytes: Buffer.byteLength(restored.content),
    contentHash: remoteEntry.hash,
    removedEntries: cleared.removedEntries,
    removedDatabases: cleared.removedDatabases,
    workspaceCommitCount: commits.length,
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
