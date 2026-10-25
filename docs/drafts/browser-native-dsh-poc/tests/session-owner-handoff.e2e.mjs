import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
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

  const handoff = await page.evaluate(async input => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'session-handoff',
    sessionId: input.sessionId,
    ownerToken: input.ownerToken,
    ownerEpoch: 1,
    handoffId: 'chrome-worker-to-cloud-1',
    checkpoint: {
      sessionId: input.sessionId,
      ownerId: 'browser-worker-1',
      epoch: 1,
      nextSessionSeq: input.nextSessionSeq,
      workspaceRevision: 1,
      pendingOperationIds: [],
      pendingExecutionIds: [],
    },
  }), { sessionId: firstTurn.sessionId, ownerToken, nextSessionSeq: firstTurn.session.events.length })
  assert.equal(handoff?.ok, true, JSON.stringify(handoff))
  assert.equal(handoff?.status, 200)
  assert.equal(handoff?.value?.owner?.ownerEpoch, 2)
  assert.notEqual(handoff?.value?.owner?.ownerToken, ownerToken)

  const cloudOwner = handoff.value.owner
  const cloudAppend = await page.evaluate(async input => {
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
        events: [{ seq: input.nextSeq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'CLOUD_HANDOFF_CONTINUED' }] } } }],
      }),
    })
    return { status: response.status, body: await response.json() }
  }, {
    sessionId: firstTurn.sessionId,
    ownerToken: cloudOwner.ownerToken,
    ownerEpoch: cloudOwner.ownerEpoch,
    nextSeq: firstTurn.session.events.length,
  })
  assert.equal(cloudAppend.status, 200, JSON.stringify(cloudAppend))

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
  assert.equal(read.events.some(event => JSON.stringify(event).includes('CLOUD_HANDOFF_CONTINUED')), true)
  assert.equal(read.events.some(event => JSON.stringify(event).includes('STALE_MUST_NOT_APPEND')), false)
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'dedicated-worker-session-handoff-owner-epoch-and-stale-fencing',
    sessionId: firstTurn.sessionId,
    previousOwnerEpoch: 1,
    nextOwnerEpoch: cloudOwner.ownerEpoch,
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
