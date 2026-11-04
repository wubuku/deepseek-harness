/**
 * A foreign page must not change cookie-owned state or read API responses.
 *
 * The attacker page is served from a different loopback IP than the backend, so
 * Chromium classifies it as cross-site: a form POST, a `no-cors` `text/plain`
 * simple request, a CORS read, and an EventSource subscription all reach the
 * backend with real browser provenance headers. Every attempt must be refused
 * before a handler runs, leaving Workspace and Session state unchanged.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-csrf-'))
let app
let backendOrigin
let attacker
let attackerOrigin
let browser
let context
let page
const pageErrors = []

async function startAttackerPage(backend) {
  attacker = createServer((request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(`<!doctype html><html><body>
<form id="attack" method="post" action="${backend}/api/browser-native/workspace/create" target="sink">
  <input name="protocolVersion" value="1">
  <input name="requestId" value="csrf-form-attempt">
</form>
<iframe name="sink" hidden></iframe>
<script>
window.__probe = { noCors: {}, cors: {}, eventSource: {}, cookie: document.cookie }
async function simple(path, body) {
  try {
    const response = await fetch('${backend}' + path, {
      method: 'POST', mode: 'no-cors', credentials: 'include',
      headers: { 'content-type': 'text/plain' }, body,
    })
    let readable = false
    try { await response.text(); readable = true } catch {}
    return { type: response.type, status: response.status, readable }
  } catch (error) {
    return { error: String(error) }
  }
}
window.__runAttack = async () => {
  window.__probe.noCors.create = await simple('/api/browser-native/workspace/create',
    JSON.stringify({ protocolVersion: 1, requestId: 'csrf-nocors-workspace' }))
  window.__probe.noCors.session = await simple('/api/browser-native/session/create',
    JSON.stringify({ protocolVersion: 1, requestId: 'csrf-nocors-session', sessionId: 'csrf-probe-session' }))
  window.__probe.noCors.llm = await simple('/api/browser-native/llm',
    JSON.stringify({ protocolVersion: 1, requestId: 'csrf-nocors-llm', messages: [{ role: 'user', content: 'CSRF_LLM_PROBE' }] }))
  try {
    await fetch('${backend}/api/browser-native/usage-audit', { mode: 'cors', credentials: 'include' })
    window.__probe.cors = { readable: true }
  } catch (error) {
    window.__probe.cors = { error: String(error) }
  }
  window.__probe.eventSource = await new Promise(resolve => {
    const source = new EventSource('${backend}/api/browser-native/session/durable/stream?turnId=csrf-probe&fromSeq=0', { withCredentials: true })
    const settle = value => { source.close(); resolve(value) }
    source.onopen = () => settle({ open: true })
    source.onerror = () => settle({ error: true })
    setTimeout(() => settle({ timeout: true }), 5_000)
  })
  return window.__probe
}
</script>
</body></html>`)
  })
  await new Promise(resolve => attacker.listen(0, '127.0.0.1', resolve))
  // Different hostname from the backend origin (127.0.0.1) makes Chromium
  // classify the page as cross-site; the socket still binds loopback.
  return `http://localhost:${String(attacker.address().port)}`
}

async function nodeIdentity() {
  const response = await fetch(`${backendOrigin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
  return { cookie, workspaceId: (await response.json()).workspaceId }
}

async function workspaceCount(cookie) {
  const response = await fetch(`${backendOrigin}/api/browser-native/workspace/list`, { headers: { cookie } })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(Array.isArray(body.workspaces), true)
  return body.workspaces.length
}

async function sessionCount(cookie) {
  const response = await fetch(`${backendOrigin}/api/browser-native/session/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID() }),
  })
  const text = await response.text()
  assert.equal(response.status, 200, text)
  const body = JSON.parse(text)
  return body.items.filter(item => item !== null && typeof item === 'object' && item.blank !== true).length
}

try {
  app = await createBrowserNativeV2Server({ dataDir, llmMode: 'scripted' })
  backendOrigin = await app.listen(0)
  attackerOrigin = await startAttackerPage(backendOrigin)
  const identity = await nodeIdentity()
  const sessionsBefore = await sessionCount(identity.cookie)
  const workspacesBefore = await workspaceCount(identity.cookie)

  browser = await chromium.launch({
    headless: true,
    ...(process.env.DSH_POC_BROWSER === 'chromium' ? {} : { channel: 'chrome' }),
  })
  context = await browser.newContext({ locale: 'en-US' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto(`${attackerOrigin}/attack`, { waitUntil: 'domcontentloaded' })

  const formResponse = page.waitForResponse(response =>
    response.url() === `${backendOrigin}/api/browser-native/workspace/create`
    && response.request().method() === 'POST', { timeout: 15_000 })
  await page.locator('#attack').evaluate(form => form.requestSubmit())
  const submitted = await formResponse
  assert.equal(submitted.status(), 403, 'a cross-site form POST must be refused')

  const probe = await page.evaluate(async () => await window.__runAttack())
  assert.equal(probe.cookie, '', 'a foreign page must not see any backend cookie')
  for (const [name, attempt] of Object.entries(probe.noCors)) {
    // `Cross-Origin-Resource-Policy: same-origin` rejects the load at the network
    // layer, so the probe sees either a network error or an opaque response.
    const blockedAtNetwork = typeof attempt.error === 'string'
    assert.equal(blockedAtNetwork || (attempt.type === 'opaque' && attempt.status === 0 && attempt.readable === false),
      true, `${name}: a no-cors request must not be readable: ${JSON.stringify(attempt)}`)
  }
  assert.equal(typeof probe.cors.error, 'string', 'a CORS read must fail')
  assert.equal(probe.eventSource.error, true, 'a cross-site EventSource must fail')

  assert.equal(await workspaceCount(identity.cookie), workspacesBefore, 'attacks must not create a Workspace')
  assert.equal(await sessionCount(identity.cookie), sessionsBefore, 'attacks must not create a Session')
  const stillOwned = await fetch(`${backendOrigin}/api/browser-native/workspace/identity`, {
    headers: { cookie: identity.cookie, 'x-browser-native-identity-mode': 'existing' },
  })
  assert.equal(stillOwned.status, 200)
  assert.equal((await stillOwned.json()).workspaceId, identity.workspaceId, 'the owner Workspace must be unchanged')

  const repeated = await fetch(`${backendOrigin}/api/browser-native/workspace/create`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain', cookie: identity.cookie,
      origin: attackerOrigin, 'sec-fetch-site': 'cross-site',
    },
    body: JSON.stringify({ protocolVersion: 1, requestId: 'csrf-node-repeat' }),
  })
  assert.equal(repeated.status, 403)
  assert.equal((await repeated.json()).error.code, 'ORIGIN_FORBIDDEN')

  assert.deepEqual(pageErrors, [])
  const summary = {
    result: 'passed',
    scope: 'cross-site-form-no-cors-simple-request-cors-read-sse',
    attackerOrigin,
    backendOrigin,
    formPostStatus: submitted.status(),
    noCorsAttempts: Object.fromEntries(Object.entries(probe.noCors)
      .map(([name, attempt]) => [name, typeof attempt.error === 'string'
        ? { outcome: 'blocked-at-network' }
        : { outcome: 'opaque', type: attempt.type, status: attempt.status, readable: attempt.readable }])),
    corsRead: 'blocked',
    eventSource: 'blocked',
    workspacesBefore,
    workspacesAfter: workspacesBefore,
    sessionsBefore,
    sessionsAfter: sessionsBefore,
    ownerWorkspaceUnchanged: identity.workspaceId,
  }
  if (process.env.DSH_POC_RESULT_FILE !== undefined) {
    await writeFile(process.env.DSH_POC_RESULT_FILE, `${JSON.stringify(summary, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    attackerOrigin,
    pageErrors,
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  if (attacker !== undefined) await new Promise(resolve => attacker.close(resolve))
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
