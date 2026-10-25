import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-long-session-')))
const turnCount = Number(process.env.DSH_POC_LONG_SESSION_TURNS ?? 24)
let image
let app
let browser
let context
let page
const pageErrors = []
const requests = []

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

if (!Number.isSafeInteger(turnCount) || turnCount < 8 || turnCount > 64) {
  throw new Error('DSH_POC_LONG_SESSION_TURNS must be between 8 and 64')
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    requests.push({ path: url.pathname, body, at: Date.now() })
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  const turns = []
  for (let index = 1; index <= turnCount; index += 1) {
    const prompt = `BROWSER_NATIVE_SCRIPTED_E2E_OK long-session-turn-${index}: keep this Session history.`
    const result = await sendTurn({
      page,
      origin,
      requests,
      prompt,
      marker: 'BROWSER_NATIVE_SCRIPTED_E2E_OK',
      sessionId: turns.at(-1)?.sessionId,
      timeout: 45_000,
    })
    turns.push({ turn: result.turn, eventCount: result.session.events.length, sessionId: result.sessionId })
  }
  const sessionId = turns[0]?.sessionId
  assert.equal(typeof sessionId, 'string')
  const beforeReload = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
  assert.equal(beforeReload.status, 200, JSON.stringify(beforeReload))
  assert.equal(beforeReload.events.filter(event => event.type === 'user/message'
    && eventText(event).includes('long-session-turn-')).length, turnCount)
  assert.equal(beforeReload.events.filter(event => event.type === 'turn/end').length, turnCount)
  assert.ok(beforeReload.events.length > turnCount * 3, `expected a non-trivial event log, got ${beforeReload.events.length}`)
  assert.match(assistantText(beforeReload, turnCount), /BROWSER_NATIVE_SCRIPTED_E2E_OK/)
  const llmCountBeforeReload = requests.filter(request => request.path.endsWith('/llm')).length
  const reloadStartedAt = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const hydrateMs = Date.now() - reloadStartedAt
  await page.getByText('BROWSER_NATIVE_SCRIPTED_E2E_OK', { exact: false }).last().waitFor({ timeout: 30_000 })
  let afterReload
  try {
    afterReload = await waitFor(async () => {
      const current = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
      return current.events.length >= beforeReload.events.length ? current : undefined
    }, 'long Session history after refresh', 30_000)
  } catch (error) {
    const observed = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    throw new Error(`${String(error)}; before=${beforeReload.events.length}; after=${observed.events?.length}; types=${observed.events?.slice(-12).map(event => event.type).join(',')}`)
  }
  assert.deepEqual(afterReload.events.slice(0, beforeReload.events.length), beforeReload.events)
  assert.deepEqual(afterReload.events.slice(beforeReload.events.length).map(event => event.type), ['session/end-seed'])
  const llmCountAfterReload = requests.filter(request => request.path.endsWith('/llm')).length
  assert.equal(llmCountAfterReload, llmCountBeforeReload, 'refresh hydration must not replay a model request')

  const followup = await sendTurn({
    page,
    origin,
    requests,
    sessionId,
    prompt: 'BROWSER_NATIVE_SCRIPTED_E2E_OK long-session-followup: continue the same Session.',
    marker: 'BROWSER_NATIVE_SCRIPTED_E2E_OK',
    timeout: 45_000,
  })
  assert.equal(followup.turn, turnCount + 1)
  assert.equal(followup.session.events.filter(event => event.type === 'user/message'
    && (eventText(event).includes('long-session-turn-') || eventText(event).includes('long-session-followup'))).length, turnCount + 1)
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'real-DSH-session-multi-turn-full-hydrate-refresh-and-followup',
    sessionId,
    turnCount,
    eventCountBeforeReload: beforeReload.events.length,
    eventCountAfterFollowup: followup.session.events.length,
    hydrateMs,
    llmCountBeforeReload,
    llmCountAfterReload,
    pageErrors,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
