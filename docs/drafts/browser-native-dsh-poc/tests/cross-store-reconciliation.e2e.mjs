import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitForPreview } from './runtime-test-support.mjs'

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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-cross-store-reconciliation-e2e-')))

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')

let image
let app
let browser
let context
let page
const requests = []
const pageErrors = []

async function readWorkspaceRecord(workspaceId) {
  return await page.evaluate(async id => await new Promise((resolveRecord, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1')
    request.onerror = () => reject(request.error ?? new Error('Workspace metadata database open failed'))
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('workspace', 'readonly')
      const read = transaction.objectStore('workspace').get(id)
      read.onerror = () => reject(read.error ?? new Error('Workspace metadata read failed'))
      read.onsuccess = () => {
        database.close()
        resolveRecord(read.result ?? null)
      }
    }
  }), workspaceId)
}

async function readSession(sessionId) {
  return await page.evaluate(async id => await (async () => {
    const response = await fetch('/api/browser-native/session/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId: id, offset: 0 }),
    })
    return await response.json()
  })(), sessionId)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  let failBusinessResponse = true
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted', testHooks: {
    failAfterCrossStoreBusinessEffect: () => {
      if (!failBusinessResponse) return false
      failBusinessResponse = false
      return true
    },
  } })
  const origin = await app.listen(port)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/browser-native/')) {
      let body
      try { body = request.postDataJSON() } catch { body = undefined }
      requests.push({ path: url.pathname, body })
    }
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=cross-store&preview-fixture=none`)
  await waitForPreview(page)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })

  const probe = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'cross-store-probe',
    path: '/dsh/home/workspace/cross-store-chrome.txt',
    content: 'cross-store Chrome Worker proof\n',
  }))
  assert.equal(probe?.ok, true, JSON.stringify(probe))
  assert.equal(probe?.decision, 'reconciled', JSON.stringify(probe))
  assert.equal(probe?.businessEffectCount, 1)
  assert.equal(probe?.businessResponseRecovered, true)
  assert.equal(probe?.pendingReceiptCount, 0)

  const manifest = await page.evaluate(async workspaceId => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
  )).json(), probe.workspaceId)
  assert.equal(manifest.revision, 1)
  assert.ok(manifest.entries.some(entry => entry.path === 'cross-store-chrome.txt'))
  const session = await readSession(probe.sessionId)
  assert.equal(session.events.length, 1)
  assert.equal(session.events[0].type, 'browser-native/workspace-receipt')
  assert.equal(session.durableThroughSeq, 0)
  const ledger = await page.evaluate(async ({ workspaceId, sessionId, operationId }) => await (await fetch(
    `/api/browser-native/workspace/cross-store-operation/${operationId}?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}&sessionId=${encodeURIComponent(sessionId)}`,
  )).json(), probe)
  assert.equal(ledger.decision.decision, 'reconciled')
  assert.equal(ledger.businessEffectCount, 1)
  const localRecord = await readWorkspaceRecord(probe.workspaceId)
  assert.deepEqual(localRecord.receipts ?? [], [])
  assert.equal(requests.filter(request => request.path.endsWith('/cross-store-operation/business')).length, 1)
  assert.equal(requests.filter(request => request.path.endsWith('/workspace/commit')).length, 1)
  assert.equal(requests.filter(request => request.path.endsWith('/session/append')
    && request.body?.sessionId === probe.sessionId).length, 1)
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'Worker-OPFS-IndexedDB-cross-store-checkpoint-reconciliation',
    workspaceId: probe.workspaceId,
    sessionId: probe.sessionId,
    operationId: probe.operationId,
    workspaceRevision: probe.workspaceRevision,
    sessionSeq: probe.sessionSeq,
    businessEffectCount: probe.businessEffectCount,
    businessResponseRecovered: probe.businessResponseRecovered,
    decision: probe.decision,
    workspaceCommitCount: requests.filter(request => request.path.endsWith('/workspace/commit')).length,
    pageErrors,
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    requests: requests.map(request => ({ path: request.path, operationId: request.body?.operationId })),
    pageErrors,
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
