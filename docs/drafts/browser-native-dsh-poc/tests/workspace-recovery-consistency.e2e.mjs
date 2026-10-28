/** Complete Chrome Hosts verify recovery decisions using real Worker, OPFS and IndexedDB state. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const parent = resolve(process.env.DSH_POC_RECOVERY_ARTIFACT_DIR ?? tmpdir())
await mkdir(parent, { recursive: true })
const artifactDir = await mkdtemp(join(parent, 'dsh-recovery-consistency-'))
const dataDir = join(artifactDir, 'backend')
const resultPath = join(artifactDir, 'results.json')
const evidence = { result: 'running', artifactDir, dataDir, cases: [], pageErrors: [], expectedBootErrors: [], externalRequests: [], cleanupErrors: [] }
let image
let app
let browser
let origin
const contexts = new Set()

async function checkpoint(value) {
  evidence.cases.push(value)
  process.stderr.write(`${JSON.stringify(value)}\n`)
  await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`)
}

async function status(page, state) {
  await page.waitForFunction(expected => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === expected, state, { timeout: 30_000 })
}

async function hostReady(page) {
  const notice = page.getByRole('button', { name: /^(Continue|继续)$/ }).first()
  let opening = false
  await waitFor(async () => {
    if (await page.locator('[data-composer-input][contenteditable="true"]').last().isVisible()) return true
    if (await notice.isVisible()) {
      await notice.click()
      await notice.waitFor({ state: 'hidden' })
      return false
    }
    if (opening) return false
    const dialog = page.getByRole('dialog', { name: /^(Select Workspace Directory|选择工作区目录)$/ })
    if (await dialog.isVisible()) {
      const path = dialog.getByRole('textbox', { name: /^(Edit path|编辑路径)$/ })
      const edit = dialog.getByRole('button', { name: /^(Edit path|编辑路径)$/ })
      if (await edit.isVisible()) await edit.click()
      else if (await path.isVisible()) {
        await path.fill('/dsh/home/')
        await path.press('Enter')
        await dialog.getByRole('button', { name: /^(Open|打开)$/ }).click()
        opening = true
      }
    } else {
      const chooser = page.getByRole('textbox', { name: /^(Choose workspace|选择工作区)$/ }).first()
      if (await chooser.isVisible()) await chooser.click()
    }
    return false
  }, 'complete Host composer', 60_000)
}

async function action(page, input, expected = true) {
  const result = await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__(value), input)
  assert.equal(result.ok, expected, JSON.stringify(result))
  return result
}

async function localSnapshot(page, workspaceId) {
  return await page.evaluate(async id => await new Promise((resolveValue, reject) => {
    const request = indexedDB.open('dsh-browser-native-workspace-v1')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('workspace', 'readonly')
      const get = transaction.objectStore('workspace').get(id)
      let value
      get.onsuccess = () => { value = get.result }
      transaction.oncomplete = () => { database.close(); resolveValue(value) }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
  }), workspaceId)
}

async function api(context, path, body) {
  const response = await context.request.fetch(`${origin}/api/browser-native/workspace/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { data: { protocolVersion: 1, requestId: randomUUID(), ...body } }),
  })
  const value = await response.json()
  assert.equal(response.status(), 200, JSON.stringify(value))
  return value
}

async function remoteEdit(context, workspaceId, baseRevision, content) {
  const bytes = Buffer.from(content)
  const hash = createHash('sha256').update(bytes).digest('hex')
  const upload = await context.request.put(`${origin}/api/browser-native/workspace/blob/${hash}`, {
    headers: { 'content-type': 'application/octet-stream', 'x-browser-native-protocol': '1',
      'x-request-id': randomUUID(), 'x-workspace-id': workspaceId }, data: bytes,
  })
  assert.equal(upload.status(), 200, await upload.text())
  return await api(context, 'commit', { workspaceId, baseRevision, operationId: randomUUID(),
    changes: [{ path: 'value.txt', kind: 'file', mode: 0o644, hash, bytes: bytes.length }] })
}

async function exportBundle(page, workspaceId, before, expectedText, label) {
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.locator('[data-browser-native-recovery-export]').click(),
  ])
  const downloaded = await download.path()
  assert.ok(downloaded)
  const value = JSON.parse(await readFile(downloaded, 'utf8'))
  const bundle = value.workspaces?.[0] ?? value
  assert.equal(bundle.workspaceId, workspaceId)
  assert.deepEqual(bundle.metadata, before)
  assert.deepEqual(bundle.missingBlobs, [])
  assert.deepEqual(bundle.corruptBlobs, [])
  assert.deepEqual(bundle.unreadableBlobs, [])
  assert.ok(bundle.blobs.some(blob => Buffer.from(blob.base64, 'base64').toString('utf8') === expectedText && blob.hashMatches))
  assert.deepEqual(await localSnapshot(page, workspaceId), before)
  await writeFile(join(artifactDir, `${label}-export.json`), `${JSON.stringify(value, null, 2)}\n`)
  await page.screenshot({ path: join(artifactDir, `${label}.png`), fullPage: true })
  return { exportedBlobs: bundle.blobs.length, metadataUnchanged: true, originalBytesPresent: true }
}

async function runCase(name, kind) {
  const context = await browser.newContext({ locale: 'en-US', acceptDownloads: true })
  contexts.add(context)
  try {
    const page = await context.newPage()
    const commits = []
    const requests = []
    let commitMode = kind === 'committed' ? 'lost' : 'fail'
    let queryUnavailable = kind === 'committed' || kind === 'unknown'
    page.on('pageerror', error => {
      const expected = (kind === 'conflict' || kind === 'unknown')
        && /^web-preview tunnel: boot payload failed with HTTP 503: Error: (Local Workspace changes use a different remote revision|Workspace commit status is unknown)/.test(error.message)
      if (expected) evidence.expectedBootErrors.push({ name, message: error.message })
      else evidence.pageErrors.push({ name, message: error.message })
    })
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin !== origin && url.protocol.startsWith('http')) evidence.externalRequests.push(url.origin + url.pathname)
      if (url.pathname.startsWith('/api/browser-native/')) requests.push(url.pathname)
    })
    await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
      const body = route.request().postDataJSON()
      commits.push({ operationId: body.operationId, baseRevision: body.baseRevision })
      if (commitMode === 'pass') return await route.continue()
      if (commitMode === 'lost') {
        const response = await route.fetch()
        assert.equal(response.status(), 200)
        assert.equal((await response.json()).replayed, false)
        commitMode = 'fail'
      }
      return await route.fulfill({ status: 503, json: { error: { code: 'RECOVERY_TEST_503', message: 'commit response unavailable' } } })
    })
    await page.route(`${origin}/api/browser-native/workspace/operation/**`, async route => {
      if (queryUnavailable) return await route.fulfill({ status: 503, json: { error: { code: 'STATUS_UNAVAILABLE', message: 'operation query unavailable' } } })
      return await route.continue()
    })
    const url = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
    await page.goto(url)
    await hostReady(page)
    await status(page, 'synced')
    const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.workspaceId)
    const text = `${name}-original-local-bytes\n`
    await action(page, { action: 'write', path: '/dsh/home/workspace/value.txt', content: text })
    await status(page, 'error')
    const before = await localSnapshot(page, workspaceId)
    assert.ok(before.retryBatch)
    const originalId = before.retryBatch.operationId
    if (kind === 'order') {
      await action(page, { action: 'remove', path: '/dsh/home/workspace/value.txt' })
      await page.reload()
      await status(page, 'error')
      const missing = await action(page, { action: 'stat', path: '/dsh/home/workspace/value.txt' }, false)
      assert.match(missing.error, /ENOENT|not found|does not exist/i)
      const layered = await localSnapshot(page, workspaceId)
      assert.equal(layered.retryBatch.operationId, originalId)
      assert.equal(layered.pending.find(change => change.path === 'value.txt').deleted, true)
      commitMode = 'pass'
      await action(page, { action: 'flush-workspace' })
      const manifest = await api(context, `manifest?protocolVersion=1&workspaceId=${workspaceId}`)
      assert.equal(manifest.revision, 2)
      assert.deepEqual(manifest.entries, [])
      assert.equal(new Set(commits.map(commit => commit.operationId)).size, 2)
      await checkpoint({ name, retryOperationId: originalId, finalRevision: 2, finalEntries: 0,
        originalWriteThenDelete: true, committedOperations: 2 })
    } else if (kind === 'committed') {
      await remoteEdit(context, workspaceId, 1, 'newer-remote-bytes\n')
      const attempts = commits.length
      queryUnavailable = false
      await page.reload()
      await status(page, 'synced')
      await hostReady(page)
      const read = await action(page, { action: 'read', path: '/dsh/home/workspace/value.txt' })
      assert.equal(read.content, 'newer-remote-bytes\n')
      assert.equal(commits.length, attempts)
      const after = await localSnapshot(page, workspaceId)
      assert.equal(after.retryBatch, undefined)
      assert.equal(after.revision, 2)
      await checkpoint({ name, retryOperationId: originalId, latestRemoteRead: true, finalRevision: after.revision,
        duplicateCommitAttemptsAfterReload: 0, originalRetryRetired: true })
    } else {
      if (kind === 'conflict') await remoteEdit(context, workspaceId, 0, 'conflicting-remote-bytes\n')
      const attempts = commits.length
      await page.reload()
      await status(page, kind === 'conflict' ? 'conflict' : 'error')
      assert.equal(commits.length, attempts)
      assert.equal(await page.locator('[data-composer-input][contenteditable="true"]').isVisible(), false)
      const exported = await exportBundle(page, workspaceId, before, text, name)
      if (kind === 'unknown') {
        queryUnavailable = false
        commitMode = 'pass'
        await page.reload()
        await status(page, 'synced')
        await hostReady(page)
        const read = await action(page, { action: 'read', path: '/dsh/home/workspace/value.txt' })
        assert.equal(read.content, text)
        assert.ok(commits.every(commit => commit.operationId === originalId))
      }
      await checkpoint({ name, ...exported, isolatedBeforeHydrate: true, modelRequests: requests.filter(path => path.includes('/llm')).length,
        retryOperationId: originalId, resumesAfterQueryRecovery: kind === 'unknown' })
    }
    assert.equal(requests.some(path => path.includes('/llm')), false)
  } finally {
    await context.close()
    contexts.delete(context)
  }
}

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  evidence.browser = browser.version()
  await runCase('layered-write-delete', 'order')
  await runCase('divergent-baseline', 'conflict')
  await runCase('committed-before-new-remote', 'committed')
  await runCase('unknown-query-and-reconnect', 'unknown')
  assert.deepEqual(evidence.pageErrors, [])
  assert.deepEqual(evidence.externalRequests, [])
  evidence.result = 'passed'
} catch (error) {
  evidence.result = 'failed'
  evidence.error = error.stack
  throw error
} finally {
  for (const cleanup of [
    async () => { for (const context of contexts) await context.close() },
    async () => { await browser?.close() }, async () => { await app?.close() }, async () => { await image?.cleanup() },
  ]) {
    try { await cleanup() } catch (error) { evidence.cleanupErrors.push(error.message) }
  }
  await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
}
assert.deepEqual(evidence.cleanupErrors, [])
