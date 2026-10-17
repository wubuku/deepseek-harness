import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as createTcpServer } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createBrowserNativeV2Server } from '../../browser-native-dsh-poc/backend-v2.mjs'
import { measureAssistantUiContrast } from './color-contrast.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../../../..')
const mode = 'real'
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
if (proxy !== undefined && !process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
  throw new Error('Safari real E2E with an HTTP proxy requires Node 24 environment proxy support')
}
if (proxy !== undefined && !process.execArgv.includes('--use-env-proxy')
  && process.env.BROWSER_NATIVE_PROXY_REEXEC !== '1') {
  const noProxy = new Set((process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').filter(Boolean))
  noProxy.add('127.0.0.1')
  noProxy.add('localhost')
  const result = spawnSync(process.execPath, [
    '--use-env-proxy',
    ...process.execArgv,
    import.meta.filename,
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

const configuredEnvFile = process.env.DSH_ASSISTANT_UI_POC_ENV_FILE
const envFile = resolve(configuredEnvFile ?? join(repositoryRoot, 'docs/drafts/.env'))
const temporaryDataDir = process.env.DSH_ASSISTANT_UI_POC_DATA_DIR === undefined
const dataDir = resolve(process.env.DSH_ASSISTANT_UI_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-assistant-ui-safari-')))
const distRoot = resolve(process.env.DSH_ASSISTANT_UI_POC_DIST_ROOT ?? join(repositoryRoot, 'apps/web/dist'))
const configuredOrigin = process.env.DSH_ASSISTANT_UI_POC_ORIGIN
const externalOrigin = configuredOrigin === undefined ? undefined : new URL(configuredOrigin).origin
if (externalOrigin !== undefined && temporaryDataDir) {
  throw new Error('External-origin Safari E2E requires DSH_ASSISTANT_UI_POC_DATA_DIR for that backend')
}
const marker = 'ASSISTANT_UI_BROWSER_NATIVE_E2E_OK'
const memoryToken = `DSH_MEMORY_${randomUUID().replaceAll('-', '').toUpperCase()}`
const failurePrompt = 'Safari recovery test: return a reply mentioning this prompt.'
const recoveryMarker = 'SAFARI_FAILURE_RECOVERY_OK'
const refreshPrompt = 'Reply with exactly this marker: SAFARI_REFRESH_CONTINUATION_OK'
const refreshMarker = 'SAFARI_REFRESH_CONTINUATION_OK'
const injectFailure = externalOrigin === undefined
const prompts = [
  `Use the todo_write tool to add exactly one pending task titled "Browser-native tool-call E2E proof". Remember this exact token for my next message: ${memoryToken}. After the tool succeeds, reply with exactly this marker: ${marker}`,
  'What exact token did I ask you to remember? Reply with only the token, no quotes or explanation.',
  ...(injectFailure
    ? [failurePrompt, `A prior model request failed. Continue and reply with exactly this marker: ${recoveryMarker}`]
    : [`Reply with exactly this marker: ${recoveryMarker}`]),
]

async function availablePort() {
  const server = createTcpServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  const { port } = address
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return port
}

async function webdriverRequest(baseUrl, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const envelope = await response.json()
  const value = envelope.value
  if (!response.ok || value?.error !== undefined) {
    throw new Error(`Safari WebDriver ${method} ${path} failed: ${JSON.stringify(envelope)}`)
  }
  return value
}

async function execute(baseUrl, sessionId, script, args = []) {
  return webdriverRequest(baseUrl, 'POST', `/session/${sessionId}/execute/sync`, { script, args })
}

async function waitForCondition(baseUrl, sessionId, script, label, timeoutMs, allowVisibleError = false) {
  const deadline = Date.now() + timeoutMs
  let lastValue
  while (Date.now() < deadline) {
    lastValue = await execute(baseUrl, sessionId, script)
    if (lastValue) return
    const errorText = await execute(baseUrl, sessionId,
      'return document.querySelector("[data-testid=assistant-ui-error]")?.textContent ?? null')
    if (errorText !== null && !allowVisibleError) throw new Error(`${label} failed in Safari: ${errorText}`)
    await delay(250)
  }
  throw new Error(`${label} timed out in Safari; last value: ${JSON.stringify(lastValue)}`)
}

async function resetLiveTextTrace(baseUrl, sessionId) {
  await execute(baseUrl, sessionId, `(() => {
    window.__dshSafariLiveTextObserver?.disconnect()
    window.__dshSafariLiveTextTrace = []
    const capture = () => {
      for (const row of document.querySelectorAll('[data-dsh-live="true"]')) {
        const text = row.querySelector('.message-body')?.textContent?.trim() ?? ''
        if (text.length === 0) continue
        const trace = window.__dshSafariLiveTextTrace
        if (trace.at(-1) !== text) trace.push(text)
      }
    }
    const observer = new MutationObserver(capture)
    observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true })
    window.__dshSafariLiveTextObserver = observer
    capture()
    return true
  })()`)
}

async function findElement(baseUrl, sessionId, selector) {
  const result = await webdriverRequest(baseUrl, 'POST', `/session/${sessionId}/element`, {
    using: 'css selector',
    value: selector,
  })
  const elementId = result['element-6066-11e4-a52e-4f735466cecf'] ?? result.ELEMENT
  assert.equal(typeof elementId, 'string', `Safari could not find ${selector}`)
  return elementId
}

async function submitPrompt(baseUrl, sessionId, prompt) {
  const inputId = await findElement(baseUrl, sessionId, '[data-testid="assistant-ui-input"]')
  const sendId = await findElement(baseUrl, sessionId, '[data-testid="assistant-ui-send"]')
  await webdriverRequest(baseUrl, 'POST', `/session/${sessionId}/element/${inputId}/value`, {
    text: prompt,
    value: [...prompt],
  })
  let inputState = await execute(baseUrl, sessionId, `return (() => {
    const input = document.querySelector('[data-testid="assistant-ui-input"]');
    const send = document.querySelector('[data-testid="assistant-ui-send"]');
    return { value: input.value, sendDisabled: send.disabled };
  })()`)
  assert.equal(inputState.value, prompt, 'Safari must place the complete prompt in the composer')
  if (inputState.sendDisabled) {
    inputState = await execute(baseUrl, sessionId, `return (() => {
      const input = document.querySelector('[data-testid="assistant-ui-input"]');
      const send = document.querySelector('[data-testid="assistant-ui-send"]');
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(input, ${JSON.stringify(prompt)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { value: input.value, sendDisabled: send.disabled };
    })()`)
  }
  assert.equal(inputState.value, prompt, 'Safari must retain the composer prompt after its input event')
  await waitForCondition(
    baseUrl,
    sessionId,
    'return document.querySelector("[data-testid=assistant-ui-send]")?.disabled === false',
    'Safari composer submission readiness',
    5_000,
  )
  await webdriverRequest(baseUrl, 'POST', `/session/${sessionId}/element/${sendId}/click`)
  await waitForCondition(
    baseUrl,
    sessionId,
    `return [...document.querySelectorAll('[data-role="user"]')].some(node => node.textContent.includes(${JSON.stringify(prompt)}))`,
    'Safari user-message submission',
    15_000,
  )
}

async function waitForAssistantStream(baseUrl, sessionId, expectedText, timeoutMs, allowVisibleError = false) {
  const deadline = Date.now() + timeoutMs
  const startedAt = Date.now()
  const snapshots = []
  let firstPartialAt
  let lastState
  while (Date.now() < deadline) {
    lastState = await execute(baseUrl, sessionId, `return (() => {
      const liveTexts = [...document.querySelectorAll('[data-dsh-live="true"]')]
        .map(row => row.querySelector('.message-body')?.textContent?.trim() ?? '')
        .filter(text => text.length > 0);
      const tracedTexts = window.__dshSafariLiveTextTrace ?? [];
      const rows = [...document.querySelectorAll('[data-role="assistant"]:not([data-dsh-live="true"])')];
      const finalTexts = rows
        .map(row => row.querySelector('.message-body')?.textContent?.trim() ?? '')
        .filter(text => text.length > 0);
      return {
        liveTexts,
        tracedTexts,
        finalTexts,
        finalText: finalTexts.find(text => text.includes(${JSON.stringify(expectedText)})) ?? finalTexts.at(-1) ?? '',
        errorText: document.querySelector('[data-testid="assistant-ui-error"]')?.textContent ?? null,
      };
    })()`)
    for (const text of [...lastState.tracedTexts, ...lastState.liveTexts]) {
      if (snapshots[snapshots.length - 1] !== text) {
        snapshots.push(text)
        firstPartialAt ??= Date.now()
      }
    }
    if (lastState.finalText.includes(expectedText)) {
      const distinctSnapshots = [...new Set(snapshots)]
      return {
        snapshotCount: distinctSnapshots.length,
        partialSnapshots: distinctSnapshots.filter(text => text.length < lastState.finalText.length).length,
        snapshotLengths: distinctSnapshots.map(text => text.length),
        elapsedMs: Date.now() - startedAt,
        partialVisibleBeforeCompletionMs: firstPartialAt === undefined ? 0 : Date.now() - firstPartialAt,
        finalContainsExpected: true,
      }
    }
    if (lastState.errorText !== null && !allowVisibleError) {
      throw new Error(`Safari model response failed: ${lastState.errorText}`)
    }
    await delay(75)
  }
  throw new Error(`Safari assistant reply timed out: ${JSON.stringify({ lastState, snapshotLengths: snapshots.map(text => text.length) })}`)
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
    await delay(200)
  }
  throw new Error(`Safari Session did not complete: ${JSON.stringify(latest?.events?.map(event => event.type) ?? [])}`)
}

let app
let driver
let driverSessionId
let driverUrl
let driverLogs = ''
let injectedFailureCount = 0

try {
  let origin = externalOrigin
  if (origin === undefined) {
    app = await createBrowserNativeV2Server({
      dataDir,
      distRoot,
      llmMode: mode,
      envFile,
      testHooks: {
        failLlmRequest(body) {
          if (injectFailure && injectedFailureCount === 0 && JSON.stringify(body.messages).includes(failurePrompt)) {
            injectedFailureCount += 1
            return true
          }
          return false
        },
      },
    })
    await app.listen(0)
    const address = app.server.address()
    assert.notEqual(address, null)
    assert.equal(typeof address, 'object')
    origin = `http://127.0.0.1:${address.port}`
  }
  const healthResponse = await fetch(`${origin}/api/browser-native/health`)
  assert.equal(healthResponse.ok, true)
  const health = await healthResponse.json()
  assert.equal(health.llmMode, mode)

  const driverPort = await availablePort()
  driverUrl = `http://127.0.0.1:${driverPort}`
  driver = spawn('safaridriver', ['--port', String(driverPort)], { stdio: ['ignore', 'pipe', 'pipe'] })
  driver.stdout.setEncoding('utf8').on('data', chunk => { driverLogs += chunk })
  driver.stderr.setEncoding('utf8').on('data', chunk => { driverLogs += chunk })
  const driverDeadline = Date.now() + 30_000
  while (Date.now() < driverDeadline) {
    if (driver.exitCode !== null) throw new Error(`safaridriver exited: ${driverLogs}`)
    try {
      const status = await fetch(`${driverUrl}/status`)
      if (status.ok && (await status.json()).value?.ready === true) break
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
    }
    await delay(200)
  }
  const readyResponse = await fetch(`${driverUrl}/status`)
  assert.equal(readyResponse.ok, true, `safaridriver did not start: ${driverLogs}`)
  assert.equal((await readyResponse.json()).value?.ready, true, `safaridriver is not ready: ${driverLogs}`)

  const capabilities = await webdriverRequest(driverUrl, 'POST', '/session', {
    capabilities: { alwaysMatch: { browserName: 'Safari' } },
  })
  driverSessionId = capabilities.sessionId
  assert.equal(typeof driverSessionId, 'string')
  const safariVersion = capabilities.capabilities.browserVersion

  await webdriverRequest(driverUrl, 'POST', `/session/${driverSessionId}/url`, {
    url: `${origin}/assistant-ui-poc/index.html`,
  })
  await waitForCondition(
    driverUrl,
    driverSessionId,
    'return document.querySelector("[data-testid=assistant-ui-ready]") !== null',
    'assistant-ui initialization',
    60_000,
  )
  await resetLiveTextTrace(driverUrl, driverSessionId)
  const timeoutMs = 240_000
  const turnEvidence = []
  const pageUrl = await execute(driverUrl, driverSessionId, 'return location.href')
  const sessionId = new URL(pageUrl).searchParams.get('sessionId')
  assert.equal(typeof sessionId, 'string', 'Safari URL must retain the DSH Session id')
  for (let index = 0; index < prompts.length; index += 1) {
    const prompt = prompts[index]
    const isInjectedFailure = injectFailure && index === 2
    const expectedReply = index === 0 ? marker : index === 1 ? memoryToken : recoveryMarker
    assert.notEqual(prompt, undefined)
    await resetLiveTextTrace(driverUrl, driverSessionId)
    await submitPrompt(driverUrl, driverSessionId, prompt)
    let turn
    if (isInjectedFailure) {
      turn = await waitForSession(origin, sessionId, index + 1, timeoutMs)
      const failedTurn = turn.events.filter(event => event.type === 'turn/end').at(-1)
      assert.equal(failedTurn?.data.reason.kind, 'error', 'Safari must record the controlled provider failure')
      assert.equal(turn.events.some(event => event.type === 'assistant/attempt' && event.data.turn === failedTurn.data.turn), true,
        'Safari must persist the failed DSH attempt')
      await waitForCondition(
        driverUrl,
        driverSessionId,
        'return document.querySelector("[data-testid=assistant-ui-error]") !== null',
        'Safari visible model error',
        15_000,
      )
      turnEvidence.push({ turn: index + 1, outcome: 'error', visibleError: true })
      continue
    }
    const stream = await waitForAssistantStream(
      driverUrl,
      driverSessionId,
      expectedReply,
      timeoutMs,
      index > 2 && injectFailure,
    )
    turn = await waitForSession(origin, sessionId, index + 1, timeoutMs)
    const assistantEvent = [...turn.events].reverse().find(event => event.type === 'assistant/message')
    const durableTextChunks = assistantEvent?.data.stream
      .filter(record => record.type === 'text-chunks')
      .reduce((sum, record) => sum + record.texts.length, 0) ?? 0
    assert.equal(stream.snapshotCount >= 1 || durableTextChunks > 1, true,
      `Safari must expose progressive UI text or durable text chunks: ${JSON.stringify({ stream, durableTextChunks })}`)
    assert.equal(stream.finalContainsExpected, true, 'Safari must render the expected completed reply')
    turnEvidence.push({ turn: index + 1, outcome: 'completed', stream, durableTextChunks })
  }
  const session = await waitForSession(origin, sessionId, prompts.length, timeoutMs)
  const eventTypes = session.events.map(event => event.type)
  assert.equal(eventTypes.includes('user/message'), true, 'the DSH Session must contain the submitted user message')
  assert.equal(eventTypes.includes('assistant/message'), true, 'the DSH Session must contain the DSH Agent reply')
  assert.equal(eventTypes.includes('turn/end'), true, 'the DSH Agent turn must finish')
  assert.equal(eventTypes.filter(type => type === 'turn/end').length >= prompts.length, true, 'the same Session must complete every successful or failed turn')
  assert.equal(eventTypes.includes('todo/write'), true, 'the real model must execute and persist the requested DSH tool call')
  if (injectFailure) {
    assert.equal(injectedFailureCount, 1, 'Safari must execute the one-shot failure injection exactly once')
    assert.equal(session.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'error'), true,
      'Safari must preserve a failed turn before a successful retry')
  }
  const userTexts = session.events
    .filter(event => event.type === 'user/message')
    .flatMap(event => event.data.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
  assert.equal(prompts.every(prompt => userTexts.includes(prompt)), true, 'the DSH Session must preserve every prompt')
  assert.equal(JSON.stringify(session.events).includes(marker), true, 'the DSH Session must preserve the assistant reply')
  const assistantTexts = session.events
    .filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text.trim())
  assert.equal(assistantTexts.includes(memoryToken), true, 'the second real model turn must recall the token from the first turn')
  const contrast = await execute(driverUrl, driverSessionId, `return (${measureAssistantUiContrast.toString()})()`)
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

  await webdriverRequest(driverUrl, 'POST', `/session/${driverSessionId}/refresh`)
  await waitForCondition(
    driverUrl,
    driverSessionId,
    'return document.querySelector("[data-testid=assistant-ui-ready]") !== null',
    'Safari Session restore after refresh',
    60_000,
  )
  await waitForCondition(
    driverUrl,
    driverSessionId,
    `return [...document.querySelectorAll('[data-role="assistant"]')].some(node => node.textContent.includes(${JSON.stringify(marker)}))`,
    'Safari restored assistant reply',
    60_000,
  )
  const restoredSessionId = new URL(await execute(driverUrl, driverSessionId, 'return location.href')).searchParams.get('sessionId')
  assert.equal(restoredSessionId, sessionId, 'refresh must retain the same DSH Session')
  await resetLiveTextTrace(driverUrl, driverSessionId)
  await submitPrompt(driverUrl, driverSessionId, refreshPrompt)
  const refreshStream = await waitForAssistantStream(
    driverUrl,
    driverSessionId,
    refreshMarker,
    timeoutMs,
  )
  const finalSession = await waitForSession(origin, sessionId, prompts.length + 1, timeoutMs)
  const refreshAssistantEvent = [...finalSession.events].reverse().find(event => event.type === 'assistant/message')
  const refreshDurableTextChunks = refreshAssistantEvent?.data.stream
    .filter(record => record.type === 'text-chunks')
    .reduce((sum, record) => sum + record.texts.length, 0) ?? 0
  assert.equal(refreshStream.snapshotCount >= 1 || refreshDurableTextChunks > 1, true,
    `Safari post-refresh reply must expose progressive UI text or durable text chunks: ${JSON.stringify({ refreshStream, refreshDurableTextChunks })}`)
  turnEvidence.push({
    turn: prompts.length + 1,
    outcome: 'completed-after-refresh',
    stream: refreshStream,
    durableTextChunks: refreshDurableTextChunks,
  })
  assert.equal(finalSession.events.some(event => event.type === 'user/message'
    && event.data.content?.some(block => block.type === 'text' && block.text === refreshPrompt)), true,
  'the post-refresh user message must reach the same DSH Session')
  assert.equal(JSON.stringify(finalSession.events).includes(refreshMarker), true,
    'the post-refresh assistant reply must be durable in the same DSH Session')
  const durableRecord = JSON.parse(await readFile(join(dataDir, 'sessions', `${sessionId}.json`), 'utf8'))
  assert.equal(durableRecord.durableThroughSeq, durableRecord.events.length - 1)
  assert.equal(JSON.stringify(durableRecord.events).includes(refreshMarker), true)

  process.stdout.write(`${JSON.stringify({
    mode,
    browser: 'safari',
    browserVersion: safariVersion,
    model: health.model,
    sessionId,
    eventCount: finalSession.events.length,
    durableThroughSeq: durableRecord.durableThroughSeq,
    contrast,
    todoWritePersisted: true,
    assistantReplyContainsMarker: true,
    submittedTurns: prompts.length + 1,
    sameSessionMemoryVerified: true,
    failureRecovered: injectFailure,
    refreshRestoredSameSessionAndContinued: true,
    safariStreamingVerified: true,
    turns: turnEvidence,
    backendTurnEnds: finalSession.events.filter(event => event.type === 'turn/end').map(event => ({
      turn: event.data.turn,
      reason: event.data.reason.kind,
    })),
    assistantStreamStats: finalSession.events.filter(event => event.type === 'assistant/message').map(event => ({
      turn: event.data.turn,
      step: event.data.step,
      textChunks: event.data.stream.filter(record => record.type === 'text-chunks').reduce((sum, record) => sum + record.texts.length, 0),
      streamSpanMs: event.data.stream.filter(record => record.type === 'text-chunks')
        .reduce((sum, record) => sum + record.dt.reduce((total, gap) => total + gap, 0), 0),
    })),
  })}\n`)
} catch (error) {
  if (driverLogs.length > 0) process.stderr.write(`safaridriver: ${driverLogs}\n`)
  throw error
} finally {
  if (driverSessionId !== undefined && driverUrl !== undefined) {
    await webdriverRequest(driverUrl, 'DELETE', `/session/${driverSessionId}`).catch(error => {
      process.stderr.write(`Safari WebDriver session cleanup failed: ${String(error)}\n`)
    })
  }
  if (driver !== undefined) {
    driver.kill('SIGTERM')
    await new Promise(resolveExit => {
      if (driver.exitCode !== null) resolveExit()
      else driver.once('exit', resolveExit)
    })
  }
  await app?.close()
  if (temporaryDataDir) await rm(dataDir, { recursive: true, force: true })
}
