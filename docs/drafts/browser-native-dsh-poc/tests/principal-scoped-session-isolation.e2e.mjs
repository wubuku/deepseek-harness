import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, sessionRequest, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-principal-isolation-')))
const principalCookieNames = new Set([
  'dsh-browser-native-principal',
  'dsh-browser-native-session-principal',
])
const workspacePath = '/dsh/home/workspace/account-scope.txt'

if (browserName !== 'chrome') throw new Error('This validation runs only in Chrome')

async function installPrincipalCookies(context, cookies) {
  for (const name of principalCookieNames) await context.clearCookies({ name })
  if (cookies.length > 0) await context.addCookies(cookies)
}

async function principalCookies(context, origin) {
  const cookies = (await context.cookies([
    `${origin}/api/browser-native/workspace/identity`,
    `${origin}/api/browser-native/session/create`,
  ])).filter(cookie => principalCookieNames.has(cookie.name))
  assert.deepEqual(new Set(cookies.map(cookie => cookie.name)), principalCookieNames)
  const values = new Set(cookies.map(cookie => cookie.value))
  assert.equal(values.size, 1, 'Workspace and Session identities must refer to the same PoC principal')
  return cookies
}

async function openPage(context, origin, pageRecords, observations) {
  const page = await context.newPage()
  const requests = []
  page.on('pageerror', error => observations.pageErrors.push(error.message))
  page.on('request', request => {
    const requestUrl = new URL(request.url())
    if (requestUrl.origin !== origin) observations.externalRequests.push(request.url())
    if (!requestUrl.pathname.startsWith('/api/browser-native/')) return
    let body
    try {
      body = request.postDataJSON()
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
    const record = { path: requestUrl.pathname, body }
    requests.push(record)
    pageRecords.push(request.allHeaders().then(headers => ({
      path: requestUrl.pathname,
      cookieNames: (headers.cookie ?? '').split(';').map(part => part.split('=', 1)[0].trim()).filter(Boolean),
    })))
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await waitForPreview(page)
  return { page, requests }
}

async function identity(page) {
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/browser-native/workspace/identity')
    return { status: response.status, ...await response.json() }
  })
  assert.equal(result.status, 200)
  return result
}

async function manifest(page, workspaceId) {
  return await page.evaluate(async id => {
    const response = await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)
    return { status: response.status, body: await response.json() }
  }, workspaceId)
}

async function listSessions(page) {
  return await page.evaluate(async () => {
    const response = await fetch('/api/browser-native/session/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), limit: 20 }),
    })
    return { status: response.status, body: await response.json() }
  })
}

async function readWorkerFile(page) {
  return await page.evaluate(async path => {
    const request = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof request !== 'function') throw new Error('Browser-Native Worker test port is unavailable')
    return await request({ action: 'read', path })
  }, workspacePath)
}

async function localWorkspace(page, workspaceId) {
  return await page.evaluate(async id => {
    const database = await new Promise((resolveDatabase, reject) => {
      const request = indexedDB.open('dsh-browser-native-workspace-v1')
      request.onerror = () => reject(request.error ?? new Error('Workspace IndexedDB open failed'))
      request.onsuccess = () => resolveDatabase(request.result)
    })
    const metadata = await new Promise((resolveRecord, reject) => {
      const transaction = database.transaction('workspace', 'readonly')
      const request = transaction.objectStore('workspace').get(id)
      request.onerror = () => reject(request.error ?? new Error('Workspace snapshot read failed'))
      request.onsuccess = () => resolveRecord(request.result ?? null)
      transaction.oncomplete = () => database.close()
    })
    const root = await navigator.storage.getDirectory()
    const directoryName = `dsh-workspace-blobs-${id}`
    let blobs = []
    try {
      const directory = await root.getDirectoryHandle(directoryName)
      blobs = []
      for await (const entry of directory.values()) blobs.push(entry.name)
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error
    }
    return { metadata, blobs: blobs.sort() }
  }, workspaceId)
}

