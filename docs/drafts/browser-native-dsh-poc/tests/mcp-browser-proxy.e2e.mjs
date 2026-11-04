/**
 * Browser-side MCP feasibility probe through a same-origin backend proxy.
 *
 * The page drives a Streamable HTTP MCP session with plain `fetch`: the
 * browser cannot spawn stdio servers, and a direct cross-origin request is
 * blocked without CORS. The backend proxy exposes an allowlisted upstream at
 * `/api/browser-native/mcp/<id>`, strips cookies, injects configured auth,
 * and streams SSE responses back unchanged.
 *
 * Usage:
 *   DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/mcp-browser-proxy.e2e.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview } from './runtime-test-support.mjs'
import { createMiniMcpServer } from './mini-mcp-server.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const ECHO_MARKER = 'MCP_PROXY_BROWSER_ECHO_9C41'
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-mcp-proxy-')))
const pageErrors = []
const workerErrors = []
const external = []
let mcp
let image
let app
let browser
let origin

try {
  mcp = await createMiniMcpServer()
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    requireLocalAuth: true,
    mcpServers: {
      echo: { url: `${mcp.origin}/mcp`, headers: { 'x-mcp-upstream-key': 'fixture' } },
      dead: { url: 'http://127.0.0.1:1/mcp' },
    },
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  await context.addCookies([{
    name: 'dsh-browser-native-auth',
    value: app.authToken,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
  }])
  const identity = await context.request.get(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(identity.status(), 200)
  const page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('request', request => {
    const requestOrigin = new URL(request.url()).origin
    if (requestOrigin !== origin && requestOrigin !== mcp.origin) external.push(request.url())
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)

  const result = await page.evaluate(async ({ proxyPath, fixtureOrigin, marker }) => {
    const initialize = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'browser-probe', version: '1.0.0' } },
    }
    const rpc = async (payload, sessionId) => {
      const response = await fetch(proxyPath, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
        },
        body: JSON.stringify(payload),
      })
      const text = await response.text()
      const contentType = response.headers.get('content-type') ?? ''
      let message
      if (contentType.includes('text/event-stream')) {
        const line = text.split('\n').find(candidate => candidate.startsWith('data:'))
        message = line === undefined ? undefined : JSON.parse(line.slice(5).trim())
      } else if (text.length > 0) {
        message = JSON.parse(text)
      }
      return {
        status: response.status,
        contentType,
        sessionId: response.headers.get('mcp-session-id') ?? undefined,
        message,
      }
    }
    const started = await rpc(initialize)
    const sessionId = started.sessionId
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId)
    const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId)
    const called = await rpc({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'echo', arguments: { text: marker } },
    }, sessionId)
    let directError
    try {
      await fetch(`${fixtureOrigin}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(initialize),
      })
      directError = 'no-error'
    } catch (error) {
      directError = String(error)
    }
    const unknown = await fetch('/api/browser-native/mcp/missing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(initialize),
    })
    const dead = await fetch('/api/browser-native/mcp/dead', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(initialize),
    })
    const method = await fetch(proxyPath, { method: 'PUT' })
    return {
      started,
      listed,
      called,
      directError,
      unknown: { status: unknown.status, body: await unknown.json() },
      dead: { status: dead.status, body: await dead.json() },
      method: { status: method.status, body: await method.json() },
    }
  }, { proxyPath: '/api/browser-native/mcp/echo', fixtureOrigin: mcp.origin, marker: ECHO_MARKER })

  assert.equal(result.started.status, 200, JSON.stringify(result.started))
  assert.equal(result.started.contentType.includes('application/json'), true)
  assert.equal(typeof result.started.sessionId, 'string')
  assert.equal(result.started.message.result.serverInfo.name, 'dsh-mini-mcp')
  assert.equal(result.listed.status, 200, JSON.stringify(result.listed))
  assert.deepEqual(result.listed.message.result.tools.map(tool => tool.name), ['echo'])
  assert.equal(result.called.status, 200, JSON.stringify(result.called))
  assert.equal(result.called.contentType.includes('text/event-stream'), true,
    'the proxy must stream the upstream SSE response')
  assert.equal(result.called.message.result.content[0].text, `MCP_ECHO:${ECHO_MARKER}`)
  assert.notEqual(result.directError, 'no-error', 'a direct cross-origin MCP request must be blocked without CORS')
  assert.equal(result.unknown.status, 404)
  assert.equal(result.unknown.body.error.code, 'MCP_SERVER_UNKNOWN')
  assert.equal(result.dead.status, 502)
  assert.equal(result.dead.body.error.code, 'MCP_UPSTREAM_UNAVAILABLE')
  assert.equal(result.method.status, 405)
  assert.equal(result.method.body.error.code, 'METHOD_NOT_ALLOWED')

  const proxied = mcp.requests.filter(request => request.url === '/mcp' && request.method === 'POST')
  assert.equal(proxied.length, 4, JSON.stringify(mcp.requests.map(request => request.method)))
  assert.equal(proxied.every(request => request.headers.cookie === undefined), true,
    'the proxy must not forward browser cookies upstream')
  assert.equal(proxied.every(request => request.headers.origin === undefined), true,
    'the proxy must not forward browser origin upstream')
  assert.equal(proxied.every(request => request.headers['x-mcp-upstream-key'] === 'fixture'), true,
    'the proxy must inject the configured upstream credential')

  const unauthenticated = await fetch(`${origin}/api/browser-native/mcp/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
  })
  const denied = await unauthenticated.json()
  assert.equal(unauthenticated.status, 401, JSON.stringify(denied))
  assert.equal(denied.error.code, 'AUTH_REQUIRED',
    JSON.stringify(denied), 'the proxy must stay behind process authentication')

  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(external, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    scope: 'mcp-browser-proxy-streamable-http',
    browser: browser.version(),
    upstream: { origin: mcp.origin, requests: proxied.length },
    initialize: { status: result.started.status, server: result.started.message.result.serverInfo },
    tools: result.listed.message.result.tools.map(tool => tool.name),
    call: { contentType: result.called.contentType, text: result.called.message.result.content[0].text },
    directCrossOrigin: result.directError,
    unknown: result.unknown.body.error.code,
    dead: result.dead.body.error.code,
    method: result.method.body.error.code,
    unauthenticated: denied.error.code,
    headers: { cookieForwarded: false, originForwarded: false, upstreamCredentialInjected: true },
    pageErrors,
    workerErrors,
    external,
  })}\n`)
} finally {
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup?.()
  await mcp?.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
