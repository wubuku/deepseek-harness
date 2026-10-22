import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-durable-tool-ack-')))
const workspacePath = 'durable-ack.txt'
const workspaceContent = 'durable acknowledgement retry succeeded\n'
const requests = []

async function readWorkspaceRecord(page, workspaceId) {
  return await page.evaluate(async id => await new Promise((resolveRecord, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1', 1)
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

async function readOpfsBlob(page, workspaceId, hash) {
  return await page.evaluate(async ({ id, blobHash }) => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
    const file = await (await directory.getFileHandle(blobHash)).getFile()
    return await file.text()
  }, { id: workspaceId, blobHash: hash })
}

function toolResultFor(session, callId) {
  return session.events.find(event => event.type === 'tool/result'
    && (event.data.message?.toolCallId ?? event.data.toolCallId ?? event.data.callId) === callId)
}

let image
let app
let browser
let page
const commits = []
const pageErrors = []
const nonLocalRequests = []
let durableCommitProbe
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
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

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    const requestBody = route.request().postDataJSON()
    const snapshot = await readWorkspaceRecord(page, workspaceId)
    const retryChange = snapshot?.retryBatch?.changes.find(change => change.path === workspacePath)
    durableCommitProbe = {
      operationIdMatches: snapshot?.retryBatch?.operationId === requestBody.operationId,
      retryChangePresent: retryChange !== undefined,
      opfsContent: typeof retryChange?.contentHash === 'string'
        ? await readOpfsBlob(page, workspaceId, retryChange.contentHash)
        : undefined,
    }
    await route.continue()
  })

  const armed = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'abort-next-metadata-transaction',
  }))
  assert.equal(armed?.ok, true, JSON.stringify(armed))

  const failedTurn = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_DURABLE_ACK_FAILURE_E2E：请将指定内容写入工作区文件。',
    marker: 'BROWSER_NATIVE_DURABLE_ACK_FAILURE_TURN_DONE',
    timeout: 45_000,
  })
  const failedCall = failedTurn.session.events.find(event => event.type === 'tool/call'
    && event.data.name === 'write' && event.data.turn === failedTurn.turn)
  assert.ok(failedCall, 'the actual DSH Agent Loop must call the write tool')
  const failedResult = toolResultFor(failedTurn.session, String(failedCall.data.callId))
  assert.ok(failedResult, 'the write call must have a persisted Session result')
  assert.equal(failedResult.data.message?.isError, true, JSON.stringify(failedResult.data))
  const failureText = (failedResult.data.message?.content ?? [])
    .filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.match(failureText, /local Workspace persistence was not confirmed/i)
  assert.equal(commits.length, 0, 'a locally unconfirmed write must not commit remotely')
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'error', undefined, { timeout: 10_000 })

  const failedRecord = await readWorkspaceRecord(page, workspaceId)
  const savedChanges = [
    ...(failedRecord?.pending ?? []),
    ...(failedRecord?.retryBatch?.changes ?? []),
  ]
  assert.equal(savedChanges.some(change => change.path === workspacePath), false,
    'the aborted snapshot must not claim the file is durable')
  const manifestAfterFailure = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(manifestAfterFailure.revision, 0)
  assert.equal(manifestAfterFailure.entries.some(entry => entry.path === workspacePath), false)

  const retryTurn = await sendTurn({
    page,
    origin,
    requests,
    sessionId: failedTurn.sessionId,
    prompt: 'BROWSER_NATIVE_DURABLE_ACK_RETRY_E2E：请在同一会话中重试相同的幂等写入。',
    marker: 'BROWSER_NATIVE_DURABLE_ACK_RETRY_TURN_DONE',
    timeout: 45_000,
  })
  const retryCall = retryTurn.session.events.find(event => event.type === 'tool/call'
    && event.data.name === 'write' && event.data.turn === retryTurn.turn)
  assert.ok(retryCall)
  const retryResult = toolResultFor(retryTurn.session, String(retryCall.data.callId))
  assert.ok(retryResult)
  assert.notEqual(retryResult.data.message?.isError, true, JSON.stringify(retryResult.data))
  assert.equal(commits.length, 1)
  assert.equal(durableCommitProbe?.operationIdMatches, true)
  assert.equal(durableCommitProbe?.retryChangePresent, true)
  assert.equal(durableCommitProbe?.opfsContent, workspaceContent)
  assert.equal(commits[0].changes.some(change => change.path === workspacePath), true)

  const receipt = retryTurn.session.events.find(event => event.type === 'browser-native/workspace-receipt'
    && event.data.callId === retryCall.data.callId)
  assert.ok(receipt, 'the durable retry must receive a Session receipt')
  assert.equal(assistantText(retryTurn.session, failedTurn.turn).includes('BROWSER_NATIVE_DURABLE_ACK_FAILURE_TURN_DONE'), true)
  const finalManifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(finalManifest.revision, 1)
  const committedEntry = finalManifest.entries.find(entry => entry.path === workspacePath)
  assert.ok(committedEntry)
  const committedContent = await page.evaluate(async ({ id, hash }) => await (await fetch(
    `/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).text(), { id: workspaceId, hash: committedEntry.hash })
  assert.equal(committedContent, workspaceContent)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  const recovered = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'read', path,
  }), `/dsh/home/workspace/${workspacePath}`)
  assert.deepEqual({ ok: recovered?.ok, content: recovered?.content }, { ok: true, content: workspaceContent })
  assert.equal(commits.length, 1, 'refresh must not replay the completed Workspace commit')
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'real-DSH-write-local-durable-error-and-same-session-retry',
    sessionId: retryTurn.sessionId,
    workspaceId,
    firstToolError: failureText,
    initialRemoteRevision: manifestAfterFailure.revision,
    retryRemoteRevision: finalManifest.revision,
    retryReceiptOperationId: receipt.data.operationId,
    commitCountAfterRefresh: commits.length,
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
