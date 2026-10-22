import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-conflict-retention-')))
const workspacePath = 'conflicting-edit.txt'
const localContent = `local-dirty-${randomUUID()}\n`
const remoteContent = `concurrent-remote-${randomUUID()}\n`

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

let image
let app
let browser
let context
let page
let concurrentPage
const commitAttempts = []
const pageErrors = []
const nonLocalRequests = []
let rejectFirstCommit = true
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  concurrentPage = await context.newPage()
  for (const currentPage of [page, concurrentPage]) {
    currentPage.on('pageerror', error => pageErrors.push(error.message))
    currentPage.on('request', request => {
      if (new URL(request.url()).origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
    })
  }
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    const body = route.request().postDataJSON()
    commitAttempts.push({ operationId: body.operationId, baseRevision: body.baseRevision })
    if (rejectFirstCommit) {
      rejectFirstCommit = false
      return await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ protocolVersion: 1, error: { code: 'TEST_CONCURRENT_COMMIT', message: 'first writer paused for concurrent update' } }),
      })
    }
    return await route.continue()
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')
  const localWrite = await page.evaluate(async input => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: `/dsh/home/workspace/${input.path}`, content: input.content,
  }), { path: workspacePath, content: localContent })
  assert.equal(localWrite?.ok, true, JSON.stringify(localWrite))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'error', undefined, { timeout: 30_000 })
  const localPending = await readSnapshot(page, workspaceId)
  const retry = localPending?.retryBatch
  assert.equal(retry?.changes?.[0]?.path, workspacePath)
  assert.equal(retry.baseRevision, 0)
  const originalOperationId = retry.operationId

  await concurrentPage.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' })
  const competingCommit = await concurrentPage.evaluate(async ({ id, path, content, operationId }) => {
    const identity = await (await fetch('/api/browser-native/workspace/identity')).json()
    const encoder = new TextEncoder()
    const bytes = encoder.encode(content)
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes)
    const hash = [...new Uint8Array(hashBuffer)].map(value => value.toString(16).padStart(2, '0')).join('')
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
    if (!upload.ok) throw new Error(`competing blob upload failed: ${upload.status} ${await upload.text()}`)
    const response = await fetch('/api/browser-native/workspace/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        workspaceId: identity.workspaceId,
        baseRevision: 0,
        operationId,
        changes: [{ path, kind: 'file', mode: 0o644, hash, bytes: bytes.byteLength }],
      }),
    })
    return { status: response.status, body: await response.json(), hash }
  }, { id: workspaceId, path: workspacePath, content: remoteContent, operationId: randomUUID() })
  assert.equal(competingCommit.status, 200, JSON.stringify(competingCommit))
  assert.equal(competingCommit.body.revision, 1)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'conflict', undefined, { timeout: 30_000 })
  const localRead = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'read', path }), `/dsh/home/workspace/${workspacePath}`)
  assert.deepEqual(
    { ok: localRead?.ok, content: localRead?.content },
    { ok: true, content: localContent },
  )
  const conflictSnapshot = await readSnapshot(page, workspaceId)
  assert.equal(conflictSnapshot.retryBatch.operationId, originalOperationId)
  assert.equal(conflictSnapshot.retryBatch.baseRevision, 0)
  assert.equal(conflictSnapshot.retryBatch.changes[0].path, workspacePath)
  const manifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(manifest.revision, 1)
  const remoteEntry = manifest.entries.find(entry => entry.path === workspacePath)
  assert.ok(remoteEntry)
  assert.equal(remoteEntry.hash, competingCommit.hash)
  const remote = await page.evaluate(async ({ id, hash }) => {
    const response = await fetch(`/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)
    return { status: response.status, content: await response.text() }
  }, { id: workspaceId, hash: remoteEntry.hash })
  assert.deepEqual(remote, { status: 200, content: remoteContent })
  assert.equal(commitAttempts.length, 2)
  assert.equal(commitAttempts[0].operationId, originalOperationId)
  assert.equal(commitAttempts[1].operationId, originalOperationId)
  assert.equal((await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)).state, 'conflict')
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'CAS-conflict-preserves-local-retry-and-remote-version',
    workspaceId,
    localOperationId: originalOperationId,
    localBaseRevision: 0,
    remoteRevision: manifest.revision,
    localContentRetained: localRead.content === localContent,
    remoteContentRetained: remote.content === remoteContent,
    commitAttempts: commitAttempts.length,
    pageErrors,
    nonLocalRequests,
  })}\n`)
} finally {
  await concurrentPage?.close().catch(() => {})
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
