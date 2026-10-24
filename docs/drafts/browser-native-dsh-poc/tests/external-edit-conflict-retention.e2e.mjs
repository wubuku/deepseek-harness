import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-external-edit-conflict-')))
const workspacePath = '/dsh/home/workspace/external-edit-crash.txt'
const localContent = 'after\n'
const remoteContent = `remote-${randomUUID()}\n`

async function readSnapshot(page, workspaceId) {
  return await page.evaluate(async id => await new Promise((resolveSnapshot, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1', 1)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('workspace', 'readonly')
      const get = transaction.objectStore('workspace').get(id)
      get.onerror = () => reject(get.error ?? new Error('IndexedDB read failed'))
      get.onsuccess = () => {
        database.close()
        resolveSnapshot(get.result ?? null)
      }
    }
  }), workspaceId)
}

async function commitRemoteVersion(page, workspaceId, content) {
  return await page.evaluate(async ({ id, path, value }) => {
    const bytes = new TextEncoder().encode(value)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const upload = await fetch(`/api/browser-native/workspace/blob/${hash}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-browser-native-protocol': '1',
        'x-request-id': crypto.randomUUID(),
        'x-workspace-id': id,
      },
      body: bytes,
    })
    if (!upload.ok) throw new Error(`remote blob upload failed: ${upload.status} ${await upload.text()}`)
    const response = await fetch('/api/browser-native/workspace/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        workspaceId: id,
        baseRevision: 1,
        operationId: crypto.randomUUID(),
        changes: [{ path, kind: 'file', mode: 0o644, hash, bytes: bytes.byteLength }],
      }),
    })
    return { status: response.status, body: await response.json(), hash }
  }, { id: workspaceId, path: 'external-edit-crash.txt', value: content })
}

let image
let app
let browser
let context
let page
let concurrentPage
let origin
let sessionId
let workspaceId
const commitAttempts = []
const sessionCreates = []
const pageErrors = []
const nonLocalRequests = []
let blockCommits = false

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  concurrentPage = await context.newPage()
  for (const currentPage of [page, concurrentPage]) {
    currentPage.on('pageerror', error => pageErrors.push(error.message))
    currentPage.on('request', request => {
      if (new URL(request.url()).origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
      if (currentPage === page && new URL(request.url()).pathname.endsWith('/session/create')) {
        sessionCreates.push(request.postDataJSON())
      }
    })
  }
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    const body = route.request().postDataJSON()
    commitAttempts.push({ operationId: body.operationId, baseRevision: body.baseRevision })
    if (blockCommits) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ protocolVersion: 1, error: { code: 'TEST_CONCURRENT_COMMIT', message: 'commit paused for concurrent update' } }),
      })
      return
    }
    await route.continue()
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')
  const seeded = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path, content: 'before\n',
  }), workspacePath)
  assert.equal(seeded?.ok, true, JSON.stringify(seeded))
  const seedFlush = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
  assert.equal(seedFlush?.ok, true, JSON.stringify(seedFlush))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })

  blockCommits = true
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill('BROWSER_NATIVE_EXTERNAL_EDIT_CRASH_WINDOW_E2E：先读取，再把 before 编辑为 after。')
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const createRequest = await waitFor(() => sessionCreates[0], 'external edit Session creation', 15_000)
  sessionId = createRequest.sessionId
  const pending = await waitFor(async () => {
    const snapshot = await readSnapshot(page, workspaceId)
    return snapshot?.retryBatch === undefined ? undefined : snapshot
  }, 'external edit durable retry batch', 45_000)
  assert.equal((await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)).state, 'error')
  assert.equal(pending?.retryBatch?.baseRevision, 1)
  assert.equal(pending.retryBatch.changes[0].externalContent, true)
  const operationId = pending.retryBatch.operationId
  const localBeforeConflict = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'read', path }), workspacePath)
  assert.deepEqual({ ok: localBeforeConflict?.ok, content: localBeforeConflict?.content }, { ok: true, content: localContent })

  await concurrentPage.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' })
  const remoteCommit = await commitRemoteVersion(concurrentPage, workspaceId, remoteContent)
  assert.equal(remoteCommit.status, 200, JSON.stringify(remoteCommit))
  blockCommits = false
  assert.equal(remoteCommit.body.revision, 2)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'conflict', undefined, { timeout: 45_000 })
  const localAfterConflict = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'read', path }), workspacePath)
  assert.deepEqual({ ok: localAfterConflict?.ok, content: localAfterConflict?.content }, { ok: true, content: localContent })
  const conflictSnapshot = await readSnapshot(page, workspaceId)
  assert.equal(conflictSnapshot.retryBatch.operationId, operationId)
  assert.equal(conflictSnapshot.retryBatch.baseRevision, 1)
  assert.equal(conflictSnapshot.retryBatch.changes[0].externalContent, true)
  const manifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(manifest.revision, 2)
  const remoteEntry = manifest.entries.find(entry => entry.path === 'external-edit-crash.txt')
  assert.equal(remoteEntry.hash, remoteCommit.hash)
  const remote = await page.evaluate(async ({ id, hash }) => {
    const response = await fetch(`/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)
    return { status: response.status, content: await response.text() }
  }, { id: workspaceId, hash: remoteEntry.hash })
  assert.deepEqual(remote, { status: 200, content: remoteContent })
  const persisted = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
  assert.equal(persisted.events.filter(event => event.type === 'tool/call' && event.data.name === 'edit').length, 1)
  assert.ok(commitAttempts.filter(attempt => attempt.operationId === operationId).length >= 2)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'real-DSH-external-edit-CAS-conflict-retains-local-reference',
    sessionId,
    workspaceId,
    operationId,
    localContentRetained: localAfterConflict.content === localContent,
    remoteContentRetained: remote.content === remoteContent,
    remoteRevision: manifest.revision,
    matchingCommitAttempts: commitAttempts.filter(attempt => attempt.operationId === operationId).length,
    pageErrors,
    nonLocalRequests,
  })}\n`)
} finally {
  await concurrentPage?.close().catch(() => {})
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close().catch(() => {})
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
