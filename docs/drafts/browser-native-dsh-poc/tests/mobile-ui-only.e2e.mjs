/**
 * Verify the iOS strategy: server-side Host execution with a browser that is
 * only UI. The page never starts a Worker, never calls OPFS, and completes a
 * turn through `/session/durable`; the session and transcript live on the
 * backend.
 *
 * The test runs WebKit with the iPhone 13 device descriptor and removes
 * `navigator.storage` before any page script runs, which is the effective
 * iOS constraint this strategy must survive. A completed turn therefore
 * proves the path has no Worker-storage dependency.
 *
 * Usage:
 *   node docs/drafts/browser-native-dsh-poc/tests/mobile-ui-only.e2e.mjs
 *   DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
 *     node docs/drafts/browser-native-dsh-poc/tests/mobile-ui-only.e2e.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const playwrightSpecifier = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? 'playwright'
const playwright = await import(playwrightSpecifier)
const browserTypes = { webkit: playwright.webkit, chromium: playwright.chromium }
const requestedBrowser = process.env.DSH_POC_BROWSER ?? 'webkit'
const browserType = browserTypes[requestedBrowser]
if (browserType === undefined) throw new Error(`DSH_POC_BROWSER must be webkit or chromium, got ${requestedBrowser}`)
const device = playwright.devices[process.env.DSH_POC_DEVICE ?? 'iPhone 13']
if (device === undefined) throw new Error('Playwright device descriptor is missing')

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-mobile-ui-only-'))
const app = await createBrowserNativeV2Server({
  dataDir,
  llmMode: 'scripted',
  requireLocalAuth: true,
  testHooks: {
    scriptedLlmFault: body => {
      const userText = body.messages.filter(message => message.role === 'user' && typeof message.content === 'string')
        .at(-1)?.content ?? ''
      if (!userText.includes('MOBILE APPROVAL PROBE')) return undefined
      const toolMessages = body.messages.filter(message => message.role === 'tool')
      if (toolMessages.length > 0) return { kind: 'text', text: 'MOBILE APPROVAL APPLIED' }
      return {
        kind: 'tool-call',
        call: {
          id: 'mobile-approval-write',
          name: 'write',
          arguments: { file_path: '/dsh/home/workspace/mobile-approval.txt', content: 'MOBILE_APPROVAL_BODY\n' },
        },
      }
    },
  },
})
const origin = await app.listen(0)
const courseId = `mobile-e2e-${String(Date.now())}`
let browser

try {
  browser = await browserType.launch({ headless: true })
  const context = await browser.newContext({ ...device, locale: 'en-US' })
  await context.addCookies([{
    name: 'dsh-browser-native-auth',
    value: app.authToken,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
  }])
  // The identity response sets the workspace and Session principal cookies for
  // the same browser context, which is what the durable route requires.
  const identity = await context.request.get(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(identity.status(), 200)
  const identityBody = await identity.json()
  assert.equal(typeof identityBody.workspaceId, 'string')

  await context.addInitScript(() => {
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      value: function TrackedWorker(...args) {
        window.__DSH_WORKER_REQUESTS__ = (window.__DSH_WORKER_REQUESTS__ ?? 0) + 1
        throw new Error('mobile UI-only must not start a Worker')
      },
    })
    try {
      Object.defineProperty(Navigator.prototype, 'storage', { configurable: true, get: () => undefined })
    } catch {
      // WebKit may expose storage as an own property; the absent-API check below
      // still records what the page actually observed.
    }
  })

  const page = await context.newPage()
  page.on('console', message => {
    if (message.type() === 'error') process.stdout.write(`page console error: ${message.text()}\n`)
  })
  page.on('pageerror', error => process.stdout.write(`page error: ${String(error)}\n`))
  await page.goto(`${origin}/mobile?sessionId=${encodeURIComponent(courseId)}`, { waitUntil: 'domcontentloaded' })
  assert.equal(await page.evaluate(() => window.__DSH_MOBILE_UI_ONLY__), true)
  assert.equal(await page.evaluate(() => navigator.storage === undefined), true, 'the simulated iOS browser has no OPFS API')

  const storageLabel = await page.locator('[data-mobile-storage]').innerText()
  assert.match(storageLabel, /OPFS unavailable/)
  assert.match(storageLabel, /server-side Session only/)

  const viewport = page.viewportSize()
  const sendBox = await page.locator('[data-mobile-send]').boundingBox()
  assert.ok(sendBox !== null && sendBox.x + sendBox.width <= viewport.width, 'the send button stays inside the mobile viewport')
  assert.ok(sendBox.y < viewport.height, 'the composer is visible without scrolling')

  await page.locator('[data-mobile-input]').fill('MOBILE UI ONLY PROBE')
  await page.locator('[data-mobile-send]').click()
  const assistant = page.locator('[data-mobile-role="assistant"]')
  try {
    await assistant.first().waitFor({ state: 'visible', timeout: 20_000 })
  } catch (error) {
    process.stdout.write(`page status: ${await page.locator('[data-mobile-status]').innerText()}\n`)
    process.stdout.write(`page transcript: ${await page.locator('[data-mobile-transcript]').innerText()}\n`)
    const debugSession = app.store.get(courseId)
    process.stdout.write(`server events: ${JSON.stringify(debugSession?.events.map(event => ({ type: event.type, data: event.data })) ?? [])}\n`)
    throw error
  }
  const assistantText = await assistant.first().innerText()
  assert.match(assistantText, /Browser-native DSH completed this turn/)
  assert.match(assistantText, /MOBILE UI ONLY PROBE/)

  await page.waitForFunction(() => /completed/.test(document.querySelector('[data-mobile-status]')?.textContent ?? ''), undefined, { timeout: 20_000 })
  assert.equal(await page.evaluate(() => window.__DSH_WORKER_REQUESTS__), 0, 'no Worker was constructed')

  const turnId = await page.evaluate(() => window.__DSH_LAST_TURN_ID__)
  assert.equal(typeof turnId, 'string')
  const durable = await context.request.get(`${origin}/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`)
  assert.equal(durable.status(), 200)
  const durableBody = await durable.json()
  assert.equal(durableBody.status, 'completed')

  const session = app.store.get(courseId)
  assert.ok(session !== undefined, 'the backend owns the Session')
  const assistantEvents = session.events.filter(event => event.type === 'assistant/message')
  assert.ok(assistantEvents.length >= 1, 'the transcript is a server-side Session event, not browser storage')
  const assistantContents = assistantEvents.flatMap(event => event.data?.message?.content ?? [])
    .filter(block => block.type === 'text').map(block => block.text).join('')
  assert.match(assistantContents, /MOBILE UI ONLY PROBE/)

  await page.locator('[data-mobile-input]').fill('MOBILE APPROVAL PROBE')
  await page.locator('[data-mobile-send]').click()
  const approval = page.locator('[data-mobile-approval]')
  await approval.waitFor({ state: 'visible', timeout: 20_000 })
  assert.match(await approval.innerText(), /write/)
  await approval.locator('[data-mobile-approve]').click()
  await approval.waitFor({ state: 'detached', timeout: 20_000 })
  await page.waitForFunction(() => /completed/.test(document.querySelector('[data-mobile-status]')?.textContent ?? ''), undefined, { timeout: 20_000 })
  const approvalTurnId = await page.evaluate(() => window.__DSH_LAST_TURN_ID__)
  const approvalStatus = await context.request.get(`${origin}/api/browser-native/session/durable?turnId=${encodeURIComponent(approvalTurnId)}`)
  assert.equal(approvalStatus.status(), 200)
  assert.equal((await approvalStatus.json()).status, 'completed')
  const approvalTranscript = await page.locator('[data-mobile-transcript]').innerText()
  assert.match(approvalTranscript, /MOBILE APPROVAL APPLIED/)
  const approvalSession = app.store.get(courseId)
  const approvalEvents = approvalSession.events.filter(event => event.type === 'turn/end')
  assert.equal(approvalEvents.length, 2, 'both mobile turns settle on the backend')

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: requestedBrowser,
    device: process.env.DSH_POC_DEVICE ?? 'iPhone 13',
    viewport,
    sessionId: courseId,
    turnId,
    workerRequests: 0,
    storage: 'navigator.storage absent before page scripts',
    durablePhase: durableBody.status,
    serverEventCount: session.events.length,
  })}\n`)
} finally {
  await browser?.close()
  await app.close()
  await rm(dataDir, { recursive: true, force: true })
}
