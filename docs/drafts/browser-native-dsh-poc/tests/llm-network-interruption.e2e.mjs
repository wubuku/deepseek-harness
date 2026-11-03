import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest, submitPrompt, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const envFile = resolve(process.env.DSH_POC_ENV_FILE
  ?? join(import.meta.dirname, '..', '..', '.env'))
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-llm-network-')))
const browserChannel = process.env.DSH_POC_BROWSER ?? 'chrome'

const CUT_PROMPT = 'LLM_UPSTREAM_CUT_E2E: Reply with exactly "CUT-PROBE-OK" and nothing else.'
const CUT_CONTINUE_PROMPT = 'LLM_CUT_CONTINUE_E2E: Reply with exactly "CUT-CONTINUE-OK" and nothing else.'
const OFFLINE_PROMPT = 'LLM_OFFLINE_STREAM_E2E: Reply with exactly "OFFLINE-PROBE-OK" and nothing else.'
const OFFLINE_CONTINUE_PROMPT = 'LLM_OFFLINE_CONTINUE_E2E: Reply with exactly "OFFLINE-CONTINUE-OK" and nothing else.'

function messageText(message) {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

function messagesText(body) {
  return (body.messages ?? []).map(messageText).join('\n')
}

function isTurnRequest(body) {
  return Array.isArray(body.tools) && body.tools.length > 0
}

/**
 * The current turn's prompt is the last user message that carries a harness
 * marker; runtime-context messages are appended after the visible prompt.
 * @param body - Model request JSON.
 * @returns Current prompt text, or empty when none carries a marker.
 */
function currentTurnText(body) {
  const userMessages = (body.messages ?? []).filter(message => message.role === 'user')
  for (let index = userMessages.length - 1; index >= 0; index -= 1) {
    const text = messageText(userMessages[index])
    if (text.includes('LLM_')) return text
  }
  return ''
}

/**
 * Local OpenAI-compatible SSE upstream. It streams the same chunk protocol and
 * lets the harness sever a response mid-token, which the real provider key could
 * not be used for in this environment.
 * @returns Stub origin, live counters, and close.
 */
async function startStreamUpstream() {
  const state = {
    requests: [],
    cutCount: 0,
    cutContentChars: 0,
    offlineContentChars: 0,
    clientAborts: 0,
  }
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    let parsed = {}
    try { parsed = JSON.parse(body) } catch {}
    const current = currentTurnText(parsed)
    const cut = isTurnRequest(parsed) && current.includes('LLM_UPSTREAM_CUT_E2E')
    const slow = isTurnRequest(parsed) && current.includes('LLM_OFFLINE_STREAM_E2E')
    state.requests.push({ turnRequest: isTurnRequest(parsed), cut, slow, tools: (parsed.tools ?? []).length })
    const text = current.includes('CUT-CONTINUE-OK') ? 'CUT-CONTINUE-OK'
      : current.includes('OFFLINE-CONTINUE-OK') ? 'OFFLINE-CONTINUE-OK'
        : cut ? 'CUT-PROBE-OK' : slow ? 'OFFLINE-PROBE-OK' : 'STUB-OK'
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    response.on('close', () => {
      if (!response.writableEnded) state.clientAborts += 1
    })
    const write = payload => response.write(`data: ${JSON.stringify(payload)}\n\n`)
    write({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
    for (const character of text) {
      if (response.writableEnded || response.destroyed) return
      write({ choices: [{ index: 0, delta: { content: character }, finish_reason: null }] })
      if (cut) state.cutContentChars += 1
      if (slow) state.offlineContentChars += 1
      if (cut && state.cutContentChars >= 4) {
        state.cutCount += 1
        response.destroy()
        return
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, slow ? 120 : 25))
    }
    write({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    response.end()
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const { port } = server.address()
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    state,
    close: async () => await new Promise(resolveClose => server.close(resolveClose)),
  }
}

/**
 * Transparent TCP relay between the browser and the backend that can drop every
 * open connection on demand, reproducing a real mid-response network loss.
 * @param options - Backend origin to forward to.
 * @returns Relay origin, connection counters, sever, and close.
 */
async function startTcpRelay({ backendOrigin }) {
  const backend = new URL(backendOrigin)
  const sockets = new Set()
  const state = { accepted: 0, severed: 0, severedAt: undefined }
  const server = net.createServer(client => {
    state.accepted += 1
    const upstream = net.connect(Number(backend.port), backend.hostname)
    const pair = { client, upstream }
    sockets.add(pair)
    const drop = () => {
      sockets.delete(pair)
      client.destroy()
      upstream.destroy()
    }
    client.on('error', drop)
    upstream.on('error', drop)
    client.on('close', drop)
    upstream.on('close', drop)
    client.pipe(upstream)
    upstream.pipe(client)
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const { port } = server.address()
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    state,
    sever: async () => {
      state.severed = sockets.size
      state.severedAt = Date.now()
      for (const pair of [...sockets]) {
        sockets.delete(pair)
        pair.client.destroy()
        pair.upstream.destroy()
      }
    },
    close: async () => await new Promise(resolveClose => {
      for (const pair of sockets) {
        pair.client.destroy()
        pair.upstream.destroy()
      }
      server.close(resolveClose)
    }),
  }
}

function capturePage(page, origin, requests, pageErrors, nonLocalRequests) {
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch {}
    requests.push({ path: url.pathname, body })
  })
  page.on('pageerror', error => pageErrors.push(error.message))
}

function eventsForTurn(session, turn) {
  return session.events.filter(event => event.data?.turn === turn)
}

function attemptText(attempt) {
  return (attempt.data.stream ?? [])
    .filter(record => record.type === 'text-chunks')
    .flatMap(record => record.texts)
    .join('')
}

function attemptFinish(attempt) {
  return (attempt.data.stream ?? []).find(record => record.type === 'chunk' && record.chunk.type === 'finish')
}

function requestCount(requests, prompt) {
  return requests.filter(request => request.path.endsWith('/llm')
    && isTurnRequest(request.body ?? {}) && currentTurnText(request.body ?? {}).trim() === prompt.trim()).length
}

function retryEventCount(session) {
  return session.events.filter(event => event.type === 'llm/retry' || event.type === 'llm/retry-started').length
}

async function readSession(sessionId) {
  return await sessionRequest(origin, 'read', { sessionId, offset: 0 })
}

async function readVisibleState(page) {
  return await page.evaluate(() => {
    const controls = [...document.querySelectorAll('button')].map(button => ({
      label: (button.getAttribute('aria-label') ?? button.textContent ?? '').trim(),
      disabled: button.disabled,
    }))
    return {
      sendEnabled: controls.some(control => /^(Send message|发送消息)$/.test(control.label) && !control.disabled),
      stopVisible: controls.some(control => /^(Stop generating|停止生成)$/.test(control.label)),
      composerEditable: document.querySelector('[data-composer-input][contenteditable="true"]')?.isContentEditable === true,
      bodyText: document.body.innerText.slice(-4_000),
    }
  })
}

function eventContent(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

function userMessageCount(session, prompt) {
  return session.events.filter(event => event.type === 'user/message' && eventContent(event).trim() === prompt.trim()).length
}

function turnTerminalAfter(session, prompt) {
  const userIndex = session.events.findLastIndex(event => event.type === 'user/message' && eventContent(event).trim() === prompt.trim())
  if (userIndex < 0) return undefined
  return session.events.findLast((event, index) => index > userIndex && event.type === 'turn/end')
}

let image
let app
let browser
let context
let page
let origin
let relay
let upstream
const requests = []
const pageErrors = []
const nonLocalRequests = []

try {
  upstream = await startStreamUpstream()
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'real',
    envFile,
    llmBaseUrl: upstream.origin,
    llmCompletionsPath: '/v1/chat/completions',
  })
  origin = await app.listen(0)
  relay = await startTcpRelay({ backendOrigin: origin })
  origin = relay.origin
  browser = await chromium.launch({ headless: true, channel: browserChannel })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  capturePage(page, origin, requests, pageErrors, nonLocalRequests)
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

  const severed = await submitPrompt({
    page, origin, requests, prompt: CUT_PROMPT, expectedReason: 'error', timeout: 120_000,
  })
  const severedTurn = eventsForTurn(severed.session, severed.turn)
  const severedAttempts = severedTurn.filter(event => event.type === 'assistant/attempt')
  assert.equal(userMessageCount(severed.session, CUT_PROMPT), 1)
  assert.equal(severedAttempts.length, 1)
  assert.equal(severedTurn.some(event => event.type === 'assistant/message'), false)
  assert.equal(severedTurn.filter(event => event.type === 'turn/end').length, 1)
  assert.equal(attemptFinish(severedAttempts[0])?.chunk.reason.kind, 'error')
  assert.ok(attemptText(severedAttempts[0]).length > 0, 'a severed stream must retain its text prefix')
  assert.equal(upstream.state.cutCount, 1)
  assert.equal(requestCount(requests, CUT_PROMPT), 1, 'a severed stream must not be retried')
  assert.equal(retryEventCount(severed.session), 0)
  const severedVisible = await readVisibleState(page)
  assert.equal(severedVisible.composerEditable, true)
  assert.equal(severedVisible.stopVisible, false)
  assert.match(severedVisible.bodyText, /Failed|failed|失败/, 'the failed turn must stay visible in the UI')

  const cutContinue = await sendTurn({
    page, origin, requests, sessionId: severed.sessionId, prompt: CUT_CONTINUE_PROMPT,
    marker: 'CUT-CONTINUE-OK', timeout: 120_000,
  })
  assert.equal(requestCount(requests, CUT_CONTINUE_PROMPT), 1)

  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(OFFLINE_PROMPT)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const sessionId = severed.sessionId
  await waitFor(async () => userMessageCount(await readSession(sessionId), OFFLINE_PROMPT) === 1,
    'offline probe user message', 30_000)
  await waitFor(() => upstream.state.offlineContentChars >= 8, 'offline probe stream prefix', 90_000)
  await relay.sever()
  await new Promise(resolveDelay => setTimeout(resolveDelay, 2_500))

  let recovery = 'reconnect'
  let offlineTerminal = await waitFor(async () => {
    const terminal = turnTerminalAfter(await readSession(sessionId), OFFLINE_PROMPT)
    return terminal === undefined ? undefined : terminal
  }, 'offline turn terminal before reload', 20_000).catch(() => undefined)
  if (offlineTerminal === undefined) {
    recovery = 'reload'
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForPreview(page)
    offlineTerminal = await waitFor(async () => {
      const terminal = turnTerminalAfter(await readSession(sessionId), OFFLINE_PROMPT)
      return terminal === undefined ? undefined : terminal
    }, 'offline turn terminal after reload', 60_000)
  }
  const offlineSession = await readSession(sessionId)
  const offlineEvents = eventsForTurn(offlineSession, offlineTerminal.data.turn)
  assert.notEqual(offlineTerminal.data.reason.kind, 'completed')
  assert.equal(userMessageCount(offlineSession, OFFLINE_PROMPT), 1)
  assert.equal(offlineEvents.some(event => event.type === 'assistant/message'), false)
  assert.ok(offlineEvents.filter(event => event.type === 'assistant/attempt').length >= 1)
  assert.equal(requestCount(requests, OFFLINE_PROMPT), 1, 'reconnect must not replay the interrupted model request')
  assert.equal(retryEventCount(offlineSession), 0)
  assert.equal(upstream.state.clientAborts >= 1, true, 'the backend must abort the upstream request when its client disappears')

  const offlineVisible = await readVisibleState(page)
  assert.equal(offlineVisible.stopVisible, false)
  assert.match(offlineVisible.bodyText, /Failed|failed|Interrupted|interrupted|失败|已中止/,
    'the interrupted turn must stay visible after reconnect')

  const offlineContinue = await sendTurn({
    page, origin, requests, sessionId, prompt: OFFLINE_CONTINUE_PROMPT,
    marker: 'OFFLINE-CONTINUE-OK', timeout: 120_000,
  })
  assert.equal(requestCount(requests, OFFLINE_CONTINUE_PROMPT), 1)
  assert.equal([CUT_PROMPT, CUT_CONTINUE_PROMPT, OFFLINE_PROMPT, OFFLINE_CONTINUE_PROMPT]
    .reduce((total, prompt) => total + requestCount(requests, prompt), 0), 4,
  'four user turns must produce exactly four model requests')

  const beforeReload = await readSession(sessionId)
  const beforeDigest = beforeReload.events.map(event => `${String(event.seq)}:${event.type}`)
  const userMessageCounts = new Map()
  for (const event of beforeReload.events) {
    if (event.type !== 'user/message') continue
    const content = eventContent(event).trim()
    if (content === '') continue
    userMessageCounts.set(content, (userMessageCounts.get(content) ?? 0) + 1)
  }
  for (const prompt of [CUT_PROMPT, CUT_CONTINUE_PROMPT, OFFLINE_PROMPT, OFFLINE_CONTINUE_PROMPT]) {
    assert.equal(userMessageCounts.get(prompt), 1, `prompt must be recorded exactly once: ${prompt.slice(0, 30)}`)
  }
  assert.equal(beforeReload.events.filter(event => event.type === 'turn/end').length, 4)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await waitFor(async () => {
    const current = await readSession(sessionId)
    return current.events.length >= beforeDigest.length ? current : undefined
  }, 'Session visibility after final reload', 60_000)
  const afterReload = await readSession(sessionId)
  assert.deepEqual(afterReload.events.slice(0, beforeDigest.length).map(event => `${String(event.seq)}:${event.type}`), beforeDigest,
    'reload must preserve the durable event prefix')
  assert.equal(afterReload.events.filter(event => event.type === 'llm/retry').length, 0)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browserChannel,
    scope: 'stream-severance-and-chrome-network-loss',
    upstream: 'local OpenAI-compatible SSE stub (configured provider returned HTTP 403 quota exhaustion)',
    sessionId,
    severedStream: {
      turn: severed.turn,
      reason: severedTurn.find(event => event.type === 'turn/end')?.data.reason,
      attemptText: attemptText(severedAttempts[0]),
      upstreamRequests: requestCount(requests, CUT_PROMPT),
      retryEvents: retryEventCount(severed.session),
      stubCutAfterCharacters: upstream.state.cutContentChars,
    },
    severedContinuation: {
      turn: cutContinue.turn,
      assistantText: assistantText(cutContinue.session, cutContinue.turn),
    },
    clientOffline: {
      turn: offlineTerminal.data.turn,
      reason: offlineTerminal.data.reason,
      recovery,
      upstreamRequests: requestCount(requests, OFFLINE_PROMPT),
      retryEvents: retryEventCount(offlineSession),
      upstreamClientAborts: upstream.state.clientAborts,
      streamPrefixCharactersBeforeOffline: upstream.state.offlineContentChars,
      severedBrowserConnections: relay.state.severed,
    },
    offlineContinuation: {
      turn: offlineContinue.turn,
      assistantText: assistantText(offlineContinue.session, offlineContinue.turn),
    },
    durableEventCount: beforeDigest.length,
    stubRequests: upstream.state.requests.length,
    pageErrors,
    nonLocalRequests,
  })}\n`)
} catch (error) {
  const sessionId = requests.find(request => request.path.endsWith('/session/create'))?.body?.sessionId
  const latest = sessionId && origin ? await readSession(sessionId).catch(() => undefined) : undefined
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    sessionId,
    events: latest?.events?.map(event => ({
      seq: event.seq,
      type: event.type,
      turn: event.data?.turn,
      reason: event.data?.turnEndReason ?? event.data?.reason,
    })),
    llmRequests: requests.filter(request => request.path.endsWith('/llm')).map(request => ({
      turnRequest: isTurnRequest(request.body ?? {}),
      markers: ['LLM_UPSTREAM_CUT_E2E', 'LLM_CUT_CONTINUE_E2E', 'LLM_OFFLINE_STREAM_E2E', 'LLM_OFFLINE_CONTINUE_E2E']
        .filter(marker => messagesText(request.body ?? {}).includes(marker)),
    })),
    stub: upstream === undefined ? undefined : {
      requests: upstream.state.requests,
      cutCount: upstream.state.cutCount,
      cutContentChars: upstream.state.cutContentChars,
      offlineContentChars: upstream.state.offlineContentChars,
      clientAborts: upstream.state.clientAborts,
    },
    pageErrors,
    nonLocalRequests,
    relay: relay === undefined ? undefined : { accepted: relay.state.accepted, severed: relay.state.severed },
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await relay?.close().catch(() => {})
  await upstream?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
