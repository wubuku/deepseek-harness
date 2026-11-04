import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, submitPrompt } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-failure-guidance-')))
const budgetMarker = 'FAILURE_GUIDANCE_BUDGET'
const principalCookie = 'dsh-browser-native-principal'
const sessionCookie = 'dsh-browser-native-session-principal'

const image = await createRuntimeValidationDist({ roster: 'browser' })
const app = await createBrowserNativeV2Server({
  dataDir,
  distRoot: image.distRoot,
  llmMode: 'scripted',
  testHooks: {
    scriptedLlmFault: body => {
      if (body.purpose !== undefined) return undefined
      const text = JSON.stringify(body.messages ?? [])
      if (!text.includes(budgetMarker)) return undefined
      return { kind: 'error', code: 'TOKEN_BUDGET_EXCEEDED', message: 'failure guidance probe: budget exhausted' }
    },
  },
})

const origin = await app.listen(0)
const browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`

async function call(cookie, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: `${principalCookie}=${cookie}; ${sessionCookie}=${cookie}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: JSON.parse(text) }
}

async function createIdentity() {
  const known = new Set(app.workspaces.identities.keys())
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const principal = [...app.workspaces.identities.keys()].find(key => !known.has(key))
  assert.equal(typeof principal, 'string')
  return principal
}

function trackRequests(page, sink) {
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch {}
    sink.push({ path: url.pathname, method: request.method(), body })
  })
}

