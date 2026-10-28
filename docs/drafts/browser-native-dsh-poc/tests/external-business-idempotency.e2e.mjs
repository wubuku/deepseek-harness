import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createExternalBusinessService } from '../external-business-service.mjs'
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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-external-business-backend-')))
const businessDataDir = resolve(process.env.DSH_POC_BUSINESS_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-external-business-service-')))

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')

let image
let app
let businessService
let browser
let context
let page
let dropNextResponse = true
let queryUnavailable = false
let failBeforeLedger = false
const unknownOperationId = randomUUID()
const unknownSessionId = randomUUID()

async function businessRecord(operationId) {
  const record = businessService.store.records.get(operationId)
  assert.ok(record, `missing external business record ${operationId}`)
  return record
}

async function readLedger(operationId, workspaceId, sessionId) {
  return await page.evaluate(async ({ operationId, workspaceId, sessionId }) => {
    const response = await fetch(`/api/browser-native/workspace/cross-store-operation/${operationId}?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}&sessionId=${encodeURIComponent(sessionId)}`)
    return { ok: response.ok, status: response.status, value: await response.json() }
  }, { operationId, workspaceId, sessionId })
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  businessService = await createExternalBusinessService({
    dataDir: businessDataDir,
    testHooks: {
      dropEffectResponse: () => {
        if (!dropNextResponse) return false
        dropNextResponse = false
        return true
      },
      failQuery: () => queryUnavailable,
    },
  })
  const businessOrigin = await businessService.listen()
  const businessPort = Number(new URL(businessOrigin).port)
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    businessServiceOrigin: businessOrigin,
    testHooks: {
      failAfterExternalBusinessEffectBeforeLedger: () => {
        if (!failBeforeLedger) return false
        failBeforeLedger = false
        return true
      },
    },
  })
  const origin = await app.listen(port)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=cross-store&preview-fixture=none`)
  await waitForPreview(page)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })

  const responseLoss = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'cross-store-probe',
    path: '/dsh/home/workspace/external-response-loss.txt',
    content: 'external business response loss\n',
  }))
  assert.equal(responseLoss?.ok, true, JSON.stringify(responseLoss))
  assert.equal(responseLoss?.businessResponseRecovered, true)
  assert.equal(responseLoss?.businessEffectCount, 1)
  assert.equal((await businessRecord(responseLoss.operationId)).effectCount, 1)

  await businessService.close()
  businessService = await createExternalBusinessService({
    dataDir: businessDataDir,
    port: businessPort,
    testHooks: {
      dropEffectResponse: () => {
        if (!dropNextResponse) return false
        dropNextResponse = false
        return true
      },
      failQuery: () => queryUnavailable,
    },
  })
  await businessService.listen()
  const afterRestart = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'cross-store-probe',
    path: '/dsh/home/workspace/external-service-restart.txt',
    content: 'external business service restart\n',
  }))
  assert.equal(afterRestart?.ok, true, JSON.stringify(afterRestart))
  assert.equal(afterRestart?.businessEffectCount, 1)
  assert.equal((await businessRecord(afterRestart.operationId)).effectCount, 1)

  failBeforeLedger = true
  const backendGap = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'cross-store-probe',
    path: '/dsh/home/workspace/external-ledger-gap.txt',
    content: 'external effect before DSH ledger\n',
  }))
  assert.equal(backendGap?.ok, true, JSON.stringify(backendGap))
  assert.equal(backendGap?.businessResponseRecovered, true)
  assert.equal((await businessRecord(backendGap.operationId)).effectCount, 1)

  queryUnavailable = true
  dropNextResponse = true
  const unknown = await page.evaluate(async ({ unknownOperationId, unknownSessionId }) => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'cross-store-probe',
    operationId: unknownOperationId,
    sessionId: unknownSessionId,
    path: '/dsh/home/workspace/external-query-unknown.txt',
    content: 'external query unavailable\n',
  }), { unknownOperationId, unknownSessionId })
  assert.equal(unknown?.ok, false, JSON.stringify(unknown))
  assert.match(String(unknown.error), /unknown/i)
  const unknownLedger = await readLedger(unknownOperationId, responseLoss.workspaceId, unknownSessionId)
  assert.equal(unknownLedger.ok, true, JSON.stringify(unknownLedger.value))
  assert.equal(unknownLedger.value.receipts.business, undefined)
  queryUnavailable = false
  const settledLedger = await readLedger(unknownOperationId, responseLoss.workspaceId, unknownSessionId)
  assert.equal(settledLedger.ok, true)
  assert.equal(settledLedger.value.receipts.business.status, 'committed')
  assert.equal((await businessRecord(unknownOperationId)).effectCount, 1)

  const conflict = await page.evaluate(async operationId => {
    const response = await fetch('/api/browser-native/workspace/cross-store-operation/business', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), operationId, payload: { changed: true } }),
    })
    return { status: response.status, body: await response.json() }
  }, responseLoss.operationId)
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'OPERATION_ID_REUSED')
  assert.equal((await businessRecord(responseLoss.operationId)).effectCount, 1)
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'real-DSH-Worker-OPFS-IndexedDB-independent-business-idempotency',
    scenarios: ['response-loss', 'business-service-restart', 'backend-ledger-gap', 'query-unknown', 'payload-conflict'],
    effectCounts: [responseLoss, afterRestart, backendGap].map(item => item.businessEffectCount),
    unknownRemainedUnconfirmed: unknownLedger.value.receipts.business === undefined,
    conflictStatus: conflict.status,
    pageErrors,
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({ failure: error instanceof Error ? error.message : String(error) })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await businessService?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
  if (process.env.DSH_POC_BUSINESS_DATA_DIR === undefined) await rm(businessDataDir, { recursive: true, force: true })
}
