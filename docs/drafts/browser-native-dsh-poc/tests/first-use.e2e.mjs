import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import {
  openPreview, assistantText, rememberSessionPrincipal, sessionRequest, waitFor, waitForPreview,
} from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-first-use-')))
const FIRST_USE = '[data-browser-native-first-use]'
const FIRST_USE_MARKER = 'dsh-browser-native-first-use-completed-v1'
const SESSION_COMPLETION_MARKER = 'Browser-native DSH completed this turn:'
let image
let app
let origin
let browser
const contexts = []
const pageErrors = []

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

function composer(page) {
  return page.locator('[data-composer-input][contenteditable="true"]').last()
}

async function populatedSessionCount(context) {
  const sessionCookie = (await context.cookies())
    .find(cookie => cookie.name === 'dsh-browser-native-session-principal')
  assert.ok(sessionCookie, 'the preview must bind a Session principal before the guide checks the empty state')
  const response = await fetch(`${origin}/api/browser-native/session/list`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `${sessionCookie.name}=${sessionCookie.value}`,
    },
    body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID() }),
  })
  const text = await response.text()
  assert.equal(response.status, 200, text)
  const body = JSON.parse(text)
  assert.equal(Array.isArray(body.items), true, text)
  return body.items.filter(item => item === null || typeof item !== 'object' || item.blank !== true).length
}

async function openContext(locale) {
  const context = await browser.newContext({ locale, viewport: { width: 1440, height: 1000 } })
  contexts.push(context)
  const requests = []
  context.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch { body = {} }
    requests.push({ path: url.pathname, method: request.method(), body, at: Date.now() })
  })
  const page = await context.newPage()
  page.on('pageerror', error => pageErrors.push({ locale, message: error.message }))
  await openPreview(page, `${origin}/preview.html?browser-native=1&preview-fixture=none`)
  return { context, page, requests }
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({
    headless: true,
    ...(process.env.DSH_POC_BROWSER === 'chromium' ? {} : { channel: 'chrome' }),
  })

  const first = await openContext('en-US')
  const guide = first.page.locator(FIRST_USE)
  await guide.waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal(await guide.locator('ol > li').count(), 3, 'the guide must name the three first-turn steps')
  assert.equal((await guide.getAttribute('aria-label'))?.length > 0, true)
  const sampleTask = (await guide.locator('[data-browser-native-first-use-task]').innerText()).trim()
  assert.equal(sampleTask.length > 0, true)
  assert.equal((await composer(first.page).innerText()).trim(), '', 'the first visit starts with an empty composer')

  await guide.locator('[data-browser-native-first-use-sample]').click()
  await waitFor(async () => (await composer(first.page).innerText()).trim() === sampleTask,
    'sample task inserted into the composer')
  assert.equal(
    (await guide.locator('[data-browser-native-first-use-status]').innerText()).trim(),
    'Sample task inserted. Press Send to run your first turn.',
  )

  // Send the inserted task without refilling the composer: the guide's insertion
  // must be what the real UI submits, not just visible text.
  await first.page.getByRole('button', { name: /^Send message$/ }).click()
  const sessionId = await waitFor(async () => first.requests
    .find(request => request.path.endsWith('/session/create'))?.body.sessionId, 'Session creation')
  await rememberSessionPrincipal(first.page, origin, sessionId)
  const settled = await waitFor(async () => {
    const current = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const events = current.events ?? []
    const userIndex = events.findLastIndex(event => event.type === 'user/message')
    if (userIndex < 0) return undefined
    const terminal = events.findLast(event => event.type === 'turn/end' && event.seq > events[userIndex].seq)
    return terminal === undefined ? undefined : { session: current, terminal }
  }, 'first turn terminal event', 90_000)
  const turn = settled.terminal.data.turn
  assert.equal(settled.terminal.data.reason.kind, 'completed', JSON.stringify(settled.terminal.data.reason))
  assert.equal(
    settled.session.events.filter(event => event.type === 'user/message' && eventText(event).trim() === sampleTask).length,
    1,
    'the sample task must be the submitted user message',
  )
  assert.equal(assistantText(settled.session, turn).includes(SESSION_COMPLETION_MARKER), true,
    'the sample task must reach the scripted model and produce assistant text')

  await guide.waitFor({ state: 'detached', timeout: 30_000 })
  await first.page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(first.page)
  assert.equal(await populatedSessionCount(first.context) >= 1, true, 'the first turn must remain persisted')
  assert.equal(await first.page.evaluate(key => window.localStorage.getItem(key), FIRST_USE_MARKER), '1')
  assert.equal(await first.page.locator(FIRST_USE).count(), 0, 'a completed first visit must not repeat the guide')

  const second = await openContext('zh-CN')
  const localized = second.page.locator(FIRST_USE)
  await localized.waitFor({ state: 'visible', timeout: 30_000 })
  const localizedTitle = await localized.locator('[data-browser-native-first-use-title]').innerText()
  assert.equal(localizedTitle.includes('第一次'), true, localizedTitle)
  await localized.locator('[data-browser-native-first-use-dismiss]').click()
  await localized.waitFor({ state: 'detached', timeout: 15_000 })
  assert.equal(await second.page.evaluate(key => window.localStorage.getItem(key), FIRST_USE_MARKER), '1')
  await second.page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(second.page)
  assert.equal(await second.page.locator(FIRST_USE).count(), 0, 'dismissal must persist across reloads')

  assert.deepEqual(pageErrors, [])

  const summary = {
    result: 'passed',
    scope: 'first-use-empty-state-guide-sample-task',
    emptyComposerAtFirstUse: true,
    guideSteps: 3,
    sampleTask,
    sampleTurnReason: settled.terminal.data.reason.kind,
    assistantMarker: SESSION_COMPLETION_MARKER,
    guideDismissedAfterFirstTurn: true,
    guideSuppressedAfterReload: true,
    localizedTitle,
  }
  if (process.env.DSH_POC_RESULT_FILE !== undefined) {
    await writeFile(resolve(process.env.DSH_POC_RESULT_FILE), `${JSON.stringify(summary, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} finally {
  for (const context of contexts) await context?.close().catch(() => {})
  await browser?.close()
  await app?.close().catch(() => {})
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
