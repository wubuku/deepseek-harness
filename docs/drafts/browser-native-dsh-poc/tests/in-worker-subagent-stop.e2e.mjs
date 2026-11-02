import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, rememberSessionPrincipal, sessionRequest, submitPrompt, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
if (browserName !== 'chrome') throw new Error('In-Worker subagent stop validation runs only in Chrome')

const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-subagent-stop-')))
const PARENT_PROMPT = 'BROWSER_NATIVE_SUBAGENT_STOP_PARENT'
const CHILD_PROMPT = 'BROWSER_NATIVE_SUBAGENT_STOP_CHILD'
const RESUME_PROMPT = 'BROWSER_NATIVE_SUBAGENT_STOP_RESUME'
const unreleased = new Promise(() => {})
const requests = []
const pageErrors = []
const workerErrors = []
const externalRequests = []
let image
let app
let browser
let page
let origin

const llmRequests = () => requests.filter(request => request.path.endsWith('/llm'))
const chatRequests = () => llmRequests().filter(request => request.body.purpose === undefined)

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

function toolResultText(session, callId) {
  const result = session.events.findLast(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === String(callId))
  if (result === undefined) return ''
  const content = result.data.message.content
  return typeof content === 'string'
    ? content
    : (content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('')
}

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser-subagent' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: {
      scriptedLlmFault: body => {
        const texts = promptTexts(body)
        if (texts.some(text => text.includes(RESUME_PROMPT))) {
          return { kind: 'text', text: 'resumed after stop' }
        }
        if (texts.some(text => text.includes(CHILD_PROMPT))) {
          // The child keeps its first model request open until the stop.
          return {
            kind: 'barrier-tool-call',
            release: unreleased,
            call: { id: 'child-blocked-call', name: 'read', arguments: { file_path: '/dsh/home/workspace/child-blocked.txt' } },
          }
        }
        if (texts.some(text => text.includes(PARENT_PROMPT))) {
          const hasToolResult = messagesAfterPrompt(body, PARENT_PROMPT).some(message => message?.role === 'tool')
          if (!hasToolResult) {
            return {
              kind: 'tool-call',
              call: {
                id: 'stop-subagent-call',
                name: 'subagent',
                arguments: { description: 'stop probe child', prompt: CHILD_PROMPT },
              },
            }
          }
          // The parent stays in flight after the child was admitted.
          return {
            kind: 'barrier-tool-call',
            release: unreleased,
            call: { id: 'parent-blocked-call', name: 'read', arguments: { file_path: '/dsh/home/workspace/parent-blocked.txt' } },
          }
        }
        return { kind: 'text', text: 'unexpected scripted request' }
      },
    },
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: browserName })
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  context.on('page', tracked => {
    tracked.on('pageerror', error => pageErrors.push(error.message))
    tracked.on('request', request => {
      const url = new URL(request.url())
      if (url.origin !== origin) externalRequests.push(request.url())
      if (!url.pathname.startsWith('/api/browser-native/')) return
      let body = {}
      try { body = request.postDataJSON() ?? {} } catch { body = {} }
      requests.push({ path: url.pathname, body })
    })
    tracked.on('worker', worker => {
      worker.on('pageerror', error => workerErrors.push(error.message))
      worker.on('console', message => {
        if (message.type() === 'error') workerErrors.push(message.text())
      })
    })
  })
  page = await context.newPage()
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=subagent&preview-fixture=none`)
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })

  let childSessionId
  let requestsAtStop
  let parentToolResult
  const parent = await submitPrompt({
    page,
    origin,
    requests,
    prompt: PARENT_PROMPT,
    timeout: 90_000,
    expectedReason: 'aborted',
    probeWhileRunning: async ({ sessionId }) => {
      parentToolResult = await waitFor(async () => {
        const current = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
        if (!Array.isArray(current.events)) return undefined
        const call = current.events.find(event => event.type === 'tool/call' && event.data.name === 'subagent')
        if (call === undefined) return undefined
        const text = toolResultText(current, call.data.callId)
        return text.includes('started subagent') ? { session: current, call, text } : undefined
      }, 'subagent tool result naming the child Session', 60_000)
      const activated = parentToolResult.text.match(/started subagent (\S+)/)
      assert.ok(activated, `subagent tool result must expose the child id, got ${parentToolResult.text}`)
      childSessionId = activated[1]
      await rememberSessionPrincipal(page, origin, childSessionId)
      await waitFor(async () => {
        const child = await sessionRequest(origin, 'read', { sessionId: childSessionId, offset: 0 }).catch(() => undefined)
        if (!Array.isArray(child?.events)) return undefined
        return child.events.some(event => event.type === 'turn/start') ? true : undefined
      }, 'child turn to start', 60_000)
      // Both Agents must be in flight when the user presses Stop: the parent
      // after the child was admitted, the child on its first model request.
      await waitFor(() => {
        const parentLlm = chatRequests().filter(request => request.body.sessionId === sessionId)
        const childLlm = chatRequests().filter(request => request.body.sessionId === childSessionId)
        return parentLlm.length >= 2 && childLlm.length >= 1 ? true : undefined
      }, 'parent and child model requests in flight', 60_000)
      requestsAtStop = chatRequests().length
      const cancelled = await testAction({ action: 'cancel-session', sessionId })
      assert.equal(cancelled?.ok, true, `the Worker must cancel the running parent Agent: ${JSON.stringify(cancelled)}`)
    },
  })

  const parentEnd = parent.session.events.findLast(event => event.type === 'turn/end')
  assert.equal(parentEnd?.data.reason.kind, 'aborted')
  assert.equal(parentEnd?.data.reason.reason.kind, 'user', 'the parent turn must record the user stop')

  const child = await waitFor(async () => {
    const response = await sessionRequest(origin, 'read', { sessionId: childSessionId, offset: 0 }).catch(() => undefined)
    if (response?.status !== 200 || !Array.isArray(response.events)) return undefined
    return response.events.some(event => event.type === 'turn/end') ? response : undefined
  }, 'child session to end after the parent stop', 60_000)
  const childEnd = child.events.findLast(event => event.type === 'turn/end')
  assert.equal(childEnd.data.reason.kind, 'aborted', 'the child must be cancelled, not completed')
  assert.equal(childEnd.data.reason.reason.kind, 'parent', 'the child must record the ancestor stop')

  // The notice is recorded but must not wake the stopped Agent: no model
  // request may follow the stop, and neither Agent may open another turn.
  const settled = await waitFor(async () => {
    const state = await testAction({ action: 'agent-inbox', sessionId: parent.sessionId })
    const notices = (state?.inbox?.nextStep ?? [])
      .filter(text => text.includes('Background subagent') && text.includes(childSessionId))
    return notices.length > 0 ? state : undefined
  }, 'child settlement notice queued for the stopped parent', 30_000)
  await new Promise(resolveDelay => setTimeout(resolveDelay, 2_000))
  assert.equal(chatRequests().length, requestsAtStop, 'a stopped turn must not produce another model request')
  assert.equal(parent.session.events.filter(event => event.type === 'turn/end').length, 1,
    'the stopped parent must not open a second turn before the user resumes')
  assert.equal(child.events.filter(event => event.type === 'turn/end').length, 1,
    'the cancelled child must not open a second turn')
  assert.equal(requests.filter(request => request.path.endsWith('/session/create')).length, 2,
    'the stop must not publish another Session')
  assert.equal(parent.session.events.some(event => event.type === 'tool/call' && event.data.name === 'subagent'), true)

  // A later user message claims the queued notice, so the stop loses no work.
  const resumed = await submitPrompt({
    page,
    origin,
    requests,
    sessionId: parent.sessionId,
    prompt: RESUME_PROMPT,
    timeout: 60_000,
  })
  const noticeIndex = resumed.session.events.findIndex(event => event.type === 'user/message'
    && eventText(event).includes('Background subagent') && eventText(event).includes(childSessionId))
  const resumeIndex = resumed.session.events.findIndex(event => event.type === 'user/message'
    && eventText(event).trim() === RESUME_PROMPT)
  assert.ok(noticeIndex >= 0, 'the resumed Session must project the settlement notice')
  assert.ok(noticeIndex < resumeIndex, 'the settlement notice must be replayed before the resumed prompt')
  assert.equal(resumed.session.events.filter(event => event.type === 'turn/end').length, 2,
    'the resumed Session keeps the aborted turn and adds one completed turn')
  assert.equal(chatRequests().length, requestsAtStop + 1, 'only the resumed prompt may add a model request')
  assert.equal(requests.filter(request => request.path.endsWith('/session/create')).length, 2,
    'resuming the stopped Session must not publish another Session')

  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'in-worker-spawn-subagent-parent-stop',
    verdict: 'supported',
    childSessionId,
    parentTurnEnd: parentEnd.data.reason,
    childTurnEnd: childEnd.data.reason,
    settlementNoticeQueued: settled.inbox.nextStep.length,
    settlementNoticeReplayedBeforeResume: true,
    modelRequestsAtStop: requestsAtStop,
    modelRequestsAfterResume: llmRequests().length,
    sessionCreates: 2,
    note: 'The public Agent.cancel(user) path on a top-level Session stops the in-Worker spawned child through the SubagentRuntime ownership graph. The child Session stays continuable and its settlement notice is queued without waking the stopped parent, then claimed by the next user turn. This does not validate cross-tab control or out-of-process providers.',
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    result: 'failed',
    error: String(error),
    requests,
    pageErrors,
    workerErrors,
    externalRequests,
  })}\n`)
  throw error
} finally {
  await browser?.close().catch(() => undefined)
  await app?.close().catch(() => undefined)
  await image?.cleanup().catch(() => undefined)
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
}

function promptTexts(body) {
  return messageTexts(body, 'user')
}

function messageTexts(body, role) {
  return (body?.messages ?? []).filter(message => message?.role === role).flatMap(message => {
    if (typeof message.content === 'string') return [message.content]
    if (Array.isArray(message.content)) return message.content.filter(part => part?.type === 'text').map(part => part.text)
    return []
  })
}

function messagesAfterPrompt(body, prompt) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const index = messages.findLastIndex(message => message?.role === 'user' && typeof message.content === 'string' && message.content.includes(prompt))
  return index < 0 ? messages : messages.slice(index + 1)
}
