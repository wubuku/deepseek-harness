import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-reference-edit-')))
const byteLength = Number(process.env.DSH_POC_REFERENCE_EDIT_BYTES ?? 16 * 1024 * 1024)
const chunkBytes = Number(process.env.DSH_POC_REFERENCE_EDIT_CHUNK_BYTES ?? 1024 * 1024)
const oldText = 'REFERENCE_EDIT_MARKER'
const newText = 'REFERENCE_EDIT_REPLACEMENT_WITHOUT_FULL_RESULT'
const failureStages = ['copy-prefix', 'copy-suffix', 'write-replacement', 'truncate', 'hash', 'publish']
const pageErrors = []
const apiRequests = []
let image
let app
let browser
let context
let page

async function test(action) {
  return await page.evaluate(async request => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(request), action)
}

try {
  assert.ok(Number.isSafeInteger(byteLength) && byteLength >= 1024 * 1024 && byteLength <= 64 * 1024 * 1024)
  assert.ok(Number.isSafeInteger(chunkBytes) && chunkBytes >= 1024 && chunkBytes <= 16 * 1024 * 1024)
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (request.url().includes('/api/browser-native/workspace/')) {
      apiRequests.push({
        path: new URL(request.url()).pathname,
        method: request.method(),
        body: request.postData(),
        bytes: request.postDataBuffer()?.byteLength ?? 0,
      })
    }
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  try {
    await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
      && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  } catch (error) {
    const state = await page.evaluate(() => ({
      status: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__,
      testPort: typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__,
    })).catch(reason => ({ evaluateError: String(reason) }))
    process.stderr.write(`${JSON.stringify({ state, pageErrors })}\n`)
    throw error
  }

  const failures = []
  for (const failStage of failureStages) {
    const failed = await test({
      action: 'reference-edit-probe',
      byteLength,
      chunkBytes,
      path: '/dsh/home/workspace/reference-edit-failure.bin',
      oldText,
      newText,
      failStage,
    })
    assert.equal(failed?.ok, false, JSON.stringify({ failStage, failed }))
    assert.equal(failed.sourceUnchanged, true, JSON.stringify({ failStage, failed }))
    assert.equal(failed.sourceHash, failed.afterFailureHash, JSON.stringify({ failStage, failed }))
    failures.push({ failStage, failure: failed.failure })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
      && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  }
  assert.equal(apiRequests.some(request => request.path.endsWith('/commit')), false)
  const initialUsage = await test({ action: 'usage' })
  const edited = await test({
    action: 'reference-edit-probe',
    byteLength,
    chunkBytes,
    path: '/dsh/home/workspace/reference-edit.bin',
    oldText,
    newText,
  })
  assert.equal(edited?.ok, true, JSON.stringify(edited))
  assert.equal(edited.result.beforeBytes, byteLength)
  assert.equal(edited.result.afterBytes, byteLength - Buffer.byteLength(oldText) + Buffer.byteLength(newText))
  assert.notEqual(edited.result.beforeHash, edited.result.afterHash)
  assert.equal(typeof edited.result.operationId, 'string')
  assert.equal(typeof edited.result.revision, 'number')
  assert.equal(Object.hasOwn(edited.result, 'before'), false)
  assert.equal(Object.hasOwn(edited.result, 'after'), false)
  assert.ok(JSON.stringify(edited.result).length < 2_000, JSON.stringify(edited.result))
  assert.ok(Math.abs(edited.usage.residentBytes - initialUsage.residentBytes) < chunkBytes,
    JSON.stringify({ initialUsage, editedUsage: edited.usage }))

  const commit = apiRequests.find(request => request.path.endsWith('/commit'))
  assert.notEqual(commit, undefined)
  assert.equal(commit.body.includes('content'), false, commit.body)
  assert.equal(commit.body.includes(oldText), false, commit.body)
  assert.equal(commit.body.includes(newText), false, commit.body)
  const commitBody = JSON.parse(commit.body)
  assert.deepEqual(commitBody.changes[0], {
    path: 'reference-edit.bin',
    kind: 'file',
    hash: edited.result.afterHash,
    bytes: edited.result.afterBytes,
    mode: 0o644,
  })
  const binaryUploads = apiRequests.filter(request => request.method === 'PUT' && request.path.includes('/blob-upload/'))
  assert.ok(binaryUploads.length >= 1)
  assert.equal(binaryUploads.every(request => request.bytes > 0 && request.bytes <= 1024 * 1024), true)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const restoredUsage = await test({ action: 'usage' })
  assert.equal(restoredUsage?.ok, true, JSON.stringify(restoredUsage))
  assert.ok(Math.abs(restoredUsage.residentBytes - initialUsage.residentBytes) < chunkBytes,
    JSON.stringify({ initialUsage, restoredUsage }))
  const restoredDigest = await test({ action: 'read-digest', path: '/dsh/home/workspace/reference-edit.bin' })
  assert.deepEqual({ bytes: restoredDigest.bytes, digest: restoredDigest.digest }, {
    bytes: edited.result.afterBytes,
    digest: edited.result.afterHash,
  })
  const restoredRange = await test({ action: 'read-range', path: '/dsh/home/workspace/reference-edit.bin', offset: Math.floor(byteLength / 2), length: 8 })
  assert.equal(restoredRange?.ok, true, JSON.stringify(restoredRange))
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'reference-backed-vfs-range-edit-workspace-cas-refresh',
    byteLength,
    chunkBytes,
    edited: edited.result,
    failures,
    usageBeforeReload: edited.usage,
    usageAfterReload: restoredUsage,
    uploadCount: binaryUploads.length,
    pageErrors,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
