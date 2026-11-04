/**
 * Offline and reconnect behavior for the browser-native DSH preview.
 *
 * The page reports `offline` in its own banner, the Worker holds Session requests
 * in a retry queue instead of failing them, and reconnection replays the same
 * append request id so the log receives the turn once. The test asserts the
 * visible banner states, that no append reaches the backend while offline, and
 * that exactly one append and one user message exist after reconnecting.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright

const image = await createRuntimeValidationDist({ roster: 'browser' })
const BASELINE_PROMPT = 'BROWSER_NATIVE_OFFLINE_BASELINE warm the session'
const BASELINE_MARKER = 'BROWSER_NATIVE_OFFLINE_BASELINE_DONE'
const OFFLINE_PROMPT = 'BROWSER_NATIVE_OFFLINE_RECONNECT queue this turn while offline'
const OFFLINE_MARKER = 'BROWSER_NATIVE_OFFLINE_RECONNECT_DONE'
const OFFLINE_STATUS_SELECTOR = '[data-browser-native-offline-status]'

function eventText(event) {
  const content = event?.payload?.content ?? event?.data?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n')
}

function latestUserText(body) {
  return [...(body?.messages ?? [])].reverse()
    .filter(message => message.role === 'user')
    .map(message => typeof message.content === 'string' ? message.content : '')
    .find(text => !text.startsWith('Current runtime context.')
      && !text.startsWith('Time sampled while preparing turn')) ?? ''
}

function scriptedFault(body) {
  if (body?.purpose === 'session-title' || body?.purpose === 'compaction') return undefined
  const text = latestUserText(body)
  if (text.includes('BROWSER_NATIVE_OFFLINE_BASELINE')) return { kind: 'text', text: BASELINE_MARKER }
  if (text.includes('BROWSER_NATIVE_OFFLINE_RECONNECT')) return { kind: 'text', text: OFFLINE_MARKER }
  return { kind: 'text', text: 'BROWSER_NATIVE_OFFLINE_DEFAULT_DONE' }
}

async function readOfflineStatus(page) {
  return await page.evaluate(selector => {
    const element = document.querySelector(selector)
    if (element === null) return { present: false, hidden: true, state: 'missing', queued: 0 }
    return {
      present: true,
      hidden: element instanceof HTMLElement ? element.hidden : false,
      state: element.getAttribute('data-state') ?? 'missing',
      queued: Number(element.getAttribute('data-queued') ?? 0),
    }
  }, OFFLINE_STATUS_SELECTOR)
}

function appendUserMessageCount(requests, marker) {
  let count = 0
  for (const request of requests) {
    if (!request.path.endsWith('/session/append')) continue
    const events = Array.isArray(request.body?.events) ? request.body.events : []
    count += events.filter(event => event.type === 'user/message'
      && JSON.stringify(event).includes(marker)).length
  }
  return count
}

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-offline-reconnect-'))
const app = await createBrowserNativeV2Server({
  dataDir,
  distRoot: image.distRoot,
  llmMode: 'scripted',
  testHooks: { scriptedLlmFault: scriptedFault },
})
const origin = await app.listen(0)
const browser = await chromium.launch({
  headless: true,
  ...(process.env.DSH_POC_BROWSER === 'chromium' ? {} : { channel: 'chrome' }),
})
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const requests = []
const pageErrors = []
page.on('request', request => {
  if (!request.url().includes('/api/browser-native/')) return
  requests.push({
    path: new URL(request.url()).pathname,
    method: request.method(),
    body: request.postDataJSON?.() ?? undefined,
  })
})
page.on('pageerror', error => pageErrors.push(error.message))

try {
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  const baseline = await sendTurn({
    page, origin, requests,
    prompt: BASELINE_PROMPT, marker: BASELINE_MARKER, timeout: 120_000,
  })

  await context.setOffline(true)
  await waitFor(async () => {
    const status = await readOfflineStatus(page)
    return status.present && !status.hidden && status.state === 'offline' ? status : undefined
  }, 'offline banner', 20_000)
  const offlineBanner = await readOfflineStatus(page)
  assert.equal(offlineBanner.state, 'offline')

  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(OFFLINE_PROMPT)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const queuedBanner = await waitFor(async () => {
    const status = await readOfflineStatus(page)
    return status.state === 'offline' && status.queued >= 1 ? status : undefined
  }, 'queued offline request', 30_000)
  assert.equal(queuedBanner.queued >= 1, true)
  assert.equal(appendUserMessageCount(requests, 'BROWSER_NATIVE_OFFLINE_RECONNECT'), 0,
    'a queued append must not reach the backend while offline')

  await context.setOffline(false)
  const recovered = await waitFor(async () => {
    const current = await sessionRequest(origin, 'read', { sessionId: baseline.sessionId, offset: 0 })
    const user = current.events.filter(event => event.type === 'user/message' && eventText(event).includes(OFFLINE_PROMPT))
    if (user.length === 0) return undefined
    const terminal = current.events.findLast(event => event.type === 'turn/end'
      && typeof event.data?.turn === 'number' && event.data.turn > baseline.turn)
    return terminal === undefined ? undefined : { session: current, user, terminal }
  }, 'offline turn replay', 120_000)

  assert.equal(recovered.user.length, 1, 'the replayed append must persist exactly one user message')
  assert.equal(recovered.terminal.data.reason.kind, 'completed')
  const assistant = recovered.session.events
    .filter(event => event.type === 'assistant/message' && event.data?.turn === recovered.terminal.data.turn)
    .flatMap(event => event.data.message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  assert.equal(assistant.includes(OFFLINE_MARKER), true, 'the replayed turn must run once and finish')
  const appendCount = appendUserMessageCount(requests, 'BROWSER_NATIVE_OFFLINE_RECONNECT')
  assert.equal(appendCount, 1, `the replayed turn must append one user message, appended ${String(appendCount)}`)
  const seqs = recovered.session.events.map(event => event.seq)
  assert.equal(new Set(seqs).size, seqs.length, 'replay must not duplicate Session event sequence numbers')
  const settledBanner = await waitFor(async () => {
    const status = await readOfflineStatus(page)
    return !status.present || status.hidden || status.state === 'online' ? status : undefined
  }, 'online banner after replay', 20_000)
  assert.notEqual(settledBanner.state, 'offline')
  assert.deepEqual(pageErrors, [])

  const summary = {
    result: 'passed',
    offlineBanner,
    queuedBanner,
    settledBanner,
    appendCount,
    userMessages: recovered.user.length,
    sessionEvents: seqs.length,
    turn: recovered.terminal.data.turn,
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} finally {
  await browser.close()
  await app.close()
  await rm(dataDir, { recursive: true, force: true })
  await image.cleanup()
}
