import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
if (browserName !== 'chrome') throw new Error('Shared Workspace observer validation runs only in Chrome')

const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-workspace-observer-')))
const previewUrl = '/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none'
const apiRequests = []
const roleRequests = { owner: [], observer: [] }
const modelRequests = []
const commits = []
const revisionResponseMetrics = []
const httpErrors = []
const pageErrors = []
const externalRequests = []
const consoleErrors = []
let image
let app
let browser
let context
let ownerPage
let observerPage
let origin
let failOwnerCommits = false

function toolNames(request) {
  return (request.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter(Boolean).sort()
}

function toolCalls(session, turn) {
  return session.events.filter(event => event.type === 'tool/call' && event.data.turn === turn)
}

function toolResult(session, call) {
  return session.events.find(event => event.type === 'tool/result'
    && event.data.turn === call.data.turn
    && event.data.step === call.data.step
    && (event.data.message?.toolCallId === call.data.callId
      || event.data.message?.source?.callId === call.data.callId))
}

function assertSingleUserPrompt(session, prompt) {
  assert.equal(session.events.filter(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(prompt)).length, 1, `prompt must be recorded once: ${prompt}`)
}

async function workerRequest(page, body) {
  return await page.evaluate(async input => {
    const request = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof request !== 'function') throw new Error('Browser-Native Worker test port is unavailable')
    return await request(input)
  }, body)
}

async function workspaceIdentity(page) {
  return await page.evaluate(async () => await (await fetch('/api/browser-native/workspace/identity')).json())
}

async function workspaceManifest(page, workspaceId) {
  return await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
}

async function localSnapshot(page, workspaceId) {
  return await page.evaluate(async id => await new Promise((resolveRecord, reject) => {
    const opening = indexedDB.open('dsh-browser-native-workspace-v1', 1)
    opening.onerror = () => reject(opening.error ?? new Error('Workspace IndexedDB open failed'))
    opening.onsuccess = () => {
      const database = opening.result
      const transaction = database.transaction('workspace', 'readonly')
      const request = transaction.objectStore('workspace').get(id)
      request.onerror = () => reject(request.error ?? new Error('Workspace snapshot read failed'))
      request.onsuccess = () => resolveRecord(request.result ?? null)
      transaction.oncomplete = () => database.close()
    }
  }), workspaceId)
}

