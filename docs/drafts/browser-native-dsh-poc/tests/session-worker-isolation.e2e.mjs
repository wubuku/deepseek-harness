import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import {
  openPreview,
  rememberSessionPrincipal,
  sessionRequest,
  waitFor,
} from './runtime-test-support.mjs'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
if (browserName !== 'chrome') throw new Error('Session Worker isolation validation runs only in Chrome')

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function makeAgent(kind, topology) {
  return {
    sessionId: `worker-isolation-${topology}-${kind}-${randomUUID()}`,
    prompt: `BROWSER_NATIVE_WORKER_ISOLATION_${topology.toUpperCase()}_${kind.toUpperCase()}`,
  }
}

const sharedAgents = [makeAgent('cpu', 'shared'), makeAgent('peer', 'shared')]
const isolatedAgents = [makeAgent('cpu', 'isolated'), makeAgent('peer', 'isolated')]
const sharedSignals = { tool: deferred(), peer: deferred(), afterTool: deferred() }
const isolatedSignals = { tool: deferred(), peer: deferred(), afterTool: deferred() }
const scenarioBySession = new Map()
const capacityBySession = new Map()
const modelRequests = []
const barrierReleases = []
const closedRequests = []
const pageErrors = []
const workerErrors = []
const externalRequests = []
const capacitySamples = []
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-session-worker-isolation-')))
let image
let app
let browser
let browserCdp
let origin

function stage(message) {
  process.stderr.write(`session Worker isolation: ${message}\n`)
}

for (const [topology, agents, signals] of [
  ['shared', sharedAgents, sharedSignals],
  ['isolated', isolatedAgents, isolatedSignals],
]) {
  for (const [index, agent] of agents.entries()) {
    scenarioBySession.set(agent.sessionId, { topology, kind: index === 0 ? 'cpu' : 'peer', agent, signals })
  }
}

function modelFault(body) {
  if (body.purpose !== undefined || typeof body.sessionId !== 'string') return undefined
  const scenario = scenarioBySession.get(body.sessionId)
  if (scenario !== undefined) {
    modelRequests.push({ topology: scenario.topology, sessionId: body.sessionId, purpose: 'agent-loop' })
    if (scenario.kind === 'peer') {
      return {
        kind: 'barrier-text',
        release: scenario.signals.peer.promise,
        onReleased: () => barrierReleases.push({ topology: scenario.topology, sessionId: body.sessionId, at: Date.now() }),
        text: `${scenario.agent.prompt}_DONE`,
      }
    }
    const promptIndex = body.messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes(scenario.agent.prompt))
    const toolResults = promptIndex < 0 ? [] : body.messages.slice(promptIndex + 1).filter(message => message.role === 'tool')
    if (toolResults.length === 0) {
      return {
        kind: 'barrier-tool-call',
        release: scenario.signals.tool.promise,
        onReleased: () => barrierReleases.push({ topology: scenario.topology, sessionId: body.sessionId, at: Date.now() }),
        call: {
          id: `worker-isolation-${scenario.topology}-${scenario.agent.sessionId}`,
          name: 'browser_cpu_blocking_probe',
          arguments: { durationMs: 1_900 },
        },
      }
    }
    return {
      kind: 'barrier-text',
      release: scenario.signals.afterTool.promise,
      text: `${scenario.agent.prompt}_AFTER_TOOL`,
    }
  }
  const capacity = capacityBySession.get(body.sessionId)
  if (capacity !== undefined) {
    modelRequests.push({ topology: `capacity-${String(capacity.level)}`, sessionId: body.sessionId, purpose: 'agent-loop' })
    return { kind: 'text', text: `${capacity.prompt}_DONE` }
  }
  return undefined
}

async function chromeProcessMetrics() {
  const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo')
  const processIds = processInfo.map(info => info.id)
  const { stdout } = await execFileAsync('ps', ['-o', 'pid=,rss=', '-p', processIds.join(',')])
  const rssByPid = new Map(stdout.trim().split('\n').filter(Boolean).map(line => {
    const [pid, rss] = line.trim().split(/\s+/).map(Number)
    return [pid, rss]
  }))
  return processInfo.map(info => ({
    type: info.type,
    pid: info.id,
    cpuTimeSeconds: info.cpuTime,
    rssKiB: rssByPid.get(info.id) ?? null,
  })).sort((left, right) => left.pid - right.pid)
}

