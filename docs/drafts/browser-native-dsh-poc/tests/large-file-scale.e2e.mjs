import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview } from './runtime-test-support.mjs'
import { WORKSPACE_BLOB_CHUNK_BYTES } from '../workspace-v2.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-large-file-')))
const filePath = '/dsh/home/workspace/large-file.bin'
const fileBytes = Number(process.env.DSH_POC_LARGE_FILE_BYTES ?? 16 * 1024 * 1024)
const byteValue = 0xa7
if (!Number.isSafeInteger(fileBytes) || fileBytes < WORKSPACE_BLOB_CHUNK_BYTES
  || fileBytes > 64 * 1024 * 1024) throw new Error('DSH_POC_LARGE_FILE_BYTES must be between 1 and 64 MiB')
const expectedHash = createHash('sha256').update(Buffer.alloc(WORKSPACE_BLOB_CHUNK_BYTES, byteValue).subarray(0, Math.min(fileBytes, WORKSPACE_BLOB_CHUNK_BYTES)))
let remaining = fileBytes - Math.min(fileBytes, WORKSPACE_BLOB_CHUNK_BYTES)
while (remaining > 0) {
  const count = Math.min(remaining, WORKSPACE_BLOB_CHUNK_BYTES)
  expectedHash.update(Buffer.alloc(count, byteValue))
  remaining -= count
}
const digest = expectedHash.digest('hex')
const pageErrors = []
const nonLocalRequests = []
const chunkRequests = []
let ackLost = false
let stagedChunkCorrupted = false
let resolveLostAck
const lostAck = new Promise(resolvePromise => { resolveLostAck = resolvePromise })

let image
let app
let browser
let page
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  const port = Number(new URL(origin).port)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
  })
  await page.route(`${origin}/api/browser-native/workspace/blob-upload/**`, async route => {
    const request = route.request()
    const match = new URL(request.url()).pathname.match(/\/blob-upload\/([0-9a-f-]{36}-[a-f0-9]{64})\/([0-9]+)$/i)
    if (request.method() === 'PUT' && match !== null) {
      const uploadId = match[1]
      const index = Number(match[2])
      const bodyBytes = request.postDataBuffer()?.byteLength ?? 0
      chunkRequests.push({ index, bodyBytes })
      if (index === 0 && !stagedChunkCorrupted) {
        const storedResponse = await route.fetch()
        assert.equal(storedResponse.status(), 200)
        const workspaceId = request.headers()['x-workspace-id']
        assert.equal(typeof workspaceId, 'string')
        await writeFile(join(dataDir, 'workspace-v2', 'uploads', workspaceId, uploadId, '0.part'), Buffer.from('corrupt staged bytes'))
        stagedChunkCorrupted = true
        await route.fulfill({ response: storedResponse })
        return
      }
      if (index === 1 && !ackLost) {
        const storedResponse = await route.fetch()
        assert.equal(storedResponse.status(), 200)
        ackLost = true
        resolveLostAck()
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ protocolVersion: 1, error: { code: 'TEST_CHUNK_ACK_LOST', message: 'chunk receipt response was lost' } }),
        })
        return
      }
    }
    await route.continue()
  })

  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await openPreview(page, previewUrl)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId !== undefined, undefined, { timeout: 30_000 })

  const created = await page.evaluate(async request => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(request), {
    action: 'write-pattern', path: filePath, byteLength: fileBytes, byteValue,
  })
  assert.deepEqual(
    { ok: created?.ok, bytes: created?.bytes, digest: created?.digest },
    { ok: true, bytes: fileBytes, digest },
  )
  let lostAckTimer
  await Promise.race([
    lostAck,
    new Promise((_, reject) => { lostAckTimer = setTimeout(() => reject(new Error('the second upload chunk did not reach the backend')), 60_000) }),
  ]).finally(() => clearTimeout(lostAckTimer))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'error', undefined, { timeout: 30_000 })
  const identityState = await page.evaluate(() => ({
    workspaceId: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId,
    dirtyCount: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount,
  }))
  assert.equal(typeof identityState.workspaceId, 'string')
  assert.ok((identityState.dirtyCount ?? 0) > 0)
  const originPort = port
  await app.close()
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const restartedOrigin = await app.listen(originPort)
  assert.equal(restartedOrigin, origin)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 90_000 })
  assert.equal(chunkRequests.filter(request => request.index === 0).length, 2)
  assert.equal(chunkRequests.filter(request => request.index === 1).length, 1)
  assert.equal(chunkRequests.filter(request => request.index >= 2).length, Math.ceil(fileBytes / WORKSPACE_BLOB_CHUNK_BYTES) - 2)
  assert.ok(chunkRequests.every(request => request.bodyBytes > 0 && request.bodyBytes <= WORKSPACE_BLOB_CHUNK_BYTES))

  const manifest = await page.evaluate(async () => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId ?? '')}`,
  )).json())
  const entry = manifest.entries.find(item => item.path === 'large-file.bin')
  assert.deepEqual({ hash: entry?.hash, bytes: entry?.bytes, revision: manifest.revision }, { hash: digest, bytes: fileBytes, revision: 1 })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 90_000 })
  const restored = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'read-digest', path }), filePath)
  assert.deepEqual(
    { ok: restored?.ok, bytes: restored?.bytes, digest: restored?.digest },
    { ok: true, bytes: fileBytes, digest },
  )
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    browserVersion: await browser.version(),
    fileBytes,
    chunkBytes: WORKSPACE_BLOB_CHUNK_BYTES,
    chunkCount: Math.ceil(fileBytes / WORKSPACE_BLOB_CHUNK_BYTES),
    uploadedChunks: chunkRequests,
    lostChunkAcknowledgement: ackLost,
    corruptedStagingChunkDetected: stagedChunkCorrupted,
    resumedAfterBackendRestart: true,
    workspaceRevision: manifest.revision,
    hash: digest,
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
