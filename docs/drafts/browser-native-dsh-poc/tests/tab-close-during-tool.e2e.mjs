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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-tab-close-tool-`))
const previewUrl = origin => `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`
const leaseDurationMs = 5_000
const toolSleepMs = 8_000
const requests = []
const pageErrors = []
const externalRequests = []
let image
let app
let browser
let context
let owner
let survivor
let sessionId
let origin

async function workspaceTest(page, request) {
  return await page.evaluate(async value => {
    const test = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof test !== 'function') throw new Error('Browser-Native test port is unavailable')
    return await test(value)
  }, request)
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
  owner = await context.newPage()
  owner.on('pageerror', error => pageErrors.push(error.message))
  owner.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({ path: url.pathname, body })
  })
  await openPreview(owner, previewUrl(origin))
  await owner.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const ownerLease = await workspaceTest(owner, { action: 'lease-info' })
  assert.equal(ownerLease.ok, true, JSON.stringify(ownerLease))

  const boot = await sendTurn({
    page: owner,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_TAB_CLOSE_BOOT_E2E：只回复 TAB_CLOSE_BOOT_OK，不调用工具。',
    timeout: 60_000,
  })
  sessionId = boot.sessionId

  const popupPromise = owner.waitForEvent('popup')
  await owner.evaluate(value => window.open(value, '_blank'), previewUrl(origin))
  survivor = await popupPromise
  await survivor.waitForFunction(() => ['recovery-conflict', 'recovery-unavailable', 'error']
    .includes(window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state ?? ''), undefined, { timeout: 30_000 })
  assert.equal(await survivor.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.state), 'recovery-conflict')

  const prompt = 'BROWSER_NATIVE_TAB_CLOSE_DURING_TOOL_E2E：调用一次需要较长时间的工具。'
  await owner.locator('[data-composer-input][contenteditable="true"]').last().fill(prompt)
  await owner.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const call = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    return session.events?.find(event => event.type === 'tool/call' && String(event.data.callId) === 'browser-native-tab-close-bash')
  }, 'the delayed tool call to start', 30_000)
  const approval = owner.locator('[data-approval-key]')
  if (await approval.isVisible()) {
    await approval.getByRole('button', { name: 'Allow once' }).click()
  }
  await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
  const beforeClose = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
  const revisionBeforeClose = (await owner.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)).revision
  const llmBeforeClose = requests.filter(request => request.path.endsWith('/llm')).length
  assert.equal(beforeClose.events.some(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === call.data.callId), false,
    'the tool must still be running at close time')
  assert.equal(beforeClose.events.some(event => event.type === 'turn/end' && event.data.turn === call.data.turn), false)

  const closedAt = Date.now()
  await owner.close()
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000))
  const afterClose = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
  assert.equal(afterClose.events.length, beforeClose.events.length,
    'a closed tab must not append Session events after its final flush')
  assert.equal(afterClose.events.some(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === call.data.callId), false,
    'a closed tab must not complete the running tool')
  assert.equal(afterClose.events.some(event => event.type === 'turn/end' && event.data.turn === call.data.turn), false,
    'a closed tab must not settle the running turn')

  await survivor.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(survivor)
  await survivor.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const takeoverLease = await waitFor(async () => {
    const lease = await workspaceTest(survivor, { action: 'lease-info' })
    return lease.ok === true && lease.accessMode === 'writer' ? lease : undefined
  }, 'writer lease takeover after abrupt tab close', 45_000)
  const takeoverAfterMs = Date.now() - closedAt
  assert.notEqual(takeoverLease.writerToken, ownerLease.writerToken)
  assert.ok(takeoverAfterMs < leaseDurationMs,
    `the writer lease must be released on pagehide instead of expiring after the TTL: ${String(takeoverAfterMs)}ms`)
  const residualImmediately = await workspaceTest(survivor, { action: 'read', path: '/dsh/home/workspace/tab-close-residual.txt' })
  assert.equal(residualImmediately.ok, false, 'the dead tab must not leave the delayed tool write behind')
  await new Promise(resolveDelay => setTimeout(resolveDelay,
    Math.max(0, toolSleepMs + 500 - (Date.now() - closedAt))))
  const afterDeadWindow = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
  assert.equal(requests.filter(request => request.path.endsWith('/llm')).length, llmBeforeClose,
    'a closed tab must not request another model stream')
  const lateResults = afterDeadWindow.events.filter(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === call.data.callId)
  assert.equal(lateResults.length, 1, 'only the takeover settlement may resolve the dead tool')
  assert.equal(lateResults[0].data.error?.code, 'TOOL_OUTCOME_UNKNOWN')
  const residualAfterDeadWindow = await workspaceTest(survivor, { action: 'read', path: '/dsh/home/workspace/tab-close-residual.txt' })
  assert.equal(residualAfterDeadWindow.ok, false, 'the dead tool must never land its delayed write')
  const revisionAfterTakeover = (await survivor.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)).revision
  assert.equal(revisionAfterTakeover, revisionBeforeClose)
  assert.equal(await survivor.locator('[data-approval-key]').count(), 0)

  const resumed = await sendTurn({
    page: survivor,
    origin,
    requests,
    sessionId,
    prompt: 'BROWSER_NATIVE_TAB_CLOSE_CONTINUE_E2E：只回复 TAB_CLOSE_CONTINUE_OK。',
    timeout: 60_000,
  })
  const final = resumed.session
  const oldTurnTerminal = final.events.filter(event => event.type === 'turn/end' && event.data.turn === call.data.turn)
  assert.equal(oldTurnTerminal.length, 1, 'the interrupted turn must settle exactly once on takeover')
  assert.equal(oldTurnTerminal[0].data.reason.kind, 'interrupted',
    'the interrupted turn must settle as interrupted, not completed')
  const oldTurnResults = final.events.filter(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === call.data.callId)
  assert.equal(oldTurnResults.length, 1, 'the interrupted tool must settle exactly once on takeover')
  assert.equal(oldTurnResults[0].data.message.isError, true)
  assert.equal(oldTurnResults[0].data.error?.code, 'TOOL_OUTCOME_UNKNOWN',
    'the dead tool must settle as unknown rather than replay or fabricate a result')
  assert.equal(final.events.filter(event => event.type === 'approval/asked').length,
    beforeClose.events.filter(event => event.type === 'approval/asked').length,
    'takeover must not re-ask a settled or interrupted approval')
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'tab-close-during-tool-execution',
    sessionId,
    toolCallId: call.data.callId,
    closedAt,
    takeoverAfterMs,
    leaseDurationMs,
    takeoverReleasedBeforeTtl: takeoverAfterMs < leaseDurationMs,
    takeoverLease: { fencingToken: takeoverLease.fencingToken, accessMode: takeoverLease.accessMode, state: takeoverLease.state },
    sessionEventsAtClose: beforeClose.events.length,
    sessionEventsOneSecondAfterClose: afterClose.events.length,
    eventsBetweenCloseAndTakeover: afterClose.events.length - beforeClose.events.length,
    toolCompletedAfterClose: false,
    turnEndedAfterClose: false,
    interruptedToolOutcome: oldTurnResults[0].data.error?.code,
    modelRequestsAfterClose: 0,
    residualWrites: 0,
    workspaceRevisionBeforeClose: revisionBeforeClose,
    workspaceRevisionAfterTakeover: revisionAfterTakeover,
    interruptedTurnSettled: oldTurnTerminal[0].data.reason.kind,
    continuationCompleted: final.events.some(event => event.type === 'turn/end'
      && event.data.turn === resumed.turn && event.data.reason.kind === 'completed'),
    note: 'Closing the tab terminates the Dedicated Worker: the running turn receives no tool result and no turn/end while the tab is gone, later Session events and model requests stop, and the delayed tool write never lands. On takeover the open tool call settles exactly once as TOOL_OUTCOME_UNKNOWN and the turn settles once as interrupted, the survivor acquires a new writer lease without changing Workspace revision, and a new prompt starts a fresh turn without replaying the dead tool.',
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
  await Promise.all([owner, survivor].map(page => page?.close().catch(() => {})))
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