function processSummary(before, after) {
  const previous = new Map(before.map(processInfo => [processInfo.pid, processInfo]))
  const current = new Map(after.map(processInfo => [processInfo.pid, processInfo]))
  const byPid = [...new Set([...previous.keys(), ...current.keys()])].map(pid => {
    const initial = previous.get(pid)
    const final = current.get(pid)
    return {
      pid,
      type: final?.type ?? initial?.type,
      cpuTimeDeltaSeconds: initial === undefined || final === undefined ? null : final.cpuTimeSeconds - initial.cpuTimeSeconds,
      rssKiB: final?.rssKiB ?? null,
    }
  })
  return {
    processCount: after.length,
    rendererProcessCount: after.filter(processInfo => processInfo.type === 'renderer').length,
    rssTotalKiB: after.reduce((total, processInfo) => total + (processInfo.rssKiB ?? 0), 0),
    cpuTimeDeltaSeconds: byPid.reduce((total, processInfo) => total + (processInfo.cpuTimeDeltaSeconds ?? 0), 0),
    processes: byPid,
  }
}

async function makePage(context) {
  const page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url())
  })
  return page
}

async function openCpuHost(context) {
  const page = await makePage(context)
  const opened = await openPreview(page,
    `${origin}/preview.html?browser-native=1&browser-native-test=cpu-contention&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function')
  return { page, startupMs: opened.elapsedMs }
}

async function startAgents(page, agents) {
  const result = await page.evaluate(async specs => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'multi-agent-start',
    agents: specs,
  }), agents)
  assert.equal(result?.ok, true, JSON.stringify(result))
  for (const agent of agents) await rememberSessionPrincipal(page, origin, agent.sessionId)
}

async function workerRequest(page, body) {
  return await page.evaluate(async request => {
    const invoke = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof invoke !== 'function') throw new Error('Browser-Native Worker test port is unavailable')
    return await invoke(request)
  }, body)
}

async function readSession(sessionId) {
  return await sessionRequest(origin, 'read', { sessionId, offset: 0 })
}

function containsPrompt(session, prompt) {
  return session.events.some(event => event.type === 'user/message' && JSON.stringify(event.data).includes(prompt))
}

function assistantText(session) {
  return session.events.filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function terminalEvents(session) {
  return session.events.filter(event => event.type === 'turn/end')
}

async function workerEvents(page) {
  return await page.evaluate(() => window.__dshCpuContentionEvents ?? [])
}

async function waitForCpuStarted(page, topology) {
  return await waitFor(async () => (await workerEvents(page)).find(event => event.mode === 'blocking' && event.stage === 'started'),
    `${topology} CPU probe start event`, 30_000)
}

async function readSessions(agents) {
  return await Promise.all(agents.map(agent => readSession(agent.sessionId)))
}

async function runCapacitySample(level, repetition) {
  stage(`capacity sample ${String(level)} Host(s), repetition ${String(repetition)}: opening`)
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
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
  const beforeProcesses = await chromeProcessMetrics()
  const nodeCpuStart = process.cpuUsage()
  const nodeMemoryStart = process.memoryUsage()
  const startedAt = Date.now()
  const hosts = await Promise.all(Array.from({ length: level }, async () => await openCpuHost(context)))
  stage(`capacity sample ${String(level)} Host(s), repetition ${String(repetition)}: starting Agent turns`)
  const agents = hosts.map((_, index) => {
    const prompt = `BROWSER_NATIVE_WORKER_CAPACITY_L${String(level)}_R${String(repetition)}_S${String(index + 1)}`
    const agent = { sessionId: `worker-capacity-${level}-${repetition}-${index}-${randomUUID()}`, prompt }
    capacityBySession.set(agent.sessionId, { level, prompt })
    return agent
  })
  for (const [index, host] of hosts.entries()) await startAgents(host.page, [agents[index]])
  const turnStartedAt = Date.now()
  const sessions = await waitFor(async () => {
    const current = await readSessions(agents)
    return current.every(session => terminalEvents(session).length === 1) ? current : undefined
  }, `all ${String(level)} one-Agent Worker turns to settle`, 60_000)
  stage(`capacity sample ${String(level)} Host(s), repetition ${String(repetition)}: turns settled`)
  const turnElapsedMs = Date.now() - turnStartedAt
  const afterProcesses = await chromeProcessMetrics()
  const nodeCpu = process.cpuUsage(nodeCpuStart)
  const nodeMemoryEnd = process.memoryUsage()
  const pageMetrics = await Promise.all(hosts.map(async (host, index) => ({
    sessionId: agents[index].sessionId,
    startupMs: host.startupMs,
    workerCount: await host.page.evaluate(() => window.__dshBrowserWorkers?.length ?? 0),
    heapUsedBytes: await host.page.evaluate(() => performance.memory?.usedJSHeapSize ?? null),
    eventCount: sessions[index].events.length,
    promptCount: sessions[index].events.filter(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes(agents[index].prompt)).length,
    terminalReason: terminalEvents(sessions[index]).at(-1)?.data.reason.kind,
    agentLoopRequests: modelRequests.filter(request => request.sessionId === agents[index].sessionId).length,
  })))
  const sample = {
    level,
    repetition,
    browserVersion: browser.version(),
    durationMs: Date.now() - startedAt,
    turnElapsedMs,
    workers: pageMetrics,
    chromeProcesses: processSummary(beforeProcesses, afterProcesses),
    nodeHarnessAndBackend: {
      cpuUserMicros: nodeCpu.user,
      cpuSystemMicros: nodeCpu.system,
      rssBeforeBytes: nodeMemoryStart.rss,
      rssAfterBytes: nodeMemoryEnd.rss,
      note: 'The backend and E2E harness share this Node process; these values are not isolated backend metrics.',
    },
  }
  assert.deepEqual(pageMetrics.map(metric => metric.workerCount), Array(level).fill(1))
  assert.deepEqual(pageMetrics.map(metric => metric.promptCount), Array(level).fill(1))
  assert.deepEqual(pageMetrics.map(metric => metric.terminalReason), Array(level).fill('completed'))
  assert.deepEqual(pageMetrics.map(metric => metric.agentLoopRequests), Array(level).fill(1))
  for (const agent of agents) capacityBySession.delete(agent.sessionId)
  stage(`capacity sample ${String(level)} Host(s), repetition ${String(repetition)}: closing context`)
  await context.close()
  stage(`capacity sample ${String(level)} Host(s), repetition ${String(repetition)}: complete`)
  return sample
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
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-precise-memory-info'] })
  browserCdp = await browser.newBrowserCDPSession()

  stage('shared topology: opening Host')
  const sharedContext = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  await sharedContext.addInitScript(() => {
    const workers = []
    window.__dshCpuContentionEvents = []
    window.__DSH_BROWSER_NATIVE_CPU_CONTENTION_EVENT__ = event => window.__dshCpuContentionEvents.push(event)
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
  const sharedHost = await openCpuHost(sharedContext)
  stage('shared topology: starting two Agents')
  await startAgents(sharedHost.page, sharedAgents)
  stage('shared topology: waiting for model barriers')
  const sharedGates = await waitFor(() => modelRequests.filter(request => sharedAgents.some(agent => agent.sessionId === request.sessionId)).length === 2,
    'both shared-Worker model requests', 30_000)
  assert.equal(sharedGates, true)
  stage('shared topology: releasing CPU tool and terminating Host')
  const sharedToolResponse = await workerRequest(sharedHost.page, { action: 'multi-agent-status' })
  assert.equal(sharedToolResponse.multiAgent?.length, 2)
  sharedSignals.tool.resolve()
  const sharedCpuStarted = await waitForCpuStarted(sharedHost.page, 'shared')
  sharedSignals.peer.resolve()
  const sharedPeerReleased = await waitFor(() => barrierReleases.find(event => event.topology === 'shared'
    && event.sessionId === sharedAgents[1].sessionId), 'shared peer response release')
  assert.ok(sharedPeerReleased.at < sharedCpuStarted.at + 1_900)
  const sharedBeforeTermination = await readSessions(sharedAgents)
  assert.equal(terminalEvents(sharedBeforeTermination[1]).length, 0)
  assert.equal(containsPrompt(sharedBeforeTermination[0], sharedAgents[0].prompt), true)
  assert.equal(containsPrompt(sharedBeforeTermination[1], sharedAgents[1].prompt), true)
  await sharedHost.page.evaluate(() => window.__dshBrowserWorkers[0].terminate())
  const sharedAfterTermination = await readSessions(sharedAgents)
  const sharedToolCalls = sharedAfterTermination[0].events.filter(event => event.type === 'tool/call'
    && event.data.name === 'browser_cpu_blocking_probe')
  assert.equal(sharedToolCalls.length, 1)
  assert.equal(sharedAfterTermination[0].events.filter(event => event.type === 'tool/result'
    && (event.data.message?.toolCallId ?? event.data.toolCallId) === sharedToolCalls[0].data.callId).length, 0)
  assert.deepEqual(sharedAfterTermination.map(session => terminalEvents(session).length), [0, 0])
  assert.deepEqual(sharedAfterTermination.map((session, index) => session.events.filter(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(sharedAgents[index].prompt)).length), [1, 1])
  stage('shared topology: closing context')
  await sharedContext.close()

  stage('isolated topology: opening two Hosts')
  const isolatedContext = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  await isolatedContext.addInitScript(() => {
    const workers = []
    window.__dshCpuContentionEvents = []
    window.__DSH_BROWSER_NATIVE_CPU_CONTENTION_EVENT__ = event => window.__dshCpuContentionEvents.push(event)
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
  const isolatedHosts = await Promise.all([openCpuHost(isolatedContext), openCpuHost(isolatedContext)])
  stage('isolated topology: starting one Agent per Host')
  await Promise.all(isolatedHosts.map((host, index) => startAgents(host.page, [isolatedAgents[index]])))
  await waitFor(() => modelRequests.filter(request => isolatedAgents.some(agent => agent.sessionId === request.sessionId)).length === 2,
    'both isolated-Worker model requests', 30_000)
  stage('isolated topology: releasing peer while CPU tool runs')
  isolatedSignals.tool.resolve()
  const isolatedCpuStarted = await waitForCpuStarted(isolatedHosts[0].page, 'isolated')
  isolatedSignals.peer.resolve()
  const isolatedPeerSession = await waitFor(async () => {
    const session = await readSession(isolatedAgents[1].sessionId)
    return terminalEvents(session).length === 1 ? session : undefined
  }, 'peer Session in its own Worker to finish while sibling CPU tool runs', 30_000)
  assert.ok(Date.now() < isolatedCpuStarted.at + 1_900)
  assert.equal((await workerEvents(isolatedHosts[0].page)).some(event => event.mode === 'blocking' && event.stage === 'completed'), false)
  assert.equal(assistantText(isolatedPeerSession).includes(`${isolatedAgents[1].prompt}_DONE`), true)
  await isolatedHosts[0].page.evaluate(() => window.__dshBrowserWorkers[0].terminate())
  const isolatedAfterTermination = await readSessions(isolatedAgents)
  const isolatedToolCalls = isolatedAfterTermination[0].events.filter(event => event.type === 'tool/call'
    && event.data.name === 'browser_cpu_blocking_probe')
  assert.equal(isolatedToolCalls.length, 1)
  assert.equal(isolatedAfterTermination[0].events.filter(event => event.type === 'tool/result'
    && (event.data.message?.toolCallId ?? event.data.toolCallId) === isolatedToolCalls[0].data.callId).length, 0)
  assert.deepEqual(terminalEvents(isolatedAfterTermination[0]), [])
  assert.equal(containsPrompt(isolatedAfterTermination[0], isolatedAgents[0].prompt), true)
  assert.equal(isolatedAfterTermination[0].events.filter(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(isolatedAgents[0].prompt)).length, 1)
  assert.equal(terminalEvents(isolatedAfterTermination[1]).length, 1)
  assert.equal(containsPrompt(isolatedAfterTermination[1], isolatedAgents[1].prompt), true)
  assert.equal(isolatedAfterTermination[1].events.filter(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(isolatedAgents[1].prompt)).length, 1)
  assert.equal(modelRequests.filter(request => request.sessionId === isolatedAgents[0].sessionId).length, 1)
  assert.equal(modelRequests.filter(request => request.sessionId === isolatedAgents[1].sessionId).length, 1)
  assert.equal(await isolatedHosts[0].page.evaluate(() => window.__dshBrowserWorkers.length), 1)
  assert.equal(await isolatedHosts[1].page.evaluate(() => window.__dshBrowserWorkers.length), 1)
  stage('isolated topology: closing context')
  await isolatedHosts[1].page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'multi-agent-dispose',
  }))
  await isolatedContext.close()

  for (let repetition = 1; repetition <= 3; repetition += 1) {
    for (const level of [1, 2, 4]) capacitySamples.push(await runCapacitySample(level, repetition))
  }

  stage('all scenarios complete: validating totals and writing result')
  const llmRequests = modelRequests.filter(request => request.purpose === 'agent-loop')
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])
  const result = {
    result: 'passed',
    browser: browser.version(),
    scope: 'shared-Worker versus one-Session-per-Worker blocking and termination isolation',
    sharedWorker: {
      workerCount: 1,
      sessions: sharedAgents.map((agent, index) => ({
        sessionId: agent.sessionId,
        promptCount: sharedAfterTermination[index].events.filter(event => event.type === 'user/message'
          && JSON.stringify(event.data).includes(agent.prompt)).length,
        turnEndCount: terminalEvents(sharedAfterTermination[index]).length,
        toolCallCount: sharedAfterTermination[index].events.filter(event => event.type === 'tool/call').length,
      })),
      peerResponseReleasedAt: sharedPeerReleased.at,
      cpuStartedAt: sharedCpuStarted.at,
      consequence: 'terminating the shared Host Worker left both Session turns without terminal events',
    },
    isolatedWorkers: {
      browserContextCount: 1,
      pageCount: 2,
      workerCount: 2,
      cpuSessionId: isolatedAgents[0].sessionId,
      cpuStartedAt: isolatedCpuStarted.at,
      peerSessionId: isolatedAgents[1].sessionId,
      peerTurnEndSeq: terminalEvents(isolatedAfterTermination[1])[0].seq,
      sessions: isolatedAgents.map((agent, index) => ({
        sessionId: agent.sessionId,
        promptCount: isolatedAfterTermination[index].events.filter(event => event.type === 'user/message'
          && JSON.stringify(event.data).includes(agent.prompt)).length,
        turnEndCount: terminalEvents(isolatedAfterTermination[index]).length,
        toolCallCount: isolatedAfterTermination[index].events.filter(event => event.type === 'tool/call').length,
      })),
      consequence: 'terminating the CPU Host Worker left only its own Session incomplete; peer Host completed independently',
    },
    topologyResourceSamples: capacitySamples,
    totalAgentLoopRequests: llmRequests.length,
    totalCapacityTurns: capacitySamples.reduce((total, sample) => total + sample.level, 0),
    totalCapacityRuns: capacitySamples.length,
    backendTopology: 'One in-process PoC backend serves all pages; each page realm owns one DSH Host Dedicated Worker.',
    limitations: [
      'The independent topology uses one same-origin page realm per Worker; the current app does not implement a single-page Worker supervisor or pool.',
      'The CPU probe has no Workspace or external side effect; termination evidence does not prove arbitrary tool side effects are reversible.',
      'A terminated Session retains an incomplete durable prefix; this test does not resume or synthesize a terminal event for that turn.',
      'Chrome RSS combines page, Worker, browser and unrelated process costs; it is not per-Worker heap or a production capacity limit.',
      'Scripted model responses validate Worker and Session scheduling, not real model concurrency or upstream latency.',
    ],
    pageErrors,
    workerErrors,
    externalRequests,
  }
  if (process.env.DSH_POC_RESULT_FILE !== undefined) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(resolve(process.env.DSH_POC_RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  for (const signals of [sharedSignals, isolatedSignals]) {
    signals.tool.resolve()
    signals.peer.resolve()
    signals.afterTool.resolve()
  }
  await browserCdp?.detach().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
