import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright

const mode = process.env.DSH_POC_LLM ?? 'scripted'
const browserName = process.env.DSH_POC_BROWSER ?? 'chromium'
const envFile = process.env.DSH_POC_ENV_FILE
const port = Number(process.env.DSH_POC_PORT ?? '4196')
const distRoot = resolve(process.env.DSH_POC_DIST_ROOT ?? 'apps/web/dist')
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'browser-native-dsh-v2-e2e-')))
const memoryToken = `BROWSER_NATIVE_MEMORY_${randomUUID().replaceAll('-', '').toUpperCase()}`
const followupMarker = 'BROWSER_NATIVE_FOLLOWUP_CONTEXT_OK'
const prompt = mode === 'real'
  ? `Use the todo_write tool to add exactly one pending task titled "Browser-native tool-call E2E proof". Remember this exact token for my next message: ${memoryToken}. After the tool succeeds, reply with exactly this marker: BROWSER_NATIVE_MEMORY_READY`
  : '请回复：BROWSER_NATIVE_SCRIPTED_E2E_OK'
const prompts = mode === 'real'
  ? [
    prompt,
    'What exact token did I ask you to remember? Reply with only the token, no quotes or explanation.',
    `Reply with exactly three lines: ${followupMarker}, the remembered token ${memoryToken}, and the earlier task title Browser-native tool-call E2E proof. Do not add anything else.`,
  ]
  : [prompt]
const expectedReplies = mode === 'real'
  ? ['BROWSER_NATIVE_MEMORY_READY', memoryToken, followupMarker]
  : ['BROWSER_NATIVE_SCRIPTED_E2E_OK']

