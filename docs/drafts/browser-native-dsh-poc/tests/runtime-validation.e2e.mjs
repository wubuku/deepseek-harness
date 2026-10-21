import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium, webkit } = playwright.default ?? playwright

const mode = process.env.DSH_POC_LLM ?? 'scripted'
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
const envFile = process.env.DSH_POC_ENV_FILE
const roster = process.env.DSH_POC_ROSTER ?? 'browser'
const durableWorkspace = process.env.DSH_POC_DURABLE_WORKSPACE === '1'
const blockWorkspaceCommitOnce = process.env.DSH_POC_BLOCK_WORKSPACE_COMMIT_ONCE === '1'
const skipPostRefreshTurns = process.env.DSH_POC_SKIP_POST_REFRESH_TURNS === '1'
const port = Number(process.env.DSH_POC_PORT ?? '0')
const turnTimeout = Number(process.env.DSH_POC_TURN_TIMEOUT_MS ?? (mode === 'real' ? 600_000 : 40_000))
const refreshCycles = Number(process.env.DSH_POC_REFRESH_CYCLES ?? '1')
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-runtime-e2e-')))
const token = `BROWSER_VFS_${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`
const outputPath = durableWorkspace
  ? '/dsh/home/workspace/browser-validation/output.txt'
  : '/dsh/home/browser-validation/output.txt'
const firstMarker = 'BROWSER_NATIVE_VFS_READY'
const secondMarker = 'BROWSER_NATIVE_VFS_MEMORY_OK'

