import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, rememberSessionPrincipal, sessionRequest, submitPrompt, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const mode = process.env.DSH_POC_LLM ?? 'scripted'
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
const envFile = process.env.DSH_POC_ENV_FILE
const alternateLlm = process.env.DSH_POC_LLM_ALT === '1'
if (mode !== 'real') throw new Error('Real subagent autonomy validation requires DSH_POC_LLM=real')
if (envFile === undefined) throw new Error('Real subagent autonomy validation requires DSH_POC_ENV_FILE')
if (browserName !== 'chrome') throw new Error('Real subagent autonomy validation runs only in Chrome')

/**
 * Read the alternate OpenAI-compatible provider from the credential file without persisting or logging it.
 * The default GPT group quota can be exhausted while the configured second endpoint still works.
 * @returns {Promise<object>} In-process backend overrides for the alternate endpoint.
 */
async function alternateLlmOptions() {
  const values = {}
  for (const line of (await readFile(envFile, 'utf8')).split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match !== null) values[match[1]] = match[2]
  }
  for (const name of ['OPENAI_MODEL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY']) {
    if (typeof values[name] !== 'string' || values[name].length === 0) throw new Error(`${name} is required for the alternate provider`)
  }
  return {
    model: values.OPENAI_MODEL,
    llmBaseUrl: values.OPENAI_BASE_URL,
    llmCompletionsPath: 'chat/completions',
    llmApiKey: values.OPENAI_API_KEY,
  }
}

const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-real-subagent-')))
const CHILD_PROMPT = 'Write a detailed, continuous 800-word essay about the history of tea. Do not use any tools and do not stop early.'
const PARENT_PROMPT = `Use the subagent tool exactly once with this prompt, copied verbatim: "${CHILD_PROMPT}" `
  + 'Immediately after the subagent tool result, write a continuous 700-word essay about the history of the bicycle. '
  + 'Do not use any other tool before finishing the essay.'
const RESUME_PROMPT = 'Reply exactly with REAL_SUBAGENT_RESUME_OK and nothing else.'
const requests = []
const openModelRequests = new Map()
const pageErrors = []
const workerErrors = []
const externalRequests = []
let image
let app
let browser
let origin
let page

