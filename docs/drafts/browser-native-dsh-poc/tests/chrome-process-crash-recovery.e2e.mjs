import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-chrome-crash-data-')))
const profileDir = await mkdtemp(join(tmpdir(), 'dsh-chrome-crash-profile-'))
const recoveryPath = '/dsh/home/workspace/process-crash-recovery.txt'
const recoveryContent = `chrome-process-crash-${crypto.randomUUID()}\n`

if (process.platform === 'win32') throw new Error('Chrome process crash E2E requires POSIX process enumeration and SIGKILL')

function chromePidsForProfile(profile) {
  const rows = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
  const profileArgument = `--user-data-dir=${profile}`
  return rows.flatMap(row => {
    const match = row.trim().match(/^(\d+)\s+(.*)$/)
    if (match === null || !match[2].includes(profileArgument)) return []
    return [{ pid: Number(match[1]), command: match[2] }]
  })
}

function killChromeProfile(profile) {
  const processes = chromePidsForProfile(profile)
  for (const { pid } of processes) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
    }
  }
  return processes.map(({ pid }) => pid)
}

async function readWorkspaceRecord(page, workspaceId) {
  return await page.evaluate(async id => await new Promise((resolveRecord, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1')
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
let context
let page
const commitAttempts = []
const pageErrors = []
const nonLocalRequests = []
const killedPids = []
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  const url = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`

  context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    channel: process.env.DSH_POC_BROWSER ?? 'chrome',
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
  })
  page = context.pages()[0] ?? await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) nonLocalRequests.push(request.url())
    if (new URL(request.url()).pathname !== '/api/browser-native/workspace/commit') return
    const body = request.postDataJSON()
    commitAttempts.push({ operationId: body.operationId, baseRevision: body.baseRevision })
  })
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => await route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ protocolVersion: 1, error: { code: 'TEST_COMMIT_BLOCKED', message: 'commit blocked before Chrome process kill' } }),
  }))
  await openPreview(page, url)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  const write = await page.evaluate(async ({ path, content }) => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write', path, content,
  }), { path: recoveryPath, content: recoveryContent })
  assert.equal(write?.ok, true, JSON.stringify(write))
  const flush = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
  assert.equal(flush?.ok, false, 'the injected 503 must leave the operation pending locally')
  await waitFor(async () => {
    const record = await readWorkspaceRecord(page, workspaceId)
    return record?.retryBatch === undefined ? undefined : record
  }, 'durable retry before browser process kill', 30_000)
  const retryRecord = await readWorkspaceRecord(page, workspaceId)
  const operationId = retryRecord.retryBatch.operationId
  const retryChange = retryRecord.retryBatch.changes.find(change => change.path === 'process-crash-recovery.txt')
  assert.ok(retryChange?.contentHash)
  assert.equal(commitAttempts.length, 1)
  const identityCookieBefore = (await context.cookies(`${origin}/api/browser-native/workspace`))
    .find(cookie => cookie.name === 'dsh-browser-native-principal')
  assert.ok(identityCookieBefore, 'the browser must have a persistent Workspace identity cookie')
  const identityCookieHashBefore = createHash('sha256').update(identityCookieBefore.value).digest('hex')

  const profileProcesses = chromePidsForProfile(profileDir)
  assert.ok(profileProcesses.length > 1, 'the unique profile must identify the Chrome process tree')
  const browserVersion = await page.evaluate(() => navigator.userAgent)
  const terminationAt = Date.now()
  killedPids.push(...killChromeProfile(profileDir))
  await waitFor(async () => chromePidsForProfile(profileDir).length === 0, 'all Chrome processes for the isolated profile to exit', 15_000)
  page = undefined
  context = undefined

  context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    channel: process.env.DSH_POC_BROWSER ?? 'chrome',
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
  })
  const identityCookieAfter = (await context.cookies(`${origin}/api/browser-native/workspace`))
    .find(cookie => cookie.name === 'dsh-browser-native-principal')
  const identityCookieHashAfter = identityCookieAfter === undefined
    ? undefined
    : createHash('sha256').update(identityCookieAfter.value).digest('hex')
  page = context.pages()[0] ?? await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) nonLocalRequests.push(request.url())
    if (new URL(request.url()).pathname !== '/api/browser-native/workspace/commit') return
    const body = request.postDataJSON()
    commitAttempts.push({ operationId: body.operationId, baseRevision: body.baseRevision })
  })
  await openPreview(page, url)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state !== 'loading', undefined, { timeout: 30_000 })
  await waitFor(async () => page.evaluate(() => {
    const status = window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__
    return status?.state === 'synced' || status?.state === 'local-corrupt' || status?.state === 'error'
  }), 'post-crash Workspace initialization to settle', 15_000)
  const firstRestartStatus = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
  let identityRecovery = 'automatic'
  if (firstRestartStatus?.state !== 'synced' || firstRestartStatus.revision !== 1) {
    assert.notEqual(firstRestartStatus?.workspaceId, workspaceId, 'the observed limitation must be an identity change')
    assert.notEqual(identityCookieHashAfter, identityCookieHashBefore, 'the profile did not restore the original identity cookie')
    const retainedLocalState = await page.evaluate(async ({ id, hash }) => {
      const record = await new Promise((resolveRecord, reject) => {
        const request = indexedDB.open('dsh-browser-native-workspace-v1')
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
      })
      const root = await navigator.storage.getDirectory()
      const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
      const file = await (await directory.getFileHandle(hash)).getFile()
      return {
        operationId: record?.retryBatch?.operationId,
        contentHash: record?.retryBatch?.changes?.find(change => change.contentHash === hash)?.contentHash,
        blobBytes: file.size,
      }
    }, { id: workspaceId, hash: retryChange.contentHash })
    assert.deepEqual(retainedLocalState, {
      operationId,
      contentHash: retryChange.contentHash,
      blobBytes: Buffer.byteLength(recoveryContent),
    })
    const oldWorkspaceResponse = await fetch(
      `${origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
      { headers: { cookie: `${identityCookieBefore.name}=${identityCookieBefore.value}` } },
    )
    assert.equal(oldWorkspaceResponse.status, 200)
    assert.equal((await oldWorkspaceResponse.json()).revision, 0)
    await context.addCookies([identityCookieBefore])
    await page.reload({ waitUntil: 'domcontentloaded' })
    identityRecovery = 'test-harness-reinjected-original-cookie'
  }
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 45_000 })
  await waitFor(() => commitAttempts.some(attempt => attempt.operationId === operationId), 'retry of the original operationId')
  assert.equal(commitAttempts.length, 2)
  assert.deepEqual(commitAttempts.map(attempt => attempt.operationId), [operationId, operationId])
  assert.equal(commitAttempts.every(attempt => attempt.baseRevision === 0), true)
  const recovered = await page.evaluate(async ({ id, path }) => {
    const result = await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'read', path })
    const manifest = await (await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)).json()
    return { result, manifest }
  }, { id: workspaceId, path: recoveryPath })
  assert.deepEqual({ ok: recovered.result?.ok, content: recovered.result?.content }, { ok: true, content: recoveryContent })
  assert.equal(recovered.manifest.revision, 1)
  assert.equal(recovered.manifest.entries.find(entry => entry.path === 'process-crash-recovery.txt')?.hash, retryChange.contentHash)
  const afterRecord = await readWorkspaceRecord(page, workspaceId)
  assert.equal(afterRecord.retryBatch, undefined)
  assert.deepEqual(afterRecord.pending, [])
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: identityRecovery === 'automatic' ? 'passed' : 'limitation-observed-and-local-retry-restored',
    browser: 'chrome',
    scope: 'chrome-sigkill-isolated-profile-durable-retry-recovery',
    browserVersion,
    workspaceId,
    operationId,
    contentHash: retryChange.contentHash,
    identityRecovery,
    identityCookieAutomaticallyRestored: identityCookieHashAfter === identityCookieHashBefore,
    killedProcessCount: killedPids.length,
    killedPids,
    commitAttempts,
    finalRevision: recovered.manifest.revision,
    restoredContentMatches: recovered.result.content === recoveryContent,
    processTerminationAndRecoveryMs: Date.now() - terminationAt,
    pageErrors,
    nonLocalRequests,
  })}\n`)
} finally {
  if (chromePidsForProfile(profileDir).length > 0) {
    killedPids.push(...killChromeProfile(profileDir))
    await waitFor(async () => chromePidsForProfile(profileDir).length === 0, 'test Chrome cleanup', 15_000)
  }
  await context?.close().catch(error => {
    if (!(error instanceof Error) || !/closed|disconnected/i.test(error.message)) throw error
  })
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
  await rm(profileDir, { recursive: true, force: true })
}
