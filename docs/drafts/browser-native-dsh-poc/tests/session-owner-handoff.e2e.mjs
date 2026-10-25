import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, sessionRequest } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-session-handoff-')))
let image
let app
let browser
let context
let page
const requests = []
let backendNow = Date.now()
let dropHandoffResponse = true

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    ownerLeaseMs: 300,
    testHooks: {
      now: () => backendNow,
      dropSessionHandoffResponse: () => {
        if (!dropHandoffResponse) return false
        dropHandoffResponse = false
        return true
      },
    },
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('request', request => {
    if (!request.url().includes('/api/browser-native/session/create')) return
    try { requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() ?? {} }) } catch {}
  })
  const url = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await openPreview(page, url)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })

  const firstTurn = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_WRITER_HANDOFF_FIRST_E2E: create the first worker file.',
    marker: 'BROWSER_NATIVE_WRITER_HANDOFF_FIRST_DONE',
    timeout: 60_000,
  })
  const ownerToken = await page.evaluate(sessionId => sessionStorage.getItem(
    `dsh.browser-native.owner.${encodeURIComponent(sessionId)}`,
  ), firstTurn.sessionId)
  assert.equal(typeof ownerToken, 'string')

  const handoffInput = {
    sessionId: firstTurn.sessionId,
    ownerToken,
    ownerEpoch: 1,
    handoffId: 'chrome-worker-to-cloud-1',
    checkpoint: {
      sessionId: firstTurn.sessionId,
      ownerId: 'browser-worker-1',
      epoch: 1,
      nextSessionSeq: firstTurn.session.events.length,
      workspaceRevision: 1,
      pendingOperationIds: [],
      pendingExecutionIds: [],
    },
  }
  const lostResponse = await page.evaluate(async input => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'session-handoff',
    sessionId: input.sessionId,
    ownerToken: input.ownerToken,
    ownerEpoch: input.ownerEpoch,
    handoffId: input.handoffId,
    checkpoint: input.checkpoint,
  }), handoffInput)
  assert.equal(
    lostResponse?.ok === false || lostResponse?.ok === true && lostResponse?.value?.replayed === true,
    true,
    JSON.stringify(lostResponse),
  )
  if (lostResponse?.ok === true) {
    assert.equal(lostResponse.value.owner, null)
    assert.equal(lostResponse.value.credentialStatus, 'not-replayed')
  }

  const retry = await page.evaluate(async input => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'session-handoff',
    sessionId: input.sessionId,
    ownerToken: input.ownerToken,
    ownerEpoch: input.ownerEpoch,
    handoffId: input.handoffId,
    checkpoint: input.checkpoint,
  }), handoffInput)
  assert.equal(retry?.ok, true, JSON.stringify(retry))
  assert.equal(retry?.status, 200)
  assert.equal(retry?.value?.replayed, true)
  assert.equal(retry?.value?.owner, null)
  assert.equal(retry?.value?.credentialStatus, 'not-replayed')

  const persisted = await readFile(join(dataDir, 'sessions', `${firstTurn.sessionId}.json`), 'utf8')
  assert.equal(persisted.includes(ownerToken), false)

  const earlyClaim = await page.evaluate(async sessionId => {
    const response = await fetch('/api/browser-native/session/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId, access: 'write' }),
    })
    return { status: response.status, body: await response.json() }
  }, firstTurn.sessionId)
  assert.equal(earlyClaim.status, 409)
  assert.equal(earlyClaim.body.error.code, 'SESSION_ALREADY_OWNED')

  backendNow += 301
  const claim = await page.evaluate(async sessionId => {
    const response = await fetch('/api/browser-native/session/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId, access: 'write' }),
    })
    return { status: response.status, body: await response.json() }
  }, firstTurn.sessionId)
  assert.equal(claim.status, 200, JSON.stringify(claim))
  const newOwner = claim.body.owner
  assert.equal(newOwner.ownerEpoch, 3)
  assert.notEqual(newOwner.ownerToken, ownerToken)

  const acceptedAppend = await page.evaluate(async input => {
    const response = await fetch('/api/browser-native/session/append', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        sessionId: input.sessionId,
        ownerToken: input.ownerToken,
        ownerEpoch: input.ownerEpoch,
        expectedNextSeq: input.nextSeq,
        events: [{ seq: input.nextSeq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'RECOVERED_OWNER_CONTINUED' }] } } }],
      }),
    })
    return { status: response.status, body: await response.json() }
  }, {
    sessionId: firstTurn.sessionId,
    ownerToken: newOwner.ownerToken,
    ownerEpoch: newOwner.ownerEpoch,
    nextSeq: firstTurn.session.events.length,
  })
  assert.equal(acceptedAppend.status, 200, JSON.stringify(acceptedAppend))

  const staleAppend = await page.evaluate(async input => {
    const response = await fetch('/api/browser-native/session/append', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        sessionId: input.sessionId,
        ownerToken: input.ownerToken,
        ownerEpoch: input.ownerEpoch,
        expectedNextSeq: input.nextSeq + 1,
        events: [{ seq: input.nextSeq + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STALE_MUST_NOT_APPEND' }] } } }],
      }),
    })
    return { status: response.status, body: await response.json() }
  }, { sessionId: firstTurn.sessionId, ownerToken, ownerEpoch: 1, nextSeq: firstTurn.session.events.length })
  assert.equal(staleAppend.status, 409, JSON.stringify(staleAppend))
  assert.equal(staleAppend.body.error.code, 'SESSION_OWNERSHIP_LOST')

  const read = await sessionRequest(origin, 'read', { sessionId: firstTurn.sessionId, offset: 0 })
  assert.equal(read.events.some(event => JSON.stringify(event).includes('RECOVERED_OWNER_CONTINUED')), true)
  assert.equal(read.events.some(event => JSON.stringify(event).includes('STALE_MUST_NOT_APPEND')), false)
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'dedicated-worker-handoff-lost-response-safe-retry-and-owner-reclaim',
    sessionId: firstTurn.sessionId,
    previousOwnerEpoch: 1,
    recoveredOwnerEpoch: newOwner.ownerEpoch,
    handoffReplayReturnsCredential: false,
    staleAppendStatus: staleAppend.status,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
