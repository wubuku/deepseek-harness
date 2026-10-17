import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createBrowserNativeV2Server } from '../../browser-native-dsh-poc/backend-v2.mjs'
import { measureAssistantUiContrast } from './color-contrast.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../../../..')
const repositoryRequire = createRequire(resolve(repositoryRoot, 'apps/web/package.json'))
const configuredPlaywrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
const playwrightModule = configuredPlaywrightModule === undefined
  ? (() => {
    try { return repositoryRequire.resolve('playwright') } catch {
      throw new Error('Install repository dependencies or set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
  : resolve(configuredPlaywrightModule)
const playwright = await import(playwrightModule)

function optionValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

const browserName = optionValue('--browser') ?? 'chromium'
if (!['chromium', 'webkit', 'chrome'].includes(browserName)) {
  throw new Error('--browser must be chromium, webkit, or chrome')
}
const browserTypes = playwright.default ?? playwright
const browserType = browserName === 'webkit' ? browserTypes.webkit : browserTypes.chromium
if (browserType === undefined) throw new Error(`The configured Playwright entry does not export ${browserName}`)
const mode = optionValue('--llm') ?? process.env.DSH_ASSISTANT_UI_POC_LLM ?? 'scripted'
if (mode !== 'scripted' && mode !== 'real') throw new Error('--llm must be scripted or real')
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
if (mode === 'real' && proxy !== undefined && !process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
  throw new Error('Real E2E with an HTTP proxy requires Node 24 environment proxy support')
}
if (mode === 'real' && proxy !== undefined && !process.execArgv.includes('--use-env-proxy')
  && process.env.BROWSER_NATIVE_PROXY_REEXEC !== '1') {
  const noProxy = new Set((process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').filter(Boolean))
  noProxy.add('127.0.0.1')
  noProxy.add('localhost')
  const result = spawnSync(process.execPath, [
    '--use-env-proxy',
    ...process.execArgv,
    fileURLToPath(import.meta.url),
    ...process.argv.slice(2),
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? process.env.https_proxy,
      HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.http_proxy,
      NO_PROXY: [...noProxy].join(','),
      no_proxy: [...noProxy].join(','),
      BROWSER_NATIVE_PROXY_REEXEC: '1',
    },
  })
  process.exit(result.status ?? 1)
}
const configuredEnvFile = optionValue('--env-file') ?? process.env.DSH_ASSISTANT_UI_POC_ENV_FILE
const envFile = configuredEnvFile === undefined
  ? mode === 'real' ? resolve(repositoryRoot, 'docs/drafts/.env') : undefined
  : resolve(configuredEnvFile)
const port = Number(process.env.DSH_ASSISTANT_UI_POC_PORT ?? '0')
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DSH_ASSISTANT_UI_POC_PORT must be a TCP port')
const temporaryDataDir = process.env.DSH_ASSISTANT_UI_POC_DATA_DIR === undefined
const dataDir = resolve(process.env.DSH_ASSISTANT_UI_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-assistant-ui-poc-')))
const distRoot = resolve(process.env.DSH_ASSISTANT_UI_POC_DIST_ROOT ?? join(repositoryRoot, 'apps/web/dist'))
const configuredOrigin = process.env.DSH_ASSISTANT_UI_POC_ORIGIN
const externalOrigin = configuredOrigin === undefined ? undefined : new URL(configuredOrigin).origin
if (externalOrigin !== undefined && temporaryDataDir) {
  throw new Error('External-origin E2E requires DSH_ASSISTANT_UI_POC_DATA_DIR for that backend')
}
const marker = 'ASSISTANT_UI_BROWSER_NATIVE_E2E_OK'
const memoryToken = `DSH_MEMORY_${randomUUID().replaceAll('-', '').toUpperCase()}`
const failureToken = `DSH_INJECTED_FAILURE_${randomUUID().replaceAll('-', '').toUpperCase()}`
const followupMarker = 'ASSISTANT_UI_FOLLOWUP_CONTEXT_OK'
const injectFailure = mode === 'real' && externalOrigin === undefined
const firstPrompt = mode === 'real'
  ? `Use the todo_write tool to add exactly one pending task titled "Browser-native tool-call E2E proof". Remember this exact token for my next message: ${memoryToken}. After the tool succeeds, reply with exactly this marker: ${marker}`
  : `Please reply with exactly this marker: ${marker}`
const prompts = mode === 'real'
  ? [
    firstPrompt,
    injectFailure
      ? `This request is part of a controlled retry test. Mention this token in your answer: ${failureToken}.`
      : 'Reply with exactly this marker: ASSISTANT_UI_RECOVERY_TURN_OK',
    'What exact token did I ask you to remember? Reply with only the token, no quotes or explanation.',
    `Reply with exactly three lines: ${followupMarker}, the remembered token ${memoryToken}, and the earlier task title Browser-native tool-call E2E proof. Do not add anything else.`,
  ]
  : [firstPrompt]
const responseMarkers = mode === 'real'
  ? [marker, injectFailure ? undefined : 'ASSISTANT_UI_RECOVERY_TURN_OK', memoryToken, followupMarker]
  : [marker]
const refreshPrompt = 'Reply with exactly this marker: ASSISTANT_UI_REFRESH_CONTINUATION_OK'
const refreshMarker = 'ASSISTANT_UI_REFRESH_CONTINUATION_OK'

async function resetLiveTextTrace(page) {
  await page.evaluate(() => {
    window.__dshLiveTextTrace = []
    window.__dshLiveTextObserver?.disconnect()
    const capture = () => {
      for (const row of document.querySelectorAll('[data-dsh-live="true"]')) {
        const text = row.querySelector('.message-body')?.textContent?.trim() ?? ''
        if (text.length === 0) continue
        const trace = window.__dshLiveTextTrace
        if (trace.at(-1)?.text !== text) trace.push({ time: performance.now(), text })
      }
    }
    const observer = new MutationObserver(capture)
    observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true })
    window.__dshLiveTextObserver = observer
  })
}

async function visibleStreamEvidence(page, expectedText) {
  return page.evaluate(expected => {
    const trace = window.__dshLiveTextTrace ?? []
    const snapshots = [...new Set(trace.map(item => item.text))]
    const completedRows = [...document.querySelectorAll('[data-role="assistant"]:not([data-dsh-live="true"])')]
    const finalText = completedRows.at(-1)?.querySelector('.message-body')?.textContent?.trim() ?? ''
    return {
      snapshotCount: snapshots.length,
      partialSnapshots: snapshots.filter(text => text.length < finalText.length).length,
      snapshotLengths: snapshots.map(text => text.length),
      finalContainsExpected: finalText.includes(expected),
    }
  }, expectedText)
}

async function readSecrets(file) {
  if (file === undefined) return []
  const text = await readFile(file, 'utf8')
  return text.split(/\r?\n/)
    .map(line => line.trim().match(/^(OPENAI_NEXT_(?:GPT|GROK)_API_KEY)=(.*)$/)?.[2])
    .filter(value => value !== undefined && value.length > 0)
    .map(value => value.replace(/^(['"])(.*)\1$/, '$2'))
}

function simulateMissingDisposableSymbols() {
  const nativeSymbol = globalThis.Symbol
  function SymbolWithoutDispose(description) {
    if (new.target) throw new TypeError('Symbol is not a constructor')
    return nativeSymbol(description)
  }
  Object.setPrototypeOf(SymbolWithoutDispose, Function.prototype)
  Object.defineProperty(SymbolWithoutDispose, 'prototype', { value: nativeSymbol.prototype })
  for (const key of Reflect.ownKeys(nativeSymbol)) {
    if (key === 'name' || key === 'length' || key === 'prototype' || key === 'dispose' || key === 'asyncDispose') continue
    Object.defineProperty(SymbolWithoutDispose, key, Object.getOwnPropertyDescriptor(nativeSymbol, key))
  }
  globalThis.Symbol = SymbolWithoutDispose
}

async function readSession(origin, sessionId) {
  const response = await fetch(`${origin}/api/browser-native/session/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, requestId: `assistant-ui-read-${sessionId}`, sessionId, offset: 0 }),
  })
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  return body
}

async function waitForSession(origin, sessionId, expectedTurns, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await readSession(origin, sessionId)
    const userMessages = latest.events.filter(event => event.type === 'user/message')
    const completedTurns = latest.events.filter(event => event.type === 'turn/end')
    if (userMessages.length >= expectedTurns && completedTurns.length >= expectedTurns) {
      return latest
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200))
  }
  throw new Error(`Session did not complete: ${JSON.stringify(latest?.events?.map(event => event.type) ?? [])}`)
}

let app
let browser
let page
let injectedFailureCount = 0

try {
  const secrets = await readSecrets(envFile)
  let origin = externalOrigin
  if (origin === undefined) {
    const testHooks = injectFailure ? {
      failLlmRequest(body) {
        if (injectedFailureCount > 0 || !JSON.stringify(body.messages).includes(failureToken)) return false
        injectedFailureCount += 1
        return true
      },
    } : undefined
    app = await createBrowserNativeV2Server({
      dataDir,
      distRoot,
      llmMode: mode,
      envFile,
      ...(testHooks === undefined ? {} : { testHooks }),
    })
    await app.listen(port)
    const address = app.server.address()
    assert.notEqual(address, null)
    assert.equal(typeof address, 'object')
    origin = `http://127.0.0.1:${address.port}`
  }
  const healthResponse = await fetch(`${origin}/api/browser-native/health`)
  assert.equal(healthResponse.ok, true)
  const health = await healthResponse.json()
  assert.equal(health.llmMode, mode)
  if (app !== undefined) assert.equal(app.llm.mode, mode)

  browser = await browserType.launch({
    headless: true,
    ...(browserName === 'chrome' ? { channel: 'chrome' } : {}),
  })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  await page.addInitScript(() => {
    const key = '__dshPageHidePersistedForE2E'
    window.addEventListener('pagehide', event => {
      const prior = JSON.parse(window.sessionStorage.getItem(key) ?? '[]')
      prior.push(event.persisted)
      window.sessionStorage.setItem(key, JSON.stringify(prior))
    })
  })
  const sessionCreates = []
  const pageErrors = []
  const browserConsoleErrors = []
  const browserHttpErrors = []
  const sessionOpenStatuses = []
  const sessionCloseStatuses = []
  const sessionCloseRequests = []
  const llmStatuses = []
  const browserRequests = []
  const browserOrigins = new Set()
  let workerSymbolShimInjected = 0
  const workerShim = `(${simulateMissingDisposableSymbols.toString()})();\n`
  await page.addInitScript(simulateMissingDisposableSymbols)
  await page.route('**/assistant-ui-poc/assets/browser-native-worker-*.js', async route => {
    const response = await route.fetch()
    workerSymbolShimInjected += 1
    await route.fulfill({ response, body: `${workerShim}${await response.text()}` })
  })
  page.on('request', request => {
    browserOrigins.add(new URL(request.url()).origin)
    if (!request.url().startsWith(`${origin}/api/browser-native/`)) return
    const body = request.postData()
    const parsedBody = body === null ? undefined : (() => {
      try { return JSON.parse(body) } catch { return undefined }
    })()
    const headers = request.allHeaders()
    if (request.url().endsWith('/session/close')) sessionCloseRequests.push(parsedBody)
    browserRequests.push(headers.then(value => ({
      url: request.url(),
      method: request.method(),
      body: parsedBody,
      headers: value,
    })))
    if (request.url().endsWith('/session/create') && parsedBody !== undefined) sessionCreates.push(parsedBody)
  })
  page.on('response', response => {
    if (response.url().endsWith('/api/browser-native/llm')) llmStatuses.push(response.status())
    if (response.url().endsWith('/api/browser-native/session/open')) sessionOpenStatuses.push(response.status())
    if (response.url().endsWith('/api/browser-native/session/close')) sessionCloseStatuses.push(response.status())
    if (response.status() >= 400) browserHttpErrors.push({
      path: new URL(response.url()).pathname,
      status: response.status(),
    })
  })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') browserConsoleErrors.push(message.text())
  })
  page.on('worker', worker => worker.on('console', message => {
    if (message.type() === 'error') browserConsoleErrors.push(message.text())
  }))

  await page.goto(`${origin}/assistant-ui-poc/index.html`, { waitUntil: 'domcontentloaded' })
  await page.getByTestId('assistant-ui-ready').waitFor({ timeout: 60_000 })
  assert.equal(await page.evaluate(() => typeof Symbol.dispose), 'symbol', 'the page must install the missing disposal symbol')
  assert.equal(await page.evaluate(() => typeof Symbol.asyncDispose), 'symbol', 'the page must install the missing async disposal symbol')
  assert.equal(workerSymbolShimInjected > 0, true, 'the test must remove disposal symbols from the Worker realm')
  assert.equal(typeof health.model, 'string')
  if (app !== undefined) assert.equal(health.model, app.llm.model)
  const sessionDeadline = Date.now() + 10_000
  while (sessionCreates.length === 0 && Date.now() < sessionDeadline) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
  }
  assert.equal(sessionCreates.length, 1, 'the assistant-ui page should create exactly one DSH Session')
  const sessionId = sessionCreates[0].sessionId
  const input = page.getByTestId('assistant-ui-input')
  const sendButton = page.getByTestId('assistant-ui-send')
  const timeoutMs = mode === 'real' ? 240_000 : 60_000
  const turnEvidence = []
  let initialOwnerToken
  if (app !== undefined) initialOwnerToken = app.store.get(sessionId).ownerToken
  for (let index = 0; index < prompts.length; index += 1) {
    const currentPrompt = prompts[index]
    const responseMarker = responseMarkers[index]
    assert.notEqual(currentPrompt, undefined)
    if (responseMarker !== undefined) await resetLiveTextTrace(page)
    await input.fill(currentPrompt)
    assert.equal(await sendButton.isEnabled(), true, 'the composer must accept each non-empty message')
    await sendButton.click()
    await page.waitForFunction(expected => {
      const userRows = [...document.querySelectorAll('[data-role="user"]')]
      return userRows.some(row => row.textContent?.includes(expected))
    }, currentPrompt, { timeout: 15_000 })
    const turn = await waitForSession(origin, sessionId, index + 1, timeoutMs)
    if (responseMarker === undefined) {
      const failedTurn = turn.events.filter(event => event.type === 'turn/end').at(-1)
      assert.equal(failedTurn?.data.reason.kind, 'error', 'the injected provider failure must end this turn with a recorded error')
      assert.equal(turn.events.some(event => event.type === 'assistant/attempt' && event.data.turn === failedTurn.data.turn), true,
        'the DSH Session must record the failed model attempt')
      await page.getByTestId('assistant-ui-error').waitFor({ timeout: 15_000 })
      turnEvidence.push({ turn: index + 1, outcome: failedTurn.data.reason.kind, visibleError: true })
      continue
    }
    await page.waitForFunction(expected => {
      const assistantRows = [...document.querySelectorAll('[data-role="assistant"]:not([data-dsh-live="true"])')]
      return assistantRows.at(-1)?.textContent?.includes(expected) ?? false
    }, responseMarker, { timeout: timeoutMs })
    const stream = await visibleStreamEvidence(page, responseMarker)
    if (mode === 'real') {
      assert.equal(stream.partialSnapshots > 0, true, `the browser must render a partial assistant reply before completion: ${JSON.stringify(stream)}`)
    }
    assert.equal(stream.finalContainsExpected, true, 'the completed assistant message must contain its expected response')
    assert.equal(await page.getByTestId('assistant-ui-error').count(), 0, 'a subsequent DSH turn must clear the prior turn error')
    turnEvidence.push({ turn: index + 1, outcome: 'completed', stream })
  }
  assert.equal(injectedFailureCount, injectFailure ? 1 : 0, 'the expected one-shot model error must reach the backend')
  assert.equal(sessionCreates.length, 1, 'the assistant-ui page should create exactly one DSH Session')
  let toolCallVisible = false
  if (mode === 'real') {
    const toolCall = page.getByTestId('assistant-ui-tool-call').filter({ hasText: 'todo_write' }).first()
    await toolCall.waitFor({ timeout: 15_000 })
    await page.getByTestId('assistant-ui-tool-result').filter({ hasText: 'Updated todo list' }).first().waitFor({ timeout: 15_000 })
    toolCallVisible = true
  }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByTestId('assistant-ui-ready').waitFor({ timeout: 60_000 })
  await page.locator('[data-role="assistant"]').getByText(marker, { exact: false }).waitFor({ timeout: 60_000 })
  const pagehidePersisted = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem('__dshPageHidePersistedForE2E') ?? '[]'))
  const reopenedOwnerToken = app?.store.get(sessionId).ownerToken
  const ownerChangedAfterRefresh = initialOwnerToken !== undefined && reopenedOwnerToken !== initialOwnerToken
  assert.equal(sessionCloseRequests.length > 0, true,
    `pagehide must dispatch Session close: ${JSON.stringify({ pagehidePersisted, sessionOpenStatuses, sessionCloseStatuses, sessionCloseRequests, ownerChangedAfterRefresh })}`)
  assert.equal(sessionCreates.length, 1, 'refresh should reopen the stored Session rather than create another one')
  assert.equal(sessionOpenStatuses.at(-1), 200,
    `refresh must reacquire DSH write ownership: ${JSON.stringify({ sessionOpenStatuses, sessionCloseStatuses, sessionCloseRequests, ownerChangedAfterRefresh, ownerToken: reopenedOwnerToken, browserHttpErrors })}`)
  await input.fill(refreshPrompt)
  assert.equal(await sendButton.isEnabled(), true, 'the composer must remain usable after Session reopen')
  await sendButton.click()
  await page.waitForFunction(expected => [...document.querySelectorAll('[data-role="user"]')]
    .some(row => row.textContent?.includes(expected)), refreshPrompt, { timeout: 15_000 })
  await page.waitForFunction(expected => {
    const rows = [...document.querySelectorAll('[data-role="assistant"]:not([data-dsh-live="true"])')]
    return rows.at(-1)?.textContent?.includes(expected) ?? false
  }, refreshMarker, { timeout: timeoutMs })

  const session = await waitForSession(origin, sessionId, prompts.length + 1, timeoutMs)
  const eventTypes = session.events.map(event => event.type)
  const assistantStreamStats = session.events.filter(event => event.type === 'assistant/message').map(event => ({
    turn: event.data.turn,
    step: event.data.step,
    textChunks: event.data.stream.filter(record => record.type === 'text-chunks').reduce((sum, record) => sum + record.texts.length, 0),
    streamSpanMs: event.data.stream.filter(record => record.type === 'text-chunks')
      .reduce((sum, record) => sum + record.dt.reduce((total, gap) => total + gap, 0), 0),
  }))
  assert.equal(eventTypes.includes('user/message'), true, 'the DSH Session must contain the submitted user message')
  assert.equal(eventTypes.includes('assistant/message'), true, 'the DSH Session must contain the DSH Agent reply')
  assert.equal(eventTypes.includes('turn/end'), true, 'the DSH Agent turn must finish')
  if (mode === 'real') {
    assert.equal(eventTypes.includes('todo/write'), true, 'the real model must execute and persist the requested DSH tool call')
    assert.equal(assistantStreamStats.some(stream => stream.textChunks > 1), true,
      `the DSH Session must preserve multiple real model text chunks: ${JSON.stringify(assistantStreamStats)}`)
  }
  const serialized = JSON.stringify(session.events)
  const submittedUserTexts = session.events
    .filter(event => event.type === 'user/message')
    .flatMap(event => event.data.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
  assert.equal(submittedUserTexts.length >= prompts.length + 1, true, 'the DSH Session must preserve every submitted prompt')
  for (const currentPrompt of [...prompts, refreshPrompt]) {
    assert.equal(submittedUserTexts.includes(currentPrompt), true, `the DSH Session must preserve this prompt: ${currentPrompt}`)
  }
  assert.equal(serialized.includes(marker), true, 'the DSH Session must preserve the assistant reply')
  const assistantTexts = session.events
    .filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text.trim())
  if (mode === 'real') {
    assert.equal(eventTypes.filter(type => type === 'turn/end').length >= prompts.length, true, 'the same Session must complete every requested turn')
    assert.equal(assistantTexts.includes(memoryToken), true, 'a later real model turn must recall the token from the first turn')
    assert.equal(assistantTexts.some(text => text.includes(followupMarker) && text.includes(memoryToken)
      && text.includes('Browser-native tool-call E2E proof')), true, 'the final real model turn must retain multi-turn context after the error')
  }
  const contrast = await page.evaluate(measureAssistantUiContrast)
  const measuredContrasts = [
    contrast.pageText,
    contrast.heading,
    ...contrast.messageLabels.map(sample => sample.ratio),
    ...contrast.messageBodies.map(sample => sample.ratio),
    ...contrast.messageParagraphs.map(sample => sample.ratio),
    contrast.composerNote,
    contrast.composerPlaceholder,
    contrast.footer,
    ...contrast.disabledButtons.map(sample => sample.ratio),
  ]
  assert.equal(contrast.messageLabels.length >= 2, true, 'the transcript must render user and assistant labels')
  assert.equal(contrast.messageBodies.length >= 2, true, 'the transcript must render user and assistant text')
  assert.equal(contrast.disabledButtons.length > 0, true, 'the idle UI must render a disabled action')
  assert.equal(measuredContrasts.every(value => value >= 4.5), true, `text contrast must meet AA: ${JSON.stringify(contrast)}`)
  const capturedBrowserRequests = await Promise.all(browserRequests)
  assert.equal(capturedBrowserRequests.some(request => new URL(request.url).pathname === '/api/browser-native/llm'), true)
  assert.equal(capturedBrowserRequests.some(request => new URL(request.url).pathname.endsWith('/session/flush')), true)
  assert.equal(llmStatuses.some(status => status === 200), true, 'the browser-native model route must succeed after the injected error')
  const browserWire = JSON.stringify(capturedBrowserRequests)
  assert.equal(browserWire.includes('authorization'), false, 'the browser must not receive an Authorization header')
  for (const secret of secrets) assert.equal(browserWire.includes(secret), false, 'a provider key reached browser-visible traffic')
  assert.deepEqual(pageErrors, [])

  const durableRecord = JSON.parse(await readFile(join(dataDir, 'sessions', `${sessionId}.json`), 'utf8'))
  assert.equal(durableRecord.durableThroughSeq, durableRecord.events.length - 1)
  assert.equal(JSON.stringify(durableRecord.events).includes(marker), true)
  const durableSession = JSON.stringify(durableRecord.events)
  for (const secret of secrets) assert.equal(durableSession.includes(secret), false, 'a provider key reached the DSH Session log')
  assert.deepEqual([...browserOrigins].filter(value => value !== origin), [], 'the browser must use same-origin routes only')

  assert.equal(sessionOpenStatuses.at(-1), 200, `no Session open request may fail after refresh: ${JSON.stringify(sessionOpenStatuses)}`)
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    mode,
    browser: browserName,
    model: health.model,
    sessionId,
    eventCount: session.events.length,
    durableThroughSeq: durableRecord.durableThroughSeq,
    contrast,
    assistantReplyContainsMarker: true,
    toolCallVisible,
    submittedTurns: prompts.length + 1,
    sameSessionMemoryVerified: mode === 'real',
    injectedFailureRecovered: injectFailure && injectedFailureCount === 1,
    turns: turnEvidence,
    browserConsoleErrors,
    browserHttpErrors,
    backendTurnEnds: session.events.filter(event => event.type === 'turn/end').map(event => ({
      turn: event.data.turn,
      reason: event.data.reason.kind,
    })),
    assistantStreamStats,
    refreshRestoredSameSessionAndContinued: true,
    sessionOpenStatuses,
    sessionCloseStatuses,
    pagehidePersisted,
    ownerChangedAfterRefresh,
    refreshRestoredReply: true,
    browserApiRoutes: [...new Set(capturedBrowserRequests.map(request => new URL(request.url).pathname))],
  })}\n`)
} finally {
  await page?.close()
  await browser?.close()
  await app?.close()
  if (temporaryDataDir) await rm(dataDir, { recursive: true, force: true })
}
