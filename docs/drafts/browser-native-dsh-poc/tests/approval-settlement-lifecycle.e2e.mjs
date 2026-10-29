import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest, submitPrompt, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-approval-settlement-')))
const requests = []
const pageErrors = []
const workerErrors = []
const externalRequests = []
let image
let app
let browser
let page
let origin

const llmRequestCount = () => requests.filter(request => request.path.endsWith('/llm')).length

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

async function readSession(sessionId) {
  return await sessionRequest(origin, 'read', { sessionId, offset: 0 })
}

async function waitForApprovalRequests(sessionId, count, description) {
  let latest
  try {
    return await waitFor(async () => {
      const session = await readSession(sessionId)
      latest = session
      const approvals = session.events.filter(event => event.type === 'approval/asked')
      return approvals.length >= count ? { session, approvals } : undefined
    }, description, 30_000)
  } catch (error) {
    const trace = latest?.events.map(event => ({
      type: event.type,
      ...(event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'approval/asked'
        || event.type === 'approval/decided' || event.type === 'turn/end'
        ? { data: event.data } : {}),
      ...(event.type === 'user/message' || event.type === 'assistant/message' ? { data: event.data } : {}),
    })) ?? []
    throw new Error(`${error instanceof Error ? error.message : String(error)}; sessionTrace=${JSON.stringify(trace)}`)
  }
}

async function waitForApprovalCard(expectedCommand) {
  const card = page.locator('[data-approval-key]')
  await waitFor(async () => {
    if (await card.count() !== 1) return undefined
    const text = await card.innerText()
    return expectedCommand === undefined || text.includes(expectedCommand) ? text : undefined
  }, `approval card${expectedCommand === undefined ? '' : ` for ${expectedCommand}`}`, 30_000)
  return card
}

function toolCallFor(session, callId) {
  return session.events.find(event => event.type === 'tool/call' && String(event.data.callId) === String(callId))
}

function toolResultFor(session, callId) {
  return session.events.find(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === String(callId))
}

function decidedFor(session, requestId) {
  return session.events.filter(event => event.type === 'approval/decided'
    && String(event.data.id) === String(requestId))
}

function outputPath(call) {
  const args = JSON.parse(call.data.arguments)
  const match = typeof args.command === 'string' ? args.command.match(/ > ([^\s]+)$/) : undefined
  assert.ok(match, `Expected a deterministic workspace write command for ${String(call.data.callId)}`)
  return match[1]
}

async function assertFile(path, expectedContent) {
  const result = await testAction({ action: 'read', path })
  assert.equal(result?.ok, true, JSON.stringify(result))
  if (expectedContent !== undefined) assert.equal(result.content, expectedContent)
}