function revisionRequestCount(role) {
  return roleRequests[role].filter(item => item.path === '/api/browser-native/workspace/revision').length
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  ownerPage = await context.newPage()
  observerPage = await context.newPage()

  for (const [page, role] of [[ownerPage, 'owner'], [observerPage, 'observer']]) {
    page.on('pageerror', error => pageErrors.push({ role, message: error.message }))
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push({ role, message: message.text() })
    })
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin !== origin) externalRequests.push(request.url())
      if (!url.pathname.startsWith('/api/browser-native/')) return
      let body = {}
      try { body = request.postDataJSON() ?? {} } catch {}
      const item = { role, path: url.pathname, body, status: undefined, startedAt: performance.now() }
      apiRequests.push(item)
      roleRequests[role].push(item)
      if (url.pathname === '/api/browser-native/llm') modelRequests.push(item)
      if (url.pathname === '/api/browser-native/workspace/commit') commits.push(item)
    })
    page.on('response', response => {
      if (response.status() >= 400) {
        httpErrors.push({ role, path: new URL(response.url()).pathname, status: response.status() })
      }
      const request = apiRequests.findLast(item => item.role === role && item.path === new URL(response.url()).pathname
        && item.status === undefined)
      if (request !== undefined) {
        request.status = response.status()
        if (request.path === '/api/browser-native/workspace/revision') {
          request.elapsedMs = performance.now() - request.startedAt
          revisionResponseMetrics.push(response.body().then(bytes => {
            request.responseBytes = bytes.byteLength
          }))
        }
      }
    })
  }

  await openPreview(ownerPage, `${origin}${previewUrl}`)
  const ownerTurn = await sendTurn({
    page: ownerPage,
    origin,
    requests: roleRequests.owner,
    prompt: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_OWNER_E2E: create a committed owner file.',
    marker: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_OWNER_DONE',
    timeout: 60_000,
  })
  assertSingleUserPrompt(ownerTurn.session, 'BROWSER_NATIVE_WORKSPACE_OBSERVER_OWNER_E2E')
  const ownerIdentity = await workspaceIdentity(ownerPage)
  const ownerManifest = await workspaceManifest(ownerPage, ownerIdentity.workspaceId)
  assert.equal(ownerManifest.revision, 1)
  const ownerLease = await workerRequest(ownerPage, { action: 'lease-info' })
  assert.equal(ownerLease.ok, true)
  assert.equal(ownerLease.fencingToken, 1)

  await ownerPage.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    if (failOwnerCommits) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'E2E_COMMIT_PENDING', message: 'commit held for observer validation' } }),
      })
    } else {
      await route.continue()
    }
  })
  failOwnerCommits = true
  const pendingWrite = await workerRequest(ownerPage, {
    action: 'write',
    path: '/dsh/home/workspace/owner-pending.txt',
    content: 'must-not-be-observed-before-commit\n',
  })
  assert.equal(pendingWrite.ok, true)
  await waitFor(async () => {
    const snapshot = await localSnapshot(ownerPage, ownerIdentity.workspaceId)
    return snapshot?.pending?.some(change => change.path === 'owner-pending.txt')
      || snapshot?.retryBatch?.changes?.some(change => change.path === 'owner-pending.txt')
  }, 'owner pending Workspace snapshot')
  await waitFor(async () => commits.find(item => item.role === 'owner' && item.status === 503),
    'injected pending Workspace commit response')
  await waitFor(async () => {
    const snapshot = await localSnapshot(ownerPage, ownerIdentity.workspaceId)
    return snapshot?.retryBatch?.changes?.some(change => change.path === 'owner-pending.txt')
  }, 'owner retry batch after failed Workspace commit')
  const ownerRetrySnapshot = await localSnapshot(ownerPage, ownerIdentity.workspaceId)
  assert.ok(ownerRetrySnapshot.retryBatch?.changes.some(change => change.path === 'owner-pending.txt'))
  assert.equal((await workspaceManifest(ownerPage, ownerIdentity.workspaceId)).revision, 1)

  await observerPage.goto(`${origin}/api/browser-native/health`, { waitUntil: 'domcontentloaded' })
  await observerPage.evaluate(() => { localStorage.removeItem('dsh.sessions.current') })
  await openPreview(observerPage, `${origin}${previewUrl}`)
  const observerLeaseState = await workerRequest(observerPage, { action: 'lease-info' })
  assert.equal(observerLeaseState.accessMode, 'observer', JSON.stringify(observerLeaseState))
  assert.equal(await observerPage.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state), 'read-only')
  const observerIdentity = await workspaceIdentity(observerPage)
  assert.equal(observerIdentity.workspaceId, ownerIdentity.workspaceId)
  const committedRead = await workerRequest(observerPage, {
    action: 'read', path: '/dsh/home/workspace/owner-committed.txt',
  })
  assert.deepEqual({ ok: committedRead.ok, path: committedRead.path, content: committedRead.content }, {
    ok: true,
    path: '/dsh/home/workspace/owner-committed.txt',
    content: 'owner-committed-value\n',
  })
  const pendingNotHydrated = await workerRequest(observerPage, {
    action: 'read', path: '/dsh/home/workspace/owner-pending.txt',
  })
  assert.equal(pendingNotHydrated.ok, false)
  assert.match(pendingNotHydrated.error, /ENOENT|not found/i)
  const observerSharedSnapshot = await localSnapshot(observerPage, ownerIdentity.workspaceId)
  assert.deepEqual(observerSharedSnapshot, ownerRetrySnapshot,
    'the observer must not change the writer pending snapshot in shared IndexedDB')
  assert.ok(observerSharedSnapshot.retryBatch?.changes.some(change => change.path === 'owner-pending.txt'),
  'the writer pending Workspace mutation remains available for retry')

  const revisionChecksBeforeRead = revisionRequestCount('observer')
  const readTurn = await sendTurn({
    page: observerPage,
    origin,
    requests: roleRequests.observer,
    prompt: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_READ_E2E: read the committed owner file.',
    marker: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_READ_DONE',
    timeout: 60_000,
  })
  assert.notEqual(ownerTurn.sessionId, readTurn.sessionId)
  assertSingleUserPrompt(readTurn.session, 'BROWSER_NATIVE_WORKSPACE_OBSERVER_READ_E2E')
  assert.equal(revisionRequestCount('observer') - revisionChecksBeforeRead, 2)
  const readCall = toolCalls(readTurn.session, readTurn.turn).find(call => call.data.name === 'read')
  assert.ok(readCall)
  assert.equal(toolResult(readTurn.session, readCall)?.data.message?.isError, false)
  assert.equal(readTurn.session.events.some(event => event.type === 'browser-native/workspace-receipt'), false)
  const readModelRequest = modelRequests.find(item => item.role === 'observer'
    && JSON.stringify(item.body.messages).includes('BROWSER_NATIVE_WORKSPACE_OBSERVER_READ_E2E'))
  assert.ok(readModelRequest)
  assert.deepEqual(
    toolNames(readModelRequest.body).filter(name => ['bash', 'edit', 'glob', 'grep', 'read', 'write'].includes(name)),
    ['glob', 'grep', 'read'],
  )

  const commitsBeforeForgedWrite = commits.length
  const forgedWriteTurn = await sendTurn({
    page: observerPage,
    origin,
    requests: roleRequests.observer,
    prompt: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_FORGED_WRITE_E2E: attempt a model call for a hidden write tool.',
    timeout: 60_000,
  })
  assert.equal(forgedWriteTurn.sessionId, readTurn.sessionId)
  assertSingleUserPrompt(forgedWriteTurn.session, 'BROWSER_NATIVE_WORKSPACE_OBSERVER_FORGED_WRITE_E2E')
  const forgedWriteCall = toolCalls(forgedWriteTurn.session, forgedWriteTurn.turn).find(call => call.data.name === 'write')
  assert.ok(forgedWriteCall, 'the model response attempts the hidden write tool')
  const forgedWriteResult = toolResult(forgedWriteTurn.session, forgedWriteCall)
  assert.equal(forgedWriteResult?.data.message?.isError, true)
  assert.match(JSON.stringify(forgedWriteResult?.data.message?.content), /capability is not currently published|observer cannot execute/i,
    JSON.stringify(forgedWriteResult?.data.message))
  assert.equal(commits.length, commitsBeforeForgedWrite)
  assert.equal((await workspaceManifest(observerPage, ownerIdentity.workspaceId)).revision, 1)
  assert.deepEqual(await localSnapshot(observerPage, ownerIdentity.workspaceId), ownerRetrySnapshot,
    'the rejected forged write must leave the writer pending snapshot unchanged')
  const forgedFile = await workerRequest(observerPage, {
    action: 'read', path: '/dsh/home/workspace/observer-forged-write.txt',
  })
  assert.equal(forgedFile.ok, false)
  assert.equal(forgedWriteTurn.session.events.some(event => event.type === 'browser-native/workspace-receipt'), false)

  assert.deepEqual(await workerRequest(observerPage, { action: 'set-file-tool-delay', delayMs: 5_000 })
    .then(result => ({ ok: result?.ok, delayMs: result?.delayMs })), { ok: true, delayMs: 5_000 })
  const revisionChecksBeforeStaleRead = revisionRequestCount('observer')
  const staleTurnPromise = sendTurn({
    page: observerPage,
    origin,
    requests: roleRequests.observer,
    prompt: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_REVISION_RACE_E2E: read while the owner commits a new revision.',
    timeout: 60_000,
  })
  await waitFor(() => {
    const request = roleRequests.observer.filter(item => item.path === '/api/browser-native/workspace/revision')
      .at(-1)
    return request?.status === 200 && revisionRequestCount('observer') === revisionChecksBeforeStaleRead + 1
  }, 'observer pre-read revision check')
  failOwnerCommits = false
  await workerRequest(ownerPage, { action: 'flush-workspace' })
  await waitFor(async () => (await workspaceManifest(ownerPage, ownerIdentity.workspaceId)).revision === 2,
    'owner pending mutation commit during observer read')
  const commitsAfterOwnerUpdate = commits.length
  assert.equal((await workspaceManifest(observerPage, ownerIdentity.workspaceId)).revision, 2)
  const staleTurn = await staleTurnPromise
  assert.equal(staleTurn.sessionId, readTurn.sessionId)
  assertSingleUserPrompt(staleTurn.session, 'BROWSER_NATIVE_WORKSPACE_OBSERVER_REVISION_RACE_E2E')
  assert.equal(commits.length, commitsAfterOwnerUpdate)
  assert.equal(revisionRequestCount('observer') - revisionChecksBeforeStaleRead, 2)
  const staleCall = toolCalls(staleTurn.session, staleTurn.turn).find(call => call.data.name === 'read')
  assert.ok(staleCall)
  const staleResult = toolResult(staleTurn.session, staleCall)
  assert.ok(assistantText(staleTurn.session, staleTurn.turn).includes('BROWSER_NATIVE_WORKSPACE_OBSERVER_REVISION_RACE_REJECTED'),
    JSON.stringify({ assistant: assistantText(staleTurn.session, staleTurn.turn), staleResult }))
  assert.equal(staleResult?.data.message?.isError, true)
  assert.match(JSON.stringify(staleResult?.data.message?.content), /stale/i)
  assert.equal(JSON.stringify(staleResult?.data.message?.content).includes('owner-committed-value'), false)
  const raceModelRequests = modelRequests.filter(item => item.role === 'observer'
    && JSON.stringify(item.body.messages).includes('BROWSER_NATIVE_WORKSPACE_OBSERVER_REVISION_RACE_E2E'))
  assert.equal(raceModelRequests.some(item => {
    const markerIndex = item.body.messages.findLastIndex(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes('BROWSER_NATIVE_WORKSPACE_OBSERVER_REVISION_RACE_E2E'))
    return JSON.stringify(item.body.messages.slice(markerIndex + 1)).includes('owner-committed-value')
  }), false)
  await observerPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'stale',
    undefined, { timeout: 15_000 })
  await waitFor(async () => {
    const request = modelRequests.findLast(item => item.role === 'observer'
      && JSON.stringify(item.body.messages).includes('BROWSER_NATIVE_WORKSPACE_OBSERVER_REVISION_RACE_E2E'))
    return request !== undefined && !toolNames(request.body).includes('read')
  }, 'observer stale capability withdrawal')
  const observerLease = await workerRequest(observerPage, { action: 'lease-info' })
  assert.equal(observerLease.ok, false)

  const released = await workerRequest(ownerPage, { action: 'release-lease' })
  assert.equal(released.ok, true)
  await observerPage.locator('[data-browser-native-workspace-refresh]').click()
  await observerPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced',
    undefined, { timeout: 30_000 })
  const refreshedLease = await workerRequest(observerPage, { action: 'lease-info' })
  assert.equal(refreshedLease.ok, true)
  assert.equal(refreshedLease.fencingToken, 2)
  const staleRenew = await observerPage.evaluate(async ({ id, lease }) => {
    const response = await fetch('/api/browser-native/workspace/lease', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        workspaceId: id,
        operation: 'renew',
        writerToken: lease.writerToken,
        fencingToken: lease.fencingToken,
      }),
    })
    return { status: response.status, body: await response.json() }
  }, { id: ownerIdentity.workspaceId, lease: ownerLease })
  assert.equal(staleRenew.status, 409)
  assert.equal(staleRenew.body.error.code, 'WORKSPACE_OWNERSHIP_LOST')
  const refreshedOwnerTurn = await sendTurn({
    page: observerPage,
    origin,
    requests: roleRequests.observer,
    prompt: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_AFTER_REFRESH_E2E: save a file after explicit refresh.',
    marker: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_AFTER_REFRESH_DONE',
    timeout: 60_000,
  })
  assert.equal(refreshedOwnerTurn.sessionId, readTurn.sessionId)
  assertSingleUserPrompt(refreshedOwnerTurn.session, 'BROWSER_NATIVE_WORKSPACE_OBSERVER_AFTER_REFRESH_E2E')
  assert.equal((await workspaceManifest(observerPage, ownerIdentity.workspaceId)).revision, 3)
  const ownerReceipts = ownerTurn.session.events.filter(event => event.type === 'browser-native/workspace-receipt')
  const observerReadReceipts = readTurn.session.events.filter(event => event.type === 'browser-native/workspace-receipt')
  const observerStaleReceipts = staleTurn.session.events.filter(event => event.type === 'browser-native/workspace-receipt')
  const observerWriterReceipts = refreshedOwnerTurn.session.events.filter(event => event.type === 'browser-native/workspace-receipt')
  assert.equal(ownerReceipts.length, 1)
  assert.deepEqual(observerReadReceipts, [])
  assert.deepEqual(observerStaleReceipts, [])
  assert.equal(observerWriterReceipts.length, 1)
  assert.equal(observerWriterReceipts[0].data.toolName, 'write')
  assert.equal(ownerReceipts[0].data.callId === observerWriterReceipts[0].data.callId, false)
  assert.equal(commits.filter(item => item.status === 200).length, 3)
  const successfulOperationIds = commits.filter(item => item.status === 200).map(item => item.body.operationId)
  assert.equal(new Set(successfulOperationIds).size, 3)
  const failedCommit = commits.find(item => item.status === 503)
  assert.ok(failedCommit)
  assert.equal(successfulOperationIds.filter(operationId => operationId === failedCommit.body.operationId).length, 1)

  const readOnlyRefreshButton = await observerPage.locator('[data-browser-native-workspace-refresh]').count()
  assert.equal(readOnlyRefreshButton, 0)
  assert.ok(httpErrors.every(error => error.status === 404
    && ['/open-in-app/apps', '/api/changes.summary', '/api/present.host'].includes(error.path)
    || error.status === 503 && error.path === '/api/browser-native/workspace/commit'
    || error.status === 409 && error.path === '/api/browser-native/workspace/lease'),
  `unexpected HTTP errors: ${JSON.stringify(httpErrors)}`)
  assert.equal(httpErrors.filter(error => error.status === 503).length, 1)
  assert.equal(httpErrors.filter(error => error.status === 409).length, 2)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])
  await Promise.all(revisionResponseMetrics)

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browserName,
    scope: 'two-session-shared-workspace-observer-stale-refresh-and-fencing',
    workspaceId: ownerIdentity.workspaceId,
    sessionIds: [ownerTurn.sessionId, readTurn.sessionId],
    ownerFirstRevision: ownerManifest.revision,
    sharedPendingSnapshotIgnored: true,
    observerReadTools: toolNames(readModelRequest.body),
    staleReadRejected: staleResult?.data.message?.isError === true,
    observerReadRevisionChecks: revisionRequestCount('observer'),
    revisionResponses: apiRequests.filter(item => item.path === '/api/browser-native/workspace/revision')
      .map(({ role, status, responseBytes, elapsedMs }) => ({ role, status, responseBytes, elapsedMs })),
    observerWriterFencingToken: refreshedLease.fencingToken,
    finalWorkspaceRevision: 3,
    sessionReceiptCounts: [ownerReceipts.length, observerReadReceipts.length,
      forgedWriteTurn.session.events.filter(event => event.type === 'browser-native/workspace-receipt').length,
      observerStaleReceipts.length, observerWriterReceipts.length],
    llmRequestCount: modelRequests.length,
    externalRequestCount: externalRequests.length,
    httpErrors,
    pageErrors,
    consoleErrors,
    finalAssistantText: assistantText(refreshedOwnerTurn.session, refreshedOwnerTurn.turn),
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    workspaceStatus: await observerPage?.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__ ?? null).catch(() => null),
    requestSummary: apiRequests.map(({ role, path, status }) => ({ role, path, status })),
    httpErrors,
    pageErrors,
    externalRequests,
  })}\n`)
  throw error
} finally {
  await observerPage?.close().catch(() => {})
  await ownerPage?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
