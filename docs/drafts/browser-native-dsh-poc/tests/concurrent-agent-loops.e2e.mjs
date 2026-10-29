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
import { assistantText, openPreview, sendTurn, sessionRequest, submitPrompt, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
if (browserName !== 'chrome') throw new Error('Concurrent Agent Loop validation runs only in Chrome')

const dataRoot = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-concurrent-loops-')))
const authorityDataDir = join(dataRoot, 'authority')
const backendDataDirs = [join(dataRoot, 'backend-a'), join(dataRoot, 'backend-b')]
const sharedSecret = `${randomUUID()}${randomUUID()}`
const previewPath = '/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none'
const apiRequests = []
const roleRequests = { owner: [], observer: [] }
const gatedModelRequests = []
const hookObservations = []
const requestRecords = new WeakMap()
const pageErrors = []
const externalRequests = []
const commits = []
const contexts = []
let image
let authority
let backendA
let backendB
let proxy
let browser
let ownerPage
let observerPage
let parallelTurns
let parallelBarrierEnabled = false
let parallelRequestCount = 0
let releaseParallelRequests
let arrivalsReached
let signalArrivals
let oldEditTurnPromise
let workspaceId

const parallelRequestsReleased = new Promise(resolveRelease => { releaseParallelRequests = resolveRelease })
arrivalsReached = new Promise(resolveArrivals => { signalArrivals = resolveArrivals })

function scriptedLlmFault(backend) {
  return body => {
    if (!parallelBarrierEnabled) return undefined
    const messagesText = JSON.stringify(body.messages)
    const marker = ['BROWSER_NATIVE_PARALLEL_OWNER_LOOP_E2E', 'BROWSER_NATIVE_PARALLEL_OBSERVER_LOOP_E2E']
      .find(candidate => messagesText.includes(candidate))
    hookObservations.push({
      backend,
      purpose: body.purpose ?? null,
      hasSessionId: typeof body.sessionId === 'string',
      toolCount: Array.isArray(body.tools) ? body.tools.length : null,
      marker: marker ?? null,
    })
    if (body.purpose !== undefined || typeof body.sessionId !== 'string'
      || !Array.isArray(body.tools) || body.tools.length === 0) return undefined
    if (marker === undefined) return undefined
    parallelRequestCount += 1
    gatedModelRequests.push({ backend, sessionId: body.sessionId, marker, toolCount: body.tools.length })
    if (parallelRequestCount === 2) signalArrivals()
    return { kind: 'barrier-text', release: parallelRequestsReleased, text: `${marker}_DONE` }
  }
}

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

async function workerRequest(page, body) {
  return await page.evaluate(async input => {
    const request = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof request !== 'function') throw new Error('Browser-Native Worker test port is unavailable')
    return await request(input)
  }, body)
}

async function workspaceIdentity(page) {
  return await page.evaluate(async () => await (await fetch('/api/browser-native/workspace/identity')).json())
}

