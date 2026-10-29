import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-approval-integrity-')))
const requests = []
const pageErrors = []
const workerErrors = []
const externalRequests = []
let image
let app
let browser
let page
let origin

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({ path: url.pathname, body })
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=approval-integrity&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  const projection = await testAction({ action: 'approval-projection-probe' })
  assert.equal(projection?.ok, true, JSON.stringify(projection))
  assert.equal(projection.approvalProjection?.ok, true, JSON.stringify(projection))
  assert.deepEqual(projection.approvalProjection?.firstPending, ['request-a', 'request-b'])
  assert.equal(projection.approvalProjection?.firstSummaryTruncated, true)
  assert.equal(projection.approvalProjection?.claimIsDurable, false)
  assert.equal(projection.approvalProjection?.duplicateClaimRejected, true)
  assert.deepEqual(projection.approvalProjection?.replayPending, [])
  assert.equal(projection.approvalProjection?.replayDecisions?.[0]?.outcome, 'allowed-once')
  assert.deepEqual(projection.approvalProjection?.invalidDiagnostics, [
    'DUPLICATE_REQUEST',
    'APPROVAL_CALL_UNBOUND',
    'APPROVAL_CALL_SETTLED',
    'DECISION_UNBOUND',
    'DECISION_CALL_SETTLED',
    'DECISION_DUPLICATE',
  ])

  const boot = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_PERMISSION_BOOT_E2E：只回复 PERMISSION_BOOT_OK，不调用工具。',
    timeout: 60_000,
  })
  const sessionId = boot.sessionId
  const prompt = 'BROWSER_NATIVE_PERMISSION_APPROVAL_E2E：请求一次需要审批的 Worker 文件操作。'
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(prompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const asked = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    return session.events?.find(event => event.type === 'approval/asked')
  }, 'approval request from the real Browser Worker', 30_000)
  assert.ok(asked)
  const approvalPanel = page.locator('[data-approval-key]')
  await approvalPanel.waitFor({ state: 'visible', timeout: 30_000 })
  await approvalPanel.getByRole('button', { name: 'Reject' }).click()
  const settled = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const decided = session.events?.findLast(event => event.type === 'approval/decided')
    const call = session.events?.find(event => event.type === 'tool/call' && event.data.callId === asked.data.callId)
    const result = session.events?.find(event => event.type === 'tool/result'
      && String(event.data.message.toolCallId) === String(asked.data.callId))
    const terminal = call === undefined ? undefined : session.events?.findLast(event => event.type === 'turn/end'
      && event.data.turn === call.data.turn)
    return decided?.data.outcome === 'rejected' && result !== undefined && terminal !== undefined
      ? { session, decided, terminal } : undefined
  }, 'rejected approval settlement in the Session log', 30_000)
  const result = settled.session.events.find(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === String(asked.data.callId))
  assert.ok(result)
  assert.equal(result.data.message.isError, true)
  assert.equal((await testAction({ action: 'read', path: '/dsh/home/workspace/approval-result.txt' })).ok, false)
  assert.equal(settled.session.events.filter(event => event.type === 'approval/asked').length, 1)
  assert.equal(settled.session.events.filter(event => event.type === 'approval/decided').length, 1)
  assert.equal(assistantText(settled.session, settled.terminal.data.turn).includes('BROWSER_NATIVE_PERMISSION_APPROVAL_REJECTED'), true)

  const recoveryPrompt = 'BROWSER_NATIVE_PERMISSION_APPROVAL_RECOVERY_E2E：等待审批期间刷新页面，不要自动重试。'
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(recoveryPrompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const recoveryAsked = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const call = session.events?.find(event => event.type === 'tool/call'
      && event.data.callId === 'browser-native-permission-approval-recovery-bash')
    const approval = session.events?.find(event => event.type === 'approval/asked'
      && event.data.callId === 'browser-native-permission-approval-recovery-bash')
    return call !== undefined && approval !== undefined ? { session, call, approval } : undefined
  }, 'second approval request before Worker refresh', 30_000)
  await page.locator('[data-approval-key]').waitFor({ state: 'visible', timeout: 30_000 })
  const llmRequestCountBeforeRefresh = requests.filter(request => request.path.endsWith('/llm')).length
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  const interrupted = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const result = session.events?.find(event => event.type === 'tool/result'
      && String(event.data.message.toolCallId) === 'browser-native-permission-approval-recovery-bash')
    const terminal = session.events?.findLast(event => event.type === 'turn/end'
      && event.data.turn === recoveryAsked.call.data.turn)
    return result !== undefined && terminal !== undefined ? { session, result, terminal } : undefined
  }, 'Worker refresh settlement for interrupted approval', 45_000)
  assert.equal(interrupted.result.data.message.isError, true)
  assert.equal(interrupted.result.data.error?.code, 'TOOL_OUTCOME_UNKNOWN')
  assert.notEqual(interrupted.terminal.data.reason.kind, 'completed')
  assert.equal(await page.locator('[data-approval-key]').count(), 0)
  assert.equal(requests.filter(request => request.path.endsWith('/llm')).length, llmRequestCountBeforeRefresh)
  assert.equal((await testAction({ action: 'read', path: '/dsh/home/workspace/approval-recovery-result.txt' })).ok, false)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'DedicatedWorker-approval-projection-and-DSH-session-rejection-integrity',
    sessionId,
    projection: projection.approvalProjection,
    approvalRequestId: String(asked.data.id),
    approvalCallId: String(asked.data.callId),
    approvalOutcome: settled.decided.data.outcome,
    rejectedToolResult: result.data.error?.code ?? null,
    refreshRecovery: {
      approvalRequestId: String(recoveryAsked.approval.data.id),
      resultCode: interrupted.result.data.error?.code ?? null,
      terminalReason: interrupted.terminal.data.reason.kind,
      approvalCardAfterRefresh: await page.locator('[data-approval-key]').count(),
      llmRequestsBeforeRefresh: llmRequestCountBeforeRefresh,
      llmRequestsAfterRefresh: requests.filter(request => request.path.endsWith('/llm')).length,
    },
    llmRequestCount: requests.filter(request => request.path.endsWith('/llm')).length,
    pageErrors,
    workerErrors,
    externalRequests,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
