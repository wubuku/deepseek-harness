import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-quota-enforcement-`))
const profileDir = await mkdtemp(`${tmpdir()}/dsh-browser-quota-profile-`)
const localMarker = `quota-anchor-${crypto.randomUUID()}`
const oversizedContent = 'Q'.repeat(2 * 1024 * 1024)
const requests = []
const pageErrors = []
let image
let app
let context
let page
let cdp
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    channel: process.env.DSH_POC_BROWSER ?? 'chrome',
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
  })
  page = context.pages()[0] ?? await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/browser-native/')) {
      try { requests.push({ path: url.pathname, body: JSON.parse(request.postData() ?? '{}') }) } catch {}
    }
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  const anchor = await page.evaluate(async marker => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: '/dsh/home/workspace/quota-anchor.txt', content: marker,
  }), localMarker)
  assert.equal(anchor?.ok, true, JSON.stringify(anchor))
  const anchorFlush = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
  assert.equal(anchorFlush?.ok, true, JSON.stringify(anchorFlush))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision >= 1, undefined, { timeout: 30_000 })

  cdp = await context.newCDPSession(page)
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 256 * 1024 })
  const quotaEstimate = await page.evaluate(async () => await navigator.storage.estimate())
  const failedWrite = await page.evaluate(async content => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: '/dsh/home/workspace/quota-failure.bin', content,
  }), oversizedContent)
  assert.equal(failedWrite?.ok, false, JSON.stringify(failedWrite))
  assert.match(failedWrite?.error ?? '', /quota|space|storage/i, 'Chrome storage must reject the OPFS write with its quota failure')
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'error', undefined, { timeout: 15_000 })

  let turn
  try {
    turn = await sendTurn({
      page,
      origin,
      requests,
      prompt: 'Attempt the required file write and report the tool result. BROWSER_NATIVE_QUOTA_GUARD_E2E',
      marker: 'BROWSER_NATIVE_QUOTA_GUARD_DONE',
      timeout: 30_000,
    })
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      failure: error instanceof Error ? error.message : String(error),
      workspaceStatus: await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__),
      requestPaths: requests.map(request => request.path),
      bodyText: (await page.locator('body').innerText()).slice(-1800),
      pageErrors,
    })}\n`)
    throw error
  }
  const writeCall = turn.session.events.find(event => event.type === 'tool/call'
    && event.data.name === 'write' && event.data.arguments.includes('quota-guard-attempt.txt'))
  assert.ok(writeCall, 'the scripted Agent must attempt the file tool while local persistence is failed')
  const writeResult = turn.session.events.find(event => event.type === 'tool/result'
    && event.data.message?.toolCallId === writeCall.data.callId)
  assert.ok(writeResult)
  assert.equal(writeResult.data.message.isError, true)
  assert.match(writeResult.data.message.content.map(block => block.text ?? '').join(' '), /local Workspace persistence is unresolved/i)
  assert.match(assistantText(turn.session, turn.turn), /BROWSER_NATIVE_QUOTA_GUARD_DONE/)

  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1024 * 1024 * 1024 })
  const restoreStartedAt = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const restored = await page.evaluate(async () => ({
    anchor: await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'read', path: '/dsh/home/workspace/quota-anchor.txt' }),
    failed: await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'read', path: '/dsh/home/workspace/quota-failure.bin' }),
  }))
  assert.deepEqual({ ok: restored.anchor?.ok, content: restored.anchor?.content }, { ok: true, content: localMarker })
  assert.equal(restored.failed?.ok, false, JSON.stringify(restored.failed))
  assert.deepEqual([...app.workspaces.workspaces.get(workspaceId).entries.keys()], ['quota-anchor.txt'])
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'chrome-storage-quota-opfs-worker-guard-refresh',
    workspaceId,
    quotaEstimate,
    quotaError: failedWrite.error,
    dshFileToolBlocked: true,
    restoredCommittedAnchor: true,
    failedFileAbsentAfterRefresh: true,
    restoreMs: Date.now() - restoreStartedAt,
    durableManifestRevision: app.workspaces.workspaces.get(workspaceId)?.revision,
    pageErrors,
  })}\n`)
} finally {
  await cdp?.detach().catch(() => {})
  await page?.close().catch(() => {})
  await context?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
  await rm(profileDir, { recursive: true, force: true })
}
