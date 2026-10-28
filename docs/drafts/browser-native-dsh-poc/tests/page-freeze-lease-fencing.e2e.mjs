import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { sendTurn, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-freeze-fencing-')))
const leaseMs = 1_200
let image
let app
let browser
let context
let ownerPage
let contenderPage
let cdp
const requests = []
const requestByObject = new WeakMap()
const pageErrors = []
const externalRequests = []
const llmRequests = []
const workspaceCommits = []

function bodyOf(request) {
  try { return request.postDataJSON() ?? {} } catch { return {} }
}

async function fetchFromPage(page, pathname, body) {
  return await page.evaluate(async ({ path, data }) => {
    const response = await fetch(path, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    })
    return { status: response.status, body: await response.json() }
  }, { path: pathname, data: { protocolVersion: 1, requestId: randomUUID(), ...body } })
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  await writeFile(join(image.distRoot, 'lifecycle-control.html'), '<!doctype html><meta charset="utf-8"><title>Lifecycle control</title>')
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    ownerLeaseMs: leaseMs,
    testHooks: { workspaceWriterLeaseMs: leaseMs },
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  context.on('page', page => {
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin !== origin) externalRequests.push(request.url())
      if (!url.pathname.startsWith('/api/browser-native/')) return
      const record = { path: url.pathname, method: request.method(), body: bodyOf(request), status: undefined }
      requests.push(record)
      if (url.pathname === '/api/browser-native/llm') llmRequests.push(record)
      if (url.pathname === '/api/browser-native/workspace/commit') workspaceCommits.push(record)
      requestByObject.set(request, record)
    })
    page.on('response', response => {
      const record = requestByObject.get(response.request())
      if (record !== undefined) record.status = response.status()
    })
  })

  ownerPage = await context.newPage()
  await ownerPage.goto(`${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`, { waitUntil: 'domcontentloaded' })
  await waitForPreview(ownerPage)
  await ownerPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const baseline = await sendTurn({
    page: ownerPage,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_PAGE_FREEZE_BASELINE',
    marker: 'BROWSER_NATIVE_PAGE_FREEZE_BASELINE',
    timeout: 60_000,
  })
  const workspaceLease = await ownerPage.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
  const workspaceId = await ownerPage.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  const sessionStateBefore = await ownerPage.evaluate(async sessionId => await (await fetch('/api/browser-native/session/read', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId, offset: 0 }),
  })).json(), baseline.sessionId)
  const manifestBefore = await ownerPage.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(workspaceLease?.ok, true)
  const sessionRenewalsBeforeFreeze = requests.filter(record => record.path.endsWith('/session/renew') && record.status === 200).length
  const workspaceRenewalsBeforeFreeze = requests.filter(record => record.path.endsWith('/workspace/lease')
    && record.body.operation === 'renew' && record.status === 200).length
  const llmRequestsBeforeFreeze = llmRequests.length
  const commitsBeforeFreeze = workspaceCommits.length

  contenderPage = await context.newPage()
  await contenderPage.goto(`${origin}/lifecycle-control.html`, { waitUntil: 'domcontentloaded' })
  cdp = await context.newCDPSession(ownerPage)
  await cdp.send('Page.enable')
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' })

  const heartbeat = await waitFor(() => {
    const sessionRenewals = requests.filter(record => record.path.endsWith('/session/renew') && record.status === 200).length
    const workspaceRenewals = requests.filter(record => record.path.endsWith('/workspace/lease')
      && record.body.operation === 'renew' && record.status === 200).length
    return sessionRenewals >= sessionRenewalsBeforeFreeze + 4
      && workspaceRenewals >= workspaceRenewalsBeforeFreeze + 4
      ? { sessionRenewals, workspaceRenewals }
      : undefined
  }, 'Dedicated Worker renewals during frozen page lifecycle', 8_000)
  const competingSessionClaim = await fetchFromPage(contenderPage, '/api/browser-native/session/open', {
    sessionId: baseline.sessionId,
    access: 'write',
  })
  const competingWorkspaceClaim = await fetchFromPage(contenderPage, '/api/browser-native/workspace/lease', {
    workspaceId,
    operation: 'claim',
  })
  assert.equal(competingSessionClaim.status, 409)
  assert.equal(competingSessionClaim.body.error.code, 'SESSION_ALREADY_OWNED')
  assert.equal(competingWorkspaceClaim.status, 409)
  assert.equal(competingWorkspaceClaim.body.error.code, 'WORKSPACE_ALREADY_OWNED')
  await cdp.send('Page.setWebLifecycleState', { state: 'active' })

  const restoredWorkspaceLease = await ownerPage.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
  assert.equal(restoredWorkspaceLease?.writerToken, workspaceLease.writerToken)
  assert.equal(restoredWorkspaceLease?.fencingToken, workspaceLease.fencingToken)

  const sessionStateAfter = await contenderPage.evaluate(async sessionId => await (await fetch('/api/browser-native/session/read', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId, offset: 0 }),
  })).json(), baseline.sessionId)
  const manifestAfter = await contenderPage.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(sessionStateAfter.nextSeq, sessionStateBefore.nextSeq)
  assert.equal(sessionStateAfter.ownerEpoch, sessionStateBefore.ownerEpoch)
  assert.equal(manifestAfter.revision, manifestBefore.revision)
  assert.equal(llmRequests.length, llmRequestsBeforeFreeze)
  assert.equal(workspaceCommits.length, commitsBeforeFreeze)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'CDP-page-freeze-with-Dedicated-Worker-lease-renewal',
    leaseMs,
    successfulRenewalsDuringFreeze: {
      session: heartbeat.sessionRenewals - sessionRenewalsBeforeFreeze,
      workspace: heartbeat.workspaceRenewals - workspaceRenewalsBeforeFreeze,
    },
    competingSessionClaimStatus: competingSessionClaim.status,
    competingWorkspaceClaimStatus: competingWorkspaceClaim.status,
    sessionEpochUnchanged: sessionStateAfter.ownerEpoch === sessionStateBefore.ownerEpoch,
    workspaceFencingTokenUnchanged: restoredWorkspaceLease?.fencingToken === workspaceLease.fencingToken,
    sessionSeqUnchanged: sessionStateAfter.nextSeq === sessionStateBefore.nextSeq,
    workspaceRevisionUnchanged: manifestAfter.revision === manifestBefore.revision,
    modelRequestsDuringFreeze: llmRequests.length - llmRequestsBeforeFreeze,
    workspaceCommitsDuringFreeze: workspaceCommits.length - commitsBeforeFreeze,
    note: 'Chrome kept the Dedicated Worker active while its document was frozen. This verifies that Worker heartbeats preserve both leases; it does not model natural tab discard or OS process termination.',
  })}\n`)
} finally {
  await cdp?.detach().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
