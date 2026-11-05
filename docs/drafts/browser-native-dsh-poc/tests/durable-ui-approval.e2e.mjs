/**
 * Verify the formal Web preview's durable approval entry: a server-owned turn
 * that needs a write approval is rendered in the page, can be decided with the
 * keyboard, and the durable turn continues or refuses the write accordingly.
 *
 * Usage:
 *   node docs/drafts/browser-native-dsh-poc/tests/durable-ui-approval.e2e.mjs
 *   DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
 *     DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/durable-ui-approval.e2e.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-durable-ui-approval-`))
const pages = []
const pageErrors = []
let image
let app
let browser
let context

function targetFor(text) {
  return text.includes('DURABLE UI APPROVAL REJECT')
    ? '/dsh/home/workspace/durable-ui-rejected.txt'
    : '/dsh/home/workspace/durable-ui-approved.txt'
}

function scriptedLlmFault(body) {
  const lastUserIndex = body.messages.findLastIndex(message => message.role === 'user')
  const lastUser = body.messages[lastUserIndex]
  const text = typeof lastUser?.content === 'string' ? lastUser.content : ''
  if (!text.includes('DURABLE UI APPROVAL')) return { kind: 'text', text: 'UNRELATED' }
  const sawToolResult = body.messages.slice(lastUserIndex + 1).some(message => message.role === 'tool')
  if (sawToolResult) return { kind: 'text', text: 'DURABLE UI APPROVAL DONE' }
  const target = targetFor(text)
  return {
    kind: 'tool-call',
    call: { id: `durable-ui-write-${target.slice(target.lastIndexOf('/') + 1)}`, name: 'write', arguments: { file_path: target, content: 'DURABLE_UI_APPROVAL_BODY\n' } },
  }
}

async function jsonRequest(method, pathname, body) {
  const response = await context.request.fetch(`${origin}${pathname}`, {
    method,
    ...(body === undefined ? {} : { data: body }),
  })
  const payload = await response.json()
  return { status: response.status(), body: payload }
}

async function manifestPaths(workspaceId) {
  const manifest = await jsonRequest('GET', `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`)
  assert.equal(manifest.status, 200, JSON.stringify(manifest.body))
  return (manifest.body.entries ?? []).map(entry => entry.path)
}

async function waitDurable(turnId, expected) {
  return await waitFor(async () => {
    const status = await jsonRequest('GET', `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`)
    assert.equal(status.status, 200, JSON.stringify(status.body))
    return status.body.status === expected ? status.body : undefined
  }, `durable turn ${turnId} to settle as ${expected}`, 30_000)
}

async function sessionEvents(sessionId) {
  const read = await jsonRequest('POST', '/api/browser-native/session/read', {
    protocolVersion: 1, requestId: `durable-ui-read-${String(Date.now())}`, sessionId, offset: 0,
  })
  assert.equal(read.status, 200, JSON.stringify(read.body))
  return read.body.events
}

function assertContiguousEnvelope(events, label) {
  const seqs = events.map(event => event.seq)
  assert.deepEqual(seqs, [...Array(events.length).keys()], `${label} event seqs must stay monotonic and contiguous`)
  const first = type => events.findIndex(event => event.type === type)
  const last = type => events.findLastIndex(event => event.type === type)
  for (const type of ['turn/start', 'user/message', 'step/start', 'tool/call', 'tool/result', 'assistant/message', 'step/end', 'turn/end']) {
    assert.ok(first(type) >= 0, `${label} must persist ${type}; got ${events.map(event => event.type).join(',')}`)
  }
  assert.equal(events.filter(event => event.type === 'tool/call').length, 1)
  assert.equal(events.filter(event => event.type === 'tool/result').length, 1)
  assert.ok(first('turn/start') < first('user/message'))
  assert.ok(first('user/message') < first('step/start'))
  assert.ok(first('step/start') < first('tool/call'))
  assert.ok(first('tool/call') < first('tool/result'))
  // The model's tool-call assistant message precedes the call; the closing
  // assistant message must follow the tool result.
  assert.ok(last('assistant/message') > first('tool/result'))
  assert.ok(last('assistant/message') < last('step/end'))
  assert.ok(last('step/end') < last('turn/end'))
}

async function startDurableTurn(page, prompt) {
  return await page.evaluate(request => window.__DSH_BROWSER_NATIVE_DURABLE_TURN__(request), { prompt })
}

async function pendingPanel(page) {
  const panel = page.locator('[data-browser-native-durable-approval][data-browser-native-durable-approval-state="pending"]')
  await panel.waitFor({ state: 'visible', timeout: 30_000 })
  return panel
}

async function waitPanelState(page, state) {
  await page.waitForFunction(expected => document.querySelector('[data-browser-native-durable-approval]')
    ?.getAttribute('data-browser-native-durable-approval-state') === expected, state, { timeout: 30_000 })
}

let origin

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    durableTurnTimeoutMs: 20_000,
    testHooks: { scriptedLlmFault },
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  context.on('page', page => {
    pages.push(page)
    page.on('pageerror', error => pageErrors.push(error.message))
  })

  // Identity issues the Session and Workspace principal cookies; the durable
  // route and the manifest read both authorize through them.
  const identity = await context.request.get(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(identity.status(), 200)
  const workspaceId = (await identity.json()).workspaceId
  assert.equal(typeof workspaceId, 'string')

  const page = await context.newPage()
  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`
  await openPreview(page, previewUrl)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_DURABLE_TURN__ === 'function', undefined, { timeout: 30_000 })

  const approvedPath = '/dsh/home/workspace/durable-ui-approved.txt'
  const rejectedPath = '/dsh/home/workspace/durable-ui-rejected.txt'

  // Approval: the page shows the pending write, the keyboard approves it, and
  // the server-side turn writes the file and settles.
  const approved = await startDurableTurn(page, 'DURABLE UI APPROVAL APPROVE：请求一次需要审批的服务端写入。')
  assert.equal(typeof approved.turnId, 'string')
  assert.equal(typeof approved.sessionId, 'string')
  const approvedPanel = await pendingPanel(page)
  const approvedPanelText = await approvedPanel.innerText()
  assert.match(approvedPanelText, /Approval needed: write/)
  assert.equal(approvedPanelText.includes(approvedPath), true, 'the approval names its exact target')
  assert.match(approvedPanelText, /waiting for your decision/)
  assert.equal(await page.locator('[data-browser-native-durable-approve]').isVisible(), true)
  assert.equal(await page.locator('[data-browser-native-durable-reject]').isVisible(), true)
  assert.equal((await manifestPaths(workspaceId)).includes(approvedPath.replace('/dsh/home/workspace/', '')), false,
    'the write must not run before the approval')

  const approveButton = page.locator('[data-browser-native-durable-approve]')
  await approveButton.focus()
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-browser-native-durable-approve')), true)
  await page.keyboard.press('Enter')
  await waitPanelState(page, 'completed')
  const approvedStatus = await waitDurable(approved.turnId, 'completed')
  assert.equal(approvedStatus.status, 'completed')
  const approvedPaths = await manifestPaths(workspaceId)
  assert.equal(approvedPaths.includes('durable-ui-approved.txt'), true, 'the approved write must land in the Workspace')
  const approvedEvents = await sessionEvents(approved.sessionId)
  assertContiguousEnvelope(approvedEvents, 'approved turn')
  const approvedResult = approvedEvents.find(event => event.type === 'tool/result')
  assert.equal(approvedResult.data.message.isError, undefined, 'an approved write must not settle as a tool error')

  // Rejection: the same entry rejects with the keyboard and leaves no file.
  const rejected = await startDurableTurn(page, 'DURABLE UI APPROVAL REJECT：请求一次被拒绝的服务端写入。')
  const rejectedPanel = await pendingPanel(page)
  const rejectedPanelText = await rejectedPanel.innerText()
  assert.match(rejectedPanelText, /Approval needed: write/)
  assert.equal(rejectedPanelText.includes(rejectedPath), true, 'the rejection panel names its exact target')
  assert.equal((await manifestPaths(workspaceId)).includes('durable-ui-rejected.txt'), false,
    'the rejected target must not exist before the decision')
  const rejectButton = page.locator('[data-browser-native-durable-reject]')
  await rejectButton.focus()
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-browser-native-durable-reject')), true)
  await page.keyboard.press('Escape')
  await waitPanelState(page, 'completed')
  const rejectedStatus = await waitDurable(rejected.turnId, 'completed')
  assert.equal(rejectedStatus.status, 'completed')
  assert.equal((await manifestPaths(workspaceId)).includes('durable-ui-rejected.txt'), false,
    'a rejected write must not land in the Workspace')
  const rejectedEvents = await sessionEvents(rejected.sessionId)
  assertContiguousEnvelope(rejectedEvents, 'rejected turn')
  const rejectedResult = rejectedEvents.find(event => event.type === 'tool/result')
  assert.equal(rejectedResult.data.message.isError, true)
  assert.match(rejectedResult.data.message.content[0].text, /rejected/i)

  assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(' | ')}`)
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    scope: 'durable-ui-approval',
    approved: { turnId: approved.turnId, status: approvedStatus.status, events: approvedEvents.length, seqs: approvedEvents.at(-1).seq, wroteFile: true },
    rejected: { turnId: rejected.turnId, status: rejectedStatus.status, events: rejectedEvents.length, seqs: rejectedEvents.at(-1).seq, wroteFile: false },
    keyboard: ['Approve via Enter', 'Reject via Escape'],
    pageErrors,
  })}\n`)
} finally {
  await browser?.close()
  await app?.close()
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}
