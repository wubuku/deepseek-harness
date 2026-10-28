import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, waitFor } from './runtime-test-support.mjs'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-worker-placement-`))
const requestedConcurrencyLevels = process.env.DSH_POC_CAPACITY_LEVELS?.split(',').map(Number)
const concurrencyLevels = requestedConcurrencyLevels ?? [1, 4, 8]
if (concurrencyLevels.length === 0 || concurrencyLevels.some(value => ![1, 4, 8].includes(value))) {
  throw new Error('DSH_POC_CAPACITY_LEVELS must be a comma-separated subset of 1,4,8')
}
const dataPath = '/dsh/home/workspace/worker-placement-'
const allRequests = []
const pageErrors = []
const externalRequests = []
const samples = []
const pendingResponseBodies = new Map()
const responseBodiesUnavailable = []
let image
let app
let browser
let browserCdp

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

function summarizeChromeProcesses(before, after) {
  const previous = new Map(before.map(processInfo => [processInfo.pid, processInfo]))
  const current = new Map(after.map(processInfo => [processInfo.pid, processInfo]))
  const allPids = new Set([...previous.keys(), ...current.keys()])
  const byPid = [...allPids].map(pid => {
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

function requestRecord(request, origin, counters, pageRequests) {
  const url = new URL(request.url())
  if (url.origin !== origin) externalRequests.push(url.origin)
  let body
  let bodyBytes = 0
  try {
    body = request.postDataJSON()
    bodyBytes = request.postDataBuffer()?.byteLength ?? 0
  } catch {
    bodyBytes = request.postDataBuffer()?.byteLength ?? 0
  }
  counters.requestCount += 1
  counters.requestBytes += bodyBytes
  if (url.pathname === '/api/browser-native/llm') {
    counters.llmRequestCount += 1
    const purpose = body?.purpose ?? 'agent-loop'
    counters.llmRequestPurposes[purpose] = (counters.llmRequestPurposes[purpose] ?? 0) + 1
  }
  if (url.pathname === '/api/browser-native/workspace/commit') counters.workspaceCommitCount += 1
  const record = {
    path: url.pathname,
    body,
    startedAt: Date.now(),
    status: undefined,
    finishedAt: undefined,
    counters,
    request,
  }
  allRequests.push(record)
  pageRequests.push(record)
  return record
}

function capturePage(page, origin, counters, pageRequests) {
  const byRequest = new WeakMap()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => { byRequest.set(request, requestRecord(request, origin, counters, pageRequests)) })
  page.on('response', response => {
    const record = byRequest.get(response.request())
    if (record === undefined) return
    record.status = response.status()
    record.finishedAt = Date.now()
    if (response.status() >= 400) {
      responseBodiesUnavailable.push({ path: new URL(response.url()).pathname, status: response.status() })
      return
    }
    const bodyTask = response.body().then(body => { counters.responseBytes += body.byteLength }).catch(() => {})
      .finally(() => { pendingResponseBodies.delete(bodyTask) })
    pendingResponseBodies.set(bodyTask, `${new URL(response.url()).pathname} (${response.status()})`)
  })
}

async function waitForStage(label, operation, timeoutMs = 20_000) {
  process.stderr.write(`browser Worker placement: ${label}\n`)
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`browser Worker placement timed out: ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function beginPageMetrics(page) {
  return await page.evaluate(() => {
    const state = { active: true, previous: performance.now(), frame: 0, intervals: [], longTasks: [] }
    const observer = PerformanceObserver.supportedEntryTypes.includes('longtask')
      ? new PerformanceObserver(list => {
        for (const entry of list.getEntries()) state.longTasks.push(entry.duration)
      })
      : undefined
    observer?.observe({ type: 'longtask', buffered: true })
    const tick = now => {
      if (!state.active) return
      state.intervals.push(now - state.previous)
      state.previous = now
      state.frame = requestAnimationFrame(tick)
    }
    state.frame = requestAnimationFrame(tick)
    window.__dshWorkerPlacementMetrics = { state, observer }
    return true
  })
}

