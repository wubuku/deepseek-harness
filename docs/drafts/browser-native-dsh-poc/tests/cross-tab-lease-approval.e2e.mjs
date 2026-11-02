import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sessionRequest, submitPrompt, sendTurn, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-cross-tab-lease-hitl-`))
const pages = []
const pageIndices = new WeakMap()
const apiRequests = []
const sessionRequests = []
const pageErrors = []
const workerErrors = []
const externalRequests = []
let image
let app
let browser
let context

function trackPage(page, origin) {
  if (pageIndices.has(page)) return pageIndices.get(page)
  const pageIndex = pages.push(page) - 1
  pageIndices.set(page, pageIndex)
  page.on('pageerror', error => pageErrors.push(`${String(pageIndex)}: ${error.message}`))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(`${String(pageIndex)}: ${error.message}`)))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (url.origin === origin && url.pathname.startsWith('/api/browser-native/')) {
      apiRequests.push({ page: pageIndex, path: url.pathname, method: request.method() })
      if (url.pathname.endsWith('/session/create') && request.method() === 'POST') {
        try { sessionRequests.push({ path: url.pathname, body: { sessionId: request.postDataJSON().sessionId } }) } catch {}
      }
    }
  })
  return pageIndex
}

async function openClone(opener, url, origin) {
  const popupPromise = opener.waitForEvent('popup')
  await opener.evaluate(value => window.open(value, '_blank'), url)
  const popup = await popupPromise
  trackPage(popup, origin)
  return popup
}

async function workspaceTest(page, request) {
  return await page.evaluate(async value => {
    const test = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof test !== 'function') throw new Error('Browser-Native test port is unavailable')
    return await test(value)
  }, request)
}

async function leaseInfo(page) {
  return await workspaceTest(page, { action: 'lease-info' })
}

async function approvalState(page, origin, sessionId) {
  return await sessionRequest(origin, 'read', { sessionId, offset: 0 })
}

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  context.on('page', page => trackPage(page, origin))
  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=approval-integrity&preview-fixture=none`
  const owner = await context.newPage()
  await openPreview(owner, previewUrl)
  await owner.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await owner.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const ownerLease = await leaseInfo(owner)
  assert.equal(ownerLease.ok, true, JSON.stringify(ownerLease))
  assert.equal(ownerLease.accessMode, 'writer', JSON.stringify(ownerLease))
  assert.equal(ownerLease.state, 'active', JSON.stringify(ownerLease))

  const boot = await sendTurn({
    page: owner,
    origin,
    requests: sessionRequests,
    prompt: 'BROWSER_NATIVE_PERMISSION_BOOT_E2E：只回复 PERMISSION_BOOT_OK，不调用工具。',
    timeout: 60_000,
  })
  const sessionId = boot.sessionId
  const approvalPrompt = 'BROWSER_NATIVE_PERMISSION_APPROVAL_E2E：请求一次需要审批的 Worker 文件操作。'
  await owner.locator('[data-composer-input][contenteditable="true"]').last().fill(approvalPrompt)
  await owner.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const asked = await waitFor(async () => {
    const session = await approvalState(owner, origin, sessionId)
    return session.events?.find(event => event.type === 'approval/asked')
  }, 'first approval request', 30_000)
  await owner.locator('[data-approval-key]').waitFor({ state: 'visible', timeout: 30_000 })

  const duplicate = await openClone(owner, previewUrl, origin)
  await duplicate.waitForFunction(() => ['recovery-conflict', 'recovery-unavailable', 'lease-conflict', 'error']
    .includes(window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state ?? ''), undefined, { timeout: 30_000 })
  const duplicateState = await duplicate.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state)
  assert.equal(duplicateState, 'recovery-conflict')
  const duplicatePage = pageIndices.get(duplicate)
  assert.equal(apiRequests.some(request => request.page === duplicatePage), false,
    'a concurrent tab must not reach the backend')
  assert.equal(await duplicate.locator('[data-approval-key]').count(), 0,
    'a concurrent tab must not project an actionable approval')
  const duplicateLease = await leaseInfo(duplicate)
  assert.equal(duplicateLease.ok, false, JSON.stringify(duplicateLease))
  assert.notEqual(duplicateLease.writerToken, ownerLease.writerToken,
    'the concurrent tab must not hold the writer lease')

  // The lease owner becomes the background tab; the foreground tab cannot settle.
  await duplicate.bringToFront()
  const backgroundLease = await leaseInfo(owner)
  assert.equal(backgroundLease.ok, true, JSON.stringify(backgroundLease))
  assert.equal(backgroundLease.writerToken, ownerLease.writerToken)
  assert.equal(backgroundLease.state, 'active', JSON.stringify(backgroundLease))
  assert.equal(backgroundLease.renewalScheduled, true, JSON.stringify(backgroundLease))

  await owner.locator('[data-approval-key]').getByRole('button', { name: 'Allow once' }).click()
  const firstSettled = await waitFor(async () => {
    const session = await approvalState(owner, origin, sessionId)
    const decided = session.events?.findLast(event => event.type === 'approval/decided')
    const result = session.events?.find(event => event.type === 'tool/result'
      && String(event.data.message.toolCallId) === String(asked.data.callId))
    return decided?.data.outcome === 'allowed-once' && result !== undefined ? session : undefined
  }, 'single settlement of the approved background-tab request', 30_000)
  assert.equal(firstSettled.events.filter(event => event.type === 'approval/asked').length, 1)
  assert.equal(firstSettled.events.filter(event => event.type === 'approval/decided').length, 1,
    'the approval must settle exactly once')
  const approvedResult = firstSettled.events.find(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === String(asked.data.callId))
  assert.equal(approvedResult.data.message.isError, false, JSON.stringify(approvedResult.data.message))
  const approvedFile = await waitFor(async () => {
    const file = await workspaceTest(owner, { action: 'read', path: '/dsh/home/workspace/approval-result.txt' })
    return file.ok === true ? file : undefined
  }, 'approved tool write to reach the Workspace VFS', 10_000)
  assert.match(approvedFile.content, /BROWSER_NATIVE_PERMISSION_APPROVAL_WRITE_OK/)
  const ownerWorkspace = await owner.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
  assert.equal(ownerWorkspace.state, 'synced', JSON.stringify(ownerWorkspace))
  assert.ok(ownerWorkspace.revision >= 1, JSON.stringify(ownerWorkspace))
  assert.equal(apiRequests.some(request => request.page === duplicatePage), false,
    'the foreground tab must stay outside the backend after settlement')
  assert.equal(await duplicate.locator('[data-approval-key]').count(), 0)
  const settledLease = await leaseInfo(owner)
  assert.equal(settledLease.ok, true, JSON.stringify(settledLease))
  assert.equal(settledLease.writerToken, ownerLease.writerToken)

  // Owner closes with a second approval pending; the surviving tab takes over.
  const recoveryPrompt = 'BROWSER_NATIVE_PERMISSION_APPROVAL_RECOVERY_E2E：等待审批期间切换标签，不要自动重试。'
  await owner.locator('[data-composer-input][contenteditable="true"]').last().fill(recoveryPrompt)
  await owner.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const pending = await waitFor(async () => {
    const session = await approvalState(owner, origin, sessionId)
    const call = session.events?.find(event => event.type === 'tool/call'
      && event.data.callId === 'browser-native-permission-approval-recovery-bash')
    const approval = session.events?.find(event => event.type === 'approval/asked'
      && event.data.callId === 'browser-native-permission-approval-recovery-bash')
    return call !== undefined && approval !== undefined ? { session, call, approval } : undefined
  }, 'pending approval before tab handoff', 30_000)
  await owner.locator('[data-approval-key]').waitFor({ state: 'visible', timeout: 30_000 })
  const duplicateRequestsBeforeTakeover = apiRequests.filter(request => request.page === duplicatePage).length
  assert.equal(duplicateRequestsBeforeTakeover, 0)
  const llmBeforeHandoff = apiRequests.filter(request => request.path.endsWith('/llm')).length
  const revisionBeforeHandoff = (await owner.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)).revision

  await owner.close()
  await duplicate.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(duplicate)
  await duplicate.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const takeoverLease = await waitFor(async () => {
    const lease = await leaseInfo(duplicate)
    return lease.ok === true && lease.accessMode === 'writer' ? lease : undefined
  }, 'writer lease takeover after owner close', 45_000)
  assert.notEqual(takeoverLease.writerToken, ownerLease.writerToken)
  assert.equal(takeoverLease.state, 'active', JSON.stringify(takeoverLease))
  const takeover = await waitFor(async () => {
    const session = await approvalState(duplicate, origin, sessionId)
    const result = session.events?.find(event => event.type === 'tool/result'
      && String(event.data.message.toolCallId) === 'browser-native-permission-approval-recovery-bash')
    return result !== undefined ? session : undefined
  }, 'handoff settlement of the interrupted approval', 45_000)
  const cutResult = takeover.events.find(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === 'browser-native-permission-approval-recovery-bash')
  assert.equal(cutResult.data.message.isError, true)
  assert.equal(cutResult.data.error?.code, 'TOOL_OUTCOME_UNKNOWN',
    'a pending approval must not be re-asked after tab handoff')
  assert.equal(await duplicate.locator('[data-approval-key]').count(), 0,
    'the recovered tab must not present the dead approval')
  assert.equal(takeover.events.filter(event => event.type === 'approval/asked').length, 2)
  assert.equal(takeover.events.filter(event => event.type === 'approval/decided').length, 1,
    'the interrupted approval must not be decided twice')
  assert.equal(apiRequests.filter(request => request.path.endsWith('/llm')).length, llmBeforeHandoff,
    'handoff must not produce another model request')
  assert.equal((await workspaceTest(duplicate, { action: 'read', path: '/dsh/home/workspace/approval-recovery-result.txt' })).ok, false,
    'the interrupted approval must not execute its tool')
  const takeoverWorkspace = await duplicate.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
  assert.equal(takeoverWorkspace.revision, revisionBeforeHandoff,
    'the interrupted approval must not mutate the Workspace')

  const continued = await submitPrompt({
    page: duplicate,
    origin,
    requests: sessionRequests,
    sessionId,
    prompt: 'BROWSER_NATIVE_CROSS_TAB_HITL_CONTINUE：只回复 CROSS_TAB_HITL_OK。',
    timeout: 60_000,
  })
  assert.equal(continued.session.events.filter(event => event.type === 'approval/asked').length, 2,
    'the recovered session must not re-ask the interrupted approval')
  assert.equal(continued.session.events.filter(event => event.type === 'approval/decided').length, 1)
  assert.equal(continued.session.events.some(event => event.type === 'tool/call'
    && event.data.callId === 'browser-native-permission-approval-recovery-bash'), true)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'cross-tab-writer-lease-and-HITL-approval-combination',
    sessionId,
    concurrentTabState: duplicateState,
    concurrentTabBackendRequests: duplicateRequestsBeforeTakeover,
    concurrentTabWriterLease: duplicateLease.ok,
    ownerLease: {
      fencingToken: ownerLease.fencingToken,
      accessMode: ownerLease.accessMode,
      state: ownerLease.state,
    },
    approvedWhileOwnerBackground: approvedResult.data.message.isError === false,
    approvalFileWritten: approvedFile.ok === true,
    workspaceRevisionAfterApproval: ownerWorkspace.revision,
    decisions: continued.session.events.filter(event => event.type === 'approval/decided').length,
    requests: continued.session.events.filter(event => event.type === 'approval/asked').length,
    interruptedOutcome: cutResult.data.error?.code,
    interruptedToolExecuted: false,
    takeoverLease: {
      fencingToken: takeoverLease.fencingToken,
      accessMode: takeoverLease.accessMode,
      state: takeoverLease.state,
    },
    recoveredPromptCompleted: true,
    note: 'Session ownership and the Workspace writer lease are independent guards: only the owner tab settles approvals, and only the lease holder may write. When both are enabled, a concurrent tab is rejected before backend access and holds no writer lease, the lease owner can approve a tool while in the background, and takeover after owner close acquires a new writer lease without replaying the interrupted approval.',
  })}\n`)
} finally {
  await Promise.all(pages.map(page => page.close().catch(() => {})))
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
