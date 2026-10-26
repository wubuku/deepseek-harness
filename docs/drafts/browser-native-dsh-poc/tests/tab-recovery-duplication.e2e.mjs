import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-tab-recovery-`))
const leasePrefix = 'dsh.browser-native.workspace-lease.'
const pages = []
const pageIndices = new WeakMap()
const apiRequests = []
const modelRequests = []
const resumeRequests = []
const sessionRequests = []
const pageErrors = []
const externalRequests = []
let image
let app
let browser
let context
let unsupportedContext

function trackPage(page, origin) {
  if (pageIndices.has(page)) return pageIndices.get(page)
  const pageIndex = pages.push(page) - 1
  pageIndices.set(page, pageIndex)
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (url.origin === origin && url.pathname.startsWith('/api/browser-native/')) {
      const record = { page: pageIndex, path: url.pathname, method: request.method() }
      if (url.pathname === '/api/browser-native/llm' && request.method() === 'POST') {
        const body = request.postDataJSON()
        modelRequests.push({
          page: pageIndex,
          recoveredPrompt: JSON.stringify(body.messages).includes('BROWSER_NATIVE_SESSION_CONTINUED_AFTER_RECOVERY'),
        })
      }
      if (url.pathname.endsWith('/session/create') && request.method() === 'POST') {
        const body = request.postDataJSON()
        sessionRequests.push({ path: url.pathname, body: { sessionId: body.sessionId } })
      }
      if (url.pathname === '/api/browser-native/workspace/lease' && request.method() === 'POST') {
        const body = request.postDataJSON()
        record.operation = body.operation
        if (body.operation === 'resume') resumeRequests.push({ page: pageIndex, status: undefined })
      }
      apiRequests.push(record)
    }
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname === '/api/browser-native/workspace/lease' && response.request().method() === 'POST') {
      const body = response.request().postDataJSON()
      if (body.operation === 'resume') {
        const request = resumeRequests.find(item => item.page === pageIndex && item.status === undefined)
        if (request !== undefined) request.status = response.status()
      }
    }
  })
  return pageIndex
}

async function openClone(opener, url) {
  const popupPromise = opener.waitForEvent('popup')
  await opener.evaluate(value => window.open(value, '_blank'), url)
  return await popupPromise
}

async function workspaceTest(page, request) {
  return await page.evaluate(async value => {
    const test = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof test !== 'function') throw new Error('Browser-Native test port is unavailable')
    return await test(value)
  }, request)
}

async function readLease(page) {
  return await workspaceTest(page, { action: 'lease-info' })
}

async function holdsRecoveryLock(page, kind, id) {
  return await page.evaluate(async ({ resourceKind, resourceId }) => {
    const locks = await navigator.locks.query()
    const expected = `dsh.browser-native.recovery.${resourceKind}.${encodeURIComponent(resourceId)}`
    return locks.held?.some(lock => lock.name === expected) ?? false
  }, { resourceKind: kind, resourceId: id })
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  context.on('page', page => trackPage(page, origin))

  const first = await context.newPage()
  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await openPreview(first, previewUrl)
  await first.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await first.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const firstLease = await readLease(first)
  const workspaceId = await first.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  const leaseKey = `${leasePrefix}${encodeURIComponent(workspaceId)}`
  const originalRecord = await first.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), leaseKey)
  assert.equal(firstLease?.ok, true)
  assert.equal(typeof originalRecord?.resumeId, 'string')
  assert.equal(await holdsRecoveryLock(first, 'workspace', workspaceId), true)

  unsupportedContext = await browser.newContext()
  unsupportedContext.on('page', page => trackPage(page, origin))
  const unsupportedPage = await unsupportedContext.newPage()
  await unsupportedPage.addInitScript(() => {
    if (location.origin === 'null') return
    Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => undefined })
    sessionStorage.setItem('dsh.browser-native.owner.synthetic-session', 'synthetic-owner-token')
    sessionStorage.setItem('dsh.browser-native.workspace-lease.synthetic-workspace', JSON.stringify({
      workspaceId: 'synthetic-workspace',
      writerToken: 'synthetic-writer-token',
      fencingToken: 1,
      resumeId: '123e4567-e89b-12d3-a456-426614174000',
    }))
  })
  await unsupportedPage.goto(previewUrl, { waitUntil: 'domcontentloaded' })
  await unsupportedPage.waitForFunction(
    () => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'recovery-unavailable',
    undefined,
    { timeout: 30_000 },
  )
  const unsupportedPageIndex = pageIndices.get(unsupportedPage)
  assert.equal(apiRequests.some(request => request.page === unsupportedPageIndex), false)

  const duplicate = await openClone(first, previewUrl)
  const duplicatePageIndex = pageIndices.get(duplicate)
  const copiedRecord = await duplicate.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), leaseKey)
  assert.equal(copiedRecord?.writerToken, originalRecord.writerToken)
  assert.equal(copiedRecord?.resumeId, originalRecord.resumeId)
  try {
    await duplicate.waitForFunction(() => ['recovery-conflict', 'recovery-unavailable', 'lease-conflict', 'error']
      .includes(window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state ?? ''), undefined, { timeout: 10_000 })
  } catch (error) {
    const diagnostics = await duplicate.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      state: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state,
      title: document.title,
    })).catch(() => ({ url: 'unavailable', readyState: 'unavailable', state: 'unavailable', title: 'unavailable' }))
    throw new Error(`Recovery conflict did not publish status: ${JSON.stringify({ diagnostics, pageErrors, apiPaths: apiRequests.filter(request => request.page === duplicatePageIndex).map(request => request.path) })}`, { cause: error })
  }
  const duplicateState = await duplicate.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state)
  assert.equal(duplicateState, 'recovery-conflict', `duplicate page state: ${String(duplicateState)}`)
  assert.equal(apiRequests.some(request => request.page === duplicatePageIndex), false)
  assert.equal(resumeRequests.length, 0)

  await first.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
  const afterPersistedPagehide = await openClone(first, previewUrl)
  const persistedDuplicatePageIndex = pageIndices.get(afterPersistedPagehide)
  await afterPersistedPagehide.waitForFunction(
    () => ['recovery-conflict', 'recovery-unavailable', 'lease-conflict', 'error']
      .includes(window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state ?? ''),
    undefined,
    { timeout: 30_000 },
  )
  assert.equal(await afterPersistedPagehide.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state), 'recovery-conflict')
  assert.equal(apiRequests.some(request => request.page === persistedDuplicatePageIndex), false)

  const scriptedTurn = await sendTurn({
    page: first,
    origin,
    requests: sessionRequests,
    prompt: 'BROWSER_NATIVE_SCRIPTED_E2E_OK',
    marker: 'BROWSER_NATIVE_SCRIPTED_E2E_OK',
    timeout: 60_000,
  })
  const sessionId = scriptedTurn.sessionId
  const ownerKey = `dsh.browser-native.owner.${encodeURIComponent(sessionId)}`
  await first.waitForFunction(key => sessionStorage.getItem(key) !== null, ownerKey, { timeout: 10_000 })
  assert.equal(await holdsRecoveryLock(first, 'session', sessionId), true)

  const leaseRecordBeforeSessionClone = await first.evaluate(key => {
    const record = sessionStorage.getItem(key)
    sessionStorage.removeItem(key)
    return record
  }, leaseKey)
  assert.notEqual(leaseRecordBeforeSessionClone, null)
  const sessionOnlyDuplicate = await openClone(first, previewUrl)
  await first.evaluate(({ key, record }) => sessionStorage.setItem(key, record), {
    key: leaseKey,
    record: leaseRecordBeforeSessionClone,
  })
  const sessionDuplicatePageIndex = pageIndices.get(sessionOnlyDuplicate)
  const sessionOnlyCopy = await sessionOnlyDuplicate.evaluate(({ leaseStorageKey, ownerStorageKey }) => ({
    lease: sessionStorage.getItem(leaseStorageKey),
    owner: sessionStorage.getItem(ownerStorageKey),
  }), { leaseStorageKey: leaseKey, ownerStorageKey: ownerKey })
  assert.equal(sessionOnlyCopy.lease, null)
  assert.equal(sessionOnlyCopy.owner, await first.evaluate(key => sessionStorage.getItem(key), ownerKey))
  const copiedOwnerToken = await sessionOnlyDuplicate.evaluate(key => sessionStorage.getItem(key), ownerKey)
  assert.equal(typeof copiedOwnerToken, 'string')
  await sessionOnlyDuplicate.waitForFunction(
    () => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'recovery-conflict',
    undefined,
    { timeout: 30_000 },
  )
  const copiedSessionPageRequestsBeforeReload = apiRequests.some(request => request.page === sessionDuplicatePageIndex)
  assert.equal(copiedSessionPageRequestsBeforeReload, false)
  await sessionOnlyDuplicate.close()

  const duplicateWithSession = await openClone(first, previewUrl)
  const fullRecoveryCopy = await duplicateWithSession.evaluate(({ leaseStorageKey, ownerStorageKey }) => ({
    lease: sessionStorage.getItem(leaseStorageKey),
    owner: sessionStorage.getItem(ownerStorageKey),
  }), { leaseStorageKey: leaseKey, ownerStorageKey: ownerKey })
  assert.equal(typeof fullRecoveryCopy.lease, 'string')
  assert.equal(fullRecoveryCopy.owner, copiedOwnerToken)
  await duplicateWithSession.waitForFunction(
    () => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'recovery-conflict',
    undefined,
    { timeout: 30_000 },
  )

  await first.close()
  await duplicateWithSession.reload({ waitUntil: 'domcontentloaded' })
  await duplicateWithSession.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const recoveredLease = await readLease(duplicateWithSession)
  assert.equal(recoveredLease?.ok, true)
  assert.notEqual(recoveredLease?.writerToken, firstLease.writerToken)
  assert.ok(recoveredLease?.fencingToken > firstLease.fencingToken)
  assert.equal(resumeRequests.length, 1)
  assert.equal(resumeRequests[0].status, 200)
  const oldWriterRenewalStatus = await duplicateWithSession.evaluate(async ({ id, lease }) => {
    const response = await fetch('/api/browser-native/workspace/lease', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        workspaceId: id,
        operation: 'renew',
        writerToken: lease.writerToken,
        fencingToken: lease.fencingToken,
      }),
    })
    return response.status
  }, { id: workspaceId, lease: firstLease })
  assert.equal(oldWriterRenewalStatus, 409)

  const resumedPrompt = 'BROWSER_NATIVE_SESSION_CONTINUED_AFTER_RECOVERY'
  const continuedTurn = await sendTurn({
    page: duplicateWithSession,
    origin,
    requests: sessionRequests,
    sessionId,
    prompt: resumedPrompt,
    timeout: 60_000,
  })
  assert.equal(continuedTurn.session.events.filter(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(resumedPrompt)).length, 1)
  assert.equal(modelRequests.filter(request => request.recoveredPrompt).length, 1)

  const path = '/dsh/home/workspace/tab-recovery.txt'
  const commitsBeforeWrite = apiRequests.filter(request => request.path === '/api/browser-native/workspace/commit').length
  assert.equal((await workspaceTest(duplicateWithSession, { action: 'write', path, content: 'single writer resumed\n' }))?.ok, true)
  assert.equal((await workspaceTest(duplicateWithSession, { action: 'flush-workspace' }))?.ok, true)
  assert.equal((await workspaceTest(duplicateWithSession, { action: 'read', path }))?.content, 'single writer resumed\n')
  assert.equal(apiRequests.filter(request => request.path === '/api/browser-native/workspace/commit').length - commitsBeforeWrite, 1)
  assert.equal(await holdsRecoveryLock(duplicateWithSession, 'session', sessionId), true)
  assert.equal((await workspaceTest(duplicateWithSession, { action: 'release-lease' }))?.ok, true)
  await duplicateWithSession.waitForFunction(async id => {
    const locks = await navigator.locks.query()
    const name = `dsh.browser-native.recovery.workspace.${encodeURIComponent(id)}`
    return !locks.held?.some(lock => lock.name === name)
  }, workspaceId, { timeout: 10_000 })
  assert.equal(await holdsRecoveryLock(duplicateWithSession, 'session', sessionId), true)
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors))
  assert.equal(externalRequests.length, 0)

  process.stdout.write(`${JSON.stringify({
    result: 'single-writer-recovery-passed',
    browser: 'chrome',
    openerCopiedRecoveryRecord: true,
    missingWebLocksWithSavedCredentialsRejectedBeforeBackendRequests: apiRequests.some(request => request.page === unsupportedPageIndex) === false,
    workspaceOnlyDuplicateRejectedBeforeBackendRequests: apiRequests.some(request => request.page === duplicatePageIndex) === false,
    persistedPagehideKeptLock: apiRequests.some(request => request.page === persistedDuplicatePageIndex) === false,
    sessionAndWorkspaceDuplicateRejectedBeforeBackendRequests: copiedSessionPageRequestsBeforeReload === false,
    sessionOwnerRecovered: await holdsRecoveryLock(duplicateWithSession, 'session', sessionId),
    resumeRequests: resumeRequests.length,
    resumeStatus: resumeRequests[0].status,
    fencingTokenAdvanced: recoveredLease.fencingToken > firstLease.fencingToken,
    priorWriterRenewalStatus: oldWriterRenewalStatus,
    recoveredSessionContinuation: true,
    recoveredPromptModelRequests: modelRequests.filter(request => request.recoveredPrompt).length,
    recoveredWorkspaceReadWrite: true,
    workspaceLockReleasedOnLeaseRelease: true,
    apiRequestCounts: Object.fromEntries([...new Set(apiRequests.map(request => request.page))]
      .map(pageIndex => [String(pageIndex), apiRequests.filter(request => request.page === pageIndex).length])),
    pageErrors: pageErrors.length,
    externalRequests: externalRequests.length,
  })}\n`)
} finally {
  await Promise.all(pages.map(page => page.close().catch(() => {})))
  await unsupportedContext?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
