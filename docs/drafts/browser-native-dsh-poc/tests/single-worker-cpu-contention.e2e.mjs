import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import {
  openPreview,
  rememberSessionPrincipal,
  sessionRequest,
  waitFor,
  waitForPreview,
} from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
if (browserName !== 'chrome') throw new Error('Single-Worker CPU contention validation runs only in Chrome')

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function scenario(mode) {
  return {
    mode,
    agents: [
      { sessionId: `cpu-${mode}-agent-${randomUUID()}`, prompt: `BROWSER_NATIVE_CPU_${mode.toUpperCase()}_AGENT` },
      { sessionId: `cpu-${mode}-peer-${randomUUID()}`, prompt: `BROWSER_NATIVE_CPU_${mode.toUpperCase()}_PEER` },
    ],
    toolResponse: deferred(),
    peerResponse: deferred(),
    afterToolResponse: deferred(),
  }
}

const scenarios = [scenario('blocking'), scenario('cooperative')]
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-cpu-contention-')))
const gatedRequests = []
const modelRequestTrace = []
const barrierReleaseTrace = []
const closedRequests = []
const finishedModelRequests = []
const pageErrors = []
const workerErrors = []
const workerWarnings = []
const externalRequests = []
let image
let app
let browser
let context
let page
let origin

function modelFault(body) {
  if (body.purpose !== undefined || typeof body.sessionId !== 'string') return undefined
  modelRequestTrace.push({
    sessionId: body.sessionId,
    toolNames: (body.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter(name => typeof name === 'string'),
    messageRoles: body.messages.map(message => message.role),
  })
  for (const test of scenarios) {
    const [cpuAgent, peerAgent] = test.agents
    if (body.sessionId === peerAgent.sessionId) {
      gatedRequests.push({ mode: test.mode, sessionId: body.sessionId })
      return {
        kind: 'barrier-text',
        release: test.peerResponse.promise,
        onReleased: () => barrierReleaseTrace.push({ mode: test.mode, sessionId: body.sessionId, at: Date.now() }),
        text: `${peerAgent.prompt}_DONE`,
      }
    }
    if (body.sessionId !== cpuAgent.sessionId) continue
    const promptIndex = body.messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(cpuAgent.prompt))
    const toolResults = promptIndex < 0 ? [] : body.messages.slice(promptIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      const cooperative = test.mode === 'cooperative'
      return {
        kind: 'barrier-tool-call',
        release: test.toolResponse.promise,
        onReleased: () => barrierReleaseTrace.push({ mode: test.mode, sessionId: body.sessionId, at: Date.now() }),
        call: {
          id: `cpu-${test.mode}-${cpuAgent.sessionId}`,
          name: cooperative ? 'browser_cpu_cooperative_probe' : 'browser_cpu_blocking_probe',
          arguments: cooperative ? { durationMs: 1_900, sliceMs: 8 } : { durationMs: 1_900 },
        },
      }
    }
    return { kind: 'barrier-text', release: test.afterToolResponse.promise, text: `${cpuAgent.prompt}_AFTER_TOOL` }
  }
  return undefined
}

async function workerRequest(body) {
  return await page.evaluate(async request => {
    const invoke = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof invoke !== 'function') throw new Error('Browser-Native Worker test port is unavailable')
    return await invoke(request)
  }, body)
}

async function enqueueCancel(sessionId) {
  return await page.evaluate(id => {
    const invoke = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof invoke !== 'function') throw new Error('Browser-Native Worker test port is unavailable')
    const key = `cpu-cancel-${id}`
    const promise = invoke({ action: 'multi-agent-cancel', sessionId: id })
      .then(response => ({ response, resolvedAt: Date.now() }))
    window.__dshCpuPendingCancels.set(key, promise)
    return { key, sentAt: Date.now() }
  }, sessionId)
}

async function settleCancel(key) {
  return await page.evaluate(async requestKey => {
    const promise = window.__dshCpuPendingCancels.get(requestKey)
    if (promise === undefined) throw new Error('CPU probe cancellation request was not recorded')
    return await promise
  }, key)
}

async function readSession(sessionId) {
  return await sessionRequest(origin, 'read', { sessionId, offset: 0 })
}

function hasTurnEnd(session) {
  return session.events?.some(event => event.type === 'turn/end') === true
}

