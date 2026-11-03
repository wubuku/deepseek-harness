/**
 * Verify that Session export/import is portable and rejects corrupt bundles.
 *
 * A Session with an attachment is created through the Node-facing Session API,
 * exported, imported under a new id, and read back. Every rejection case then
 * asserts a typed failure and checks that no partially imported Session exists.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright

const PROTOCOL_VERSION = 1
const SESSION_FORMAT_VERSION = 4
const PROMPT_MARKER = 'PORTABLE-EXPORT-OK'

let image
let app
let browser
let dataDir

function requestId() {
  return randomUUID()
}

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  dataDir = await mkdtemp(`${tmpdir()}/dsh-browser-export-`)
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  await page.goto(`${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`, { waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

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
  assert.equal(typeof workspaceId, 'string', 'workspace identity must expose an id')

  const attachmentBytes = Buffer.from('portable attachment payload\n', 'utf8')
  const hash = createHash('sha256').update(attachmentBytes).digest('hex')
  const uploaded = await fetch(`${origin}/api/browser-native/workspace/attachments/${hash}?workspaceId=${encodeURIComponent(workspaceId)}&name=note.txt`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/octet-stream' },
    body: attachmentBytes,
  })
  assert.equal(uploaded.status, 200, 'attachment upload must succeed')

  const sourceId = 'portable-export-1'
  const created = await call('/api/browser-native/session/create', {
    body: {
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId(),
      sessionId: sourceId,
      header: { id: sourceId, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), cwd: '/workspace' },
    },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const owner = { ownerToken: created.body.owner.ownerToken, ownerEpoch: created.body.owner.ownerEpoch }
  const events = [
    {
      seq: 0,
      type: 'user/message',
      data: {
        content: [
          { type: 'file', attachment: { attachmentId: `sha256:${hash}`, name: 'note.txt' } },
          { type: 'text', text: `${PROMPT_MARKER} portable bundle` },
        ],
      },
    },
    { seq: 1, type: 'assistant/message', data: { content: [{ type: 'text', text: 'acknowledged' }] } },
  ]
  const appended = await call('/api/browser-native/session/append', {
    body: {
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId(),
      sessionId: sourceId,
      ...owner,
      expectedNextSeq: 0,
      events,
    },
  })
  assert.equal(appended.status, 200, JSON.stringify(appended.body))
  const flushed = await call('/api/browser-native/session/flush', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: sourceId, ...owner },
  })
  assert.equal(flushed.status, 200, JSON.stringify(flushed.body))
  await call('/api/browser-native/session/close', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: sourceId, ...owner },
  })

  const exported = await call('/api/browser-native/session/export', {
    body: { workspaceId, sessionId: sourceId },
  })
  assert.equal(exported.status, 200, JSON.stringify(exported.body))
  const bundle = exported.body
  assert.equal(bundle.format, 'dsh-session-bundle')
  assert.equal(bundle.formatVersion, 1)
  assert.equal(bundle.sessionFormatVersion, SESSION_FORMAT_VERSION)
  assert.equal(typeof bundle.exportedAt, 'string')
  assert.equal(new Date(bundle.exportedAt).toISOString(), bundle.exportedAt)
  assert.equal(bundle.workspaceId, workspaceId)
  assert.equal(bundle.session.id, sourceId)
  assert.deepEqual(bundle.session.events.map(event => event.seq), [0, 1])
  assert.equal(bundle.attachments.length, 1)
  assert.equal(bundle.attachments[0].attachmentId, `sha256:${hash}`)
  assert.equal(bundle.attachments[0].bytes, attachmentBytes.byteLength)
  assert.equal(Buffer.from(bundle.attachments[0].data, 'base64').toString('utf8'), attachmentBytes.toString('utf8'))

  const importedId = 'portable-import-1'
  const copy = {
    ...bundle,
    session: { ...bundle.session, id: importedId, header: { ...bundle.session.header, id: importedId } },
  }
  const imported = await call('/api/browser-native/session/import', { body: { workspaceId, bundle: copy } })
  assert.equal(imported.status, 200, JSON.stringify(imported.body))
  assert.equal(imported.body.imported, true)
  assert.equal(imported.body.eventCount, 2)
  assert.equal(imported.body.attachmentCount, 1)
  const readImported = await call('/api/browser-native/session/read', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: importedId },
  })
  assert.equal(readImported.status, 200, JSON.stringify(readImported.body))
  assert.deepEqual(readImported.body.events.map(event => event.seq), [0, 1])
  const importedFile = readImported.body.events[0].data.content.find(block => block.type === 'file')
  assert.equal(importedFile.attachment.attachmentId, `sha256:${hash}`)
  assert.equal(importedFile.attachment.name, 'note.txt')
  const downloaded = await call(`/api/browser-native/workspace/attachments/${hash}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'GET' })
  assert.equal(downloaded.status, 200)

  const rejectionCases = [
    {
      name: 'unsupported bundle version',
      code: 'UNSUPPORTED_BUNDLE_VERSION',
      status: 409,
      mutate: candidate => { candidate.formatVersion = 2 },
      sessionId: 'reject-version-1',
    },
    {
      name: 'unsupported Session log version',
      code: 'SESSION_FORMAT_UNSUPPORTED',
      status: 422,
      mutate: candidate => { candidate.session.header.version = SESSION_FORMAT_VERSION + 1 },
      sessionId: 'reject-version-2',
    },
    {
      name: 'non-contiguous event sequence',
      code: 'INVALID_BUNDLE',
      status: 400,
      mutate: candidate => { candidate.session.events[1].seq = 5 },
      sessionId: 'reject-sequence-1',
    },
    {
      name: 'event without a type',
      code: 'INVALID_BUNDLE',
      status: 400,
      mutate: candidate => { candidate.session.events[0].type = 42 },
      sessionId: 'reject-event-1',
    },
    {
      name: 'referenced attachment is missing',
      code: 'ATTACHMENT_MISSING',
      status: 409,
      mutate: candidate => { candidate.attachments = [] },
      sessionId: 'reject-attachment-1',
    },
    {
      name: 'attachment digest mismatch',
      code: 'ATTACHMENT_DIGEST_MISMATCH',
      status: 409,
      mutate: candidate => {
        const data = Buffer.from(candidate.attachments[0].data, 'base64')
        data[0] = data[0] === 0x70 ? 0x71 : 0x70
        candidate.attachments[0].data = data.toString('base64')
      },
      sessionId: 'reject-attachment-2',
    },
    {
      name: 'attachment size mismatch',
      code: 'ATTACHMENT_SIZE_MISMATCH',
      status: 409,
      mutate: candidate => { candidate.attachments[0].bytes += 1 },
      sessionId: 'reject-attachment-3',
    },
    {
      name: 'duplicate Session id',
      code: 'SESSION_ALREADY_EXISTS',
      status: 409,
      mutate: candidate => {
        candidate.session.id = sourceId
        candidate.session.header.id = sourceId
      },
      sessionId: sourceId,
    },
  ]
  const rejections = []
  for (const rejection of rejectionCases) {
    const candidate = JSON.parse(JSON.stringify(copy))
    candidate.session.id = rejection.sessionId
    candidate.session.header.id = rejection.sessionId
    rejection.mutate(candidate)
    const result = await call('/api/browser-native/session/import', { body: { workspaceId, bundle: candidate } })
    assert.equal(result.status, rejection.status, `${rejection.name}: ${JSON.stringify(result.body)}`)
    assert.equal(result.body.error?.code, rejection.code, `${rejection.name}: ${JSON.stringify(result.body)}`)
    rejections.push({ name: rejection.name, code: result.body.error.code, status: result.status })
  }
  const catalog = await call('/api/browser-native/session/list', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: requestId(), limit: 50 },
  })
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body))
  const listed = new Set(catalog.body.items.map(item => item.sessionId))
  assert.equal(listed.has(importedId), true)
  for (const rejection of rejectionCases) {
    if (rejection.sessionId === sourceId) continue
    assert.equal(listed.has(rejection.sessionId), false, rejection.name)
  }
  const readSource = await call('/api/browser-native/session/read', {
    body: { protocolVersion: PROTOCOL_VERSION, requestId: requestId(), sessionId: sourceId },
  })
  assert.equal(readSource.status, 200)
  assert.equal(readSource.body.events.length, 2, 'a rejected import must not mutate the source Session')

  console.log(JSON.stringify({
    result: 'passed',
    scope: 'session-export-import',
    format: { format: bundle.format, formatVersion: bundle.formatVersion, sessionFormatVersion: bundle.sessionFormatVersion },
    exported: {
      sessionId: sourceId,
      eventCount: bundle.session.events.length,
      attachmentCount: bundle.attachments.length,
      attachmentBytes: bundle.attachments[0].bytes,
    },
    imported: {
      sessionId: importedId,
      eventCount: imported.body.eventCount,
      attachmentCount: imported.body.attachmentCount,
      durabilityReceipt: imported.body.durabilityReceipt,
    },
    rejections,
    catalogSize: catalog.body.items.length,
  }))
} finally {
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup()
  if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true })
}