async function workspaceManifest(page, id) {
  return await page.evaluate(async workspaceIdValue => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceIdValue)}`,
  )).json(), id)
}

async function remoteFileText(page, id, manifest, path) {
  const entry = manifest.entries.find(candidate => candidate.path === path)
  assert.ok(entry, `manifest must contain ${path}`)
  return await page.evaluate(async ({ workspaceIdValue, hash }) => await (await fetch(
    `/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceIdValue)}`,
  )).text(), { workspaceIdValue: id, hash: entry.hash })
}

function toolCalls(session, turn, name) {
  return session.events.filter(event => event.type === 'tool/call'
    && event.data.turn === turn
    && (name === undefined || event.data.name === name))
}

function toolResult(session, call) {
  return session.events.find(event => event.type === 'tool/result'
    && (event.data.message?.toolCallId === call.data.callId
      || event.data.message?.source?.callId === call.data.callId
      || event.data.toolCallId === call.data.callId
      || event.data.callId === call.data.callId))
}

function assertPromptOnce(session, prompt) {
  assert.equal(session.events.filter(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(prompt)).length, 1, `prompt must be recorded once: ${prompt}`)
}

function watchPage(page, role) {
  page.on('pageerror', error => pageErrors.push({ role, message: error.message }))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== proxy.origin) externalRequests.push({ role, origin: url.origin, path: url.pathname })
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    const record = { role, path: url.pathname, method: request.method(), body, status: undefined, backend: undefined }
    requestRecords.set(request, record)
    apiRequests.push(record)
    roleRequests[role].push(record)
    if (url.pathname === '/api/browser-native/workspace/commit') commits.push(record)
  })
  page.on('response', response => {
    const record = requestRecords.get(response.request())
    if (record === undefined) return
    record.status = response.status()
    record.backend = response.headers()['x-browser-native-cluster-target']
  })
}

function routeCounts(items) {
  const counts = new Map()
  for (const item of items) {
    const route = item.path.split('?')[0]
      .replace(/\/blob-upload\/[^/]+\/\d+/g, '/blob-upload/:upload/:chunk')
      .replace(/\/blob-upload\/[^/]+/g, '/blob-upload/:upload')
      .replace(/\/blob\/[a-f0-9]+/g, '/blob/:hash')
    const label = `${item.role ?? item.label} ${item.method} ${route} ${item.status ?? ''}`.trim()
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)))
}

async function openObserverPage(page, role) {
  await page.goto(`${proxy.origin}/api/browser-native/health`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { localStorage.removeItem('dsh.sessions.current') })
  await openPreview(page, `${proxy.origin}${previewPath}`)
  await page.waitForFunction(() => ['read-only', 'synced'].includes(
    window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state,
  ), undefined, { timeout: 30_000 })
  const state = await workerRequest(page, { action: 'lease-info' })
  assert.equal(state.ok, role === 'owner', JSON.stringify(state))
  assert.equal(state.accessMode, role === 'owner' ? 'writer' : 'observer')
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
    testHooks: { scriptedLlmFault: scriptedLlmFault('backend-a') },
  }))
  backendB = await listen(await createBrowserNativeV2Server({
    dataDir: backendDataDirs[1],
    distRoot: image.distRoot,
    llmMode: 'scripted',
    stateAuthorityOrigin: authority.origin,
    stateAuthorityToken: sharedSecret,
    testHooks: { scriptedLlmFault: scriptedLlmFault('backend-b') },
  }))
  proxy = await startProxy([
    { label: 'backend-a', get origin() { return backendA.origin } },
    { label: 'backend-b', get origin() { return backendB.origin } },
  ])
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  contexts.push(context)
  ownerPage = await context.newPage()
  observerPage = await context.newPage()
  watchPage(ownerPage, 'owner')
  watchPage(observerPage, 'observer')

  await openPreview(ownerPage, `${proxy.origin}${previewPath}`)
  await ownerPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced',
    undefined, { timeout: 30_000 })
  const ownerIdentity = await workspaceIdentity(ownerPage)
  workspaceId = ownerIdentity.workspaceId

  const ownerWritePrompt = 'BROWSER_NATIVE_WORKSPACE_OBSERVER_OWNER_E2E: commit one shared file.'
  const ownerWriteTurn = await sendTurn({
    page: ownerPage,
    origin: proxy.origin,
    requests: roleRequests.owner,
    prompt: ownerWritePrompt,
    marker: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_OWNER_DONE',
    timeout: 120_000,
  })
  assertPromptOnce(ownerWriteTurn.session, 'BROWSER_NATIVE_WORKSPACE_OBSERVER_OWNER_E2E')
  const ownerManifest = await workspaceManifest(ownerPage, workspaceId)
  assert.equal(ownerManifest.revision, 1)
  const ownerWriteCall = toolCalls(ownerWriteTurn.session, ownerWriteTurn.turn, 'write')[0]
  assert.ok(ownerWriteCall)
  assert.equal(toolResult(ownerWriteTurn.session, ownerWriteCall)?.data.message?.isError, false)
  const ownerWriteReceipt = ownerWriteTurn.session.events.filter(event => event.type === 'browser-native/workspace-receipt'
    && event.data.callId === ownerWriteCall.data.callId)
  assert.equal(ownerWriteReceipt.length, 1)

  await openObserverPage(observerPage, 'observer')
  const observerIdentity = await workspaceIdentity(observerPage)
  assert.equal(observerIdentity.workspaceId, workspaceId)

  parallelBarrierEnabled = true
  parallelTurns = Promise.all([
    sendTurn({
      page: ownerPage,
      origin: proxy.origin,
      requests: roleRequests.owner,
      prompt: 'BROWSER_NATIVE_PARALLEL_OWNER_LOOP_E2E: complete this independent session request.',
      timeout: 120_000,
    }),
    sendTurn({
      page: observerPage,
      origin: proxy.origin,
      requests: roleRequests.observer,
      prompt: 'BROWSER_NATIVE_PARALLEL_OBSERVER_LOOP_E2E: complete this independent session request.',
      timeout: 120_000,
    }),
  ])
  await Promise.race([
    arrivalsReached,
    waitFor(() => parallelRequestCount === 2, 'two concurrent Agent Loop model requests', 20_000),
  ])
  assert.equal(parallelRequestCount, 2, 'both model requests must be held at the same barrier')
  assert.deepEqual(new Set(gatedModelRequests.map(request => request.marker)), new Set([
    'BROWSER_NATIVE_PARALLEL_OWNER_LOOP_E2E', 'BROWSER_NATIVE_PARALLEL_OBSERVER_LOOP_E2E',
  ]))
  assert.equal(new Set(gatedModelRequests.map(request => request.sessionId)).size, 2)
  assert.ok(gatedModelRequests.every(request => request.toolCount > 0))
  const parallelSessions = await Promise.all([ownerPage, observerPage].map(async page => {
    const role = page === ownerPage ? 'owner' : 'observer'
    const sessionId = await waitFor(async () => apiRequests.find(item => item.role === role
      && item.path === '/api/browser-native/session/create')?.body.sessionId, `${role} Session creation`)
    const session = await waitFor(async () => {
      try {
        const current = await sessionRequest(proxy.origin, 'read', { sessionId, offset: 0 })
        const markers = current.events.filter(event => event.type === 'user/message'
          && JSON.stringify(event.data).includes('BROWSER_NATIVE_PARALLEL_'))
        const promptIndex = current.events.findLastIndex(event => event.type === 'user/message'
          && JSON.stringify(event.data).includes(role === 'owner'
            ? 'BROWSER_NATIVE_PARALLEL_OWNER_LOOP_E2E'
            : 'BROWSER_NATIVE_PARALLEL_OBSERVER_LOOP_E2E'))
        const turnEnded = current.events.some((event, index) => index > promptIndex && event.type === 'turn/end')
        return markers.length === 1 && promptIndex >= 0 && !turnEnded ? current : undefined
      } catch { return undefined }
    }, `${role} Session remains independently active`)
    return { role, sessionId, session }
  }))
  assert.notEqual(parallelSessions[0].sessionId, parallelSessions[1].sessionId)
  assert.ok(parallelSessions.every(item => item.session.events.filter(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes('BROWSER_NATIVE_PARALLEL_')).length === 1))
  parallelBarrierEnabled = false
  releaseParallelRequests()
  const [ownerParallelTurn, observerParallelTurn] = await parallelTurns
  assert.notEqual(ownerParallelTurn.sessionId, observerParallelTurn.sessionId)
  assertPromptOnce(ownerParallelTurn.session, 'BROWSER_NATIVE_PARALLEL_OWNER_LOOP_E2E')
  assertPromptOnce(observerParallelTurn.session, 'BROWSER_NATIVE_PARALLEL_OBSERVER_LOOP_E2E')
  assert.equal(toolCalls(ownerParallelTurn.session, ownerParallelTurn.turn).length, 0)
  assert.equal(toolCalls(observerParallelTurn.session, observerParallelTurn.turn).length, 0)
  assert.notEqual(assistantText(ownerParallelTurn.session, ownerParallelTurn.turn).trim(), '')
  assert.notEqual(assistantText(observerParallelTurn.session, observerParallelTurn.turn).trim(), '')

  const observerReadPrompt = 'BROWSER_NATIVE_WORKSPACE_OBSERVER_READ_E2E: read the committed owner file.'
  const observerReadTurn = await sendTurn({
    page: observerPage,
    origin: proxy.origin,
    requests: roleRequests.observer,
    prompt: observerReadPrompt,
    marker: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_READ_DONE',
    timeout: 120_000,
  })
  assert.notEqual(ownerWriteTurn.sessionId, observerReadTurn.sessionId)
  assertPromptOnce(observerReadTurn.session, 'BROWSER_NATIVE_WORKSPACE_OBSERVER_READ_E2E')
  const observerReadCall = toolCalls(observerReadTurn.session, observerReadTurn.turn, 'read')[0]
  assert.ok(observerReadCall)
  assert.equal(toolResult(observerReadTurn.session, observerReadCall)?.data.message?.isError, false)
  assert.deepEqual(observerReadTurn.session.events.filter(event => event.type === 'browser-native/workspace-receipt'), [])
  const observerReadRequest = apiRequests.findLast(item => item.role === 'observer'
    && item.path === '/api/browser-native/llm'
    && JSON.stringify(item.body.messages).includes('BROWSER_NATIVE_WORKSPACE_OBSERVER_READ_E2E'))
  assert.ok(observerReadRequest)
  assert.deepEqual(
    (observerReadRequest.body.tools ?? []).map(tool => tool.function?.name ?? tool.name)
      .filter(name => ['edit', 'glob', 'grep', 'read', 'write'].includes(name)).sort(),
    ['glob', 'grep', 'read'],
  )

  const successfulCommitCountBeforeForgedWrite = commits.filter(item => item.status === 200).length
  const forgedWriteTurn = await sendTurn({
    page: observerPage,
    origin: proxy.origin,
    requests: roleRequests.observer,
    prompt: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_FORGED_WRITE_E2E: attempt a hidden write tool.',
    timeout: 120_000,
  })
  const forgedWriteCall = toolCalls(forgedWriteTurn.session, forgedWriteTurn.turn, 'write')[0]
  assert.ok(forgedWriteCall)
  assert.equal(toolResult(forgedWriteTurn.session, forgedWriteCall)?.data.message?.isError, true)
  assert.match(JSON.stringify(toolResult(forgedWriteTurn.session, forgedWriteCall)?.data.message?.content),
    /capability is not currently published|observer cannot execute/i)
  assert.equal(commits.filter(item => item.status === 200).length, successfulCommitCountBeforeForgedWrite)
  assert.equal((await workspaceManifest(observerPage, workspaceId)).revision, 1)
  const forgedFile = await workerRequest(observerPage, {
    action: 'read', path: '/dsh/home/workspace/observer-forged-write.txt',
  })
  assert.equal(forgedFile.ok, false)

  const workspacePath = '/dsh/home/workspace/lease-edit-race.txt'
  const seeded = await workerRequest(ownerPage, {
    action: 'write-pattern',
    path: workspacePath,
    byteLength: 32 * 1024 * 1024,
    byteValue: 120,
    lineBytes: 8192,
    markerLine: 2048,
    marker: 'BROWSER_NATIVE_LEASE_EDIT_OLD',
  })
  assert.equal(seeded.ok, true, JSON.stringify({ ok: seeded.ok, error: seeded.error }))
  const seedCommit = await workerRequest(ownerPage, { action: 'flush-workspace' })
  assert.equal(seedCommit.ok, true, JSON.stringify(seedCommit))
  await ownerPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 2, undefined, { timeout: 60_000 })

  const editDelay = await workerRequest(ownerPage, { action: 'set-file-tool-delay', delayMs: 500 })
  assert.deepEqual({ ok: editDelay.ok, delayMs: editDelay.delayMs }, { ok: true, delayMs: 500 })
  const editStagePromise = workerRequest(ownerPage, {
    action: 'wait-file-tool-stage', toolStage: 'copy-prefix', timeoutMs: 45_000,
  })
  oldEditTurnPromise = submitPrompt({
    page: ownerPage,
    origin: proxy.origin,
    requests: roleRequests.owner,
    prompt: 'BROWSER_NATIVE_WORKSPACE_LEASE_EDIT_RACE_E2E: replace the marker while another Worker takes ownership.',
    timeout: 180_000,
    probeWhileRunning: async ({ sessionId }) => {
      await editStagePromise
      const current = await sessionRequest(proxy.origin, 'read', { sessionId, offset: 0 })
      const editCall = current.events.find(event => event.type === 'tool/call'
        && event.data.name === 'edit' && JSON.stringify(event.data).includes('BROWSER_NATIVE_LEASE_EDIT_OLD_OWNER'))
      assert.ok(editCall, 'the active DSH edit call must be recorded before ownership transfer')
      assert.ok(current.durableThroughSeq >= Number(editCall.seq), 'the edit call must be durable before transfer')
    },
  })
  await editStagePromise
  await waitFor(async () => {
    const current = await sessionRequest(proxy.origin, 'read', { sessionId: ownerWriteTurn.sessionId, offset: 0 })
    return current.events.some(event => event.type === 'tool/call' && event.data.name === 'edit'
      && JSON.stringify(event.data).includes('BROWSER_NATIVE_LEASE_EDIT_OLD_OWNER')
      && current.durableThroughSeq >= Number(event.seq))
  }, 'durable old-owner edit call before Workspace release')
  const priorLease = await workerRequest(ownerPage, { action: 'lease-info' })
  assert.equal(priorLease.ok, true)
  assert.equal(priorLease.fencingToken, 1)
  const release = await workerRequest(ownerPage, { action: 'release-lease' })
  assert.equal(release.ok, true)

  roleRequests.observer.length = 0
  await observerPage.goto(`${proxy.origin}/api/browser-native/health`, { waitUntil: 'domcontentloaded' })
  await observerPage.evaluate(() => { localStorage.removeItem('dsh.sessions.current') })
  await openPreview(observerPage, `${proxy.origin}${previewPath}`)
  await observerPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced',
    undefined, { timeout: 60_000 })
  const successorLease = await workerRequest(observerPage, { action: 'lease-info' })
  assert.equal(successorLease.ok, true, JSON.stringify({ ok: successorLease.ok, accessMode: successorLease.accessMode }))
  assert.equal(successorLease.fencingToken, 2)
  let oldEditSettled = false
  void oldEditTurnPromise.then(() => { oldEditSettled = true }, () => { oldEditSettled = true })
  assert.equal(oldEditSettled, false, 'the old edit must remain in flight after the successor claims the lease')
  const successorSessionPrompt = 'BROWSER_NATIVE_WORKSPACE_LEASE_SUCCESSOR_E2E: write the new owner value to the same path.'
  const successorTurnPromise = sendTurn({
    page: observerPage,
    origin: proxy.origin,
    requests: roleRequests.observer,
    prompt: successorSessionPrompt,
    marker: 'BROWSER_NATIVE_WORKSPACE_LEASE_SUCCESSOR_DONE',
    timeout: 120_000,
  })
  const successorTurn = await successorTurnPromise
  assert.notEqual(successorTurn.sessionId, ownerWriteTurn.sessionId)
  assertPromptOnce(successorTurn.session, 'BROWSER_NATIVE_WORKSPACE_LEASE_SUCCESSOR_E2E')
  const successorManifest = await workspaceManifest(observerPage, workspaceId)
  assert.equal(successorManifest.revision, 3)
  assert.equal(await remoteFileText(observerPage, workspaceId, successorManifest, 'lease-edit-race.txt'),
    'BROWSER_NATIVE_LEASE_EDIT_NEW_OWNER\n')

  const oldEditTurn = await oldEditTurnPromise
  assertPromptOnce(oldEditTurn.session, 'BROWSER_NATIVE_WORKSPACE_LEASE_EDIT_RACE_E2E')
  const oldEditCall = toolCalls(oldEditTurn.session, oldEditTurn.turn, 'edit')[0]
  assert.ok(oldEditCall)
  const oldEditResult = toolResult(oldEditTurn.session, oldEditCall)
  assert.equal(oldEditResult?.data.message?.isError, true)
  assert.match(JSON.stringify(oldEditResult?.data.message?.content), /writer lease.*released|local writer was invalidated/i)
  assert.equal(oldEditTurn.session.events.filter(event => event.type === 'browser-native/workspace-receipt'
    && event.data.callId === oldEditCall.data.callId).length, 0)
  assert.equal(assistantText(oldEditTurn.session, oldEditTurn.turn), 'BROWSER_NATIVE_WORKSPACE_LEASE_EDIT_FENCED')
  const oldLocalFile = await workerRequest(ownerPage, { action: 'read', path: workspacePath })
  assert.equal(oldLocalFile.ok, true)
  assert.equal(oldLocalFile.content.includes('BROWSER_NATIVE_LEASE_EDIT_NEW_OWNER'), false)
  assert.equal(oldLocalFile.content.includes('BROWSER_NATIVE_LEASE_EDIT_OLD_OWNER'), false)
  const successorWriteCall = toolCalls(successorTurn.session, successorTurn.turn, 'write')[0]
  assert.ok(successorWriteCall)
  assert.equal(toolResult(successorTurn.session, successorWriteCall)?.data.message?.isError, false)
  const successorReceipt = successorTurn.session.events.find(event => event.type === 'browser-native/workspace-receipt'
    && event.data.callId === successorWriteCall.data.callId)
  assert.ok(successorReceipt)
  assert.equal(successorReceipt.data.operationId,
    commits.find(item => item.status === 200 && item.body.operationId === successorReceipt.data.operationId)?.body.operationId)

  const finalManifest = await workspaceManifest(observerPage, workspaceId)
  assert.equal(finalManifest.revision, 3)
  assert.equal(commits.filter(item => item.status === 200).length, 3)
  assert.equal(new Set(commits.filter(item => item.status === 200).map(item => item.body.operationId)).size, 3)
  assert.deepEqual(await Promise.all([backendA, backendB].map(async backend => ({
    sessions: backend.app.store.sessions.size,
    workspaces: backend.app.workspaces.workspaces.size,
  }))), [{ sessions: 0, workspaces: 0 }, { sessions: 0, workspaces: 0 }])
  assert.ok(authority.app.store.sessions.size >= 3)
  assert.ok(authority.app.workspaces.workspaces.get(workspaceId).operations.size >= 3)
  assert.deepEqual(new Set(proxy.hits.map(hit => hit.label)), new Set(['backend-a', 'backend-b']))
  const llmBackendLabels = new Set(apiRequests.filter(item => item.path === '/api/browser-native/llm'
    && item.method === 'POST').map(item => item.backend))
  assert.deepEqual(llmBackendLabels, new Set(['backend-a', 'backend-b']))
  assert.deepEqual(externalRequests, [])
  assert.deepEqual(pageErrors, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'parallel-dsh-loops-round-robin-authority-workspace-single-writer-and-stale-edit-fencing',
    backendLabels: [...new Set(proxy.hits.map(hit => hit.label))],
    llmBackendLabels: [...llmBackendLabels],
    overlappingModelRequests: parallelRequestCount,
    gatedModelRequests,
    sessionIds: [ownerParallelTurn.sessionId, observerParallelTurn.sessionId, successorTurn.sessionId],
    parallelTurns: [ownerParallelTurn.turn, observerParallelTurn.turn],
    observerToolRoster: ['glob', 'grep', 'read'],
    observerForgedWriteRejected: true,
    workspaceFencingTokens: [priorLease.fencingToken, successorLease.fencingToken],
    oldEditCallId: oldEditCall.data.callId,
    oldEditReceiptCount: 0,
    finalWorkspaceRevision: finalManifest.revision,
    successfulCommitCount: commits.filter(item => item.status === 200).length,
    authoritySessionCount: authority.app.store.sessions.size,
    backendLocalStateCounts: [backendA, backendB].map(backend => ({
      sessions: backend.app.store.sessions.size,
      workspaces: backend.app.workspaces.workspaces.size,
    })),
    llmRequestCount: apiRequests.filter(item => item.path === '/api/browser-native/llm').length,
    externalRequestCount: externalRequests.length,
    pageErrors,
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    workspaceStatus: await observerPage?.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__ ?? null).catch(() => null),
    backendHitCounts: proxy === undefined ? undefined : routeCounts(proxy.hits),
    apiRequestCounts: routeCounts(apiRequests),
    hookObservations,
    pageErrors,
    externalRequests,
  })}\n`)
  throw error
} finally {
  releaseParallelRequests?.()
  await parallelTurns?.catch(() => {})
  await oldEditTurnPromise?.catch(() => {})
  for (const context of contexts) await context.close().catch(() => {})
  await browser?.close().catch(() => {})
  await proxy?.close().catch(() => {})
  await backendB?.app.close().catch(() => {})
  await backendA?.app.close().catch(() => {})
  await authority?.app.close().catch(() => {})
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataRoot, { recursive: true, force: true })
}
