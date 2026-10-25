import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-session-observers-')))
let image
let app
let browser
let context
let writer
let observer

async function request(page, operation, body = {}) {
  return await page.evaluate(async input => {
    const response = await fetch(`/api/browser-native/session/${input.operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), ...input.body }),
    })
    return { status: response.status, body: await response.json() }
  }, { operation, body })
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  writer = await context.newPage()
  observer = await context.newPage()
  await Promise.all([writer.goto(`${origin}/api/browser-native/health`), observer.goto(`${origin}/api/browser-native/health`)]).then(() => undefined)

  const sessionId = 'chrome-observer-session'
  const header = { id: sessionId, version: 1, createdAt: 1_700_000_000_000, cwd: '/workspace' }
  const created = await request(writer, 'create', { sessionId, header, inheritedEventCount: 0 })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const owner = created.body.owner

  const firstAppend = await request(writer, 'append', {
    sessionId,
    ownerToken: owner.ownerToken,
    ownerEpoch: owner.ownerEpoch,
    expectedNextSeq: 0,
    events: [{ seq: 0, type: 'user/message', payload: { content: 'observer first event' } }],
  })
  assert.equal(firstAppend.status, 200, JSON.stringify(firstAppend.body))

  const firstRead = await request(observer, 'read', { sessionId, offset: 0, length: 1 })
  assert.equal(firstRead.status, 200, JSON.stringify(firstRead.body))
  assert.equal(firstRead.body.ownerEpoch, 1)
  assert.equal(firstRead.body.durableThroughSeq, -1)
  assert.equal(firstRead.body.hasMore, false)
  assert.equal(firstRead.body.events[0].payload.content, 'observer first event')

  const secondAppend = await request(writer, 'append', {
    sessionId,
    ownerToken: owner.ownerToken,
    ownerEpoch: owner.ownerEpoch,
    expectedNextSeq: 1,
    events: [{ seq: 1, type: 'assistant/message', payload: { content: 'observer second event' } }],
  })
  assert.equal(secondAppend.status, 200, JSON.stringify(secondAppend.body))
  const observerPage = await request(observer, 'read', { sessionId, offset: 0, length: 1 })
  assert.equal(observerPage.body.hasMore, true)
  assert.equal(observerPage.body.nextSeq, 2)
  const observerTail = await request(observer, 'read', { sessionId, offset: 1, length: 1 })
  assert.equal(observerTail.body.events[0].seq, 1)

  const observerWrite = await request(observer, 'append', {
    sessionId,
    expectedNextSeq: 2,
    events: [{ seq: 2, type: 'assistant/message', payload: { content: 'observer must not write' } }],
  })
  assert.equal(observerWrite.status, 409)
  assert.equal(observerWrite.body.error.code, 'SESSION_OWNERSHIP_LOST')

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'two-browser-pages-single-session-observer-and-single-writer',
    sessionId,
    ownerEpoch: firstRead.body.ownerEpoch,
    observerSawNextSeq: observerPage.body.nextSeq,
    observerWriteStatus: observerWrite.status,
  })}\n`)
} finally {
  await writer?.close().catch(() => {})
  await observer?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
