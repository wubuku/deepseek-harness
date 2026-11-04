/**
 * Large-workspace sync benchmark.
 *
 * Seeds thousands of remote files through the real workspace API, then reloads
 * the preview and measures the Worker's pull of the full manifest. Prints a
 * JSON line so the performance-baseline document can cite measured numbers.
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
const fileCount = Number(process.env.DSH_POC_WORKSPACE_FILES ?? 9_990)
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-large-sync-')))
const previewUrlPath = '/preview.html?browser-native=1&browser-native-test=cross-store&preview-fixture=none'

const app = await createBrowserNativeV2Server({ dataDir, llmMode: 'scripted' })
const origin = await app.listen(0)
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const context = await browser.newContext({ locale: 'en-US' })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))

const workspaceRequests = []
let requestEpoch = 0
page.on('request', request => {
  const url = new URL(request.url())
  if (!url.pathname.startsWith('/api/browser-native/workspace/')) return
  workspaceRequests.push({ epoch: requestEpoch, at: Date.now(), path: url.pathname, method: request.method() })
})

/** Sum backend route counters matching one normalized route fragment. */
async function routeCounts(fragment) {
  const snapshot = await (await fetch(`${origin}/api/browser-native/observability/metrics`)).json()
  return Object.entries(snapshot.requests.routes)
    .filter(([route]) => route.includes(fragment))
    .reduce((sum, [, histogram]) => sum + histogram.count, 0)
}

try {
  await openPreview(page, `${origin}${previewUrlPath}`)
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const identity = await page.evaluate(() => ({
    workspaceId: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId,
    revision: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision,
  }))
  assert.equal(typeof identity.workspaceId, 'string')
  const principal = (await context.cookies(`${origin}/api/browser-native/workspace/manifest`))
    .find(cookie => cookie.name === 'dsh-browser-native-principal')
  assert.ok(principal, 'the workspace principal cookie is present')

  const files = Array.from({ length: fileCount }, (_, index) => {
    const name = `file-${String(index).padStart(5, '0')}.txt`
    const content = Buffer.from(`large workspace bench ${index}\n`)
    return { path: `bench/${name}`, hash: createHash('sha256').update(content).digest('hex'), bytes: content.length, content }
  })
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  const cookie = `${principal.name}=${principal.value}`
  const seedStartedAt = Date.now()
  let cursor = 0
  const upload = async () => {
    while (cursor < files.length) {
      const file = files[cursor++]
      const response = await fetch(`${origin}/api/browser-native/workspace/blob/${file.hash}`, {
        method: 'PUT',
        headers: {
          'x-browser-native-protocol': '1',
          'x-workspace-id': identity.workspaceId,
          'x-request-id': randomUUID(),
          'content-type': 'application/octet-stream',
          cookie,
        },
        body: file.content,
      })
      assert.equal(response.status, 200, `blob ${file.path}: ${await response.text()}`)
    }
  }
  await Promise.all(Array.from({ length: 64 }, upload))
  const commit = await fetch(`${origin}/api/browser-native/workspace/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      protocolVersion: 1,
      requestId: randomUUID(),
      workspaceId: identity.workspaceId,
      operationId: randomUUID(),
      baseRevision: identity.revision,
      changes: files.map(file => ({ kind: 'file', path: file.path, hash: file.hash, bytes: file.bytes, mode: 0o644 })),
    }),
  })
  assert.equal(commit.status, 200, await commit.clone().text())
  const receipt = await commit.json()
  const seedMs = Date.now() - seedStartedAt

  requestEpoch += 1
  const blobDownloadsBefore = await routeCounts('/workspace/blob/')
  const manifestsBefore = await routeCounts('/workspace/manifest')
  const reloadStartedAt = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(revision => {
    const status = window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__
    return status?.state === 'synced' && status?.revision === revision
  }, receipt.revision, { timeout: 120_000 })
  const syncMs = Date.now() - reloadStartedAt
  const observed = {
    status: await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__),
    listing: await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'list', path: '/dsh/home/workspace/bench' })),
  }
  assert.equal(observed.status.state, 'synced')
  assert.equal(observed.listing?.ok, true, JSON.stringify(observed.listing))
  assert.equal(observed.listing.entries.length, fileCount)
  assert.equal(observed.listing.entries.every(name => name.startsWith('file-') && name.endsWith('.txt')), true)

  const requests = workspaceRequests.filter(request => request.epoch === requestEpoch)
  const blobDownloadsAfter = await routeCounts('/workspace/blob/')
  const manifestsAfter = await routeCounts('/workspace/manifest')
  const blobDownloads = blobDownloadsAfter - blobDownloadsBefore
  const manifestPulls = manifestsAfter - manifestsBefore
  const commits = requests.filter(request => request.path.endsWith('/workspace/commit'))
  assert.equal(commits.length, 0, 'a clean pull must not write back')
  assert.equal(blobDownloads, fileCount, `expected ${String(fileCount)} blob downloads, got ${String(blobDownloads)}`)
  assert.ok(manifestPulls >= 1, 'the reload pulls the manifest at least once')
  assert.deepEqual(pageErrors, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    files: fileCount,
    totalBytes,
    seed: { ms: seedMs, filesPerSecond: Math.round(fileCount / (seedMs / 1_000)) },
    sync: { ms: syncMs, filesPerSecond: Math.round(fileCount / (syncMs / 1_000)), bytesPerSecond: Math.round(totalBytes / (syncMs / 1_000)) },
    requests: { total: requests.length, manifests: manifestPulls, blobDownloads, commits: 0 },
  })}\n`)
} finally {
  await page.close().catch(() => {})
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
  await app.close().catch(() => {})
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
