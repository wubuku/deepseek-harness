import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, sendTurn, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-capability-publication-`))
const fullToolNames = ['ask_user_question', 'bash', 'edit', 'glob', 'grep', 'read', 'todo_write', 'working_directory', 'write']
const degradedToolNames = ['ask_user_question', 'todo_write']
const llmRequests = []
const workspaceCommits = []
const requests = []
const pageErrors = []
const consoleMessages = []
const externalRequests = []
let image
let app
let browser
let page

function wireSchema(tool) {
  const schema = tool.function ?? tool
  return { name: schema.name, description: schema.description, parameters: schema.parameters }
}

function schemaNames(schemas) {
  return schemas.map(schema => schema.name).sort()
}

function latestUserText(request) {
  return [...(request.messages ?? [])].reverse().find(message => message.role === 'user'
    && typeof message.content === 'string'
    && !message.content.startsWith('Current runtime context.')
    && !message.content.startsWith('Time sampled while preparing turn'))?.content ?? ''
}

function agentRequestsFor(marker) {
  return llmRequests.filter(body => body.purpose !== 'session-title'
    && Array.isArray(body.tools) && latestUserText(body).includes(marker))
}

function toolResultFor(session, callId) {
  return session.events.find(event => event.type === 'tool/result'
    && event.data.message?.toolCallId === callId)
}

function userPromptCount(session, marker) {
  return session.events.filter(event => {
    if (event.type !== 'user/message') return false
    const content = event.data.content ?? event.data.message?.content
    return Array.isArray(content) && content.some(block => block.type === 'text' && block.text.includes(marker))
  }).length
}

function assertRecordedRosters(session, modelRequests) {
  const headers = session.events.filter(event => event.type === 'request/header')
    .map(event => event.data.header.tools ?? [])
  assert.ok(headers.length >= 2, 'DSH must log initial and degraded request headers')
  for (const request of modelRequests) {
    const wireSchemas = (request.tools ?? []).map(wireSchema)
    const recorded = headers.some(header => JSON.stringify(header.map(wireSchema).sort((a, b) => a.name.localeCompare(b.name)))
      === JSON.stringify(wireSchemas.sort((a, b) => a.name.localeCompare(b.name))))
    assert.equal(recorded, true, `Session request/header must contain the exact schema sent to the model: ${schemaNames(wireSchemas)}`)
  }
}

async function openNativePreview(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
}

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' || message.text().includes('browser-native')) {
      consoleMessages.push({ type: message.type(), text: message.text() })
    }
  })
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = JSON.parse(request.postData() ?? '{}') } catch {}
    requests.push({ path: url.pathname, body })
    if (url.pathname === '/api/browser-native/llm') llmRequests.push(body)
    if (url.pathname === '/api/browser-native/workspace/commit') workspaceCommits.push(body)
  })

  const preview = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await openNativePreview(page, preview)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')

  const baseline = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write',
    path: '/dsh/home/workspace/capability-baseline.txt',
    content: 'baseline survives Worker reconstruction\n',
  }))
  assert.equal(baseline?.ok, true, JSON.stringify(baseline))
  const baselineCommit = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
  assert.equal(baselineCommit?.ok, true, JSON.stringify(baselineCommit))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  assert.equal(workspaceCommits.length, 1)

  let bashTurn
  try {
    bashTurn = await sendTurn({
      page,
      origin,
      requests,
      prompt: 'BROWSER_NATIVE_CAPABILITY_BASH_E2E：通过 Worker Shell 写入工作区文件。',
      marker: 'BROWSER_NATIVE_CAPABILITY_BASH_DONE',
      timeout: 60_000,
    })
  } catch (error) {
    const sessionId = requests.find(request => request.path === '/api/browser-native/session/create')?.body.sessionId
    const session = typeof sessionId === 'string' ? await sessionRequest(origin, 'read', { sessionId, offset: 0 }) : undefined
    process.stderr.write(`${JSON.stringify({
      failure: error instanceof Error ? error.message : String(error),
      sessionId,
      requestPaths: requests.map(request => request.path),
      loggedHeaders: session?.events?.filter(event => event.type === 'request/header').map(event => event.data.header),
      pageText: (await page.locator('body').innerText()).slice(-2000),
      pageErrors,
      consoleMessages,
    })}\n`)
    throw error
  }
  const bashCall = bashTurn.session.events.find(event => event.type === 'tool/call'
    && event.data.callId === 'browser-native-capability-bash-write')
  assert.ok(bashCall, 'the actual DSH Agent Loop must dispatch the Worker bash tool')
  const bashResult = toolResultFor(bashTurn.session, String(bashCall.data.callId))
  assert.ok(bashResult)
  assert.equal(bashResult.data.message.isError, false)
  assert.ok(bashTurn.session.events.some(event => event.type === 'browser-native/workspace-receipt'
    && event.data.callId === bashCall.data.callId), 'the bash mutation must be linked to its DSH tool call')
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 2, undefined, { timeout: 30_000 })
  assert.equal(workspaceCommits.length, 2, 'a successful bash write must receive the same durable Workspace commit path')
  const durableBashFile = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'read', path: '/dsh/home/workspace/capability-bash.txt',
  }))
  assert.deepEqual({ ok: durableBashFile?.ok, content: durableBashFile?.content }, {
    ok: true,
    content: 'BROWSER_NATIVE_CAPABILITY_BASH_DURABLE\n',
  })

  let cloudCommitRejected = false
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    if (cloudCommitRejected) return await route.continue()
    cloudCommitRejected = true
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'TEST_CLOUD_COMMIT_PENDING', message: 'commit remains pending for capability test' } }),
    })
  })
  const cloudPendingTurn = await sendTurn({
    page,
    origin,
    requests,
    sessionId: bashTurn.sessionId,
    prompt: 'BROWSER_NATIVE_CAPABILITY_CLOUD_PENDING_E2E：写入文件并在云端暂时不可用时继续。',
    marker: 'BROWSER_NATIVE_CAPABILITY_CLOUD_PENDING_DONE',
    timeout: 60_000,
  })
  await page.unroute(`${origin}/api/browser-native/workspace/commit`)
  assert.equal(cloudCommitRejected, true, 'the E2E must inject a remote commit failure')
  const cloudPendingCall = cloudPendingTurn.session.events.find(event => event.type === 'tool/call'
    && event.data.callId === 'browser-native-capability-cloud-pending-write')
  assert.ok(cloudPendingCall)
  assert.equal(toolResultFor(cloudPendingTurn.session, String(cloudPendingCall.data.callId))?.data.message.isError, false,
    'local durability keeps the successful tool result even while remote commit is pending')
  const cloudPendingRequests = agentRequestsFor('BROWSER_NATIVE_CAPABILITY_CLOUD_PENDING_E2E')
  assert.equal(cloudPendingRequests.length, 2)
  assert.deepEqual(schemaNames((cloudPendingRequests[0].tools ?? []).map(wireSchema)), fullToolNames)
  assert.deepEqual(schemaNames((cloudPendingRequests[1].tools ?? []).map(wireSchema)), fullToolNames,
    'remote commit failure must not withdraw locally durable Workspace tools')
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 3, undefined, { timeout: 30_000 })
  const pendingCommitAttempts = workspaceCommits.filter(body => body.changes?.some(change => change.path === 'capability-cloud-pending.txt'))
  assert.equal(pendingCommitAttempts.length, 2, 'the pending cloud operation must be retried once')
  assert.equal(pendingCommitAttempts[0].operationId, pendingCommitAttempts[1].operationId,
    'remote retry must reuse the Workspace operation id')
  const locallyDurableCloudFile = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'read', path: '/dsh/home/workspace/capability-cloud-pending.txt',
  }))
  assert.deepEqual({ ok: locallyDurableCloudFile?.ok, content: locallyDurableCloudFile?.content }, {
    ok: true,
    content: 'local durable bytes remain available while cloud commit is pending\n',
  })

  const armed = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'quota-next-opfs-write' }))
  assert.equal(armed?.ok, true, JSON.stringify(armed))
  const failedTurn = await sendTurn({
    page,
    origin,
    requests,
    sessionId: bashTurn.sessionId,
    prompt: 'BROWSER_NATIVE_CAPABILITY_WITHDRAWAL_E2E：请完成两项工作区文件写入。',
    marker: 'BROWSER_NATIVE_CAPABILITY_WITHDRAWAL_DONE',
    timeout: 60_000,
  })

  const writes = failedTurn.session.events.filter(event => event.type === 'tool/call'
    && event.data.turn === failedTurn.turn && event.data.name === 'write')
  assert.deepEqual(writes.map(event => event.data.callId), [
    'browser-native-capability-quota-write',
    'browser-native-capability-late-write',
  ])
  const failedWriteResult = toolResultFor(failedTurn.session, 'browser-native-capability-quota-write')
  const lateWriteResult = toolResultFor(failedTurn.session, 'browser-native-capability-late-write')
  assert.ok(failedWriteResult)
  assert.ok(lateWriteResult)
  assert.equal(failedWriteResult.data.message.isError, true)
  assert.match(failedWriteResult.data.message.content.map(block => block.text ?? '').join(' '), /local Workspace persistence was not confirmed/i)
  assert.equal(lateWriteResult.data.message.isError, true)
  assert.match(lateWriteResult.data.message.content.map(block => block.text ?? '').join(' '), /capability is not currently published/i)
  assert.equal(assistantText(failedTurn.session, failedTurn.turn).includes('BROWSER_NATIVE_CAPABILITY_WITHDRAWAL_DONE'), true)

  const sameTurnRequests = agentRequestsFor('BROWSER_NATIVE_CAPABILITY_WITHDRAWAL_E2E')
  assert.equal(sameTurnRequests.length, 2, 'one user prompt must produce the tool request and one continuation request only')
  assert.deepEqual(schemaNames((sameTurnRequests[0].tools ?? []).map(wireSchema)), fullToolNames)
  assert.deepEqual(schemaNames((sameTurnRequests[1].tools ?? []).map(wireSchema)), degradedToolNames)
  assertRecordedRosters(failedTurn.session, sameTurnRequests)

  const volatileFirstWrite = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'read', path: '/dsh/home/workspace/capability-quota-attempt.txt',
  }))
  const blockedSecondWrite = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'read', path: '/dsh/home/workspace/capability-late-attempt.txt',
  }))
  assert.equal(volatileFirstWrite?.ok, true, 'the first VFS mutation is not rolled back when local durability fails')
  assert.equal(blockedSecondWrite?.ok, false, 'the late call must not create a VFS mutation')
  assert.equal(workspaceCommits.length, 4, 'a locally unconfirmed file must not be committed remotely')
  const requestsBeforeReload = llmRequests.length

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 3, undefined, { timeout: 30_000 })
  assert.equal(llmRequests.length, requestsBeforeReload, 'Worker reconstruction must not replay the failed turn')
  const afterReloadFirstWrite = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'read', path: '/dsh/home/workspace/capability-quota-attempt.txt',
  }))
  const restoredBaseline = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'read', path: '/dsh/home/workspace/capability-baseline.txt',
  }))
  assert.equal(afterReloadFirstWrite?.ok, false, 'volatile bytes must not appear durable after refresh')
  assert.deepEqual({ ok: restoredBaseline?.ok, content: restoredBaseline?.content }, {
    ok: true,
    content: 'baseline survives Worker reconstruction\n',
  })

  const recoveredTurn = await sendTurn({
    page,
    origin,
    requests,
    sessionId: bashTurn.sessionId,
    prompt: 'BROWSER_NATIVE_CAPABILITY_RECOVERY_E2E：读取已提交的基线文件。',
    marker: 'BROWSER_NATIVE_CAPABILITY_RECOVERY_DONE',
    timeout: 60_000,
  })
  const recoveredRead = recoveredTurn.session.events.find(event => event.type === 'tool/call'
    && event.data.callId === 'browser-native-capability-recovered-read')
  assert.ok(recoveredRead, 'a new Worker must republish the read tool after successful startup probes')
  const recoveredResult = toolResultFor(recoveredTurn.session, String(recoveredRead.data.callId))
  assert.ok(recoveredResult)
  assert.equal(recoveredResult.data.message.isError, false)
  assert.match(recoveredResult.data.message.content.map(block => block.text ?? '').join(' '), /baseline survives Worker reconstruction/)
  const recoveryRequests = agentRequestsFor('BROWSER_NATIVE_CAPABILITY_RECOVERY_E2E')
  assert.equal(recoveryRequests.length, 2)
  assert.deepEqual(schemaNames((recoveryRequests[0].tools ?? []).map(wireSchema)), fullToolNames)
  assert.deepEqual(schemaNames((recoveryRequests[1].tools ?? []).map(wireSchema)), fullToolNames)
  assertRecordedRosters(recoveredTurn.session, recoveryRequests)

  assert.equal(userPromptCount(recoveredTurn.session, 'BROWSER_NATIVE_CAPABILITY_WITHDRAWAL_E2E'), 1)
  assert.equal(userPromptCount(recoveredTurn.session, 'BROWSER_NATIVE_CAPABILITY_RECOVERY_E2E'), 1)
  const bashRequests = agentRequestsFor('BROWSER_NATIVE_CAPABILITY_BASH_E2E')
  assert.equal(bashRequests.length, 2)
  assert.equal(sameTurnRequests.length, 2)
  assert.equal(recoveryRequests.length, 2)
  assert.equal(workspaceCommits.length, 4)
  assert.deepEqual(consoleMessages.filter(message => message.text.includes('llm-browser-native')), [])
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'real-DSH-tool-schema-withdrawal-cloud-pending-distinction-and-refresh-republish',
    workspaceId,
    sessionId: recoveredTurn.sessionId,
    llmRequestCount: llmRequests.length,
    bashWorkspaceCommitCount: 1,
    cloudPendingCommitRetries: pendingCommitAttempts.length,
    cloudPendingOperationIdReused: pendingCommitAttempts[0].operationId === pendingCommitAttempts[1].operationId,
    firstTurnToolNames: sameTurnRequests.map(body => schemaNames((body.tools ?? []).map(wireSchema))),
    writeCallCount: writes.length,
    blockedLateWrite: true,
    volatileWriteAbsentAfterRefresh: afterReloadFirstWrite?.ok === false,
    baselineRestored: restoredBaseline?.ok === true,
    workspaceCommitCount: workspaceCommits.length,
    pageErrors,
    externalRequests,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
