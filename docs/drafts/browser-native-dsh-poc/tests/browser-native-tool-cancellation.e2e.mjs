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
const scenarioName = process.env.DSH_POC_TOOL_CANCELLATION_SCENARIO ?? 'stop-grep'
const scenarios = {
  'stop-grep': {
    action: 'stop',
    stage: 'grep-match',
    promptMarker: 'BROWSER_NATIVE_TOOL_STOP_GREP_E2E',
    continueMarker: 'BROWSER_NATIVE_STOP_GREP_CONTINUE_E2E',
    target: 'BROWSER_NATIVE_STOP_GREP_TARGET',
    path: '/dsh/home/workspace/stop-grep.txt',
    tool: 'grep',
  },
  'stop-edit': {
    action: 'stop',
    stage: 'copy-prefix',
    promptMarker: 'BROWSER_NATIVE_TOOL_STOP_EDIT_E2E',
    continueMarker: 'BROWSER_NATIVE_STOP_EDIT_CONTINUE_E2E',
    target: 'BROWSER_NATIVE_STOP_EDIT_TARGET',
    path: '/dsh/home/workspace/stop-edit.txt',
    tool: 'edit',
  },
  'crash-edit': {
    action: 'terminate',
    stage: 'copy-prefix',
    promptMarker: 'BROWSER_NATIVE_EDIT_STAGE_CRASH_E2E',
    continueMarker: 'BROWSER_NATIVE_CRASH_EDIT_CONTINUE_E2E',
    target: 'BROWSER_NATIVE_CRASH_EDIT_TARGET',
    path: '/dsh/home/workspace/crash-edit.txt',
    tool: 'edit',
  },
}
const scenario = scenarios[scenarioName]
if (scenario === undefined) throw new Error(`Unknown DSH_POC_TOOL_CANCELLATION_SCENARIO: ${scenarioName}`)

const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-tool-cancel-')))
const requests = []
const commits = []
const sessionFlushes = []
const pageErrors = []
const workerErrors = []
const externalRequests = []
let image
let app
let browser
let context
let page
let origin
let sessionId
let workspaceId

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

async function readSession() {
  return await sessionRequest(origin, 'read', { sessionId, offset: 0 })
}

function toolCallFor(session, toolName) {
  return session.events.findLast(event => event.type === 'tool/call'
    && event.data.name === toolName && event.data.turn > 0)
}

function resultFor(session, callId) {
  return session.events.find(event => event.type === 'tool/result'
    && event.data.message?.toolCallId === callId)
}

function conversationModelRequestCount() {
  return requests.filter(request => request.path.endsWith('/llm') && request.body?.purpose === undefined).length
}

async function listEditTemporaryDirectories() {
  return await page.evaluate(async id => {
    const root = await navigator.storage.getDirectory()
    const prefix = `dsh-browser-native-edit-${id}-`
    const names = []
    for await (const [name, handle] of root.entries()) {
      if (handle.kind === 'directory' && name.startsWith(prefix)) names.push(name)
    }
    return names.sort()
  }, workspaceId)
}

