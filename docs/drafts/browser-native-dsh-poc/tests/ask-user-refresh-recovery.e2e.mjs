import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, rememberSessionPrincipal, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-ask-refresh-')))
const prompt = 'BROWSER_NATIVE_INTERACTION_TOOLS_E2E: ask before changing directory, then write a relative file.'
const requests = []
const pageErrors = []
const externalRequests = []
let image
let app
let browser
let page
let origin
let sessionId

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({ path: url.pathname, body })
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(prompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const createRequest = await waitFor(
    () => requests.find(request => request.path.endsWith('/session/create')),
    'Session creation for HITL refresh recovery',
  )
  sessionId = createRequest.body.sessionId
  await rememberSessionPrincipal(page, origin, sessionId)
  const asked = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const call = session.events?.find(event => event.type === 'tool/call' && event.data.name === 'ask_user_question')
    return call === undefined ? undefined : { session, call }
  }, 'persisted ask_user_question call before refresh', 30_000)
  const question = page.locator('[data-question-key]')
  await question.waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByText('May I continue with the file operation?', { exact: true }).waitFor()
  const llmRequestCountBeforeRefresh = requests.filter(request => request.path.endsWith('/llm')).length

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  const interrupted = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const result = session.events?.find(event => event.type === 'tool/result'
      && (event.data.callId === asked.call.data.callId || event.data.message?.toolCallId === asked.call.data.callId))
    return result === undefined ? undefined : { session, result }
  }, 'blocking question interruption after Worker restart', 45_000)
  const persistedCall = interrupted.session.events.find(event => event.type === 'tool/call'
    && event.data.callId === asked.call.data.callId)
  assert.ok(persistedCall)
  assert.equal(interrupted.result.data.message.isError, true)
  assert.equal(interrupted.result.data.error.code, 'TOOL_OUTCOME_UNKNOWN')
  assert.equal(interrupted.session.events.some(event => event.type === 'turn/end'
    && event.data.turn === asked.call.data.turn && event.data.reason.kind === 'completed'), false,
  'the interrupted Agent turn must not be reported as completed')
  assert.equal(await page.locator('[data-question-key]').count(), 0,
    'the UI must not present the terminated Worker Promise as an answerable question')
  assert.equal(requests.filter(request => request.path.endsWith('/llm')).length, llmRequestCountBeforeRefresh,
    'reopening a Session must not silently rerun the interrupted turn')

  const terminal = interrupted.session.events.find(event => event.type === 'turn/end'
    && event.data.turn === asked.call.data.turn)
  assert.ok(terminal)
  assert.notEqual(terminal.data.reason.kind, 'completed')
  const calls = interrupted.session.events.filter(event => event.type === 'tool/call'
    && event.data.turn === terminal.data.turn)
  assert.deepEqual(calls.map(event => event.data.name), ['ask_user_question'])
  assert.equal(interrupted.session.events.filter(event => event.type === 'tool/call'
    && event.data.name === 'ask_user_question').length, 1, 'refresh must not duplicate the question tool call')
  assert.equal(requests.filter(request => request.path.endsWith('/llm')).length, llmRequestCountBeforeRefresh,
    'reopening the Session must not silently continue the interrupted turn')
  const identity = await page.evaluate(async () => await (await fetch('/api/browser-native/workspace/identity')).json())
  const manifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), identity.workspaceId)
  assert.equal(manifest.revision, 0, 'the interrupted approval must not trigger a later file write')
  assert.equal(manifest.entries.some(entry => entry.path === 'interaction-dir/relative-result.txt'), false)

  const llmRequestsAfterRefresh = requests.filter(request => request.path.endsWith('/llm')).length
  assert.equal(llmRequestsAfterRefresh, llmRequestCountBeforeRefresh,
    'reopening a Session must not silently rerun the interrupted turn')
  const llmRequestsBeforeContinue = requests.filter(request => request.path.endsWith('/llm')).length
  const followUp = 'BROWSER_NATIVE_AFTER_HITL_REFRESH_CONTINUE：请只确认会话可以继续。'
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(followUp)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const continued = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const user = session.events?.findLast(event => event.type === 'user/message'
      && (typeof event.data.content === 'string'
        ? event.data.content
        : Array.isArray(event.data.content)
          ? event.data.content.filter(block => block?.type === 'text').map(block => block.text).join('')
          : '').includes('BROWSER_NATIVE_AFTER_HITL_REFRESH_CONTINUE'))
    const followUpTerminal = session.events?.findLast(event => event.type === 'turn/end'
      && event.data.turn !== terminal.data.turn)
    return user !== undefined && followUpTerminal?.data.reason.kind === 'completed'
      ? { session, user, terminal: followUpTerminal } : undefined
  }, 'explicit new user turn after interrupted question', 45_000)
  const continuedText = assistantText(continued.session, continued.terminal.data.turn)
  assert.match(continuedText, /BROWSER_NATIVE_AFTER_HITL_REFRESH_CONTINUE_OK/)
  assert.equal(requests.filter(request => request.path.endsWith('/llm')).length, llmRequestsBeforeContinue + 1)
  assert.equal(continued.session.events.filter(event => event.type === 'tool/call'
    && event.data.name === 'ask_user_question').length, 1, 'continuing must not rerun the interrupted question')
  const finalManifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), identity.workspaceId)
  assert.equal(finalManifest.revision, 0, 'the explicit follow-up must not execute the interrupted file operation')
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'same-tab-refresh-during-DSH-ask-user-question',
    sessionId,
    questionCallId: String(asked.call.data.callId),
    resumedQuestionCard: false,
    interruptedQuestionResult: interrupted.result.data.error.code,
    interruptedTurn: terminal.data.turn,
    toolNamesBeforeInterruption: calls.map(event => event.data.name),
    terminalReason: terminal.data.reason.kind,
    llmRequestsBeforeRefresh: llmRequestCountBeforeRefresh,
    llmRequestsAfterRefresh,
    explicitFollowUpTurn: continued.terminal.data.turn,
    followUpAssistantText: continuedText,
    llmRequestsAfterFollowUp: requests.filter(request => request.path.endsWith('/llm')).length,
    questionCallCount: interrupted.session.events.filter(event => event.type === 'tool/call'
      && event.data.name === 'ask_user_question').length,
    pageErrors,
    externalRequests,
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    sessionId,
    requests: requests.map(request => ({ path: request.path, sessionId: request.body?.sessionId, eventTypes: request.body?.events?.map(event => event.type) })),
    pageText: page !== undefined && !page.isClosed() ? (await page.locator('body').innerText().catch(() => '')).slice(-3000) : undefined,
    pageErrors,
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
