import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, submitPrompt, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-product-visibility-')))

function deferred() {
  let resolvePromise
  const promise = new Promise(resolveRelease => { resolvePromise = resolveRelease })
  return { promise, resolve: resolvePromise }
}

function trackRequests(page, sink) {
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch {}
    sink.push({ path: url.pathname, method: request.method(), body })
  })
}

const holdRelease = deferred()
let holdStarted = false
const holdMarker = 'VISIBILITY_QUEUE_HOLD'
const errorMarker = 'VISIBILITY_LLM_ERROR'
const queueMarker = 'VISIBILITY_QUEUE_WAIT'

const app = await createBrowserNativeV2Server({
  dataDir,
  llmMode: 'scripted',
  admission: { maxConcurrentTurns: 1, queueTimeoutMs: 3_000 },
  testHooks: {
    scriptedLlmFault: body => {
      if (body.purpose !== undefined) return undefined
      const text = JSON.stringify(body.messages ?? [])
      if (text.includes(holdMarker)) {
        holdStarted = true
        return { kind: 'barrier-text', text: 'VISIBILITY_HOLD_RELEASED', release: holdRelease.promise }
      }
      if (text.includes(errorMarker)) {
        return { kind: 'error', code: 'UPSTREAM_LLM_AUTH_FAILED', message: 'visibility probe: upstream rejected the key' }
      }
      return undefined
    },
  },
})

const origin = await app.listen(0)
const image = await createRuntimeValidationDist({ roster: 'browser' })
const browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`

try {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Singapore', viewport: { width: 1440, height: 1000 } })
  const requestsA = []
  const pageA = await context.newPage()
  trackRequests(pageA, requestsA)
  await openPreview(pageA, previewUrl)
  await pageA.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

  const pageB = await context.newPage()
  trackRequests(pageB, [])
  await openPreview(pageB, previewUrl)
  const conflict = await waitFor(async () => {
    const status = pageB.locator('[data-browser-native-workspace-status]')
    if (await status.count() === 0) return undefined
    return (await status.getAttribute('data-state')) === 'session-conflict' ? await status.innerText() : undefined
  }, 'session lease conflict surfaced in the preview status', 30_000)
  assert.match(conflict, /This Session is open in another tab/)
  assert.match(conflict, /session is already owned by another browser/i)

  const failure = await submitPrompt({
    page: pageA,
    origin,
    requests: requestsA,
    prompt: `${errorMarker}: explain why the previous turn cannot call the model`,
    expectedReason: 'error',
    timeout: 120_000,
  })
  const failureTerminal = failure.session.events.findLast(event => event.type === 'turn/end' && event.data.turn === failure.turn)
  assert.equal(failureTerminal.data.reason.error.code, 'UPSTREAM_LLM_AUTH_FAILED')
  const codeText = await pageA.locator('[data-turn-error-code="UPSTREAM_LLM_AUTH_FAILED"]').last().innerText()
  assert.equal(codeText.trim(), 'UPSTREAM_LLM_AUTH_FAILED')
  await pageA.getByText('visibility probe: upstream rejected the key', { exact: false }).last().waitFor({ timeout: 10_000 })

  const contextB = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Singapore', viewport: { width: 1440, height: 1000 } })
  const requestsC = []
  const pageC = await contextB.newPage()
  trackRequests(pageC, requestsC)
  await openPreview(pageC, previewUrl)
  await pageC.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

  let queuedObserved = false
  const heldTurn = submitPrompt({
    page: pageA,
    origin,
    requests: requestsA,
    prompt: `${holdMarker}: wait for the release barrier`,
    timeout: 120_000,
    probeWhileRunning: async () => {
      await waitFor(async () => holdStarted, 'model barrier for a held admission slot')
      const queuedPromise = submitPrompt({
        page: pageC,
        origin,
        requests: requestsC,
        prompt: `${queueMarker}: answer while another turn holds the only slot`,
        expectedReason: 'error',
        timeout: 60_000,
      })
      await pageC.getByText(queueMarker, { exact: false }).last().waitFor({ timeout: 10_000 })
      queuedObserved = true
      const queuedResult = await queuedPromise
      const terminal = queuedResult.session.events.findLast(event => event.type === 'turn/end' && event.data.turn === queuedResult.turn)
      assert.equal(terminal.data.reason.error.code, 'ADMISSION_TIMEOUT')
      assert.match(terminal.data.reason.error.message, /queue position 1/)
      const queuedCode = await pageC.locator('[data-turn-error-code="ADMISSION_TIMEOUT"]').last().innerText()
      assert.equal(queuedCode.trim(), 'ADMISSION_TIMEOUT')
      await pageC.getByText(/queue position 1/).last().waitFor({ timeout: 10_000 })
      holdRelease.resolve()
    },
  })
  const held = await heldTurn
  assert.equal(held.session.events.findLast(event => event.type === 'turn/end' && event.data.turn === held.turn).data.reason.kind, 'completed')
  assert.equal(queuedObserved, true)

  process.stdout.write(`${JSON.stringify({
    sessionLeaseConflict: conflict,
    failureClassification: {
      code: codeText.trim(),
      message: 'visibility probe: upstream rejected the key',
      rendered: true,
    },
    admissionQueue: {
      observedWhileQueueing: queuedObserved,
      timeoutCode: 'ADMISSION_TIMEOUT',
      timeoutMessageIncludesPosition: true,
    },
  })}\n`)

  await contextB.close()
  await context.close()
} finally {
  holdRelease.resolve()
  await browser.close().catch(() => {})
  await app.close().catch(() => {})
  await image.cleanup().catch(() => {})
}
