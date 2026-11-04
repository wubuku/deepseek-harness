/**
 * One narrative journey across the shipped Browser-Native surface.
 *
 * A single script walks first use (identity, workspace, empty composer), three
 * ordinary turns, one approval-gated bash write settled from the real approval
 * card, a viewer grant that adds a read-only second principal while the owner
 * keeps writing, and finally Session export. Every step asserts both the
 * visible UI state and the durable Session record, and the closing checks
 * compare the exported bundle with the authoritative read response.
 *
 * Usage:
 *   DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/user-journey.e2e.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import {
  assistantText, openPreview, rememberSessionPrincipal, sendTurn, sessionRequest, submitPrompt, waitFor,
} from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const APPROVAL_MARKER = 'BROWSER_NATIVE_APPROVAL_ALLOW_ONCE_E2E'
const APPROVAL_DONE = 'BROWSER_NATIVE_APPROVAL_ALLOW_ONCE_E2E_SETTLED'
const APPROVAL_FILE = '/dsh/home/workspace/approval-allow-once-result.txt'
const APPROVAL_CONTENT = 'APPROVAL_ALLOW_ONCE_WRITE_OK\n'
const TURN_PROMPTS = [
  'USER_JOURNEY_TURN_ONE：总结这个工作区里可用的能力，不要调用工具。',
  'USER_JOURNEY_TURN_TWO：继续上一轮，给出下一步建议，不要调用工具。',
  'USER_JOURNEY_TURN_THREE：确认前两轮的结论，不要调用工具。',
]
const COLLABORATION_PROMPT = 'USER_JOURNEY_TURN_FIVE：协作授权后继续记录一条进展，不要调用工具。'
const STEP_TIMEOUT_MS = 90_000

const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-user-journey-')))
const requests = []
const pageErrors = []
const workerErrors = []
const external = []
let image
let app
let browser
let context
let page
let origin

function stepTimer() {
  const startedAt = Date.now()
  return () => Date.now() - startedAt
}

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

async function readSession(sessionId) {
  return await sessionRequest(origin, 'read', { sessionId, offset: 0 })
}

async function ownerCall(path, { method = 'POST', body, cookie } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => undefined)
  return { status: response.status, body: payload }
}

async function viewerCall(cookie, path, body) {
  return await ownerCall(path, { body, cookie })
}

async function createViewerPrincipal() {
  const known = new Set(app.workspaces.identities.keys())
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  const payload = await response.json()
  assert.equal(response.status, 200, JSON.stringify(payload))
  const principal = [...app.workspaces.identities.keys()].find(candidate => !known.has(candidate))
  assert.equal(typeof principal, 'string', 'the second principal must be issued a workspace identity')
  const cookie = `dsh-browser-native-principal=${principal}; dsh-browser-native-session-principal=${principal}`
  return { principal, workspaceId: app.workspaces.identities.get(principal), cookie }
}

function approvalEvents(session) {
  return session.events.filter(event => event.type === 'approval/asked')
}

function userPrompts(session) {
  return session.events.filter(event => event.type === 'user/message'
    && event.data.source?.kind === 'user')
}

function toolResultFor(session, callId) {
  return session.events.find(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === String(callId))
}

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) {
      external.push(request.url())
      return
    }
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({ path: url.pathname, body })
  })

  // Step 1: first use. The shipped preview boots one principal and workspace
  // with an empty transcript before any Session exists.
  const bootTimer = stepTimer()
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=approval-integrity&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  assert.equal(await page.locator('[data-composer-input][contenteditable="true"]').last().isVisible(), true)
  assert.equal(await page.locator('[data-chat-flow-kind="user"]').count(), 0, 'a fresh workspace must start without user messages')
  assert.equal(await page.locator('[data-approval-key]').count(), 0)
  const bootSessions = requests.filter(request => request.path.endsWith('/session/create'))
    .map(request => request.body?.sessionId).filter(sessionId => typeof sessionId === 'string')
  assert.equal(bootSessions.length, 1, 'first use must open exactly one empty Session')
  const bootSessionId = bootSessions[0]
  await rememberSessionPrincipal(page, origin, bootSessionId)
  const emptyRecord = await readSession(bootSessionId)
  assert.equal(emptyRecord.status, 200, JSON.stringify(emptyRecord))
  assert.equal(emptyRecord.events.filter(event => event.type === 'user/message').length, 0)
  assert.equal(emptyRecord.events.filter(event => event.type === 'turn/start').length, 0)
  const ownerCookie = (await context.cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  const identity = await ownerCall('/api/browser-native/workspace/identity', { method: 'GET', cookie: ownerCookie })
  assert.equal(identity.status, 200, JSON.stringify(identity.body))
  assert.equal(typeof identity.body.workspaceId, 'string')
  const firstUseMs = bootTimer()

  // Step 2: three ordinary turns, each visible in the transcript and closed by
  // a completed turn/end event in the durable log.
  const turnTimer = stepTimer()
  let sessionId
  for (const [index, prompt] of TURN_PROMPTS.entries()) {
    const result = index === 0
      ? await sendTurn({ page, origin, requests, prompt, timeout: STEP_TIMEOUT_MS })
      : await submitPrompt({ page, origin, requests, sessionId, prompt, timeout: STEP_TIMEOUT_MS })
    sessionId = result.sessionId
    if (index === 0) assert.equal(sessionId, bootSessionId, 'the first send must use the Session opened at first use')
    assert.equal(assistantText(result.session, result.turn).trim().length > 0, true,
      `turn ${String(result.turn)} must persist assistant text`)
    const terminal = result.session.events.findLast(event => event.type === 'turn/end')
    assert.equal(terminal.data.reason.kind, 'completed')
    const expectedUserBubbles = index + 1
    await waitFor(async () => await page.locator('[data-chat-flow-kind="user"]').count() === expectedUserBubbles,
      `${String(expectedUserBubbles)} visible user bubbles`, 15_000)
  }
  const multiTurnMs = turnTimer()
  const afterMultiTurn = await readSession(sessionId)
  const multiTurnUsers = userPrompts(afterMultiTurn)
  assert.equal(multiTurnUsers.length, 3, JSON.stringify(multiTurnUsers.map(event => event.data)))
  assert.equal(afterMultiTurn.events.filter(event => event.type === 'turn/start').length, 3)
  assert.equal(afterMultiTurn.events.filter(event => event.type === 'turn/end').length, 3)

  // Step 3: approval. The real card settles one dangerous bash write as
  // `allowed-once`; the transcript and the workspace both show the result.
  const approvalTimer = stepTimer()
  let approval
  const approvalTurn = await submitPrompt({
    page, origin, requests, sessionId,
    prompt: `${APPROVAL_MARKER}：写一条审批结果到工作区，然后确认。`,
    timeout: STEP_TIMEOUT_MS,
    probeWhileRunning: async () => {
      const asked = await waitFor(async () => {
        const session = await readSession(sessionId)
        return approvalEvents(session).at(-1)
      }, 'approval request', 60_000)
      const card = page.locator('[data-approval-key]')
      await card.waitFor({ state: 'visible', timeout: 30_000 })
      const cardText = await card.innerText()
      assert.match(cardText, /Allow once/)
      assert.match(cardText, /APPROVAL_ALLOW_ONCE_WRITE_OK/)
      approval = { request: asked, cardText }
      await card.getByRole('button', { name: 'Allow once' }).click()
    },
  })
  assert.ok(approval !== undefined, 'the approval turn must ask for approval')
  const approvalState = await readSession(sessionId)
  const asked = approvalEvents(approvalState)
  assert.equal(asked.length, 1, 'the journey must ask for approval exactly once')
  assert.equal(String(asked[0].data.id), String(approval.request.data.id))
  const decided = approvalState.events.filter(event => event.type === 'approval/decided'
    && String(event.data.id) === String(approval.request.data.id))
  assert.equal(decided.length, 1)
  assert.equal(decided[0].data.outcome, 'allowed-once')
  const result = toolResultFor(approvalState, asked[0].data.callId)
  assert.ok(result, 'the allowed call must settle')
  assert.equal(result.data.message.isError, false, JSON.stringify(result.data.message))
  assert.match(assistantText(approvalState, approvalTurn.turn), new RegExp(APPROVAL_DONE))
  await page.getByText(APPROVAL_DONE, { exact: false }).last().waitFor({ timeout: 30_000 })
  assert.equal(await page.locator('[data-approval-key]').count(), 0, 'the settled card must disappear')
  const written = await testAction({ action: 'read', path: APPROVAL_FILE })
  assert.equal(written?.ok, true, JSON.stringify(written))
  assert.equal(written.content, APPROVAL_CONTENT)
  const approvalMs = approvalTimer()

  // Step 4: collaboration. A second principal gets a viewer grant, reads the
  // same transcript, and is refused every mutation route.
  const shareTimer = stepTimer()
  const viewer = await createViewerPrincipal()
  assert.notEqual(viewer.workspaceId, identity.body.workspaceId, 'the viewer must own a separate workspace')
  const beforeGrant = await viewerCall(viewer.cookie, '/api/browser-native/session/open', {
    protocolVersion: 1, requestId: randomUUID(), sessionId, access: 'read',
  })
  assert.equal(beforeGrant.status, 404, 'sharing must precede viewer access')
  const grant = await ownerCall('/api/browser-native/session/share', {
    cookie: ownerCookie,
    body: { protocolVersion: 1, requestId: randomUUID(), sessionId, viewerPrincipalId: viewer.principal, role: 'viewer' },
  })
  assert.equal(grant.status, 200, JSON.stringify(grant.body))
  assert.equal(grant.body.share.role, 'viewer')
  assert.equal(grant.body.shares.length, 1)
  assert.equal(grant.body.owner, undefined, 'a grant response must not leak the owner lease')

  const openRead = await viewerCall(viewer.cookie, '/api/browser-native/session/open', {
    protocolVersion: 1, requestId: randomUUID(), sessionId, access: 'read',
  })
  assert.equal(openRead.status, 200, JSON.stringify(openRead.body))
  assert.equal(openRead.body.shared, true)
  assert.equal(openRead.body.owner, undefined)
  const viewerRead = await viewerCall(viewer.cookie, '/api/browser-native/session/read', {
    protocolVersion: 1, requestId: randomUUID(), sessionId, offset: 0,
  })
  assert.equal(viewerRead.status, 200, JSON.stringify(viewerRead.body))
  assert.deepEqual(viewerRead.body.events.map(event => event.seq), approvalState.events.map(event => event.seq))
  const openWrite = await viewerCall(viewer.cookie, '/api/browser-native/session/open', {
    protocolVersion: 1, requestId: randomUUID(), sessionId, access: 'write',
  })
  assert.equal(openWrite.status, 403)
  assert.equal(openWrite.body.error.code, 'SESSION_READ_ONLY')
  const viewerAppend = await viewerCall(viewer.cookie, '/api/browser-native/session/append', {
    protocolVersion: 1, requestId: randomUUID(), sessionId, expectedNextSeq: approvalState.nextSeq,
    events: [{ seq: approvalState.nextSeq, type: 'user/message', data: { message: { role: 'user', content: 'viewer write' }, turn: 5 } }],
  })
  assert.equal(viewerAppend.status, 403)
  assert.equal(viewerAppend.body.error.code, 'SESSION_READ_ONLY')

  const collaborationTurn = await submitPrompt({
    page, origin, requests, sessionId,
    prompt: COLLABORATION_PROMPT,
    timeout: STEP_TIMEOUT_MS,
  })
  await waitFor(async () => await page.locator('[data-chat-flow-kind="user"]').count() === 5,
    'five visible user bubbles after collaboration', 15_000)
  const viewerReadAfterWrite = await viewerCall(viewer.cookie, '/api/browser-native/session/read', {
    protocolVersion: 1, requestId: randomUUID(), sessionId, offset: 0,
  })
  assert.equal(viewerReadAfterWrite.status, 200)
  assert.equal(userPrompts(viewerReadAfterWrite.body).length, 5,
    'the viewer must observe the owner turn authorised after the grant')
  assert.deepEqual(viewerReadAfterWrite.body.events.map(event => event.seq),
    collaborationTurn.session.events.map(event => event.seq))
  const viewerExport = await viewerCall(viewer.cookie, '/api/browser-native/session/export', {
    workspaceId: viewer.workspaceId, sessionId,
  })
  assert.notEqual(viewerExport.status, 200, 'export stays owner-only')
  const shareMs = shareTimer()

  // Step 5: export. The bundle must equal the authoritative Session record,
  // including the approval decision and the final turn.
  const exportTimer = stepTimer()
  const finalRead = await readSession(sessionId)
  const exported = await ownerCall('/api/browser-native/session/export', {
    cookie: ownerCookie,
    body: { workspaceId: identity.body.workspaceId, sessionId },
  })
  assert.equal(exported.status, 200, JSON.stringify(exported.body))
  const bundle = exported.body
  assert.equal(bundle.format, 'dsh-session-bundle')
  assert.equal(bundle.formatVersion, 1)
  assert.equal(bundle.sessionFormatVersion, 4)
  assert.equal(bundle.session.id, sessionId)
  assert.equal(bundle.session.header.cwd, '/dsh/home')
  assert.equal(bundle.attachments.length, 0)
  assert.deepEqual(bundle.session.events, finalRead.events)
  assert.equal(bundle.session.durableThroughSeq, finalRead.durableThroughSeq)
  assert.deepEqual(bundle.session.events.map(event => event.seq),
    bundle.session.events.map((_, index) => index))
  const exportedUsers = userPrompts(bundle.session)
  assert.equal(exportedUsers.length, 5)
  const exportedDecisions = bundle.session.events.filter(event => event.type === 'approval/decided')
  assert.equal(exportedDecisions.length, 1)
  assert.equal(exportedDecisions[0].data.outcome, 'allowed-once')
  assert.match(assistantText(bundle.session), new RegExp(APPROVAL_DONE))
  const exportedBytes = Buffer.byteLength(JSON.stringify(bundle))
  const afterExportWrite = await testAction({ action: 'read', path: APPROVAL_FILE })
  assert.equal(afterExportWrite.content, APPROVAL_CONTENT)
  const exportMs = exportTimer()

  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(external, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    scope: 'narrative-journey-first-use-multi-turn-approval-collaboration-export',
    browser: browser.version(),
    sessionId,
    steps: {
      firstUse: { ms: firstUseMs, workspaceId: identity.body.workspaceId, bootSessionId, userMessages: 0, userBubbles: 0 },
      multiTurn: { ms: multiTurnMs, turns: 3, events: afterMultiTurn.events.length },
      approval: {
        ms: approvalMs,
        requestId: String(asked[0].data.id),
        callId: String(asked[0].data.callId),
        outcome: decided[0].data.outcome,
        file: { path: APPROVAL_FILE, bytes: Buffer.byteLength(APPROVAL_CONTENT) },
      },
      collaboration: {
        ms: shareMs,
        viewerPrincipalDigest: viewer.principal.slice(0, 8),
        viewerReadEvents: viewerReadAfterWrite.body.events.length,
        writeDenied: 'SESSION_READ_ONLY',
        exportDenied: viewerExport.status,
        ownerTurns: 5,
      },
      export: {
        ms: exportMs,
        bytes: exportedBytes,
        events: bundle.session.events.length,
        durableThroughSeq: bundle.session.durableThroughSeq,
        attachments: bundle.attachments.length,
      },
    },
    requests: {
      sessionCreate: requests.filter(request => request.path.endsWith('/session/create')).length,
      sessionAppend: requests.filter(request => request.path.endsWith('/session/append')).length,
      llm: requests.filter(request => request.path.endsWith('/llm')).length,
    },
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup?.()
  await rm(dataDir, { recursive: true, force: true })
}