const modelRequests = () => requests.filter(request => request.path.endsWith('/llm') && request.body.purpose === undefined)

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
    dataDir, distRoot: image.distRoot, llmMode: mode, envFile,
    ...(alternateLlm ? await alternateLlmOptions() : {}),
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: browserName })
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  context.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch { body = {} }
    requests.push({ path: url.pathname, body })
    if (url.pathname.endsWith('/llm') && body.purpose === undefined) openModelRequests.set(request, body.sessionId)
  })
  context.on('requestfinished', request => openModelRequests.delete(request))
  context.on('requestfailed', request => openModelRequests.delete(request))
  context.on('page', tracked => {
    tracked.on('pageerror', error => pageErrors.push(error.message))
    tracked.on('worker', worker => {
      worker.on('pageerror', error => workerErrors.push(error.message))
      worker.on('console', message => { if (message.type() === 'error') workerErrors.push(message.text()) })
    })
  })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => {
    worker.on('pageerror', error => workerErrors.push(error.message))
    worker.on('console', message => { if (message.type() === 'error') workerErrors.push(message.text()) })
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=subagent&preview-fixture=none`)
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })

  let childSessionId
  let requestsAtStop
  let openBeforeStop
  const parent = await submitPrompt({
    page,
    origin,
    requests,
    prompt: PARENT_PROMPT,
    timeout: 600_000,
    expectedReason: 'aborted',
    probeWhileRunning: async ({ sessionId }) => {
      const diagnostics = { reads: 0, eventTypes: [], assistant: '' }
      let delegated
      try {
        delegated = await waitFor(async () => {
          const current = await sessionRequest(origin, 'read', { sessionId, offset: 0 }).catch(() => undefined)
          if (!Array.isArray(current?.events)) return undefined
          diagnostics.reads += 1
          diagnostics.eventTypes = current.events.map(event => event.type)
          diagnostics.assistant = current.events.filter(event => event.type === 'assistant/message')
            .flatMap(event => event.data.message.content).filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 300)
          diagnostics.toolNames = current.events.filter(event => event.type === 'tool/call').map(event => event.data.name)
          diagnostics.turnEnd = current.events.findLast(event => event.type === 'turn/end')?.data.reason
          diagnostics.attempt = current.events.findLast(event => event.type === 'assistant/attempt')?.data
          const call = current.events.find(event => event.type === 'tool/call' && event.data.name === 'subagent')
          if (call === undefined) return undefined
          const text = toolResultText(current, call.data.callId)
          return text.includes('started subagent') ? { session: current, call, text } : undefined
        }, 'real model to delegate through the subagent tool', 120_000)
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify(diagnostics)}`)
      }
      const activated = delegated.text.match(/started subagent (\S+)/)
      assert.ok(activated, `subagent tool result must name the child Session, got ${delegated.text}`)
      childSessionId = activated[1]
      await rememberSessionPrincipal(page, origin, childSessionId)
      await waitFor(async () => {
        const child = await sessionRequest(origin, 'read', { sessionId: childSessionId, offset: 0 }).catch(() => undefined)
        if (!Array.isArray(child?.events)) return undefined
        return child.events.some(event => event.type === 'turn/start') ? true : undefined
      }, 'child turn to start', 120_000)
      openBeforeStop = await waitFor(async () => {
        const openSessions = [...openModelRequests.values()]
        const parentOpen = openSessions.filter(id => id === sessionId).length
        const childOpen = openSessions.filter(id => id === childSessionId).length
        return parentOpen > 0 && childOpen > 0 ? { parentOpen, childOpen } : undefined
      }, 'parent and child model streams to be open at the same time', 120_000)
      requestsAtStop = modelRequests().length
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
  }, 'child session to end after the parent stop', 120_000)
  const childEnd = child.events.findLast(event => event.type === 'turn/end')
  assert.equal(childEnd.data.reason.kind, 'aborted', 'the child must be cancelled, not completed')
  assert.equal(childEnd.data.reason.reason.kind, 'parent', 'the child must record the ancestor stop')

  const settled = await waitFor(async () => {
    const state = await testAction({ action: 'agent-inbox', sessionId: parent.sessionId })
    const notices = (state?.inbox?.nextStep ?? [])
      .filter(text => text.includes('Background subagent') && text.includes(childSessionId))
    return notices.length > 0 ? state : undefined
  }, 'child settlement notice queued for the stopped parent', 60_000)
  await new Promise(resolveDelay => setTimeout(resolveDelay, 2_000))
  assert.equal(modelRequests().length, requestsAtStop, 'a stopped turn must not produce another model request')
  assert.equal(parent.session.events.filter(event => event.type === 'turn/end').length, 1,
    'the stopped parent must not open a second turn before the user resumes')
  assert.equal(child.events.filter(event => event.type === 'turn/end').length, 1,
    'the cancelled child must not open a second turn')
  assert.equal(requests.filter(request => request.path.endsWith('/session/create')).length, 2,
    'the stop must not publish another Session')

  const resumed = await submitPrompt({
    page,
    origin,
    requests,
    sessionId: parent.sessionId,
    prompt: RESUME_PROMPT,
    timeout: 180_000,
  })
  const resumedText = resumed.session.events.filter(event => event.type === 'assistant/message' && event.data.turn === resumed.turn)
    .flatMap(event => event.data.message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.ok(resumedText.includes('REAL_SUBAGENT_RESUME_OK'), `resumed turn must contain the marker, got ${resumedText.slice(0, 200)}`)
  const noticeIndex = resumed.session.events.findIndex(event => event.type === 'user/message'
    && eventText(event).includes('Background subagent') && eventText(event).includes(childSessionId))
  const resumeIndex = resumed.session.events.findIndex(event => event.type === 'user/message'
    && eventText(event).trim() === RESUME_PROMPT)
  assert.ok(noticeIndex >= 0, 'the resumed Session must project the settlement notice')
  assert.ok(noticeIndex < resumeIndex, 'the settlement notice must be replayed before the resumed prompt')
  assert.equal(modelRequests().length, requestsAtStop + 1, 'only the resumed prompt may add a model request')
  assert.equal(requests.filter(request => request.path.endsWith('/session/create')).length, 2,
    'resuming the stopped Session must not publish another Session')

  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    model: app.llm.model,
    scope: 'real-model-autonomous-delegation-then-parent-stop',
    verdict: 'supported',
    childSessionId,
    delegatedWithoutScriptedModel: true,
    openStreamsAtStop: openBeforeStop,
    parentTurnEnd: parentEnd.data.reason,
    childTurnEnd: childEnd.data.reason,
    settlementNoticeQueued: settled.inbox.nextStep.length,
    settlementNoticeReplayedBeforeResume: true,
    modelRequestsAtStop: requestsAtStop,
    modelRequestsAfterResume: modelRequests().length,
    sessionCreates: 2,
    note: 'The real model chose the subagent tool from the prompt alone; both model streams were open when Agent.cancel(user) ran on the parent. The child inherited the cancellation, no request or turn followed, and the settlement notice was replayed before the resumed prompt.',
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    result: 'failed',
    error: String(error),
    modelRequests: modelRequests().map(request => ({ sessionId: request.body.sessionId, messages: request.body.messages?.length })),
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
