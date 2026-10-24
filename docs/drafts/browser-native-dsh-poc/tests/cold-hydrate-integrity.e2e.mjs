import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-cold-hydrate-')))
const fileBytes = 3 * 1024 * 1024 + 37
const workspacePath = '/dsh/home/workspace/cold-hydrate.bin'

async function listLocalBlobs(page, workspaceId) {
  return await page.evaluate(async id => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
    const names = []
    for await (const [name, entry] of directory.entries()) if (entry.kind === 'file') names.push(name)
    return names.sort()
  }, workspaceId)
}

async function removeLocalBlob(page, workspaceId, hash) {
  await page.evaluate(async ({ id, blobHash }) => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
    await directory.removeEntry(blobHash)
  }, { id: workspaceId, blobHash: hash })
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
  const chunkRequests = []
  page.on('response', async response => {
    const url = new URL(response.url())
    if (!url.pathname.includes('/workspace/blob/') || !url.pathname.includes('/chunk/')) return
    chunkRequests.push({ url: response.url(), bytes: (await response.body()).byteLength })
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.workspaceId)
  const initialUsage = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'usage' }))
  const write = await page.evaluate(async ({ path, bytes }) => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write-pattern', path, byteLength: bytes, byteValue: 37,
  }), { path: workspacePath, bytes: fileBytes })
  assert.equal(write?.ok, true, JSON.stringify(write))
  const committed = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
  assert.equal(committed?.ok, true, JSON.stringify(committed))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  const manifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  const entry = manifest.entries.find(item => item.path === 'cold-hydrate.bin')
  assert.ok(entry?.hash)
  const originalBlobs = await listLocalBlobs(page, workspaceId)
  assert.deepEqual(originalBlobs, [entry.hash])
  assert.equal((await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'close-vfs' }))).ok, true)
  await removeLocalBlob(page, workspaceId, entry.hash)

  chunkRequests.length = 0
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const usage = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'usage' }))
  assert.equal(usage?.ok, true)
  assert.ok(usage.logicalBytes >= fileBytes, JSON.stringify(usage))
  assert.ok(usage.residentBytes < initialUsage.residentBytes + fileBytes / 2, JSON.stringify({ initialUsage, usage }))
  assert.ok(chunkRequests.length >= 4, JSON.stringify(chunkRequests))
  assert.ok(chunkRequests.every(item => item.bytes <= 1024 * 1024), JSON.stringify(chunkRequests))
  const range = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'read-range', path, offset: 1024 * 1024 + 17, length: 4096,
  }), workspacePath)
  assert.equal(range?.ok, true, JSON.stringify(range))
  assert.equal(range.length, 4096)
  assert.equal(Buffer.from(range.base64, 'base64').every(byte => byte === 37), true)

  assert.equal((await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'close-vfs' }))).ok, true)
  await removeLocalBlob(page, workspaceId, entry.hash)
  await page.route(`${origin}/api/browser-native/workspace/blob/${entry.hash}/chunk/0?**`, async route => {
    const response = await route.fetch()
    const body = Buffer.from(await response.body())
    body[0] = body[0] === 37 ? 38 : 37
    await route.fulfill({ response, body })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(async () => await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'error'),
    'corrupt cold hydrate status', 30_000)
  const failedState = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
  assert.match(failedState.message, /chunk verification|hash mismatch/i)
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'cold-hydrate-chunk-integrity',
    workspaceId,
    fileBytes,
    chunkRequests: chunkRequests.length,
    maxChunkBytes: Math.max(...chunkRequests.map(item => item.bytes)),
    logicalBytes: usage.logicalBytes,
    initialResidentBytes: initialUsage.residentBytes,
    residentBytes: usage.residentBytes,
    corruptHydrateState: failedState.state,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
