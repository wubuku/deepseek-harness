import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, rememberSessionPrincipal, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
if (browserName !== 'chrome') throw new Error('Session continuity validation runs only in Chrome')

const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-session-continuity-')))
const barriers = new Map([
  ['BROWSER_NATIVE_CONTINUITY_A_FIRST', Promise.withResolvers()],
  ['BROWSER_NATIVE_CONTINUITY_B_FIRST', Promise.withResolvers()],
  ['BROWSER_NATIVE_CONTINUITY_OPEN_FIRST', Promise.withResolvers()],
])
const TOOL_PROMPT = 'BROWSER_NATIVE_CONTINUITY_TOOL_FIRST'
const TOOL_CALL_ID = 'continuity-tool-hold'
const TOOL_HOLD_MS = 8_000
const requests = []
const pageErrors = []
const workerErrors = []
const externalRequests = []
let image
let app
let browser
let page
let origin

function latestPrompt(body) {
  return [...(body.messages ?? [])].reverse().find(message => message.role === 'user'
    && typeof message.content === 'string'
    && !message.content.startsWith('Current runtime context.')
    && !message.content.startsWith('[model changed:'))?.content ?? ''
}

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

async function workerRequest(request) {
  return await page.evaluate(async value => {
    const invoke = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof invoke !== 'function') throw new Error('Browser-Native Worker test port is unavailable')
    return await invoke(value)
  }, request)
}

async function readSession(sessionId) {
  return await sessionRequest(origin, 'read', { sessionId, offset: 0 })
}

