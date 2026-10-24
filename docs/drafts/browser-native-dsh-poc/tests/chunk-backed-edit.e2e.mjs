import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-chunk-edit-')))
const byteLength = Number(process.env.DSH_POC_CHUNK_EDIT_BYTES ?? 64 * 1024 * 1024)
const chunkBytes = Number(process.env.DSH_POC_CHUNK_EDIT_CHUNK_BYTES ?? 1024 * 1024)
const oldText = 'BROWSER_TARGET_MARKER'
const newText = 'BROWSER_TARGET_REPLACED_WITH_A_LONGER_MARKER'
const failureStages = ['copy-prefix', 'copy-suffix', 'write-replacement', 'truncate', 'hash', 'publish']
const pageErrors = []
let image
let app
let browser
let context
let page

async function test(action) {
  return await page.evaluate(async request => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(request), action)
}

try {
  assert.ok(Number.isSafeInteger(byteLength) && byteLength >= 1024 * 1024 && byteLength <= 128 * 1024 * 1024)
  assert.ok(Number.isSafeInteger(chunkBytes) && chunkBytes >= 1024 && chunkBytes <= 16 * 1024 * 1024)
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

  const successful = await test({
    action: 'chunk-edit-probe', byteLength, chunkBytes, oldText, newText,
  })
  assert.equal(successful?.ok, true, JSON.stringify(successful))
  assert.equal(successful.sourceHash === successful.resultHash, false, JSON.stringify(successful))
  assert.equal(successful.resultHash, successful.verifiedHash, JSON.stringify(successful))
  assert.equal(successful.resultBytes, byteLength - Buffer.byteLength(oldText) + Buffer.byteLength(newText))
  assert.ok(successful.maxWorkingBytes <= chunkBytes + Buffer.byteLength(newText), JSON.stringify(successful))
  assert.ok(successful.readCalls > 0 && successful.writeCalls > 0, JSON.stringify(successful))
  assert.ok(successful.bytesWritten >= successful.resultBytes, JSON.stringify(successful))

  const failures = []
  for (const failStage of failureStages) {
    const result = await test({ action: 'chunk-edit-probe', byteLength, chunkBytes, oldText, newText, failStage })
    assert.equal(result?.ok, false, JSON.stringify({ failStage, result }))
    assert.equal(result.sourceUnchanged, true, JSON.stringify({ failStage, result }))
    assert.equal(result.sourceHash, result.afterFailureHash, JSON.stringify({ failStage, result }))
    failures.push({ failStage, failure: result.failure, sourceUnchanged: result.sourceUnchanged })
  }
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'real-chrome-worker-opfs-bounded-memory-copy-on-write-edit',
    byteLength,
    chunkBytes,
    oldText,
    newText,
    successful,
    failures,
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
