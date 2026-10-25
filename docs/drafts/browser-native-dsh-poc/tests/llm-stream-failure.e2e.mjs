import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest, submitPrompt, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-stream-failure-e2e-')))
const browserChannel = process.env.DSH_POC_BROWSER ?? 'chrome'
let image
let app
let browser
let context
let page
let origin
const requests = []
const pageErrors = []
const nonLocalRequests = []
let clientCloseCount = 0

function latestPrompt(body) {
  return [...(body.messages ?? [])].reverse().find(message => message.role === 'user'
    && typeof message.content === 'string' && !message.content.startsWith('Current runtime context.'))?.content ?? ''
}

function eventsForTurn(session, turn) {
  return session.events.filter(event => event.data?.turn === turn)
}

function lastTurnEnd(session, turn) {
  return eventsForTurn(session, turn).findLast(event => event.type === 'turn/end')
}

function attemptFor(session, turn) {
  return eventsForTurn(session, turn).findLast(event => event.type === 'assistant/attempt')
}

function capturePage(pageToCapture) {
  pageToCapture.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch {}
    requests.push({ path: url.pathname, body })
  })
  pageToCapture.on('pageerror', error => pageErrors.push(error.message))
}

async function latestSession(sessionId) {
  return await sessionRequest(origin, 'read', { sessionId, offset: 0 })
}

