/**
 * Multi-Workspace switcher E2E.
 *
 * Creates a second Workspace through the page control, then switches back to
 * the first, asserting each tab only lists its own files and keeps its own
 * Workspace identity across reloads.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { openPreview, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-workspace-switching-')))
const previewUrlPath = '/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=cross-store&preview-fixture=none'

const app = await createBrowserNativeV2Server({ dataDir, llmMode: 'scripted' })
const origin = await app.listen(0)
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const context = await browser.newContext({ locale: 'en-US' })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))

/** Read the page's current Workspace identity after a sync. */
async function syncedIdentity() {
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  return await page.evaluate(() => ({
    workspaceId: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId,
    revision: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision,
  }))
}

/** Read the workspace principal cookie used by the browser API. */
async function principalCookie() {
  const cookie = (await context.cookies(`${origin}/api/browser-native/workspace/list`))
    .find(candidate => candidate.name === 'dsh-browser-native-principal')
  assert.ok(cookie, 'the workspace principal cookie is present')
  return `${cookie.name}=${cookie.value}`
}

/** Commit one file to the Workspace that is active when the call starts. */
async function commitFile(identity, cookie, path, content) {
  const bytes = Buffer.from(content)
  const hash = createHash('sha256').update(bytes).digest('hex')
  const upload = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}`, {
    method: 'PUT',
    headers: {
      'x-browser-native-protocol': '1',
      'x-workspace-id': identity.workspaceId,
      'x-request-id': randomUUID(),
      'content-type': 'application/octet-stream',
      cookie,
    },
    body: bytes,
  })
  assert.equal(upload.status, 200, await upload.text())
  const commit = await fetch(`${origin}/api/browser-native/workspace/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      protocolVersion: 1,
      requestId: randomUUID(),
      workspaceId: identity.workspaceId,
      operationId: randomUUID(),
      baseRevision: identity.revision,
      changes: [{ kind: 'file', path, hash, bytes: bytes.length, mode: 0o644 }],
    }),
  })
  assert.equal(commit.status, 200, await commit.text())
}

/** Reload the preview and wait for the next Workspace sync. */
async function reloadAndSync() {
  await Promise.all([
    page.waitForEvent('load', { timeout: 60_000 }),
    page.reload({ waitUntil: 'domcontentloaded' }),
  ])
  await waitForPreview(page)
  return await syncedIdentity()
}

try {
  await openPreview(page, `${origin}${previewUrlPath}`)
  await waitForPreview(page)
  const first = await syncedIdentity()
  assert.equal(typeof first.workspaceId, 'string')
  const cookie = await principalCookie()
  await commitFile(first, cookie, 'notes/only-in-first.txt', 'first workspace only\n')
  const afterCommit = await reloadAndSync()
  assert.equal(afterCommit.workspaceId, first.workspaceId)

  await page.waitForFunction(() => document.querySelectorAll('[data-browser-native-workspace-select] option').length >= 1, undefined, { timeout: 30_000 })
  const optionsBefore = await page.evaluate(() => [...document.querySelectorAll('[data-browser-native-workspace-select] option')].map(option => option.value))
  assert.equal(optionsBefore.length, 1)

  await Promise.all([
    page.waitForEvent('load', { timeout: 60_000 }),
    page.click('[data-browser-native-workspace-create]'),
  ])
  await waitForPreview(page)
  const second = await syncedIdentity()
  assert.notEqual(second.workspaceId, first.workspaceId)
  const secondListing = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'list', path: '/dsh/home/workspace/' }))
  assert.equal(secondListing?.ok, true, JSON.stringify(secondListing))
  assert.equal(secondListing.entries.includes('only-in-first.txt'), false, 'the new Workspace must not see the first Workspace file')

  await page.waitForFunction(() => document.querySelectorAll('[data-browser-native-workspace-select] option').length === 2, undefined, { timeout: 30_000 })
  await Promise.all([
    page.waitForEvent('load', { timeout: 60_000 }),
    page.selectOption('[data-browser-native-workspace-select]', first.workspaceId),
  ])
  await waitForPreview(page)
  const switched = await syncedIdentity()
  assert.equal(switched.workspaceId, first.workspaceId, 'switch must restore the first Workspace identity')
  assert.equal(switched.revision, afterCommit.revision)
  const firstListing = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'list', path: '/dsh/home/workspace/notes' }))
  assert.equal(firstListing?.ok, true, JSON.stringify(firstListing))
  assert.equal(firstListing.entries.includes('only-in-first.txt'), true, 'switch must restore the first Workspace data')
  assert.deepEqual(pageErrors, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    firstWorkspaceId: first.workspaceId,
    secondWorkspaceId: second.workspaceId,
    switchedBack: switched.workspaceId === first.workspaceId,
  })}\n`)
} finally {
  await page.close().catch(() => {})
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
  await app.close().catch(() => {})
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
