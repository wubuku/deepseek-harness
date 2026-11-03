import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-worker-crash-tool-`))
const previewUrl = origin => `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`
const leaseDurationMs = 5_000
const toolSleepMs = 8_000
const bootMarker = 'BROWSER_NATIVE_SCRIPTED_E2E_OK'
const requests = []
const pageErrors = []
const externalRequests = []
let image
let app
let browser
let context
let page
let sessionId
let origin

async function workspaceTest(target, request) {
  return await target.evaluate(async value => {
    const test = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof test !== 'function') throw new Error('Browser-Native test port is unavailable')
    return await test(value)
  }, request)
}

function eventTypes(events) {
  return events.map(event => event.type)
}

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    ownerLeaseMs: leaseDurationMs,
    testHooks: { workspaceWriterLeaseMs: leaseDurationMs },
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({ path: url.pathname, body })
  })
  await openPreview(page, previewUrl(origin))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const firstLease = await workspaceTest(page, { action: 'lease-info' })
  assert.equal(firstLease.ok, true, JSON.stringify(firstLease))

  const boot = await sendTurn({
    page,
    origin,
    requests,
    prompt: `${bootMarker}：只回复 ${bootMarker}，不调用工具。`,
    timeout: 60_000,
  })
  sessionId = boot.sessionId

  const prompt = 'BROWSER_NATIVE_RELOAD_DURING_TOOL_E2E：调用一次需要较长时间的工具。'
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(prompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const callStartedAt = Date.now()
  const call = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    return session.events?.find(event => event.type === 'tool/call'
      && String(event.data.callId) === 'browser-native-reload-bash')
  }, 'the delayed tool call to start', 30_000)
  const approval = page.locator('[data-approval-key]')
  if (await approval.isVisible()) {
    await approval.getByRole('button', { name: 'Allow once' }).click()
  }
  await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
  const beforeCrash = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
  const ownerEpochBeforeCrash = beforeCrash.ownerEpoch
  const revisionBeforeCrash = (await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)).revision
  const llmBeforeCrash = requests.filter(request => request.path.endsWith('/llm')).length
  assert.equal(beforeCrash.events.some(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === call.data.callId), false)
  assert.equal(beforeCrash.events.some(event => event.type === 'turn/end' && event.data.turn === call.data.turn), false)

  const client = await context.newCDPSession(page)
  const targets = (await client.send('Target.getTargets')).targetInfos
  const workerTarget = targets.find(target => target.type === 'worker' && target.url.includes('browser-native-worker'))
  assert.ok(workerTarget, `the Dedicated Worker target must be observable: ${JSON.stringify(targets.map(target => target.type))}`)
  const crashedAt = Date.now()
  const attached = await client.send('Target.attachToTarget', { targetId: workerTarget.targetId, flatten: true })
  await client.send('Runtime.evaluate', { expression: 'self.close()', sessionId: attached.sessionId })
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000))
  const afterCrash = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
  assert.equal(afterCrash.events.length, beforeCrash.events.length,
    'a crashed Worker must not append Session events before recovery')
  assert.equal(afterCrash.events.some(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === call.data.callId), false,
    'a crashed Worker must not complete the running tool')
  assert.equal(afterCrash.events.some(event => event.type === 'turn/end' && event.data.turn === call.data.turn), false,
    'a crashed Worker must not settle the running turn')
  assert.equal(requests.filter(request => request.path.endsWith('/llm')).length, llmBeforeCrash,
    'a crashed Worker must not request another model stream')

  const reloadStartedAt = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 45_000 })
  const reloadLease = await waitFor(async () => {
    const lease = await workspaceTest(page, { action: 'lease-info' })
    return lease.ok === true && lease.accessMode === 'writer' ? lease : undefined
  }, 'writer lease after crash reload', 45_000)
  const settled = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const result = session.events.find(event => event.type === 'tool/result'
      && String(event.data.message.toolCallId) === call.data.callId)
    const terminal = session.events.find(event => event.type === 'turn/end' && event.data.turn === call.data.turn)
    return result !== undefined && terminal !== undefined ? { session, result, terminal } : undefined
  }, 'crash reload to settle the interrupted turn', 45_000)
  const settleAfterReloadMs = Date.now() - reloadStartedAt
  const crashToSettlementMs = Date.now() - crashedAt
  assert.equal(settled.terminal.data.reason.kind, 'interrupted')
  assert.equal(settled.result.data.error?.code, 'TOOL_OUTCOME_UNKNOWN')
  assert.equal(settled.session.ownerEpoch, ownerEpochBeforeCrash + 1,
    'crash recovery must advance the Session owner epoch exactly once')
  assert.notEqual(reloadLease.writerToken, firstLease.writerToken)
  assert.equal(reloadLease.fencingToken, firstLease.fencingToken + 1,
    'crash recovery must advance the Writer fencing token exactly once')

  const afterReload = settled.session
  const prefix = afterReload.events.slice(0, beforeCrash.events.length)
  assert.deepEqual(prefix, beforeCrash.events, 'crash hydrate must not rewrite the persisted event prefix')
  const appended = afterReload.events.slice(beforeCrash.events.length)
  const closers = appended.filter(event => event.type !== 'session/end-seed')
  assert.deepEqual(closers.map(event => event.type), ['tool/result', 'step/end', 'turn/end'],
    `crash reload must append only the interrupted closers: ${JSON.stringify(appended)}`)
  assert.equal(afterCrash.events.slice(beforeCrash.events.length).filter(event => event.type === 'tool/call'
    && String(event.data.callId) === call.data.callId).length, 0,
  'no tool call may be recorded between crash and reload')
  assert.equal(afterReload.events.filter(event => event.type === 'tool/call'
    && String(event.data.callId) === call.data.callId).length, 1,
  'crash recovery must not replay the interrupted tool call')
  assert.equal(afterReload.events.filter(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === call.data.callId).length, 1)
  assert.equal(afterReload.events.filter(event => event.type === 'turn/end'
    && event.data.turn === call.data.turn).length, 1)
  assert.equal(requests.filter(request => request.path.endsWith('/llm')).length, llmBeforeCrash,
    'crash settlement must not request another model stream')

  await new Promise(resolveDelay => setTimeout(resolveDelay,
    Math.max(0, callStartedAt + toolSleepMs + 500 - Date.now())))
  const residual = await workspaceTest(page, { action: 'read', path: '/dsh/home/workspace/reload-residual.txt' })
  assert.equal(residual.ok, false, 'the crashed tool must never land its delayed write')
  const revisionAfterSettlement = (await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)).revision
  assert.equal(revisionAfterSettlement, revisionBeforeCrash)
  const bootTextOccurrences = await page.evaluate(marker => {
    const text = [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')]
      .map(node => node.textContent ?? '').join('\n')
    return text.split(marker).length - 1
  }, bootMarker)
  assert.equal(bootTextOccurrences, 1)

  const resumed = await sendTurn({
    page,
    origin,
    requests,
    sessionId,
    prompt: 'BROWSER_NATIVE_RELOAD_CONTINUE_E2E：只回复 BROWSER_NATIVE_RELOAD_CONTINUE_E2E_DONE。',
    timeout: 60_000,
  })
  const final = resumed.session
  assert.equal(final.events.filter(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === call.data.callId).length, 1)
  assert.equal(final.events.filter(event => event.type === 'turn/end'
    && event.data.turn === call.data.turn).length, 1)
  assert.equal(final.events.filter(event => event.type === 'turn/end'
    && event.data.turn === resumed.turn && event.data.reason.kind === 'completed').length, 1)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'worker-crash-during-tool-execution',
    sessionId,
    toolCallId: call.data.callId,
    workerTargetUrl: workerTarget.url,
    crashedAt,
    crashToSettlementMs,
    settleAfterReloadMs,
    leaseDurationMs,
    settledBeforeTtl: crashToSettlementMs < leaseDurationMs,
    sessionEventsBeforeCrash: beforeCrash.events.length,
    sessionEventsOneSecondAfterCrash: afterCrash.events.length,
    sessionEventsAfterSettlement: afterReload.events.length,
    appendedCloserEvents: closers.map(event => event.type),
    ownerEpochBeforeCrash,
    ownerEpochAfterRecovery: afterReload.ownerEpoch,
    fencingTokenBeforeCrash: firstLease.fencingToken,
    fencingTokenAfterRecovery: reloadLease.fencingToken,
    persistedPrefixIdentical: true,
    interruptedToolOutcome: settled.result.data.error?.code,
    interruptedTurnSettled: settled.terminal.data.reason.kind,
    modelRequestsDuringSettlement: 0,
    replayedToolCallEvents: 0,
    residualWrites: 0,
    workspaceRevisionBeforeCrash: revisionBeforeCrash,
    workspaceRevisionAfterSettlement: revisionAfterSettlement,
    projectedAssistantTextOccurrences: bootTextOccurrences,
    continuationCompleted: true,
    note: 'Closing the Dedicated Worker through CDP bypasses pagehide, so no lease is released and the Session cannot be handed over from the dead owner; the backend keeps the dead owner epoch until recovery. Reloading the page mounts a new Worker that recovers the Session, advances ownerEpoch and the Writer fencing token exactly once, and appends only the interrupted closers.',
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    sessionId,
    pageErrors,
    externalRequests,
    session: sessionId !== undefined && origin !== undefined
      ? await sessionRequest(origin, 'read', { sessionId, offset: 0 }).catch(() => undefined)
      : undefined,
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
