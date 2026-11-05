import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sessionRequest, submitPrompt, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-retry-panel-')))

const failMarker = 'RETRY_PANEL_FAIL'
const okMarker = 'RETRY_PANEL_OK'
const widths = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]

const app = await createBrowserNativeV2Server({
  dataDir,
  llmMode: 'scripted',
  testHooks: {
    scriptedLlmFault: body => {
      if (body.purpose !== undefined) return undefined
      const messages = body.messages ?? []
      const markerMessages = messages.filter(message => message?.role === 'user'
        && JSON.stringify(message).includes('RETRY_PANEL'))
      const text = JSON.stringify(markerMessages.at(-1) ?? body)
      if (text.includes(failMarker)) {
        return { kind: 'error', code: 'UPSTREAM_LLM_AUTH_FAILED', message: 'retry panel probe: upstream rejected the key' }
      }
      if (text.includes(okMarker)) return { kind: 'text', text: `${okMarker}: the composer still sends` }
      return undefined
    },
  },
})

const origin = await app.listen(0)
const image = await createRuntimeValidationDist({ roster: 'browser' })
const browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`

/**
 * Measure whether the retry panel covers the Send control or the composer.
 * @param {import('playwright').Page} page - Preview page.
 * @returns {Promise<object>} Rects and hit-test result.
 */
async function measure(page) {
  return await page.evaluate(() => {
    const send = [...document.querySelectorAll('button[aria-label]')]
      .find(button => /^(Send message|发送消息)$/.test(button.getAttribute('aria-label') ?? ''))
    const panel = document.querySelector('[data-browser-native-turn-retry]')
    const composer = [...document.querySelectorAll('[data-composer-input][contenteditable="true"]')].at(-1)
    if (send === undefined || panel === null || composer === undefined) return { ready: false }
    const toRect = node => {
      const rect = node.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    const overlaps = (first, second) => !(first.right <= second.left || second.right <= first.left
      || first.bottom <= second.top || second.bottom <= first.top)
    const sendRect = toRect(send)
    const panelRect = toRect(panel)
    const composerRect = toRect(composer)
    const hit = document.elementFromPoint(sendRect.left + sendRect.width / 2, sendRect.top + sendRect.height / 2)
    return {
      ready: true,
      sendRect,
      panelRect,
      composerRect,
      panelCoversSend: overlaps(panelRect, sendRect),
      panelCoversComposer: overlaps(panelRect, composerRect),
      sendHittable: hit !== null && (send.contains(hit) || hit === send),
      panelState: panel.getAttribute('data-state'),
    }
  })
}

try {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const requests = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch {}
    requests.push({ path: url.pathname, method: request.method(), body })
  })
  await openPreview(page, previewUrl)

  const failure = await submitPrompt({
    page,
    origin,
    requests,
    prompt: `${failMarker}: the retry panel must not cover the Send control`,
    expectedReason: 'error',
    timeout: 120_000,
  })
  const panel = page.locator('[data-browser-native-turn-retry]')
  await panel.waitFor({ state: 'visible', timeout: 30_000 })
  await waitFor(async () => (await panel.getAttribute('data-state')) === 'failed', 'failed retry panel', 20_000)
  await page.getByText('retry panel probe: upstream rejected the key', { exact: false }).last().waitFor({ timeout: 10_000 })

  const measurements = []
  for (const size of widths) {
    await page.setViewportSize(size)
    await page.waitForTimeout(150)
    const measured = await measure(page)
    assert.equal(measured.ready, true, `retry panel, Send and composer must exist at ${size.width}px`)
    assert.equal(measured.panelCoversSend, false, `the retry panel must not cover Send at ${size.width}px`)
    assert.equal(measured.panelCoversComposer, false, `the retry panel must not cover the composer at ${size.width}px`)
    assert.equal(measured.sendHittable, true, `Send must stay clickable at ${size.width}px`)
    measurements.push({ width: size.width, panelTop: measured.panelRect.top, panelBottom: measured.panelRect.bottom, sendTop: measured.sendRect.top })
  }

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.waitForTimeout(150)
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.fill(`${okMarker}: send with Enter while the panel is visible`)
  await composer.press('Enter')
  const sessionId = failure.sessionId
  const settled = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId })
    const userTurns = (session.events ?? []).filter(event => event.type === 'user/message'
      && JSON.stringify(event).includes(okMarker))
    if (userTurns.length === 0) return undefined
    const terminal = (session.events ?? []).findLast(event => event.type === 'turn/end'
      && JSON.stringify(event).includes('completed'))
    return terminal === undefined ? undefined : session
  }, 'a completed turn submitted with Enter after the retry panel appeared', 120_000)
  const terminal = settled.events.findLast(event => event.type === 'turn/end'
    && JSON.stringify(event).includes('completed'))
  assert.equal(JSON.stringify(terminal).includes('completed'), true)

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    scope: 'retry-panel-keeps-send-reachable',
    failureTurnError: failure.session.events.findLast(event => event.type === 'turn/end').data.reason.error.code,
    panelState: await panel.getAttribute('data-state').catch(() => null),
    widths: measurements,
    enterAfterPanel: { userMessagesWithMarker: 1, terminalCompleted: true },
    pageErrors,
  })}\n`)

  await context.close()
} finally {
  await browser.close().catch(() => {})
  await app.close().catch(() => {})
  await image.cleanup().catch(() => {})
}
