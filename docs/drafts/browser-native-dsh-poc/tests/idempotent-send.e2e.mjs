/**
 * Browser-level idempotency: a rapid double Send click and a replayed append
 * request must produce one Turn and one event batch, never duplicate side
 * effects.
 *
 * The backend contract lives in `state-change-idempotency.test.mjs`; this test
 * proves that the shipped composer plus the real Worker never turn a double
 * click into a duplicate Session prompt.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, rememberSessionPrincipal, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const browserChannel = process.env.DSH_POC_BROWSER ?? 'chrome'

const MARKER = 'BROWSER_NATIVE_IDEMPOTENT_SEND_E2E'
const prompt = `${MARKER}: answer this turn exactly once.`
const previewUrl = origin => `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`

function createRecorder(page, origin) {
  const requests = []
  const pageErrors = []
  const nonLocalRequests = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.origin.startsWith(origin)) nonLocalRequests.push(`${url.origin}${url.pathname}`)
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = JSON.parse(request.postData() ?? '{}') } catch { return }
    requests.push({ path: url.pathname, body })
  })
  return { requests, pageErrors, nonLocalRequests }
}

function userMessages(events) {
  return events.filter(event => event.type === 'user/message'
    && event.data?.content?.some(block => block.type === 'text' && block.text.trim() === prompt))
}

async function fillComposer(page) {
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.fill(prompt)
  await page.waitForFunction(expected => {
    const nodes = [...document.querySelectorAll('[data-composer-input]')]
    const input = nodes.at(-1)
    return input !== undefined && (input.innerText ?? '').trim() === expected.trim()
  }, prompt, { timeout: 10_000 })
}

/** Dispatch two clicks in the same task so React cannot disable the button in between. */
async function doubleClickSend(page) {
  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')]
      .find(candidate => /^(Send message|发送消息)$/.test(candidate.getAttribute('aria-label') ?? ''))
    if (button === undefined || button.disabled === true) return false
    button.click()
    button.click()
    return true
  })
  assert.equal(clicked, true, 'the Send button must be enabled before the double click')
}

async function run() {
  const image = await createRuntimeValidationDist({ roster: 'original' })
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-idempotent-send-'))
  let browser
  let context
  let page
  let app
  try {
    app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
    const origin = await app.listen(0)
    browser = await chromium.launch({ headless: true, channel: browserChannel })
    context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
    page = await context.newPage()
    const recorder = createRecorder(page, origin)
    await openPreview(page, previewUrl(origin))
    await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

    await fillComposer(page)
    await doubleClickSend(page)

    const sessionId = await waitFor(
      () => recorder.requests.find(request => request.path.endsWith('/session/create'))?.body.sessionId,
      'Session creation', 60_000,
    )
    await rememberSessionPrincipal(page, origin, sessionId)
    const settled = await waitFor(async () => {
      const read = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
      const events = read.events ?? []
      return events.some(event => event.type === 'turn/end') ? read : undefined
    }, 'terminal turn after a double Send', 180_000)

    const events = settled.events
    const users = userMessages(events)
    const turnStarts = events.filter(event => event.type === 'turn/start')
    const turnEnds = events.filter(event => event.type === 'turn/end')
    const transcriptUsers = await page.locator('[data-chat-flow-kind="user"]').count()
    assert.equal(users.length, 1, `a double Send must submit one user message: ${JSON.stringify(events.map(event => event.type))}`)
    assert.equal(turnStarts.length, 1, 'a double Send must start one turn')
    assert.equal(turnEnds.length, 1, 'a double Send must finish one turn')
    assert.equal(transcriptUsers, 1, 'the transcript must render one user message')

    const appends = recorder.requests.filter(request => request.path.endsWith('/session/append'))
    assert.ok(appends.length > 0, 'the Worker must persist the turn through session/append')
    const finalAppend = appends.at(-1).body
    const eventCount = events.length

    const replay = await sessionRequest(origin, 'append', finalAppend)
    assert.equal(replay.status, 200, JSON.stringify(replay))
    assert.equal(replay.replayed, true, 'a network retry of the last append must replay its receipt')
    assert.equal(replay.acceptedCount, finalAppend.events.length)
    assert.equal((await sessionRequest(origin, 'read', { sessionId, offset: 0 })).events.length, eventCount,
      'an append retry must not duplicate events')

    const [concurrentA, concurrentB] = await Promise.all([
      sessionRequest(origin, 'append', finalAppend),
      sessionRequest(origin, 'append', finalAppend),
    ])
    assert.deepEqual([concurrentA.status, concurrentB.status], [200, 200],
      `${JSON.stringify(concurrentA)} / ${JSON.stringify(concurrentB)}`)
    assert.equal((await sessionRequest(origin, 'read', { sessionId, offset: 0 })).events.length, eventCount,
      'concurrent duplicate appends must not duplicate events')

    const mutated = structuredClone(finalAppend)
    mutated.events[0] = {
      ...mutated.events[0],
      data: { ...(mutated.events[0].data ?? {}), idempotencyProbe: 'mutated' },
    }
    const conflict = await sessionRequest(origin, 'append', mutated)
    assert.equal(conflict.status, 409, JSON.stringify(conflict))
    assert.equal(conflict.error?.code, 'IDEMPOTENCY_CONFLICT', JSON.stringify(conflict))
    assert.equal((await sessionRequest(origin, 'read', { sessionId, offset: 0 })).events.length, eventCount,
      'a conflicting reuse must not change the log')

    assert.equal(recorder.pageErrors.length, 0, 'the page must not report errors')
    assert.equal(recorder.nonLocalRequests.length, 0, 'the browser must not issue any non-local request')

    console.log(JSON.stringify({
      result: 'passed', browser: browserChannel, sessionId,
      events: { total: eventCount, userMessages: users.length, turnStarts: turnStarts.length, turnEnds: turnEnds.length },
      transcriptUserMessages: transcriptUsers,
      appendRequests: appends.length,
      replay: { status: replay.status, replayed: replay.replayed, acceptedCount: replay.acceptedCount },
      concurrentReplayStatuses: [concurrentA.status, concurrentB.status],
      conflict: { status: conflict.status, code: conflict.error?.code },
      pageErrors: recorder.pageErrors, nonLocalRequests: recorder.nonLocalRequests,
    }))
  } finally {
    if (page !== undefined) await page.close().catch(() => {})
    if (context !== undefined) await context.close().catch(() => {})
    if (browser !== undefined) await browser.close().catch(() => {})
    if (app !== undefined) await app.close().catch(() => {})
    if (image !== undefined) await image.cleanup().catch(() => {})
    await rm(dataDir, { recursive: true, force: true })
  }
}

await run()