async function submitAndInspect({ sessionId, prompt, expectedReason }) {
  const result = await submitPrompt({ page, origin, requests, sessionId, prompt, expectedReason, timeout: 45_000 })
  const terminal = lastTurnEnd(result.session, result.turn)
  assert.ok(terminal, `missing terminal event for ${prompt}`)
  return { ...result, terminal, events: eventsForTurn(result.session, result.turn) }
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    ownerLeaseMs: 1_500,
    testHooks: {
      scriptedLlmFault: body => {
        const prompt = latestPrompt(body)
        if (prompt.includes('BROWSER_NATIVE_PARTIAL_TEXT_STREAM_E2E')) {
          return { kind: 'partial-text', text: 'PARTIAL_TEXT_VISIBLE_BUT_NOT_COMPLETE' }
        }
        if (prompt.includes('BROWSER_NATIVE_PARTIAL_TOOL_STREAM_E2E')) {
          return {
            kind: 'partial-tool-call',
            id: 'browser-native-partial-tool-e2e',
            name: 'write',
            argumentsDelta: '{"file_path":"/dsh/home/workspace/never-created.txt","content":"incomplete',
          }
        }
        if (prompt.includes('BROWSER_NATIVE_WORKER_STREAM_TERMINATE_E2E')) {
          return {
            kind: 'delayed-text',
            delayMs: 5_000,
            text: 'STREAM_TERMINATION_SHOULD_NOT_COMPLETE',
            prefix: 'STREAM_TERMINATION_PREFIX',
          }
        }
        if (prompt.includes('BROWSER_NATIVE_STOP_STREAM_E2E')) {
          return { kind: 'delayed-text', delayMs: 5_000, text: 'STOP_STREAM_SHOULD_NOT_COMPLETE' }
        }
        return undefined
      },
      onLlmClientClose: () => { clientCloseCount += 1 },
    },
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: browserChannel })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => {
    const workers = []
    Object.defineProperty(window, '__dshBrowserWorkers', { value: workers })
    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args, target)
        workers.push(worker)
        return worker
      },
    })
  })
  page = await context.newPage()
  capturePage(page)
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })

  const partialText = await submitAndInspect({
    prompt: 'BROWSER_NATIVE_PARTIAL_TEXT_STREAM_E2E：模拟模型文本输出一半后断流。',
    expectedReason: 'error',
  })
  const partialTextAttempt = attemptFor(partialText.session, partialText.turn)
  assert.ok(partialTextAttempt, 'partial text must persist an assistant attempt')
  assert.equal(partialText.events.some(event => event.type === 'assistant/message'), false)
  assert.equal(partialText.terminal.data.reason.kind, 'error')
  assert.equal(partialTextAttempt.data.stream.some(record => record.type === 'text-chunks'
    && record.texts.includes('PARTIAL_TEXT_VISIBLE_BUT_NOT_COMPLETE')), true)
  const partialTextFinish = partialTextAttempt.data.stream.find(record => record.type === 'chunk' && record.chunk.type === 'finish')
  assert.equal(partialTextFinish?.chunk.reason.kind, 'error')

  const textContinuation = await sendTurn({
    page,
    origin,
    requests,
    sessionId: partialText.sessionId,
    prompt: 'BROWSER_NATIVE_PARTIAL_TEXT_CONTINUE_OK：请继续一轮新的对话。',
    marker: 'BROWSER_NATIVE_PARTIAL_TEXT_CONTINUE_OK',
    timeout: 45_000,
  })
  assert.equal(lastTurnEnd(textContinuation.session, textContinuation.turn).data.reason.kind, 'completed')

  const partialTool = await submitAndInspect({
    sessionId: partialText.sessionId,
    prompt: 'BROWSER_NATIVE_PARTIAL_TOOL_STREAM_E2E：模拟工具参数 JSON 输出一半后断流。',
    expectedReason: 'error',
  })
  const partialToolEvents = partialTool.events
  assert.ok(attemptFor(partialTool.session, partialTool.turn), 'partial tool call must persist an assistant attempt')
  assert.equal(partialToolEvents.some(event => event.type === 'tool/call'), false)
  assert.equal(partialToolEvents.some(event => event.type === 'tool/result'), false)
  assert.equal(partialToolEvents.some(event => event.type === 'assistant/message'), false)
  assert.equal(partialTool.terminal.data.reason.kind, 'error')
  const manifestAfterPartialTool = await page.evaluate(async () => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.workspaceId)}`,
  )).json())
  assert.equal(manifestAfterPartialTool.revision, 0, 'an incomplete tool call must not commit Workspace bytes')

  const toolContinuation = await sendTurn({
    page,
    origin,
    requests,
    sessionId: partialText.sessionId,
    prompt: 'BROWSER_NATIVE_PARTIAL_TOOL_CONTINUE_OK：请开启新的安全对话。',
    marker: 'BROWSER_NATIVE_PARTIAL_TOOL_CONTINUE_OK',
    timeout: 45_000,
  })
  assert.equal(lastTurnEnd(toolContinuation.session, toolContinuation.turn).data.reason.kind, 'completed')

  const workerPrompt = 'BROWSER_NATIVE_WORKER_STREAM_TERMINATE_E2E：在模型流中终止 Worker。'
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(workerPrompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const workerRequestCount = await waitFor(
    () => requests.filter(request => request.path.endsWith('/llm') && latestPrompt(request.body) === workerPrompt).length,
    'Worker stream LLM request',
    15_000,
  )
  assert.equal(workerRequestCount, 1)
  await page.getByText('STREAM_TERMINATION_PREFIX', { exact: false }).last().waitFor({ timeout: 15_000 })
  const beforeWorkerTerminate = await waitFor(async () => {
    const session = await latestSession(partialText.sessionId)
    return session.events.some(event => event.type === 'user/message' && eventText(event) === workerPrompt) ? session : undefined
  }, 'Worker stream user event', 15_000)
  const workerBeforeTerminateCount = beforeWorkerTerminate.events.filter(event => event.type === 'turn/end').length
  await page.evaluate(() => {
    const worker = window.__dshBrowserWorkers.at(-1)
    if (worker === undefined) throw new Error('Dedicated Worker was not captured')
    worker.terminate()
  })
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1_800))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  const afterWorkerTerminate = await waitFor(async () => {
    const session = await latestSession(partialText.sessionId)
    const currentEnds = session.events.filter(event => event.type === 'turn/end').length
    return currentEnds > workerBeforeTerminateCount ? session : undefined
  }, 'Worker stream recovery terminal event', 30_000)
  const workerTurn = beforeWorkerTerminate.events.findLast(event => event.type === 'turn/start')?.data.turn
  const workerTerminal = afterWorkerTerminate.events.findLast(event => event.type === 'turn/end' && event.data.turn === workerTurn)
  if (workerTerminal !== undefined) assert.notEqual(workerTerminal.data.reason.kind, 'completed')
  assert.equal(requests.filter(request => request.path.endsWith('/llm') && latestPrompt(request.body) === workerPrompt).length, 1,
    'refresh must not replay the interrupted model request')
  assert.equal(afterWorkerTerminate.events.some(event => event.type === 'tool/call' && event.data.turn === workerTurn), false)
  assert.equal(afterWorkerTerminate.events.some(event => event.type === 'tool/result' && event.data.turn === workerTurn), false)

  const workerContinuation = await sendTurn({
    page,
    origin,
    requests,
    sessionId: partialText.sessionId,
    prompt: 'BROWSER_NATIVE_WORKER_STREAM_CONTINUE_OK：终止后继续新的对话。',
    marker: 'BROWSER_NATIVE_WORKER_STREAM_CONTINUE_OK',
    timeout: 45_000,
  })
  assert.equal(lastTurnEnd(workerContinuation.session, workerContinuation.turn).data.reason.kind, 'completed')

  const stopPrompt = 'BROWSER_NATIVE_STOP_STREAM_E2E：点击 Stop 取消延迟模型流。'
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(stopPrompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  await waitFor(
    () => requests.filter(request => request.path.endsWith('/llm') && latestPrompt(request.body) === stopPrompt).length,
    'Stop stream LLM request',
    15_000,
  )
  await page.getByRole('button', { name: /^(Stop generating|停止生成)$/ }).click()
  const stopped = await waitFor(async () => {
    const session = await latestSession(partialText.sessionId)
    const userIndex = session.events.findLastIndex(event => event.type === 'user/message' && eventText(event) === stopPrompt)
    const terminal = session.events.findLast((event, index) => index > userIndex && event.type === 'turn/end')
    return terminal?.data.reason.kind === 'aborted' ? { session, terminal } : undefined
  }, 'Stop stream aborted turn', 30_000)
  await waitFor(() => clientCloseCount >= 1, 'backend response close after Stop', 10_000)
  assert.equal(stopped.terminal.data.reason.kind, 'aborted')
  assert.equal(clientCloseCount >= 1, true)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])
  assert.equal(assistantText(stopped.session).includes('STOP_STREAM_SHOULD_NOT_COMPLETE'), false)
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browserChannel,
    scope: 'real-DSH-stream-failure-partial-text-partial-tool-worker-termination-and-stop',
    sessionId: partialText.sessionId,
    partialTextTurn: partialText.turn,
    partialToolTurn: partialTool.turn,
    workerTurn,
    workerRecovery: workerTerminal?.data.reason.kind ?? 'repair-without-turn-end',
    stopTurn: stopped.terminal.data.turn,
    backendClientCloseCount: clientCloseCount,
    llmRequestCount: requests.filter(request => request.path.endsWith('/llm')).length,
    pageErrors,
    nonLocalRequests,
  })}\n`)
} catch (error) {
  const sessionId = requests.find(request => request.path.endsWith('/session/create'))?.body?.sessionId
  const latest = sessionId && origin ? await latestSession(sessionId).catch(() => undefined) : undefined
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    sessionId,
    events: latest?.events?.map(event => ({ type: event.type, turn: event.data?.turn, reason: event.data?.reason })),
    requests: requests.map(request => ({ path: request.path, prompt: latestPrompt(request.body ?? {}) })),
    pageErrors,
    nonLocalRequests,
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}