async function terminalFor(sessionId, prompt, reason = undefined) {
  return await waitFor(async () => {
    const session = await readSession(sessionId)
    const userIndex = session.events.findLastIndex(event => event.type === 'user/message' && eventText(event) === prompt)
    if (userIndex < 0) return undefined
    const terminal = session.events.findLast((event, index) => index > userIndex && event.type === 'turn/end')
    if (terminal === undefined) return undefined
    if (reason !== undefined && terminal.data.reason.kind !== reason) return undefined
    return { session, terminal }
  }, `terminal event for ${sessionId}:${prompt}`, 45_000)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser-session-continuity' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: {
      scriptedLlmFault: body => {
        const prompt = latestPrompt(body)
        if (prompt === TOOL_PROMPT) {
          const promptIndex = body.messages.findLastIndex(message => message.role === 'user'
            && typeof message.content === 'string' && message.content.includes(TOOL_PROMPT))
          const toolResults = promptIndex < 0 ? [] : body.messages.slice(promptIndex + 1).filter(message => message.role === 'tool')
          if (toolResults.length === 0) {
            return { kind: 'tool-call', call: { id: TOOL_CALL_ID, name: 'browser_fork_hold_probe', arguments: { durationMs: TOOL_HOLD_MS } } }
          }
          return { kind: 'text', text: `${TOOL_PROMPT}_DONE` }
        }
        const barrier = barriers.get(prompt)
        if (barrier !== undefined) return { kind: 'barrier-text', release: barrier.promise, text: `${prompt}_DONE` }
        return { kind: 'text', text: `${prompt}_DONE` }
      },
    },
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: browserName })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => {
    worker.on('pageerror', error => workerErrors.push(error.message))
    worker.on('console', message => {
      if (message.type() === 'error') workerErrors.push(message.text())
    })
  })
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url())
    if (!request.url().endsWith('/api/browser-native/llm')) return
    try {
      const body = JSON.parse(request.postData() ?? '{}')
      if (body.purpose === undefined) requests.push({ sessionId: body.sessionId, model: body.model, prompt: latestPrompt(body) })
    } catch {}
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-test=session-continuity&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })

  const startedA = await workerRequest({
    action: 'session-continuity-start',
    sessionId: 'continuity-a',
    prompt: 'BROWSER_NATIVE_CONTINUITY_A_FIRST',
    provider: 'browser-native',
    model: 'browser-native-route-a',
  })
  const startedB = await workerRequest({
    action: 'session-continuity-start',
    sessionId: 'continuity-b',
    prompt: 'BROWSER_NATIVE_CONTINUITY_B_FIRST',
  })
  const startedOpen = await workerRequest({
    action: 'session-continuity-start',
    sessionId: 'continuity-open',
    prompt: 'BROWSER_NATIVE_CONTINUITY_OPEN_FIRST',
  })
  assert.equal(startedA.ok, true, JSON.stringify(startedA))
  assert.equal(startedB.ok, true, JSON.stringify(startedB))
  assert.equal(startedOpen.ok, true, JSON.stringify(startedOpen))
  await rememberSessionPrincipal(page, origin, 'continuity-a')
  await rememberSessionPrincipal(page, origin, 'continuity-b')
  await rememberSessionPrincipal(page, origin, 'continuity-open')
  await waitFor(() => requests.filter(request => request.sessionId === 'continuity-a').length === 1, 'first A model request')
  await waitFor(() => requests.filter(request => request.sessionId === 'continuity-b').length === 1, 'first B model request')
  await waitFor(() => requests.filter(request => request.sessionId === 'continuity-open').length === 1, 'first open-tail model request')

  const queuedA = await workerRequest({ action: 'session-continuity-queue', sessionId: 'continuity-a', prompt: 'BROWSER_NATIVE_CONTINUITY_A_QUEUED' })
  assert.equal(queuedA.ok, true, JSON.stringify(queuedA))
  assert.equal(queuedA.sessionContinuity.nextTurnCount, 1)
  assert.equal(requests.filter(request => request.sessionId === 'continuity-a').length, 1)
  barriers.get('BROWSER_NATIVE_CONTINUITY_A_FIRST').resolve()
  await terminalFor('continuity-a', 'BROWSER_NATIVE_CONTINUITY_A_QUEUED')
  const queuedSession = await readSession('continuity-a')
  assert.equal(queuedSession.events.filter(event => event.type === 'user/message' && eventText(event) === 'BROWSER_NATIVE_CONTINUITY_A_QUEUED').length, 1)
  assert.equal(requests.filter(request => request.sessionId === 'continuity-a' && request.prompt === 'BROWSER_NATIVE_CONTINUITY_A_QUEUED').length, 1)

  const queuedB = await workerRequest({ action: 'session-continuity-queue', sessionId: 'continuity-b', prompt: 'BROWSER_NATIVE_CONTINUITY_B_QUEUED' })
  assert.equal(queuedB.ok, true, JSON.stringify(queuedB))
  const canceledB = await workerRequest({ action: 'session-continuity-cancel-keep-inbox', sessionId: 'continuity-b' })
  assert.equal(canceledB.ok, true, JSON.stringify(canceledB))
  assert.equal(canceledB.sessionContinuity.nextTurnCount, 1)
  barriers.get('BROWSER_NATIVE_CONTINUITY_B_FIRST').resolve()
  await terminalFor('continuity-b', 'BROWSER_NATIVE_CONTINUITY_B_FIRST', 'aborted')
  assert.equal(requests.some(request => request.sessionId === 'continuity-b' && request.prompt === 'BROWSER_NATIVE_CONTINUITY_B_QUEUED'), false)
  const wakeB = await workerRequest({ action: 'session-continuity-followup', sessionId: 'continuity-b', prompt: 'BROWSER_NATIVE_CONTINUITY_B_WAKE' })
  assert.equal(wakeB.ok, true, JSON.stringify(wakeB))
  const continuedB = await terminalFor('continuity-b', 'BROWSER_NATIVE_CONTINUITY_B_WAKE', 'completed')
  assert.equal(continuedB.session.events.filter(event => event.type === 'user/message' && eventText(event) === 'BROWSER_NATIVE_CONTINUITY_B_QUEUED').length, 1)
  assert.equal(continuedB.session.events.filter(event => event.type === 'user/message' && eventText(event) === 'BROWSER_NATIVE_CONTINUITY_B_WAKE').length, 1)

  const resumed = await workerRequest({ action: 'session-continuity-resume', sessionId: 'continuity-a', prompt: 'BROWSER_NATIVE_CONTINUITY_A_RESUMED' })
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.deepEqual(resumed.sessionContinuity.route, { provider: 'browser-native', model: 'browser-native-route-a' })
  await waitFor(() => requests.some(request => request.sessionId === 'continuity-a' && request.prompt === 'BROWSER_NATIVE_CONTINUITY_A_RESUMED'), 'resumed A request')
  const resumedRequest = requests.find(request => request.sessionId === 'continuity-a' && request.prompt === 'BROWSER_NATIVE_CONTINUITY_A_RESUMED')
  assert.equal(resumedRequest.model, 'browser-native-route-a')
  const resumedSession = await terminalFor('continuity-a', 'BROWSER_NATIVE_CONTINUITY_A_RESUMED', 'completed')
  const parentEventCount = resumedSession.session.events.length

  const forked = await workerRequest({ action: 'session-continuity-fork', sessionId: 'continuity-a', childSessionId: 'continuity-a-child' })
  assert.equal(forked.ok, true, JSON.stringify(forked))
  assert.equal(forked.sessionContinuity.parentSessionId, 'continuity-a')
  assert.equal(forked.sessionContinuity.inheritedEventCount, parentEventCount)
  await rememberSessionPrincipal(page, origin, 'continuity-a-child')
  const childFollowup = await workerRequest({ action: 'session-continuity-followup', sessionId: 'continuity-a-child', prompt: 'BROWSER_NATIVE_CONTINUITY_CHILD' })
  assert.equal(childFollowup.ok, true, JSON.stringify(childFollowup))
  const childDone = await terminalFor('continuity-a-child', 'BROWSER_NATIVE_CONTINUITY_CHILD', 'completed')
  const parentAfterChild = await readSession('continuity-a')
  assert.equal(parentAfterChild.events.length, parentEventCount)
  assert.equal(childDone.session.header.parentSession, 'continuity-a')
  assert.equal(childDone.session.header.isSeeded, true)
  assert.equal(childDone.session.events.filter(event => event.type === 'user/message' && eventText(event) === 'BROWSER_NATIVE_CONTINUITY_CHILD').length, 1)
  assert.equal(childDone.session.events.some(event => event.type === 'user/message' && eventText(event) === 'BROWSER_NATIVE_CONTINUITY_A_RESUMED'), true)

  const openForked = await workerRequest({ action: 'session-continuity-fork', sessionId: 'continuity-open', childSessionId: 'continuity-open-child' })
  assert.equal(openForked.ok, true, JSON.stringify(openForked))
  assert.equal(openForked.sessionContinuity.parentSessionId, 'continuity-open')
  await rememberSessionPrincipal(page, origin, 'continuity-open-child')
  barriers.get('BROWSER_NATIVE_CONTINUITY_OPEN_FIRST').resolve()
  await terminalFor('continuity-open', 'BROWSER_NATIVE_CONTINUITY_OPEN_FIRST', 'completed')
  const openChildFollowup = await workerRequest({ action: 'session-continuity-followup', sessionId: 'continuity-open-child', prompt: 'BROWSER_NATIVE_CONTINUITY_OPEN_CHILD' })
  assert.equal(openChildFollowup.ok, true, JSON.stringify(openChildFollowup))
  const openChildDone = await terminalFor('continuity-open-child', 'BROWSER_NATIVE_CONTINUITY_OPEN_CHILD', 'completed')
  assert.equal(openChildDone.session.header.parentSession, 'continuity-open')
  assert.equal(openChildDone.session.header.isSeeded, true)
  assert.equal(openChildDone.session.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'forked'), true)
  assert.equal(requests.filter(request => request.sessionId === 'continuity-open' && request.prompt === 'BROWSER_NATIVE_CONTINUITY_OPEN_FIRST').length, 1)
  assert.equal(requests.filter(request => request.sessionId === 'continuity-open-child' && request.prompt === 'BROWSER_NATIVE_CONTINUITY_OPEN_FIRST').length, 0)

  const toolStarted = await workerRequest({ action: 'session-continuity-start', sessionId: 'continuity-tool', prompt: TOOL_PROMPT })
  assert.equal(toolStarted.ok, true, JSON.stringify(toolStarted))
  await rememberSessionPrincipal(page, origin, 'continuity-tool')
  await waitFor(() => requests.filter(request => request.sessionId === 'continuity-tool').length === 1, 'hold-tool model request')
  const openCall = await waitFor(async () => {
    const session = await readSession('continuity-tool')
    return session.events.find(event => event.type === 'tool/call' && event.data.callId === TOOL_CALL_ID)
  }, 'hold tool call to be recorded', 30_000)
  const parentCountAtToolCut = (await readSession('continuity-tool')).events.length
  const toolForked = await workerRequest({
    action: 'session-continuity-fork',
    sessionId: 'continuity-tool',
    childSessionId: 'continuity-tool-child',
    boundary: openCall.seq,
  })
  assert.equal(toolForked.ok, true, JSON.stringify(toolForked))
  assert.equal(toolForked.sessionContinuity.boundary, openCall.seq)
  assert.deepEqual(toolForked.sessionContinuity.openToolResults, [{
    callId: TOOL_CALL_ID,
    code: 'TOOL_OUTCOME_UNKNOWN',
    sourceEventSeqs: [openCall.seq],
  }])
  await rememberSessionPrincipal(page, origin, 'continuity-tool-child')
  assert.equal((await readSession('continuity-tool')).events.length, parentCountAtToolCut, 'fork must not append to the parent log')
  const toolChildFollowup = await workerRequest({ action: 'session-continuity-followup', sessionId: 'continuity-tool-child', prompt: 'BROWSER_NATIVE_CONTINUITY_TOOL_CHILD' })
  assert.equal(toolChildFollowup.ok, true, JSON.stringify(toolChildFollowup))
  const toolChildDone = await terminalFor('continuity-tool-child', 'BROWSER_NATIVE_CONTINUITY_TOOL_CHILD', 'completed')
  const toolChildCalls = toolChildDone.session.events.filter(event => event.type === 'tool/call' && event.data.callId === TOOL_CALL_ID)
  const toolChildResults = toolChildDone.session.events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === TOOL_CALL_ID)
  assert.equal(toolChildCalls.length, 1, 'child must inherit exactly one tool call and must not re-execute it')
  assert.equal(toolChildCalls[0].seq, openCall.seq)
  assert.equal(toolChildResults.length, 1)
  assert.deepEqual(toolChildResults[0].data.error, { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' })
  assert.equal(toolChildDone.session.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'forked'), true)
  assert.equal(requests.filter(request => request.sessionId === 'continuity-tool-child').length, 1)
  assert.equal(requests.filter(request => request.sessionId === 'continuity-tool-child' && request.prompt === TOOL_PROMPT).length, 0)

  const toolParentDone = await terminalFor('continuity-tool', TOOL_PROMPT, 'completed')
  const toolParentCalls = toolParentDone.session.events.filter(event => event.type === 'tool/call' && event.data.callId === TOOL_CALL_ID)
  const toolParentResults = toolParentDone.session.events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === TOOL_CALL_ID)
  assert.equal(toolParentCalls.length, 1, 'parent must execute the held tool exactly once')
  assert.equal(toolParentResults.length, 1)
  assert.equal(toolParentResults[0].data.error, undefined)
  assert.equal(toolParentDone.session.events.filter(event => event.type === 'user/message' && eventText(event) === TOOL_PROMPT).length, 1)
  assert.equal(requests.filter(request => request.sessionId === 'continuity-tool').length, 2)

  const disposed = await workerRequest({ action: 'session-continuity-dispose' })
  assert.deepEqual(disposed.sessionContinuity, { disposedCount: 7, remainingCount: 0 })
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'session-continuity-busy-inbox-cancel-keep-inbox-resume-route-and-fork',
    requestCount: requests.length,
    requests,
    parentEventCount,
    childEventCount: childDone.session.events.length,
    openChildEventCount: openChildDone.session.events.length,
    openToolCut: {
      boundary: openCall.seq,
      seededCode: toolForked.sessionContinuity.openToolResults[0].code,
      childEventCount: toolChildDone.session.events.length,
      parentEventCount: toolParentDone.session.events.length,
      parentModelRequestCount: requests.filter(request => request.sessionId === 'continuity-tool').length,
    },
    pageErrors,
    workerErrors,
    externalRequests,
  })}\n`)
} catch (error) {
  const sessions = await Promise.all(['continuity-a', 'continuity-b', 'continuity-open'].map(async sessionId => {
    try {
      const session = await readSession(sessionId)
      return {
        sessionId,
        eventTypes: session.events.map(event => event.type),
        failure: session.events.filter(event => ['step/end', 'turn/end', 'assistant/attempt'].includes(event.type)).map(event => ({ type: event.type, data: event.data })),
      }
    } catch (readError) {
      return { sessionId, readError: String(readError) }
    }
  }))
  process.stderr.write(`${JSON.stringify({ result: 'failed', error: String(error), requests, sessions, pageErrors, workerErrors, externalRequests })}\n`)
  throw error
} finally {
  for (const barrier of barriers.values()) barrier.resolve()
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