const localNoProxy = new Set((process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').filter(Boolean))
localNoProxy.add('127.0.0.1')
localNoProxy.add('localhost')
process.env.NO_PROXY = [...localNoProxy].join(',')
process.env.no_proxy = process.env.NO_PROXY

if (mode !== 'scripted' && mode !== 'real') throw new Error('DSH_POC_LLM must be scripted or real')
if (!['chromium', 'chrome'].includes(browserName)) throw new Error('DSH_POC_BROWSER must be chromium or chrome')
if (mode === 'real' && envFile === undefined) throw new Error('DSH_POC_ENV_FILE is required for real mode')
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')

function requestJson(request) {
  const body = request.postData()
  if (body === null) return undefined
  try { return JSON.parse(body) } catch { return undefined }
}

async function clickPreviewNotice(page) {
  const button = page.getByRole('button', { name: /^(Continue|继续)$/ }).first()
  if (await button.count() > 0 && await button.isVisible()) await button.click()
}

async function chooseWorkspace(page) {
  const chooser = page.getByRole('textbox', { name: /^(Choose workspace|选择工作区)$/ }).first()
  await chooser.click()
  const dialog = page.getByRole('dialog', { name: /^(Select Workspace Directory|选择工作区目录)$/ })
  await dialog.waitFor({ timeout: 15_000 })
  const editPath = dialog.getByRole('button', { name: /^(Edit path|编辑路径)$/ })
  if (await editPath.count() > 0 && await editPath.isVisible()) await editPath.click()
  const pathInput = dialog.getByRole('textbox', { name: /^(Edit path|编辑路径)$/ })
  if (await pathInput.count() > 0) {
    await pathInput.fill('/dsh/home/')
    await pathInput.press('Enter')
  }
  await dialog.getByRole('button', { name: /^(Open|打开)$/ }).click()
}

async function readSession(origin, id) {
  const response = await fetch(`${origin}/api/browser-native/session/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, requestId: `e2e-read-${id}`, sessionId: id, offset: 0 }),
  })
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  return body
}

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

async function waitForTurn(origin, id, prompt, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await readSession(origin, id)
    const userIndex = latest.events.findLastIndex(event => event.type === 'user/message'
      && eventText(event).trim() === prompt.trim())
    if (userIndex >= 0) {
      const turnEnd = latest.events.slice(userIndex + 1).find(event => event.type === 'turn/end')
      if (turnEnd !== undefined) return { session: latest, turnEnd }
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  throw new Error(`Session did not reach a terminal turn; latest events: ${JSON.stringify(latest?.events?.slice(-12).map(event => ({
    seq: event.seq,
    type: event.type,
    turn: event.data?.turn,
    name: event.data?.name,
    reason: event.data?.reason,
  })) ?? [])}`)
}

async function readSecrets(file) {
  if (file === undefined) return []
  const text = await readFile(file, 'utf8')
  return text.split(/\r?\n/)
    .map(line => line.match(/^(OPENAI_NEXT_(?:GPT|GROK)_API_KEY)=(.*)$/)?.[2])
    .filter(value => value !== undefined && value.length > 0)
}

const app = await createBrowserNativeV2Server({ dataDir, distRoot, llmMode: mode, envFile })
const origin = await app.listen(port)
const browser = await chromium.launch({ headless: true, ...(browserName === 'chrome' ? { channel: 'chrome' } : {}) })
const page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
const requests = []
const pageErrors = []
const browserConsoleErrors = []
const browserHttpErrors = []
const llmStatuses = []
let createRequest
let sessionId
let latestSession
page.on('request', request => {
  if (request.url().includes('/api/browser-native/')) requests.push({ url: request.url(), method: request.method(), body: requestJson(request) })
})
page.on('pageerror', error => pageErrors.push(error.message))
page.on('console', message => {
  if (message.type() === 'error') browserConsoleErrors.push(message.text())
})
page.on('response', response => {
  if (response.url().endsWith('/api/browser-native/llm')) llmStatuses.push(response.status())
  if (response.status() >= 400) browserHttpErrors.push({ path: new URL(response.url()).pathname, status: response.status() })
})

try {
  await page.goto(`${origin}/preview.html?browser-native=1&preview-fixture=none`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  await clickPreviewNotice(page)
  await chooseWorkspace(page)
  await page.getByText('Browser-native remote', { exact: true }).waitFor({ timeout: 15_000 })

  const input = page.locator('[data-composer-input][contenteditable="true"]').last()
  await input.waitFor({ timeout: 15_000 })
  const sendButton = page.getByRole('button', { name: /^(Send message|发送消息)$/ })
  for (let index = 0; index < prompts.length; index += 1) {
    const currentPrompt = prompts[index]
    const expectedReply = expectedReplies[index]
    assert.notEqual(currentPrompt, undefined)
    assert.notEqual(expectedReply, undefined)
    const turnStartedAt = Date.now()
    process.stdout.write(`${JSON.stringify({ phase: 'turn-start', turn: index + 1, mode, browser: browserName })}\n`)
    await input.fill(currentPrompt)
    assert.equal(await sendButton.isEnabled(), true, 'the Web UI must accept each non-empty message')
    await sendButton.click()
    if (index === 0) {
      const creationDeadline = Date.now() + 15_000
      while (createRequest === undefined && Date.now() < creationDeadline) {
        createRequest = requests.find(request => request.url.endsWith('/session/create'))
        if (createRequest === undefined) await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
      }
      assert.notEqual(createRequest, undefined, 'the Web UI did not create a remote Session')
      assert.equal(typeof createRequest.body.sessionId, 'string')
      sessionId = createRequest.body.sessionId
    }
    assert.notEqual(sessionId, undefined)
    const { session, turnEnd } = await waitForTurn(origin, sessionId, currentPrompt,
      Number(process.env.DSH_POC_TURN_TIMEOUT_MS ?? (mode === 'real' ? 300_000 : 30_000)))
    latestSession = session
    const reason = turnEnd.data.reason
    assert.equal(reason.kind, 'completed',
      `Turn ${turnEnd.data.turn} ended as ${JSON.stringify(reason)} after prompt ${JSON.stringify(currentPrompt)}`)
    const assistantText = session.events
      .filter(event => event.type === 'assistant/message' && event.data.turn === turnEnd.data.turn)
      .map(eventText)
      .join('\n')
    assert.equal(assistantText.includes(expectedReply), true,
      `Turn ${turnEnd.data.turn} completed without expected marker ${expectedReply}; assistant text: ${JSON.stringify(assistantText.slice(-800))}`)
    assert.equal(session.events.filter(event => event.type === 'user/message').length >= index + 1, true)
    await page.getByText(expectedReply, { exact: false }).last().waitFor({ timeout: 30_000 })
    process.stdout.write(`${JSON.stringify({ phase: 'turn-complete', turn: index + 1, reason: reason.kind, elapsedMs: Date.now() - turnStartedAt, eventCount: session.events.length })}\n`)
  }
  const session = await readSession(origin, sessionId)
  latestSession = session
  const eventTypes = session.events.map(event => event.type)
  assert.equal(eventTypes.includes('user/message') || eventTypes.includes('agent/inbox/spliced'), true, JSON.stringify(eventTypes))
  assert.equal(eventTypes.includes('assistant/message'), true, JSON.stringify(eventTypes))
  if (mode === 'real') {
    assert.equal(eventTypes.filter(type => type === 'turn/end').length >= prompts.length, true, 'the same Session must complete all three turns')
    assert.equal(eventTypes.includes('todo/write'), true, 'the real DSH Agent must execute the requested todo tool')
    const assistantTexts = session.events
      .filter(event => event.type === 'assistant/message')
      .flatMap(event => event.data.message.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text.trim())
    assert.equal(assistantTexts.includes(memoryToken), true, 'the second real model turn must recall the token from the first turn')
    assert.equal(assistantTexts.some(text => text.includes(followupMarker) && text.includes(memoryToken)
      && text.includes('Browser-native tool-call E2E proof')), true, 'the third turn must retain the prior token and task context')
    const todoEvents = session.events.filter(event => event.type === 'todo/write')
    assert.equal(todoEvents.length, 1, 'the real DSH tool must record exactly one todo write')
    assert.deepEqual(todoEvents[0].data.todos.map(todo => ({ content: todo.content, status: todo.status })), [
      { content: 'Browser-native tool-call E2E proof', status: 'pending' },
    ])
  }
  const sessionText = JSON.stringify(session.events)
  const submittedTexts = session.events
    .filter(event => event.type === 'user/message')
    .flatMap(event => event.data.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
  assert.equal(prompts.every(currentPrompt => submittedTexts.includes(currentPrompt)), true,
    'the persisted Session must contain every submitted prompt as a user message')
  assert.equal(sessionText.includes(mode === 'real' ? 'BROWSER_NATIVE_MEMORY_READY' : 'BROWSER_NATIVE_SCRIPTED_E2E_OK'), true,
    'the persisted assistant response did not contain the provider marker')
  assert.equal(requests.some(request => request.url.endsWith('/session/flush')), true)
  assert.equal(requests.some(request => request.url.endsWith('/llm')), true)
  if (mode === 'real') assert.equal(llmStatuses.every(status => status === 200), true, JSON.stringify(llmStatuses))
  assert.deepEqual(pageErrors, [])

  const durableRecord = JSON.parse(await readFile(join(dataDir, 'sessions', `${createRequest.body.sessionId}.json`), 'utf8'))
  assert.equal(durableRecord.durableThroughSeq, durableRecord.events.length - 1)

  const browserWire = JSON.stringify(requests)
  for (const secret of await readSecrets(envFile)) assert.equal(browserWire.includes(secret), false)

  process.stdout.write(`${JSON.stringify({
    mode,
    model: app.llm.model,
    browser: browserName,
    sessionId: createRequest.body.sessionId,
    eventCount: session.events.length,
    durableThroughSeq: session.durableThroughSeq,
    submittedTurns: prompts.length,
    sameSessionMemoryVerified: mode === 'real',
    todoWritePersisted: mode === 'real',
    browserConsoleErrors,
    browserHttpErrors,
    llmStatuses,
    assistantStreamStats: session.events.filter(event => event.type === 'assistant/message').map(event => ({
      turn: event.data.turn,
      step: event.data.step,
      textChunks: event.data.stream.filter(record => record.type === 'text-chunks').reduce((sum, record) => sum + record.texts.length, 0),
      streamSpanMs: event.data.stream.filter(record => record.type === 'text-chunks')
        .reduce((sum, record) => sum + record.dt.reduce((total, gap) => total + gap, 0), 0),
    })),
    llmRequestSummaries: requests.filter(request => request.url.endsWith('/llm')).map(request => ({
      messageCount: Array.isArray(request.body?.messages) ? request.body.messages.length : null,
      toolNames: Array.isArray(request.body?.tools)
        ? request.body.tools.map(tool => tool.function?.name ?? tool.name ?? null).filter(name => name !== null)
        : [],
    })),
    browserApiRoutes: [...new Set(requests.map(request => new URL(request.url).pathname))],
  })}\n`)
} catch (error) {
  const events = latestSession?.events ?? []
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    sessionId,
    dataDir,
    llmStatuses,
    browserHttpErrors,
    pageErrors,
    browserConsoleErrors,
    recentEvents: events.slice(-20).map(event => ({
      seq: event.seq,
      type: event.type,
      turn: event.data?.turn,
      step: event.data?.step,
      name: event.data?.name,
      callId: event.data?.callId,
      reason: event.data?.reason,
      text: event.type === 'assistant/message' ? eventText(event).slice(0, 240) : undefined,
    })),
  })}\n`)
  throw error
} finally {
  await page.close()
  await browser.close()
  await app.close()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
