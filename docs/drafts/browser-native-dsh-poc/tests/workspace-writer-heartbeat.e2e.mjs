import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { WorkspaceError } from '../workspace-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-lease-heartbeat-')))
const prompt = 'BROWSER_NATIVE_INTERACTION_TOOLS_E2E: ask before changing directory, then write a relative file.'
const targetDirectory = '/dsh/home/workspace/interaction-dir'
const leaseDurationMs = 20_000
let image
let app
let browser
let context
let page
let competitor
let sessionId
const requests = []
const renewResponses = []
const pageErrors = []
const externalRequests = []
let allowRenewFailure = false
let injectedRenewFailure = false

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: { workspaceWriterLeaseMs: leaseDurationMs },
  })
  const lease = app.workspaces.lease.bind(app.workspaces)
  app.workspaces.lease = async (request, body) => {
    if (body.operation !== 'renew') return await lease(request, body)
    if (allowRenewFailure && !injectedRenewFailure) {
      injectedRenewFailure = true
      allowRenewFailure = false
      renewResponses.push({ status: 503, requestId: body.requestId, at: Date.now() })
      throw new WorkspaceError('E2E_RENEW_TEMPORARY', 'injected one-time renewal outage', 503)
    }
    const renewed = await lease(request, body)
    renewResponses.push({ status: 200, requestId: body.requestId, at: Date.now() })
    return renewed
  }
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  competitor = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({ path: url.pathname, body })
  })
  await openPreview(page,
    `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const seeded = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'mkdir', path }), targetDirectory)
  assert.equal(seeded?.ok, true, JSON.stringify(seeded))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })

  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(prompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const createRequest = await waitFor(
    () => requests.find(request => request.path.endsWith('/session/create')),
    'Session creation for a long-running user question',
  )
  sessionId = createRequest.body.sessionId
  const call = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    return session.events?.find(event => event.type === 'tool/call' && event.data.name === 'ask_user_question')
  }, 'logged ask_user_question call', 30_000)
  const question = page.locator('[data-question-key]')
  await question.waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByText('May I continue with the file operation?', { exact: true }).waitFor()
  const questionOpenedAt = Date.now()
  allowRenewFailure = true
  const timerProbe = await Promise.race([
    page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-timer-probe' })),
    new Promise(resolveTimeout => setTimeout(() => resolveTimeout({ timeout: true }), 2_000)),
  ])
  const leaseState = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
  assert.equal(timerProbe?.ok, true, JSON.stringify(timerProbe))
  assert.equal(leaseState?.state, 'active', JSON.stringify(leaseState))
  assert.equal(leaseState?.renewalScheduled, true, JSON.stringify(leaseState))
  process.stdout.write(`${JSON.stringify({
    timerProbe,
    leaseState: {
      state: leaseState.state,
      renewalScheduled: leaseState.renewalScheduled,
      renewalPending: leaseState.renewalPending,
      renewAfterMs: leaseState.renewAfterMs,
      deadlineRemainingMs: leaseState.deadlineRemainingMs,
    },
  })}\n`)
  await waitFor(() => {
    const successfulRenewals = renewResponses.filter(response => response.status === 200 && response.at >= questionOpenedAt)
    return Date.now() - questionOpenedAt >= leaseDurationMs * 2 + 1_000 && successfulRenewals.length >= 5
      ? successfulRenewals
      : undefined
  }, 'lease renewals over two full TTLs during the pending question', 60_000)
  assert.equal(renewResponses.some(response => response.status === 503 && response.at >= questionOpenedAt), true,
    JSON.stringify(renewResponses))
  assert.equal(injectedRenewFailure, true)

  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')
  await competitor.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' })
  const competingClaim = await competitor.evaluate(async id => {
    const response = await fetch('/api/browser-native/workspace/lease', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), workspaceId: id, operation: 'claim' }),
    })
    return { status: response.status, body: await response.json() }
  }, workspaceId)
  assert.equal(competingClaim.status, 409, JSON.stringify(competingClaim))
  assert.equal(competingClaim.body.error.code, 'WORKSPACE_ALREADY_OWNED')

  const yes = question.getByRole('radio', { name: 'Yes' })
  await yes.click()
  await yes.press('Enter')
  const completed = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const terminal = session.events?.findLast(event => event.type === 'turn/end')
    return terminal === undefined ? undefined : { session, terminal }
  }, 'same DSH turn completion after lease renewals', 60_000)
  const calls = completed.session.events.filter(event => event.type === 'tool/call'
    && event.data.turn === completed.terminal.data.turn)
  assert.deepEqual(calls.map(event => event.data.name), ['ask_user_question', 'working_directory', 'write'])
  assert.equal(calls[0].data.callId, call.data.callId)
  assert.equal(completed.terminal.data.reason.kind, 'completed')
  assert.match(assistantText(completed.session, completed.terminal.data.turn), /BROWSER_NATIVE_INTERACTION_TOOLS_DONE/)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 2, undefined, { timeout: 30_000 })
  const receipt = completed.session.events.find(event => event.type === 'browser-native/workspace-receipt'
    && event.data.callId === String(calls[2].data.callId))
  assert.ok(receipt, 'the file write must retain its Session and Workspace receipt association')
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors))
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'active-Worker-workspace-lease-heartbeat-during-HITL',
    sessionId,
    workspaceId,
    leaseDurationMs,
    renewResponses,
    competingClaimStatus: competingClaim.status,
    toolNames: calls.map(event => event.data.name),
    workspaceRevision: 2,
    receiptOperationId: receipt.data.operationId,
    pageErrors,
    externalRequests,
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    sessionId,
    renewResponses,
    pageText: page !== undefined && !page.isClosed() ? (await page.locator('body').innerText().catch(() => '')).slice(-2500) : undefined,
    pageErrors,
    externalRequests,
  })}\n`)
  throw error
} finally {
  await competitor?.close().catch(() => {})
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
