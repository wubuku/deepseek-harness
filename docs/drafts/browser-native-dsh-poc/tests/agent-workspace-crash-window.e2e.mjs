import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sessionRequest, submitPrompt, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-crash-window-')))
const workspacePath = '/dsh/home/workspace/crash-window.txt'
const prompt = 'BROWSER_NATIVE_WORKSPACE_CRASH_WINDOW_E2E：创建 crash-window.txt。'

async function readLocalRecord(page, workspaceId) {
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

async function readManifest(page, workspaceId) {
  return await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
}

async function readLocalBlob(page, workspaceId, hash) {
  return await page.evaluate(async ({ id, blobHash }) => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
    const file = await directory.getFileHandle(blobHash)
    return await (await file.getFile()).text()
  }, { id: workspaceId, blobHash: hash })
}

function resultFor(session, callId) {
  return session.events.find(event => event.type === 'tool/result'
    && (event.data.callId === callId || event.data.toolCallId === callId
      || event.data.message?.toolCallId === callId))
}

async function runCrashCase(app, origin, stage) {
  const browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  await context.addInitScript(() => {
    const workers = []
    Object.defineProperty(window, '__dshBrowserWorkers', { value: workers })
    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args, target)
        workers.push(worker)
        return worker
      },
    })
  })
  const page = await context.newPage()
  const requests = []
  const commits = []
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
    if (url.pathname.endsWith('/workspace/commit')) commits.push(body)
  })
  try {
    await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
    await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
    const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
    assert.equal(typeof workspaceId, 'string')
    const armed = await page.evaluate(async saveStage => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
      action: 'pause-local-save', stage: saveStage,
    }), stage)
    assert.equal(armed?.ok, true, JSON.stringify(armed))

    await page.locator('[data-composer-input][contenteditable="true"]').last().fill(prompt)
    await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
    const create = await waitFor(
      () => requests.find(request => request.path.endsWith('/session/create')),
      'Session create before crash-window test',
    )
    const sessionId = create.body.sessionId
    const stopped = await waitFor(async () => {
      const state = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'local-save-state' }))
      return state?.stage === stage ? state : undefined
    }, `local persistence barrier ${stage}`, 45_000)
    assert.equal(stopped.ok, true)
    assert.equal(stopped.stage, stage)

    const beforeCrash = await waitFor(async () => {
      const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
      const call = session.events.find(event => event.type === 'tool/call' && event.data.name === 'write')
      return call === undefined ? undefined : { session, call }
    }, 'actual DSH write tool call', 15_000)
    const callId = String(beforeCrash.call.data.callId)
    assert.equal(resultFor(beforeCrash.session, callId), undefined,
      'the tool result must wait for the blocked local persistence acknowledgement')
    assert.equal(beforeCrash.session.events.some(event => event.type === 'turn/end'), false)
    const llmRequestCountBeforeCrash = requests.filter(request => request.path.endsWith('/llm')).length
    assert.ok(llmRequestCountBeforeCrash >= 1)

    const localRecordBeforeCrash = await readLocalRecord(page, workspaceId)
    const manifestBeforeCrash = await readManifest(page, workspaceId)
    assert.equal(manifestBeforeCrash.revision, 0)
    assert.equal(manifestBeforeCrash.entries.some(entry => entry.path === 'crash-window.txt'), false)
    let expectedLocalHash
    if (stage === 'before') {
      assert.equal(localRecordBeforeCrash?.pending?.length ?? 0, 0)
      assert.equal(localRecordBeforeCrash?.retryBatch, undefined)
    } else {
      const change = localRecordBeforeCrash?.pending?.find(item => item.path === 'crash-window.txt')
      assert.ok(change, 'the after-save barrier must stop after IndexedDB stores the pending mutation')
      expectedLocalHash = change.contentHash
      assert.equal(await readLocalBlob(page, workspaceId, expectedLocalHash), 'crash-window-payload\n')
    }

    await page.evaluate(() => {
      const worker = window.__dshBrowserWorkers.at(-1)
      if (worker === undefined) throw new Error('Dedicated Worker was not captured')
      worker.terminate()
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForPreview(page)
    await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
    await page.waitForFunction(expectedRevision => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
      && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === expectedRevision,
    stage === 'after' ? 1 : 0, { timeout: 30_000 })
    await new Promise(resolveDelay => setTimeout(resolveDelay, 500))

    const recovered = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const originalCalls = recovered.events.filter(event => event.type === 'tool/call' && event.data.name === 'write')
    assert.equal(originalCalls.length, 1, 'Worker reconstruction must not replay the unfinished DSH file tool')
    const recoveredResult = resultFor(recovered, callId)
    assert.ok(recoveredResult, 'Session recovery must close the unmatched tool call')
    assert.equal(recoveredResult.data.message?.isError, true)
    assert.equal(recoveredResult.data.error?.code, 'TOOL_OUTCOME_UNKNOWN')
    const recoveryText = (recoveredResult.data.message?.content ?? [])
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.match(recoveryText, /outcome is unknown/i)
    const interruptedTurnEnd = recovered.events.find(event => event.type === 'turn/end'
      && event.data.turn === beforeCrash.call.data.turn)
    if (interruptedTurnEnd !== undefined) {
      assert.notEqual(interruptedTurnEnd.data.reason?.kind, 'completed',
        'the interrupted turn must not be reported as successfully completed')
    }
    assert.equal(requests.filter(request => request.path.endsWith('/llm')).length, llmRequestCountBeforeCrash,
      'Worker reconstruction must not silently issue another model request for the interrupted turn')

    const manifestAfterCrash = await readManifest(page, workspaceId)
    const localRecordAfterCrash = await readLocalRecord(page, workspaceId)
    if (stage === 'before') {
      assert.equal(manifestAfterCrash.revision, 0)
      assert.equal(manifestAfterCrash.entries.some(entry => entry.path === 'crash-window.txt'), false)
      assert.equal(localRecordAfterCrash?.pending?.length ?? 0, 0)
      const missingVolatileFile = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
        action: 'read', path,
      }), workspacePath)
      assert.equal(missingVolatileFile?.ok, false, 'volatile bytes must not appear after Worker reconstruction')
    } else {
      assert.equal(manifestAfterCrash.revision, 1)
      const remoteFile = manifestAfterCrash.entries.find(entry => entry.path === 'crash-window.txt')
      assert.equal(remoteFile?.hash, expectedLocalHash)
      assert.equal(commits.length, 1, 'the durable pending mutation must commit exactly once after reload')
      assert.deepEqual(localRecordAfterCrash?.pending ?? [], [])
      assert.equal(localRecordAfterCrash?.retryBatch, undefined)
    }

    const continuation = await submitPrompt({
      page,
      origin,
      requests,
      sessionId,
      prompt: `BROWSER_NATIVE_CRASH_WINDOW_CONTINUE_${stage}：请继续对话，不要重放上一次文件操作。`,
      timeout: 45_000,
    })
    assert.equal(continuation.sessionId, sessionId)
    assert.equal(requests.filter(request => request.path.endsWith('/llm')).length, llmRequestCountBeforeCrash + 1,
      'one explicit follow-up must add exactly one LLM request')
    assert.equal(continuation.session.events.filter(event => event.type === 'tool/call'
      && event.data.name === 'write').length, 1, 'the follow-up must not replay the interrupted write')
    assert.equal(resultFor(continuation.session, callId)?.data.error?.code, 'TOOL_OUTCOME_UNKNOWN')
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(nonLocalRequests, [])
    return {
      stage,
      sessionId,
      workspaceId,
      callId,
      toolResultBeforeRecovery: false,
      recoveryResult: recoveredResult.data.error.code,
      manifestRevisionAfterRecovery: manifestAfterCrash.revision,
      recoveredPendingHash: expectedLocalHash,
      commitCount: commits.length,
      continuationTurn: continuation.turn,
      pageErrors,
      nonLocalRequests,
    }
  } catch (error) {
    const bodyText = page.isClosed() ? '' : await page.locator('body').innerText().catch(() => '')
    process.stderr.write(`${JSON.stringify({ stage, error: error instanceof Error ? error.message : String(error), requests: requests.map(request => request.path), commits, pageErrors, bodyText: bodyText.slice(-2500) })}\n`)
    throw error
  } finally {
    await page.close().catch(() => {})
    await context.close().catch(() => {})
    await browser.close()
  }
}

let image
let app
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  const results = []
  results.push(await runCrashCase(app, origin, 'before'))
  results.push(await runCrashCase(app, origin, 'after'))
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'real-DSH-write-crash-before-and-after-OPFS-IndexedDB-local-durable-save',
    cases: results,
  })}\n`)
} finally {
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
