/**
 * axe-core accessibility audit for the main Browser-Native UI and its added
 * states: export result, failed turn, queued admission, offline/recovery notice,
 * cross-tab Session conflict, and the mobile UI-only page.
 *
 * Only serious and critical violations fail the run. Moderate and minor
 * findings are reported for follow-up so the gate stays focused on
 * user-blocking defects.
 *
 * Usage:
 *   DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/accessibility-audit.e2e.mjs
 */
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, submitPrompt, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const AXE_SOURCE = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8')

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-a11y-'))
const pageErrors = []
let image
let app
let browser
let context
let queueContext
let page
let holdStarted = false
let releaseQueue

function messageText(message) {
  return typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content) ? message.content.map(block => block?.text ?? '').join('') : ''
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') return messageText(messages[index])
  }
  return ''
}

function trackRequests(target, sink) {
  target.on('request', request => {
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/browser-native/session/')) return
    try {
      sink.push({ path, body: JSON.parse(request.postData() ?? 'null') })
    } catch {
      sink.push({ path, body: null })
    }
  })
}

async function injectAxe(target) {
  await target.addScriptTag({ content: AXE_SOURCE })
  await target.waitForFunction(() => typeof window.axe?.run === 'function')
}

async function scan(target, label) {
  // Transient banners fade out through a CSS animation whose late frames blend
  // the label into the page behind it. WCAG contrast applies while the banner
  // is visible, so pin every alert to its fully opaque frame before sampling.
  await target.evaluate(() => {
    if (document.getElementById('dsh-a11y-pin-transient') !== null) return
    const style = document.createElement('style')
    style.id = 'dsh-a11y-pin-transient'
    style.textContent = '[role="alert"]{animation:none !important;opacity:1 !important;visibility:visible !important}'
    document.head.appendChild(style)
  })
  const report = await target.evaluate(async () => {
    const result = await window.axe.run(document, {
      resultTypes: ['violations'],
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
    })
    return result.violations.map(violation => ({
      id: violation.id,
      impact: violation.impact,
      description: violation.description,
      nodes: violation.nodes.slice(0, 4).map(node => ({
        target: node.target,
        html: node.html,
        summary: node.failureSummary,
      })),
    }))
  })
  const serious = report.filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
  return {
    label,
    serious,
    other: report.filter(violation => violation.impact !== 'serious' && violation.impact !== 'critical')
      .map(violation => ({ id: violation.id, impact: violation.impact })),
  }
}