async function cpuEvents() {
  return await page.evaluate(() => window.__dshCpuContentionEvents)
}

async function eventFor(mode, stage) {
  return await waitFor(async () => (await cpuEvents()).find(event => event.mode === mode && event.stage === stage),
    `${mode} CPU tool ${stage}`, 30_000)
}

async function waitForSettledSessions(test) {
  return await waitFor(async () => {
    const sessions = await Promise.all(test.agents.map(agent => readSession(agent.sessionId)))
    return sessions.every(hasTurnEnd) ? sessions : undefined
  }, `${test.mode} Agent turns to settle`, 30_000)
}

async function waitForPeerBarrier(test) {
  try {
    await waitFor(() => gatedRequests.some(request => request.mode === test.mode
      && request.sessionId === test.agents[1].sessionId), `${test.mode} peer model request to reach its barrier`, 10_000)
  } catch (error) {
    const [status, sessions] = await Promise.all([
      workerRequest({ action: 'multi-agent-status' }),
      Promise.all(test.agents.map(async agent => {
        const session = await readSession(agent.sessionId)
        return {
          sessionId: agent.sessionId,
          eventTypes: session.events?.map(event => event.type),
          terminalReasons: session.events?.filter(event => event.type === 'turn/end').map(event => event.data.reason),
        }
      })),
    ])
    throw new Error(JSON.stringify({ error: String(error), modelRequestTrace, gatedRequests, status, sessions, workerErrors }))
  }
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser-cpu-contention' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: {
      scriptedLlmFault: modelFault,
      onLlmClientClose: body => {
        if (typeof body.sessionId === 'string') closedRequests.push(body.sessionId)
      },
    },
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  await context.addInitScript(() => {
    const workers = []
    window.__dshBrowserWorkers = workers
    window.__dshCpuContentionEvents = []
    window.__DSH_BROWSER_NATIVE_CPU_CONTENTION_EVENT__ = event => window.__dshCpuContentionEvents.push(event)
    window.__dshCpuPendingCancels = new Map()
    window.__dshAnimationFrameCount = 0
    const sampleFrame = () => {
      window.__dshAnimationFrameCount += 1
      requestAnimationFrame(sampleFrame)
    }
    requestAnimationFrame(sampleFrame)
    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget)
        workers.push(worker)
        return worker
      },
    })
  })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => {
    worker.on('pageerror', error => workerErrors.push(error.message))
    worker.on('console', message => {
      if (message.type() === 'error') workerErrors.push(message.text())
      else if (message.type() === 'warning') workerWarnings.push(message.text())
    })
  })
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url())
  })
  page.on('requestfinished', request => {
    if (!request.url().endsWith('/api/browser-native/llm')) return
    try {
      const body = JSON.parse(request.postData() ?? '{}')
      if (body.purpose === undefined && typeof body.sessionId === 'string') {
        finishedModelRequests.push({ sessionId: body.sessionId, finishedAt: Date.now() })
      }
    } catch {
      finishedModelRequests.push({ sessionId: 'invalid-request-body', finishedAt: Date.now() })
    }
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-test=cpu-contention&preview-fixture=none`)
  await waitForPreview(page)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function')

  const blocking = scenarios[0]
  const blockingStart = await workerRequest({ action: 'multi-agent-start', agents: blocking.agents })
  assert.equal(blockingStart.ok, true, JSON.stringify(blockingStart))
  for (const agent of blocking.agents) await rememberSessionPrincipal(page, origin, agent.sessionId)
  await waitForPeerBarrier(blocking)
  await waitFor(() => modelRequestTrace.some(request => request.sessionId === blocking.agents[0].sessionId),
    'blocking CPU Agent model request to reach its barrier')
  blocking.toolResponse.resolve()
  let blockingStarted
  try {
    blockingStarted = await eventFor(blocking.mode, 'started')
  } catch (error) {
    const [status, sessions] = await Promise.all([
      workerRequest({ action: 'multi-agent-status' }),
      Promise.all(blocking.agents.map(agent => readSession(agent.sessionId))),
    ])
    throw new Error(JSON.stringify({ error: String(error), modelRequestTrace, status, sessions, workerErrors, pageErrors }))
  }
  assert.equal(blockingStarted.sessionId, blocking.agents[0].sessionId)
  const framesAtBlockingStart = await page.evaluate(() => window.__dshAnimationFrameCount)
  const blockingCancel = await enqueueCancel(blocking.agents[0].sessionId)
  blocking.peerResponse.resolve()
  const blockedPeerSession = await readSession(blocking.agents[1].sessionId)
  assert.equal(hasTurnEnd(blockedPeerSession), false, 'Worker must not consume the peer response during synchronous CPU work')
  assert.equal((await cpuEvents()).some(event => event.mode === blocking.mode && event.stage === 'completed'), false,
    'the Session snapshot must be read before the synchronous CPU tool completes')
  const blockingPeerReleased = await waitFor(() => barrierReleaseTrace.find(event => event.mode === blocking.mode
    && event.sessionId === blocking.agents[1].sessionId), 'blocking peer response to leave the backend barrier')
  const blockingCompleted = await eventFor(blocking.mode, 'completed')
  assert.ok(blockingPeerReleased.at < blockingCompleted.at,
    'backend must release the peer response while synchronous CPU work is still running')
  const blockingPeerResponse = await waitFor(() => finishedModelRequests.find(request => request.sessionId === blocking.agents[1].sessionId),
    'blocking peer model response request to finish')
  const blockingCancelResult = await settleCancel(blockingCancel.key)
  assert.equal(blockingCancelResult.response.ok, true, JSON.stringify(blockingCancelResult.response))
  assert.ok(blockingCancel.sentAt < blockingCompleted.at, 'cancel must be posted while synchronous CPU work is active')
  assert.ok(blockingCancelResult.resolvedAt >= blockingCompleted.at, 'Worker must handle cancel only after synchronous CPU work returns')
  const framesAfterBlocking = await page.evaluate(() => window.__dshAnimationFrameCount)
  assert.ok(framesAfterBlocking > framesAtBlockingStart, 'main-thread animation frames must advance during Worker CPU work')
  blocking.afterToolResponse.resolve()
  const blockingSessions = await waitForSettledSessions(blocking)
  const blockingCalls = blockingSessions[0].events.filter(event => event.type === 'tool/call'
    && event.data.name === 'browser_cpu_blocking_probe')
  assert.equal(blockingCalls.length, 1)
  assert.equal(blockingSessions[0].events.filter(event => event.type === 'tool/result'
    && event.data.message?.toolCallId === blockingCalls[0].data.callId).length, 1)

  const blockingDisposed = await workerRequest({ action: 'multi-agent-dispose' })
  assert.deepEqual(blockingDisposed.multiAgent, { disposedCount: 2, remainingCount: 0 })

  const cooperative = scenarios[1]
  const cooperativeStart = await workerRequest({ action: 'multi-agent-start', agents: cooperative.agents })
  assert.equal(cooperativeStart.ok, true, JSON.stringify(cooperativeStart))
  for (const agent of cooperative.agents) await rememberSessionPrincipal(page, origin, agent.sessionId)
  await waitForPeerBarrier(cooperative)
  await waitFor(() => modelRequestTrace.some(request => request.sessionId === cooperative.agents[0].sessionId),
    'cooperative CPU Agent model request to reach its barrier')
  cooperative.toolResponse.resolve()
  const cooperativeStarted = await eventFor(cooperative.mode, 'started')
  assert.equal(cooperativeStarted.sessionId, cooperative.agents[0].sessionId)
  const framesAtCooperativeStart = await page.evaluate(() => window.__dshAnimationFrameCount)
  cooperative.peerResponse.resolve()
  const cooperativePeerResponse = await waitFor(() => finishedModelRequests.find(request => request.sessionId === cooperative.agents[1].sessionId),
    'cooperative peer response to finish in the browser network stack')
  const cooperativePeerSession = await waitFor(async () => {
    const session = await readSession(cooperative.agents[1].sessionId)
    return hasTurnEnd(session) ? session : undefined
  }, 'peer Session to complete while cooperative CPU tool is active', 30_000)
  const cooperativePeerReleased = barrierReleaseTrace.find(event => event.mode === cooperative.mode
    && event.sessionId === cooperative.agents[1].sessionId)
  assert.ok(cooperativePeerReleased !== undefined)
  const eventsBeforeCooperativeCancel = await cpuEvents()
  assert.equal(eventsBeforeCooperativeCancel.some(event => event.mode === cooperative.mode && event.stage === 'completed'), false,
    'peer turn must settle before the cooperative CPU workload completes')
  const cooperativeCancel = await enqueueCancel(cooperative.agents[0].sessionId)
  const cooperativeCancelResult = await settleCancel(cooperativeCancel.key)
  assert.equal(cooperativeCancelResult.response.ok, true, JSON.stringify(cooperativeCancelResult.response))
  const cooperativeCancelled = await eventFor(cooperative.mode, 'cancelled')
  assert.ok(cooperativeCancelled.at < cooperativeStarted.at + 1_900,
    'cooperative tool must observe cancellation before its requested workload deadline')
  assert.ok(cooperativePeerResponse.finishedAt < cooperativeCancelled.at)
  assert.ok(cooperativePeerSession.events.some(event => event.type === 'turn/end'
    && event.data.reason.kind === 'completed'))
  const cooperativeCancelResolvedAt = cooperativeCancelResult.resolvedAt
  assert.ok(cooperativeCancelResolvedAt < cooperativeCancelled.at + 250,
    'the Worker control message must be handled before the cooperative tool reports cancellation')
  const cooperativeSessions = await waitForSettledSessions(cooperative)
  assert.equal(cooperativeSessions[0].events.findLast(event => event.type === 'turn/end')?.data.reason.kind, 'aborted')
  const cooperativeCalls = cooperativeSessions[0].events.filter(event => event.type === 'tool/call'
    && event.data.name === 'browser_cpu_cooperative_probe')
  assert.equal(cooperativeCalls.length, 1)
  assert.equal(cooperativeSessions[0].events.filter(event => event.type === 'tool/result'
    && event.data.message?.toolCallId === cooperativeCalls[0].data.callId).length, 1)
  assert.ok(cooperativePeerReleased.at < cooperativeCancelled.at)
  assert.ok(await page.evaluate(() => window.__dshAnimationFrameCount) > framesAtCooperativeStart)

  const disposed = await workerRequest({ action: 'multi-agent-dispose' })
  assert.deepEqual(disposed.multiAgent, { disposedCount: 2, remainingCount: 0 })
  assert.equal(await page.evaluate(() => window.__dshBrowserWorkers.length), 1)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'same-worker-synchronous-cpu-blocking-versus-cooperative-yield-and-cancellation',
    workerCount: await page.evaluate(() => window.__dshBrowserWorkers.length),
    blocking: {
      agentSessionId: blocking.agents[0].sessionId,
      peerSessionId: blocking.agents[1].sessionId,
      startedAt: blockingStarted.at,
      peerResponseFinishedAt: blockingPeerResponse.finishedAt,
      completedAt: blockingCompleted.at,
      cancelSentAt: blockingCancel.sentAt,
      cancelHandledAt: blockingCancelResult.resolvedAt,
      animationFramesAdvanced: framesAfterBlocking - framesAtBlockingStart,
      toolCalls: blockingSessions[0].events.filter(event => event.type === 'tool/call'
        && event.data.name === 'browser_cpu_blocking_probe').length,
      toolResults: blockingSessions[0].events.filter(event => event.type === 'tool/result'
        && event.data.message?.toolCallId === blockingCalls[0].data.callId).length,
    },
    cooperative: {
      agentSessionId: cooperative.agents[0].sessionId,
      peerSessionId: cooperative.agents[1].sessionId,
      startedAt: cooperativeStarted.at,
      peerResponseFinishedAt: cooperativePeerResponse.finishedAt,
      peerTurnEndSeq: cooperativePeerSession.events.findLast(event => event.type === 'turn/end')?.seq,
      cancelSentAt: cooperativeCancel.sentAt,
      cancelHandledAt: cooperativeCancelResolvedAt,
      cancelObservedAt: cooperativeCancelled.at,
      animationFramesAdvanced: await page.evaluate(() => window.__dshAnimationFrameCount) - framesAtCooperativeStart,
      agentTurnReason: cooperativeSessions[0].events.findLast(event => event.type === 'turn/end')?.data.reason,
    },
    workerEvents: await cpuEvents(),
    backendBarrierReleases: barrierReleaseTrace,
    closedRequests,
    pageErrors,
    workerErrors,
    workerWarnings,
    externalRequests,
  })}\n`)
} finally {
  for (const test of scenarios) {
    test.toolResponse.resolve()
    test.peerResponse.resolve()
    test.afterToolResponse.resolve()
  }
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
