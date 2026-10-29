import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-session-projection-')))
const pageErrors = []
const externalRequests = []
let image
let app
let browser
let context
const pages = []

async function request(page, operation, body) {
  return await page.evaluate(async ({ operation, body }) => {
    const response = await fetch(`/api/browser-native/session/${operation}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), ...body }),
    })
    return { status: response.status, body: await response.json() }
  }, { operation, body })
}

async function raceOpen(contenders, sessionId) {
  let arrivals = 0
  let release
  const barrier = new Promise(resolveBarrier => { release = resolveBarrier })
  const routeUrl = `${origin}/api/browser-native/session/open`
  const handlers = contenders.map(page => async route => {
    arrivals += 1
    if (arrivals === contenders.length) release()
    await barrier
    await route.continue()
  })
  await Promise.all(contenders.map((page, index) => page.route(routeUrl, handlers[index])))
  try {
    return await Promise.all(contenders.map(page => request(page, 'open', { sessionId, access: 'write' })))
  } finally {
    await Promise.all(contenders.map((page, index) => page.unroute(routeUrl, handlers[index])))
  }
}

let origin
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const workerPage = await context.newPage()
  pages.push(workerPage)
  workerPage.on('pageerror', error => pageErrors.push(error.message))
  workerPage.on('request', requestEvent => {
    if (new URL(requestEvent.url()).origin !== origin) externalRequests.push(requestEvent.url())
  })
  await openPreview(workerPage, `${origin}/preview.html?browser-native=1&browser-native-test=session-projection&preview-fixture=none`)
  await waitForPreview(workerPage)
  await workerPage.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })

  const projection = await workerPage.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'session-projection-probe' }))
  assert.equal(projection?.ok, true, JSON.stringify(projection))
  assert.equal(projection.sessionProjection?.ok, true, JSON.stringify(projection))
  assert.equal(projection.sessionProjection?.baseline, 'A baseline')
  assert.equal(projection.sessionProjection?.foreignIgnored, true)
  assert.equal(projection.sessionProjection?.activeUpdated, true)
  assert.equal(projection.sessionProjection?.duplicateIgnored, true)
  assert.equal(projection.sessionProjection?.switched, true)
  assert.equal(projection.sessionProjection?.lateForeignIgnored, true)
  assert.equal(projection.sessionProjection?.removedCleared, true)
  assert.equal(projection.sessionProjection?.detachedCleared, true)
  assert.equal(projection.sessionProjection?.detachedUpdateIgnored, true)
  assert.equal(projection.sessionProjection?.reattached, true)

  const sessionId = `projection-authority-${randomUUID()}`
  const created = await request(workerPage, 'create', {
    sessionId,
    header: { id: sessionId, version: 1, createdAt: Date.now(), cwd: '/dsh/home/workspace' },
    inheritedEventCount: 0,
  })
  assert.equal(created.status, 200, JSON.stringify(created))
  const owner = created.body.owner
  const appended = await request(workerPage, 'append', {
    sessionId,
    ownerToken: owner.ownerToken,
    ownerEpoch: owner.ownerEpoch,
    expectedNextSeq: 0,
    events: [{ seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'authority baseline' }] } } }],
  })
  assert.equal(appended.status, 200, JSON.stringify(appended))

  const observerPage = await context.newPage()
  pages.push(observerPage)
  observerPage.on('pageerror', error => pageErrors.push(error.message))
  observerPage.on('request', requestEvent => {
    if (new URL(requestEvent.url()).origin !== origin) externalRequests.push(requestEvent.url())
  })
  await observerPage.goto(`${origin}/api/browser-native/health`, { waitUntil: 'domcontentloaded' })
  const observed = await request(observerPage, 'read', { sessionId, offset: 0 })
  assert.equal(observed.status, 200, JSON.stringify(observed))
  assert.equal(observed.body.events[0].data.message.content[0].text, 'authority baseline')
  const observerAppend = await request(observerPage, 'append', {
    sessionId,
    expectedNextSeq: 1,
    events: [{ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'observer must not write' }] } } }],
  })
  assert.equal(observerAppend.status, 409, JSON.stringify(observerAppend))
  assert.equal(observerAppend.body.error.code, 'SESSION_OWNERSHIP_LOST')

  const close = await request(workerPage, 'close', { sessionId, ownerToken: owner.ownerToken, ownerEpoch: owner.ownerEpoch })
  assert.equal(close.status, 200, JSON.stringify(close))
  const contenders = [await context.newPage(), await context.newPage()]
  pages.push(...contenders)
  for (const page of contenders) {
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('request', requestEvent => {
      if (new URL(requestEvent.url()).origin !== origin) externalRequests.push(requestEvent.url())
    })
    await page.goto(`${origin}/api/browser-native/health`, { waitUntil: 'domcontentloaded' })
  }
  const claims = await raceOpen(contenders, sessionId)
  assert.equal(claims.filter(result => result.status === 200).length, 1, JSON.stringify(claims))
  assert.equal(claims.filter(result => result.status === 409 && result.body.error.code === 'SESSION_ALREADY_OWNED').length, 1)
  const winner = claims.find(result => result.status === 200).body.owner
  const winnerIndex = claims.findIndex(result => result.status === 200)
  const winnerClose = await request(contenders[winnerIndex], 'close', {
    sessionId,
    ownerToken: winner.ownerToken,
    ownerEpoch: winner.ownerEpoch,
  })
  assert.equal(winnerClose.status, 200, JSON.stringify(winnerClose))

  const finalRead = await request(observerPage, 'read', { sessionId, offset: 0 })
  assert.equal(finalRead.status, 200, JSON.stringify(finalRead))
  assert.equal(finalRead.body.nextSeq, 1)
  assert.equal(finalRead.body.events.some(event => JSON.stringify(event).includes('observer must not write')), false)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'session-projection-baseline-filter-reseed-detach-and-session-authority-owner-observer-separation',
    projection: projection.sessionProjection,
    observerReadNextSeq: observed.body.nextSeq,
    observerAppendStatus: observerAppend.status,
    claimStatuses: claims.map(result => result.status),
    claimConflict: claims.some(result => result.status === 409 && result.body.error.code === 'SESSION_ALREADY_OWNED'),
    finalSessionNextSeq: finalRead.body.nextSeq,
    pageErrors,
    externalRequests,
  })}\n`)
} finally {
  for (const page of pages) await page.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
