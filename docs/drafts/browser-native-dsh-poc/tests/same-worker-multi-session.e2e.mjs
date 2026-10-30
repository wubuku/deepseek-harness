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
if (browserName !== 'chrome') throw new Error('Same-Worker multi-Session validation runs only in Chrome')

const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-same-worker-sessions-')))
const sessionSpecs = [
  { sessionId: `multi-worker-a-${randomUUID()}`, prompt: 'BROWSER_NATIVE_SAME_WORKER_SESSION_A_E2E' },
  { sessionId: `multi-worker-b-${randomUUID()}`, prompt: 'BROWSER_NATIVE_SAME_WORKER_SESSION_B_E2E' },
  { sessionId: `multi-worker-c-${randomUUID()}`, prompt: 'BROWSER_NATIVE_SAME_WORKER_SESSION_C_E2E' },
]
const gatedRequests = []
const closedRequests = []
const pageErrors = []
const workerErrors = []
const externalRequests = []
let releaseBarrier
let image
let app
let browser
let context
let page
let origin
let barrierEnabled = true
const barrier = new Promise(resolveBarrier => { releaseBarrier = resolveBarrier })

function modelFault(body) {
  if (!barrierEnabled || body.purpose !== undefined || typeof body.sessionId !== 'string') return undefined
  const spec = sessionSpecs.find(candidate => JSON.stringify(body.messages).includes(candidate.prompt))
  if (spec === undefined) return undefined
  gatedRequests.push({ sessionId: body.sessionId, prompt: spec.prompt, toolCount: body.tools?.length ?? 0 })
  return { kind: 'barrier-text', release: barrier, text: `${spec.prompt}_DONE` }
}

async function workerRequest(body) {
  return await page.evaluate(async request => {
    const invoke = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof invoke !== 'function') throw new Error('Browser-Native Worker test port is unavailable')
    return await invoke(request)
  }, body)
}

async function readSession(sessionId) {
  return await sessionRequest(origin, 'read', { sessionId, offset: 0 })
}

function userMessages(session) {
  return session.events.filter(event => event.type === 'user/message')
}

