import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { sendTurn, sessionRequest, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataRoot = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-shared-authority-e2e-')))
const authorityDataDir = join(dataRoot, 'authority')
const backendDataDirs = [join(dataRoot, 'backend-a'), join(dataRoot, 'backend-b')]
const sharedSecret = `${randomUUID()}${randomUUID()}`
const pageErrors = []
const apiRequests = []
const contexts = []
let image
let authority
let backendA
let backendB
let proxy
let browser

async function listen(app, port = 0) {
  const origin = await app.listen(port)
  return { app, origin, port: Number(new URL(origin).port) }
}

async function startProxy(targets) {
  let next = 0
  const hits = []
  const server = createServer((request, response) => {
    const target = targets[next % targets.length]
    next += 1
    hits.push({ label: target.label, method: request.method, path: request.url })
    const targetUrl = new URL(target.origin)
    const upstream = httpRequest({
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: targetUrl.host },
    })
    upstream.on('response', upstreamResponse => {
      const headers = { ...upstreamResponse.headers, 'x-browser-native-cluster-target': target.label }
      delete headers.connection
      delete headers['keep-alive']
      response.writeHead(upstreamResponse.statusCode ?? 502, headers)
      upstreamResponse.pipe(response)
    })
    upstream.on('error', error => {
      if (response.headersSent || response.destroyed) return
      response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: { code: 'CLUSTER_BACKEND_UNAVAILABLE', message: String(error) } }))
    })
    request.on('aborted', () => upstream.destroy())
    request.pipe(upstream)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  return {
    origin: `http://127.0.0.1:${address.port}`,
    hits,
    close: async () => await new Promise((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose())
    }),
  }
}

async function racePost(pages, origin, pathname, body) {
  let arrivals = 0
  let release
  let rejectBarrier
  const barrier = new Promise((resolveBarrier, reject) => {
    release = resolveBarrier
    rejectBarrier = reject
  })
  const deadline = setTimeout(() => rejectBarrier(new Error(`claim race did not reach both pages: ${pathname}`)), 10_000)
  const routeUrl = `${origin}${pathname}`
  const handlers = pages.map(page => async route => {
    arrivals += 1
    if (arrivals === pages.length) {
      clearTimeout(deadline)
      release()
    }
    await barrier
    await route.continue()
  })
  await Promise.all(pages.map((page, index) => page.route(routeUrl, handlers[index])))
  try {
    return await Promise.all(pages.map((page, index) => page.evaluate(async ({ path, requestBody }) => {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
      })
      return { status: response.status, body: await response.json() }
    }, { path: pathname, requestBody: body(index) })))
  } finally {
    clearTimeout(deadline)
    await Promise.all(pages.map((page, index) => page.unroute(routeUrl, handlers[index])))
  }
}

async function pagePost(page, pathname, body) {
  return await page.evaluate(async ({ path, requestBody }) => {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    return { status: response.status, body: await response.json() }
  }, { path: pathname, requestBody: body })
}

function protocolBody(body = {}) {
  return { protocolVersion: 1, requestId: randomUUID(), ...body }
}