let image
let app
let browser
let context
const requestScopes = []
const observations = { pageErrors: [], externalRequests: [] }
const ownedDataDir = process.env.DSH_POC_DATA_DIR === undefined

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })

  const accountAPage = await openPage(context, origin, requestScopes, observations)
  const turnA = await sendTurn({
    page: accountAPage.page,
    origin,
    requests: accountAPage.requests,
    prompt: 'BROWSER_NATIVE_PRINCIPAL_SCOPE_A：使用 write 工具保存 A 的标记。',
    marker: 'BROWSER_NATIVE_PRINCIPAL_SCOPE_A_DONE',
    timeout: 45_000,
  })
  const identityA = await identity(accountAPage.page)
  const cookiesA = await principalCookies(context, origin)
  const manifestA = await manifest(accountAPage.page, identityA.workspaceId)
  assert.equal(manifestA.status, 200)
  assert.equal(manifestA.body.revision, 1)
  assert.deepEqual(manifestA.body.entries.filter(entry => entry.kind === 'file').map(entry => entry.path), ['account-scope.txt'])
  const fileA = manifestA.body.entries.find(entry => entry.path === 'account-scope.txt')
  const contentA = await accountAPage.page.evaluate(async entry => {
    const response = await fetch(`/api/browser-native/workspace/blob/${entry.hash}?protocolVersion=1&workspaceId=${encodeURIComponent(entry.workspaceId)}`)
    return await response.text()
  }, { ...fileA, workspaceId: identityA.workspaceId })
  assert.equal(contentA, 'principal-A\n')
  const localA = await localWorkspace(accountAPage.page, identityA.workspaceId)
  assert.equal(localA.metadata.workspaceId, identityA.workspaceId)
  assert.equal(localA.metadata.revision, manifestA.body.revision)
  assert.deepEqual(localA.blobs, [fileA.hash])
  assert.deepEqual(turnA.session.events.filter(event => event.type === 'tool/call').map(event => event.data.name), ['write'])
  await accountAPage.page.close()

  await installPrincipalCookies(context, [])
  const accountBPage = await openPage(context, origin, requestScopes, observations)
  const crossRead = await sendTurn({
    page: accountBPage.page,
    origin,
    requests: accountBPage.requests,
    prompt: 'BROWSER_NATIVE_PRINCIPAL_CROSS_READ：读取相同路径。',
    marker: 'BROWSER_NATIVE_PRINCIPAL_CROSS_READ_DONE',
    timeout: 45_000,
  })
  const identityB = await identity(accountBPage.page)
  const cookiesB = await principalCookies(context, origin)
  assert.notEqual(identityB.workspaceId, identityA.workspaceId)
  assert.notEqual(cookiesB.find(cookie => cookie.name === 'dsh-browser-native-session-principal')?.value,
    cookiesA.find(cookie => cookie.name === 'dsh-browser-native-session-principal')?.value)
  const crossReadCall = crossRead.session.events.find(event => event.type === 'tool/call')
  const crossReadResult = crossRead.session.events.find(event => event.type === 'tool/result'
    && (event.data.message?.toolCallId ?? event.data.toolCallId ?? event.data.callId) === crossReadCall?.data.callId)
  assert.equal(crossReadCall?.data.name, 'read')
  assert.equal(crossReadResult?.data.message?.isError, true)
  const missingFromBWorker = await readWorkerFile(accountBPage.page)
  assert.equal(missingFromBWorker.ok, false)
  const foreignWorkspace = await manifest(accountBPage.page, identityA.workspaceId)
  assert.equal(foreignWorkspace.status, 403)
  const foreignSession = await accountBPage.page.evaluate(async id => {
    const response = await fetch('/api/browser-native/session/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId: id, offset: 0 }),
    })
    return { status: response.status, body: await response.json() }
  }, turnA.sessionId)
  assert.equal(foreignSession.status, 404)
  assert.equal(foreignSession.body.error.code, 'SESSION_NOT_FOUND')
  const listB = await listSessions(accountBPage.page)
  assert.equal(listB.status, 200)
  assert.deepEqual(listB.body.items.map(item => item.sessionId), [crossRead.sessionId])

  const turnB = await sendTurn({
    page: accountBPage.page,
    origin,
    requests: accountBPage.requests,
    prompt: 'BROWSER_NATIVE_PRINCIPAL_SCOPE_B：使用 write 工具保存 B 的标记。',
    marker: 'BROWSER_NATIVE_PRINCIPAL_SCOPE_B_DONE',
    timeout: 45_000,
  })
  const manifestB = await manifest(accountBPage.page, identityB.workspaceId)
  assert.equal(manifestB.status, 200)
  assert.equal(manifestB.body.revision, 1)
  const fileB = manifestB.body.entries.find(entry => entry.path === 'account-scope.txt')
  const contentB = await accountBPage.page.evaluate(async entry => {
    const response = await fetch(`/api/browser-native/workspace/blob/${entry.hash}?protocolVersion=1&workspaceId=${encodeURIComponent(entry.workspaceId)}`)
    return await response.text()
  }, { ...fileB, workspaceId: identityB.workspaceId })
  assert.equal(contentB, 'principal-B\n')
  const localB = await localWorkspace(accountBPage.page, identityB.workspaceId)
  assert.equal(localB.metadata.workspaceId, identityB.workspaceId)
  assert.equal(localB.metadata.revision, manifestB.body.revision)
  assert.deepEqual(localB.blobs, [fileB.hash])
  assert.deepEqual(turnB.session.events.filter(event => event.type === 'tool/call'
    && event.data.turn === turnB.turn).map(event => event.data.name), ['write'])
  assert.notEqual(fileA.hash, fileB.hash)
  await accountBPage.page.close()

  await installPrincipalCookies(context, cookiesB)
  const accountBRestored = await openPage(context, origin, requestScopes, observations)
  assert.equal((await identity(accountBRestored.page)).workspaceId, identityB.workspaceId)
  const restoredManifestB = await manifest(accountBRestored.page, identityB.workspaceId)
  assert.equal(restoredManifestB.status, 200)
  assert.equal(restoredManifestB.body.revision, 1)
  const restoredWorkerFileB = await readWorkerFile(accountBRestored.page)
  assert.equal(restoredWorkerFileB.ok, true)
  assert.equal(restoredWorkerFileB.content, 'principal-B\n')
  const restoredSessionsB = await listSessions(accountBRestored.page)
  assert.equal(turnB.sessionId, crossRead.sessionId)
  const sessionIdsB = restoredSessionsB.body.items.map(item => item.sessionId)
  assert.ok(sessionIdsB.includes(turnB.sessionId))
  assert.equal(sessionIdsB.includes(turnA.sessionId), false)
  await accountBRestored.page.close()

  await installPrincipalCookies(context, cookiesA)
  const accountARestored = await openPage(context, origin, requestScopes, observations)
  assert.equal((await identity(accountARestored.page)).workspaceId, identityA.workspaceId)
  const restoredManifestA = await manifest(accountARestored.page, identityA.workspaceId)
  assert.equal(restoredManifestA.status, 200)
  assert.equal(restoredManifestA.body.revision, 1)
  const restoredWorkerFileA = await readWorkerFile(accountARestored.page)
  assert.deepEqual({ ok: restoredWorkerFileA.ok, path: restoredWorkerFileA.path, content: restoredWorkerFileA.content }, {
    ok: true,
    path: workspacePath,
    content: 'principal-A\n',
  })
  const restoredLocalA = await localWorkspace(accountARestored.page, identityA.workspaceId)
  assert.equal(restoredLocalA.metadata.revision, 1)
  assert.deepEqual(restoredLocalA.blobs, [fileA.hash])
  const restoredSessionA = await sessionRequest(origin, 'read', { sessionId: turnA.sessionId, offset: 0 })
  assert.equal(restoredSessionA.status, 200)
  assert.equal(restoredSessionA.events.some(event => event.type === 'tool/call' && event.data.name === 'write'), true)
  const restoredSessionsA = await listSessions(accountARestored.page)
  const sessionIdsA = restoredSessionsA.body.items.map(item => item.sessionId)
  assert.ok(sessionIdsA.includes(turnA.sessionId))
  assert.equal(sessionIdsA.includes(turnB.sessionId), false)

  const observedScopes = await Promise.all(requestScopes)
  assert.ok(observedScopes.some(scope => scope.path === '/api/browser-native/session/create'
    && scope.cookieNames.includes('dsh-browser-native-session-principal')))
  assert.ok(observedScopes.some(scope => scope.path === '/api/browser-native/workspace/manifest'
    && scope.cookieNames.includes('dsh-browser-native-principal')))
  assert.equal(observedScopes.filter(scope => scope.path === '/api/browser-native/llm')
    .some(scope => scope.cookieNames.some(name => principalCookieNames.has(name))), false)
  assert.deepEqual(observations.pageErrors, [])
  assert.deepEqual(observations.externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'same-origin-principal-switch-with-real-DSH-Worker-Session-and-OPFS-IDB-isolation',
    workspaceIds: [identityA.workspaceId, identityB.workspaceId],
    sessionIds: [turnA.sessionId, crossRead.sessionId],
    revisions: [manifestA.body.revision, manifestB.body.revision, restoredManifestA.body.revision],
    accountAContent: contentA,
    accountBContent: contentB,
    accountBReadRejected: crossReadResult.data.message.isError,
    accountBRestoredFromWorkerCache: restoredWorkerFileB.content,
    accountARestoredFromWorkerCache: restoredWorkerFileA.content,
    localBlobSetsAreDistinct: JSON.stringify(localA.blobs) !== JSON.stringify(localB.blobs),
    sessionPrincipalCookieOnLlmRequests: observedScopes.filter(scope => scope.path === '/api/browser-native/llm')
      .some(scope => scope.cookieNames.includes('dsh-browser-native-session-principal')),
    pageErrors: observations.pageErrors,
    externalRequests: observations.externalRequests,
  })}\n`)
} finally {
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  if (ownedDataDir) await rm(dataDir, { recursive: true, force: true })
}
