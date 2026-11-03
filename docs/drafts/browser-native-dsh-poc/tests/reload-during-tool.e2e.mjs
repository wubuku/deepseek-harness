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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-reload-tool-`))
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

function sessionEventType(event) {
  return event.type
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
  assert.equal(boot.session.events.filter(event => event.type === 'turn/end').length, 1)

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
  const beforeReload = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
  const revisionBeforeReload = (await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)).revision
  const llmBeforeReload = requests.filter(request => request.path.endsWith('/llm')).length
  const callCountBeforeReload = beforeReload.events.filter(event => event.type === 'tool/call'
    && String(event.data.callId) === call.data.callId).length
  assert.equal(callCountBeforeReload, 1, 'the delayed tool must be recorded exactly once before reload')
  assert.equal(beforeReload.events.some(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === call.data.callId), false,
    'the tool must still be running at reload time')
  assert.equal(beforeReload.events.some(event => event.type === 'turn/end' && event.data.turn === call.data.turn), false)

  const reloadStartedAt = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 45_000 })
  const reloadLease = await waitFor(async () => {
    const lease = await workspaceTest(page, { action: 'lease-info' })
    return lease.ok === true && lease.accessMode === 'writer' ? lease : undefined
  }, 'writer lease after reload', 45_000)
  const settled = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const result = session.events.find(event => event.type === 'tool/result'
      && String(event.data.message.toolCallId) === call.data.callId)
    const terminal = session.events.find(event => event.type === 'turn/end' && event.data.turn === call.data.turn)
    return result !== undefined && terminal !== undefined ? { session, result, terminal } : undefined
  }, 'hydrate to settle the interrupted turn', 30_000)
  const settleAfterReloadMs = Date.now() - reloadStartedAt
  assert.notEqual(reloadLease.writerToken, firstLease.writerToken)
  assert.ok(settleAfterReloadMs < leaseDurationMs,
    `reload must settle through the pagehide release, not the lease TTL: ${String(settleAfterReloadMs)}ms`)

  const afterReload = settled.session
  const prefix = afterReload.events.slice(0, beforeReload.events.length)
  assert.deepEqual(prefix.map(sessionEventType), beforeReload.events.map(sessionEventType),
    'hydrate must preserve the persisted event prefix in order')
  assert.deepEqual(prefix.map(event => event.seq), beforeReload.events.map(event => event.seq),
    'hydrate must not renumber persisted events')
  assert.deepEqual(prefix, beforeReload.events, 'hydrate must not rewrite persisted events')
  const appended = afterReload.events.slice(beforeReload.events.length)
  const closers = appended.filter(event => event.type !== 'session/end-seed')
  assert.equal(closers.length, 3,
    `reload must append only the interrupted closer events: ${JSON.stringify(appended)}`)
  assert.deepEqual(closers.map(sessionEventType), ['tool/result', 'step/end', 'turn/end'])
  assert.equal(appended.filter(event => event.type === 'session/end-seed').length, 1,
    'reload must record one hydrate seed marker, not replay turn state')
  const lateResult = settled.result
  assert.equal(lateResult.data.message.isError, true)
  assert.equal(lateResult.data.error?.code, 'TOOL_OUTCOME_UNKNOWN')
  assert.equal(settled.terminal.data.reason.kind, 'interrupted')
  assert.equal(afterReload.events.filter(event => event.type === 'tool/call'
    && String(event.data.callId) === call.data.callId).length, 1,
    'hydrate must not replay the interrupted tool call')
  assert.equal(afterReload.events.filter(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === call.data.callId).length, 1,
    'the interrupted tool must settle exactly once')
  assert.equal(afterReload.events.filter(event => event.type === 'turn/end'
    && event.data.turn === call.data.turn).length, 1,
    'the interrupted turn must settle exactly once')
  assert.equal(afterReload.events.filter(event => event.type === 'assistant/message'
    && (event.data.turn === call.data.turn)).length,
  beforeReload.events.filter(event => event.type === 'assistant/message'
    && (event.data.turn === call.data.turn)).length,
  'settlement must not request or fabricate another assistant response')
  assert.equal(requests.filter(request => request.path.endsWith('/llm')).length, llmBeforeReload,
    'settlement after reload must not request another model stream')
  assert.equal(afterReload.events.filter(event => event.type === 'approval/asked').length,
    beforeReload.events.filter(event => event.type === 'approval/asked').length,
    'reload must not re-ask a settled or interrupted approval')
  assert.equal(await page.locator('[data-approval-key]').count(), 0)
  const bootTextOccurrences = await page.evaluate(marker => {
    const text = [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')]
      .map(node => node.textContent ?? '').join('\n')
    return text.split(marker).length - 1
  }, bootMarker)
  assert.equal(bootTextOccurrences, 1, 'hydrate must project each persisted assistant message once')

  await new Promise(resolveDelay => setTimeout(resolveDelay,
    Math.max(0, callStartedAt + toolSleepMs + 500 - Date.now())))
  const residual = await workspaceTest(page, { action: 'read', path: '/dsh/home/workspace/reload-residual.txt' })
  assert.equal(residual.ok, false, 'a tool killed by reload must never land its delayed write')
  const revisionAfterSettlement = (await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)).revision
  assert.equal(revisionAfterSettlement, revisionBeforeReload)

  const resumed = await sendTurn({
    page,
    origin,
    requests,
    sessionId,
    prompt: 'BROWSER_NATIVE_RELOAD_CONTINUE_E2E：只回复 BROWSER_NATIVE_RELOAD_CONTINUE_E2E_DONE。',
    timeout: 60_000,
  })
  const final = resumed.session
  assert.equal(final.events.filter(event => event.type === 'turn/end' && event.data.turn === call.data.turn).length, 1,
    'the interrupted turn must stay settled once after continuation')
  assert.equal(final.events.filter(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === call.data.callId).length, 1,
    'continuation must not replay the interrupted tool')
  assert.equal(final.events.filter(event => event.type === 'turn/end'
    && event.data.turn === resumed.turn && event.data.reason.kind === 'completed').length, 1)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'reload-during-tool-execution',
    sessionId,
    toolCallId: call.data.callId,
    reloadStartedAt,
    settleAfterReloadMs,
    leaseDurationMs,
    settledBeforeTtl: settleAfterReloadMs < leaseDurationMs,
    leaseAfterReload: { fencingToken: reloadLease.fencingToken, accessMode: reloadLease.accessMode, state: reloadLease.state },
    sessionEventsBeforeReload: beforeReload.events.length,
    sessionEventsAfterSettlement: afterReload.events.length,
    appendedCloserEvents: closers.map(sessionEventType),
    hydrateSeedEvents: 1,
    persistedPrefixIdentical: true,
    interruptedToolOutcome: lateResult.data.error?.code,
    interruptedTurnSettled: settled.terminal.data.reason.kind,
    modelRequestsDuringSettlement: 0,
    replayedToolCallEvents: 0,
    residualWrites: 0,
    workspaceRevisionBeforeReload: revisionBeforeReload,
    workspaceRevisionAfterSettlement: revisionAfterSettlement,
    projectedAssistantTextOccurrences: bootTextOccurrences,
    continuationCompleted: true,
    note: 'Reloading the page during a running tool destroys the old Dedicated Worker exactly like tab close, but the pagehide barrier releases Session ownership and the Writer lease, so the reloaded Worker resumes the same Session in under the lease TTL, appends only the three interrupted closer events, keeps the persisted prefix byte-identical, never replays the tool call, never re-requests the model, and never lands the delayed write. The next prompt continues the same Session.',
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
