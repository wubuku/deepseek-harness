import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { createObservabilityJournal } from '../observability-journal.mjs'
import { buildUsageReport, normalizeUsagePricing } from '../usage-report.mjs'
import { erasePrincipal, eraseSession, findResidue } from '../hosted/data-erasure.mjs'
import { waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-erasure-')))
const usagePricing = normalizeUsagePricing({ inputUsdPer1M: 2, outputUsdPer1M: 4 })
let image
let app
let origin
let browser
const contexts = []

const principalCookie = 'dsh-browser-native-principal'
const sessionCookie = 'dsh-browser-native-session-principal'

async function call(cookie, path, options = {}) {
  const headers = { cookie: `${principalCookie}=${cookie}; ${sessionCookie}=${cookie}`, ...options.headers }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

async function seedWorkspace(context, label) {
  const known = new Set(app.workspaces.identities.keys())
  const page = await context.newPage()
  const url = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const status = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
  const workspaceId = status?.workspaceId
  const principal = [...app.workspaces.identities.keys()].find(key => !known.has(key))
  assert.equal(typeof workspaceId, 'string', JSON.stringify(status))
  assert.equal(typeof principal, 'string', 'the preview load must create exactly one new identity')
  const write = await page.evaluate(async name => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'write',
    path: `/dsh/home/workspace/${name}.txt`,
    content: `${name} bytes that belong to exactly one principal\n`,
  }), label)
  assert.equal(write?.ok, true)
  const flush = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
  assert.equal(flush?.ok, true)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 30_000 })
  const manifest = await call(principal, `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`)
  assert.equal(manifest.status, 200)
  const file = manifest.body.entries.find(entry => entry.path === `${label}.txt`)
  assert.ok(file)
  const attachmentBytes = Buffer.from(`attachment for ${label}\n`)
  const attachmentHash = createHash('sha256').update(attachmentBytes).digest('hex')
  const uploaded = await fetch(`${origin}/api/browser-native/workspace/attachments/${attachmentHash}?workspaceId=${encodeURIComponent(workspaceId)}&name=${label}.txt`, {
    method: 'PUT',
    headers: { cookie: `${principalCookie}=${principal}; ${sessionCookie}=${principal}`, 'content-type': 'application/octet-stream' },
    body: attachmentBytes,
  })
  assert.equal(uploaded.status, 200, await uploaded.text())
  const sessionId = `sess-${label}-${randomUUID()}`
  const created = await call(principal, '/api/browser-native/session/create', {
    body: {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      header: { id: sessionId, version: 4, createdAt: Date.now(), cwd: '/dsh/home/workspace' },
    },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const owner = { ownerToken: created.body.owner.ownerToken, ownerEpoch: created.body.owner.ownerEpoch }
  const appended = await call(principal, '/api/browser-native/session/append', {
    body: {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      ...owner,
      expectedNextSeq: 0,
      events: [
        { seq: 0, type: 'user', data: { text: `hello from ${label}` } },
        { seq: 1, type: 'assistant', data: { text: `reply for ${label}`, attachmentId: `sha256:${attachmentHash}` } },
      ],
    },
  })
  assert.equal(appended.status, 200, JSON.stringify(appended.body))
  const flushed = await call(principal, '/api/browser-native/session/flush', {
    body: { protocolVersion: 1, requestId: randomUUID(), sessionId, ...owner },
  })
  assert.equal(flushed.status, 200, JSON.stringify(flushed.body))
  const exported = await call(principal, '/api/browser-native/session/export', { body: { workspaceId, sessionId } })
  assert.equal(exported.status, 200, JSON.stringify(exported.body))
  return { principal, workspaceId, sessionId, fileHash: file.hash, exported: exported.body }
}

async function restart() {
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    workspaceChunkObjects: true,
    usagePricing,
  })
  origin = await app.listen(0)
  return origin
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  await restart()
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  const left = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const right = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  contexts.push(left, right)
  const kept = await seedWorkspace(left, 'kept')
  const erased = await seedWorkspace(right, 'erased')
  assert.notEqual(kept.principal, erased.principal)
  assert.notEqual(kept.workspaceId, erased.workspaceId)

  const journal = createObservabilityJournal({ dataDir })
  const keptDigest = createHash('sha256').update(kept.principal).digest('hex').slice(0, 16)
  const erasedDigest = createHash('sha256').update(erased.principal).digest('hex').slice(0, 16)
  await journal.appendAccessDenial({
    at: Date.now(), method: 'GET', route: '/api/browser-native/session/read', resource: 'session',
    resourceId: kept.sessionId, principalDigest: keptDigest, code: 'SESSION_NOT_FOUND', status: 404,
  })
  await journal.appendAccessDenial({
    at: Date.now(), method: 'GET', route: '/api/browser-native/session/read', resource: 'session',
    resourceId: erased.sessionId, principalDigest: erasedDigest, code: 'SESSION_NOT_FOUND', status: 404,
  })
  await journal.appendUsage({ at: Date.now(), sessionId: kept.sessionId, model: 'scripted', inputTokens: 100, outputTokens: 20, principalId: kept.principal })
  await journal.appendUsage({ at: Date.now(), sessionId: erased.sessionId, model: 'scripted', inputTokens: 50, outputTokens: 10, principalId: erased.principal })
  await journal.close()

  await assert.rejects(
    eraseSession({ dataDir, sessionId: erased.sessionId }),
    error => error.code === 'BACKEND_RUNNING',
  )
  await app.close()
  app = undefined

  const sessionErasure = await eraseSession({ dataDir, sessionId: erased.sessionId })
  assert.deepEqual(sessionErasure.sessions, [erased.sessionId])
  assert.ok(sessionErasure.removedAttachments >= 1, 'the erased Session attachment must be removed')
  assert.equal(sessionErasure.removedJournalRecords.usage, 1)
  assert.equal(sessionErasure.removedJournalRecords.accessDenials, 1)
  assert.deepEqual(await findResidue({ dataDir, needles: [erased.sessionId] }), [])

  const afterSessionErase = createObservabilityJournal({ dataDir })
  const restored = await afterSessionErase.restore()
  assert.equal(restored.integrity.verified, true, 'the redacted journal chain must verify')
  assert.deepEqual(restored.usage.map(entry => entry.sessionId), [kept.sessionId])
  assert.deepEqual(restored.accessDenials.map(entry => entry.resourceId), [kept.sessionId])
  const report = buildUsageReport(restored.usage, { pricing: usagePricing, model: 'scripted' })
  assert.equal(report.totals.inputTokens, 100)
  assert.equal(report.totals.outputTokens, 20)

  await restart()
  const keptAgain = await call(kept.principal, '/api/browser-native/session/export', { body: { workspaceId: kept.workspaceId, sessionId: kept.sessionId } })
  assert.equal(keptAgain.status, 200, JSON.stringify(keptAgain.body))
  assert.deepEqual(keptAgain.body.events, kept.exported.events, 'retained Sessions must export unchanged')
  const erasedExport = await call(erased.principal, '/api/browser-native/session/export', { body: { workspaceId: erased.workspaceId, sessionId: erased.sessionId } })
  assert.equal(erasedExport.status, 404, 'an erased Session must not be exportable')
  assert.equal(erasedExport.body.error?.code ?? erasedExport.body.code, 'SESSION_NOT_FOUND')

  await app.close()
  app = undefined

  const workspaceBefore = await readdir(join(dataDir, 'workspace-v2'))
  const principalErasure = await erasePrincipal({ dataDir, principalId: erased.principal })
  assert.ok(principalErasure.removedWorkspaces.some(path => path.includes(join('attachments-v1', erased.workspaceId))),
    'the erased principal attachment directory must be removed')
  assert.equal(principalErasure.removedJournalRecords.usage, 0)
  assert.equal(principalErasure.removedJournalRecords.accessDenials, 1)
  assert.ok(principalErasure.removedBlobs + principalErasure.removedDescriptors + principalErasure.removedChunks >= 1,
    'the erased principal Workspace blob objects must be removed')
  assert.deepEqual(await findResidue({ dataDir, needles: [erased.principal, erased.workspaceId, erased.fileHash] }), [])
  const remainingSessions = await readdir(join(dataDir, 'sessions'))
  assert.ok(remainingSessions.includes(`${kept.sessionId}.json`), 'the retained Session log must remain')
  assert.ok(!remainingSessions.includes(`${erased.sessionId}.json`), 'the erased Session log must be gone')
  assert.equal((await readdir(join(dataDir, 'workspace-v2', 'workspaces'))).length, 1)
  assert.deepEqual((await readdir(join(dataDir, 'workspace-v2'))).sort(), workspaceBefore.sort())

  await restart()
  const eraseRequest = await call(erased.principal, `/api/browser-native/workspace/identity`, {
    headers: { 'x-browser-native-identity-mode': 'existing' },
  })
  assert.equal(eraseRequest.status, 401, 'an erased principal cookie must not resolve to an identity')
  const erasedReExport = await call(erased.principal, '/api/browser-native/session/export', { body: { workspaceId: erased.workspaceId, sessionId: erased.sessionId } })
  assert.ok([401, 404].includes(erasedReExport.status), 'an erased principal must not recover its Session through export')
  const keptIdentity = await call(kept.principal, '/api/browser-native/workspace/identity')
  assert.equal(keptIdentity.status, 200)
  assert.equal(keptIdentity.body.workspaceId, kept.workspaceId)
  const keptFinal = await call(kept.principal, '/api/browser-native/session/export', { body: { workspaceId: kept.workspaceId, sessionId: kept.sessionId } })
  assert.equal(keptFinal.status, 200)

  await app.close()
  app = undefined
  const finalJournal = createObservabilityJournal({ dataDir })
  const finalRestore = await finalJournal.restore()
  assert.equal(finalRestore.integrity.verified, true, JSON.stringify(finalRestore.integrity))
  assert.deepEqual(finalRestore.usage.map(entry => entry.sessionId), [kept.sessionId])
  assert.ok(finalRestore.accessDenials.some(entry => entry.resourceId === kept.sessionId))
  assert.ok(!finalRestore.accessDenials.some(entry => entry.resourceId === erased.sessionId))
  assert.ok(!finalRestore.accessDenials.some(entry => entry.principalDigest === erasedDigest))

  const summary = {
    result: 'passed',
    scope: 'session-erasure-and-principal-erasure',
    sessionErased: erased.sessionId,
    sessionResidue: 0,
    principalErased: erased.principal,
    workspaceErased: erased.workspaceId,
    principalResidue: 0,
    retainedSessionExportable: true,
    retainedWorkspaceIdentity: kept.workspaceId,
    journalVerifiedAfterRedaction: true,
    retainedUsageTokens: 120,
  }
  if (process.env.DSH_POC_RESULT_FILE !== undefined) {
    await writeFile(resolve(process.env.DSH_POC_RESULT_FILE), `${JSON.stringify(summary, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} finally {
  await app?.close().catch(() => {})
  for (const context of contexts) await context?.close().catch(() => {})
  await browser?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
