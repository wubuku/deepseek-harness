/**
 * Per-principal export and retention cleanup against the Browser-native backend.
 *
 * Run A (retention disabled) seeds two principals with one turn each and a
 * workspace file each, exports principal A, then checks the bundle against the
 * live stores: every A Session is present with its event log, workspace blobs
 * and attachments hash-verify, usage entries and the cost report match the
 * audit endpoint, no B data appears, and a tampered bundle is rejected.
 *
 * Run B (two-second retention) proves elapsed data cannot be read back: reads
 * and appends return SESSION_EXPIRED before any sweep, the export drops the
 * Session, the usage ledger excludes it, and the sweep then removes the file.
 *
 * Both runs drive the real OpenAI-compatible provider client against a local
 * upstream that streams OpenAI chunks with usage, so the usage ledger, cost
 * report, and retention paths run without a key or an external quota.
 *
 * Usage:
 *   node docs/drafts/browser-native-dsh-poc/tests/principal-data.e2e.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { verifyPrincipalExport } from '../principal-export.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const llmTimeoutMs = Number(process.env.DSH_POC_PRINCIPAL_DATA_LLM_TIMEOUT_MS ?? 240_000)
const MARKER = 'PRINCIPAL_DATA_DONE'

/** OpenAI-compatible SSE upstream: answers with the requested marker and reports usage. */
async function startFakeUpstream() {
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch {}
      const text = Array.isArray(body.messages)
        ? body.messages.filter(message => message.role === 'user')
          .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
        : ''
      const marker = text.match(/exactly ([A-Z_0-9]+)/)?.[1] ?? 'OK'
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write(`data: ${JSON.stringify({ id: 'local-upstream', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: marker } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({
        id: 'local-upstream',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 320, completion_tokens: 7, total_tokens: 327, prompt_tokens_details: { cached_tokens: 256 } },
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

async function startBackend({ image, dataDir, upstream, retentionDays, retentionSweepMs }) {
  const app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'real',
    llmProviderKind: 'openai',
    model: 'local-upstream',
    llmBaseUrl: upstream.baseUrl,
    llmCompletionsPath: 'v1/chat/completions',
    llmApiKey: 'local-upstream-key',
    llmTimeoutMs,
    llmIncludeUsage: true,
    ...(retentionDays === undefined ? {} : { retentionDays }),
    ...(retentionSweepMs === undefined ? {} : { retentionSweepMs }),
  })
  return { app, origin: await app.listen(0) }
}

async function openPrincipal({ browser, origin, label }) {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const requests = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin || !url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    requests.push({ path: url.pathname, body })
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=approval-integrity&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 120_000 })
  const identity = await page.evaluate(async () =>
    await (await fetch('/api/browser-native/workspace/identity')).json())
  return { label, context, page, requests, pageErrors, identity }
}

async function writeWorkspaceFile(principal, path, content) {
  const written = await principal.page.evaluate(async ({ path, content }) =>
    await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__({ action: 'write', path, content }), { path, content })
  assert.equal(written?.ok, true, `workspace write failed: ${JSON.stringify(written)}`)
  await principal.page.waitForFunction(() => {
    const status = window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__
    return status?.state === 'synced' && status?.dirtyCount === 0
  }, undefined, { timeout: 120_000 })
  const manifest = await principal.page.evaluate(async workspaceId =>
    await (await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`)).json(),
  principal.identity.workspaceId)
  const entry = manifest.entries.find(item => item.path === path.replace('/dsh/home/workspace/', ''))
  assert.ok(entry !== undefined, `the manifest must publish ${path}`)
  const blob = await principal.page.evaluate(async ({ workspaceId, hash }) =>
    await (await fetch(`/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`)).text(),
  { workspaceId: principal.identity.workspaceId, hash: entry.hash })
  assert.equal(blob, content, 'the durable blob must hold the written content')
  return entry.hash
}

async function getJson(page, path) {
  return await page.evaluate(async target => await (await fetch(target)).json(), path)
}

async function exportPrincipal({ page }) {
  return await page.evaluate(async () => {
    const response = await fetch('/api/browser-native/workspace/principal-export')
    if (!response.ok) throw new Error(`export failed: ${response.status} ${await response.text()}`)
    return await response.json()
  })
}

const browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
const cleanup = []
const summary = {}

