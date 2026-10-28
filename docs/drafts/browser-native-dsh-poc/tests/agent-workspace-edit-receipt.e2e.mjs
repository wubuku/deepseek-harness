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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-agent-edit-e2e-')))
const prompt = 'BROWSER_NATIVE_WORKSPACE_EDIT_E2E：请依次创建文件、读取后编辑它，再创建第二个文件。'

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
  const commits = []
  const requests = []
  const pageErrors = []
  const nonLocalRequests = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({ path: url.pathname, body })
    if (url.pathname === '/api/browser-native/workspace/commit') commits.push(body)
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  const turn = await sendTurn({
    page,
    origin,
    requests,
    prompt,
    marker: 'BROWSER_NATIVE_WORKSPACE_EDIT_DONE',
    timeout: 45_000,
  })
  assert.equal(assistantText(turn.session, turn.turn).includes('BROWSER_NATIVE_WORKSPACE_EDIT_DONE'), true)

  const toolCalls = turn.session.events.filter(event => event.type === 'tool/call')
    .filter(event => ['write', 'read', 'edit'].includes(event.data.name))
  assert.deepEqual(toolCalls.map(event => event.data.name), ['write', 'read', 'edit', 'write'])
  const toolResults = turn.session.events.filter(event => event.type === 'tool/result')
  assert.equal(toolResults.length >= toolCalls.length, true, 'every scripted file tool call must have a Session result')

  const mutatingCalls = toolCalls.filter(event => event.data.name === 'write' || event.data.name === 'edit')
  const receipts = turn.session.events.filter(event => event.type === 'browser-native/workspace-receipt')
  assert.equal(receipts.length, 3)
  assert.deepEqual(receipts.map(event => event.data.callId), mutatingCalls.map(event => String(event.data.callId)))
  assert.deepEqual(receipts.map(event => event.data.toolName), ['write', 'edit', 'write'])
  assert.equal(new Set(receipts.map(event => event.data.operationId)).size, 3)
  assert.equal(new Set(receipts.map(event => event.data.callId)).size, 3)
  assert.deepEqual(receipts.map(event => event.data.revision), [1, 2, 3])
  assert.equal(receipts.every(event => event.ignorable === true), true)

  const identity = await page.evaluate(async () => await (await fetch('/api/browser-native/workspace/identity')).json())
  assert.equal(commits.length, 3, 'read must not create a Workspace commit')
  const committedOperations = []
  for (const commit of commits) {
    const operation = await page.evaluate(async ({ workspaceId, operationId }) => await (await fetch(
      `/api/browser-native/workspace/operation/${operationId}?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
    )).json(), { workspaceId: identity.workspaceId, operationId: commit.operationId })
    assert.equal(operation.found, true)
    committedOperations.push(operation.receipt)
  }
  assert.deepEqual(committedOperations.map(receipt => receipt.changedPaths), [
    ['agent-edit.txt'],
    ['agent-edit.txt'],
    ['agent-edit-summary.txt'],
  ])

  const manifest = await page.evaluate(async workspaceId => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
  )).json(), identity.workspaceId)
  assert.equal(manifest.revision, 3)
  const fileContents = await page.evaluate(async ({ workspaceId, entries }) => {
    const result = {}
    for (const entry of entries) {
      const response = await fetch(
        `/api/browser-native/workspace/blob/${entry.hash}?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
      )
      result[entry.path] = await response.text()
    }
    return result
  }, {
    workspaceId: identity.workspaceId,
    entries: manifest.entries.filter(entry => entry.kind === 'file'),
  })
  assert.deepEqual(fileContents, {
    'agent-edit.txt': 'alpha\nBETA\n',
    'agent-edit-summary.txt': 'edited=agent-edit.txt\n',
  })
  const localRecord = await readWorkspaceRecord(page, identity.workspaceId)
  assert.deepEqual(localRecord.receipts ?? [], [])
  assert.equal(localRecord.pending.length, 0)
  assert.equal(localRecord.retryBatch, undefined)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })))
  await page.reload({ waitUntil: 'domcontentloaded' })
  const reloadedSession = await sessionRequest(origin, 'read', { sessionId: turn.sessionId, offset: 0 })
  const reloadedReceipts = reloadedSession.events.filter(event => event.type === 'browser-native/workspace-receipt')
  assert.deepEqual(reloadedReceipts.map(event => event.data.operationId), receipts.map(event => event.data.operationId))
  assert.equal(commits.length, 3, 'Session reload must not replay successful file mutations')

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'Real-DSH-write-read-edit-write-Session-Workspace-receipts',
    sessionId: turn.sessionId,
    workspaceId: identity.workspaceId,
    toolSequence: toolCalls.map(event => ({ name: event.data.name, callId: event.data.callId })),
    receiptOperations: receipts.map(event => ({ callId: event.data.callId, operationId: event.data.operationId, revision: event.data.revision })),
    commitCount: commits.length,
    workspaceRevision: manifest.revision,
    fileContents,
    localOutboxAfterSessionFlush: localRecord.receipts ?? [],
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
