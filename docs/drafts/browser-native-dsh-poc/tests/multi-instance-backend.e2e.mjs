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
import { assistantText, openPreview, sendTurn, sessionRequest, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const mode = process.env.DSH_POC_LLM_MODE ?? 'scripted'
const envFile = process.env.DSH_POC_ENV_FILE
if (mode !== 'scripted' && mode !== 'real') throw new Error('DSH_POC_LLM_MODE must be scripted or real')
if (mode === 'real' && envFile === undefined) throw new Error('DSH_POC_ENV_FILE is required for real LLM mode')

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
    const headers = { ...request.headers, host: targetUrl.host }
    const upstream = fetchTarget(targetUrl, request, headers)
    upstream.on('response', upstreamResponse => {
      const responseHeaders = { ...upstreamResponse.headers, 'x-browser-native-cluster-target': target.label }
      delete responseHeaders.connection
      delete responseHeaders['keep-alive']
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
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

function fetchTarget(targetUrl, request, headers) {
  return httpRequest({
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    method: request.method,
    path: request.url,
    headers,
  })
}

const dataRoot = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-cluster-')))
const image = await createRuntimeValidationDist({ roster: 'browser' })
const sharedSecret = `${randomUUID()}${randomUUID()}`
const authorityDataDir = join(dataRoot, 'authority')
const backendDataDirs = [join(dataRoot, 'backend-a'), join(dataRoot, 'backend-b')]
let authority
let backendA
let backendB
let proxy
let browser
let context
let page
const pageErrors = []
const requests = []

function bodyOf(request) {
  try { return request.postDataJSON() ?? {} } catch { return {} }
}

try {
  let dropCommitResponse = mode === 'scripted'
  authority = await listen(await createBrowserNativeV2Server({
    dataDir: authorityDataDir,
    distRoot: image.distRoot,
    llmMode: mode,
    envFile,
    stateAuthorityToken: sharedSecret,
    testHooks: {
      dropWorkspaceCommitResponse: () => {
        if (!dropCommitResponse) return false
        dropCommitResponse = false
        return true
      },
    },
  }))
  backendA = await listen(await createBrowserNativeV2Server({
    dataDir: backendDataDirs[0],
    distRoot: image.distRoot,
    llmMode: mode,
    envFile,
    stateAuthorityOrigin: authority.origin,
    stateAuthorityToken: sharedSecret,
  }))
  backendB = await listen(await createBrowserNativeV2Server({
    dataDir: backendDataDirs[1],
    distRoot: image.distRoot,
    llmMode: mode,
    envFile,
    stateAuthorityOrigin: authority.origin,
    stateAuthorityToken: sharedSecret,
  }))
  const targets = [
    { label: 'backend-a', get origin() { return backendA.origin } },
    { label: 'backend-b', get origin() { return backendB.origin } },
  ]
  proxy = await startProxy(targets)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    requests.push({ path: url.pathname, method: request.method(), body: bodyOf(request), status: undefined })
  })
  page.on('response', response => {
    const url = new URL(response.url())
    const record = requests.findLast(candidate => candidate.path === url.pathname && candidate.status === undefined)
    if (record !== undefined) record.status = response.status()
  })

  const previewUrl = `${proxy.origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`
  await openPreview(page, previewUrl)
  const firstPrompt = mode === 'scripted'
    ? 'BROWSER_NATIVE_WORKSPACE_TOOL_E2E shared authority route: write the workspace file exactly once.'
    : 'Use exactly this tool sequence and no other tool calls: (1) call the DSH write tool once with file_path "/dsh/home/workspace/clustered.txt" and content "clustered-backend-write-ok"; (2) call the DSH read tool once with file_path "/dsh/home/workspace/clustered.txt". Confirm the exact content and reply exactly REAL_CLUSTERED_BACKEND_DONE.'
  const firstMarker = mode === 'scripted' ? 'BROWSER_NATIVE_WORKSPACE_TOOL_DONE' : undefined
  const first = await sendTurn({
    page,
    origin: proxy.origin,
    requests,
    prompt: firstPrompt,
    marker: firstMarker,
    timeout: Number(process.env.DSH_POC_TURN_TIMEOUT_MS ?? '240000'),
  })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })

  const firstSession = await sessionRequest(proxy.origin, 'read', { sessionId: first.sessionId, offset: 0 })
  assert.equal(firstSession.status, 200, JSON.stringify(firstSession))
  const firstPromptCount = firstSession.events.filter(event => event.type === 'user/message'
    && JSON.stringify(event).includes(firstPrompt)).length
  if (mode === 'scripted') {
    assert.equal(firstPromptCount, 1)
  } else {
    assert.ok(firstSession.events.filter(event => event.type === 'user/message').length > 0)
  }
  if (mode === 'real') assert.notEqual(assistantText(firstSession, first.turn).trim(), '')
  assert.equal(dropCommitResponse, false, 'scripted authority must exercise one committed Workspace response loss')

  const backendBDataDir = backendDataDirs[1]
  const backendBPort = backendB.port
  await backendB.app.close()
  backendB = await listen(await createBrowserNativeV2Server({
    dataDir: backendBDataDir,
    distRoot: image.distRoot,
    llmMode: mode,
    envFile,
    stateAuthorityOrigin: authority.origin,
    stateAuthorityToken: sharedSecret,
  }), backendBPort)

  const authorityPort = authority.port
  await authority.app.close()
  authority = await listen(await createBrowserNativeV2Server({
    dataDir: authorityDataDir,
    distRoot: image.distRoot,
    llmMode: mode,
    envFile,
    stateAuthorityToken: sharedSecret,
  }), authorityPort)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const secondPrompt = mode === 'scripted'
    ? 'BROWSER_NATIVE_SCRIPTED_E2E_OK clustered backend follow-up after both process restarts.'
    : 'Call the DSH read tool exactly once with file_path "/dsh/home/workspace/clustered.txt" and confirm the exact content "clustered-backend-write-ok". Reply exactly REAL_CLUSTERED_BACKEND_AFTER_RESTART_DONE.'
  const secondMarker = mode === 'scripted' ? 'BROWSER_NATIVE_SCRIPTED_E2E_OK' : undefined
  const second = await sendTurn({
    page,
    origin: proxy.origin,
    requests,
    prompt: secondPrompt,
    marker: secondMarker,
    sessionId: first.sessionId,
    timeout: Number(process.env.DSH_POC_TURN_TIMEOUT_MS ?? '240000'),
  })

  const finalSession = await sessionRequest(proxy.origin, 'read', { sessionId: first.sessionId, offset: 0 })
  assert.equal(finalSession.status, 200, JSON.stringify(finalSession))
  if (mode === 'scripted') {
    assert.equal(finalSession.events.filter(event => event.type === 'user/message'
      && JSON.stringify(event).includes(firstPrompt)).length, 1)
    assert.equal(finalSession.events.filter(event => event.type === 'user/message'
      && JSON.stringify(event).includes(secondPrompt)).length, 1)
  } else {
    assert.ok(finalSession.events.filter(event => event.type === 'user/message').length >= 2)
  }
  assert.equal(finalSession.events.filter(event => event.type === 'turn/end').length, 2)
  if (mode === 'real') assert.notEqual(assistantText(finalSession, second.turn).trim(), '')
  const authoritySession = authority.app.store.get(first.sessionId)
  assert.equal(authoritySession.events.length, finalSession.events.length)
  assert.equal(authoritySession.durableThroughSeq, finalSession.events.length - 1)
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  const authorityWorkspace = authority.app.workspaces.workspaces.get(workspaceId)
  assert.ok(authorityWorkspace, `shared authority must retain Workspace ${String(workspaceId)}`)
  const toolCallCount = finalSession.events.filter(event => event.type === 'tool/call').length
  if (mode === 'scripted') {
    assert.equal(authorityWorkspace.revision, 1)
    assert.equal(authorityWorkspace.operations.size, 1)
  } else if (toolCallCount > 0) {
    assert.equal(authorityWorkspace.revision, 1)
    assert.equal(authorityWorkspace.operations.size, 1)
  } else {
    assert.equal(authorityWorkspace.revision, 0)
    assert.equal(authorityWorkspace.operations.size, 0)
  }
  const labels = new Set(proxy.hits.filter(hit => hit.path?.startsWith('/api/')).map(hit => hit.label))
  assert.deepEqual(labels, new Set(['backend-a', 'backend-b']))
  for (const label of labels) {
    assert.ok(proxy.hits.some(hit => hit.label === label && hit.path === '/api/browser-native/llm'), `${label} must serve an LLM request`)
    assert.ok(proxy.hits.some(hit => hit.label === label && hit.path?.startsWith('/api/browser-native/session/')), `${label} must serve Session traffic`)
  }
  assert.deepEqual(pageErrors, [])
  const commits = requests.filter(request => request.path === '/api/browser-native/workspace/commit')
  const operationIds = new Set(commits.map(request => request.body.operationId).filter(Boolean))
  if (mode === 'scripted' || toolCallCount > 0) {
    assert.equal(operationIds.size, 1, `expected one Workspace operation, got ${JSON.stringify([...operationIds])}`)
  } else {
    assert.equal(operationIds.size, 0)
  }
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    mode,
    scope: 'shared-authority-round-robin-backend-restart-and-response-loss',
    sessionId: first.sessionId,
    eventCount: finalSession.events.length,
    durableThroughSeq: finalSession.durableThroughSeq,
    turns: [first.turn, second.turn],
    backendLabels: [...labels],
    backendHitCount: proxy.hits.filter(hit => hit.path?.startsWith('/api/')).length,
    llmRequestCount: requests.filter(request => request.path === '/api/browser-native/llm').length,
    toolCallCount,
    workspaceCommitStatuses: commits.map(request => request.status),
    uniqueWorkspaceOperationIds: operationIds.size,
    authorityRestarted: true,
    backendRestarted: true,
    pageErrors,
  })}\n`)
} catch (error) {
  const sessionId = requests.find(request => request.path === '/api/browser-native/session/create')?.body.sessionId
  const session = typeof sessionId === 'string' ? authority?.app.store.sessions.get(sessionId) : undefined
  process.stderr.write(`${JSON.stringify({
    error: String(error),
    pageErrors,
    proxyHits: proxy?.hits,
    apiRequests: requests.map(request => ({ path: request.path, method: request.method, status: request.status })),
    session: session === undefined ? null : {
      eventTypes: session.events.map(event => event.type),
      durableThroughSeq: session.durableThroughSeq,
    },
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await proxy?.close().catch(() => {})
  await backendB?.app.close().catch(() => {})
  await backendA?.app.close().catch(() => {})
  await authority?.app.close().catch(() => {})
  await image.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataRoot, { recursive: true, force: true })
}