async function readDigest(path) {
  const result = await testAction({ action: 'read-digest', path })
  return { ok: result?.ok, path: result?.path, bytes: result?.bytes, digest: result?.digest }
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
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
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== new URL(origin).origin) externalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({ path: url.pathname, body })
    if (url.pathname.endsWith('/workspace/commit')) commits.push(body)
  })
  await page.route(`${origin}/api/browser-native/session/flush`, async route => {
    const response = await route.fetch()
    const body = await response.text()
    if (response.ok()) sessionFlushes.push(JSON.parse(body))
    await route.fulfill({ status: response.status(), headers: response.headers(), body })
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 45_000 })
  workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')

  const seeded = await testAction({
    action: 'write-pattern',
    path: scenario.path,
    byteLength: 8 * 1024 * 1024,
    byteValue: 0x41,
    lineBytes: 4096,
    markerLine: 1024,
    marker: scenario.target,
  })
  assert.equal(seeded?.ok, true, JSON.stringify(seeded))
  const seedFlush = await testAction({ action: 'flush-workspace' })
  assert.equal(seedFlush?.ok, true, JSON.stringify(seedFlush))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 90_000 })
  const sourceBefore = await readDigest(scenario.path)
  assert.equal(sourceBefore?.ok, true, JSON.stringify(sourceBefore))
  assert.deepEqual(await testAction({ action: 'set-file-tool-delay', delayMs: scenario.tool === 'grep' ? 100 : 20 })
    .then(value => ({ ok: value?.ok })), { ok: true })
  await page.evaluate(() => {
    const sample = { active: true, previous: undefined, maxGapMs: 0, frames: 0, frame: 0 }
    const tick = timestamp => {
      if (!sample.active) return
      if (sample.previous !== undefined) sample.maxGapMs = Math.max(sample.maxGapMs, timestamp - sample.previous)
      sample.previous = timestamp
      sample.frames += 1
      sample.frame = requestAnimationFrame(tick)
    }
    window.__dshToolCancellationFrameSample = sample
    sample.frame = requestAnimationFrame(tick)
  })

  const waitForStage = testAction({ action: 'wait-file-tool-stage', toolStage: scenario.stage })
  void waitForStage.catch(() => {})
  const interrupted = await submitPrompt({
    page,
    origin,
    requests,
    prompt: `${scenario.promptMarker}: run the requested file tool and keep the operation active until interrupted.`,
    timeout: 90_000,
    expectedReason: scenario.action === 'stop' ? 'aborted' : null,
    probeWhileRunning: async ({ sessionId: runningSessionId }) => {
      sessionId = runningSessionId
      const call = await waitFor(async () => toolCallFor(await readSession(), scenario.tool),
        `durable ${scenario.tool} call for ${scenarioName}`, 60_000)
      assert.equal(typeof call.data.callId, 'string')
      if (scenario.tool === 'edit') {
        assert.equal(sessionFlushes.some(flush => flush.durableThroughSeq >= call.seq), true,
          'the DSH edit call must be durable before its copy-on-write operation reaches the observed stage')
      }

      const stage = await waitForStage
      if (stage?.ok !== true || stage?.stage !== scenario.stage) {
        const observedSession = await readSession()
        const call = toolCallFor(observedSession, scenario.tool)
        throw new Error(JSON.stringify({ stage, call, result: call === undefined ? undefined : resultFor(observedSession, call.data.callId) }))
      }
      const stagedDirectories = scenario.tool === 'edit' ? await listEditTemporaryDirectories() : []
      if (scenario.tool === 'edit') assert.equal(stagedDirectories.length, 1, 'edit must own one OPFS copy-on-write directory before interruption')

      if (scenario.action === 'stop') {
        const stop = page.getByRole('button', {
          name: /^(Stop generating|Stop the current agent run|停止生成|停止当前 Agent 操作)$/,
        }).last()
        await stop.waitFor({ state: 'visible', timeout: 10_000 })
        const modelRequestsAtInterruption = conversationModelRequestCount()
        const stopRequestedAt = Date.now()
        await stop.click()
        return { callId: call.data.callId, stage: scenario.stage, stagedDirectories, modelRequestsAtInterruption, stopRequestedAt }
      }

      const llmRequestsAtTerminate = conversationModelRequestCount()
      const frameSample = await page.evaluate(() => {
        const sample = window.__dshToolCancellationFrameSample
        sample.active = false
        cancelAnimationFrame(sample.frame)
        return { maxGapMs: sample.maxGapMs, frames: sample.frames }
      })
      await page.evaluate(() => {
        const workers = window.__dshBrowserWorkers
        if (workers.length === 0) throw new Error('Dedicated Worker was not captured')
        for (const worker of workers) worker.terminate()
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForPreview(page)
      await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
        && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 45_000 })
      const recovered = await waitFor(async () => {
        const session = await readSession()
        const result = resultFor(session, call.data.callId)
        const terminal = session.events.findLast(event => event.type === 'turn/end' && event.data.turn === call.data.turn)
        return result?.data.error?.code === 'TOOL_OUTCOME_UNKNOWN' && terminal !== undefined
          ? { session, result, terminal }
          : undefined
      }, 'unknown settlement of the interrupted edit and terminal turn', 60_000)
      assert.equal(recovered.session.events.filter(event => event.type === 'tool/call'
        && event.data.callId === call.data.callId).length, 1, 'Worker recovery must not replay the old edit call')
      assert.equal(conversationModelRequestCount(), llmRequestsAtTerminate,
        'refresh recovery must not issue a second model request for the interrupted prompt')
      assert.deepEqual(await listEditTemporaryDirectories(), [], 'refresh must clean the abandoned OPFS edit directory')
      return {
        callId: call.data.callId,
        stage: scenario.stage,
        stagedDirectories,
        recoveryCode: recovered.result.data.error.code,
        terminalReason: recovered.terminal.data.reason.kind,
        llmRequestsAtTerminate,
        frameSample,
      }
    },
  })
  const stopToTerminalObservedMs = scenario.action === 'stop'
    ? Date.now() - interrupted.runningProbe.stopRequestedAt
    : undefined
  const frameSample = scenario.action === 'stop'
    ? await page.evaluate(() => {
      const sample = window.__dshToolCancellationFrameSample
      sample.active = false
      cancelAnimationFrame(sample.frame)
      return { maxGapMs: sample.maxGapMs, frames: sample.frames }
    })
    : interrupted.runningProbe.frameSample

  const interruptedCall = interrupted.session.events.findLast(event => event.type === 'tool/call'
    && event.data.name === scenario.tool && event.data.turn === interrupted.turn)
  assert.ok(interruptedCall, `missing ${scenario.tool} call in interrupted turn`)
  assert.equal(interrupted.session.events.filter(event => event.type === 'tool/call'
    && event.data.callId === interruptedCall.data.callId).length, 1)
  if (scenario.action === 'stop') {
    const terminal = interrupted.session.events.findLast(event => event.type === 'turn/end'
      && event.data.turn === interrupted.turn)
    assert.equal(terminal?.data.reason.kind, 'aborted')
    const result = resultFor(interrupted.session, interruptedCall.data.callId)
    assert.equal(result === undefined || result.data.error !== undefined || result.data.message?.isError === true,
      true, 'an aborted file tool must not be recorded as successful')
    assert.equal(conversationModelRequestCount(), interrupted.runningProbe.modelRequestsAtInterruption,
      'Stop during a tool must not request another model turn')
  }
  assert.equal(interrupted.session.events.some(event => event.type === 'browser-native/workspace-receipt'
    && event.data.callId === interruptedCall.data.callId), false, 'an unpublished edit must not create a Workspace receipt')
  assert.equal(commits.length, 1, 'only the fixture seed may commit before the continuation')
  assert.deepEqual(await readDigest(scenario.path), sourceBefore,
    'interruption before VFS publication must preserve the source bytes')
  assert.equal((await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision)), 1)
  if (scenario.tool === 'edit') assert.deepEqual(await listEditTemporaryDirectories(), [])

  const continued = await sendTurn({
    page,
    origin,
    requests,
    sessionId: interrupted.sessionId,
    prompt: `${scenario.continueMarker}: search the unchanged source file.`,
    marker: scenario.continueMarker.replace('_E2E', '_DONE'),
    timeout: 90_000,
  })
  const continuationCalls = continued.session.events.filter(event => event.type === 'tool/call'
    && event.data.turn === continued.turn)
  assert.deepEqual(continuationCalls.map(event => event.data.name), ['grep'])
  assert.equal(continuationCalls.length, 1)
  assert.equal(assistantText(continued.session, continued.turn).includes(scenario.continueMarker.replace('_E2E', '_DONE')), true)
  assert.equal(commits.length, 1, 'read-only continuation must not create a Workspace commit')
  assert.deepEqual(await readDigest(scenario.path), sourceBefore)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scenario: scenarioName,
    action: scenario.action,
    sessionId: interrupted.sessionId,
    workspaceId,
    tool: scenario.tool,
    toolCallId: interruptedCall.data.callId,
    observedStage: scenario.stage,
    stopToTerminalObservedMs,
    promptMaxFrameGapMs: frameSample.maxGapMs,
    promptAnimationFrames: frameSample.frames,
    interruptedTurnReason: interrupted.session.events.findLast(event => event.type === 'turn/end'
      && event.data.turn === interrupted.turn)?.data.reason.kind,
    continuationTurn: continued.turn,
    workspaceRevision: 1,
    workspaceCommitRequests: commits.length,
    sessionFlushThrough: sessionFlushes.map(flush => flush.durableThroughSeq),
    sourceBytes: sourceBefore.bytes,
    sourceDigest: sourceBefore.digest,
    modelRequests: conversationModelRequestCount(),
    pageErrors,
    workerErrors,
    externalRequests,
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    scenario: scenarioName,
    sessionId,
    workspaceId,
    commits,
    requests: requests.map(request => ({ path: request.path, sessionId: request.body?.sessionId })),
    modelInputs: requests.filter(request => request.path.endsWith('/llm')).map(request => ({
      purpose: request.body?.purpose,
      messages: request.body?.messages?.filter(message => message.role === 'user').map(message => message.content),
      tools: request.body?.tools?.map(tool => tool.function?.name ?? tool.name),
    })),
    pageText: page !== undefined && !page.isClosed() ? (await page.locator('body').innerText().catch(() => '')).slice(-2500) : undefined,
    pageErrors,
    workerErrors,
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close().catch(() => {})
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
