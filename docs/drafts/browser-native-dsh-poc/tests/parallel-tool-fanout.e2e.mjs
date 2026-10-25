import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-parallel-tools-')))
let image
let app
let browser
let context
let page
const pageErrors = []
const requests = []

function toolResultFor(session, callId, turn) {
  return session.events.find(event => event.type === 'tool/result'
    && event.data.turn === turn && event.data.message?.toolCallId === callId)
}

async function test(action) {
  return await page.evaluate(async request => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(request), action)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    requests.push({ path: url.pathname, body, at: Date.now() })
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  assert.deepEqual(
    await test({ action: 'set-file-tool-delay', delayMs: 500 }).then(result => ({ ok: result?.ok, delayMs: result?.delayMs })),
    { ok: true, delayMs: 500 },
  )
  for (const path of ['parallel-slow.txt', 'parallel-fast.txt']) {
    const result = await test({ action: 'write', path: `/dsh/home/workspace/${path}`, content: `${path}\n` })
    assert.equal(result?.ok, true, JSON.stringify(result))
  }
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 30_000 })

  const normal = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_PARALLEL_TOOLS_E2E：并行读取两个文件，然后给出完成标记。',
    marker: 'BROWSER_NATIVE_PARALLEL_TOOLS_DONE',
    timeout: 45_000,
  })
  const normalCalls = normal.session.events.filter(event => event.type === 'tool/call' && event.data.turn === normal.turn)
  assert.deepEqual(normalCalls.map(call => call.data.callId), [
    'browser-native-parallel-slow-read',
    'browser-native-parallel-fast-read',
  ])
  const normalResults = normalCalls.map(call => toolResultFor(normal.session, call.data.callId, normal.turn))
  assert.equal(normalResults.every(result => result?.data.message?.isError !== true), true)
  assert.deepEqual(normalResults.map(result => result?.data.message?.toolCallId), normalCalls.map(call => call.data.callId))
  assert.equal(normal.session.events.filter(event => event.type === 'tool/call' && event.data.turn === normal.turn).length, 2)
  assert.equal(normal.session.events.filter(event => event.type === 'tool/result' && event.data.turn === normal.turn).length, 2)
  assert.ok(normal.elapsedMs < 1_100, `parallel read turn took ${normal.elapsedMs}ms; expected one 500ms slow read, not serial delay`)

  const partial = await sendTurn({
    page,
    origin,
    requests,
    sessionId: normal.sessionId,
    prompt: 'BROWSER_NATIVE_PARALLEL_TOOLS_PARTIAL_FAILURE_E2E：并行读取一个存在文件和一个不存在文件，然后继续完成。',
    marker: 'BROWSER_NATIVE_PARALLEL_TOOLS_PARTIAL_FAILURE_DONE',
    timeout: 45_000,
  })
  const partialCalls = partial.session.events.filter(event => event.type === 'tool/call' && event.data.turn === partial.turn)
  assert.deepEqual(partialCalls.map(call => call.data.callId), [
    'browser-native-parallel-slow-read',
    'browser-native-parallel-fast-read',
  ])
  const partialResults = partialCalls.map(call => toolResultFor(partial.session, call.data.callId, partial.turn))
  assert.equal(partialResults[0]?.data.message?.isError, false)
  assert.equal(partialResults[1]?.data.message?.isError, true, JSON.stringify(partialResults[1]))
  assert.equal(partial.session.events.filter(event => event.type === 'tool/call' && event.data.turn === partial.turn).length, 2)
  assert.equal(partial.session.events.filter(event => event.type === 'tool/result' && event.data.turn === partial.turn).length, 2)
  assert.match(assistantText(partial.session, partial.turn), /BROWSER_NATIVE_PARALLEL_TOOLS_PARTIAL_FAILURE_DONE/)
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'real-DSH-agent-loop-parallel-read-fanout-model-order-settlement-partial-failure',
    sessionId: normal.sessionId,
    normalTurn: normal.turn,
    partialFailureTurn: partial.turn,
    normalElapsedMs: normal.elapsedMs,
    normalCallIds: normalCalls.map(call => call.data.callId),
    normalResultIds: normalResults.map(result => result?.data.message?.toolCallId),
    partialResultErrors: partialResults.map(result => result?.data.message?.isError ?? null),
    llmRequestCount: requests.filter(request => request.path.endsWith('/llm')).length,
    pageErrors,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