async function endPageMetrics(page) {
  return await page.evaluate(() => {
    const capture = window.__dshWorkerPlacementMetrics
    if (capture === undefined) throw new Error('Worker placement metrics were not started')
    capture.state.active = false
    cancelAnimationFrame(capture.state.frame)
    capture.observer?.disconnect()
    const intervals = [...capture.state.intervals].sort((left, right) => left - right)
    const memory = performance.memory
    return {
      workerCount: window.__dshBrowserWorkers?.length ?? 0,
      frameCount: intervals.length,
      p95FrameMs: intervals[Math.floor((intervals.length - 1) * 0.95)] ?? 0,
      maxFrameMs: intervals.at(-1) ?? 0,
      longTaskCount: capture.state.longTasks.length,
      longTaskTotalMs: capture.state.longTasks.reduce((total, duration) => total + duration, 0),
      pageHeapUsedBytes: typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null,
      pageHeapLimitBytes: typeof memory?.jsHeapSizeLimit === 'number' ? memory.jsHeapSizeLimit : null,
    }
  })
}

async function beginPagePerformanceMetrics(context, page) {
  const session = await context.newCDPSession(page)
  await session.send('Performance.enable')
  const metrics = await session.send('Performance.getMetrics')
  return { session, metrics: new Map(metrics.metrics.map(metric => [metric.name, metric.value])) }
}

async function readPagePerformanceMetrics(session) {
  const result = await session.send('Performance.getMetrics')
  return new Map(result.metrics.map(metric => [metric.name, metric.value]))
}

