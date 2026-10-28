import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
if (browserName !== 'chrome') throw new Error('Workspace lease edit race validation runs only in Chrome')

const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-workspace-lease-edit-')))
const workspacePath = '/dsh/home/workspace/lease-edit-race.txt'
const previewUrl = '/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none'
const roleRequests = { owner: [], successor: [] }
const modelRequests = []
const commits = []
const externalRequests = []
const pageErrors = []
const httpErrors = []
let image
let app
let browser
let context
let ownerPage
let successorPage
let origin
let oldTurnPromise
let successorLeaseObserved
let successorSessionId

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

async function remoteFileText(page, workspaceId, manifest) {
  const entry = manifest.entries.find(candidate => candidate.path === 'lease-edit-race.txt')
  assert.ok(entry, 'the committed manifest must contain the edited file')
  return await page.evaluate(async ({ id, hash }) => await (await fetch(
    `/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).text(), { id: workspaceId, hash: entry.hash })
}

function toolCallFor(session, turn, name) {
  return session.events.find(event => event.type === 'tool/call' && event.data.turn === turn && event.data.name === name)
}

function toolResultFor(session, callId) {
  return session.events.find(event => event.type === 'tool/result'
    && (event.data.message?.toolCallId ?? event.data.toolCallId ?? event.data.callId) === callId)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  ownerPage = await context.newPage()
  successorPage = await context.newPage()

  for (const [page, role] of [[ownerPage, 'owner'], [successorPage, 'successor']]) {
    page.on('pageerror', error => pageErrors.push({ role, message: error.message }))
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin !== origin) externalRequests.push(request.url())
      if (!url.pathname.startsWith('/api/browser-native/')) return
      let body = {}
      try { body = request.postDataJSON() ?? {} } catch {}
      const item = { role, path: url.pathname, body, status: undefined }
      roleRequests[role].push(item)
      if (url.pathname === '/api/browser-native/llm') modelRequests.push(item)
      if (url.pathname === '/api/browser-native/workspace/commit') commits.push(item)
    })
    page.on('response', response => {
      if (response.status() >= 400) {
        httpErrors.push({ role, path: new URL(response.url()).pathname, status: response.status() })
      }
      const request = roleRequests[role].findLast(item => item.path === new URL(response.url()).pathname
        && item.status === undefined)
      if (request !== undefined) request.status = response.status()
    })
  }

  await openPreview(ownerPage, `${origin}${previewUrl}`)
  await ownerPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced',
    undefined, { timeout: 30_000 })
  const identity = await workspaceIdentity(ownerPage)
  const seeded = await workerRequest(ownerPage, {
    action: 'write-pattern',
    path: workspacePath,
    byteLength: 32 * 1024 * 1024,
    byteValue: 120,
    lineBytes: 8192,
    markerLine: 2048,
    marker: 'BROWSER_NATIVE_LEASE_EDIT_OLD',
  })
  assert.equal(seeded.ok, true, JSON.stringify(seeded))
  const markerBytes = await workerRequest(ownerPage, {
    action: 'read-range', path: workspacePath, offset: 2047 * 8192, length: 30,
  })
  assert.equal(markerBytes.ok, true, JSON.stringify(markerBytes))
  assert.equal(Buffer.from(markerBytes.base64, 'base64').toString('utf8'), 'BROWSER_NATIVE_LEASE_EDIT_OLD\n')
  const seedCommit = await workerRequest(ownerPage, { action: 'flush-workspace' })
  assert.equal(seedCommit.ok, true, JSON.stringify(seedCommit))
  await ownerPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 60_000 })
  assert.equal((await workspaceManifest(ownerPage, identity.workspaceId)).revision, 1)

  await successorPage.goto(`${origin}/api/browser-native/health`, { waitUntil: 'domcontentloaded' })
  await successorPage.evaluate(() => { localStorage.removeItem('dsh.sessions.current') })
  const delay = await workerRequest(ownerPage, { action: 'set-file-tool-delay', delayMs: 500 })
  assert.deepEqual({ ok: delay.ok, delayMs: delay.delayMs }, { ok: true, delayMs: 500 })
  const editStagePromise = workerRequest(ownerPage, {
    action: 'wait-file-tool-stage', toolStage: 'copy-prefix', timeoutMs: 45_000,
  })
  let signalSessionId
  const sessionIdReady = new Promise(resolveSession => { signalSessionId = resolveSession })
  oldTurnPromise = sendTurn({
    page: ownerPage,
    origin,
    requests: roleRequests.owner,
    prompt: 'BROWSER_NATIVE_WORKSPACE_LEASE_EDIT_RACE_E2E: replace the marker in the large file.',
    marker: 'BROWSER_NATIVE_WORKSPACE_LEASE_EDIT_FENCED',
    timeout: 120_000,
    probeWhileRunning: async ({ sessionId }) => {
      signalSessionId(sessionId)
      await editStagePromise
      const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
      const editCall = session.events.find(event => event.type === 'tool/call' && event.data.name === 'edit')
      signalSessionId({ sessionId, editCall, session })
    },
  }).catch(error => {
    return { turnError: error }
  })
  const sessionId = await sessionIdReady
  const editStage = await editStagePromise
  if (editStage.ok !== true) {
    const latestSession = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    throw new Error(`edit stage was not observed: ${JSON.stringify({ stage: editStage, toolCalls: latestSession.events
      .filter(event => event.type === 'tool/call').map(event => event.data.name),
    toolResults: latestSession.events.filter(event => event.type === 'tool/result').map(event => ({
      error: event.data.message?.isError,
      content: JSON.stringify(event.data.message?.content).slice(0, 800),
    })),
    tools: modelRequests.map(item => item.body.tools?.map(tool => tool.function?.name ?? tool.name)),
    requests: roleRequests.owner.map(item => ({ path: item.path, status: item.status })) })}`)
  }
  const stagedSession = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
  const editCall = stagedSession.events.find(event => event.type === 'tool/call' && event.data.name === 'edit')
  assert.ok(editCall, 'the DSH edit call must be recorded before the OPFS copy stage')
  assert.ok(stagedSession.durableThroughSeq >= Number(editCall.seq),
    'the DSH edit call must be durable before release')
  const previousLease = await workerRequest(ownerPage, { action: 'lease-info' })
  assert.equal(previousLease.ok, true)
  assert.equal(previousLease.fencingToken, 1)
  assert.equal((await workerRequest(ownerPage, { action: 'release-lease' })).ok, true)
  await openPreview(successorPage, `${origin}${previewUrl}`)
  await successorPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced',
    undefined, { timeout: 60_000 })
  const successorIdentity = await workspaceIdentity(successorPage)
  assert.equal(successorIdentity.workspaceId, identity.workspaceId)
  const successorLease = await workerRequest(successorPage, { action: 'lease-info' })
  successorLeaseObserved = successorLease
  assert.equal(successorLease.ok, true, JSON.stringify(successorLease))
  assert.equal(successorLease.fencingToken, 2)

  let oldTurnSettled = false
  void oldTurnPromise.then(() => { oldTurnSettled = true }, () => { oldTurnSettled = true })
  assert.equal(oldTurnSettled, false, 'the old edit must still be copying when the successor takes ownership')
  const successorTurn = await sendTurn({
    page: successorPage,
    origin,
    requests: roleRequests.successor,
    prompt: 'BROWSER_NATIVE_WORKSPACE_LEASE_SUCCESSOR_E2E: write the new owner value to the same path.',
    marker: 'BROWSER_NATIVE_WORKSPACE_LEASE_SUCCESSOR_DONE',
    timeout: 90_000,
  })
  successorSessionId = successorTurn.sessionId
  assert.equal(successorTurn.session.events.filter(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes('BROWSER_NATIVE_WORKSPACE_LEASE_SUCCESSOR_E2E')).length, 1)
  const manifestAfterSuccessor = await workspaceManifest(successorPage, identity.workspaceId)
  assert.equal(manifestAfterSuccessor.revision, 2)
  assert.equal(await remoteFileText(successorPage, identity.workspaceId, manifestAfterSuccessor), 'BROWSER_NATIVE_LEASE_EDIT_NEW_OWNER\n')
  assert.equal(oldTurnSettled, false, 'the old edit must remain in flight through the successor commit')

  const oldTurnOutcome = await oldTurnPromise
  if (oldTurnOutcome?.turnError !== undefined) throw oldTurnOutcome.turnError
  const oldTurn = oldTurnOutcome
  const oldEditCall = toolCallFor(oldTurn.session, oldTurn.turn, 'edit')
  assert.ok(oldEditCall)
  assert.deepEqual(JSON.parse(oldEditCall.data.arguments), {
    file_path: workspacePath,
    old_string: 'BROWSER_NATIVE_LEASE_EDIT_OLD',
    new_string: 'BROWSER_NATIVE_LEASE_EDIT_OLD_OWNER',
  })
  assert.equal(oldTurn.session.events.filter(event => event.type === 'tool/call'
    && event.data.turn === oldTurn.turn && event.data.name === 'edit').length, 1)
  const oldEditResult = toolResultFor(oldTurn.session, oldEditCall.data.callId)
  assert.equal(oldEditResult?.data.message?.isError, true, JSON.stringify(oldEditResult))
  assert.match(JSON.stringify(oldEditResult?.data.message?.content), /writer lease.*released/i)
  assert.equal(assistantText(oldTurn.session, oldTurn.turn), 'BROWSER_NATIVE_WORKSPACE_LEASE_EDIT_FENCED')
  assert.equal(oldTurn.session.events.filter(event => event.type === 'browser-native/workspace-receipt'
    && event.data.callId === oldEditCall.data.callId).length, 0)
  assert.equal((await workspaceManifest(ownerPage, identity.workspaceId)).revision, 2)
  assert.equal(await remoteFileText(ownerPage, identity.workspaceId, manifestAfterSuccessor), 'BROWSER_NATIVE_LEASE_EDIT_NEW_OWNER\n')
  const oldLocalFile = await workerRequest(ownerPage, { action: 'read', path: workspacePath })
  assert.equal(oldLocalFile.ok, true, JSON.stringify(oldLocalFile))
  assert.equal(oldLocalFile.content.includes('BROWSER_NATIVE_LEASE_EDIT_NEW_OWNER'), false)
  assert.equal(oldLocalFile.content.includes('BROWSER_NATIVE_LEASE_EDIT_OLD_OWNER'), false,
    'a fenced edit must not publish into the old Worker VFS')

  const successorReadCall = toolCallFor(successorTurn.session, successorTurn.turn, 'read')
  assert.ok(successorReadCall, 'the successor must satisfy DSH read-before-write policy')
  assert.equal(toolResultFor(successorTurn.session, successorReadCall.data.callId)?.data.message?.isError, false)
  const successorWrite = successorTurn.session.events.find(event => event.type === 'browser-native/workspace-receipt'
    && event.data.toolName === 'write')
  assert.ok(successorWrite, 'the successor DSH write must own the Workspace receipt')
  assert.equal(successorWrite.data.operationId, commits.find(item => item.role === 'successor'
    && item.status === 200)?.body.operationId)
  assert.deepEqual(externalRequests, [])
  assert.deepEqual(pageErrors, [])
  assert.equal(modelRequests.filter(item => item.role === 'owner').length, 4)
  assert.equal(modelRequests.filter(item => item.role === 'successor').length, 4)
  assert.ok(modelRequests.every(item => item.status === 200))

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browserName,
    scope: 'real-worker-opfs-long-edit-workspace-lease-transfer-fencing',
    workspaceId: identity.workspaceId,
    sessionIds: [sessionId, successorTurn.sessionId],
    oldEditCallId: oldEditCall.data.callId,
    oldEditRejectedBeforePublish: oldEditResult?.data.message?.isError === true,
    oldEditArgumentsRetainedWithoutReplay: true,
    successorReadCallId: successorReadCall.data.callId,
    successorReceiptOperationId: successorWrite.data.operationId,
    fencingTokens: [previousLease.fencingToken, successorLease.fencingToken],
    finalRevision: manifestAfterSuccessor.revision,
    llmRequestCount: modelRequests.length,
    commitCount: commits.filter(item => item.status === 200).length,
    externalRequestCount: externalRequests.length,
    httpErrors,
    pageErrors,
  })}\n`)
} catch (error) {
  const successorSession = successorSessionId === undefined
    ? undefined
    : await sessionRequest(origin, 'read', { sessionId: successorSessionId, offset: 0 }).catch(() => undefined)
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    ownerWorkspaceStatus: await ownerPage?.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__ ?? null).catch(() => null),
    successorWorkspaceStatus: await successorPage?.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__ ?? null).catch(() => null),
    successorLeaseObserved,
    successorSessionId,
    successorToolEvents: successorSession?.events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')
      .map(event => ({ type: event.type, name: event.data.name, callId: event.data.callId,
        isError: event.data.message?.isError, content: JSON.stringify(event.data.arguments ?? event.data.message?.content).slice(0, 500) })),
    successorModelRequests: modelRequests.filter(item => item.role === 'successor').map(item => ({
      tools: item.body.tools?.map(tool => tool.function?.name ?? tool.name),
      userMessages: item.body.messages?.filter(message => message.role === 'user')
        .map(message => typeof message.content === 'string' ? message.content.slice(0, 160) : '[non-text]'),
    })),
    requests: Object.fromEntries(Object.entries(roleRequests).map(([role, items]) => [role,
      items.filter(item => item.path === '/api/browser-native/workspace/lease').map(item => ({
        status: item.status,
        operation: item.body.operation,
        fencingToken: item.body.fencingToken,
        response: item.response,
      }))])),
    httpErrors,
    pageErrors,
    externalRequests,
  })}\n`)
  throw error
} finally {
  await oldTurnPromise?.catch(() => {})
  await successorPage?.close().catch(() => {})
  await ownerPage?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
