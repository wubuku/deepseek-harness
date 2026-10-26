import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { SESSION_APPEND_MAX_BYTES, SESSION_APPEND_MAX_EVENTS } from '../session-transport-limits.mjs'
import { openPreview, sendTurn, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-session-transport-')))
const outageMarker = 'BROWSER_NATIVE_SESSION_TRANSPORT_503'
let image
let app
let browser
let page
let dropReceiptResponse = true
let droppedReceiptResponses = 0
let sessionAppendFailuresRemaining = 0
let sessionAppendFailures = 0
const requests = []
const appendStatuses = []
const commits = []
const pageErrors = []
const nonLocalRequests = []

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: {
      failSessionAppend: body => {
        if (sessionAppendFailuresRemaining === 0 || !JSON.stringify(body.events).includes(outageMarker)) return false
        sessionAppendFailuresRemaining -= 1
        sessionAppendFailures += 1
        return true
      },
      dropSessionAppendResponse: body => {
        if (!dropReceiptResponse || !body.events?.some(event => event.type === 'browser-native/workspace-receipt')) return false
        dropReceiptResponse = false
        droppedReceiptResponses += 1
        return true
      },
    },
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({ path: url.pathname, body })
    if (url.pathname.endsWith('/workspace/commit')) commits.push(body)
  })
  page.on('response', response => {
    if (new URL(response.url()).pathname.endsWith('/session/append')) appendStatuses.push(response.status())
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  const first = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_WORKSPACE_TOOL_E2E：请使用 write 工具写入工作区，然后确认。',
    marker: 'BROWSER_NATIVE_WORKSPACE_TOOL_DONE',
    timeout: 60_000,
  })
  const receipt = first.session.events.filter(event => event.type === 'browser-native/workspace-receipt')
  assert.equal(droppedReceiptResponses, 1, 'the backend must commit the receipt event before dropping its response')
  assert.equal(receipt.length, 1, 'unknown append recovery must not duplicate the Workspace receipt')
  assert.equal(commits.length, 1, 'the Workspace side effect must execute once')
  assert.equal(first.session.events.filter(event => event.type === 'tool/call' && event.data.name === 'write').length, 1)
  assert.equal(first.session.events.filter(event => event.type === 'tool/result').length, 1)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  sessionAppendFailuresRemaining = 3
  const failedPrompt = `${outageMarker}：请简短回答，不调用工具。`
  const priorSession = await sessionRequest(origin, 'read', { sessionId: first.sessionId, offset: 0 })
  const priorTurn = Math.max(...priorSession.events.filter(event => event.type === 'turn/end').map(event => event.data.turn))
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(failedPrompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const failedSession = await waitFor(async () => {
    const current = await sessionRequest(origin, 'read', { sessionId: first.sessionId, offset: 0 })
    const terminal = current.events.findLast(event => event.type === 'turn/end' && event.data.turn > priorTurn)
    return terminal === undefined ? undefined : { current, terminal }
  }, 'failed turn after Session append outage', 30_000)
  assert.equal(sessionAppendFailures, 3, 'the transient outage must be injected for three consecutive append attempts')
  assert.equal(sessionAppendFailuresRemaining, 0)
  assert.notEqual(failedSession.terminal.data.reason.kind, 'completed', 'a turn without a durable user input must fail closed')
  assert.equal(failedSession.current.events.some(event => event.type === 'user/message' && eventText(event).includes(outageMarker)), false)
  assert.equal(requests.some(request => request.path.endsWith('/llm') && JSON.stringify(request.body).includes(outageMarker)), false,
    'the failed prompt must not reach the model before its Session input is durable')
  assert.equal(failedSession.current.events.filter(event => event.type === 'browser-native/workspace-receipt').length, 1)
  assert.equal(commits.length, 1)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  const second = await sendTurn({
    page,
    origin,
    requests,
    sessionId: first.sessionId,
    prompt: 'BROWSER_NATIVE_SESSION_TRANSPORT_CONTINUE：故障解除后显式开启新一轮。',
    timeout: 60_000,
  })
  assert.equal(second.session.events.every((event, index) => event.seq === index), true)
  assert.equal(second.session.events.filter(event => event.type === 'browser-native/workspace-receipt').length, 1)
  assert.equal(commits.length, 1)

  const finalRead = await sessionRequest(origin, 'read', { sessionId: first.sessionId, offset: 0 })
  assert.equal(finalRead.durableThroughSeq, finalRead.nextSeq - 1, 'the durable prefix must cover the complete recovered log')
  const appendBodies = requests.filter(request => request.path.endsWith('/session/append')).map(request => request.body.events)
  assert.equal(appendBodies.length > 0, true)
  assert.equal(appendBodies.every(events => events.length <= SESSION_APPEND_MAX_EVENTS), true)
  assert.equal(appendBodies.every(events => new TextEncoder().encode(JSON.stringify(events)).byteLength <= SESSION_APPEND_MAX_BYTES), true)
  assert.equal(second.session.events.some(event => event.type === 'assistant/message' && event.data.turn === second.turn), true)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'real-DSH-Worker-unknown-append-response-session-reconciliation-three-503-fail-closed-explicit-continue-workspace-receipt-refresh',
    sessionId: first.sessionId,
    eventCount: finalRead.nextSeq,
    durableThroughSeq: finalRead.durableThroughSeq,
    droppedReceiptResponses,
    sessionAppendFailures,
    failedTurnReason: failedSession.terminal.data.reason.kind,
    rejectedPromptReachedLlm: false,
    appendRequests: appendBodies.length,
    maxAppendEvents: Math.max(...appendBodies.map(events => events.length)),
    maxAppendBytes: Math.max(...appendBodies.map(events => new TextEncoder().encode(JSON.stringify(events)).byteLength)),
    workspaceCommits: commits.length,
    workspaceReceipts: receipt.length,
    pageErrors,
    nonLocalRequests,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
