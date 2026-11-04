/**
 * Delegation trace across parent and child Sessions.
 *
 * A scripted parent Session first hits a denied write (so the trace carries an
 * audit decision) and then delegates once to an in-Worker child. The test reads
 * both Session logs and the trace report, and checks that the root Session id
 * is the shared trace id, the parent call is recoverable, and per-Session cost
 * rows are joined from usage.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import {
  openPreview,
  rememberSessionPrincipal,
  sessionGetRequest,
  sessionRequest,
  submitPrompt,
  waitFor,
  waitForPreview,
} from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const image = await createRuntimeValidationDist({ roster: 'browser-subagent' })
const dataDir = await mkdtemp(join(tmpdir(), 'dsh-subagent-trace-'))
const PARENT_PROMPT = 'BROWSER_NATIVE_TRACE_PARENT'
const CHILD_PROMPT = 'BROWSER_NATIVE_TRACE_CHILD'
const DENIED_FILE = '/dsh/home/workspace/trace-denied.txt'
const POLICY = { tools: { write: 'deny' }, default: 'allow' }
let app
let browser
const pageErrors = []
const workerErrors = []

const appServer = await createBrowserNativeV2Server({
  dataDir,
  distRoot: image.distRoot,
  llmMode: 'scripted',
  testHooks: {
    scriptedLlmFault: body => {
      const userTexts = messageTexts(body, 'user')
      if (!userTexts.some(text => text.includes(PARENT_PROMPT))) {
        return { kind: 'text', text: `${CHILD_PROMPT}_DONE` }
      }
      const toolTexts = messageTexts(body, 'tool')
      if (toolTexts.length === 0) {
        return {
          kind: 'tool-call',
          call: { id: 'trace-denied-write', name: 'write', arguments: { file_path: DENIED_FILE, content: 'denied' } },
        }
      }
      if (!toolTexts.some(text => text.includes('started subagent'))) {
        return {
          kind: 'tool-call',
          call: { id: 'trace-subagent-call', name: 'subagent', arguments: { description: 'trace child', prompt: CHILD_PROMPT } },
        }
      }
      return { kind: 'text', text: `${PARENT_PROMPT}_DONE` }
    },
  },
})
app = appServer
const origin = await app.listen(0)
browser = await chromium.launch({ headless: true, channel: 'chrome' })

try {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  context.on('page', tracked => {
    tracked.on('pageerror', error => pageErrors.push(error.message))
    tracked.on('worker', worker => {
      worker.on('pageerror', error => workerErrors.push(error.message))
      worker.on('console', message => {
        if (message.type() === 'error') workerErrors.push(message.text())
      })
    })
  })
  const page = await context.newPage()
  const requests = []
  page.on('request', request => {
    if (!request.url().includes('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({ path: new URL(request.url()).pathname, body })
  })
  await openPreview(page,
    `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=subagent&preview-fixture=none`)
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced',
    undefined, { timeout: 30_000 })

  await page.locator('button[aria-label^="Access mode"]').first().click()
  await page.getByRole('menuitem', { name: 'Workspace Write' }).click()
  await page.locator('button[aria-label="Access mode, current: Workspace Write"]').waitFor({ timeout: 15_000 })
  const applied = await page.evaluate(async policy =>
    await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'tool-policy-set', toolPolicy: policy }), POLICY)
  assert.equal(applied?.ok, true, JSON.stringify(applied))

  const parent = await submitPrompt({ page, origin, requests, prompt: PARENT_PROMPT, timeout: 90_000 })
  const deniedCall = parent.session.events.find(event => event.type === 'tool/call'
    && event.data.name === 'write' && event.data.callId === 'trace-denied-write')
  assert.ok(deniedCall, 'the parent must attempt the denied write')
  const deniedResult = parent.session.events.find(event => event.type === 'tool/result'
    && event.data.message.toolCallId === deniedCall.data.callId)
  assert.equal(deniedResult?.data.message.isError, true, 'the tool policy must deny the write')

  const subagentCall = parent.session.events.find(event => event.type === 'tool/call' && event.data.name === 'subagent')
  assert.ok(subagentCall, 'the parent must delegate once')
  const subagentResult = parent.session.events.find(event => event.type === 'tool/result'
    && event.data.message.toolCallId === subagentCall.data.callId)
  const activated = toolResultText(subagentResult).match(/started subagent (\S+)/)
  assert.ok(activated, `the subagent result must name the child, got ${toolResultText(subagentResult)}`)
  const childSessionId = activated[1]
  await rememberSessionPrincipal(page, origin, childSessionId)
  await waitFor(async () => {
    const read = await sessionRequest(origin, 'read', { sessionId: childSessionId, offset: 0 }).catch(() => undefined)
    return read?.status === 200 && read.events?.some(event => event.type === 'turn/end')
  }, 'the child Session to finish', 60_000)

  const childRead = await sessionRequest(origin, 'read', { sessionId: childSessionId, offset: 0 })
  assert.equal(childRead.header?.parentSession, parent.sessionId,
    'the child log header must persist its delegation parent')
  assert.equal(childRead.header?.origin, 'subagent')
  assert.equal(childRead.header?.delegationDepth, 1)

  const parentTrace = await sessionGetRequest(origin, 'trace', { sessionId: parent.sessionId }, parent.sessionId)
  const childTrace = await sessionGetRequest(origin, 'trace', { sessionId: childSessionId }, childSessionId)
  assert.equal(parentTrace.status, 200)
  assert.equal(childTrace.status, 200)
  assert.equal(parentTrace.traceId, parent.sessionId, 'the root Session id is the trace id')
  assert.equal(childTrace.traceId, parent.sessionId, 'a child resolves to the same trace id')
  assert.equal(parentTrace.sessions.length, 2, 'the trace must include the parent and its child')
  const parentRow = parentTrace.sessions.find(row => row.sessionId === parent.sessionId)
  const childRow = parentTrace.sessions.find(row => row.sessionId === childSessionId)
  assert.ok(parentRow && childRow)
  assert.equal(parentRow.parentSession, null)
  assert.equal(childRow.parentSession, parent.sessionId)
  assert.equal(childRow.parentCallId, subagentCall.data.callId, 'the parent call must be linked into the trace')
  assert.ok(childRow.parentTurn >= 1, 'the parent call must carry its turn number')
  assert.equal(childRow.delegationDepth, 1)
  assert.ok(parentRow.audit.toolPolicy.deny >= 1, 'the denied write must appear in the parent audit row')
  assert.equal(childRow.audit.toolPolicy.deny, 0)
  assert.equal(parentTrace.totals.sessions, 2)
  assert.equal(parentTrace.model, 'browser-native-scripted')
  assert.deepEqual(parentTrace.accessDenials, [])
  assert.deepEqual({
    traceId: parentTrace.traceId,
    childTraceId: childTrace.traceId,
    sessions: parentTrace.sessions.map(row => ({
      sessionId: row.sessionId,
      parentSession: row.parentSession,
      parentCallId: row.parentCallId,
      parentTurn: row.parentTurn,
      depth: row.delegationDepth,
    })),
    totals: parentTrace.totals,
  }, {
    traceId: parent.sessionId,
    childTraceId: parent.sessionId,
    sessions: [
      { sessionId: parent.sessionId, parentSession: null, parentCallId: null, parentTurn: null, depth: 0 },
      { sessionId: childSessionId, parentSession: parent.sessionId, parentCallId: subagentCall.data.callId, parentTurn: 1, depth: 1 },
    ],
    totals: { sessions: 2, turns: 2, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null },
  })
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    traceId: parentTrace.traceId,
    parentSessionId: parent.sessionId,
    childSessionId,
    parentCallId: subagentCall.data.callId,
    parentTurn: childRow.parentTurn,
    sessions: parentTrace.sessions.map(row => ({
      sessionId: row.sessionId,
      parentSession: row.parentSession,
      depth: row.delegationDepth,
      audit: row.audit.toolPolicy,
    })),
    totals: parentTrace.totals,
    note: 'Scripted scripted delegation proves ancestry, parent call linkage, audit attribution and usage joins. Cost is exercised by subagent-trace.test.mjs with priced usage; this E2E has no provider usage because the model is scripted.',
  })}\n`)
} finally {
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image.cleanup()
  await rm(dataDir, { recursive: true, force: true })
}

function messageTexts(body, role) {
  return (body?.messages ?? []).filter(message => message?.role === role).flatMap(message => {
    if (typeof message.content === 'string') return [message.content]
    if (Array.isArray(message.content)) return message.content.filter(part => part?.type === 'text').map(part => part.text)
    return []
  })
}

function toolResultText(event) {
  const content = event?.data?.message?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('') : ''
}
