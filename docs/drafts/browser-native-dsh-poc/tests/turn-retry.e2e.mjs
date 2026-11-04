/**
 * Retry a failed turn from the page and prove the retry settles once.
 *
 * The scripted model fails the first prompt and completes the retried prompt
 * after a delay, so the test can double-click the visible retry action, probe
 * the server-side intent while the retried turn is still running, and then
 * assert one new user message, one new model request, and one settlement.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, submitPrompt, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const image = await createRuntimeValidationDist({ roster: 'browser' })

const BOOT_PROMPT = 'TURN_RETRY_BOOT reply with READY'
const FAIL_PROMPT = 'TURN_RETRY_FAIL report the scripted failure'
const RETRY_MARKER = 'TURN_RETRY_OK'
const FAILURE_CODE = 'SCRIPTED_UI_RETRY_FAILURE'
const RETRY_DELAY_MS = 6_000

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-turn-retry-'))
let failedOnce = false
const turnPrompts = []
const app = await createBrowserNativeV2Server({
  dataDir,
  distRoot: image.distRoot,
  llmMode: 'scripted',
  testHooks: {
    scriptedLlmFault: body => {
      if (body?.purpose !== undefined) return undefined
      const latest = [...(body?.messages ?? [])].reverse().find(message => message.role === 'user'
        && typeof message.content === 'string'
        && !message.content.startsWith('Current runtime context.')
        && !message.content.startsWith('Time sampled while preparing turn'))?.content ?? ''
      turnPrompts.push(latest.slice(0, 80))
      if (!latest.includes('TURN_RETRY_FAIL')) return undefined
      if (!failedOnce) {
        failedOnce = true
        return { kind: 'error', code: FAILURE_CODE, message: 'scripted turn failure before the UI retry' }
      }
      return { kind: 'delayed-text', text: RETRY_MARKER, delayMs: RETRY_DELAY_MS }
    },
  },
})
const origin = await app.listen(0)
const browser = await chromium.launch({
  headless: true,
  ...(process.env.DSH_POC_BROWSER === 'chromium' ? {} : { channel: 'chrome' }),
})

try {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const requests = []
  page.on('request', request => {
    if (!request.url().includes('/api/browser-native/')) return
    requests.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.postDataJSON?.(),
    })
  })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await openPreview(page,
    `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced',
    undefined, { timeout: 60_000 })

  await submitPrompt({ page, origin, requests, prompt: BOOT_PROMPT, timeout: 60_000 })
  const failed = await submitPrompt({
    page, origin, requests, prompt: FAIL_PROMPT, expectedReason: 'error', timeout: 60_000,
  })
  const failedTurn = failed.turn
  const failure = failed.session.events.findLast(event => event.type === 'turn/end')
  assert.equal(failure.data.reason.kind, 'error', 'the scripted prompt must end its turn as an error')
  assert.equal(failure.data.reason.error.code, FAILURE_CODE, 'the visible failure must carry the scripted code')

  const panel = page.locator('[data-browser-native-turn-retry]')
  await panel.waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal(await panel.getAttribute('data-state'), 'failed', 'a failed turn must expose a retry action')
  const visibleMessage = await panel.locator('[data-browser-native-turn-retry-message]').innerText()
  assert.match(visibleMessage, new RegExp(`Turn ${String(failedTurn)} ended as error`),
    'the retry surface must name the failed turn and its reason')
  const retryButton = panel.locator('[data-browser-native-turn-retry-button]')
  assert.equal(await retryButton.innerText(), `Retry turn ${String(failedTurn)}`)

  await retryButton.click({ clickCount: 2, delay: 10 })
  await waitFor(async () => await panel.getAttribute('data-state') === 'submitted',
    'the retry surface reports the submitted retry', 30_000)
  const submittedMessage = await panel.locator('[data-browser-native-turn-retry-message]').innerText()
  assert.match(submittedMessage, new RegExp(`Retry submitted for turn ${String(failedTurn)}`),
    'the retry surface must confirm the submission')

  assert.equal(requests.filter(request => request.method === 'POST'
    && request.path.endsWith('/session/turn-retry')).length, 1,
    'a double click must issue exactly one retry request')
  assert.equal(requests.filter(request => request.method === 'POST'
    && request.path.endsWith('/session/turn-retry/settle')).length, 1,
    'a double click must settle the retry exactly once')

  const repeated = await sessionRequest(origin, 'turn-retry', { sessionId: failed.sessionId, turn: failedTurn })
  assert.equal(repeated.status, 200, 'a repeated retry request for the same failed turn must be accepted')
  assert.equal(repeated.created, false, 'a repeated retry request must not create a second intent')
  assert.equal(repeated.retry.turn, failedTurn)
  assert.equal(repeated.retry.prompt, FAIL_PROMPT, 'the server must replay the authoritative original prompt')
  const duplicateSettlement = await sessionRequest(origin, 'turn-retry/settle', {
    sessionId: failed.sessionId, retryId: repeated.retry.retryId,
  })
  assert.equal(duplicateSettlement.settled, false, 'a settled retry must not settle twice')

  const completed = await waitFor(async () => {
    const read = await sessionRequest(origin, 'read', { sessionId: failed.sessionId, offset: 0 })
    const terminal = (read.events ?? []).findLast?.(event => event.type === 'turn/end'
      && event.data?.turn === failedTurn + 1)
    return terminal?.data?.reason?.kind === 'completed' ? read : undefined
  }, 'the retried turn reaches completion', 60_000)
  assert.equal(assistantText(completed, failedTurn + 1).includes(RETRY_MARKER), true,
    'the retried turn must produce the scripted completion marker')
  const userMessages = completed.events.filter(event => event.type === 'user/message'
    && JSON.stringify(event.data?.content ?? '').includes('TURN_RETRY_FAIL'))
  assert.equal(userMessages.length, 2, 'the failed prompt plus its single retry must be the only user messages')
  assert.equal(turnPrompts.length, 3, 'boot, the failed turn, and one retried turn must be the only model requests')

  const ledger = await page.evaluate(async sessionId => {
    const response = await fetch(
      `/api/browser-native/session/turn-retry?sessionId=${encodeURIComponent(sessionId)}`)
    return { status: response.status, body: await response.json() }
  }, failed.sessionId)
  assert.equal(ledger.status, 200)
  assert.equal(ledger.body.retries.length, 1, 'the ledger must keep exactly one retry intent')
  assert.equal(ledger.body.retries[0].turn, failedTurn)
  assert.equal(ledger.body.retries[0].prompt, FAIL_PROMPT)
  assert.notEqual(ledger.body.retries[0].settledAt, null, 'the submitted retry must be settled')

  assert.deepEqual(pageErrors, [])
  console.log(JSON.stringify({
    sessionId: failed.sessionId,
    failedTurn,
    visibleStates: ['failed', 'submitted'],
    retryRequestsFromPage: requests.filter(request => request.method === 'POST'
      && request.path.endsWith('/session/turn-retry')).length,
    settleRequestsFromPage: requests.filter(request => request.method === 'POST'
      && request.path.endsWith('/session/turn-retry/settle')).length,
    duplicateCreated: repeated.created,
    duplicateSettled: duplicateSettlement.settled,
    modelRequests: turnPrompts.length,
    userMessages: userMessages.length,
    ledger: ledger.body.retries,
  }, null, 2))
} finally {
  await browser.close()
  await app.close()
  await rm(dataDir, { recursive: true, force: true })
  await image.cleanup()
}
