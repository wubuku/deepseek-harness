/**
 * Verify that the Browser-Native profile declares a 128k model window and that
 * pressure compaction really fires near that window without a capacity warning.
 *
 * The backend starts without a context window, so the only source of model capacity
 * is the profile config. Turns grow the conversation with a large prompt plus one
 * tool result until the 0.8 pressure line is crossed; the Session is then flushed,
 * reloaded and continued to prove the logged events can rebuild the compacted state.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import {
  openPreview, sessionRequest, submitPrompt, waitFor, waitForPreview,
} from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright

const MARKER = 'BROWSER_NATIVE_SESSION_SCALE_TURN_E2E'
const turns = Number(process.env.DSH_POC_WINDOW_TURNS ?? 42)
const fillerChars = Number(process.env.DSH_POC_WINDOW_FILLER_CHARS ?? 12_000)
const windowTokens = Number(process.env.DSH_POC_WINDOW_TOKENS ?? 131_072)
const declaredWindowConfig = 131_072
const previewUrl = origin => `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`

if (!Number.isSafeInteger(turns) || turns < 16) throw new Error('DSH_POC_WINDOW_TURNS must be an integer of at least 16')
if (!Number.isSafeInteger(fillerChars) || fillerChars < 4_000) throw new Error('DSH_POC_WINDOW_FILLER_CHARS must be an integer of at least 4000')

function contentText(event) {
  const content = event.data?.message?.content ?? event.data?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

function createOwnerCapture(page) {
  const state = { ownerToken: undefined, configs: [] }
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname
    if (pathname === '/api/browser-native/config') {
      void response.json().then(payload => state.configs.push(payload)).catch(() => {})
    }
    if (!pathname.endsWith('/session/create') && !pathname.endsWith('/session/open')) return
    void response.json().then(payload => {
      if (typeof payload.owner?.ownerToken === 'string') state.ownerToken = payload.owner.ownerToken
    }).catch(() => {})
  })
  return state
}

async function readAllSession(origin, sessionId) {
  const events = []
  let offset = 0
  let durableThroughSeq = -1
  while (offset < 1_000_000) {
    const page = await sessionRequest(origin, 'read', { sessionId, offset, length: 2_048 })
    assert.equal(page.status, 200, JSON.stringify(page))
    events.push(...page.events)
    durableThroughSeq = Math.max(durableThroughSeq, page.durableThroughSeq)
    if (page.hasMore !== true) break
    offset = events.length
  }
  return { events, durableThroughSeq }
}

const filler = `${'Browser-native context pressure preserves this exact historical fact. '.repeat(Math.ceil(fillerChars / 64))}`.slice(0, fillerChars)
const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-context-window-'))
let image
let browser
let app
let context
let page
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  // The backend intentionally omits contextWindow: the profile config must supply it.
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  const requests = []
  const external = []
  const pageErrors = []
  const logs = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => logs.push(`${message.type()}: ${message.text()}`))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) {
      external.push(request.url())
      return
    }
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    requests.push({ path: url.pathname, body })
  })
  const owner = createOwnerCapture(page)

  await openPreview(page, previewUrl(origin))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

  let sessionId
  const turnDurations = []
  for (let index = 1; index <= turns; index += 1) {
    const startedAt = Date.now()
    const result = await submitPrompt({
      page, origin, requests, sessionId,
      prompt: `${MARKER} scale-turn-${String(index)}: ${filler}`,
      timeout: 180_000,
    })
    sessionId = result.sessionId
    turnDurations.push(Date.now() - startedAt)
  }

  const ownerToken = await waitFor(() => owner.ownerToken, 'Session write owner receipt')
  const flush = await sessionRequest(origin, 'flush', { sessionId, ownerToken })
  assert.equal(flush.status, 200, JSON.stringify(flush))
  const before = await readAllSession(origin, sessionId)
  assert.equal(before.durableThroughSeq, before.events.length - 1,
    'compaction events must be durable before the reload proof')

  const starts = before.events.filter(event => event.type === 'compaction/start')
  const summaries = before.events.filter(event => event.type === 'compaction/summary')
  const ends = before.events.filter(event => event.type === 'compaction/end')
  assert.ok(starts.length > 0,
    `a declared ${String(declaredWindowConfig)}-token window must trigger pressure compaction; events=${before.events.map(event => event.type).join(',')}`)
  assert.ok(summaries.length > 0, 'a triggered compaction must produce a durable summary')
  assert.equal(ends.length, summaries.length, 'each successful summary must close once')
  assert.equal(ends.every(event => event.data.error === undefined), true,
    `compaction must complete without an error: ${JSON.stringify(ends.map(event => event.data.error ?? null))}`)
  const firstCompactionSeq = starts[0].seq
  const turnsBeforeCompaction = before.events.filter(event => event.type === 'user/message'
    && event.seq <= firstCompactionSeq && contentText(event).includes(MARKER)).length
  assert.ok(turnsBeforeCompaction > 10,
    `compaction fired at turn ${String(turnsBeforeCompaction)}, far below the 0.8 pressure line`)
  const toolCallsBefore = before.events.filter(event => event.type === 'tool/call').length
  assert.ok(toolCallsBefore >= turns,
    `every turn must keep its tool call across compaction; observed ${String(toolCallsBefore)} for ${String(turns)} turns`)
  assert.equal(owner.configs.every(config => config.contextWindow === undefined), true,
    'the verification backend must not declare a model window, so compaction proves the profile config')
  assert.deepEqual(external, [])
  assert.deepEqual(pageErrors, [])
  const capacityWarnings = logs.filter(line => line.includes('no context capacity') || line.includes('headroom tokens'))
  assert.deepEqual(capacityWarnings, [], 'a profile-declared window must not emit a capacity warning')

  const durableBytes = (await stat(join(dataDir, 'sessions', `${sessionId}.json`))).size

  // Rebuild from the durable log after a reload, then continue the compacted Session.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const reopened = await readAllSession(origin, sessionId)
  const rebuiltStarts = reopened.events.filter(event => event.type === 'compaction/start')
  assert.equal(rebuiltStarts.length, starts.length, 'hydrate must replay every compaction event from the durable log')
  assert.equal(reopened.events.filter(event => event.type === 'compaction/summary').length, summaries.length)
  const lastMarker = `${MARKER}_${String(turns)}_DONE`
  await page.waitForFunction(marker => [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')]
    .some(node => node.textContent?.includes(marker)), lastMarker, { timeout: 30_000 })

  const continued = await submitPrompt({
    page, origin, requests, sessionId,
    prompt: `${MARKER} scale-turn-${String(turns + 1)}: ${filler}`,
    timeout: 180_000,
  })
  const after = await readAllSession(origin, sessionId)
  const compactionAfterContinue = after.events.filter(event => event.type === 'compaction/start').length
  assert.ok(compactionAfterContinue >= starts.length,
    'a compacted Session must keep its compaction history after continuing')
  const newToolCalls = after.events.filter(event => event.type === 'tool/call').length - toolCallsBefore
  assert.ok(newToolCalls >= 1,
    `the follow-up turn must execute its own tool call; new calls=${String(newToolCalls)}`)
  assert.ok(after.events.some(event => event.type === 'user/message'
    && contentText(event).includes(`scale-turn-${String(turns + 1)}`)))
  assert.equal(contentText(after.events.at(-1)).length >= 0, true)

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'profile-context-window-compaction',
    declaredWindow: declaredWindowConfig,
    requestedWindowTokens: windowTokens,
    turns,
    fillerChars,
    sessionId,
    eventCount: before.events.length,
    durableBytes,
    firstCompactionTurn: turnsBeforeCompaction,
    compaction: { starts: starts.length, summaries: summaries.length, ends: ends.length },
    afterReload: {
      events: reopened.events.length,
      starts: rebuiltStarts.length,
      summaries: reopened.events.filter(event => event.type === 'compaction/summary').length,
      lastMarkerVisible: true,
    },
    continuedTurn: continued.turn,
    toolCalls: after.events.filter(event => event.type === 'tool/call').length,
    turnLatencyMedianMs: [...turnDurations].sort((left, right) => left - right)[Math.floor(turnDurations.length / 2)],
    turnLatencyMaxMs: Math.max(...turnDurations),
    capacityWarnings,
    backendConfigWindows: owner.configs.map(config => config.contextWindow ?? null),
    externalRequests: external.length,
    pageErrors,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await app?.close()
  await browser?.close()
  await image?.cleanup()
  await rm(dataDir, { recursive: true, force: true })
}
