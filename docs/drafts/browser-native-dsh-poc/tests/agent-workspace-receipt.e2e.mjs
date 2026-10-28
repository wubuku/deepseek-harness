import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const port = Number(process.env.DSH_POC_PORT ?? '0')
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-agent-workspace-e2e-')))
const prompt = 'BROWSER_NATIVE_WORKSPACE_TOOL_E2E：请使用 write 工具写入工作区，然后确认。'

async function readWorkspaceRecord(page, workspaceId) {
  return await page.evaluate(async id => await new Promise((resolveRecord, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1')
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('workspace', 'readonly')
      const get = transaction.objectStore('workspace').get(id)
      get.onerror = () => reject(get.error ?? new Error('IndexedDB read failed'))
      get.onsuccess = () => {
        database.close()
        resolveRecord(get.result ?? null)
      }
    }
  }), workspaceId)
}

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')

let image
let app
let browser
let page
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(port)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  const requests = []
  const commits = []
  const pageErrors = []
  const consoleErrors = []
  const requestFailures = []
  let receiptAppendAttempts = 0
  let failFirstReceiptAppend = true
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('requestfailed', request => requestFailures.push({ url: request.url(), error: request.failure()?.errorText }))
  page.on('request', request => {
    if (!request.url().includes('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({ path: new URL(request.url()).pathname, body })
    if (new URL(request.url()).pathname.endsWith('/workspace/commit')) commits.push(body)
  })
  await page.route(`${origin}/api/browser-native/session/append`, async route => {
    const body = route.request().postDataJSON()
    if (body.events?.some(event => event.type === 'browser-native/workspace-receipt')) {
      receiptAppendAttempts += 1
      if (failFirstReceiptAppend) {
        failFirstReceiptAppend = false
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ protocolVersion: 1, error: { code: 'E2E_RECEIPT_APPEND_INTERRUPTED', message: 'receipt append interrupted once' } }),
        })
        return
      }
    }
    await route.continue()
  })

  try {
    await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ pageErrors, consoleErrors, requestFailures })}\n`)
    throw error
  }
  const turn = await sendTurn({
    page,
    origin,
    requests,
    prompt,
    marker: 'BROWSER_NATIVE_WORKSPACE_TOOL_DONE',
    timeout: 30_000,
    captureStream: true,
  })
  assert.equal(turn.streamSamples.length > 0, true, 'the final Agent message must be rendered')
  assert.equal(assistantText(turn.session, turn.turn).includes('BROWSER_NATIVE_WORKSPACE_TOOL_DONE'), true)

  const toolCall = turn.session.events
    .filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message.content ?? [])
    .find(block => block.type === 'tool-call' && block.name === 'write')
  assert.ok(toolCall, 'the DSH Agent Loop must persist the scripted write tool call')
  assert.equal(turn.session.events.some(event => event.type === 'tool/result'), true, 'the DSH Agent Loop must persist the write result')
  const workspaceEvent = turn.session.events.find(event => event.type === 'workspace/changes')
  assert.ok(workspaceEvent, 'the DSH Session must persist the Workspace change projection after the file tool')
  const callEvent = turn.session.events.find(event => event.type === 'tool/call' && event.data.callId === toolCall.id)
  assert.ok(callEvent, 'the Session tool call must be the receipt association source')
  const sessionReceipt = await waitFor(async () => {
    const current = await sessionRequest(origin, 'read', { sessionId: turn.sessionId, offset: 0 })
    return current.events.find(event => event.type === 'browser-native/workspace-receipt'
      && event.data.callId === String(callEvent.data.callId))
  }, 'durable Session Workspace receipt', 30_000)

  const identity = await page.evaluate(async () => await (await fetch('/api/browser-native/workspace/identity')).json())
  assert.equal(typeof identity.workspaceId, 'string')
  await waitFor(async () => {
    const manifest = await page.evaluate(async id => await (await fetch(
      `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
    )).json(), identity.workspaceId)
    return manifest.entries.some(entry => entry.path === 'agent-receipt.txt' && entry.kind === 'file') ? manifest : undefined
  }, 'Agent file tool Workspace commit', 30_000)
  await waitFor(() => commits.length >= 1, 'Workspace commit request', 30_000)
  const commit = commits[0]
  assert.equal(typeof commit.operationId, 'string')
  const operation = await page.evaluate(async ({ id, operationId }) => await (await fetch(
    `/api/browser-native/workspace/operation/${operationId}?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), { id: identity.workspaceId, operationId: commit.operationId })
  assert.equal(operation.found, true)
  assert.deepEqual(operation.receipt, {
    workspaceId: identity.workspaceId,
    revision: 1,
    operationId: commit.operationId,
    changedPaths: ['agent-receipt.txt'],
    digest: operation.receipt.digest,
  })
  assert.match(operation.receipt.digest, /^[a-f0-9]{64}$/)
  assert.deepEqual(sessionReceipt.data, {
    turn: callEvent.data.turn,
    step: callEvent.data.step,
    callId: String(callEvent.data.callId),
    toolName: callEvent.data.name,
    toolCallSeq: callEvent.seq,
    operationId: commit.operationId,
    workspaceId: identity.workspaceId,
    baseRevision: 0,
    revision: 1,
    manifestDigest: operation.receipt.digest,
    paths: ['agent-receipt.txt'],
    replayed: false,
  })
  assert.equal(sessionReceipt.ignorable, true, 'the PoC-only event must be marked safe to skip on unknown readers')
  assert.equal(commits.length, 1, 'one file tool call must not create duplicate Workspace commits')
  assert.equal(receiptAppendAttempts >= 2, true, 'the failed Session receipt append must retry from the outbox')
  const localRecord = await readWorkspaceRecord(page, identity.workspaceId)
  assert.deepEqual(localRecord.receipts ?? [], [], 'the local receipt outbox clears only after Session flush succeeds')
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors))

  await page.close()
  page = undefined
  await browser.close()
  browser = undefined
  await app.close()
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const restartedOrigin = await app.listen(port)
  const reopened = await sessionRequest(restartedOrigin, 'read', { sessionId: turn.sessionId, offset: 0 })
  const reopenedReceipts = reopened.events.filter(event => event.type === 'browser-native/workspace-receipt')
  assert.deepEqual(reopenedReceipts, [sessionReceipt])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'Real-DSH-Agent-file-tool-to-Workspace-receipt',
    sessionId: turn.sessionId,
    workspaceId: identity.workspaceId,
    toolName: toolCall.name,
    workspaceEvent: workspaceEvent.type,
    operationId: commit.operationId,
    sessionReceiptSeq: sessionReceipt.seq,
    sessionReceiptIgnorable: sessionReceipt.ignorable,
    receiptAppendAttempts,
    localOutboxAfterSessionFlush: localRecord.receipts ?? [],
    pageErrors,
    consoleErrors,
    requestFailures,
    revision: operation.receipt.revision,
    streamSamples: turn.streamSamples.length,
    sessionEventTypes: [...new Set(turn.session.events.map(event => event.type))],
    browserApiRoutes: [...new Set(requests.map(request => request.path))],
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
