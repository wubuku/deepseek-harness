import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-volatile-failure-')))
const workspacePath = 'durable-edit.txt'
const workspaceFile = `/dsh/home/workspace/${workspacePath}`
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

function toolCallFor(session, turn, name) {
  return session.events.find(event => event.type === 'tool/call'
    && event.data.turn === turn && event.data.name === name)
}

function toolResultFor(session, callId) {
  return session.events.find(event => event.type === 'tool/result'
    && (event.data.message?.toolCallId ?? event.data.toolCallId ?? event.data.callId) === callId)
}

async function workspaceManifest(page, workspaceId) {
  return await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
}

async function remoteFileText(page, workspaceId, manifest) {
  const entry = manifest.entries.find(candidate => candidate.path === workspacePath)
  assert.ok(entry, `manifest must contain ${workspacePath}`)
  return await page.evaluate(async ({ id, hash }) => await (await fetch(
    `/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).text(), { id: workspaceId, hash: entry.hash })
}

let image
let app
let browser
let page
const commits = []
const pageErrors = []
const nonLocalRequests = []
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

  const baselineWrite = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path, content: 'before\n',
  }), workspaceFile)
  assert.equal(baselineWrite?.ok, true, JSON.stringify(baselineWrite))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  const baselineManifest = await workspaceManifest(page, workspaceId)
  assert.equal(baselineManifest.revision, 1)
  assert.equal(await remoteFileText(page, workspaceId, baselineManifest), 'before\n')
  const baselineCommitCount = commits.length

  const armed = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'abort-metadata-transactions', count: 50,
  }))
  assert.equal(armed?.ok, true, JSON.stringify(armed))

  const failedTurn = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_DURABLE_EDIT_FAILURE_E2E：编辑已保存文件，然后读取它。',
    marker: 'BROWSER_NATIVE_DURABLE_EDIT_FAILURE_TURN_DONE',
    timeout: 45_000,
  })
  const failedEdit = toolCallFor(failedTurn.session, failedTurn.turn, 'edit')
  const readCalls = failedTurn.session.events.filter(event => event.type === 'tool/call'
    && event.data.turn === failedTurn.turn && event.data.name === 'read')
  const baselineRead = readCalls[0]
  const failedRead = readCalls[1]
  const failedGrep = toolCallFor(failedTurn.session, failedTurn.turn, 'grep')
  const failedGlob = toolCallFor(failedTurn.session, failedTurn.turn, 'glob')
  const failedWrite = failedTurn.session.events.find(event => event.type === 'tool/call'
    && event.data.turn === failedTurn.turn && event.data.name === 'write')
  assert.ok(baselineRead, 'the Agent must observe the file before using edit')
  assert.ok(failedEdit, 'the real DSH Agent Loop must call edit')
  assert.ok(failedRead, 'the scripted Agent must attempt a subsequent read')
  assert.ok(failedGrep, 'the scripted Agent must attempt a subsequent content search')
  assert.ok(failedGlob, 'the scripted Agent must attempt a subsequent path search')
  assert.ok(failedWrite, 'the scripted Agent must attempt a subsequent file write')
  assert.notEqual(toolResultFor(failedTurn.session, String(baselineRead.data.callId))?.data.message?.isError, true)
  const failedEditResult = toolResultFor(failedTurn.session, String(failedEdit.data.callId))
  const failedReadResult = toolResultFor(failedTurn.session, String(failedRead.data.callId))
  const failedGrepResult = toolResultFor(failedTurn.session, String(failedGrep.data.callId))
  const failedGlobResult = toolResultFor(failedTurn.session, String(failedGlob.data.callId))
  const failedWriteResult = toolResultFor(failedTurn.session, String(failedWrite.data.callId))
  assert.equal(failedEditResult?.data.message?.isError, true, JSON.stringify(failedEditResult?.data))
  assert.equal(failedReadResult?.data.message?.isError, true, JSON.stringify(failedReadResult?.data))
  assert.equal(failedGrepResult?.data.message?.isError, true, JSON.stringify(failedGrepResult?.data))
  assert.equal(failedGlobResult?.data.message?.isError, true, JSON.stringify(failedGlobResult?.data))
  assert.equal(failedWriteResult?.data.message?.isError, true, JSON.stringify(failedWriteResult?.data))
  const readError = (failedReadResult.data.message?.content ?? [])
    .filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.match(readError, /local Workspace persistence is unresolved/i, JSON.stringify(failedEditResult?.data))
  for (const result of [failedGrepResult, failedGlobResult, failedWriteResult]) {
    const message = (result.data.message?.content ?? [])
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.match(message, /local Workspace persistence is unresolved/i)
  }
  assert.equal(commits.length, baselineCommitCount, 'failed edit must not advance the remote manifest')

  const volatileRead = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'read', path,
  }), workspaceFile)
  assert.deepEqual(
    { ok: volatileRead?.ok, content: volatileRead?.content },
    { ok: true, content: 'after\n' },
    'the test-only VFS probe confirms the edit remained in Worker memory before teardown',
  )
  const failedRecord = await readWorkspaceRecord(page, workspaceId)
  assert.equal(failedRecord?.revision, baselineManifest.revision)
  assert.deepEqual(failedRecord?.pending, [])
  assert.equal(failedRecord?.retryBatch, undefined)
  const manifestAfterFailure = await workspaceManifest(page, workspaceId)
  assert.equal(manifestAfterFailure.revision, baselineManifest.revision)
  assert.equal(await remoteFileText(page, workspaceId, manifestAfterFailure), 'before\n')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  const recoveredRead = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'read', path,
  }), workspaceFile)
  assert.deepEqual(
    { ok: recoveredRead?.ok, content: recoveredRead?.content },
    { ok: true, content: 'before\n' },
    'the new Worker must restore the last durable and remote-committed content',
  )
  const reloadedSession = await sessionRequest(origin, 'read', { sessionId: failedTurn.sessionId, offset: 0 })
  assert.equal(toolResultFor(reloadedSession, String(failedEdit.data.callId))?.data.message?.isError, true)
  assert.equal(toolResultFor(reloadedSession, String(failedRead.data.callId))?.data.message?.isError, true)
  assert.equal(toolResultFor(reloadedSession, String(failedGrep.data.callId))?.data.message?.isError, true)
  assert.equal(toolResultFor(reloadedSession, String(failedWrite.data.callId))?.data.message?.isError, true)

  const retryTurn = await sendTurn({
    page,
    origin,
    requests,
    sessionId: failedTurn.sessionId,
    prompt: 'BROWSER_NATIVE_DURABLE_EDIT_RETRY_E2E：恢复后显式重试刚才的编辑。',
    marker: 'BROWSER_NATIVE_DURABLE_EDIT_RETRY_TURN_DONE',
    timeout: 45_000,
  })
  const retryEdit = toolCallFor(retryTurn.session, retryTurn.turn, 'edit')
  assert.ok(retryEdit, 'the recovered Session must execute a new edit call')
  assert.notEqual(retryEdit.data.callId, failedEdit.data.callId)
  const retryResult = toolResultFor(retryTurn.session, String(retryEdit.data.callId))
  assert.ok(retryResult)
  assert.notEqual(retryResult.data.message?.isError, true, JSON.stringify(retryResult.data))
  const retryReceipt = retryTurn.session.events.find(event => event.type === 'browser-native/workspace-receipt'
    && event.data.callId === retryEdit.data.callId)
  assert.ok(retryReceipt, 'the successful retry must receive a Session receipt')
  assert.equal(commits.length, baselineCommitCount + 1, 'the recovered edit must commit exactly once')
  assert.equal(retryReceipt.data.revision, baselineManifest.revision + 1)

  const finalManifest = await workspaceManifest(page, workspaceId)
  assert.equal(finalManifest.revision, baselineManifest.revision + 1)
  assert.equal(await remoteFileText(page, workspaceId, finalManifest), 'after\n')
  const finalRecord = await readWorkspaceRecord(page, workspaceId)
  assert.deepEqual(finalRecord?.pending, [])
  assert.equal(finalRecord?.retryBatch, undefined)
  assert.deepEqual(finalRecord?.receipts ?? [], [])
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'agent-edit-idb-failure-read-isolation-worker-reload-same-session-retry',
    failedEditCallId: failedEdit.data.callId,
    blockedReadCallId: failedRead.data.callId,
    blockedGrepCallId: failedGrep.data.callId,
    blockedGlobCallId: failedGlob.data.callId,
    blockedWriteCallId: failedWrite.data.callId,
    retryEditCallId: retryEdit.data.callId,
    volatileContentBeforeReload: volatileRead.content,
    recoveredContent: recoveredRead.content,
    finalRevision: finalManifest.revision,
    newCommitCount: commits.length - baselineCommitCount,
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
