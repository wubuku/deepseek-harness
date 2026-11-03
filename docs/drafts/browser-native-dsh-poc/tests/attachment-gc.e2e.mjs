import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-attachment-gc-')))
const marker = 'BROWSER_NATIVE_ATTACHMENT_READ_DONE'
const promptMarker = 'BROWSER_NATIVE_ATTACHMENT_READ_E2E'
const content = Buffer.from(`BROWSER_NATIVE_ATTACHMENT_GC_CONTENT_V1\n${'x'.repeat(8192)}`)
const hash = createHash('sha256').update(content).digest('hex')
const attachmentPath = `/dsh/home/attachments/v1/files/${hash.slice(0, 2)}/${hash}/attachment-gc-fixture.txt`
const orphanContent = 'BROWSER_NATIVE_ATTACHMENT_GC_ORPHAN_V1\n'
const orphanHash = createHash('sha256').update(orphanContent).digest('hex')
const pageErrors = []
const backendRequests = []
let image
let app
let browser
let page

async function workspaceTest(target, request) {
  return await target.evaluate(async value => {
    const test = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof test !== 'function') throw new Error('Browser-Native test port is unavailable')
    return await test(value)
  }, request)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    attachmentGcMinAgeMs: 0,
    attachmentGcSweepIntervalMs: 0,
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch {}
    backendRequests.push({ path: url.pathname, method: request.method(), body })
  })

  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await openPreview(page, previewUrl)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const workspaceId = await page.evaluate(async () => (await (await fetch('/api/browser-native/workspace/identity')).json()).workspaceId)

  const uploadResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === `/api/browser-native/workspace/attachments/${hash}`
      && response.request().method() === 'PUT'
  }, { timeout: 20_000 })
  await page.locator('input[type="file"]').last().setInputFiles({
    name: 'attachment-gc-fixture.txt',
    mimeType: 'text/plain',
    buffer: content,
  })
  const uploaded = await uploadResponse
  assert.equal(uploaded.status(), 200)
  const uploadReceipt = await uploaded.json()
  assert.equal(uploadReceipt.attachmentId, `sha256:${hash}`)
  assert.equal(uploadReceipt.bytes, content.byteLength)

  const turn = await sendTurn({
    page,
    origin,
    requests: backendRequests,
    prompt: `${promptMarker}: read ${attachmentPath} with the standard read tool and report its content.`,
    marker,
  })
  const readCall = turn.session.events.find(event => event.type === 'tool/call'
    && event.data.turn === turn.turn && event.data.name === 'read')
  assert.ok(readCall, 'the Agent must read the uploaded attachment before GC')
  const readResult = turn.session.events.find(event => event.type === 'tool/result'
    && event.data.turn === turn.turn && event.data.message?.toolCallId === readCall.data.callId)
  assert.notEqual(readResult.data.message.isError, true, 'the attachment read must succeed before GC')
  assert.match(readResult.data.message.content.map(block => block.text ?? '').join('\n'), /BROWSER_NATIVE_ATTACHMENT_GC_CONTENT_V1/)
  assert.equal(turn.session.events.some(event => event.type === 'user/message'
    && event.data.content?.some(block => block.type === 'file'
      && block.attachment.attachmentId === `sha256:${hash}`)), true,
  'the Session must durably reference the uploaded attachment')
  const durableSession = await readFile(join(dataDir, 'sessions', `${turn.sessionId}.json`), 'utf8')
  assert.equal(durableSession.includes(`sha256:${hash}`), true,
    'the attachment reference must reach the durable Session file before GC')

  const orphanUpload = await page.evaluate(async ({ attachmentHash, workspaceId, body }) => {
    const url = new URL(`/api/browser-native/workspace/attachments/${attachmentHash}`, location.origin)
    url.searchParams.set('workspaceId', workspaceId)
    url.searchParams.set('name', 'attachment-gc-orphan.txt')
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new TextEncoder().encode(body),
    })
    return { status: response.status, receipt: await response.json() }
  }, { attachmentHash: orphanHash, workspaceId, body: orphanContent })
  assert.equal(orphanUpload.status, 200)

  const gc = await page.evaluate(async workspaceId => {
    const token = await (await fetch(`/api/browser-native/workspace/attachments/gc-token?workspaceId=${encodeURIComponent(workspaceId)}`)).json()
    const response = await fetch('/api/browser-native/workspace/attachments/gc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: `attachment-gc-${Date.now()}`,
        workspaceId,
        token: token.token,
      }),
    })
    return { issued: token, result: await response.json() }
  }, workspaceId)
  assert.equal(gc.result.skipped, undefined)
  assert.deepEqual(gc.result.deleted, [orphanHash], 'GC must delete only the unreferenced object')
  assert.deepEqual(gc.result.failures, [])
  assert.equal(gc.result.scanned, 2)
  assert.equal(gc.result.kept, 1)

  const kept = await page.evaluate(async ({ attachmentHash, workspaceId }) => {
    const response = await fetch(`/api/browser-native/workspace/attachments/${attachmentHash}?workspaceId=${encodeURIComponent(workspaceId)}`)
    return { status: response.status, text: response.status === 200 ? await response.text() : '' }
  }, { attachmentHash: hash, workspaceId })
  assert.equal(kept.status, 200, 'GC must not delete an attachment referenced by a durable Session')
  assert.equal(kept.text, content.toString())

  const orphan = await page.evaluate(async ({ attachmentHash, workspaceId }) => {
    const response = await fetch(`/api/browser-native/workspace/attachments/${attachmentHash}?workspaceId=${encodeURIComponent(workspaceId)}`)
    return { status: response.status }
  }, { attachmentHash: orphanHash, workspaceId })
  assert.equal(orphan.status, 404)

  const warmProbe = await workspaceTest(page, {
    action: 'attachment-hydrate-probe',
    attachmentId: `sha256:${hash}`,
    byteLength: content.byteLength,
  })
  assert.equal(warmProbe.ok, true, JSON.stringify(warmProbe))
  assert.equal(warmProbe.verifications.length, 2, 'two hydrations must each report one verification decision')
  assert.equal(warmProbe.verifications.filter(entry => entry.mode === 'full').length <= 1, true,
    `repeat hydration must not re-hash a previously verified object: ${JSON.stringify(warmProbe.verifications)}`)
  assert.equal(warmProbe.verifications.at(-1).mode, 'cached')

  const downloadsBeforeEviction = backendRequests.filter(request => request.path.startsWith('/api/browser-native/workspace/attachments/')
    && request.method === 'GET').length
  await page.goto(`${origin}/api/browser-native/health`, { waitUntil: 'domcontentloaded' })
  const cleared = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    for await (const [name] of root.entries()) {
      if (name === 'dsh-browser-native-attachments-v1') {
        await root.removeEntry(name, { recursive: true })
        return name
      }
    }
    return undefined
  })
  assert.equal(cleared, 'dsh-browser-native-attachments-v1')
  await openPreview(page, previewUrl)
  await waitFor(async () => {
    const downloads = backendRequests.filter(request => request.path.startsWith('/api/browser-native/workspace/attachments/')
      && request.method === 'GET').length
    return downloads > downloadsBeforeEviction ? downloads : undefined
  }, 'attachment rehydration after OPFS eviction', 60_000)

  const evictedProbe = await workspaceTest(page, {
    action: 'attachment-hydrate-probe',
    attachmentId: `sha256:${hash}`,
    byteLength: content.byteLength,
  })
  assert.equal(evictedProbe.ok, true, JSON.stringify(evictedProbe))
  assert.deepEqual(evictedProbe.verifications.map(entry => entry.mode), ['cached', 'cached'],
    'after a verified re-download, repeated hydration must reuse the verification cache')
  assert.equal((await page.evaluate(async ({ attachmentHash, workspaceId }) => {
    const response = await fetch(`/api/browser-native/workspace/attachments/${attachmentHash}?workspaceId=${encodeURIComponent(workspaceId)}`)
    return response.status
  }, { attachmentHash: hash, workspaceId })), 200)

  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    browserVersion: browser.version(),
    sessionId: turn.sessionId,
    attachmentBytes: content.byteLength,
    attachmentSha256: hash,
    gc: {
      tokenGeneration: gc.issued.generation,
      scanned: gc.result.scanned,
      kept: gc.result.kept,
      deleted: gc.result.deleted,
      skipped: gc.result.skipped ?? null,
      failures: gc.result.failures,
    },
    keptAfterGc: kept.status,
    orphanAfterGc: orphan.status,
    warmProbe: warmProbe.verifications,
    evictedProbe: evictedProbe.verifications,
    rehydrateDownloads: backendRequests.filter(request => request.path.startsWith('/api/browser-native/workspace/attachments/')
      && request.method === 'GET').length - downloadsBeforeEviction,
    pageErrors,
  })}\n`)
} finally {
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
