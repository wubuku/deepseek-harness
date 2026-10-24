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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-opfs-vfs-')))
const filePath = '/dsh/home/workspace/opfs-residency.bin'
const fileBytes = Number(process.env.DSH_POC_OPFS_FILE_BYTES ?? 8 * 1024 * 1024)
const byteValue = 0x5a
const pageErrors = []
let image
let app
let browser
let context
let page

if (!Number.isSafeInteger(fileBytes) || fileBytes < 1024 * 1024 || fileBytes > 64 * 1024 * 1024) {
  throw new Error('DSH_POC_OPFS_FILE_BYTES must be between 1 MiB and 64 MiB')
}

async function test(action) {
  return await page.evaluate(async request => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(request), action)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))

  const url = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await openPreview(page, url)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

  const initialUsage = await test({ action: 'usage' })
  assert.equal(initialUsage?.ok, true, JSON.stringify(initialUsage))
  const written = await test({ action: 'write-pattern', path: filePath, byteLength: fileBytes, byteValue })
  assert.equal(written?.ok, true, JSON.stringify(written))
  const residentAfterWrite = await test({ action: 'usage' })
  assert.equal(residentAfterWrite?.logicalBytes, residentAfterWrite?.bytes)
  assert.ok(residentAfterWrite.residentBytes >= initialUsage.residentBytes + fileBytes, JSON.stringify({ initialUsage, residentAfterWrite }))
  const flushed = await test({ action: 'flush-workspace' })
  assert.equal(flushed?.ok, true, JSON.stringify(flushed))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 60_000 })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const hydratedUsage = await test({ action: 'usage' })
  assert.equal(hydratedUsage?.ok, true, JSON.stringify(hydratedUsage))
  assert.ok(hydratedUsage.logicalBytes >= fileBytes, JSON.stringify(hydratedUsage))
  assert.ok(hydratedUsage.residentBytes < residentAfterWrite.residentBytes - fileBytes / 2,
    JSON.stringify({ residentAfterWrite, hydratedUsage }))
  const range = await test({ action: 'read-range', path: filePath, offset: fileBytes - 64, length: 64 })
  assert.deepEqual({ ok: range?.ok, offset: range?.offset, length: range?.length }, { ok: true, offset: fileBytes - 64, length: 64 })
  assert.equal(Buffer.from(range.base64, 'base64').equals(Buffer.alloc(64, byteValue)), true)
  const afterRangeUsage = await test({ action: 'usage' })
  assert.ok(Math.abs(afterRangeUsage.residentBytes - hydratedUsage.residentBytes) < 8192,
    JSON.stringify({ hydratedUsage, afterRangeUsage }))

  const appended = await test({ action: 'append', path: filePath, content: 'x' })
  assert.equal(appended?.ok, true, JSON.stringify(appended))
  const materializedUsage = await test({ action: 'usage' })
  assert.ok(materializedUsage.residentBytes >= hydratedUsage.residentBytes + fileBytes / 2,
    JSON.stringify({ hydratedUsage, materializedUsage }))
  const modified = await test({ action: 'read-digest', path: filePath })
  assert.equal(modified?.ok, true, JSON.stringify(modified))
  await test({ action: 'flush-workspace' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 60_000 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const finalUsage = await test({ action: 'usage' })
  assert.ok(finalUsage.residentBytes < materializedUsage.residentBytes - fileBytes / 2,
    JSON.stringify({ materializedUsage, finalUsage }))
  const finalRange = await test({ action: 'read-range', path: filePath, offset: fileBytes, length: 1 })
  assert.equal(Buffer.from(finalRange.base64, 'base64').toString('utf8'), 'x')
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'Worker-OPFS-sync-range-backing-vfs-residency',
    fileBytes,
    initialUsage,
    residentAfterWrite,
    hydratedUsage,
    afterRangeUsage,
    materializedUsage,
    finalUsage,
    rangeBytes: range.length,
    modifiedDigest: modified.digest,
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
