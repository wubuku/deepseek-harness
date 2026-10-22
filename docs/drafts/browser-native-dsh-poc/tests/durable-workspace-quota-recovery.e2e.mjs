import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-quota-recovery-')))
const workspacePath = 'quota-retry.txt'
const content = `quota-retry-${randomUUID()}\n`

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

let image
let app
let browser
let context
let page
let releaseCommit
const commitGate = new Promise(resolveGate => { releaseCommit = resolveGate })
const commits = []
const pageErrors = []
const nonLocalRequests = []
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
  })
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    commits.push(route.request().postDataJSON())
    if (commits.length === 1) await commitGate
    await route.continue()
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string')

  const armed = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'quota-next-opfs-write' }))
  assert.equal(armed?.ok, true, JSON.stringify(armed))
  const write = await page.evaluate(async input => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path: `/dsh/home/workspace/${input.path}`, content: input.content,
  }), { path: workspacePath, content })
  assert.equal(write?.ok, false, JSON.stringify(write))
  assert.match(write?.error ?? '', /quota/i)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'error', undefined, { timeout: 10_000 })

  await waitFor(() => commits.length > 0, 'Workspace commit after quota retry', 30_000)
  assert.equal(commits.length, 1)
  const operationId = commits[0].operationId
  const localRecord = await readWorkspaceRecord(page, workspaceId)
  assert.equal(localRecord?.retryBatch?.operationId, operationId)
  const localChange = localRecord.retryBatch.changes.find(change => change.path === workspacePath)
  assert.equal(typeof localChange?.contentHash, 'string')
  const localBlob = await page.evaluate(async ({ id, hash }) => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
    const file = await (await directory.getFileHandle(hash)).getFile()
    return { content: await file.text(), bytes: file.size }
  }, { id: workspaceId, hash: localChange.contentHash })
  assert.deepEqual(localBlob, { content, bytes: Buffer.byteLength(content) })
  assert.equal(app.workspaces.workspaces.get(workspaceId)?.revision, 0, 'the backend must not commit before durable OPFS and IndexedDB state exists')

  releaseCommit()
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  assert.equal(app.workspaces.workspaces.get(workspaceId)?.revision, 1)
  assert.equal(commits.length, 1)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'Worker-OPFS-injected-quota-error-and-retry',
    workspaceId,
    firstWriteRejected: true,
    injectedError: write.error,
    operationId,
    commitCount: commits.length,
    finalRevision: app.workspaces.workspaces.get(workspaceId)?.revision,
    durableBeforeCommit: true,
    pageErrors,
    nonLocalRequests,
  })}\n`)
} finally {
  releaseCommit?.()
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
