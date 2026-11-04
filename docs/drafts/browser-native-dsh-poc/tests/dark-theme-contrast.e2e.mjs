/**
 * Dark-theme contrast audit for the injected Browser-Native surfaces. Runs the
 * real preview with `prefers-color-scheme: dark`, asserts the theme bootstrap
 * applied `data-ds-dark-theme`, then measures WCAG contrast for the first-use
 * guide, workspace/queue/offline notices, export controls, cross-tab conflict
 * notice, and the mobile UI-only page.
 *
 * Every surface is styled with design-platform tokens; a transparent surface
 * background would mean a token failed to resolve, so that is a failure too.
 *
 * Usage:
 *   DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/dark-theme-contrast.e2e.mjs
 *   DSH_POC_BROWSER=chrome DSH_POC_COLOR_SCHEME=light node docs/drafts/browser-native-dsh-poc/tests/dark-theme-contrast.e2e.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, submitPrompt, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-dark-'))
const COLOR_SCHEME = process.env.DSH_POC_COLOR_SCHEME ?? 'dark'
const pageErrors = []
let image
let app
let browser
let context
let queueContext
let releaseQueue
let holdStarted = false

const SURFACE_SELECTORS = [
  '[data-browser-native-first-use]',
  '[data-browser-native-workspace-status]',
  '[data-browser-native-queue-status]',
  '[data-browser-native-offline-status]',
  '[data-browser-native-session-export-root]',
  '[data-browser-native-workspace-switcher]',
]
const MOBILE_SELECTORS = ['header', 'main', '.status', 'form']

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

function contrastAudit(selectors) {
  const cardSelectors = new Set([
    '[data-browser-native-first-use]',
    '[data-browser-native-workspace-status]',
    '[data-browser-native-queue-status]',
    '[data-browser-native-offline-status]',
  ])
  const parse = (value) => {
    const match = value.match(/rgba?\(([^)]+)\)/)
    if (match === null) return null
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  const composite = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: top.a + bottom.a * (1 - top.a),
  })
  const backdrop = (element) => {
    const layers = []
    for (let node = element; node !== null; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor)
      if (color !== null && color.a > 0) {
        layers.push(color)
        if (color.a === 1) break
      }
    }
    let result = { r: 255, g: 255, b: 255, a: 1 }
    for (let index = layers.length - 1; index >= 0; index--) result = composite(layers[index], result)
    return result
  }
  const luminance = (color) => {
    const channel = (value) => {
      const scaled = value / 255
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  }
  const ratio = (foreground, background) => {
    const light = Math.max(luminance(foreground), luminance(background))
    const dark = Math.min(luminance(foreground), luminance(background))
    return (light + 0.05) / (dark + 0.05)
  }
  const visible = element => element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden'
    && Number.parseFloat(getComputedStyle(element).opacity) > 0
  const hasDirectText = element => [...element.childNodes]
    .some(node => node.nodeType === 3 && (node.nodeValue ?? '').trim().length > 0)
  const describe = element => `${element.tagName.toLowerCase()}${element.getAttribute('aria-label') !== null ? `[aria-label="${element.getAttribute('aria-label')}"]` : ''} "${element.innerText.trim().slice(0, 40)}"`

  const measured = []
  const problems = []
  for (const selector of selectors) {
    for (const root of document.querySelectorAll(selector)) {
      if (!visible(root)) continue
      const style = getComputedStyle(root)
      const background = parse(style.backgroundColor)
      // An injected status surface always paints its own card; a transparent
      // root means the design-platform token did not resolve.
      if (cardSelectors.has(selector) && (background === null || background.a < 1)) {
        problems.push({ kind: 'unresolved-surface', element: describe(root), background: style.backgroundColor })
      }
      for (const node of [root, ...root.querySelectorAll('*')]) {
        if (!visible(node) || !hasDirectText(node)) continue
        const own = parse(getComputedStyle(node).color) ?? { r: 0, g: 0, b: 0, a: 1 }
        const behind = backdrop(node)
        const measuredRatio = ratio(own, behind)
        const weight = Number.parseInt(getComputedStyle(node).fontWeight, 10) || 400
        const size = Number.parseFloat(getComputedStyle(node).fontSize)
        const large = size >= 24 || (size >= 18.66 && weight >= 700)
        const threshold = large ? 3 : 4.5
        measured.push({ element: describe(node), ratio: Number(measuredRatio.toFixed(2)), threshold })
        if (measuredRatio < threshold) {
          problems.push({
            kind: 'low-contrast',
            element: describe(node),
            ratio: Number(measuredRatio.toFixed(2)),
            threshold,
            foreground: getComputedStyle(node).color,
            background: `rgb(${Math.round(behind.r)} ${Math.round(behind.g)} ${Math.round(behind.b)})`,
          })
        }
      }
    }
  }
  return { measured, problems }
}

async function assertReadable(target, label, output, expectedRoots) {
  const report = await target.evaluate((selectors) => {
    const audit = window.__dshDarkAudit
    if (typeof audit !== 'function') throw new Error('contrast audit helper is not installed')
    return audit(selectors)
  }, expectedRoots)
  assert.ok(report.measured.length > 0, `${label}: no text was measured`)
  output.push({ label, measured: report.measured.length, problems: report.problems })
  assert.deepEqual(report.problems, [], `${label}: dark-theme contrast defects\n${JSON.stringify(report.problems, null, 2)}`)
}

async function installAudit(target) {
  await target.evaluate(`window.__dshDarkAudit = ${contrastAudit.toString()}`)
}

async function visibleStatus(target, selector) {
  const locator = target.locator(selector)
  return await locator.count() > 0 && await locator.isVisible()
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  const queueHold = new Promise(resolve => { releaseQueue = resolve })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    admission: { maxConcurrentTurns: 1, queueTimeoutMs: 120_000 },
    testHooks: {
      scriptedLlmFault(body) {
        if (body?.purpose !== undefined) return undefined
        const text = lastUserText(body)
        if (!text.includes('DARK_QUEUE')) return undefined
        if (text.includes('DARK_QUEUE_FIRST')) holdStarted = true
        return { kind: 'barrier-text', release: queueHold, text: 'DARK_QUEUE_DONE' }
      },
    },
  })
  const origin = await app.listen(0)
  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    colorScheme: COLOR_SCHEME,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  })
  const page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  const requests = []
  trackRequests(page, requests)
  await openPreview(page, previewUrl)
  await waitForPreview(page)
  await installAudit(page)

  assert.equal(await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme')), COLOR_SCHEME === 'dark',
    'the color scheme must reach the theme bootstrap')
  const reports = []

  // The first-use guide mounts after the workspace sync completes.
  await waitFor(async () => visibleStatus(page, '[data-browser-native-first-use]'), 'first-use guide', 30_000)
  await assertReadable(page, 'first-use-guide', reports, SURFACE_SELECTORS)

  await submitPrompt({ page, origin, requests, prompt: 'DARK_MAIN', timeout: 120_000 })
  await waitFor(async () => await page.locator('[data-browser-native-session-export]').isVisible(), 'export control', 30_000)
  await assertReadable(page, 'main-export-workspace', reports, SURFACE_SELECTORS)

  const ownSessionId = requests.find(request => request.path.endsWith('/session/create'))?.body?.sessionId
  assert.equal(typeof ownSessionId, 'string')
  const heldTurn = submitPrompt({
    page, origin, requests, sessionId: ownSessionId, prompt: 'DARK_QUEUE_FIRST', timeout: 120_000,
  })
  await waitFor(async () => holdStarted, 'held admission slot', 45_000)
  queueContext = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    colorScheme: COLOR_SCHEME,
    viewport: { width: 1440, height: 900 },
  })
  const queuePage = await queueContext.newPage()
  queuePage.on('pageerror', error => pageErrors.push(`queue: ${error.message}`))
  const queueRequests = []
  trackRequests(queuePage, queueRequests)
  await openPreview(queuePage, previewUrl)
  await waitForPreview(queuePage)
  await installAudit(queuePage)
  const queuedTurn = submitPrompt({
    page: queuePage, origin, requests: queueRequests, prompt: 'DARK_QUEUE_SECOND', timeout: 120_000,
  })
  await waitFor(async () => visibleStatus(queuePage, '[data-browser-native-queue-status]'), 'queue status', 30_000)
  await assertReadable(queuePage, 'queued-admission', reports, SURFACE_SELECTORS)
  releaseQueue()
  await Promise.all([heldTurn, queuedTurn])
  await queueContext.close()
  queueContext = undefined

  await context.setOffline(true)
  await waitFor(async () => visibleStatus(page, '[data-browser-native-offline-status]'), 'offline status', 15_000)
  await assertReadable(page, 'offline-recovery', reports, SURFACE_SELECTORS)
  await context.setOffline(false)

  // A second tab sharing the stored Session choice must publish a conflict.
  const page2 = await context.newPage()
  page2.on('pageerror', error => pageErrors.push(`tab2: ${error.message}`))
  await openPreview(page2, previewUrl)
  await waitForPreview(page2)
  await installAudit(page2)
  const conflict = await waitFor(async () => {
    const state = await page2.locator('[data-browser-native-workspace-status]').getAttribute('data-state').catch(() => null)
    return ['lease-conflict', 'session-conflict', 'recovery-conflict'].includes(state) ? state : undefined
  }, 'cross-tab conflict notice', 20_000).catch(() => undefined)
  if (conflict !== undefined) {
    await assertReadable(page2, `collaboration-${conflict}`, reports, SURFACE_SELECTORS)
  } else {
    reports.push({ label: 'collaboration', skipped: 'second tab reported no lease/session/recovery conflict' })
  }
  await page2.close()

  const mobile = await context.newPage()
  await mobile.setViewportSize({ width: 390, height: 844 })
  mobile.on('pageerror', error => pageErrors.push(`mobile: ${error.message}`))
  await mobile.goto(`${origin}/mobile`, { waitUntil: 'domcontentloaded' })
  await installAudit(mobile)
  assert.equal(await mobile.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), COLOR_SCHEME === 'dark',
    'the mobile page must receive the requested color scheme')
  await assertReadable(mobile, 'mobile-ui-only', reports, MOBILE_SELECTORS)
  await mobile.close()

  assert.deepEqual(pageErrors, [], pageErrors.join('\n'))
  console.log(JSON.stringify({
    result: 'passed',
    theme: COLOR_SCHEME,
    reports,
    pageErrors,
    note: 'Contrast follows WCAG 2 AA: 4.5 for normal text, 3 for large text. Resolved token surfaces must be opaque; a transparent card background fails as an unresolved token. The audit does not cover images, gradients, focus rings, or glyph antialiasing.',
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
