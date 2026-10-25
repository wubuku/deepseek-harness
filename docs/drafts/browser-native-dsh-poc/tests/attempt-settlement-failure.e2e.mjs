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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-attempt-failure-')))
const failureMarker = 'BROWSER_NATIVE_ATTEMPT_APPEND_FAILURE_E2E'
let attemptAppendFailures = 0
let image
let app
let browser
let context
let page
const requests = []
const pageErrors = []

function latestPrompt(body) {
  return [...(body.messages ?? [])].reverse().find(message => message.role === 'user'
    && typeof message.content === 'string' && !message.content.startsWith('Current runtime context.'))?.content ?? ''
}

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

async function currentSession(origin, sessionId) {
  return await sessionRequest(origin, 'read', { sessionId, offset: 0 })
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: {
      scriptedLlmFault: body => latestPrompt(body).includes(failureMarker)
        ? { kind: 'partial-text', text: 'ATTEMPT_APPEND_FAILURE_PARTIAL_TEXT' }
        : undefined,
      failSessionAppend: body => {
        if (attemptAppendFailures > 0) return false
        if (!body.events?.some(event => event.type === 'assistant/attempt')) return false
        attemptAppendFailures += 1
        return true
      },
    },
  })
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
  const prompt = `${failureMarker}：模型只输出半段文本，且第一次 assistant/attempt 持久化返回 503。`
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(prompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const createRequest = await waitFor(
    () => requests.find(request => request.path.endsWith('/session/create')),
    'attempt failure Session creation',
  )
  const sessionId = createRequest.body.sessionId
  const failureTurn = await waitFor(async () => {
    const session = await currentSession(origin, sessionId)
    const userIndex = session.events.findLastIndex(event => event.type === 'user/message' && eventText(event) === prompt)
    if (userIndex < 0) return undefined
    const turn = session.events.find(event => event.type === 'turn/start' && event.data.turn !== undefined
      && session.events.indexOf(event) < userIndex)
    if (turn === undefined) return undefined
    const turnEnd = session.events.findLast(event => event.type === 'turn/end' && event.data.turn === turn.data.turn)
    const attempt = session.events.findLast(event => event.type === 'assistant/attempt' && event.data.turn === turn.data.turn)
    const message = session.events.findLast(event => event.type === 'assistant/message' && event.data.turn === turn.data.turn)
    return turnEnd !== undefined || attempt !== undefined || message !== undefined
      ? { session, turn: turn.data.turn, turnEnd, attempt, message } : undefined
  }, 'attempt failure settlement observation', 45_000)
  assert.equal(attemptAppendFailures, 1)
  assert.ok(failureTurn.attempt, 'the failed streamed attempt must remain a Session fact after append retry')
  assert.equal(failureTurn.message, undefined, 'a failed stream must not become a successful assistant message')
  assert.equal(failureTurn.session.events.some(event => event.type === 'tool/call' && event.data.turn === failureTurn.turn), false)
  assert.equal(failureTurn.session.events.some(event => event.type === 'tool/result' && event.data.turn === failureTurn.turn), false)
  assert.ok(failureTurn.turnEnd, 'the failed turn must settle instead of remaining in-flight')
  assert.notEqual(failureTurn.turnEnd.data.reason.kind, 'completed')
  const llmCountBeforeReload = requests.filter(request => request.path.endsWith('/llm')
    && latestPrompt(request.body) === prompt).length
  assert.equal(llmCountBeforeReload, 1)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  const afterReload = await waitFor(async () => {
    const session = await currentSession(origin, sessionId)
    return session.events.some(event => event.type === 'assistant/attempt' && event.data.turn === failureTurn.turn)
      ? session : undefined
  }, 'failed attempt after refresh', 30_000)
  assert.equal(requests.filter(request => request.path.endsWith('/llm') && latestPrompt(request.body) === prompt).length, 1)
  assert.equal(afterReload.events.filter(event => event.type === 'assistant/attempt'
    && event.data.turn === failureTurn.turn).length, 1)

  const continuation = await sendTurn({
    page,
    origin,
    requests,
    sessionId,
    prompt: 'BROWSER_NATIVE_PARTIAL_TEXT_CONTINUE_OK：失败 turn 后显式开启新一轮。',
    marker: 'BROWSER_NATIVE_PARTIAL_TEXT_CONTINUE_OK',
    timeout: 45_000,
  })
  assert.equal(continuation.session.events.filter(event => event.type === 'turn/end').length >= 2, true)
  assert.match(assistantText(continuation.session, continuation.turn), /BROWSER_NATIVE_PARTIAL_TEXT_CONTINUE_OK/)
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'real-DSH-attempt-append-503-failed-stream-settlement-refresh-and-explicit-continue',
    sessionId,
    failedTurn: failureTurn.turn,
    continuationTurn: continuation.turn,
    attemptAppendFailures,
    failedTurnReason: failureTurn.turnEnd.data.reason.kind,
    failedAttemptStreamRecords: failureTurn.attempt.data.stream.length,
    llmCountForFailedPrompt: llmCountBeforeReload,
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