function metricDelta(before, after, name) {
  const initial = before.get(name)
  const final = after.get(name)
  return initial === undefined || final === undefined ? null : final - initial
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({
    headless: true,
    channel: process.env.DSH_POC_BROWSER ?? 'chrome',
    args: ['--enable-precise-memory-info'],
  })
  browserCdp = await browser.newBrowserCDPSession()

  for (const concurrency of concurrencyLevels) {
    process.stderr.write(`browser Worker placement: opening ${String(concurrency)} isolated contexts\n`)
    const chromeBefore = await chromeProcessMetrics()
    const contexts = await Promise.all(Array.from({ length: concurrency }, async () => await browser.newContext({
      locale: 'en-US',
      timezoneId: 'Asia/Shanghai',
    })))
    await Promise.all(contexts.map(context => context.addInitScript(() => {
      const workers = []
      Object.defineProperty(window, '__dshBrowserWorkers', { value: workers })
      const nativeWorker = window.Worker
      window.Worker = new Proxy(nativeWorker, {
        construct(target, args) {
          const worker = Reflect.construct(target, args, target)
          workers.push(worker)
          return worker
        },
      })
    })))
    const workers = contexts.map((context, index) => ({
      context,
      page: undefined,
      counters: {
        requestCount: 0,
        requestBytes: 0,
        responseBytes: 0,
        llmRequestCount: 0,
        llmRequestPurposes: {},
        workspaceCommitCount: 0,
      },
      requests: [],
      contextIndex: index + 1,
    }))

    try {
      await Promise.all(workers.map(async worker => {
        worker.page = await worker.context.newPage()
        capturePage(worker.page, origin, worker.counters, worker.requests)
        const opened = await openPreview(worker.page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
        try {
          await worker.page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
        } catch (error) {
          const diagnostic = await worker.page.evaluate(() => ({
            status: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__,
            testPortType: typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__,
          })).catch(() => undefined)
          throw new Error(`context ${String(worker.contextIndex)} did not expose the Worker test port: ${JSON.stringify(diagnostic)}`, { cause: error })
        }
        await worker.page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
        worker.startupMs = opened.elapsedMs
      }))

      const pagePerformance = await Promise.all(workers.map(worker => beginPagePerformanceMetrics(worker.context, worker.page)))
      await Promise.all(workers.map(worker => beginPageMetrics(worker.page)))
      process.stderr.write(`browser Worker placement: running ${String(concurrency)} DSH turns\n`)
      const nodeCpuStart = process.cpuUsage()
      const nodeMemoryAtWorkloadStart = process.memoryUsage()
      const chromeWorkloadStart = await chromeProcessMetrics()
      const turns = await Promise.all(workers.map(worker => {
        const suffix = `CTX_${String(worker.contextIndex).padStart(2, '0')}`
        worker.marker = `BROWSER_NATIVE_WORKER_PLACEMENT_${suffix}`
        worker.path = `${dataPath}${suffix.toLowerCase()}.txt`
        return sendTurn({
          page: worker.page,
          origin,
          requests: worker.requests,
          prompt: `Execute the deterministic Worker placement write/read probe ${worker.marker}.`,
          marker: `${worker.marker}_DONE`,
          timeout: 90_000,
        })
      }))
      process.stderr.write(`browser Worker placement: validating ${String(concurrency)} DSH turns\n`)

      await Promise.all(workers.map(async (worker, index) => {
        const turn = turns[index]
        const toolCalls = turn.session.events.filter(event => event.type === 'tool/call' && event.data.turn === turn.turn)
        const toolCallIds = new Set(toolCalls.map(call => call.data.callId))
        const toolResults = turn.session.events.filter(event => event.type === 'tool/result'
          && toolCallIds.has(event.data.message?.toolCallId ?? event.data.toolCallId ?? event.data.callId))
        assert.deepEqual(toolCalls.map(call => call.data.name), ['write', 'read'])
        assert.equal(toolResults.length, 2)
        assert.equal(assistantText(turn.session, turn.turn).includes(`${worker.marker}_DONE`), true)
        await waitForStage(`context ${String(worker.contextIndex)} Workspace sync`, worker.page.waitForFunction(
          () => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
            && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0,
          undefined,
          { timeout: 60_000 },
        ), 65_000)
        const read = await waitForStage(`context ${String(worker.contextIndex)} Worker VFS read`, worker.page.evaluate(
          path => window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'read', path }), worker.path,
        ))
        assert.deepEqual({ ok: read?.ok, content: read?.content }, { ok: true, content: `placement=${worker.marker.slice('BROWSER_NATIVE_WORKER_PLACEMENT_'.length).toLowerCase()}\n` })
        worker.sessionEventCount = turn.session.events.length
        worker.toolCallCount = toolCalls.length
        worker.turnEndCount = turn.session.events.filter(event => event.type === 'turn/end' && event.data.turn === turn.turn).length
        worker.llmRequestCount = worker.counters.llmRequestCount ?? 0
        worker.llmRequestPurposes = worker.counters.llmRequestPurposes
        worker.workspaceCommitCount = worker.counters.workspaceCommitCount ?? 0
      }))

      await waitForStage(
        `draining ${String(pendingResponseBodies.size)} HTTP response bodies: ${[...pendingResponseBodies.values()].join(', ')}`,
        Promise.all([...pendingResponseBodies.keys()]),
      )
      const pageMetrics = await Promise.all(workers.map(async (worker, index) => {
        const browserMetrics = await waitForStage(`context ${String(worker.contextIndex)} page metrics`, endPageMetrics(worker.page))
        const cdpMetrics = await waitForStage(
          `context ${String(worker.contextIndex)} CDP metrics`,
          readPagePerformanceMetrics(pagePerformance[index].session),
        )
        const sample = {
          context: worker.contextIndex,
          startupMs: worker.startupMs,
          workerCount: browserMetrics.workerCount,
          pageTaskDurationSeconds: metricDelta(pagePerformance[index].metrics, cdpMetrics, 'TaskDuration'),
          pageScriptDurationSeconds: metricDelta(pagePerformance[index].metrics, cdpMetrics, 'ScriptDuration'),
          pageHeapUsedBytes: browserMetrics.pageHeapUsedBytes,
          frameCount: browserMetrics.frameCount,
          p95FrameMs: browserMetrics.p95FrameMs,
          maxFrameMs: browserMetrics.maxFrameMs,
          longTaskCount: browserMetrics.longTaskCount,
          longTaskTotalMs: browserMetrics.longTaskTotalMs,
          requestCount: worker.counters.requestCount,
          requestBytes: worker.counters.requestBytes,
          responseBytes: worker.counters.responseBytes,
          llmRequestCount: worker.llmRequestCount,
          llmRequestPurposes: worker.llmRequestPurposes,
          workspaceCommitCount: worker.workspaceCommitCount,
          sessionEventCount: worker.sessionEventCount,
          toolCallCount: worker.toolCallCount,
          turnEndCount: worker.turnEndCount,
        }
        await pagePerformance[index].session.detach()
        return sample
      }))
      const chromeAfter = await chromeProcessMetrics()
      const nodeCpuAfter = process.cpuUsage(nodeCpuStart)
      const nodeMemoryAfter = process.memoryUsage()
      const backendAndHarnessProcess = {
        backendPid: process.pid,
        nodeProcessCpuUserMicros: nodeCpuAfter.user,
        nodeProcessCpuSystemMicros: nodeCpuAfter.system,
        nodeProcessRssBeforeBytes: nodeMemoryAtWorkloadStart.rss,
        nodeProcessRssAfterBytes: nodeMemoryAfter.rss,
        note: 'The backend and E2E harness share this Node process; these values are not isolated backend CPU/RSS or a deployed backend process count.',
      }
      samples.push({
        concurrency,
        browserVersion: browser.version(),
        platform: process.platform,
        backendWorkspacePrincipals: app.workspaces.identities.size,
        backendSessions: app.store.sessions.size,
        backendAndHarnessProcess,
        browserProcesses: summarizeChromeProcesses(chromeBefore, chromeAfter),
        browserProcessesDuringTurns: summarizeChromeProcesses(chromeWorkloadStart, chromeAfter),
        pageMetrics,
      })
      process.stderr.write(`browser Worker placement: completed ${String(concurrency)} contexts\n`)
    } finally {
      await Promise.all(contexts.map(context => context.close()))
    }
  }

  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])
  const llmFailures = allRequests.filter(request => request.path === '/api/browser-native/llm'
    && request.status !== 200)
  assert.deepEqual(llmFailures.map(request => request.status), [])
  const llmRequests = allRequests.filter(request => request.path === '/api/browser-native/llm')
  const totalTurns = concurrencyLevels.reduce((total, concurrency) => total + concurrency, 0)
  assert.equal(llmRequests.length, totalTurns * 4)
  assert.equal(llmRequests.filter(request => request.body?.purpose === 'session-title').length, totalTurns)
  assert.equal(llmRequests.filter(request => request.body?.purpose === undefined).length, totalTurns * 3)
  const commitRequests = allRequests.filter(request => request.path.endsWith('/workspace/commit'))
  assert.equal(commitRequests.every(request => request.status === 200), true)
  const commitOperationIds = commitRequests.map(request => request.body?.operationId).filter(id => typeof id === 'string')
  assert.equal(new Set(commitOperationIds).size, commitOperationIds.length)
  assert.equal(app.workspaces.identities.size, totalTurns)
  assert.equal(app.store.sessions.size, totalTurns)
  assert.equal(samples.every(sample => sample.pageMetrics.every(page => page.workerCount === 1)), true)
  assert.equal(samples.every(sample => sample.pageMetrics.every(page => page.llmRequestCount === 4)), true)
  assert.equal(samples.every(sample => sample.pageMetrics.every(page => page.llmRequestPurposes['agent-loop'] === 3
    && page.llmRequestPurposes['session-title'] === 1)), true)
  assert.equal(samples.every(sample => sample.pageMetrics.every(page => page.workspaceCommitCount === 1)), true)
  assert.equal(samples.every(sample => sample.pageMetrics.every(page => page.toolCallCount === 2
    && page.turnEndCount === 1)), true)

  const result = {
    result: 'passed',
    browser: browser.version(),
    workload: 'one real DSH Agent Loop turn per isolated context; scripted backend issues write then read and a terminal response',
    concurrencyLevels,
    totalTurns,
    totalToolCalls: samples.reduce((total, sample) => total + sample.pageMetrics.reduce((sum, page) => sum + page.toolCallCount, 0), 0),
    totalWorkspaceCommitRequests: commitRequests.length,
    uniqueWorkspaceOperationIds: new Set(commitOperationIds).size,
    totalLlmRequests: llmRequests.length,
    backendPid: process.pid,
    backendTopology: 'One in-process PoC backend serves all Chrome contexts; the DSH Host and Agent Loop run in each page Dedicated Worker.',
    samples,
    pageErrors,
    externalRequests,
    responseBodiesUnavailable,
    limitations: [
      'The scripted provider fixes tool selection and does not measure model reasoning quality or upstream model latency.',
      'Each Chrome context has a separate identity and Workspace; the run measures same-backend independent Workers, not same-Workspace contention.',
      'Node process CPU/RSS includes the test harness because the PoC backend is in-process; Chrome process CPU/RSS is measured separately through CDP and ps.',
      'Response byte totals omit HTTP error bodies; those paths and statuses are listed separately because some preview 404 responses remain open.',
      'The browser run is a single-machine capacity diagnostic, not a production SLA or maximum-concurrency result.',
    ],
  }
  if (process.env.DSH_POC_RESULT_FILE !== undefined) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(resolve(process.env.DSH_POC_RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  await browserCdp?.detach().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
