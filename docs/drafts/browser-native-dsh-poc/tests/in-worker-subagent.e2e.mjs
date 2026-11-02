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
if (browserName !== 'chrome') throw new Error('In-Worker subagent validation runs only in Chrome')

const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-subagent-')))
const PARENT_PROMPT = 'BROWSER_NATIVE_SUBAGENT_PARENT_TASK'
const CHILD_PROMPT = 'BROWSER_NATIVE_SUBAGENT_CHILD_WORK'
const DEPTH_PARENT_PROMPT = 'BROWSER_NATIVE_SUBAGENT_DEPTH_PARENT'
const DEPTH_CHILD_PROMPT = 'BROWSER_NATIVE_SUBAGENT_DEPTH_CHILD'
const NESTED_PROMPT = 'BROWSER_NATIVE_SUBAGENT_NESTED_MUST_NOT_START'
const requests = []
const pageErrors = []
const workerErrors = []
const externalRequests = []
let image
let app
let browser
let page
let origin

try {
  image = await createRuntimeValidationDist({ roster: 'browser-subagent' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: {
      scriptedLlmFault: body => {
        const texts = promptTexts(body)
        if (texts.some(text => text.includes(DEPTH_CHILD_PROMPT))) {
          const hasToolResult = messagesAfterPrompt(body, DEPTH_CHILD_PROMPT).some(message => message?.role === 'tool')
          if (!hasToolResult) {
            return {
              kind: 'tool-call',
              call: {
                id: 'nested-subagent-call',
                name: 'subagent',
                arguments: { description: 'nested attempt', prompt: NESTED_PROMPT },
              },
            }
          }
          return { kind: 'text', text: `${DEPTH_CHILD_PROMPT}_DONE` }
        }
        if (texts.some(text => text.includes(DEPTH_PARENT_PROMPT))) {
          const hasToolResult = messagesAfterPrompt(body, DEPTH_PARENT_PROMPT).some(message => message?.role === 'tool')
          if (!hasToolResult) {
            return {
              kind: 'tool-call',
              call: {
                id: 'depth-subagent-call',
                name: 'subagent',
                arguments: { description: 'depth probe child', prompt: DEPTH_CHILD_PROMPT },
              },
            }
          }
          return { kind: 'text', text: `${DEPTH_PARENT_PROMPT}_DONE` }
        }
        const isParent = texts.some(text => text.includes(PARENT_PROMPT))
        if (isParent) {
          const hasToolResult = messagesAfterParentPrompt(body).some(message => message?.role === 'tool')
          if (!hasToolResult) {
            return {
              kind: 'tool-call',
              call: {
                id: 'subagent-call-1',
                name: 'subagent',
                arguments: { description: 'child session work', prompt: CHILD_PROMPT },
              },
            }
          }
          return { kind: 'text', text: `${PARENT_PROMPT}_DONE` }
        }
        return { kind: 'text', text: `${CHILD_PROMPT}_DONE` }
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

  const parent = await submitPrompt({ page, origin, requests, prompt: PARENT_PROMPT, timeout: 90_000, expectedReason: 'completed' })
  const parentEnd = parent.session.events.findLast(event => event.type === 'turn/end')
  const toolCall = parent.session.events.find(event => event.type === 'tool/call' && event.data.name === 'subagent')
  assert.ok(toolCall !== undefined, 'the model-visible subagent tool must exist in the Worker profile')
  const toolResult = parent.session.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === toolCall.data.callId)
  assert.equal(toolResult?.data.error, undefined)
  const rendered = typeof toolResult?.data.message.content === 'string'
    ? toolResult.data.message.content
    : (toolResult?.data.message.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('')
  const activated = rendered.match(/started subagent (\S+)/)
  assert.ok(activated, `subagent tool result must expose the child id, got ${rendered}`)
  const childSessionId = activated[1]
  await rememberSessionPrincipal(page, origin, childSessionId)
  const child = await waitFor(async () => {
    const response = await sessionRequest(origin, 'read', { sessionId: childSessionId, offset: 0 }).catch(() => undefined)
    if (response?.status !== 200 || !Array.isArray(response.events)) return undefined
    return response.events.some(event => event.type === 'turn/end') ? response : undefined
  }, 'child session to finish', 90_000)
  const childEnd = child.events.findLast(event => event.type === 'turn/end')
  assert.equal(childEnd.data.reason.kind, 'completed')
  assert.equal(parentEnd?.data.reason.kind, 'completed')

  const childUserTexts = child.events.filter(event => event.type === 'user/message').map(eventText)
  assert.equal(childUserTexts.some(text => text.includes(CHILD_PROMPT)), true, 'child must receive its own prompt')
  assert.equal(childUserTexts.some(text => text.includes(PARENT_PROMPT)), false, 'spawn children must not inherit parent context')
  const workerLlm = requests.filter(request => request.path.endsWith('/llm') && request.body.purpose === undefined)
  const childLlm = workerLlm.filter(request => request.body.sessionId === childSessionId)
  const parentLlm = workerLlm.filter(request => request.body.sessionId === parent.sessionId
    && !promptTexts(request.body).some(text => text.includes('Background subagent')))
  assert.equal(childLlm.length, 1)
  assert.equal(promptTexts(childLlm[0].body).some(text => text.includes(CHILD_PROMPT)), true)
  const childTools = (childLlm[0].body.tools ?? []).map(tool => tool.function?.name)
  assert.equal(childTools.includes('write') && childTools.includes('read') && childTools.includes('subagent'), true,
    `child must inherit the published tool registry, got ${JSON.stringify(childTools)}`)
  assert.equal(parentLlm.length, 2)
  assert.equal(parentLlm.some(request => promptTexts(request.body).some(text => text.includes(CHILD_PROMPT))), false,
    'the parent must not observe the child prompt')
  assert.equal(parentLlm.some(request => messageTexts(request.body, 'tool').some(text => text.includes('started subagent'))), true,
    'the parent must resume after the subagent tool result')
  const parentAfter = await waitFor(async () => {
    const current = await sessionRequest(origin, 'read', { sessionId: parent.sessionId, offset: 0 })
    if (current?.status !== 200 || !Array.isArray(current.events)) return undefined
    return current.events.some(event => event.type === 'user/message'
      && eventText(event).includes('Background subagent')) ? current : undefined
  }, 'subagent settlement notice in the parent Session', 30_000)
  const settledNotice = parentAfter.events.find(event => event.type === 'user/message'
    && eventText(event).includes('Background subagent'))
  assert.equal(eventText(settledNotice).includes(childSessionId), true,
    'the settlement notice must name the child Session')
  assert.equal(eventText(settledNotice).includes(`${CHILD_PROMPT}_DONE`), true,
    'the settlement notice must carry the child final answer')
  const noticeRequest = await waitFor(() => requests.find(request => request.path.endsWith('/llm')
    && request.body.sessionId === parent.sessionId
    && promptTexts(request.body).some(text => text.includes('Background subagent'))),
  'parent model request carrying the settlement notice', 10_000)
  assert.ok(noticeRequest !== undefined, 'the settlement notice must start a parent turn')
  assert.equal(promptTexts(noticeRequest.body).some(text => text.includes(`${CHILD_PROMPT}_DONE`)), true,
    'the parent model must receive the child final answer')

  const depthParent = await submitPrompt({ page, origin, requests, prompt: DEPTH_PARENT_PROMPT, timeout: 90_000, expectedReason: 'completed' })
  const depthCall = depthParent.session.events.findLast(event => event.type === 'tool/call' && event.data.name === 'subagent')
  assert.ok(depthCall !== undefined, 'the depth probe parent must delegate once')
  const depthResult = depthParent.session.events.findLast(event => event.type === 'tool/result'
    && event.data.message.toolCallId === depthCall.data.callId)
  assert.equal(depthResult?.data.error, undefined)
  const depthRendered = eventText(depthResult)
  const depthActivated = depthRendered.match(/started subagent (\S+)/)
  assert.ok(depthActivated, `depth probe result must expose the child id, got ${depthRendered}`)
  const depthChildId = depthActivated[1]
  await rememberSessionPrincipal(page, origin, depthChildId)
  const depthChild = await waitFor(async () => {
    const response = await sessionRequest(origin, 'read', { sessionId: depthChildId, offset: 0 }).catch(() => undefined)
    if (response?.status !== 200 || !Array.isArray(response.events)) return undefined
    return response.events.some(event => event.type === 'turn/end') ? response : undefined
  }, 'depth probe child session to finish', 90_000)
  const depthChildEnd = depthChild.events.findLast(event => event.type === 'turn/end')
  assert.equal(depthChildEnd.data.reason.kind, 'completed')
  const nestedCall = depthChild.events.find(event => event.type === 'tool/call' && event.data.name === 'subagent')
  assert.ok(nestedCall !== undefined, 'the child must attempt a nested delegation')
  const nestedResult = depthChild.events.find(event => event.type === 'tool/result'
    && event.data.message.toolCallId === nestedCall.data.callId)
  assert.ok(nestedResult !== undefined,
    `missing nested tool result; events=${depthChild.events.map(event => event.type).join(',')}`)
  assert.equal(nestedResult.data.message.isError, true, 'the nested delegation must fail')
  assert.match(eventText(nestedResult), /subagent depth 2 exceeds maxDepth 1/)
  const depthContinuation = await waitFor(() => requests.find(request => request.path.endsWith('/llm')
    && request.body.sessionId === depthChildId
    && messageTexts(request.body, 'tool').some(text => text.includes('exceeds maxDepth 1'))),
  'request proving the child continued after the depth rejection', 10_000)
  assert.ok(depthContinuation !== undefined)
  assert.equal(requests.filter(request => request.path.endsWith('/session/create')).length, 3,
    'the depth rejection must not publish a third child Session')
  assert.equal(requests.some(request => promptTexts(request.body).some(text => text.includes(NESTED_PROMPT))), false,
    'the rejected nested prompt must never reach a model')
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'in-worker-spawn-subagent',
    verdict: 'supported',
    childSessionId,
    parentEvents: parent.session.events.length,
    parentEventsAfterNotice: parentAfter.events.length,
    childEvents: child.events.length,
    settlementNotice: true,
    childUserMessages: childUserTexts.length,
    childModelRequests: childLlm.length,
    parentModelRequests: parentLlm.length,
    depthChildId,
    depthRejected: 'subagent depth 2 exceeds maxDepth 1',
    depthChildModelRequests: requests.filter(request => request.path.endsWith('/llm')
      && request.body.sessionId === depthChildId).length,
    sessionCreates: 3,
    note: 'Spawn provider runs a fresh child Agent in the same Dedicated Worker through the real ctx.subagents service. The depth probe proves maxDepth 1 rejects a nested delegation without publishing a Session. This does not validate cancellation, fork providers, out-of-process providers, real-model delegation or cross-tab control.',
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
  await page?.context().close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}

function messageTexts(body, role) {
  return (body?.messages ?? []).filter(message => message?.role === role).flatMap(message => {
    if (typeof message.content === 'string') return [message.content]
    if (Array.isArray(message.content)) return message.content.filter(part => part?.type === 'text').map(part => part.text)
    return []
  })
}

function promptTexts(body) {
  return messageTexts(body, 'user')
}

function messagesAfterPrompt(body, prompt) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const index = messages.findLastIndex(message => message?.role === 'user' && typeof message.content === 'string' && message.content.includes(prompt))
  return index < 0 ? messages : messages.slice(index + 1)
}

function messagesAfterParentPrompt(body) {
  return messagesAfterPrompt(body, PARENT_PROMPT)
}

function eventText(event) {
  const content = event?.data?.message?.content ?? event?.data?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(part => part?.type === 'text').map(part => part.text).join('')
  return ''
}
