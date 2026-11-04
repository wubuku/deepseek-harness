/**
 * Verify full data-directory backup and restore for the hosted backend.
 *
 * A source data directory is filled through the public HTTP surface: a durable
 * Workspace with one blob, an attachment, a two-event Session, and journal
 * records for audit denials and provider usage. After the backend stops, the
 * directory is exported to a bundle, imported into an empty target, and checked
 * for byte-identical stores, an intact journal hash chain, the same usage report,
 * and a Session that continues from its restored log.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { createObservabilityJournal } from '../observability-journal.mjs'
import { BackupError, exportDataDir, importDataDir } from '../hosted/data-backup.mjs'
import { inspectDataDirectory } from '../hosted/check-data.mjs'
import { buildUsageReport, normalizeUsagePricing } from '../usage-report.mjs'
import { openPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const PROTOCOL_VERSION = 1
const SESSION_FORMAT_VERSION = 4
const USAGE_PRICING = { inputUsdPer1M: 1.5, outputUsdPer1M: 6 }
const BLOB_PATH = '/dsh/home/workspace/restore.txt'
const BLOB_CONTENT = 'workspace blob carried through backup and restore\n'

let image
let app
let browser
let sourceDir

/** Recursively fingerprint every data file except the backend lock. */
async function fingerprint(root, prefix = '') {
  const entries = {}
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.name === '.browser-native-backend.lock') continue
    if (entry.isDirectory()) Object.assign(entries, await fingerprint(root, path))
    else if (entry.isFile()) {
      const bytes = await readFile(join(root, path))
      entries[path] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength }
    }
  }
  return entries
}

/** Fetch one Session export bundle. */
async function exportSession(call, workspaceId, sessionId) {
  const response = await call('/api/browser-native/session/export', { body: { workspaceId, sessionId } })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return response.body
}

/**
 * Upload one blob through the content-defined upload protocol so the backend
 * publishes chunk objects and a content layout, not just a plain blob file.
 */
