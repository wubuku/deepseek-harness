import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, submitPrompt, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
if (browserName !== 'chrome') throw new Error('Background-tab lease validation runs only in Chrome')

const OBSERVE_MS = Number(process.env.DSH_POC_OBSERVE_MS ?? 380_000)
const POLL_MS = 15_000
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-background-tab-')))
const requests = []
const pageErrors = []
const workerErrors = []
const externalRequests = []
const renewals = []
const PROMPT = 'BROWSER_NATIVE_BACKGROUND_TAB_TURN'
let image
let app
let browser
let context
let page
let controlPage
let origin
let visibilityStates = []

class Blocked extends Error {}

function recordRenewal(record, status) {
  if (!record.path.endsWith('/session/renew') && !record.path.endsWith('/workspace/lease')) return
  renewals.push({ path: record.path, operation: record.body?.operation, status, at: Date.now() })
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: {
      scriptedLlmFault: body => {
        const prompt = latestPrompt(body)
        return { kind: 'text', text: `${prompt}_DONE` }
      },
    },
  })
  origin = await app.listen(0)
  browser = await chromium.launch({
    headless: false,
    channel: browserName,
    ignoreDefaultArgs: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const record = request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch { body = {} }
    const entry = { path: url.pathname, method: request.method(), body, status: undefined, at: Date.now() }
    requests.push(entry)
    entry.request = request
  }
  context.on('page', tracked => {
    tracked.on('pageerror', error => pageErrors.push(error.message))
    tracked.on('request', record)
    tracked.on('response', response => {
      const entry = requests.find(item => item.request === response.request())
      if (entry === undefined) return
      entry.status = response.status()
      recordRenewal(entry, entry.status)
    })
    tracked.on('worker', worker => {
      worker.on('pageerror', error => workerErrors.push(error.message))
      worker.on('console', message => {
        if (message.type() === 'error') workerErrors.push(message.text())
      })
    })
  })

  page = await context.newPage()
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&preview-fixture=none`)
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const baseline = await page.locator('[data-composer-input][contenteditable="true"]').last().isVisible()
  assert.equal(baseline, true)
  const renewalBaseline = renewals.length
  const sessionRenewalBaseline = renewals.filter(item => item.path.endsWith('/session/renew')).length

  await page.evaluate(() => {
    const probe = { startedAt: performance.now(), samples: [], active: true }
    window.__DSH_BACKGROUND_TAB_PROBE__ = probe
    let previous = performance.now()
    const tick = () => {
      if (!probe.active) return
      const now = performance.now()
      probe.samples.push({ at: now, gapMs: now - previous })
      previous = now
      setTimeout(tick, 100)
    }
    setTimeout(tick, 100)
  })

  controlPage = await context.newPage()
  await controlPage.goto('about:blank', { waitUntil: 'domcontentloaded' })
  await controlPage.bringToFront()
  visibilityStates = await Promise.all(context.pages().map(async tracked => {
    try {
      return { url: tracked.url().slice(0, 80), state: await tracked.evaluate(() => document.visibilityState) }
    } catch (error) {
      return { url: tracked.url().slice(0, 80), error: String(error) }
    }
  }))
  if (visibilityStates.every(entry => entry.state === 'visible')) {
    throw new Blocked('headed Chrome keeps every page visible in this automation session, so no natural hidden-tab throttling can be observed')
  }
  await waitFor(() => page.evaluate(() => document.visibilityState === 'hidden'), 'owner tab to become hidden', 10_000)
  const hiddenSince = Date.now()

  const observations = []
  const deadline = hiddenSince + OBSERVE_MS
  while (Date.now() < deadline) {
    const lease = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
    observations.push({
      elapsedMs: Date.now() - hiddenSince,
      leaseOk: lease?.ok,
      fencingToken: lease?.fencingToken,
      expiresInMs: typeof lease?.expiresAt === 'number' ? lease.expiresAt - Date.now() : undefined,
      sessionRenewals: renewals.filter(item => item.path.endsWith('/session/renew')).length,
      sessionRenewalFailures: renewals.filter(item => item.path.endsWith('/session/renew') && item.status !== 200).length,
      workspaceRenewals: renewals.filter(item => item.path.endsWith('/workspace/lease')).length,
      workspaceRenewalFailures: renewals.filter(item => item.path.endsWith('/workspace/lease') && item.status !== 200).length,
    })
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }

  const probe = await page.evaluate(() => {
    const current = window.__DSH_BACKGROUND_TAB_PROBE__
    current.active = false
    return current
  })
  const hiddenSamples = probe.samples.filter(sample => sample.at > probe.startedAt)
  const maxTimerGapMs = hiddenSamples.reduce((max, sample) => Math.max(max, sample.gapMs), 0)
  const sessionRenewalsDuringHidden = renewals.filter(item => item.path.endsWith('/session/renew') && item.at >= hiddenSince)
  const sessionRenewalFailures = sessionRenewalsDuringHidden.filter(item => item.status !== 200)
  const renewGaps = sessionRenewalsDuringHidden.map((item, index, list) => (index === 0 ? item.at - hiddenSince : item.at - list[index - 1].at))
  const maxSessionRenewGapMs = renewGaps.reduce((max, gap) => Math.max(max, gap), 0)
  const successfulRenewGaps = sessionRenewalsDuringHidden
    .filter(item => item.status === 200)
    .map((item, index, list) => (index === 0 ? item.at - hiddenSince : item.at - list[index - 1].at))
  const maxSuccessfulRenewGapMs = successfulRenewGaps.reduce((max, gap) => Math.max(max, gap), 0)

  const turn = await submitPrompt({
    page,
    origin,
    requests,
    prompt: PROMPT,
    timeout: 180_000,
    expectedReason: null,
  })
  const terminal = turn.session.events.findLast(event => event.type === 'turn/end')
  const readback = await page.evaluate(async sessionId => await (await fetch('/api/browser-native/session/read', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId, offset: 0 }),
  })).json(), turn.sessionId)
  const lastSeq = turn.session.events.at(-1)?.seq
  const visibility = await page.evaluate(() => document.visibilityState)
  const sessionRenewalFailuresAfterTurn = renewals.filter(item => item.path.endsWith('/session/renew') && item.status !== 200).length
  const workspaceRenewalFailuresAfterTurn = renewals.filter(item => item.path.endsWith('/workspace/lease') && item.status !== 200).length

  assert.equal(visibility, 'hidden', 'the owner tab must remain hidden for the whole observation')
  assert.ok(maxTimerGapMs >= 1_000, `expected measurable tab throttling, max timer gap was ${String(maxTimerGapMs)} ms`)
  assert.ok(sessionRenewalsDuringHidden.length >= 2, 'the Worker must attempt Session renewals while hidden')
  assert.ok(observations.every(observation => observation.leaseOk === true), 'lease-info must stay readable while hidden')
  assert.equal(turn.session.events.filter(event => event.type === 'user/message' && eventText(event).trim() === PROMPT).length, 1)
  assert.ok(requests.filter(item => item.path.endsWith('/llm')).length >= 1)
  assert.ok(terminal !== undefined, 'hidden-tab turn must reach a terminal event')
  const leaseFenced = sessionRenewalFailuresAfterTurn > 0 || workspaceRenewalFailuresAfterTurn > 0
  const durableThroughTerminal = typeof readback.durableThroughSeq === 'number' && readback.durableThroughSeq >= terminal.seq
  const verdict = !leaseFenced && terminal.data.reason.kind === 'completed' && durableThroughTerminal
    ? 'lease-and-turn-maintained'
    : 'lease-or-turn-degraded'
  if (verdict === 'lease-and-turn-maintained') {
    assert.equal(terminal.data.reason.kind, 'completed')
    assert.ok(durableThroughTerminal)
  }
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'natural-hidden-tab-throttling-with-owner-leases-and-turn',
    verdict,
    observationMs: Date.now() - hiddenSince,
    defaultOwnerLeaseMs: 30_000,
    maxPageTimerGapMs: Math.round(maxTimerGapMs),
    maxSessionRenewGapMs: Math.round(maxSessionRenewGapMs),
    maxSuccessfulSessionRenewGapMs: Math.round(maxSuccessfulRenewGapMs),
    sessionRenewalsDuringHidden: sessionRenewalsDuringHidden.length,
    workspaceRenewalsDuringHidden: renewals.filter(item => item.path.endsWith('/workspace/lease') && item.at >= hiddenSince).length,
    renewalBaseline,
    sessionRenewalBaseline,
    observations,
    hiddenTabTurn: { reason: terminal?.data.reason.kind, events: turn.session.events.length, durableThroughSeq: readback.durableThroughSeq, lastSeq },
    note: 'Headed Chrome with Playwright background-throttling flags removed. This verifies natural hidden-tab throttling for one foreground-controlled window; it does not model tab discard, worker termination, OS sleep or cross-device handoff.',
  })}\n`)
} catch (error) {
  if (error instanceof Blocked) {
    process.stdout.write(`${JSON.stringify({
      result: 'blocked',
      browser: browser?.version(),
      scope: 'natural-hidden-tab-throttling-with-owner-leases-and-turn',
      reason: error.message,
      visibilityStates,
      attempts: ['second Playwright page in the same window', 'Target.activateTarget via bringToFront', 'Browser.setWindowBounds minimized', 'fullscreen control window'],
      reproducibleCommand: 'DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/background-tab-lease.e2e.mjs',
      note: 'Chrome 156 and bundled Chromium 147 both report every page as visible in this automation session, including after minimize and fullscreen attempts; no hidden-tab timer throttling can be produced. CDP Page.setWebLifecycleState freeze remains the only lease-renewal evidence and it is not natural throttling.',
    })}\n`)
  } else {
    process.stderr.write(`${JSON.stringify({
      result: 'failed',
      error: String(error),
      requests: requests.map(({ request, ...rest }) => rest),
      renewals,
      pageErrors,
      workerErrors,
      externalRequests,
    })}\n`)
    throw error
  }
} finally {
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}

function latestPrompt(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && typeof message.content === 'string') return message.content
  }
  return ''
}

function eventText(event) {
  const content = event?.data?.message?.content ?? event?.data?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(part => part?.type === 'text').map(part => part.text).join('')
  return ''
}
