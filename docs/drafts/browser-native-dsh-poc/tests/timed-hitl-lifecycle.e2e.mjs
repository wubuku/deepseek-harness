import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-timed-hitl-')))
const timeoutSeconds = Number(process.env.DSH_POC_TIMED_QUESTION_TIMEOUT ?? 10)
if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 3 || timeoutSeconds > 30) {
  throw new Error('DSH_POC_TIMED_QUESTION_TIMEOUT must be an integer from 3 through 30 seconds')
}
const selectedScenario = process.env.DSH_POC_TIMED_HITL_SCENARIO ?? 'in-time'
const scenarios = ['in-time', 'late-answer', 'refresh-before-answer', 'refresh-after-answer', 'hide-refresh', 'stop-timed', 'stop-legacy']
if (!scenarios.includes(selectedScenario)) {
  throw new Error(`DSH_POC_TIMED_HITL_SCENARIO must be one of: ${scenarios.join(', ')}`)
}

const requests = []
const modelRequests = []
const pageErrors = []
const externalRequests = []
let origin
const releaseAnswerModel = Promise.withResolvers()
let answerModelHeld = false
let phase = 'startup'
let lastPage
let image
let app
let browser

function monitorPage(page) {
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (origin !== undefined && url.origin !== origin) externalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({ path: url.pathname, body })
    if (url.pathname === '/api/browser-native/llm') modelRequests.push(body)
  })
}

function eventsOf(session) {
  return session.events ?? []
}

function askCall(session) {
  return eventsOf(session).find(event => event.type === 'tool/call' && event.data.name === 'ask_user_question')
}

function toolResult(session, callId) {
  return eventsOf(session).find(event => event.type === 'tool/result'
    && event.data.message?.toolCallId === callId)
}

function eventText(event) {
  const content = event?.data?.message?.content ?? event?.data?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

function mainModelRequestCount() {
  return modelRequests.filter(request => request?.purpose === undefined).length
}

function pendingResult(event) {
  if (event === undefined || event.data.error !== undefined) return false
  try { return JSON.parse(eventText(event)).pending === true } catch { return false }
}

function questionReplyEvents(session, callId) {
  return eventsOf(session).filter(event => event.type === 'user/message'
    && event.data.source.kind === 'user-question-reply'
    && event.data.source.callId === callId)
}

async function readSession(sessionId) {
  const result = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
  assert.equal(result.status, 200, JSON.stringify(result))
  return result
}

async function currentManifest(page) {
  const identity = await page.evaluate(async () => await (await fetch('/api/browser-native/workspace/identity')).json())
  return await page.evaluate(async workspaceId => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
  )).json(), identity.workspaceId)
}

async function openScenario(marker) {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  lastPage = page
  monitorPage(page)
  const createStart = requests.length
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(marker)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const created = await waitFor(
    () => requests.slice(createStart).find(request => request.path.endsWith('/session/create')),
    `Session creation for ${marker}`,
  )
  return { context, page, sessionId: created.body.sessionId }
}

async function waitForAsk(sessionId) {
  return await waitFor(async () => {
    const session = await readSession(sessionId)
    const call = askCall(session)
    return call === undefined ? undefined : { session, call }
  }, 'persisted timed ask_user_question call', 45_000)
}

async function waitForQuestionCard(page) {
  const card = page.locator('[data-question-key]').last()
  await card.waitFor({ state: 'visible', timeout: 30_000 })
  return card
}

async function expandTurnProcesses(page) {
  const selector = '[data-turn-process]:visible, [data-process-activity]:visible'
  await page.locator(selector).first().waitFor({ state: 'visible', timeout: 10_000 })
  for (let pass = 0; pass < 5; pass++) {
    const collapsed = page.locator('[data-turn-process][aria-expanded="false"]:visible, [data-process-activity][aria-expanded="false"]:visible')
    const count = await collapsed.count()
    if (count === 0) return
    for (let index = 0; index < count; index++) {
      const control = collapsed.nth(index)
      if (await control.isVisible()) await control.click()
    }
  }
  assert.equal(await page.locator('[data-turn-process][aria-expanded="false"]:visible, [data-process-activity][aria-expanded="false"]:visible').count(), 0,
    'all visible turn process groups must expand')
}

async function submitYes(page) {
  const card = await waitForQuestionCard(page)
  await card.getByRole('radio', { name: 'Yes' }).click()
  await card.getByRole('radio', { name: 'Yes' }).press('Enter')
}

