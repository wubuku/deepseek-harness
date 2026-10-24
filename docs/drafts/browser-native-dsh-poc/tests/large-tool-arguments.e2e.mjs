import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest, submitPrompt, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-large-tool-args-')))
const requests = []
const appendResponses = []
const pageErrors = []
const apiResponses = []
const modelPromptMarkers = []
let image
let app
let browser
let page
let observedSessionId
let origin

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (!request.url().includes('/api/browser-native/')) return
    const pathname = new URL(request.url()).pathname
    let body
    if (pathname.endsWith('/session/create')) {
      try { body = request.postDataJSON() } catch {}
      observedSessionId = body?.sessionId
    }
    if (pathname === '/api/browser-native/llm') {
      try {
        const body = request.postDataJSON()
        modelPromptMarkers.push((body.messages ?? [])
          .filter(message => message.role === 'user' && typeof message.content === 'string')
          .map(message => message.content.match(/BROWSER_NATIVE_[A-Z0-9_]+/)?.[0] ?? message.content.slice(0, 48)))
      } catch {}
    }
    requests.push({
      path: pathname,
      pathname,
      method: request.method(),
      bytes: request.postDataBuffer()?.byteLength ?? 0,
      ...(body === undefined ? {} : { body }),
    })
  })
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname
    const request = response.request()
    const bytes = request.postDataBuffer()?.byteLength ?? 0
    apiResponses.push({ pathname, status: response.status(), bytes })
    if (pathname === '/api/browser-native/session/append') appendResponses.push({ status: response.status(), bytes })
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const accepted = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_TOOL_ARGS_768K_E2E: persist and execute this bounded file write.',
    marker: 'BROWSER_NATIVE_TOOL_ARGS_DONE',
    timeout: 90_000,
  })
  const acceptedCall = accepted.session.events.find(event => event.type === 'tool/call'
    && event.data.name === 'write' && event.data.arguments.includes('786432-byte-tool-argument'))
  assert.ok(acceptedCall, 'the 768 KiB tool call must be persisted')
  assert.equal(accepted.session.events.some(event => event.type === 'tool/result'
    && event.data.message?.toolCallId === acceptedCall.data.callId), true)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 60_000 })

  const sessionId = accepted.sessionId
  const rejectedTurns = []
  for (const mebibytes of [6, 9]) {
    const rejectedPrompt = `BROWSER_NATIVE_TOOL_ARGS_${String(mebibytes)}M_E2E: this call must fail before dispatch.`
    const result = await submitPrompt({
      page,
      origin,
      requests,
      prompt: rejectedPrompt,
      sessionId,
      timeout: 90_000,
      expectedReason: null,
    })
    assert.equal(result.sessionId, sessionId)
    const promptIndex = result.session.events.findLastIndex(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes(rejectedPrompt))
    const terminal = result.session.events.find((event, index) => index > promptIndex && event.type === 'turn/end')
    assert.ok(terminal, `${mebibytes} MiB rejected turn must settle`)
    assert.equal(result.session.events.some(event => event.type === 'tool/call'
      && event.data.arguments.includes(`${String(mebibytes * 1024 * 1024)}-byte-tool-argument`)), false,
    `${mebibytes} MiB call must not be logged or dispatched`)
    assert.equal(result.session.events.some(event => event.type === 'tool/result'
      && JSON.stringify(event.data).includes(`${String(mebibytes * 1024 * 1024)}-byte-tool-argument`)), false)
    rejectedTurns.push({ mebibytes, turn: terminal.data.turn, reason: terminal.data.reason })
  }
  const followUp = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_AFTER_OVERSIZE_TOOL_CALL_CONTINUE: continue in this same Session.',
    marker: 'BROWSER_NATIVE_AFTER_OVERSIZE_TOOL_CALL_CONTINUE_OK',
    sessionId,
    timeout: 60_000,
  })
  assert.equal(followUp.sessionId, sessionId)
  assert.equal(assistantText(followUp.session, followUp.turn).includes('BROWSER_NATIVE_AFTER_OVERSIZE_TOOL_CALL_CONTINUE_OK'), true)
  const identity = await page.evaluate(async () => await (await fetch('/api/browser-native/workspace/identity')).json())
  const manifest = await page.evaluate(async workspaceId => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
  )).json(), identity.workspaceId)
  const entries = new Map(manifest.entries.map(entry => [entry.path, entry]))
  assert.equal(entries.get('786432-byte-tool-argument.txt')?.bytes, 768 * 1024,
    'the accepted DSH tool call must create the expected Workspace entry')
  assert.equal(entries.has('6291456-byte-tool-argument.txt'), false)
  assert.equal(entries.has('9437184-byte-tool-argument.txt'), false)
  assert.ok(appendResponses.every(response => response.status === 200), 'Session appends must not hit the retrying 413 path')
  assert.ok(appendResponses.every(response => response.bytes < 8 * 1024 * 1024), 'accepted append bodies must remain under the backend limit')
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors))
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'scripted-DSH-worker-tool-call-persistence-limit',
    sessionId,
    maximumAcceptedFileContentBytes: 768 * 1024,
    adapterToolArgumentLimitBytes: 1024 * 1024,
    rejectedToolArgumentBytes: [6, 9].map(value => value * 1024 * 1024),
    rejectedTurns,
    oversizedToolCallsPersisted: false,
    oversizedToolSideEffects: false,
    followUpTurnId: followUp.turn,
    sessionAppendRequestCount: appendResponses.length,
    maximumSessionAppendBodyBytes: Math.max(0, ...appendResponses.map(response => response.bytes)),
    pageErrors,
    workspaceRevision: 1,
  })}\n`)
} catch (error) {
  let session
  if (observedSessionId !== undefined && origin !== undefined) {
    try { session = await sessionRequest(origin, 'read', { sessionId: observedSessionId, offset: 0 }) } catch {}
  }
  process.stderr.write(`${JSON.stringify({
    diagnostic: 'large-tool-argument-e2e-failed',
    error: String(error),
    sessionId: observedSessionId,
    sessionStatus: session?.status,
    eventTypes: session?.events?.map(event => event.type),
    toolCalls: session?.events?.filter(event => event.type === 'tool/call').map(event => ({
      name: event.data.name,
      argumentBytes: Buffer.byteLength(event.data.arguments ?? ''),
    })),
    apiResponses,
    modelPromptMarkers,
    pageErrors,
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