const localNoProxy = new Set((process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').filter(Boolean))
localNoProxy.add('127.0.0.1')
localNoProxy.add('localhost')
process.env.NO_PROXY = [...localNoProxy].join(',')
process.env.no_proxy = process.env.NO_PROXY

if (!['scripted', 'real'].includes(mode)) throw new Error('DSH_POC_LLM must be scripted or real')
if (!['chromium', 'chrome', 'webkit'].includes(browserName)) throw new Error('DSH_POC_BROWSER must be chromium, chrome, or webkit')
if (!['browser', 'original'].includes(roster)) throw new Error('DSH_POC_ROSTER must be browser or original')
if (mode === 'real' && envFile === undefined) throw new Error('DSH_POC_ENV_FILE is required for real mode')
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')
if (!Number.isInteger(turnTimeout) || turnTimeout < 1_000) throw new Error('DSH_POC_TURN_TIMEOUT_MS must be at least 1000')
if (!Number.isInteger(refreshCycles) || refreshCycles < 1 || refreshCycles > 5) {
  throw new Error('DSH_POC_REFRESH_CYCLES must be an integer from 1 through 5')
}

function requestBody(request) {
  const body = request.postData()
  if (body === null) return undefined
  try { return JSON.parse(body) } catch { return undefined }
}

async function readSecrets(file) {
  if (file === undefined) return []
  const text = await readFile(file, 'utf8')
  return text.split(/\r?\n/)
    .map(line => line.match(/^(OPENAI_NEXT_(?:GPT|GROK)_API_KEY)=(.*)$/)?.[2])
    .filter(value => value !== undefined && value.length > 0)
}

let image
let app
let browser
let page
let origin
const requests = []
const networkRequests = []
const pageErrors = []
const workerErrors = []
const requestFailures = []
let phase = 'setup'
const httpErrors = []
const consoleErrors = []
const llmStatuses = []
let blockedWorkspaceCommit = false
try {
  image = await createRuntimeValidationDist({ roster })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: mode, envFile })
  origin = await app.listen(port)
  const launcher = browserName === 'webkit' ? webkit : chromium
  browser = await launcher.launch({ headless: true, ...(browserName === 'chrome' ? { channel: 'chrome' } : {}) })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  await page.addInitScript(() => {
    const key = 'dsh-browser-native-lifecycle-trace'
    const record = (event, persisted) => {
      const current = JSON.parse(sessionStorage.getItem(key) ?? '[]')
      current.push({ event, persisted, at: Date.now() })
      sessionStorage.setItem(key, JSON.stringify(current))
    }
    window.addEventListener('pagehide', event => record('pagehide', event.persisted), true)
    window.addEventListener('pageshow', event => record('pageshow', event.persisted), true)
  })
  page.on('worker', worker => {
    worker.on('console', message => workerErrors.push({ type: message.type(), text: message.text(), url: worker.url() }))
    worker.on('pageerror', error => workerErrors.push({ type: 'pageerror', message: error.message, stack: error.stack, url: worker.url() }))
  })
  page.on('request', request => networkRequests.push({
    url: request.url(),
    headers: request.headers(),
    body: request.postData(),
  }))
  page.on('request', request => {
    if (request.url().includes('/api/browser-native/')) requests.push({
      path: new URL(request.url()).pathname,
      method: request.method(),
      body: requestBody(request),
      startedAt: Date.now(),
      request,
    })
  })
  page.on('requestfinished', request => {
    const record = requests.find(candidate => candidate.request === request)
    if (record !== undefined) record.finishedAt = Date.now()
  })
  page.on('requestfailed', request => {
    const record = requests.find(candidate => candidate.request === request)
    if (record !== undefined) record.finishedAt = Date.now()
  })
  page.on('pageerror', error => pageErrors.push({ message: error.message, stack: error.stack, phase }))
  page.on('requestfailed', request => requestFailures.push({ url: request.url(), failure: request.failure()?.errorText, phase }))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('response', response => {
    if (response.url().endsWith('/api/browser-native/llm')) llmStatuses.push(response.status())
    const requestRecord = requests.find(request => request.request === response.request())
    if (requestRecord !== undefined) {
      requestRecord.status = response.status()
      requestRecord.settledAt = Date.now()
    }
    if (response.url().includes('/api/browser-native/session/')) {
      const requestId = requestBody(response.request())?.requestId
      const record = requests.find(request => request.body?.requestId === requestId)
      if (record !== undefined) {
        record.settledAt = Date.now()
        record.status = response.status()
      }
    }
    if (response.status() >= 400) httpErrors.push({ path: new URL(response.url()).pathname, status: response.status() })
  })
  if (blockWorkspaceCommitOnce) {
    await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
      if (blockedWorkspaceCommit) return await route.continue()
      blockedWorkspaceCommit = true
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'TEST_COMMIT_BLOCKED', message: 'commit blocked by durable Workspace E2E' } }),
      })
    })
  }

  phase = 'initial preview boot'
  const initialBootStartedAt = Date.now()
  await openPreview(page, `${origin}/preview.html?browser-native=1&${durableWorkspace ? 'browser-native-durable=1&' : ''}preview-fixture=none`)
  const initialBootMs = Date.now() - initialBootStartedAt
  await page.getByText('Browser-native remote', { exact: true }).waitFor({ timeout: 20_000 })

  const firstPrompt = mode === 'real'
    ? `Use exactly this tool sequence and no other tool calls: (1) read /dsh/home/browser-validation/input.txt; (2) write ${outputPath} exactly once with these two lines: token=${token} and result=DSH_VFS_WRITE_OK; do not read or probe ${outputPath} before writing it; (3) read ${outputPath} once to verify it. After all three calls succeed, reply with exactly this marker: ${firstMarker}`
    : `请回复：BROWSER_NATIVE_RUNTIME_VALIDATION_OK ${'stream-check '.repeat(24)}`
  const firstExpected = mode === 'real' ? undefined : 'BROWSER_NATIVE_RUNTIME_VALIDATION_OK'
  phase = 'first turn'
  const first = await sendTurn({
    page,
    origin,
    requests,
    prompt: firstPrompt,
    marker: firstExpected,
    timeout: turnTimeout,
    captureStream: true,
    ...(mode === 'real' ? {
      probeWhileRunning: async ({ page: runningPage, requests: runningRequests, submittedAt, timeout: probeTimeout }) => {
        const request = await waitFor(async () => runningRequests.find(candidate => candidate.path.endsWith('/llm')
          && candidate.startedAt >= submittedAt && candidate.finishedAt === undefined),
        'in-flight LLM request for UI responsiveness probe', Math.min(probeTimeout, 30_000))
        const startedAt = Date.now()
        const stopButton = runningPage.getByRole('button', { name: /^(Stop generating|停止生成)$/ }).last()
        const stopVisible = await stopButton.isVisible()
        const stopEnabled = stopVisible && await stopButton.isEnabled()
        assert.equal(stopEnabled, true, 'Stop must remain enabled during a running LLM request')
        const animationFrameMs = await runningPage.evaluate(() => new Promise(resolveFrame => {
          const frameStartedAt = performance.now()
          requestAnimationFrame(() => resolveFrame(performance.now() - frameStartedAt))
        }))
        return { requestStartedAt: request.startedAt, stopVisible, stopEnabled, animationFrameMs,
          interactionMs: Date.now() - startedAt }
      },
    } : {}),
  })
  if (blockWorkspaceCommitOnce) {
    await waitFor(() => blockedWorkspaceCommit, 'one blocked durable Workspace commit', 30_000)
  }
  if (mode === 'scripted') {
    assert.equal(first.streamSamples.length >= 2, true,
      `expected multiple visible assistant DOM updates during streaming; got ${JSON.stringify(first.streamSamples)}`)
  }
  if (mode === 'real' || refreshCycles > 1) {
    for (let cycle = 1; cycle <= refreshCycles; cycle += 1) {
      phase = `page refresh ${cycle} and Session reconnect`
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForPreview(page)
      await page.getByText(mode === 'real' ? token : 'BROWSER_NATIVE_RUNTIME_VALIDATION_OK', { exact: false }).last().waitFor({ timeout: 20_000 })
    }
  }
  if (blockWorkspaceCommitOnce) {
    await waitFor(() => requests.some(request => request.path.endsWith('/workspace/commit') && request.status === 200),
      'durable Workspace retry commit after Worker reconstruction', 30_000)
  }
  phase = 'post-refresh memory turn'
  const second = mode === 'real' && !skipPostRefreshTurns
    ? await sendTurn({
      page,
      origin,
      requests,
      sessionId: first.sessionId,
      prompt: `What exact token did you write to ${outputPath}? Reply with ${secondMarker} and the token. Do not use another tool.`,
      timeout: turnTimeout,
    })
    : undefined
  let refreshProbe
  if (mode === 'real' && !skipPostRefreshTurns) {
    phase = 'post-refresh VFS probe'
    refreshProbe = await sendTurn({
      page,
      origin,
      requests,
      sessionId: first.sessionId,
      prompt: `Use the read tool to inspect ${outputPath} after the browser Worker was restarted. Do not infer whether the file exists from earlier messages. If the tool reports it missing, say so; if it succeeds, report its exact contents. Finish with ${'BROWSER_VFS_REFRESH_PROBE_DONE'}.`,
      timeout: turnTimeout,
    })
  }

  const session = refreshProbe?.session ?? second?.session ?? first.session
  const llmRequests = requests.filter(request => request.path.endsWith('/llm'))
  const toolNames = [...new Set(llmRequests.flatMap(request => request.body?.tools ?? [])
    .map(tool => tool.function?.name ?? tool.name).filter(name => typeof name === 'string'))]
  if (roster === 'browser') {
    assert.equal(toolNames.includes('bash'), false, `browser roster exposed bash: ${toolNames.join(', ')}`)
    assert.equal(toolNames.includes('web_search'), false, `browser roster exposed web_search: ${toolNames.join(', ')}`)
    assert.equal(toolNames.includes('web_fetch'), false, `browser roster exposed web_fetch: ${toolNames.join(', ')}`)
    assert.equal(toolNames.includes('read'), true, `browser roster did not expose read: ${toolNames.join(', ')}`)
    assert.equal(toolNames.includes('write'), true, `browser roster did not expose write: ${toolNames.join(', ')}`)
  }
  if (mode === 'real') {
    const text = assistantText(session)
    if (!skipPostRefreshTurns) assert.equal(text.includes(token), true, 'the same Session did not retain the VFS token')
    const calls = session.events.filter(event => event.type === 'tool/call' && event.data.turn === 1)
    const results = new Map(session.events.filter(event => event.type === 'tool/result')
      .map(event => [event.data.message?.toolCallId ?? event.data.toolCallId ?? event.data.callId, event]))
    for (const call of calls) {
      const result = results.get(call.data.callId)
      assert.ok(result, `tool result missing for ${call.data.name} call ${call.data.callId}`)
      if (result.data.message?.isError === true) {
        const argumentsValue = JSON.parse(call.data.arguments)
        assert.equal(call.data.name, 'read', 'only a missing-file read probe may fail')
        assert.equal(argumentsValue.file_path, outputPath, 'failed read must probe the output path')
      }
    }
    const callsWithArguments = calls.map(event => ({ event, arguments: JSON.parse(event.data.arguments) }))
    assert.deepEqual(callsWithArguments.map(call => call.event.data.name), ['read', 'write', 'read'],
      'the first turn must complete exactly read → write → read without exploratory tool calls')
    assert.equal(callsWithArguments[0].event.data.name, 'read')
    assert.equal(callsWithArguments[0].arguments.file_path, '/dsh/home/browser-validation/input.txt')
    const writeCalls = callsWithArguments.filter(call => call.event.data.name === 'write')
    assert.equal(writeCalls.length, 1, 'the first turn must write the output file exactly once')
    assert.equal(writeCalls[0].arguments.file_path, outputPath)
    assert.equal(writeCalls[0].arguments.content.includes(token), true)
    assert.equal(writeCalls[0].arguments.content.includes('result=DSH_VFS_WRITE_OK'), true)
    const writeIndex = callsWithArguments.indexOf(writeCalls[0])
    assert.equal(callsWithArguments[writeIndex + 1].event.data.name, 'read')
    assert.equal(callsWithArguments[writeIndex + 1].arguments.file_path, outputPath)
    const firstRead = results.get(callsWithArguments[0].event.data.callId)
    const verificationRead = results.get(callsWithArguments[writeIndex + 1].event.data.callId)
    assert.match(firstRead.data.message.content.map(block => block.text ?? '').join('\n'), /VFS_INPUT_READY/)
    assert.match(verificationRead.data.message.content.map(block => block.text ?? '').join('\n'), new RegExp(token))
    assert.equal(session.events.filter(event => event.type === 'turn/end').length, skipPostRefreshTurns ? 1 : 3)
    if (!skipPostRefreshTurns) {
      assert.equal(session.events.filter(event => event.type === 'tool/call' && event.data.turn === 2).length, 0,
        'the second turn should recover the token from Session context without another VFS call')
      assert.equal(text.includes(token), true, 'the second turn must recall the VFS token from Session context')
      const refreshRead = session.events.filter(event => event.type === 'tool/call' && event.data.turn === 3 && event.data.name === 'read')
      assert.equal(refreshRead.length >= 1, true, 'the post-refresh probe must use DSH read against the same VFS path')
      const refreshReadResult = results.get(refreshRead[0].data.callId)
      const refreshReadText = refreshReadResult.data.message.content.map(block => block.text ?? '').join('\n')
      const vfsFileAfterRefresh = refreshReadResult.data.message.isError ? 'missing' : 'available'
      if (vfsFileAfterRefresh === 'missing') assert.match(refreshReadText, /not found/)
      else assert.match(refreshReadText, new RegExp(token))
    }
  }
  assert.equal(llmStatuses.every(status => status === 200), true, JSON.stringify(llmStatuses))
  assert.deepEqual(pageErrors, [], `unexpected page errors: ${JSON.stringify(pageErrors)}`)
  assert.deepEqual(consoleErrors.filter(error => error.includes('web-preview tunnel: boot payload failed')), [],
    `unexpected Worker tunnel boot errors: ${JSON.stringify(consoleErrors)}`)
  const wire = JSON.stringify(requests)
  const browserWire = JSON.stringify(networkRequests)
  for (const secret of await readSecrets(envFile)) {
    assert.equal(wire.includes(secret), false)
    assert.equal(browserWire.includes(secret), false, 'provider secret appeared in browser network traffic')
  }
  const llmRequestOrigins = [...new Set(networkRequests
    .filter(request => new URL(request.url).pathname === '/api/browser-native/llm')
    .map(request => new URL(request.url).origin))]
  assert.deepEqual(llmRequestOrigins, [origin], 'LLM traffic must use the same-origin backend proxy')
  if (durableWorkspace) {
    assert.equal(requests.some(request => request.path.endsWith('/workspace/identity')), true,
      'durable Workspace mode must open the same-origin Workspace identity')
    assert.equal(requests.some(request => request.path.endsWith('/workspace/commit')), true,
      'durable Workspace mode must commit the DSH file mutation')
  }
  if (blockWorkspaceCommitOnce) {
    assert.equal(requests.some(request => request.path.endsWith('/workspace/commit') && request.status === 503), true,
      'fault injection must produce one failed Workspace commit')
    assert.equal(requests.filter(request => request.path.endsWith('/workspace/commit') && request.status === 200).length >= 1, true,
      'Worker reconstruction must retry the durable Workspace commit')
  }
  const durable = JSON.parse(await readFile(join(dataDir, 'sessions', `${first.sessionId}.json`), 'utf8'))
  assert.equal(durable.durableThroughSeq, durable.events.length - 1)
  const firstTurnFlushes = requests.filter(request => request.path.endsWith('/session/flush')
    && request.startedAt >= first.submittedAt && request.startedAt <= first.settledAt && request.settledAt !== undefined)
  const firstTextChunkAt = session.events
    .filter(event => event.type === 'assistant/message' && event.data.turn === 1)
    .flatMap(event => event.data.stream.filter(record => record.type === 'text-chunks').map(record => record.time0))
    .sort((left, right) => left - right)[0]
  process.stdout.write(`${JSON.stringify({
    mode,
    browser: browserName,
    roster,
    durableWorkspace,
    blockedWorkspaceCommit,
    workspaceCommitStatuses: requests.filter(request => request.path.endsWith('/workspace/commit')).map(request => request.status),
    model: app.llm.model,
    sessionId: first.sessionId,
    eventCount: session.events.length,
    durableThroughSeq: durable.durableThroughSeq,
    toolNames,
    vfsToolSequence: mode === 'real'
      ? session.events.filter(event => event.type === 'tool/call' && event.data.turn === 1).map(event => event.data.name)
      : [],
    vfsFileAfterRefresh: mode === 'real' && !skipPostRefreshTurns
      ? (() => {
        const call = session.events.find(event => event.type === 'tool/call' && event.data.turn === 3 && event.data.name === 'read')
        const result = session.events.find(event => event.type === 'tool/result'
          && (event.data.message?.toolCallId ?? event.data.toolCallId ?? event.data.callId) === call.data.callId)
        return result.data.message.isError ? 'missing' : 'available'
      })()
      : null,
    refreshedBetweenRealTurns: mode === 'real',
    skipPostRefreshTurns,
    refreshCycles: mode === 'real' ? refreshCycles : 0,
    assistantStreamStats: session.events.filter(event => event.type === 'assistant/message').map(event => ({
      turn: event.data.turn,
      step: event.data.step,
      textChunks: event.data.stream.filter(record => record.type === 'text-chunks')
        .reduce((sum, record) => sum + record.texts.length, 0),
      streamSpanMs: event.data.stream.filter(record => record.type === 'text-chunks')
        .reduce((sum, record) => sum + record.dt.reduce((total, gap) => total + gap, 0), 0),
    })),
    runtimeTimings: {
      initialBootMs,
      firstTurnSettlementMs: first.elapsedMs,
      firstVisibleAssistantUpdateMs: first.streamSamples[0]?.elapsedMs ?? null,
      firstSessionTextChunkMs: firstTextChunkAt === undefined ? null : firstTextChunkAt - first.submittedAt,
      firstTurnFlushRequests: firstTurnFlushes.map(request => ({
        afterSubmitMs: request.startedAt - first.submittedAt,
        durationMs: request.settledAt - request.startedAt,
        status: request.status,
      })),
    },
    runningUiResponsiveness: first.runningProbe ?? null,
    pageLifecycle: await page.evaluate(() => JSON.parse(sessionStorage.getItem('dsh-browser-native-lifecycle-trace') ?? '[]')),
    workerErrors,
    visibleDomStreamSamples: first.streamSamples.length,
    browserNetworkRequestCount: networkRequests.length,
    llmRequestOrigins,
    llmRequestSummaries: llmRequests.map(request => ({
      messageCount: request.body?.messages?.length ?? null,
      toolNames: request.body?.tools?.map(tool => tool.function?.name ?? tool.name).filter(Boolean) ?? [],
    })),
    pageErrors,
    requestFailures,
    consoleErrors,
    httpErrors,
    llmStatuses,
  })}\n`)
} catch (error) {
  const sessionId = requests.find(request => request.path.endsWith('/session/create'))?.body.sessionId
  const latest = sessionId ? await sessionRequest(origin, 'read', { sessionId, offset: 0 }) : undefined
  process.stderr.write(`${JSON.stringify({ failure: error.message, llmStatuses, pageErrors, workerErrors, consoleErrors, httpErrors,
    events: latest?.events?.filter(event => ['tool/call', 'tool/result', 'assistant/attempt', 'step/end', 'turn/end'].includes(event.type)),
    assistantText: latest?.events ? assistantText(latest) : undefined,
    pageLifecycle: page ? await page.evaluate(() => JSON.parse(sessionStorage.getItem('dsh-browser-native-lifecycle-trace') ?? '[]')) : [],
    pageText: page ? (await page.locator('body').innerText()).slice(-3000) : undefined,
  })}\n`)
  throw error
} finally {
  await page?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