function watchPage(page, origin) {
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) apiRequests.push({ externalOrigin: url.origin, path: url.pathname })
    if (url.pathname.startsWith('/api/browser-native/')) {
      let body
      if (url.pathname === '/api/browser-native/session/create') {
        try { body = request.postDataJSON() ?? {} } catch { body = {} }
      }
      apiRequests.push({ origin: url.origin, method: request.method(), path: url.pathname, body })
    }
  })
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  authority = await listen(await createBrowserNativeV2Server({
    dataDir: authorityDataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    stateAuthorityToken: sharedSecret,
  }))
  backendA = await listen(await createBrowserNativeV2Server({
    dataDir: backendDataDirs[0],
    distRoot: image.distRoot,
    llmMode: 'scripted',
    stateAuthorityOrigin: authority.origin,
    stateAuthorityToken: sharedSecret,
  }))
  backendB = await listen(await createBrowserNativeV2Server({
    dataDir: backendDataDirs[1],
    distRoot: image.distRoot,
    llmMode: 'scripted',
    stateAuthorityOrigin: authority.origin,
    stateAuthorityToken: sharedSecret,
  }))
  proxy = await startProxy([
    { label: 'backend-a', get origin() { return backendA.origin } },
    { label: 'backend-b', get origin() { return backendB.origin } },
  ])
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  contexts.push(context)
  const workerPage = await context.newPage()
  watchPage(workerPage, proxy.origin)
  await workerPage.goto(`${proxy.origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`, { waitUntil: 'domcontentloaded' })
  await waitForPreview(workerPage)
  await workerPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })

  const firstPrompt = 'BROWSER_NATIVE_WORKSPACE_TOOL_E2E shared authority concurrency baseline: write the workspace file exactly once.'
  const first = await sendTurn({
    page: workerPage,
    origin: proxy.origin,
    requests: apiRequests,
    prompt: firstPrompt,
    marker: 'BROWSER_NATIVE_WORKSPACE_TOOL_DONE',
    timeout: Number(process.env.DSH_POC_TURN_TIMEOUT_MS ?? '180000'),
  })
  const firstSession = await sessionRequest(proxy.origin, 'read', { sessionId: first.sessionId, offset: 0 })
  assert.equal(firstSession.events.filter(event => event.type === 'tool/call').length, 1)
  assert.equal(firstSession.events.filter(event => event.type === 'turn/end').length, 1)
  const workspaceId = await workerPage.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  const initialManifest = await workerPage.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(initialManifest.revision, 1)
  const initialOperationCount = authority.app.workspaces.workspaces.get(workspaceId).operations.size
  assert.equal(initialOperationCount, 1)

  const workspaceLease = await workerPage.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
  assert.equal(workspaceLease?.ok, true)
  const ownerToken = await workerPage.evaluate(sessionId => sessionStorage.getItem(
    `dsh.browser-native.owner.${encodeURIComponent(sessionId)}`,
  ), first.sessionId)
  assert.equal(typeof ownerToken, 'string')
  const closeSession = await pagePost(workerPage, '/api/browser-native/session/close', protocolBody({
    sessionId: first.sessionId,
    ownerToken,
    ownerEpoch: firstSession.ownerEpoch,
  }))
  assert.equal(closeSession.status, 200, JSON.stringify(closeSession.body))
  const releaseWorkspace = await pagePost(workerPage, '/api/browser-native/workspace/lease', protocolBody({
    workspaceId,
    operation: 'release',
    writerToken: workspaceLease.writerToken,
    fencingToken: workspaceLease.fencingToken,
  }))
  assert.equal(releaseWorkspace.status, 200, JSON.stringify(releaseWorkspace.body))
  await workerPage.close()

  const contenderPages = [await context.newPage(), await context.newPage()]
  for (const page of contenderPages) {
    watchPage(page, proxy.origin)
    await page.goto(`${proxy.origin}/api/browser-native/health`, { waitUntil: 'domcontentloaded' })
    assert.equal(await page.evaluate(() => location.origin), proxy.origin)
  }
  const sessionClaims = await racePost(contenderPages, proxy.origin, '/api/browser-native/session/open', index => protocolBody({
    sessionId: first.sessionId,
    access: 'write',
    contender: index,
  }))
  assert.equal(sessionClaims.filter(result => result.status === 200).length, 1, JSON.stringify(sessionClaims))
  assert.equal(sessionClaims.filter(result => result.status === 409 && result.body.error.code === 'SESSION_ALREADY_OWNED').length, 1)
  const sessionWinnerIndex = sessionClaims.findIndex(result => result.status === 200)
  const sessionOwner = sessionClaims[sessionWinnerIndex].body.owner

  const workspaceClaims = await racePost(contenderPages, proxy.origin, '/api/browser-native/workspace/lease', index => protocolBody({
    workspaceId,
    operation: 'claim',
    contender: index,
  }))
  assert.equal(workspaceClaims.filter(result => result.status === 200).length, 1, JSON.stringify(workspaceClaims))
  assert.equal(workspaceClaims.filter(result => result.status === 409 && result.body.error.code === 'WORKSPACE_ALREADY_OWNED').length, 1)
  const workspaceWinnerIndex = workspaceClaims.findIndex(result => result.status === 200)
  const lease = workspaceClaims[workspaceWinnerIndex].body
  assert.ok(lease.fencingToken > workspaceLease.fencingToken)

  const winnerPage = contenderPages[sessionWinnerIndex]
  const sessionRelease = await pagePost(winnerPage, '/api/browser-native/session/close', protocolBody({
    sessionId: first.sessionId,
    ownerToken: sessionOwner.ownerToken,
    ownerEpoch: sessionOwner.ownerEpoch,
  }))
  assert.equal(sessionRelease.status, 200, JSON.stringify(sessionRelease.body))
  const workspaceWinnerPage = contenderPages[workspaceWinnerIndex]
  const workspaceRelease = await pagePost(workspaceWinnerPage, '/api/browser-native/workspace/lease', protocolBody({
    workspaceId,
    operation: 'release',
    writerToken: lease.writerToken,
    fencingToken: lease.fencingToken,
  }))
  assert.equal(workspaceRelease.status, 200, JSON.stringify(workspaceRelease.body))

  const foreignContext = await browser.newContext({ locale: 'en-US' })
  contexts.push(foreignContext)
  const foreignPage = await foreignContext.newPage()
  watchPage(foreignPage, proxy.origin)
  await foreignPage.goto(`${proxy.origin}/api/browser-native/health`, { waitUntil: 'domcontentloaded' })
  const foreignIdentity = await foreignPage.evaluate(async () => {
    const response = await fetch('/api/browser-native/workspace/identity')
    return { status: response.status, body: await response.json() }
  })
  assert.equal(foreignIdentity.status, 200)
  assert.notEqual(foreignIdentity.body.workspaceId, workspaceId)
  const foreignManifest = await foreignPage.evaluate(async id => {
    const response = await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)
    return { status: response.status, body: await response.json() }
  }, workspaceId)
  assert.equal(foreignManifest.status, 403)
  const foreignSession = await pagePost(foreignPage, '/api/browser-native/session/read', protocolBody({
    sessionId: first.sessionId,
    offset: 0,
  }))
  assert.equal(foreignSession.status, 404)

  const authorityPort = authority.port
  await authority.app.close()
  authority = undefined
  const unavailableSession = await pagePost(contenderPages[0], '/api/browser-native/session/read', protocolBody({
    sessionId: first.sessionId,
    offset: 0,
  }))
  assert.equal(unavailableSession.status, 503, JSON.stringify(unavailableSession.body))
  assert.equal(unavailableSession.body.error.code, 'SHARED_STATE_UNAVAILABLE')
  const unavailableManifest = await contenderPages[1].evaluate(async id => {
    const response = await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)
    return { status: response.status, body: await response.json() }
  }, workspaceId)
  assert.equal(unavailableManifest.status, 503, JSON.stringify(unavailableManifest.body))
  assert.equal(unavailableManifest.body.error.code, 'SHARED_STATE_UNAVAILABLE')
  const unavailableLlm = await pagePost(contenderPages[0], '/api/browser-native/llm', protocolBody({
    sessionId: first.sessionId,
    ownerToken: sessionOwner.ownerToken,
    ownerEpoch: sessionOwner.ownerEpoch,
    messages: [{ role: 'user', content: 'authority outage must reject before model execution' }],
    tools: [],
  }))
  assert.equal(unavailableLlm.status, 503, JSON.stringify(unavailableLlm.body))
  assert.equal(unavailableLlm.body.error.code, 'SHARED_STATE_UNAVAILABLE')
  assert.equal(backendA.app.store.sessions.size, 0)
  assert.equal(backendB.app.store.sessions.size, 0)
  assert.equal(backendA.app.workspaces.workspaces.size, 0)
  assert.equal(backendB.app.workspaces.workspaces.size, 0)

  authority = await listen(await createBrowserNativeV2Server({
    dataDir: authorityDataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    stateAuthorityToken: sharedSecret,
  }), authorityPort)
  const recoveredPage = contenderPages[0]
  await recoveredPage.goto(`${proxy.origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`, { waitUntil: 'domcontentloaded' })
  await waitForPreview(recoveredPage)
  await recoveredPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const restoredFile = await recoveredPage.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'read',
    path: '/dsh/home/workspace/agent-receipt.txt',
  }))
  assert.equal(restoredFile?.content, 'BROWSER_NATIVE_WORKSPACE_TOOL_OK\n')
  const followupPrompt = 'BROWSER_NATIVE_SCRIPTED_E2E_OK shared authority recovered from its durable store.'
  const followup = await sendTurn({
    page: recoveredPage,
    origin: proxy.origin,
    requests: apiRequests,
    prompt: followupPrompt,
    marker: 'BROWSER_NATIVE_SCRIPTED_E2E_OK',
    sessionId: first.sessionId,
    timeout: Number(process.env.DSH_POC_TURN_TIMEOUT_MS ?? '180000'),
  })
  const finalSession = await sessionRequest(proxy.origin, 'read', { sessionId: first.sessionId, offset: 0 })
  assert.equal(finalSession.events.filter(event => event.type === 'user/message' && JSON.stringify(event).includes(firstPrompt)).length, 1)
  assert.equal(finalSession.events.filter(event => event.type === 'user/message' && JSON.stringify(event).includes(followupPrompt)).length, 1)
  assert.equal(finalSession.events.filter(event => event.type === 'turn/end').length, 2)
  assert.equal(finalSession.events.filter(event => event.type === 'tool/call').length, 1)
  assert.equal(finalSession.durableThroughSeq, finalSession.events.length - 1)
  const finalManifest = await recoveredPage.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(finalManifest.revision, 1)
  const restoredEntry = finalManifest.entries.find(entry => entry.path === 'agent-receipt.txt')
  assert.ok(restoredEntry)
  const remoteFile = await recoveredPage.evaluate(async ({ id, hash }) => {
    const response = await fetch(`/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`)
    return { status: response.status, content: await response.text() }
  }, { id: workspaceId, hash: restoredEntry.hash })
  assert.equal(remoteFile.status, 200)
  assert.equal(remoteFile.content, 'BROWSER_NATIVE_WORKSPACE_TOOL_OK\n')
  const persistedAuthoritySession = authority.app.store.get(first.sessionId)
  assert.equal(persistedAuthoritySession.events.length, finalSession.events.length)
  assert.equal(authority.app.workspaces.workspaces.get(workspaceId).operations.size, initialOperationCount)
  assert.equal(backendA.app.store.sessions.size, 0)
  assert.equal(backendB.app.store.sessions.size, 0)
  assert.equal(backendA.app.workspaces.workspaces.size, 0)
  assert.equal(backendB.app.workspaces.workspaces.size, 0)

  const backendLabels = new Set(proxy.hits.filter(hit => hit.path?.startsWith('/api/')).map(hit => hit.label))
  assert.deepEqual(backendLabels, new Set(['backend-a', 'backend-b']))
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(apiRequests.filter(request => request.externalOrigin), [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'round-robin-shared-authority-dual-page-races-outage-and-worker-recovery',
    backendLabels: [...backendLabels],
    sessionClaimStatuses: sessionClaims.map(result => result.status),
    workspaceClaimStatuses: workspaceClaims.map(result => result.status),
    sessionOwnerEpoch: sessionOwner.ownerEpoch,
    workspaceFencingTokens: [workspaceLease.fencingToken, lease.fencingToken],
    outageStatuses: [unavailableSession.status, unavailableManifest.status, unavailableLlm.status],
    foreignPrincipalStatuses: [foreignManifest.status, foreignSession.status],
    sessionEvents: finalSession.events.length,
    durableThroughSeq: finalSession.durableThroughSeq,
    turns: [first.turn, followup.turn],
    modelRequests: apiRequests.filter(request => request.path === '/api/browser-native/llm').length,
    workspaceRevision: finalManifest.revision,
    workspaceOperations: authority.app.workspaces.workspaces.get(workspaceId).operations.size,
    backendLocalSessionRecords: [backendA.app.store.sessions.size, backendB.app.store.sessions.size],
    backendLocalWorkspaceRecords: [backendA.app.workspaces.workspaces.size, backendB.app.workspaces.workspaces.size],
    pageErrors,
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    error: String(error),
    pageErrors,
    backendHits: proxy?.hits.map(hit => ({ label: hit.label, method: hit.method, path: hit.path })),
    apiRequests: apiRequests.map(request => ({ origin: request.origin ?? request.externalOrigin, method: request.method, path: request.path })),
  })}\n`)
  throw error
} finally {
  for (const context of contexts) await context.close().catch(() => {})
  await browser?.close().catch(() => {})
  await proxy?.close().catch(() => {})
  await backendB?.app.close().catch(() => {})
  await backendA?.app.close().catch(() => {})
  await authority?.app.close().catch(() => {})
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataRoot, { recursive: true, force: true })
}
