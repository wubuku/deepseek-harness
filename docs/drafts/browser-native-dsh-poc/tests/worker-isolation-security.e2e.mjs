/**
 * Verify what Worker-side tool execution can reach and how CSP/COOP/COEP change it.
 *
 * Each scenario boots the real preview with a fresh backend and records Worker
 * realm facts plus same-origin, cross-origin, opaque and credentialed fetches.
 * A scripted turn then proves ordinary tool dispatch still works under the
 * response headers.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { sendTurn, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const crossOriginRecords = []
const scenarios = [
  { name: 'baseline', headers: {}, expectIsolated: false },
  { name: 'csp', headers: { 'content-security-policy': "connect-src 'self' data:" }, expectIsolated: false },
  {
    name: 'coep',
    headers: {
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    },
    expectIsolated: true,
  },
]
let image
let browser
let crossOrigin
let crossOriginOrigin

function toolResultText(session, callId) {
  const event = session.events.find(candidate => candidate.type === 'tool/result'
    && candidate.data.message?.toolCallId === callId)
  assert.ok(event, `missing tool result for ${callId}`)
  const content = event.data.message.content
  if (typeof content === 'string') return content
  assert.ok(Array.isArray(content), `tool result for ${callId} has no text content`)
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

function reportsFor(path) {
  return crossOriginRecords.filter(record => record.path === path)
}

function assertDifferential(probe, scenario) {
  const { name } = scenario
  if (name === 'baseline') {
    assert.equal(probe.cors.ok, true, JSON.stringify(probe.cors))
    assert.equal(probe.cors.body, 'cors-ok')
    assert.equal(probe.noCors.ok, true, JSON.stringify(probe.noCors))
    assert.equal(probe.noCors.type, 'opaque')
    assert.equal(probe.noCorp.ok, true, JSON.stringify(probe.noCorp))
    assert.equal(probe.noCorp.body, 'no-corp-ok')
    assert.equal(probe.corp.ok, true, JSON.stringify(probe.corp))
    assert.equal(probe.corp.type, 'opaque')
  }
  if (name === 'csp') {
    assert.equal(probe.cors.ok, false, 'connect-src must block cross-origin fetch')
    assert.equal(probe.cors.error?.startsWith('TypeError'), true, String(probe.cors.error))
    assert.equal(probe.noCors.ok, false, 'connect-src must block no-cors cross-origin fetch')
  }
  if (name === 'coep') {
    assert.equal(probe.corp.ok, true, 'a CORP cross-origin resource must remain loadable under COEP')
    assert.equal(probe.noCors.ok, false, 'COEP must block a no-cors cross-origin load without CORP')
  }
}

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  crossOrigin = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://cross-origin.invalid')
    crossOriginRecords.push({
      path: url.pathname,
      cookie: request.headers.cookie ?? null,
      authorization: request.headers.authorization ?? null,
      mode: request.headers['sec-fetch-mode'] ?? null,
    })
    if (url.pathname === '/cors') {
      response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' })
      response.end('cors-ok')
      return
    }
    if (url.pathname === '/opaque') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('opaque-body')
      return
    }
    if (url.pathname === '/cookie') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        cookie: request.headers.cookie ?? null,
        authorization: request.headers.authorization ?? null,
      }))
      return
    }
    if (url.pathname === '/corp') {
      response.writeHead(200, {
        'cross-origin-resource-policy': 'cross-origin',
        'content-type': 'text/plain',
      })
      response.end('corp-ok')
      return
    }
    if (url.pathname === '/no-corp') {
      response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' })
      response.end('no-corp-ok')
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not-found')
  })
  await new Promise(resolveListen => crossOrigin.listen(0, '127.0.0.1', resolveListen))
  crossOriginOrigin = `http://127.0.0.1:${crossOrigin.address().port}`
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  const results = []
  for (const scenario of scenarios) {
    const dataDir = await mkdtemp(`${tmpdir()}/dsh-browser-isolation-${scenario.name}-`)
    const app = await createBrowserNativeV2Server({
      dataDir,
      distRoot: image.distRoot,
      llmMode: 'scripted',
      responseHeaders: scenario.headers,
    })
    const origin = await app.listen(0)
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
    const requests = []
    const pageErrors = []
    let page
    try {
      crossOriginRecords.length = 0
      page = await context.newPage()
      page.on('pageerror', error => pageErrors.push(error.message))
      if (process.env.DSH_POC_DEBUG === '1') {
        page.on('console', message => console.error(`[console:${message.type()}] ${message.text()}`))
        page.on('requestfailed', request => console.error(`[requestfailed] ${request.url()} ${request.failure()?.errorText}`))
      }
      page.on('request', request => {
        const url = new URL(request.url())
        if (!url.pathname.startsWith('/api/browser-native/')) return
        let body = {}
        try { body = JSON.parse(request.postData() ?? '{}') } catch {}
        requests.push({ path: url.pathname, body })
      })
      const preview = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
      await page.goto(preview, { waitUntil: 'domcontentloaded' })
      await waitForPreview(page)
      console.error(`[scenario] ${scenario.name} booted`)
      await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
      await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
      const urls = {
        sameOrigin: `${origin}/api/browser-native/health`,
        cors: `${crossOriginOrigin}/cors`,
        noCors: `${crossOriginOrigin}/opaque`,
        cookie: `${crossOriginOrigin}/cookie`,
        corp: `${crossOriginOrigin}/corp`,
        noCorp: `${crossOriginOrigin}/no-corp`,
      }
      const probe = await page.evaluate(targets => window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__({
        action: 'isolation-probe',
        urls: targets,
      }), urls)
      assert.equal(probe?.ok, true, JSON.stringify(probe))
      assert.equal(probe.realm.hasDocument, false, 'a Worker has no document')
      assert.equal(probe.realm.hasWindow, false, 'a Worker has no window')
      assert.equal(probe.realm.hasLocalStorage, false, 'a Worker has no localStorage')
      assert.equal(probe.realm.hasSessionStorage, false, 'a Worker has no sessionStorage')
      assert.equal(probe.realm.hasCookieStore, false, 'a Dedicated Worker has no CookieStore')
      assert.equal(probe.realm.hasIndexedDB, true)
      assert.equal(probe.realm.hasRequire, false, 'a Worker has no CommonJS require')
      assert.deepEqual(probe.realm.processEnvKeys.filter(key => /DEEPSEEK|OPENAI|API_KEY|SECRET|TOKEN/i.test(key)), [],
        'the Worker environment must not expose provider credentials')
      assert.equal(probe.realm.crossOriginIsolated, scenario.expectIsolated,
        `crossOriginIsolated must be ${String(scenario.expectIsolated)} under ${scenario.name}`)
      assert.equal(probe.sameOrigin.ok, true, JSON.stringify(probe.sameOrigin))
      assert.equal(probe.sameOrigin.status, 200)
      assert.equal(probe.sameOrigin.body.includes('"ok":true'), true)
      assertDifferential(probe, scenario)

      const cookieRecords = reportsFor('/cookie')
      if (scenario.name === 'csp') {
        assert.equal(crossOriginRecords.length, 0,
          'connect-src must stop cross-origin requests before they leave the Worker')
      } else {
        assert.ok(cookieRecords.length >= 1, 'the credentialed cross-origin request must reach the server')
      }
      assert.equal(crossOriginRecords.every(record => record.authorization === null), true,
        'the Worker must not send an Authorization header to a cross-origin endpoint')
      assert.equal(probe.cookie.ok, false, 'the Worker must not read a cross-origin response without CORS')
      const crossOriginCookieForwarded = crossOriginRecords.some(record =>
        (record.cookie ?? '').includes('dsh-browser-native-session-principal'))

      const marker = `BROWSER_NATIVE_ISOLATION_TOOL_OK_${scenario.name}`
      const turn = await sendTurn({
        page,
        origin,
        requests,
        prompt: `BROWSER_NATIVE_ISOLATION_TOOL_E2E ${scenario.name}`,
        marker: `BROWSER_NATIVE_ISOLATION_TOOL_E2E_DONE`,
      })
      const toolText = toolResultText(turn.session, 'browser-native-isolation-bash')
      assert.equal(toolText.includes('BROWSER_NATIVE_ISOLATION_TOOL_OK'), true, toolText)
      await page.evaluate(targets => window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__({
        action: 'isolation-probe',
        urls: { cookie: targets.cookie },
      }), urls)
      const postTurnRecords = reportsFor('/cookie')
      const postTurnCookie = postTurnRecords.at(-1) ?? null
      const postTurnCookieForwarded = (postTurnCookie?.cookie ?? '').includes('dsh-browser-native-session-principal')
      assert.equal(postTurnRecords.at(-1)?.authorization ?? null, null,
        'the Worker must never attach an Authorization header to a cross-origin endpoint')
      assert.deepEqual(pageErrors, [])
      results.push({
        scenario: scenario.name,
        headers: scenario.headers,
        realm: probe.realm,
        sameOrigin: { ok: probe.sameOrigin.ok, status: probe.sameOrigin.status },
        cors: { ok: probe.cors.ok, type: probe.cors.type, body: probe.cors.body, error: probe.cors.error },
        noCors: { ok: probe.noCors.ok, type: probe.noCors.type, body: probe.noCors.body, error: probe.noCors.error },
        cookie: { ok: probe.cookie.ok, error: probe.cookie.error, sessionCookieForwarded: crossOriginCookieForwarded },
        corp: { ok: probe.corp.ok, body: probe.corp.body },
        noCorp: { ok: probe.noCorp.ok, body: probe.noCorp.body, error: probe.noCorp.error },
        crossOriginRequests: crossOriginRecords.length,
        crossOriginAuthorizationHeaders: crossOriginRecords.filter(record => record.authorization !== null).length,
        credentialedRequests: cookieRecords.length,
        postTurnCookie: { forwarded: postTurnCookieForwarded },
        toolTurn: { marker, toolText },
      })
    } finally {
      await page?.close().catch(() => {})
      await context.close()
      await app.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  }
  const anyCookieForwarded = results.some(result => result.postTurnCookie.forwarded)
  const cspResult = results.find(result => result.scenario === 'csp')
  const coepResult = results.find(result => result.scenario === 'coep')
  const credentialPattern = /DEEPSEEK|OPENAI|API_KEY|SECRET|TOKEN/i
  console.log(JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'worker-isolation-and-response-headers',
    scenarios: results,
    verdict: {
      workerRealmLacksDocumentAndCookieAccess: results.every(result =>
        !result.realm.hasDocument && !result.realm.hasWindow && !result.realm.hasCookieStore),
      workerHoldsProviderCredentials: results.some(result =>
        result.realm.processEnvKeys.some(key => credentialPattern.test(key))),
      crossOriginResponseReadableWithoutCorsOptIn: results.some(result =>
        result.noCors.ok && result.noCors.type === 'basic'),
      sessionCookieForwardedToCrossOriginPorts: anyCookieForwarded,
      crossOriginAuthorizationHeaders: results.reduce(
        (total, result) => total + result.crossOriginAuthorizationHeaders, 0),
      cspStopsCrossOriginRequestsBeforeTheyLeave: cspResult.crossOriginRequests === 0,
      coepBlocksNoCorsLoadsWithoutCorp: coepResult.noCors.ok === false && coepResult.corp.ok === true,
      coepLeavesCorsReadsUnaffected: coepResult.cors.ok === true,
      toolDispatchSurvivesResponseHeaders: results.every(result =>
        result.toolTurn.toolText.includes('BROWSER_NATIVE_ISOLATION_TOOL_OK')),
    },
  }, null, 2))
} finally {
  await browser?.close().catch(() => {})
  await new Promise(resolveClose => crossOrigin === undefined ? resolveClose() : crossOrigin.close(resolveClose))
  await image?.cleanup().catch(() => {})
}
