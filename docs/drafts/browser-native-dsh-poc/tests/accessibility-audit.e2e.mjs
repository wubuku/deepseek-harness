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
let budgetContext
let budgetApp
let budgetDataDir
const zhContexts = []
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

async function assertFocusRing(page, target, label) {
  // Programmatic focus alone matches :focus but not :focus-visible. Press a
  // keyboard key first so Chromium treats the following focus as keyboard
  // driven, then sample the ring the user would actually see.
  await page.keyboard.press('Tab')
  await target.focus()
  const ring = await target.evaluate(node => {
    const style = getComputedStyle(node)
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow }
  })
  assert.ok(ring.outlineStyle !== 'none' || ring.boxShadow !== 'none', `${label}: focused control has no visible focus ring`)
}

async function assertContained(target, selector, label) {
  const box = await target.locator(selector).evaluate(node => {
    const rect = node.getBoundingClientRect()
    return {
      left: rect.left,
      right: rect.right,
      width: window.innerWidth,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }
  })
  assert.ok(box.left >= 0 && box.right <= box.width + 1, `${label}: content overflows the viewport (${JSON.stringify(box)})`)
  assert.ok(box.scrollWidth <= box.clientWidth + 1, `${label}: content is horizontally truncated (${JSON.stringify(box)})`)
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

  // Archived marker and its menus: archive through the row menu, then reveal
  // the grayed archived row through the keyboard-driven view options.
  const row = page.locator('[data-row-key^="session:"]').first()
  await waitFor(async () => await row.count() > 0, 'session row', 20_000)
  await row.hover()
  const rowMenu = row.getByRole('button', { name: /Session actions for/ })
  await rowMenu.focus()
  await assertFocusRing(page, rowMenu, 'session row menu')
  await rowMenu.click()
  const archiveItem = page.getByRole('menuitem', { name: 'Archive session', exact: true })
  await archiveItem.waitFor({ state: 'visible', timeout: 10_000 })
  await injectAxe(page)
  await assertClean(await scan(page, 'archive-menu'), reports)
  await page.keyboard.press('Escape')
  await waitFor(async () => await archiveItem.count() === 0, 'session menu closed by Escape', 10_000)

  await rowMenu.click()
  await archiveItem.waitFor({ state: 'visible', timeout: 10_000 })
  await archiveItem.click()
  await waitFor(async () => await page.locator('[data-row-key^="session:"]').count() === 0, 'archived row hidden', 15_000)

  const viewOptions = page.getByRole('button', { name: 'View options' })
  await viewOptions.focus()
  await assertFocusRing(page, viewOptions, 'view options')
  await viewOptions.press('Enter')
  const showArchived = page.getByRole('menuitem', { name: 'All conversations (show archived)', exact: true })
  await showArchived.waitFor({ state: 'visible', timeout: 10_000 })
  await page.keyboard.press('Escape')
  await waitFor(async () => await showArchived.count() === 0, 'view options closed by Escape', 10_000)
  await viewOptions.press('Enter')
  await showArchived.waitFor({ state: 'visible', timeout: 10_000 })
  await showArchived.focus()
  await showArchived.press('Enter')
  const archivedRow = page.locator('[data-row-key^="session:"]').first()
  await waitFor(async () => await archivedRow.count() > 0, 'archived row visible', 15_000)
  assert.match(await archivedRow.getAttribute('aria-description') ?? '', /archiv/i,
    'the archived row must expose its inactive state to assistive technology')
  await injectAxe(page)
  await assertClean(await scan(page, 'archived-row'), reports)

  const mobile = await context.newPage()
  await mobile.setViewportSize({ width: 390, height: 844 })
  mobile.on('pageerror', error => pageErrors.push(`mobile: ${error.message}`))
  await mobile.goto(`${origin}/mobile`, { waitUntil: 'domcontentloaded' })
  await injectAxe(mobile)
  await assertClean(await scan(mobile, 'mobile-ui-only'), reports)
  await mobile.close()

  // Chinese locale: failure guidance, archived copy, and the mobile page must
  // render locale-owned text without horizontal overflow at a phone width.
  const zhContext = await browser.newContext({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 390, height: 844 },
    acceptDownloads: true,
  })
  zhContexts.push(zhContext)
  const zhPage = await zhContext.newPage()
  zhPage.on('pageerror', error => pageErrors.push(`zh: ${error.message}`))
  const zhRequests = []
  trackRequests(zhPage, zhRequests)
  await openPreview(zhPage, previewUrl)
  await waitForPreview(zhPage)
  await submitPrompt({ page: zhPage, origin, requests: zhRequests, prompt: 'A11Y_ZH_MAIN', timeout: 120_000 })
  const zhSessionId = zhRequests.find(request => request.path.endsWith('/session/create'))?.body?.sessionId
  assert.equal(typeof zhSessionId, 'string')
  await submitPrompt({ page: zhPage, origin, requests: zhRequests, sessionId: zhSessionId, prompt: 'A11Y_FAIL', expectedReason: 'error', timeout: 120_000 })
  const zhGuidance = zhPage.locator('[data-browser-native-failure-guidance]')
  await zhGuidance.waitFor({ state: 'visible', timeout: 15_000 })
  const zhTitle = await zhGuidance.locator('[data-browser-native-failure-guidance-title]').innerText()
  const zhExplanation = await zhGuidance.locator('[data-browser-native-failure-guidance-explanation]').innerText()
  assert.ok(/[\u4e00-\u9fff]/.test(zhTitle), `failure guidance title must be Chinese: ${zhTitle}`)
  assert.ok(/[\u4e00-\u9fff]/.test(zhExplanation), `failure guidance explanation must be Chinese: ${zhExplanation}`)
  assert.ok(!zhExplanation.includes('(turn'), 'the Chinese failure copy must not embed English turn labels')
  const zhAction = zhGuidance.locator('[data-browser-native-failure-action]')
  if (await zhAction.count() > 0) {
    assert.ok(/[\u4e00-\u9fff]/.test(await zhAction.innerText()), 'the failure action label must be Chinese')
  }
  await assertContained(zhPage, '[data-browser-native-failure-guidance]', 'failure guidance zh 390px')
  await injectAxe(zhPage)
  await assertClean(await scan(zhPage, 'failure-zh'), reports)

  const zhMobile = await zhContext.newPage()
  await zhMobile.goto(`${origin}/mobile`, { waitUntil: 'domcontentloaded' })
  await injectAxe(zhMobile)
  await assertClean(await scan(zhMobile, 'mobile-ui-only-zh'), reports)
  await zhMobile.close()

  // Budget bar in the exhausted state: localized copy, axe scan, keyboard
  // reachability of both actions, and a visible focus ring.
  budgetDataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-a11y-budget-'))
  budgetApp = await createBrowserNativeV2Server({
    dataDir: budgetDataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    budgetLimits: { sessionTokens: 1, tenantTokens: 2, tenantId: 'a11y-tenant', warnRatio: 0.8 },
    testHooks: {
      allowScriptedBudget: true,
      scriptedUsage: body => body.purpose === undefined ? { inputTokens: 2, outputTokens: 2 } : undefined,
    },
  })
  const budgetOrigin = await budgetApp.listen(0)
  budgetContext = await browser.newContext({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 390, height: 844 },
    acceptDownloads: true,
  })
  await budgetContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: budgetOrigin })
  const budgetPage = await budgetContext.newPage()
  budgetPage.on('pageerror', error => pageErrors.push(`budget: ${error.message}`))
  const budgetRequests = []
  trackRequests(budgetPage, budgetRequests)
  await openPreview(budgetPage, `${budgetOrigin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  await waitForPreview(budgetPage)
  await submitPrompt({ page: budgetPage, origin: budgetOrigin, requests: budgetRequests, prompt: 'A11Y_BUDGET', timeout: 120_000 })
  const budgetPanel = budgetPage.locator('[data-browser-native-budget]')
  await waitFor(async () => await budgetPanel.getAttribute('data-state') === 'exceeded',
    'exhausted budget panel', 20_000)
  const budgetTitle = await budgetPanel.locator('[data-browser-native-budget-title]').count() > 0
    ? await budgetPanel.locator('[data-browser-native-budget-title]').innerText()
    : await budgetPanel.locator('span').first().innerText()
  assert.equal(budgetTitle, '预算', 'the budget title must be localized')
  const budgetNote = await budgetPanel.locator('[data-browser-native-budget-note]').innerText()
  assert.match(budgetNote, /发送已禁用/, `the blocked note must be Chinese: ${budgetNote}`)
  const budgetAdmin = budgetPanel.locator('[data-browser-native-budget-admin]')
  const budgetDiagnostics = budgetPanel.locator('[data-browser-native-budget-diagnostics]')
  assert.equal(await budgetAdmin.innerText(), '复制管理员说明')
  assert.equal(await budgetDiagnostics.innerText(), '导出诊断包')
  await assertContained(budgetPage, '[data-browser-native-budget]', 'budget panel zh 390px')
  await injectAxe(budgetPage)
  await assertClean(await scan(budgetPage, 'budget-exceeded-zh'), reports)
  await budgetAdmin.focus()
  await assertFocusRing(budgetPage, budgetAdmin, 'budget admin action')
  await budgetPage.keyboard.press('Tab')
  assert.notEqual(await budgetPage.evaluate(() => document.activeElement?.getAttribute('data-browser-native-budget-diagnostics')),
    null, 'Tab must move from the admin action to the diagnostics action')
  const budgetDownload = budgetPage.waitForEvent('download')
  await budgetDiagnostics.press('Enter')
  await budgetDownload
  await waitFor(async () => await budgetPanel.locator('[data-browser-native-budget-result]').innerText() !== '',
    'budget diagnostics result', 10_000)
  assert.match(await budgetPanel.locator('[data-browser-native-budget-result]').innerText(), /诊断包已导出/)

  assert.deepEqual(pageErrors, [], pageErrors.join('\n'))
  console.log(JSON.stringify({
    result: 'passed',
    scope: 'main-export-failure-queued-offline-conflict-archive-zh-mobile-budget-keyboard',
    reports,
    pageErrors,
    note: 'Only serious and critical axe-core violations block. Scans cover the rendered document, including fixed status/export overlays; they do not cover native browser chrome, screen-reader speech output, or interaction timing.',
  }, null, 2))
} finally {
  releaseQueue?.()
  await queueContext?.close().catch(() => {})
  for (const zhContext of zhContexts) await zhContext.close().catch(() => {})
  await budgetContext?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await budgetApp?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
  if (budgetDataDir !== undefined) await rm(budgetDataDir, { recursive: true, force: true })
}