async function uploadChunkedBlob({ origin, cookie, workspaceId, chunks }) {
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
  const layout = {
    version: 1,
    algorithm: 'dsh-gear-v1',
    minimumBytes: 32 * 1024,
    averageBytes: 128 * 1024,
    maximumBytes: 1024 * 1024,
    chunks: [],
  }
  let offset = 0
  for (const chunk of chunks) {
    layout.chunks.push({ offset, length: chunk.byteLength, hash: sha256(chunk) })
    offset += chunk.byteLength
  }
  const hash = sha256(Buffer.concat(chunks))
  const operationId = randomUUID()
  const start = await fetch(`${origin}/api/browser-native/workspace/blob-upload/start`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      workspaceId,
      operationId,
      hash,
      totalBytes: offset,
      chunkBytes: 1024 * 1024,
      layout,
    }),
  })
  assert.equal(start.status, 200, `chunked upload start failed: ${await start.text()}`)
  for (const [index, chunk] of chunks.entries()) {
    const response = await fetch(`${origin}/api/browser-native/workspace/blob-upload/${operationId}-${hash}/${String(index)}`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/octet-stream',
        'x-browser-native-protocol': String(PROTOCOL_VERSION),
        'x-workspace-id': workspaceId,
        'x-request-id': randomUUID(),
        'x-chunk-sha256': layout.chunks[index].hash,
      },
      body: chunk,
    })
    assert.equal(response.status, 200, `chunk ${String(index)} upload failed: ${await response.text()}`)
  }
  const complete = await fetch(`${origin}/api/browser-native/workspace/blob-upload/${operationId}-${hash}/complete`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), workspaceId }),
  })
  assert.equal(complete.status, 200, `chunked upload completion failed: ${await complete.text()}`)
  return { hash, totalBytes: offset }
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  sourceDir = await mkdtemp(`${tmpdir()}/dsh-browser-backup-source-`)
  app = await createBrowserNativeV2Server({
    dataDir: sourceDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    usagePricing: USAGE_PRICING,
    workspaceChunkObjects: true,
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(
    () => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced',
    undefined,
    { timeout: 60_000 },
  )

  let cookie = (await context.cookies()).map(entry => `${entry.name}=${entry.value}`).join('; ')
  const call = async (path, { method = 'POST', body, headers = {} } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = await response.json().catch(() => undefined)
    return { status: response.status, body: payload }
  }
  const identity = await call('/api/browser-native/workspace/identity', { method: 'GET' })
  assert.equal(identity.status, 200, JSON.stringify(identity.body))
  cookie = (await context.cookies()).map(entry => `${entry.name}=${entry.value}`).join('; ')
  const workspaceId = identity.body.workspaceId

  await page.waitForFunction(
    () => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function',
    undefined,
    { timeout: 30_000 },
  )
  const written = await page.evaluate(async ({ path, content }) => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'write', path, content }),
    { path: BLOB_PATH, content: BLOB_CONTENT })
  assert.equal(written?.ok, true, `the Workspace test port must write the blob: ${JSON.stringify(written)}`)
  assert.equal((await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))).ok, true,
    'the Workspace must flush to durable storage')
  await page.waitForFunction(
    () => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
      && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0,
    undefined,
    { timeout: 30_000 },
  )

  const attachmentBytes = Buffer.from('backup attachment payload\n', 'utf8')
  const attachmentHash = createHash('sha256').update(attachmentBytes).digest('hex')
  const uploaded = await fetch(`${origin}/api/browser-native/workspace/attachments/${attachmentHash}?workspaceId=${encodeURIComponent(workspaceId)}&name=note.txt`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/octet-stream' },
    body: attachmentBytes,
  })
  assert.equal(uploaded.status, 200, 'attachment upload must succeed')

  const chunked = await uploadChunkedBlob({
    origin,
    cookie,
    workspaceId,
    chunks: [Buffer.alloc(40_000, 1), Buffer.alloc(40_000, 2)],
  })

  const sessionId = 'backup-restore-1'
  const created = await call('/api/browser-native/session/create', {
    body: {
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      sessionId,
      header: { id: sessionId, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), cwd: '/workspace' },
    },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const owner = { ownerToken: created.body.owner.ownerToken, ownerEpoch: created.body.owner.ownerEpoch }
  const appended = await call('/api/browser-native/session/append', {
    body: {
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      sessionId,
      ...owner,
      expectedNextSeq: 0,
      events: [
        {
          seq: 0,
          type: 'user/message',
          data: {
            content: [
              { type: 'file', attachment: { attachmentId: `sha256:${attachmentHash}`, name: 'note.txt' } },
              { type: 'text', text: 'backup restore seed' },
            ],
          },
        },
        { seq: 1, type: 'assistant/message', data: { content: [{ type: 'text', text: 'acknowledged' }] } },
      ],
    },
  })
  assert.equal(appended.status, 200, JSON.stringify(appended.body))
  const flushed = await call('/api/browser-native/session/flush', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), sessionId, ...owner },
  })
  assert.equal(flushed.status, 200, JSON.stringify(flushed.body))
  const closed = await call('/api/browser-native/session/close', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), sessionId, ...owner },
  })
  assert.equal(closed.status, 200, JSON.stringify(closed.body))

  const sourceBundle = await exportSession(call, workspaceId, sessionId)
  await app.close()
  app = undefined

  const journal = createObservabilityJournal({ dataDir: sourceDir })
  await journal.appendAccessDenial({
    at: Date.now(), method: 'GET', route: '/api/browser-native/health', resource: 'health',
    resourceId: null, principalDigest: null, code: 'AUTH_REQUIRED', status: 401,
  })
  await journal.appendUsage({ sessionId, model: 'scripted', inputTokens: 120, outputTokens: 30 })
  const sourceJournal = await journal.restore()
  assert.equal(sourceJournal.integrity.verified, true, 'the source journal must chain before export')

  const sourceFiles = await fingerprint(sourceDir)
  const sourceCheck = await inspectDataDirectory(sourceDir)
  assert.equal(sourceCheck.compatible, true)
  assert.equal(sourceCheck.storage.chunkObjects, true, 'the seeded Workspace must store chunk objects')
  assert.ok(sourceFiles[`workspace-v2/workspaces/${workspaceId}.json`], 'the Workspace manifest must exist')
  assert.ok(Object.keys(sourceFiles).some(path => path.startsWith('workspace-v2/chunk-objects/chunks/')), 'the chunked upload must publish chunk objects')
  assert.ok(sourceFiles[`workspace-v2/chunk-objects/files/${chunked.hash}.json`], 'the chunked upload must publish a file descriptor')
  assert.ok(Object.keys(sourceFiles).some(path => path.startsWith(`workspace-v2/layouts/${workspaceId}/`)), 'the chunked upload must publish a content layout')
  assert.ok(Object.keys(sourceFiles).some(path => path.startsWith('attachments-v1/')), 'the attachment must exist')

  const bundleDir = await mkdtemp(`${tmpdir()}/dsh-browser-backup-bundle-`)
  const exportManifest = await exportDataDir({ dataDir: sourceDir, outputDir: bundleDir })
  assert.equal(exportManifest.files.length, Object.keys(sourceFiles).length)
  const sourceSessionFiles = Object.keys(sourceFiles).filter(path => path.startsWith('sessions/') && path.endsWith('.json'))
  assert.equal(exportManifest.stores.sessions.count, sourceSessionFiles.length)
  assert.equal(exportManifest.stores.workspaces.count, 1)
  assert.equal(exportManifest.stores.attachments.count, 1)
  assert.equal(exportManifest.stores.observability.accessDenials, 1)
  assert.equal(exportManifest.stores.observability.usage, 1)

  const restoredDir = join(await mkdtemp(`${tmpdir()}/dsh-browser-backup-target-`), 'data')
  const { manifest: importedManifest } = await importDataDir({ bundleDir, dataDir: restoredDir })
  assert.deepEqual(importedManifest.files, exportManifest.files, 'import must report the verified manifest')
  const restoredFiles = await fingerprint(restoredDir)
  assert.deepEqual(restoredFiles, sourceFiles, 'every Session, Workspace, attachment, ledger and journal file must restore byte-identically')
  const restoredCheck = await inspectDataDirectory(restoredDir)
  assert.equal(restoredCheck.compatible, true)
  assert.equal(restoredCheck.storage.chunkObjects, true)
  assert.equal(restoredCheck.lock.present, false)

  app = await createBrowserNativeV2Server({
    dataDir: restoredDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    usagePricing: USAGE_PRICING,
    workspaceChunkObjects: true,
  })
  const restoredOrigin = await app.listen(0)
  const restoredCall = async (path, { method = 'POST', body, headers = {} } = {}) => {
    const response = await fetch(`${restoredOrigin}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = await response.json().catch(() => undefined)
    return { status: response.status, body: payload }
  }

  const restoredBundle = await exportSession(restoredCall, workspaceId, sessionId)
  assert.deepEqual({ ...restoredBundle, exportedAt: undefined }, { ...sourceBundle, exportedAt: undefined },
    'restored Session events and attachment bytes must match the source export')
  const attachmentDownload = await restoredCall(`/api/browser-native/workspace/attachments/${attachmentHash}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'GET' })
  assert.equal(attachmentDownload.status, 200)

  const restoredUsage = (await restoredCall('/api/browser-native/usage-report', { method: 'GET' })).body
  const expectedUsage = buildUsageReport(sourceJournal.usage, {
    pricing: normalizeUsagePricing(USAGE_PRICING),
    model: restoredUsage.model,
  })
  assert.deepEqual(
    { ...restoredUsage, generatedAt: undefined, protocolVersion: undefined },
    { ...expectedUsage, generatedAt: undefined, protocolVersion: undefined },
    'the restored usage report must match the restored journal entries',
  )
  assert.deepEqual(
    { inputTokens: restoredUsage.totals.inputTokens, outputTokens: restoredUsage.totals.outputTokens, totalTokens: restoredUsage.totals.totalTokens },
    { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
  )

  const restoredJournal = await createObservabilityJournal({ dataDir: restoredDir }).restore()
  assert.equal(restoredJournal.integrity.verified, true, 'the restored journal hash chain must verify')
  assert.equal(restoredJournal.accessDenials.length, 1)
  assert.equal(restoredJournal.usage.length, 1)
  assert.deepEqual(restoredJournal.usage[0], sourceJournal.usage[0])

  const reopened = await restoredCall('/api/browser-native/session/open', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), sessionId, access: 'write' },
  })
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body))
  const continued = await restoredCall('/api/browser-native/session/append', {
    body: {
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      sessionId,
      ownerToken: reopened.body.owner.ownerToken,
      ownerEpoch: reopened.body.owner.ownerEpoch,
      expectedNextSeq: 2,
      events: [{ seq: 2, type: 'assistant/message', data: { content: [{ type: 'text', text: 'continued after restore' }] } }],
    },
  })
  assert.equal(continued.status, 200, JSON.stringify(continued.body))
  const readBack = await restoredCall('/api/browser-native/session/read', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), sessionId },
  })
  assert.equal(readBack.status, 200, JSON.stringify(readBack.body))
  assert.deepEqual(readBack.body.events.map(event => event.seq), [0, 1, 2], 'the restored Session must continue from its last seq')
  assert.equal((await inspectDataDirectory(restoredDir)).compatible, true)

  await assert.rejects(
    () => exportDataDir({ dataDir: restoredDir, outputDir: join(tmpdir(), `blocked-${randomUUID()}`) }),
    error => error instanceof BackupError && error.code === 'BACKEND_RUNNING',
    'a running backend must refuse export',
  )

  const tamperedBundle = await mkdtemp(`${tmpdir()}/dsh-browser-backup-tampered-`)
  await app.close()
  app = undefined
  await exportDataDir({ dataDir: restoredDir, outputDir: tamperedBundle })
  const attachmentPath = (await readdir(join(tamperedBundle, 'files', 'attachments-v1'), { recursive: true }))
    .find(path => path.endsWith(attachmentHash))
  assert.ok(attachmentPath, 'the bundle must carry the attachment object')
  const tamperedFile = join(tamperedBundle, 'files', 'attachments-v1', attachmentPath)
  await chmod(tamperedFile, 0o600)
  await writeFile(tamperedFile, 'tampered')
  const tamperedTarget = join(await mkdtemp(`${tmpdir()}/dsh-browser-backup-tamper-target-`), 'data')
  await assert.rejects(
    () => importDataDir({ bundleDir: tamperedBundle, dataDir: tamperedTarget }),
    error => error instanceof BackupError && error.code === 'INTEGRITY_MISMATCH',
    'a tampered bundle must refuse import',
  )
  assert.equal(existsSync(tamperedTarget), false, 'a rejected import must not create the target directory')

  const occupied = await mkdtemp(`${tmpdir()}/dsh-browser-backup-occupied-`)
  await writeFile(join(occupied, 'keep.txt'), 'occupied\n')
  await assert.rejects(
    () => importDataDir({ bundleDir, dataDir: occupied }),
    error => error instanceof BackupError && error.code === 'TARGET_NOT_EMPTY',
    'a non-empty target must refuse import',
  )

  console.log(JSON.stringify({
    result: 'passed',
    scope: 'backup-restore',
    files: exportManifest.files.length,
    sessions: exportManifest.stores.sessions.count,
    workspaces: exportManifest.stores.workspaces.count,
    attachments: exportManifest.stores.attachments.count,
    journal: { accessDenials: restoredJournal.accessDenials.length, usage: restoredJournal.usage.length, verified: restoredJournal.integrity.verified },
    usageTotals: restoredUsage.totals,
    continuedSeq: readBack.body.events.length - 1,
  }))
} finally {
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup()
  if (sourceDir !== undefined) await rm(sourceDir, { recursive: true, force: true })
}