try {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Singapore', viewport: { width: 1440, height: 1000 } })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  const requests = []
  const page = await context.newPage()
  trackRequests(page, requests)
  await openPreview(page, previewUrl)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

  // Scenario 1: the provider refuses the turn with the budget code; the panel must
  // explain it, route the user to an administrator, and keep a retry from being offered.
  const failed = await submitPrompt({
    page,
    origin,
    requests,
    prompt: `${budgetMarker}: explain why this turn cannot reach the model`,
    expectedReason: 'error',
    timeout: 120_000,
  })
  const terminal = failed.session.events.findLast(event => event.type === 'turn/end' && event.data.turn === failed.turn)
  assert.equal(terminal.data.reason.error.code, 'TOKEN_BUDGET_EXCEEDED')
  const panel = page.locator('[data-browser-native-turn-retry][data-state="failed"]')
  await panel.waitFor({ timeout: 30_000 })
  const guidance = panel.locator('[data-browser-native-failure-guidance]')
  assert.equal(await guidance.getAttribute('data-code'), 'TOKEN_BUDGET_EXCEEDED')
  assert.equal(await guidance.getAttribute('data-action'), 'contact-admin')
  const title = await guidance.locator('[data-browser-native-failure-guidance-title]').innerText()
  assert.equal(title, 'Token budget exhausted')
  const explanation = await guidance.locator('[data-browser-native-failure-guidance-explanation]').innerText()
  assert.match(explanation, /blocked before it reached the model/)
  assert.equal(await panel.locator('[data-browser-native-turn-retry-button]').isVisible(), false,
    'a budget rejection must not offer a blind retry')

  await guidance.locator('[data-browser-native-failure-action]').click()
  const result = guidance.locator('[data-browser-native-failure-guidance-result]')
  await result.waitFor({ state: 'visible', timeout: 10_000 })
  assert.match(await result.innerText(), /Admin request copied/)
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  assert.match(copied, /TOKEN_BUDGET_EXCEEDED/)
  assert.ok(copied.includes(failed.sessionId), 'the copied request must name the Session')

  const supportBundle = await Promise.all([
    page.waitForEvent('download'),
    guidance.locator('[data-browser-native-failure-diagnostics]').click(),
  ])
  assert.equal(supportBundle[0].suggestedFilename(), `dsh-support-bundle-${failed.sessionId}.json`)
  await page.waitForTimeout(1_500)
  const diagnosticsText = await result.innerText()
  assert.match(diagnosticsText, /Diagnostics bundle exported/, diagnosticsText)

  // Scenario 2: a second tab opens the same Session while the first holds its lease.
  const requestsB = []
  const pageB = await context.newPage()
  trackRequests(pageB, requestsB)
  await openPreview(pageB, previewUrl)
  const status = pageB.locator('[data-browser-native-workspace-status]')
  await pageB.waitForFunction(
    () => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'session-conflict',
    undefined,
    { timeout: 30_000 },
  )
  const conflictGuidance = status.locator('[data-browser-native-failure-guidance]')
  assert.equal(await conflictGuidance.getAttribute('data-code'), 'SESSION_ALREADY_OWNED')
  assert.equal(await conflictGuidance.getAttribute('data-action'), 'reload')
  assert.match(await conflictGuidance.innerText(), /This Session is open in another tab/)
  assert.equal(await status.locator('[data-browser-native-session-retry]').count(), 1)
  await pageB.close()

  // Scenario 3: the backend rejects a viewer's write against a shared Session.
  const owner = await createIdentity()
  const viewer = await createIdentity()
  assert.notEqual(owner, viewer)
  const sessionId = `sess-failure-guidance-${randomUUID()}`
  const created = await call(owner, '/api/browser-native/session/create', {
    protocolVersion: 1,
    requestId: randomUUID(),
    sessionId,
    header: { id: sessionId, version: 4, createdAt: Date.now(), cwd: '/dsh/home/workspace' },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const ownerRef = { ownerToken: created.body.owner.ownerToken, ownerEpoch: created.body.owner.ownerEpoch }
  const appended = await call(owner, '/api/browser-native/session/append', {
    protocolVersion: 1,
    requestId: randomUUID(),
    sessionId,
    ...ownerRef,
    expectedNextSeq: 0,
    events: [{ seq: 0, type: 'user', data: { text: 'shared transcript' } }],
  })
  assert.equal(appended.status, 200, JSON.stringify(appended.body))
  const shared = await call(owner, '/api/browser-native/session/share', {
    protocolVersion: 1,
    requestId: randomUUID(),
    sessionId,
    viewerPrincipalId: viewer,
  })
  assert.equal(shared.status, 200, JSON.stringify(shared.body))
  const readOpen = await call(viewer, '/api/browser-native/session/open', {
    protocolVersion: 1, requestId: randomUUID(), sessionId, access: 'read',
  })
  assert.equal(readOpen.status, 200, JSON.stringify(readOpen.body))
  const writeOpen = await call(viewer, '/api/browser-native/session/open', {
    protocolVersion: 1, requestId: randomUUID(), sessionId, access: 'write',
  })
  assert.equal(writeOpen.status, 403)
  assert.equal(writeOpen.body.error.code, 'SESSION_READ_ONLY')
  const writeAppend = await call(viewer, '/api/browser-native/session/append', {
    protocolVersion: 1,
    requestId: randomUUID(),
    sessionId,
    ...ownerRef,
    expectedNextSeq: 1,
    events: [{ seq: 1, type: 'user', data: { text: 'viewer write' } }],
  })
  assert.equal(writeAppend.status, 403)
  assert.equal(writeAppend.body.error.code, 'SESSION_READ_ONLY')

  process.stdout.write(`${JSON.stringify({
    budget: {
      code: 'TOKEN_BUDGET_EXCEEDED',
      title,
      action: 'contact-admin',
      retryOffered: false,
      copiedIncludesSession: true,
      diagnostics: supportBundle[0].suggestedFilename(),
    },
    leaseConflict: { code: 'SESSION_ALREADY_OWNED', action: 'reload', guidanceRendered: true },
    readOnlyShare: {
      openStatus: writeOpen.status,
      appendStatus: writeAppend.status,
      code: writeAppend.body.error.code,
    },
  })}\n`)

  await context.close()
} finally {
  await browser.close().catch(() => {})
  await app.close().catch(() => {})
  await image.cleanup().catch(() => {})
}