try {
  const image = await createRuntimeValidationDist({ roster: 'browser' })
  cleanup.push(image)
  const upstream = await startFakeUpstream()
  cleanup.push(upstream)

  // Run A: retention disabled, two principals.
  const exportDir = await mkdtemp(join(tmpdir(), 'dsh-principal-export-'))
  cleanup.push({ cleanup: () => rm(exportDir, { recursive: true, force: true }) })
  const exported = await startBackend({ image, dataDir: exportDir, upstream })
  cleanup.push(exported.app)
  const alice = await openPrincipal({ browser, origin: exported.origin, label: 'alice' })
  const bob = await openPrincipal({ browser, origin: exported.origin, label: 'bob' })
  cleanup.push(alice.context, bob.context)
  assert.notEqual(alice.identity.workspaceId, bob.identity.workspaceId, 'browser contexts must hold distinct workspaces')

  const aliceTurn = await sendTurn({
    page: alice.page, origin: exported.origin, requests: alice.requests,
    prompt: `Reply with exactly ALICE_${MARKER}. Do not use any tools.`, marker: `ALICE_${MARKER}`, timeout: llmTimeoutMs * 2,
  })
  const bobTurn = await sendTurn({
    page: bob.page, origin: exported.origin, requests: bob.requests,
    prompt: `Reply with exactly BOB_${MARKER}. Do not use any tools.`, marker: `BOB_${MARKER}`, timeout: llmTimeoutMs * 2,
  })
  const aliceFile = `/dsh/home/workspace/principal-data-${alice.identity.workspaceId.slice(0, 8)}.txt`
  const aliceContent = `principal-data export note ${alice.identity.workspaceId}`
  await writeWorkspaceFile(alice, aliceFile, aliceContent)
  await writeWorkspaceFile(bob, `/dsh/home/workspace/principal-data-bob.txt`, `foreign note ${bob.identity.workspaceId}`)

  // A published attachment blob in the store layout the exporter reads.
  const attachmentHash = createHash('sha256').update('attachment-bytes').digest('hex')
  const attachmentDirectory = join(exportDir, 'attachments-v1', alice.identity.workspaceId, attachmentHash.slice(0, 2))
  await mkdir(attachmentDirectory, { recursive: true })
  await writeFile(join(attachmentDirectory, attachmentHash), 'attachment-bytes')

  const bundle = await exportPrincipal({ page: alice.page })
  verifyPrincipalExport(bundle)
  const bobBundle = await exportPrincipal({ page: bob.page })
  assert.notEqual(bundle.principalId, bobBundle.principalId, 'each browser context must export its own principal')
  assert.equal(bundle.workspaceId, alice.identity.workspaceId)
  assert.equal(bundle.workspace?.owner, bundle.principalId)
  assert.deepEqual(bundle.sessions.map(session => session.id), [aliceTurn.sessionId])
  assert.deepEqual(bobBundle.sessions.map(session => session.id), [bobTurn.sessionId])
  assert.ok(bundle.counts.sessionEvents > 0)
  assert.ok(bundle.counts.workspaceBlobs >= 1, `export must carry workspace blobs; counts=${JSON.stringify(bundle.counts)}`)
  assert.equal(bundle.counts.attachments, 1)
  assert.ok(bundle.usage.length > 0, `export must carry usage entries; counts=${JSON.stringify(bundle.counts)}`)
  assert.ok(bundle.usage.every(entry => entry.principalId === bundle.principalId))
  assert.equal(bundle.cost.totals.requests, bundle.usage.length)
  const usageAudit = await getJson(alice.page, '/api/browser-native/usage-audit')
  assert.deepEqual(bundle.usage.map(entry => entry.requestId).sort(),
    usageAudit.entries.filter(entry => entry.principalId === bundle.principalId).map(entry => entry.requestId).sort())

  const serialized = JSON.stringify(bundle)
  assert.equal(serialized.includes(bobBundle.principalId), false, 'export must not contain another principal id')
  assert.equal(serialized.includes(bobTurn.sessionId), false, 'export must not contain another principal Session')
  assert.equal(serialized.includes(`BOB_${MARKER}`), false, 'export must not contain another principal content')
  assert.equal(serialized.includes(bob.identity.workspaceId), false, 'export must not contain another principal workspace')
  assert.deepEqual(alice.pageErrors, [])

  const tampered = structuredClone(bundle)
  tampered.attachments[0].bytesBase64 = Buffer.from('other-bytes').toString('base64')
  assert.throws(() => verifyPrincipalExport(tampered), /principal export verification failed/)

  summary.export = {
    sessions: bundle.counts.sessions,
    sessionEvents: bundle.counts.sessionEvents,
    workspaceBlobs: bundle.counts.workspaceBlobs,
    attachments: bundle.counts.attachments,
    usageEntries: bundle.counts.usageEntries,
    costRequests: bundle.cost.totals.requests,
    digest: bundle.digest.slice(0, 16),
  }
  await exported.app.close()

  // Run B: two-second retention, five-second sweep.
  const retentionDir = await mkdtemp(join(tmpdir(), 'dsh-principal-retention-'))
  cleanup.push({ cleanup: () => rm(retentionDir, { recursive: true, force: true }) })
  const retained = await startBackend({
    image, dataDir: retentionDir, upstream, retentionDays: 2 / 86_400, retentionSweepMs: 5_000,
  })
  cleanup.push(retained.app)
  const carol = await openPrincipal({ browser, origin: retained.origin, label: 'carol' })
  cleanup.push(carol.context)
  const carolTurn = await sendTurn({
    page: carol.page, origin: retained.origin, requests: carol.requests,
    prompt: `Reply with exactly CAROL_${MARKER}. Do not use any tools.`, marker: `CAROL_${MARKER}`, timeout: llmTimeoutMs * 2,
  })
  const sessionFile = join(retentionDir, 'sessions', `${carolTurn.sessionId}.json`)
  const before = (await stat(sessionFile)).mtimeMs
  assert.ok(Number.isFinite(before))

  await waitFor(async () => {
    const read = await sessionRequest(retained.origin, 'read', { sessionId: carolTurn.sessionId, offset: 0 })
    return read.status === 410 ? read : undefined
  }, 'Session retention must reject reads before the sweep runs', 60_000)
  const expiredRead = await sessionRequest(retained.origin, 'read', { sessionId: carolTurn.sessionId, offset: 0 })
  assert.equal(expiredRead.error.code, 'SESSION_EXPIRED')
  const expiredAppend = await sessionRequest(retained.origin, 'append', {
    sessionId: carolTurn.sessionId, event: { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'after retention' }] } } },
  })
  assert.equal(expiredAppend.status, 410, `append must refuse an expired Session; got ${expiredAppend.status}`)
  const expiredBundle = await exportPrincipal({ page: carol.page })
  assert.equal(expiredBundle.counts.sessions, 0, 'export must not carry an expired Session')
  assert.equal(expiredBundle.counts.usageEntries, 0, 'export must not carry expired usage entries')
  const expiredAudit = await getJson(carol.page, `/api/browser-native/usage-audit?sessionId=${carolTurn.sessionId}`)
  assert.deepEqual(expiredAudit.entries, [], 'expired usage entries must be excluded from the audit endpoint')

  const swept = await waitFor(async () => {
    const response = await getJson(carol.page, '/api/browser-native/retention')
    return response.lastSweep.sessions.includes(carolTurn.sessionId) ? response.lastSweep : undefined
  }, 'the retention sweep must remove the expired Session', 60_000)
  const gone = await stat(sessionFile).then(() => false).catch(error => error?.code === 'ENOENT' ? true : Promise.reject(error))
  assert.equal(gone, true, 'the sweep must delete the expired Session file')
  assert.ok(swept.usageEntries > 0, `the sweep must drop expired usage entries; sweep=${JSON.stringify(swept)}`)
  const report = await getJson(carol.page, '/api/browser-native/usage-report')
  assert.equal(report.totals.requests, 0, 'the cost report must exclude expired usage')
  assert.deepEqual(carol.pageErrors, [])

  summary.retention = {
    retentionDays: 2 / 86_400,
    sweepIntervalMs: 5_000,
    readStatus: expiredRead.status,
    readCode: expiredRead.error.code,
    appendStatus: expiredAppend.status,
    exportSessions: expiredBundle.counts.sessions,
    exportUsageEntries: expiredBundle.counts.usageEntries,
    sweptUsageEntries: swept.usageEntries,
    reportRequests: report.totals.requests,
    fileDeleted: gone,
  }
  await retained.app.close()
  console.log(JSON.stringify({ result: 'passed', upstream: 'local-openai-compatible', ...summary }))
} finally {
  for (const resource of cleanup.reverse()) {
    try {
      if (typeof resource?.close === 'function') await resource.close()
      else if (typeof resource?.cleanup === 'function') await resource.cleanup()
    } catch {}
  }
  await browser.close()
}