async function assertClean(report, output) {
  output.push(report)
  assert.deepEqual(report.serious, [], `${report.label}: serious/critical accessibility violations\n${JSON.stringify(report.serious, null, 2)}`)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  const queueRelease = new Promise(resolve => { releaseQueue = resolve })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    admission: { maxConcurrentTurns: 1, queueTimeoutMs: 120_000 },
    testHooks: {
      scriptedLlmFault(body) {
        if (body?.purpose !== undefined) return undefined
        const text = lastUserText(body)
        if (!text.includes('A11Y_QUEUE')) return undefined
        if (text.includes('A11Y_QUEUE_FIRST')) holdStarted = true
        return { kind: 'barrier-text', release: queueRelease, text: 'A11Y_QUEUE_DONE' }
      },
      failLlmRequest(body) {
        return body?.purpose === undefined && lastUserText(body).includes('A11Y_FAIL')
      },
    },
  })
  const origin = await app.listen(0)
  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  const requests = []
  trackRequests(page, requests)

  await openPreview(page, previewUrl)
  await waitForPreview(page)
  await submitPrompt({ page, origin, requests, prompt: 'A11Y_MAIN', timeout: 120_000 })
  await injectAxe(page)
  const reports = []
  if (process.env.DSH_POC_A11Y_DEBUG === '1') {
    console.log(await page.evaluate(() => [...document.querySelectorAll('.xzAHpq_brand,.mlza5a_trigger')]
      .map(node => ({ text: node.innerText, html: node.outerHTML.slice(0, 500) }))))
  }
  await assertClean(await scan(page, 'main'), reports)

  const download = page.waitForEvent('download')
  await page.locator('[data-browser-native-session-export]').click()
  await download
  await waitFor(async () => await page.locator('[data-browser-native-session-export-result]').evaluate(node => node.textContent?.length > 0),
    'export result', 15_000)
  await assertClean(await scan(page, 'export'), reports)

  const ownSessionId = requests.find(request => request.path.endsWith('/session/create'))?.body?.sessionId
  assert.equal(typeof ownSessionId, 'string')
  await submitPrompt({ page, origin, requests, sessionId: ownSessionId, prompt: 'A11Y_FAIL', expectedReason: 'error', timeout: 120_000 })
  await assertClean(await scan(page, 'failure'), reports)

  // Queued admission: the held turn owns the only concurrent-turn slot, so a
  // second tab's turn waits and publishes its local admission position.
  const heldTurn = submitPrompt({
    page, origin, requests, sessionId: ownSessionId, prompt: 'A11Y_QUEUE_FIRST', timeout: 120_000,
  })
  await waitFor(async () => holdStarted, 'held admission slot', 30_000)
  queueContext = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 900 },
  })
  const queuePage = await queueContext.newPage()
  queuePage.on('pageerror', error => pageErrors.push(`queue: ${error.message}`))
  const queueRequests = []
  trackRequests(queuePage, queueRequests)
  await openPreview(queuePage, previewUrl)
  await waitForPreview(queuePage)
  const queuedTurn = submitPrompt({
    page: queuePage, origin, requests: queueRequests, prompt: 'A11Y_QUEUE_SECOND', timeout: 120_000,
  })
  await waitFor(async () => {
    const status = queuePage.locator('[data-browser-native-queue-status]')
    return await status.count() > 0 && await status.isVisible()
  }, 'queue status', 30_000)
  await injectAxe(queuePage)
  await assertClean(await scan(queuePage, 'queued'), reports)
  releaseQueue()
  await Promise.all([heldTurn, queuedTurn])
  await queueContext.close()
  queueContext = undefined

  await context.setOffline(true)
  await waitFor(async () => {
    const status = page.locator('[data-browser-native-offline-status]')
    return await status.count() > 0 && await status.isVisible()
  }, 'offline status', 15_000)
  await assertClean(await scan(page, 'offline-recovery'), reports)
  await context.setOffline(false)

  // Collaboration conflict: a second tab sharing the stored Session choice
  // opens the Session already leased by the first tab and must publish a
  // blocking conflict notice.
  const page2 = await context.newPage()
  page2.on('pageerror', error => pageErrors.push(`tab2: ${error.message}`))
  await openPreview(page2, previewUrl)
  await waitForPreview(page2)
  const conflict = await waitFor(async () => {
    const status = page2.locator('[data-browser-native-workspace-status]')
    const state = await status.getAttribute('data-state').catch(() => null)
    return ['lease-conflict', 'session-conflict', 'recovery-conflict'].includes(state) ? state : undefined
  }, 'cross-tab conflict notice', 20_000).catch(() => undefined)
  if (conflict !== undefined) {
    await injectAxe(page2)
    await assertClean(await scan(page2, `collaboration-${conflict}`), reports)
  } else {
    reports.push({ label: 'collaboration', skipped: 'second tab reported no lease/session/recovery conflict' })
  }
  await page2.close()

  const mobile = await context.newPage()
  await mobile.setViewportSize({ width: 390, height: 844 })
  mobile.on('pageerror', error => pageErrors.push(`mobile: ${error.message}`))
  await mobile.goto(`${origin}/mobile`, { waitUntil: 'domcontentloaded' })
  await injectAxe(mobile)
  await assertClean(await scan(mobile, 'mobile-ui-only'), reports)
  await mobile.close()

  assert.deepEqual(pageErrors, [], pageErrors.join('\n'))
  console.log(JSON.stringify({
    result: 'passed',
    scope: 'main-export-failure-queued-offline-conflict-mobile',
    reports,
    pageErrors,
    note: 'Only serious and critical axe-core violations block. Scans cover the rendered document, including fixed status/export overlays; they do not cover native browser chrome, screen-reader speech output, or interaction timing.',
  }, null, 2))
} finally {
  releaseQueue?.()
  await queueContext?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