async function waitForTerminal(sessionId, turn, predicate = () => true) {
  return await waitFor(async () => {
    const session = await readSession(sessionId)
    const terminal = eventsOf(session).findLast(event => event.type === 'turn/end' && event.data.turn === turn)
    return terminal !== undefined && predicate(terminal, session) ? { session, terminal } : undefined
  }, `terminal Session event for turn ${turn}`, 60_000)
}

async function launchQuestion(marker, timed = true) {
  const run = await openScenario(marker)
  const asked = await waitForAsk(run.sessionId)
  const schema = modelRequests.findLast(request => request?.purpose === undefined
    && JSON.stringify(request?.messages).includes(marker))?.tools ?? []
  const questionTool = schema.find(tool => (tool.function?.name ?? tool.name) === 'ask_user_question')
  assert.ok(questionTool, 'question tool must be present in the real Worker model schema')
  if (timed) assert.ok(JSON.stringify(questionTool).includes('timeout'), 'timed tool schema must expose its timeout parameter')
  const cards = await waitForQuestionCard(run.page)
  await run.page.getByText(`Answer the ${marker} decision.`, { exact: true }).waitFor()
  return { ...run, asked, cards }
}

try {
  image = await createRuntimeValidationDist(selectedScenario === 'stop-legacy'
    ? { roster: 'original' }
    : { roster: 'original', timedQuestionTimeout: timeoutSeconds })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: {
      scriptedLlmFault: body => {
        if (answerModelHeld || !Array.isArray(body.messages)) return undefined
        const hasTargetReply = body.messages.some(message => message.role === 'user'
          && typeof message.content === 'string'
          && message.content.includes('"kind":"answer_to_pending_question"')
          && message.content.includes('browser-native-timed-hitl-reply-refresh'))
        if (!hasTargetReply) return undefined
        answerModelHeld = true
        return {
          kind: 'barrier-text',
          release: releaseAnswerModel.promise,
          text: 'BROWSER_NATIVE_TIMED_HITL_REPLY_REFRESH_ANSWER_ADMITTED',
        }
      },
    },
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })

  if (selectedScenario === 'in-time') {
    phase = 'in-time-answer'
    const inTime = await launchQuestion('BROWSER_NATIVE_TIMED_HITL_IN_TIME')
    await submitYes(inTime.page)
    const inTimeDone = await waitFor(async () => {
      const session = await readSession(inTime.sessionId)
      const terminal = eventsOf(session).findLast(event => event.type === 'turn/end')
      return terminal?.data.reason.kind === 'completed' ? { session, terminal } : undefined
    }, 'in-time timed question and same-turn continuation', 60_000)
    const inTimeCalls = eventsOf(inTimeDone.session).filter(event => event.type === 'tool/call'
      && event.data.turn === inTimeDone.terminal.data.turn)
    const inTimeResult = toolResult(inTimeDone.session, inTime.asked.call.data.callId)
    assert.deepEqual(inTimeCalls.map(event => event.data.name), ['ask_user_question', 'write'])
    assert.equal(inTimeResult.data.error, undefined)
    assert.match(eventText(inTimeResult), /"selected":\["Yes"\]/)
    assert.equal(questionReplyEvents(inTimeDone.session, inTime.asked.call.data.callId).length, 0,
      'in-time answer belongs to the original tool result, not a late-reply user message')
    const inTimeManifest = await currentManifest(inTime.page)
    assert.equal(inTimeManifest.revision, 1)
    assert.match(assistantText(inTimeDone.session, inTimeDone.terminal.data.turn), /BROWSER_NATIVE_TIMED_HITL_IN_TIME_DONE/)
    await inTime.context.close()
  }

  if (selectedScenario === 'late-answer') {
    phase = 'timeout-and-late-answer'
    const late = await launchQuestion('BROWSER_NATIVE_TIMED_HITL_LATE_REPLY')
    const latePending = await waitFor(async () => {
      const session = await readSession(late.sessionId)
      const call = askCall(session)
      const result = call === undefined ? undefined : toolResult(session, call.data.callId)
      const terminal = call === undefined ? undefined : eventsOf(session).findLast(event => event.type === 'turn/end'
        && event.data.turn === call.data.turn)
      return pendingResult(result) && terminal?.data.reason.kind === 'completed'
        ? { session, call, result, terminal } : undefined
    }, 'timed question timeout followed by independent Agent continuation', (timeoutSeconds + 60) * 1000)
    assert.equal(await late.page.getByRole('button', { name: /^(Stop the current agent run|停止当前 Agent 操作)$/ }).count(), 0,
      'a continued question must not expose Stop for a different or already-ended turn')
    assert.match(assistantText(latePending.session, latePending.terminal.data.turn), /BROWSER_NATIVE_TIMED_HITL_LATE_REPLY_CONTINUED_WITHOUT_ANSWER/)
    assert.equal(eventsOf(latePending.session).filter(event => event.type === 'tool/call'
      && event.data.name === 'write').length, 0, 'Agent must not perform the gated write before the late answer')
    assert.equal((await currentManifest(late.page)).revision, 0)
    await submitYes(late.page)
    const lateReply = await waitFor(async () => {
      const session = await readSession(late.sessionId)
      const replies = questionReplyEvents(session, latePending.call.data.callId)
      return replies.length === 1 ? { session, reply: replies[0] } : undefined
    }, 'durable late answer message', 30_000)
    assert.equal(lateReply.reply.data.source.outcome, 'answered')
    assert.match(eventText(lateReply.reply), /"kind":"answer_to_pending_question"/)
    assert.equal(pendingResult(toolResult(lateReply.session, latePending.call.data.callId)), true,
      'late answer must not rewrite the timed tool result')
    const lateWrite = await waitFor(async () => {
      const session = await readSession(late.sessionId)
      const call = eventsOf(session).find(event => event.type === 'tool/call' && event.data.name === 'write')
      const terminal = call === undefined ? undefined : eventsOf(session).findLast(event => event.type === 'turn/end'
        && event.data.turn === call.data.turn)
      return call !== undefined && terminal?.data.reason.kind === 'completed' ? { session, call, terminal } : undefined
    }, 'one business write after late answer admission', 60_000)
    assert.equal(eventsOf(lateWrite.session).filter(event => event.type === 'tool/call'
      && event.data.name === 'ask_user_question').length, 1)
    assert.equal(eventsOf(lateWrite.session).filter(event => event.type === 'tool/call'
      && event.data.name === 'write').length, 1)
    assert.match(assistantText(lateWrite.session, lateWrite.terminal.data.turn), /BROWSER_NATIVE_TIMED_HITL_LATE_REPLY_ANSWER_ADMITTED/)
    assert.equal((await currentManifest(late.page)).revision, 1)
    await late.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForPreview(late.page)
    assert.equal((await readSession(late.sessionId)).events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user-question-reply'
      && event.data.source.callId === latePending.call.data.callId).length, 1,
    'refresh must not duplicate a late answer')
    assert.equal((await currentManifest(late.page)).revision, 1, 'refresh must not repeat the gated write')
    await late.context.close()
  }

  if (selectedScenario === 'refresh-before-answer') {
    phase = 'refresh-before-answer'
    const refresh = await launchQuestion('BROWSER_NATIVE_TIMED_HITL_REFRESH')
    const refreshAsk = refresh.asked.call
    const llmBeforeRefresh = mainModelRequestCount()
    await refresh.page.reload({ waitUntil: 'domcontentloaded' })
    await refresh.page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined,
      { timeout: 30_000 })
    const recoveredQuestion = await waitFor(async () => {
      const session = await readSession(refresh.sessionId)
      const result = toolResult(session, refreshAsk.data.callId)
      const terminal = eventsOf(session).findLast(event => event.type === 'turn/end'
        && event.data.turn === refreshAsk.data.turn)
      return result?.data.error?.code === 'TOOL_OUTCOME_UNKNOWN' && terminal !== undefined
        ? { session, result, terminal } : undefined
    }, 'timed question recovery after Worker refresh', 45_000)
    assert.notEqual(recoveredQuestion.terminal.data.reason.kind, 'completed')
    const recoveredCard = await waitForQuestionCard(refresh.page)
    assert.equal(await recoveredCard.getByRole('radio', { name: 'Yes' }).count(), 1,
      'continued question card must be rebuilt from the same Session call')
    await submitYes(refresh.page)
    const refreshedReply = await waitFor(async () => {
      const session = await readSession(refresh.sessionId)
      const replies = questionReplyEvents(session, refreshAsk.data.callId)
      const terminal = eventsOf(session).findLast(event => event.type === 'turn/end'
        && event.data.turn !== refreshAsk.data.turn)
      return replies.length === 1 && terminal?.data.reason.kind === 'completed'
        ? { session, reply: replies[0], terminal } : undefined
    }, 'same-call late answer after Worker refresh', 60_000)
    assert.equal(refreshedReply.reply.data.source.callId, refreshAsk.data.callId)
    assert.equal(eventsOf(refreshedReply.session).filter(event => event.type === 'tool/call'
      && event.data.name === 'ask_user_question').length, 1)
    assert.equal(mainModelRequestCount(), llmBeforeRefresh + 1,
      'refresh must not resume the old prompt; only the explicit late answer starts a model turn')
    assert.match(assistantText(refreshedReply.session, refreshedReply.terminal.data.turn), /BROWSER_NATIVE_TIMED_HITL_REFRESH_ANSWER_ADMITTED/)
    await refresh.context.close()
  }

  if (selectedScenario === 'refresh-after-answer') {
    phase = 'refresh-after-durable-answer'
    const replyRefresh = await launchQuestion('BROWSER_NATIVE_TIMED_HITL_REPLY_REFRESH')
    const replyRefreshAsk = replyRefresh.asked.call
    const originalTurn = replyRefreshAsk.data.turn
    await waitFor(async () => {
      const session = await readSession(replyRefresh.sessionId)
      const result = toolResult(session, replyRefreshAsk.data.callId)
      const terminal = eventsOf(session).findLast(event => event.type === 'turn/end'
        && event.data.turn === originalTurn)
      return pendingResult(result) && terminal?.data.reason.kind === 'completed' ? true : undefined
    }, 'timed question pending before late-answer response-loss test', (timeoutSeconds + 60) * 1000)
    await submitYes(replyRefresh.page)
    await waitFor(() => answerModelHeld ? true : undefined, 'late-answer model request barrier', 30_000)
    const durableReplyBeforeRefresh = await waitFor(async () => {
      const session = await readSession(replyRefresh.sessionId)
      const replies = questionReplyEvents(session, replyRefreshAsk.data.callId)
      return replies.length === 1 ? { session, reply: replies[0] } : undefined
    }, 'late answer durable before interrupted response', 30_000)
    assert.equal(durableReplyBeforeRefresh.reply.data.source.outcome, 'answered')
    await replyRefresh.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForPreview(replyRefresh.page)
    releaseAnswerModel.resolve()
    const replyTurn = await waitFor(async () => {
      const session = await readSession(replyRefresh.sessionId)
      const replies = questionReplyEvents(session, replyRefreshAsk.data.callId)
      const terminal = eventsOf(session).findLast(event => event.type === 'turn/end'
        && event.data.turn !== originalTurn)
      return replies.length === 1 && terminal !== undefined ? { session, terminal } : undefined
    }, 'interrupted answer-processing turn after Worker refresh', 45_000)
    assert.notEqual(replyTurn.terminal.data.reason.kind, 'completed')
    assert.equal(eventsOf(replyTurn.session).filter(event => event.type === 'tool/call'
      && event.data.name === 'ask_user_question').length, 1)
    assert.equal(questionReplyEvents(replyTurn.session, replyRefreshAsk.data.callId).length, 1)
    assert.equal(await replyRefresh.page.locator('[data-question-key]').count(), 0,
      'a durable answer must not return as an editable question after refresh')
    const followUp = 'BROWSER_NATIVE_TIMED_HITL_REPLY_REFRESH_CONTINUE'
    await replyRefresh.page.locator('[data-composer-input][contenteditable="true"]').last().fill(followUp)
    await replyRefresh.page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
    const afterReplyRefresh = await waitFor(async () => {
      const session = await readSession(replyRefresh.sessionId)
      const terminal = eventsOf(session).findLast(event => event.type === 'turn/end'
        && event.data.turn !== replyTurn.terminal.data.turn)
      return terminal?.data.reason.kind === 'completed' ? { session, terminal } : undefined
    }, 'explicit follow-up after answer-processing interruption', 60_000)
    assert.equal(questionReplyEvents(afterReplyRefresh.session, replyRefreshAsk.data.callId).length, 1)
    assert.equal(eventsOf(afterReplyRefresh.session).filter(event => event.type === 'tool/call'
      && event.data.name === 'ask_user_question').length, 1)
    await replyRefresh.context.close()
  }

  if (selectedScenario === 'hide-refresh') {
    phase = 'hide-and-refresh'
    const hidden = await launchQuestion('BROWSER_NATIVE_TIMED_HITL_STOP')
    const hiddenCard = hidden.page.locator('[data-question-key]').last()
    await hiddenCard.getByRole('button', { name: 'Close the panel — reopen it from the tool call' }).click()
    await hiddenCard.waitFor({ state: 'detached' })
    assert.equal(toolResult(await readSession(hidden.sessionId), hidden.asked.call.data.callId), undefined,
      'closing a keyed question panel must not settle or cancel the wait')
    await hidden.page.reload({ waitUntil: 'domcontentloaded' })
    await hidden.page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined,
      { timeout: 30_000 })
    const recovered = await waitFor(async () => {
      const session = await readSession(hidden.sessionId)
      const result = toolResult(session, hidden.asked.call.data.callId)
      const terminal = eventsOf(session).findLast(event => event.type === 'turn/end'
        && event.data.turn === hidden.asked.call.data.turn)
      return result?.data.error?.code === 'TOOL_OUTCOME_UNKNOWN' && terminal !== undefined
        ? { session, terminal } : undefined
    }, 'hidden question survives Worker refresh as a continued question', 45_000)
    assert.notEqual(recovered.terminal.data.reason.kind, 'completed')
    const recoveredCard = await waitForQuestionCard(hidden.page)
    assert.equal(await recoveredCard.getByRole('radio', { name: 'Yes' }).count(), 1,
      'the same timed question must be answerable after refresh')
    await submitYes(hidden.page)
    const recoveredReply = await waitFor(async () => {
      const session = await readSession(hidden.sessionId)
      const replies = questionReplyEvents(session, hidden.asked.call.data.callId)
      return replies.length === 1 ? { session, reply: replies[0] } : undefined
    }, 'answer after hiding and refreshing the question panel', 30_000)
    assert.equal(recoveredReply.reply.data.source.callId, hidden.asked.call.data.callId)
    assert.equal(eventsOf(recoveredReply.session).filter(event => event.type === 'tool/call'
      && event.data.name === 'ask_user_question').length, 1)
    await hidden.context.close()
  }

  if (selectedScenario === 'stop-timed' || selectedScenario === 'stop-legacy') {
    phase = selectedScenario === 'stop-timed' ? 'cancel-active-timed-question' : 'cancel-active-legacy-question'
    const marker = selectedScenario === 'stop-timed'
      ? 'BROWSER_NATIVE_TIMED_HITL_STOP'
      : 'BROWSER_NATIVE_LEGACY_HITL_STOP'
    const waiting = await launchQuestion(marker, selectedScenario === 'stop-timed')
    const card = waiting.page.locator('[data-question-key]').last()
    const stopButton = card.getByRole('button', { name: /^(Stop the current agent run|停止当前 Agent 操作)$/ })
    await stopButton.waitFor({ state: 'visible', timeout: 10_000 })
    await stopButton.click()
    const stopped = await waitForTerminal(waiting.sessionId, waiting.asked.call.data.turn,
      terminal => terminal.data.reason.kind === 'aborted')
    assert.equal(stopped.terminal.data.reason.kind, 'aborted')
    const result = toolResult(stopped.session, waiting.asked.call.data.callId)
    if (result !== undefined) {
      assert.ok(result.data.error !== undefined || result.data.message?.isError === true,
        'a cancelled ask tool cannot be recorded as a successful answer')
    }
    assert.equal(questionReplyEvents(stopped.session, waiting.asked.call.data.callId).length, 0,
      'Stop must not create an answer or late-reply message')
    assert.equal(eventsOf(stopped.session).filter(event => event.type === 'tool/call'
      && event.data.name === 'write').length, 0, 'Stop must prevent later business writes')
    assert.equal((await currentManifest(waiting.page)).revision, 0, 'Stop must not create a Workspace commit')
    assert.equal(mainModelRequestCount(), 1, 'Stop must not start a replacement model turn')
    await waiting.context.close()
  }

  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'timed-HITL-answer-timeout-refresh-hide-and-active-stop',
    timeoutSeconds,
    scenario: selectedScenario,
    llmRequestCount: modelRequests.length,
    sessionCreateCount: requests.filter(request => request.path.endsWith('/session/create')).length,
    pageErrors,
    externalRequests,
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    phase,
    failure: error instanceof Error ? error.message : String(error),
    requestPaths: requests.map(request => request.path),
    modelRequests: modelRequests.map(request => ({ purpose: request?.purpose, messageCount: request?.messages?.length })),
    pageErrors,
    externalRequests,
    pageText: lastPage !== undefined && !lastPage.isClosed()
      ? (await lastPage.locator('body').innerText().catch(() => '')).slice(-2500) : undefined,
    composer: lastPage !== undefined && !lastPage.isClosed()
      ? await lastPage.locator('[data-composer-input][contenteditable="true"]').evaluateAll(elements =>
        elements.map(element => ({ text: element.textContent, disabled: element.getAttribute('aria-disabled') }))).catch(() => []) : undefined,
  })}\n`)
  throw error
} finally {
  releaseAnswerModel.resolve()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
