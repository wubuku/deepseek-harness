import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const ownsDataDir = process.env.DSH_POC_DATA_DIR === undefined
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-runtime-probes-')))
const probeMode = 'browser-native-test=runtime-capability-probes'
const requests = []
const pageErrors = []
const externalRequests = []
const localNoProxy = new Set((process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').filter(Boolean))
localNoProxy.add('127.0.0.1')
localNoProxy.add('localhost')
process.env.NO_PROXY = [...localNoProxy].join(',')
process.env.no_proxy = process.env.NO_PROXY
let image
let app
let browser
let page
let origin

function trackPage(target) {
  target.on('pageerror', error => pageErrors.push(error.message))
  target.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(url.href)
    if (url.pathname.startsWith('/api/browser-native/')) {
      let body
      try { body = request.postDataJSON() } catch {}
      requests.push({ path: url.pathname, method: request.method(), url: url.href, body })
    }
  })
}

function previewUrl(options = {}) {
  const query = new URLSearchParams({ 'browser-native': '1', 'preview-fixture': 'none' })
  if (options.durable === true) query.set('browser-native-durable', '1')
  if (options.test === true) query.set('browser-native-test', 'runtime-capability-probes')
  if (options.fault !== undefined) query.set('browser-native-probe-fault', options.fault)
  return `${origin}/preview.html?${query.toString()}`
}

async function expectStartupBlocked(options) {
  const start = pageErrors.length
  await page.goto(previewUrl({ test: true, ...options }), { waitUntil: 'domcontentloaded' })
  const failure = await waitFor(async () => pageErrors.slice(start).find(message => message.includes('browser-native startup blocked')),
    `${options.label} startup failure`, 15_000)
  assert.ok(failure.includes(options.code), `expected ${options.code}, received ${failure}`)
  if (options.responseSentinel !== undefined) {
    assert.equal(failure.includes(options.responseSentinel), false, 'backend response body must not enter the startup diagnostic')
  }
  assert.equal(requests.some(request => request.path.startsWith('/api/browser-native/session/')), false,
    `${options.label}: Session API was contacted before Host startup`)
  assert.equal(requests.some(request => request.path === '/api/browser-native/llm'), false,
    `${options.label}: model request was sent before Host startup`)
}

try {
  image = await createRuntimeValidationDist()
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  trackPage(page)

  let failHealth = true
  await page.route(`${origin}/api/browser-native/health`, async route => {
    if (!failHealth) return await route.continue()
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ protocolVersion: 1, ok: false, error: 'probe route unavailable', secret: 'PROBE_SECRET_MUST_NOT_LEAK' }),
    })
  })
  await expectStartupBlocked({
    code: 'BACKEND_UNAVAILABLE',
    label: 'backend 503',
    responseSentinel: 'PROBE_SECRET_MUST_NOT_LEAK',
  })
  failHealth = false

  await page.unroute(`${origin}/api/browser-native/health`)
  await page.route(`${origin}/api/browser-native/config`, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ protocolVersion: 99, llmMode: 'scripted', provider: 'scripted', model: 'browser-native-scripted' }),
    })
  })
  await expectStartupBlocked({ code: 'BACKEND_PROTOCOL_MISMATCH', label: 'backend protocol mismatch' })
  await page.unroute(`${origin}/api/browser-native/config`)

  await expectStartupBlocked({ code: 'SESSION_OUTBOX_UNAVAILABLE', fault: 'outbox-abort', label: 'IndexedDB transaction abort' })
  await expectStartupBlocked({
    code: 'OPFS_SYNC_ACCESS_UNAVAILABLE',
    durable: true,
    fault: 'opfs-unavailable',
    label: 'durable Workspace OPFS failure',
  })

  await page.goto(previewUrl({ test: true, fault: 'opfs-unavailable' }), { waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  assert.equal(requests.some(request => request.path === '/api/browser-native/llm'), false,
    'the optional OPFS check must not send a model request during startup')
  assert.deepEqual(externalRequests, [], 'runtime probes must stay same-origin')

  await page.goto(previewUrl({ durable: true }), { waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const prompt = 'RUNTIME_CAPABILITY_PROBE_RECOVERY: confirm the agent started.'
  const successPageErrorOffset = pageErrors.length
  const turn = await sendTurn({ page, origin, requests, prompt, marker: 'RUNTIME_CAPABILITY_PROBE_RECOVERY', timeout: 90_000 })
  assert.equal(requests.filter(request => request.path === '/api/browser-native/llm' && request.body?.purpose === undefined).length, 1,
    'one user turn must produce one model request')
  assert.deepEqual(externalRequests, [], 'the Browser-Native preview must not send requests off-origin')
  assert.deepEqual(pageErrors.slice(successPageErrorOffset), [], `recovered page errors: ${JSON.stringify(pageErrors.slice(successPageErrorOffset))}`)
  assert.equal(turn.session.events.some(event => event.type === 'turn/end'), true)

  console.log(JSON.stringify({
    browser: await browser.version(),
    blockedCases: ['backend-503', 'backend-protocol-mismatch', 'indexeddb-abort', 'durable-opfs-unavailable'],
    optionalOpfsSkipped: true,
    recovery: { durableWorkspace: true, modelRequests: 1, response: 'RUNTIME_CAPABILITY_PROBE_RECOVERY' },
    externalRequests: externalRequests.length,
  }, null, 2))
} finally {
  if (page !== undefined) await page.close().catch(() => {})
  if (browser !== undefined) await browser.close().catch(() => {})
  if (app !== undefined) await app.close().catch(() => {})
  if (image !== undefined) await image.cleanup().catch(() => {})
  if (ownsDataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {})
}
