import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(process.env.DSH_POC_REPO_ROOT ?? process.cwd())
const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-many-files-`))
const { createBrowserNativeV2Server } = await import(pathToFileURL(join(repoRoot, 'docs/drafts/browser-native-dsh-poc/backend-v2.mjs')).href)
const { createRuntimeValidationDist } = await import(pathToFileURL(join(repoRoot, 'docs/drafts/browser-native-dsh-poc/runtime-validation.mjs')).href)
const { openPreview } = await import(pathToFileURL(join(repoRoot, 'docs/drafts/browser-native-dsh-poc/tests/runtime-test-support.mjs')).href)
const fileCount = 1_000
const bytesPerFile = 256
const expectedPaths = Array.from({ length: fileCount }, (_, index) =>
  `${String(index).padStart(4, '0')}.bin`,
)
const pageErrors = []
const commitRequests = []
let image
let app
let browser
let context
let page

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (!new URL(request.url()).pathname.endsWith('/workspace/commit')) return
    let body = {}
    try { body = JSON.parse(request.postData() ?? '{}') } catch {}
    commitRequests.push({ operationId: body.operationId, changeCount: body.changes?.length })
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  const storageBefore = await page.evaluate(async () => await navigator.storage.estimate())
  const writeStartedAt = performance.now()
  const written = await page.evaluate(async input => {
    const requests = Array.from({ length: input.fileCount }, (_, index) => window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
      action: 'write',
      path: `/dsh/home/workspace/${String(index).padStart(4, '0')}.bin`,
      content: String.fromCharCode(33 + index % 80).repeat(input.bytesPerFile),
    }))
    return await Promise.all(requests)
  }, { fileCount, bytesPerFile })
  assert.equal(written.length, fileCount)
  assert.ok(written.every(result => result?.ok === true), JSON.stringify(written.find(result => result?.ok !== true)))
  const localDurableMs = performance.now() - writeStartedAt

  const commitStartedAt = performance.now()
  const flushed = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
  assert.equal(flushed?.ok, true, JSON.stringify(flushed))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 120_000 })
  const workspaceCommitMs = performance.now() - commitStartedAt
  const manifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.ok(manifest.revision >= 1)
  assert.deepEqual(manifest.entries.map(entry => entry.path).sort(), expectedPaths)
  assert.ok(commitRequests.length > 0)
  assert.equal(commitRequests.reduce((sum, request) => sum + request.changeCount, 0), fileCount)
  assert.ok(commitRequests.every(request => typeof request.operationId === 'string'))
  const storageAfter = await page.evaluate(async () => await navigator.storage.estimate())

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 90_000 })
  const restored = await page.evaluate(async paths => {
    const results = []
    for (const path of paths) {
      results.push(await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
        action: 'read', path: `/dsh/home/workspace/${path}`,
      }))
    }
    return results
  }, ['0000.bin', '0499.bin', '0999.bin'])
  assert.deepEqual(restored.map(result => ({ ok: result?.ok, content: result?.content })), [0, 499, 999].map(index => ({
    ok: true,
    content: String.fromCharCode(33 + index % 80).repeat(bytesPerFile),
  })))
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    browserVersion: await browser.version(),
    fileCount,
    bytesPerFile,
    totalBytes: fileCount * bytesPerFile,
    localDurableMs,
    workspaceCommitMs,
    workspaceRevision: manifest.revision,
    commitRequests,
    storageBefore,
    storageAfter,
    restoredSampleCount: restored.length,
    pageErrors,
  })}\n`)
} finally {
  await context?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
