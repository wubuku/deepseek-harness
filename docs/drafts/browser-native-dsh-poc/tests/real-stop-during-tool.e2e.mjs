import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, rememberSessionPrincipal, sessionRequest, submitPrompt, waitFor } from './runtime-test-support.mjs'

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
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-real-tool-stop-')))
const port = Number(process.env.DSH_POC_PORT ?? '0')

if (!['chrome', 'webkit'].includes(browserName)) throw new Error('DSH_POC_BROWSER must be chrome or webkit')
if (envFile === undefined) throw new Error('DSH_POC_ENV_FILE is required for real mode')

const requests = []
const pageErrors = []
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

/** Terminal reason of the last turn ending at or after one event index. */
function lastTurnEnd(session) {
  return session.events.filter(event => event.type === 'turn/end').at(-1)
}

/** One tool call and any recorded result, matched by call id. */
function toolPair(session, name) {
  const call = session.events.findLast(event => event.type === 'tool/call' && event.data.name === name)
  if (call === undefined) return {}
  const result = session.events.find(event => event.type === 'tool/result'
    && event.data.message.toolCallId === call.data.callId)
  return { call, result }
}

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'real', envFile })
  origin = await app.listen(port)
  browser = await (browserName === 'webkit' ? webkit : chromium).launch({
    headless: true,
    ...(browserName === 'chrome' ? { channel: 'chrome' } : {}),
  })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page.on('request', request => {
    if (request.url().includes('/api/browser-native/')) {
      requests.push({ path: new URL(request.url()).pathname, body: requestBody(request), request })
    }
  })
  page.on('pageerror', error => pageErrors.push(error.message))

  await openPreview(page, `${origin}/preview.html?browser-native=1&preview-fixture=none`)
  const prompt = 'Use the bash tool exactly once to run `sleep 4` and nothing else. Do not answer before the command finishes.'
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(prompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const sessionId = await waitFor(async () => requests.find(request => request.path.endsWith('/session/create'))?.body.sessionId, 'Session creation')
  await rememberSessionPrincipal(page, origin, sessionId)
  const running = await waitFor(async () => {
    const current = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const pair = toolPair(current, 'bash')
    return pair.call !== undefined && pair.result === undefined ? current : undefined
  }, 'bash tool execution in flight', Number(process.env.DSH_POC_TOOL_TIMEOUT_MS ?? 180_000))
  const callId = toolPair(running, 'bash').call.data.callId
  const stopButton = page.getByRole('button', { name: /^(Stop generating|停止生成)$/ }).last()
  await stopButton.waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal(await stopButton.isEnabled(), true)
  await stopButton.click()
  await waitFor(async () => {
    const current = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    return lastTurnEnd(current)?.data.reason.kind === 'aborted' ? current : undefined
  }, 'tool-phase stop settlement', 120_000)
  const requestsAtStop = requests.filter(request => request.path === '/api/browser-native/llm').length
  await new Promise(resolveDelay => setTimeout(resolveDelay, 6_000))
  const afterWait = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
  const requestsAfter = requests.filter(request => request.path === '/api/browser-native/llm').length
  assert.equal(requestsAfter, requestsAtStop, 'a stopped tool phase must not restart the model stream')
  assert.equal(afterWait.events.filter(event => event.type === 'turn/end').length, 1, 'the stopped turn must stay single')
  assert.equal(afterWait.events.filter(event => event.type === 'tool/call' && event.data.name === 'bash').length, 1,
    'the stopped tool must not be re-executed')
  const resumePrompt = 'The earlier stopped command no longer matters. Reply with exactly REAL_TOOL_STOP_RECOVERY_OK.'
  const resumed = await submitPrompt({
    page,
    origin,
    requests,
    sessionId,
    prompt: resumePrompt,
    timeout: Number(process.env.DSH_POC_TURN_TIMEOUT_MS ?? 600_000),
  })
  const resumedTurns = resumed.session.events.filter(event => event.type === 'turn/end')
  assert.equal(resumedTurns.at(-1).data.reason.kind, 'completed')
  assert.equal(resumed.session.events.filter(event => event.type === 'tool/call' && event.data.name === 'bash').length, 1,
    'resuming a cut tool phase must not replay the command')
  const cutResult = resumed.session.events.find(event => event.type === 'tool/result'
    && event.data.message.toolCallId === callId)
  assert.equal(cutResult?.data.message.isError, true, 'the cut tool call must settle as an error result')
  assert.equal(resumed.session.events.some(event => event.type === 'assistant/message'
    && event.data.turn === resumed.turn
    && event.data.message.content.some(block => block.type === 'text' && block.text.includes('REAL_TOOL_STOP_RECOVERY_OK'))), true,
    'the resumed turn must answer the user prompt')
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    mode: 'real',
    browser: browserName,
    sessionId,
    callId,
    turns: resumedTurns.map(event => event.data.reason.kind),
    toolCalls: resumed.session.events.filter(event => event.type === 'tool/call').length,
    toolResults: resumed.session.events.filter(event => event.type === 'tool/result').map(event => ({
      callId: event.data.message.toolCallId,
      isError: event.data.message.isError,
      text: event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('').slice(0, 120),
    })),
    llmRequestsAtStop: requestsAtStop,
    llmRequestsAfterWait: requestsAfter,
    note: 'Stopping during real-LLM bash execution settles one aborted turn, records the cut call as an error result, starts no replacement stream, and the next user turn completes without replaying the command.',
  })}\n`)
} catch (error) {
  const sessionId = requests.find(request => request.path.endsWith('/session/create'))?.body.sessionId
  let events = []
  if (sessionId !== undefined && app !== undefined) {
    try { events = (await sessionRequest(origin, 'read', { sessionId, offset: 0 })).events ?? [] } catch {}
  }
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    sessionId,
    turns: events.filter(event => event.type === 'turn/end').map(event => event.data.reason),
    toolCalls: events.filter(event => event.type === 'tool/call').map(event => ({ name: event.data.name, callId: event.data.callId })),
    assistant: events.filter(event => event.type === 'assistant/message').map(event => event.data.message.content),
    requestPaths: requests.map(request => request.path),
    pageErrors,
  })}\n`)
  throw error
} finally {
  await page?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