async function assertNoFile(path) {
  assert.equal((await testAction({ action: 'read', path })).ok, false)
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
  const boot = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'Start the Browser-Native session and confirm the available workspace briefly.',
  })
  const sessionId = boot.sessionId

  const allowPrompt = 'BROWSER_NATIVE_APPROVAL_ALLOW_ONCE_E2E'
  const allowLlmBefore = llmRequestCount()
  let allowRequest
  const allowed = await submitPrompt({
    page,
    origin,
    requests,
    sessionId,
    prompt: allowPrompt,
    probeWhileRunning: async ({ sessionId: currentSessionId }) => {
      const observed = await waitForApprovalRequests(currentSessionId,
        1, 'allow-once request')
      allowRequest = observed.approvals.at(-1)
      assert.equal(String(allowRequest.data.callId), 'browser-native-approval-allow-once')
      const card = await waitForApprovalCard('ALLOW_ONCE')
      await card.getByRole('button', { name: 'Allow once' }).click()
    },
  })
  const allowCall = toolCallFor(allowed.session, allowRequest.data.callId)
  const allowResult = toolResultFor(allowed.session, allowRequest.data.callId)
  assert.ok(allowCall)
  assert.ok(allowResult)
  assert.equal(allowResult.data.message.isError, false)
  assert.equal(decidedFor(allowed.session, allowRequest.data.id).length, 1)
  assert.equal(decidedFor(allowed.session, allowRequest.data.id)[0]?.data.outcome, 'allowed-once')
  assert.equal(allowed.session.events.filter(event => event.type === 'tool/call'
    && String(event.data.callId) === String(allowRequest.data.callId)).length, 1)
  assert.equal(allowed.session.events.filter(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === String(allowRequest.data.callId)).length, 1)
  const allowLlmCount = llmRequestCount() - allowLlmBefore
  assert.equal(allowLlmCount, 2)
  await assertFile('/dsh/home/workspace/approval-allow-once-result.txt', 'APPROVAL_ALLOW_ONCE_WRITE_OK\n')
  assert.equal(assistantText(allowed.session, allowed.turn).includes('BROWSER_NATIVE_APPROVAL_ALLOW_ONCE_E2E_SETTLED'), true)

  const queuePrompt = 'BROWSER_NATIVE_APPROVAL_QUEUE_E2E'
  const queueLlmBefore = llmRequestCount()
  let queueRequests = []
  const queued = await submitPrompt({
    page,
    origin,
    requests,
    sessionId,
    prompt: queuePrompt,
    probeWhileRunning: async ({ sessionId: currentSessionId }) => {
      const firstObserved = await waitForApprovalRequests(currentSessionId,
        2, 'first exclusive approval request')
      queueRequests = [firstObserved.approvals.at(-1)]
      assert.equal(String(queueRequests[0].data.callId), 'browser-native-approval-queue-first')
      const firstCard = await waitForApprovalCard('APPROVAL_QUEUE_FIRST_OK')
      assert.equal(await page.locator('[data-approval-key]').count(), 1)
      await firstCard.getByRole('button', { name: 'Allow once' }).click()
      const secondObserved = await waitForApprovalRequests(currentSessionId,
        3, 'second approval after first settles')
      queueRequests = [...queueRequests, secondObserved.approvals.at(-1)]
      assert.equal(String(queueRequests[1].data.callId), 'browser-native-approval-queue-second')
      const secondCard = await waitForApprovalCard('APPROVAL_QUEUE_SECOND_OK')
      assert.equal(await page.locator('[data-approval-key]').count(), 1)
      await secondCard.getByRole('button', { name: 'Reject' }).click()
    },
  })
  assert.equal(queueRequests[0].data.reason.includes('FIFO_FIRST: approve this first queued operation.'), true)
  assert.equal(queueRequests[1].data.reason.includes('FIFO_SECOND: reject this second queued operation.'), true)
  const queueOutcomes = queueRequests.map(request => ({
    request,
    decision: decidedFor(queued.session, request.data.id),
    call: toolCallFor(queued.session, request.data.callId),
    result: toolResultFor(queued.session, request.data.callId),
  }))
  assert.deepEqual(queueOutcomes.map(item => item.decision.map(event => event.data.outcome)), [
    ['allowed-once'],
    ['rejected'],
  ])
  assert.ok(queueOutcomes.every(item => item.call !== undefined && item.result !== undefined))
  assert.equal(queueOutcomes[0].result.data.message.isError, false)
  assert.equal(queueOutcomes[1].result.data.message.isError, true)
  assert.equal(llmRequestCount() - queueLlmBefore, 2)
  await assertFile(outputPath(queueOutcomes[0].call), 'APPROVAL_QUEUE_FIRST_OK\n')
  await assertNoFile(outputPath(queueOutcomes[1].call))
  assert.equal(assistantText(queued.session, queued.turn).includes('BROWSER_NATIVE_APPROVAL_QUEUE_E2E_SETTLED_WITH_ERROR'), true)

  const cancelPrompt = 'BROWSER_NATIVE_APPROVAL_CANCEL_E2E'
  const cancelLlmBefore = llmRequestCount()
  let cancelRequest
  const cancelled = await submitPrompt({
    page,
    origin,
    requests,
    sessionId,
    prompt: cancelPrompt,
    expectedReason: 'aborted',
    probeWhileRunning: async ({ sessionId: currentSessionId }) => {
      const observed = await waitForApprovalRequests(currentSessionId,
        4, 'approval request before Worker cancellation')
      cancelRequest = observed.approvals.at(-1)
      assert.equal(String(cancelRequest.data.callId), 'browser-native-approval-cancel')
      await waitForApprovalCard('APPROVAL_CANCEL_MUST_NOT_WRITE')
      const result = await testAction({ action: 'cancel-session', sessionId: currentSessionId })
      assert.equal(result?.ok, true, JSON.stringify(result))
    },
  })
  const cancelCall = toolCallFor(cancelled.session, cancelRequest.data.callId)
  const cancelResult = toolResultFor(cancelled.session, cancelRequest.data.callId)
  assert.ok(cancelCall)
  assert.ok(cancelResult)
  assert.equal(cancelResult.data.message.isError, true)
  assert.equal(decidedFor(cancelled.session, cancelRequest.data.id).length, 1)
  assert.equal(decidedFor(cancelled.session, cancelRequest.data.id)[0]?.data.outcome, 'cancelled')
  assert.equal(llmRequestCount() - cancelLlmBefore, 1)
  await assertNoFile('/dsh/home/workspace/approval-cancel-result.txt')
  assert.equal(await page.locator('[data-approval-key]').count(), 0)

  const followupLlmBefore = llmRequestCount()
  const followup = await sendTurn({
    page,
    origin,
    requests,
    sessionId,
    prompt: 'BROWSER_NATIVE_APPROVAL_AFTER_CANCEL_E2E',
    marker: 'BROWSER_NATIVE_APPROVAL_AFTER_CANCEL_E2E',
  })
  assert.equal(llmRequestCount() - followupLlmBefore, 1)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'Browser-Worker-approval-allow-once-serial-FIFO-and-Agent-cancel',
    sessionId,
    allowOnce: {
      requestId: String(allowRequest.data.id),
      callId: String(allowRequest.data.callId),
      outcome: decidedFor(allowed.session, allowRequest.data.id)[0]?.data.outcome,
      llmRequests: allowLlmCount,
    },
    fifo: queueRequests.map(request => ({
      requestId: String(request.data.id),
      callId: String(request.data.callId),
      reason: request.data.reason,
      outcome: decidedFor(queued.session, request.data.id)[0]?.data.outcome,
    })),
    cancelled: {
      requestId: String(cancelRequest.data.id),
      callId: String(cancelRequest.data.callId),
      outcome: decidedFor(cancelled.session, cancelRequest.data.id)[0]?.data.outcome,
      turnReason: cancelled.session.events.findLast(event => event.type === 'turn/end'
        && event.data.turn === cancelCall.data.turn)?.data.reason.kind,
    },
    llmRequestCount: llmRequestCount(),
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
