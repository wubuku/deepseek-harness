import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-bfcache-')))
let image
let app
let browser
let context
let page

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  await writeFile(join(image.distRoot, 'lifecycle-return.html'), '<!doctype html><meta charset="utf-8"><title>Lifecycle return</title><a href="/preview.html">Return</a>')
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: { workspaceWriterLeaseMs: 30_000 },
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({
    headless: true,
    channel: process.env.DSH_POC_BROWSER ?? 'chrome',
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
  })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  await context.addInitScript(() => {
    if (location.pathname !== '/preview.html') return
    const key = '__dshLifecycleEvents'
    const read = () => {
      try {
        const value = JSON.parse(sessionStorage.getItem(key) ?? '[]')
        return Array.isArray(value) ? value : []
      } catch {
        return []
      }
    }
    const record = (type, persisted) => {
      const events = read()
      events.push({ type, persisted, at: performance.now() })
      sessionStorage.setItem(key, JSON.stringify(events))
    }
    addEventListener('pagehide', event => record('pagehide', event.persisted))
    addEventListener('pageshow', event => record('pageshow', event.persisted))
  })
  page = await context.newPage()
  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await page.goto(previewUrl, { waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const before = await page.evaluate(async () => ({
    lease: await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }),
    locks: (await navigator.locks.query()).held?.map(lock => lock.name).sort() ?? [],
    workerPortReady: typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function',
  }))
  await page.goto(`${origin}/lifecycle-return.html`, { waitUntil: 'domcontentloaded' })
  await page.goBack({ waitUntil: 'commit', timeout: 20_000 })
  await page.waitForFunction(() => location.pathname === '/preview.html'
    && JSON.parse(sessionStorage.getItem('__dshLifecycleEvents') ?? '[]').some(event => event.type === 'pageshow'), undefined, { timeout: 30_000 })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  const after = await page.evaluate(async () => ({
    events: JSON.parse(sessionStorage.getItem('__dshLifecycleEvents') ?? '[]'),
    navigationType: performance.getEntriesByType('navigation')[0]?.type,
    notRestoredReasons: performance.getEntriesByType('navigation')[0]?.notRestoredReasons ?? null,
    lease: await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }),
    locks: (await navigator.locks.query()).held?.map(lock => lock.name).sort() ?? [],
    workerPortReady: typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function',
  }))
  const persistedShow = after.events.findLast(event => event.type === 'pageshow')
  const persistedHide = after.events.findLast(event => event.type === 'pagehide')
  const result = persistedShow?.persisted === true
    ? 'passed'
    : 'not-verified'
  if (result === 'passed') {
    assert.equal(persistedHide?.persisted, true)
    assert.equal(after.navigationType, 'back_forward')
    assert.equal(after.workerPortReady, true)
    assert.deepEqual(after.locks, before.locks)
    assert.equal(after.lease?.writerToken, before.lease?.writerToken)
    assert.equal(after.lease?.fencingToken, before.lease?.fencingToken)
  }
  const summary = {
    result,
    browser: browser.version(),
    scope: 'real-Chrome-back-forward-navigation-BFCache-evidence',
    pagehidePersisted: persistedHide?.persisted ?? null,
    pageshowPersisted: persistedShow?.persisted ?? null,
    navigationType: after.navigationType ?? null,
    notRestoredReasons: after.notRestoredReasons,
    workerPortReady: after.workerPortReady,
    recoveryLockCountBefore: before.locks.length,
    recoveryLockCountAfter: after.locks.length,
    workspaceFencingTokenUnchanged: after.lease?.fencingToken === before.lease?.fencingToken,
    note: result === 'passed'
      ? 'Chrome restored the same live Worker lease from BFCache.'
      : 'This run did not demonstrate a BFCache restore; no lifecycle continuity claim is made.',
  }
  if (process.env.DSH_POC_RESULT_FILE !== undefined) {
    const { writeFile: saveResult } = await import('node:fs/promises')
    await saveResult(resolve(process.env.DSH_POC_RESULT_FILE), `${JSON.stringify(summary, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} finally {
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