function assistantText(session) {
  return session.events.filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser-multi-agent' })
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
    Object.defineProperty(window, '__dshBrowserWorkers', { value: workers })
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
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url())
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-test=multi-agent&preview-fixture=none`)
  await waitForPreview(page)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function')

  const start = await workerRequest({ action: 'multi-agent-start', agents: sessionSpecs })
  if (start.ok !== true) {
    const trace = await workerRequest({ action: 'module-trace' })
    const relatedEvents = trace.moduleTrace?.events?.filter(event => {
      return String(event.target).includes('browser-native')
    })
    throw new Error(JSON.stringify({ start, relatedEvents }))
  }
  assert.equal(start.ok, true, JSON.stringify(start))
  assert.deepEqual(start.multiAgent, {
    sessionIds: sessionSpecs.map(spec => spec.sessionId),
    startedCount: sessionSpecs.length,
  })
  await waitFor(() => new Set(gatedRequests.map(request => request.sessionId)).size === sessionSpecs.length,
    'three Session requests to reach one model barrier', 30_000)
  assert.equal(new Set(gatedRequests.map(request => request.sessionId)).size, sessionSpecs.length)
  assert.ok(gatedRequests.every(request => request.toolCount > 0), 'each real DSH Loop must assemble its tool roster')

  for (const { sessionId } of sessionSpecs) await rememberSessionPrincipal(page, origin, sessionId)
  await waitFor(async () => {
    const [status, sessions] = await Promise.all([
      workerRequest({ action: 'multi-agent-status' }),
      Promise.all(sessionSpecs.map(spec => readSession(spec.sessionId))),
    ])
    const allHavePrompt = sessions.every((session, index) => userMessages(session).filter(event => {
      return JSON.stringify(event.data).includes(sessionSpecs[index].prompt)
    }).length === 1)
    return status.multiAgent?.length === sessionSpecs.length
      && status.multiAgent.every(agent => agent.status === 'running' && agent.registered)
      && allHavePrompt
      && sessions.every(session => !session.events.some(event => event.type === 'turn/end'))
      ? { status, sessions }
      : undefined
  }, 'all three live Session logs and Agent statuses', 30_000)

  const canceledSpec = sessionSpecs[1]
  const canceled = await workerRequest({ action: 'multi-agent-cancel', sessionId: canceledSpec.sessionId })
  assert.equal(canceled.ok, true, JSON.stringify(canceled))
  await waitFor(() => closedRequests.includes(canceledSpec.sessionId), 'cancelled model request to close', 20_000)
  assert.deepEqual(new Set(closedRequests), new Set([canceledSpec.sessionId]))
  const remaining = await workerRequest({ action: 'multi-agent-status' })
  const remainingBySession = new Map(remaining.multiAgent?.map(agent => [agent.sessionId, agent]))
  for (const spec of sessionSpecs.filter(candidate => candidate.sessionId !== canceledSpec.sessionId)) {
    assert.deepEqual(remainingBySession.get(spec.sessionId), { sessionId: spec.sessionId, status: 'running', registered: true })
  }
  assert.equal(remainingBySession.get(canceledSpec.sessionId)?.registered, true)

  barrierEnabled = false
  releaseBarrier()
  const settled = await waitFor(async () => {
    const [status, sessions] = await Promise.all([
      workerRequest({ action: 'multi-agent-status' }),
      Promise.all(sessionSpecs.map(spec => readSession(spec.sessionId))),
    ])
    return status.multiAgent?.every(agent => agent.status === 'idle' && agent.registered)
      && sessions.every(session => session.events.some(event => event.type === 'turn/end'))
      ? { status, sessions }
      : undefined
  }, 'all three real Agent Loops to settle', 30_000)

  for (const [index, spec] of sessionSpecs.entries()) {
    const session = settled.sessions[index]
    const matchingPrompts = userMessages(session).filter(event => JSON.stringify(event.data).includes(spec.prompt))
    assert.equal(matchingPrompts.length, 1, `Session ${spec.sessionId} must record only its own prompt once`)
    const otherPrompts = sessionSpecs.filter(candidate => candidate.sessionId !== spec.sessionId)
      .filter(candidate => userMessages(session).some(event => JSON.stringify(event.data).includes(candidate.prompt)))
    assert.deepEqual(otherPrompts, [], `Session ${spec.sessionId} must not contain another Agent prompt`)
    const terminal = session.events.filter(event => event.type === 'turn/end').at(-1)
    assert.ok(terminal, `Session ${spec.sessionId} must persist a terminal event`)
    if (spec.sessionId === canceledSpec.sessionId) {
      assert.deepEqual(terminal.data.reason, { kind: 'aborted', reason: { kind: 'user' } })
      assert.equal(assistantText(session).includes(`${spec.prompt}_DONE`), false)
    } else {
      assert.deepEqual(terminal.data.reason, { kind: 'completed' })
      assert.ok(assistantText(session).includes(`${spec.prompt}_DONE`))
    }
  }

  const disposed = await workerRequest({ action: 'multi-agent-dispose' })
  assert.deepEqual(disposed.multiAgent, { disposedCount: sessionSpecs.length, remainingCount: 0 })
  assert.deepEqual((await workerRequest({ action: 'multi-agent-status' })).multiAgent, [])
  assert.equal(await page.evaluate(() => window.__dshBrowserWorkers.length), 1)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'three-real-dsh-agents-in-one-dedicated-worker-with-isolated-cancel-and-session-logs',
    workerCount: await page.evaluate(() => window.__dshBrowserWorkers.length),
    sessionIds: sessionSpecs.map(spec => spec.sessionId),
    gatedModelRequests: gatedRequests,
    explicitPromptCounts: settled.sessions.map((session, index) => userMessages(session)
      .filter(event => JSON.stringify(event.data).includes(sessionSpecs[index].prompt)).length),
    canceledSessionId: canceledSpec.sessionId,
    closedModelRequests: closedRequests,
    turnReasons: settled.sessions.map(session => session.events.filter(event => event.type === 'turn/end').at(-1).data.reason),
    disposed,
    pageErrors,
    workerErrors,
    externalRequests,
  })}\n`)
} finally {
  barrierEnabled = false
  releaseBarrier()
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
