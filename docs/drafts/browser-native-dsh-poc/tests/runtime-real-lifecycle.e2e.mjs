import assert from 'node:assert/strict'
import { mkdtemp, readFile, readFile as readText, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest, submitPrompt, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium, webkit } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
const envFile = process.env.DSH_POC_ENV_FILE
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-real-lifecycle-e2e-')))
const port = Number(process.env.DSH_POC_PORT ?? '0')
const localNoProxy = new Set((process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').filter(Boolean))
localNoProxy.add('127.0.0.1')
localNoProxy.add('localhost')
process.env.NO_PROXY = [...localNoProxy].join(',')
process.env.no_proxy = process.env.NO_PROXY

if (!['chrome', 'webkit'].includes(browserName)) throw new Error('DSH_POC_BROWSER must be chrome or webkit')
if (envFile === undefined) throw new Error('DSH_POC_ENV_FILE is required for real mode')
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')

const requests = []
const networkRequests = []
const llmResponseTasks = []
const pageErrors = []
const httpErrors = []
const llmStatuses = []
let image
let app
let browser
let page
let origin

function requestBody(request) {
  const raw = request.postData()
  if (raw === null) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

async function readSecrets(file) {
  const text = await readText(file, 'utf8')
  return text.split(/\r?\n/)
    .map(line => line.match(/^(OPENAI_NEXT_(?:GPT|GROK)_API_KEY)=(.*)$/)?.[2])
    .filter(value => value !== undefined && value.length > 0)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'real', envFile })
  origin = await app.listen(port)
  const browserType = browserName === 'webkit' ? webkit : chromium
  browser = await browserType.launch({ headless: true, ...(browserName === 'chrome' ? { channel: 'chrome' } : {}) })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page.on('request', request => {
    const body = requestBody(request)
    networkRequests.push({ url: request.url(), body, headers: request.headers() })
    if (request.url().includes('/api/browser-native/')) {
      requests.push({ path: new URL(request.url()).pathname, body, request, startedAt: Date.now() })
    }
  })
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    if (path === '/api/browser-native/llm') {
      llmStatuses.push(response.status())
      const request = requests.find(candidate => candidate.request === response.request())
      if (request !== undefined) {
        request.status = response.status()
        llmResponseTasks.push(response.body().then(body => {
          const records = body.toString('utf8').split(/\r?\n/).filter(line => line.length > 0).map(line => JSON.parse(line))
          request.stream = {
            bytes: body.length,
            chunks: records.filter(record => record.kind === 'chunk').map(record => ({
              type: record.chunk?.type,
              textLength: typeof record.chunk?.text === 'string' ? record.chunk.text.length : undefined,
              finish: record.chunk?.reason,
            })),
            errors: records.filter(record => record.kind === 'error').map(record => record.error?.code),
          }
        }).catch(error => {
          request.streamReadError = error instanceof Error ? error.message : String(error)
        }))
      }
    }
    if (response.status() >= 400) httpErrors.push({ path, status: response.status() })
  })
  page.on('pageerror', error => pageErrors.push(error.message))

  await openPreview(page, `${origin}/preview.html?browser-native=1&preview-fixture=none`)
  const stopPrompt = `Keep generating a long response until I stop it. Repeat this phrase many times: ${'browser stop probe '.repeat(120)}`
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(stopPrompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const sessionId = await waitFor(async () => requests.find(request => request.path.endsWith('/session/create'))?.body.sessionId, 'Session creation')
  const inFlight = await waitFor(async () => requests.find(request => request.path.endsWith('/llm') && request.request.failure() === null), 'in-flight real LLM request', 60_000)
  const stopButton = page.getByRole('button', { name: /^(Stop generating|停止生成)$/ }).last()
  await stopButton.waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal(await stopButton.isEnabled(), true)
  await stopButton.click()
  const stopped = await waitFor(async () => {
    const current = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const terminal = current.events.filter(event => event.type === 'turn/end').at(-1)
    return terminal?.data.reason.kind === 'aborted' ? current : undefined
  }, 'real LLM stop settlement', 120_000)
  const recoveryPrompt = 'After the previous turn was stopped, reply with exactly REAL_BROWSER_STOP_RECOVERY_OK.'
  let recovery = await submitPrompt({
    page,
    origin,
    requests,
    sessionId,
    prompt: recoveryPrompt,
    expectedReason: null,
    timeout: Number(process.env.DSH_POC_TURN_TIMEOUT_MS ?? 600_000),
  })
  const firstRecoveryReason = recovery.session.events.findLast(event => event.type === 'turn/end' && event.data.turn === recovery.turn).data.reason
  let emptyRecoveryRetried = false
  if (firstRecoveryReason.kind === 'error' && firstRecoveryReason.error?.code === 'UPSTREAM_LLM_EMPTY') {
    emptyRecoveryRetried = true
    recovery = await sendTurn({
      page,
      origin,
      requests,
      sessionId,
      prompt: 'Retry the prior request now. Reply with exactly REAL_BROWSER_STOP_RECOVERY_OK.',
      marker: 'REAL_BROWSER_STOP_RECOVERY_OK',
      timeout: Number(process.env.DSH_POC_TURN_TIMEOUT_MS ?? 600_000),
    })
  } else {
    assert.equal(firstRecoveryReason.kind, 'completed', JSON.stringify(firstRecoveryReason))
    assert.equal(assistantText(recovery.session, recovery.turn).includes('REAL_BROWSER_STOP_RECOVERY_OK'), true,
      `Recovery response omitted marker: ${assistantText(recovery.session, recovery.turn).slice(0, 400)}`)
  }
  const persisted = await waitFor(async () => {
    const current = JSON.parse(await readFile(join(dataDir, 'sessions', `${sessionId}.json`), 'utf8'))
    return current.durableThroughSeq === current.events.length - 1
      && assistantText({ events: current.events }, recovery.turn).includes('REAL_BROWSER_STOP_RECOVERY_OK')
      ? current
      : undefined
  }, 'real stop recovery durability', 30_000)
  await Promise.allSettled(llmResponseTasks)
  const wire = JSON.stringify(requests)
  const browserWire = JSON.stringify(networkRequests)
  for (const secret of await readSecrets(envFile)) {
    assert.equal(wire.includes(secret), false)
    assert.equal(browserWire.includes(secret), false, 'provider secret appeared in browser network traffic')
  }
  assert.equal(stopped.events.filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'aborted')
  assert.equal(recovery.session.events.filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
  const reasons = persisted.events.filter(event => event.type === 'turn/end').map(event => event.data.reason)
  assert.equal(reasons[0].kind, 'aborted')
  assert.equal(reasons.at(-1).kind, 'completed')
  if (emptyRecoveryRetried) {
    assert.equal(reasons.length, 3)
    assert.equal(reasons[1].kind, 'error')
    assert.equal(reasons[1].error?.code, 'UPSTREAM_LLM_EMPTY')
  } else {
    assert.equal(reasons.length, 2)
  }
  assert.equal(networkRequests.filter(request => new URL(request.url).pathname === '/api/browser-native/llm')
    .every(request => new URL(request.url).origin === origin), true)
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    mode: 'real',
    browser: browserName,
    sessionId,
    stoppedRequestStarted: inFlight.body?.requestId !== undefined,
    turns: persisted.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind),
    emptyRecoveryRetried,
    durableThroughSeq: persisted.durableThroughSeq,
    llmStatuses,
    llmRequestSummaries: requests.filter(request => request.path === '/api/browser-native/llm').map(request => ({
      startedAt: request.startedAt,
      status: request.status,
      messageCount: request.body?.messages?.length,
      toolCount: request.body?.tools?.length ?? 0,
      stream: request.stream,
      streamReadError: request.streamReadError,
    })),
    pageErrors,
    httpErrors,
  })}\n`)
} catch (error) {
  const sessionId = requests.find(request => request.path.endsWith('/session/create'))?.body.sessionId
  let events = []
  if (sessionId !== undefined && app !== undefined) {
    try { events = (await sessionRequest(origin, 'read', { sessionId, offset: 0 })).events ?? [] } catch {}
  }
  await Promise.allSettled(llmResponseTasks)
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    sessionId,
    dataDir,
    llmStatuses,
    llmRequestSummaries: requests.filter(request => request.path === '/api/browser-native/llm').map(request => ({
      startedAt: request.startedAt,
      status: request.status,
      messageCount: request.body?.messages?.length,
      toolCount: request.body?.tools?.length ?? 0,
      stream: request.stream,
      streamReadError: request.streamReadError,
    })),
    turns: events.filter(event => event.type === 'turn/end').map(event => ({ turn: event.data.turn, reason: event.data.reason })),
    assistantMessages: events.filter(event => event.type === 'assistant/message').map(event => ({
      turn: event.data.turn,
      text: assistantText({ events: [event] }, event.data.turn).slice(0, 240),
      chunks: event.data.stream?.filter(record => record.type === 'text-chunks').reduce((sum, record) => sum + record.texts.length, 0) ?? 0,
    })),
    pageErrors,
    httpErrors,
  })}\n`)
  throw error
} finally {
  await page?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
