import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-identity-loss-')))
let image
let app
let browser
let context
let page

async function readLocalWorkspace(targetPage, workspaceId) {
  return await targetPage.evaluate(async id => {
    const database = await new Promise((resolveDatabase, reject) => {
      const request = indexedDB.open('dsh-browser-native-workspace-v1')
      request.onsuccess = () => resolveDatabase(request.result)
      request.onerror = () => reject(request.error ?? new Error('Workspace metadata open failed'))
    })
    try {
      const metadata = await new Promise((resolveRecord, reject) => {
        const transaction = database.transaction('workspace', 'readonly')
        const request = transaction.objectStore('workspace').get(id)
        request.onsuccess = () => resolveRecord(request.result ?? null)
        request.onerror = () => reject(request.error ?? new Error('Workspace metadata read failed'))
      })
      let opfsFileCount = 0
      try {
        const root = await navigator.storage.getDirectory()
        const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
        for await (const entry of directory.values()) if (entry.kind === 'file') opfsFileCount += 1
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
      }
      return { metadata, opfsFileCount }
    } finally {
      database.close()
    }
  }, workspaceId)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', acceptDownloads: true })
  page = await context.newPage()
  const llmRequests = []
  const workspaceCommits = []
  const externalRequests = []
  const pageErrors = []
  const apiResponses = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin === origin && url.pathname === '/api/browser-native/workspace/identity') {
      apiResponses.push({ method: request.method(), path: url.pathname, identityMode: request.headers()['x-browser-native-identity-mode'] ?? 'create-if-missing' })
    }
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin === origin && url.pathname.startsWith('/api/browser-native/')) {
      apiResponses.push({ method: response.request().method(), path: url.pathname, status: response.status() })
    }
  })
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(url.origin)
    if (url.pathname === '/api/browser-native/llm') llmRequests.push(request)
    if (url.pathname === '/api/browser-native/workspace/commit') workspaceCommits.push(request)
  })

  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await page.goto(previewUrl, { waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const previousWorkspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof previousWorkspaceId, 'string')
  const initialIdentityCount = app.workspaces.identities.size

  const write = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write',
    path: '/dsh/home/workspace/identity-loss.txt',
    content: 'retained local cache after identity cookie loss\n',
  }))
  assert.equal(write?.ok, true)
  const flush = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
  assert.equal(flush?.ok, true)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 30_000 })
  const oldManifest = await page.evaluate(async id => {
    const response = await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)
    return { status: response.status, body: await response.json() }
  }, previousWorkspaceId)
  const oldLocal = await readLocalWorkspace(page, previousWorkspaceId)
  assert.equal(oldManifest.body.entries.some(entry => entry.path === 'identity-loss.txt'), true)
  assert.ok(oldLocal.opfsFileCount > 0)
  const llmCountBeforeIdentityLoss = llmRequests.length
  const commitCountBeforeIdentityLoss = workspaceCommits.length

  await context.clearCookies({ name: 'dsh-browser-native-principal' })
  await context.clearCookies({ name: 'dsh-browser-native-session-principal' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  try {
    await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'identity-missing', undefined, { timeout: 10_000 })
  } catch (error) {
    const diagnostics = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
    const cookieNames = (await context.cookies(origin)).map(cookie => cookie.name).sort()
    throw new Error(`Identity-loss status was not published: ${JSON.stringify({ diagnostics, pageErrors, cookieNames, identityCount: app.workspaces.identities.size, retainedMetadata: oldLocal.metadata !== null, retainedOpfsFiles: oldLocal.opfsFileCount, apiResponses })}`, { cause: error })
  }

  const current = await page.evaluate(async () => {
    const status = window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__
    const response = await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(status?.workspaceId ?? '')}`)
    return {
      workspaceId: status?.workspaceId,
      state: status?.state,
      dirtyCount: status?.dirtyCount,
      manifestStatus: response.status,
    }
  })
  const oldLocalAfter = await readLocalWorkspace(page, previousWorkspaceId)
  assert.equal(current.workspaceId, undefined)
  assert.equal(current.state, 'identity-missing')
  assert.equal(current.manifestStatus, 401)
  assert.equal(app.workspaces.identities.size, initialIdentityCount, 'missing cookies must not create a new principal')
  assert.equal(llmRequests.length, llmCountBeforeIdentityLoss, 'identity recovery must not start a model request')
  assert.equal(workspaceCommits.length, commitCountBeforeIdentityLoss, 'identity recovery must not commit a Workspace mutation')
  assert.ok(oldLocalAfter.opfsFileCount > 0)
  const recoveryStatusText = await page.locator('[data-browser-native-workspace-status]').innerText()
  assert.match(recoveryStatusText, /Local Workspace data is retained/)
  assert.match(recoveryStatusText, /64 MiB/)

  const downloadPromise = page.waitForEvent('download')
  await page.locator('[data-browser-native-recovery-export]').click()
  const download = await downloadPromise
  const bundlePath = await download.path()
  assert.ok(bundlePath)
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8'))
  assert.equal(bundle.format, 'dsh-browser-native-workspace-recovery-set-v1')
  assert.equal(bundle.workspaces.length, 1)
  assert.equal(bundle.workspaces[0].workspaceId, previousWorkspaceId)
  assert.ok(bundle.workspaces[0].blobs.length > 0)
  assert.deepEqual(externalRequests, [])

  const summary = {
    result: 'passed',
    browser: browser.version(),
    scope: 'missing-identity-cookie-with-retained-OPFS-and-IndexedDB',
    previousWorkspaceHadCommittedFile: true,
    previousLocalMetadataRetained: oldLocalAfter.metadata !== null,
    previousOpfsFilesRetained: oldLocalAfter.opfsFileCount,
    identityState: current.state,
    newPrincipalCreated: app.workspaces.identities.size !== initialIdentityCount,
    modelRequestsAfterIdentityLoss: llmRequests.length - llmCountBeforeIdentityLoss,
    workspaceCommitsAfterIdentityLoss: workspaceCommits.length - commitCountBeforeIdentityLoss,
    localRecoveryBundleWorkspaceCount: bundle.workspaces.length,
    note: 'The controlled cookie-loss case fails closed and exports retained local data. It does not model natural cookie expiry, OS crash, or restore remote Session access.',
  }
  if (process.env.DSH_POC_RESULT_FILE !== undefined) {
    await writeFile(resolve(process.env.DSH_POC_RESULT_FILE), `${JSON.stringify(summary, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} finally {
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
