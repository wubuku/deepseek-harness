import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const scenarios = [
  { marker: 'BROWSER_NATIVE_COMPACTION_PRESSURE_E2E', contextWindow: 4096, longPrompt: true },
  { marker: 'BROWSER_NATIVE_COMPACTION_SUMMARY_FAILURE_E2E', summaryFailure: true },
  { marker: 'BROWSER_NATIVE_COMPACTION_END_APPEND_503_E2E', failCloseAppend: true },
]
const sentinel = 'BROWSER_NATIVE_COMPACTION_SENTINEL_6F31A2'
let image
let browser
const outcomes = []

function contentText(event) {
  const content = event.data?.message?.content ?? event.data?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

function markerInRequest(body, marker) {
  return (body.messages ?? []).some(message => message.role === 'user'
    && typeof message.content === 'string' && message.content.includes(marker))
}

async function runScenario(scenario) {
  const dataDir = resolve(await mkdtemp(join(tmpdir(), 'dsh-browser-compaction-e2e-')))
  let app
  let context
  let page
  const requests = []
  const configs = []
  const pageErrors = []
  const externalRequests = []
  let overflowFailures = 0
  let closeAppendFailures = 0
  let summaryFailures = 0
  let ownerToken
  try {
    app = await createBrowserNativeV2Server({
      dataDir,
      distRoot: image.distRoot,
      llmMode: 'scripted',
      ...(scenario.contextWindow === undefined ? {} : { contextWindow: scenario.contextWindow }),
      testHooks: {
        scriptedLlmFault: body => {
          if (body.purpose === 'compaction' && scenario.summaryFailure && summaryFailures === 0) {
            summaryFailures += 1
            return { kind: 'partial-text', text: 'PARTIAL_COMPACTION_SUMMARY' }
          }
          if (body.purpose === undefined && markerInRequest(body, scenario.marker)
            && body.messages.some(message => message.role === 'tool') && overflowFailures === 0) {
            overflowFailures += 1
            return { kind: 'error', code: 'CONTEXT_WINDOW_EXCEEDED', message: 'injected model context overflow' }
          }
          return undefined
        },
        failSessionAppend: body => {
          if (scenario.failCloseAppend && closeAppendFailures === 0
            && body.events?.some(event => event.type === 'compaction/end')) {
            closeAppendFailures += 1
            return true
          }
          return false
        },
      },
    })
    const origin = await app.listen(0)
    context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
    page = await context.newPage()
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin !== origin) externalRequests.push(request.url())
      if (!url.pathname.startsWith('/api/browser-native/')) return
      let body = {}
      try { body = request.postDataJSON() ?? {} } catch {}
      requests.push({ path: url.pathname, body })
    })
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname
      if (pathname === '/api/browser-native/config') {
        void response.json().then(config => configs.push(config))
      }
      if (pathname.endsWith('/session/create') || pathname.endsWith('/session/open')) {
        void response.json().then(payload => {
          if (typeof payload.owner?.ownerToken === 'string') ownerToken = payload.owner.ownerToken
        })
      }
    })

    await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
    const pressureContext = scenario.longPrompt
      ? `\n${'Browser-native context pressure preserves this exact historical fact. '.repeat(1200)}`
      : ''
    const prompt = `${scenario.marker}\nRemember the exact identifier ${sentinel}. Read the large Browser VFS fixture and then report completion.${pressureContext}`
    const turn = await sendTurn({
      page,
      origin,
      requests,
      prompt,
      marker: `${scenario.marker}_DONE`,
      timeout: 120_000,
    })
    ownerToken = await waitFor(() => ownerToken, 'Session write owner receipt')
    const flush = await sessionRequest(origin, 'flush', { sessionId: turn.sessionId, ownerToken })
    assert.equal(flush.status, 200)
    const beforeReload = await sessionRequest(origin, 'read', { sessionId: turn.sessionId, offset: 0 })
    assert.equal(beforeReload.status, 200)
    assert.equal(flush.durableThroughSeq, beforeReload.events.length - 1,
      'the completed compaction and tool result must be durable before refresh')

    const events = beforeReload.events
    const toolCalls = events.filter(event => event.type === 'tool/call' && event.data.name === 'read')
    const rawResult = events.find(event => event.type === 'tool/result'
      && event.data.message?.toolCallId === toolCalls[0]?.data.callId)
    assert.equal(toolCalls.length, 1, 'context overflow recovery must not repeat the read side effect')
    assert.ok(rawResult, 'the DSH Session must retain the read result event')
    assert.ok(contentText(rawResult).includes('BROWSER_NATIVE_LARGE_TOOL_RESULT_MIDDLE_SENTINEL'))

    const pruneEvents = events.filter(event => event.type === 'compaction/prune')
    const summaries = events.filter(event => event.type === 'compaction/summary')
    const ends = events.filter(event => event.type === 'compaction/end')
    assert.ok(pruneEvents.length > 0, 'large tool result must be pruned through DSH compaction')
    assert.equal(overflowFailures, 1, 'the context-overflow request must be injected once')
    if (scenario.summaryFailure) {
      assert.equal(summaryFailures, 1)
      assert.equal(summaries.length, 0, 'a partial auxiliary response must not be recorded as a successful summary')
      assert.equal(ends.length, 1)
      assert.ok(ends[0].data.error !== undefined, 'failed auxiliary summary must close with an error')
    } else {
      assert.ok(summaries.length > 0, `the DSH compactor must create a durable summary; events=${events.map(event => event.type).join(',')}; endErrors=${JSON.stringify(ends.map(event => event.data.error ?? null))}; purposes=${JSON.stringify(requests.filter(request => request.path.endsWith('/llm')).map(request => request.body.purpose ?? 'conversation'))}`)
      assert.equal(ends.length, summaries.length, 'each successful summary must have exactly one closing event')
    }
    if (scenario.longPrompt) {
      assert.ok(events.some(event => event.type === 'compaction/start'), 'small declared context must trigger automatic pressure compaction')
      assert.equal(configs.some(config => config.contextWindow === 4096), true,
        'Worker must consume backend-declared model capacity')
      assert.equal(configs.every(config => !JSON.stringify(config).includes('apiKey')
        && !JSON.stringify(config).includes('baseUrl')), true, 'model configuration must not expose credentials or upstream URLs')
    }
    if (scenario.summaryFailure) {
      assert.ok(events.some(event => event.type === 'assistant/message' && event.data.turn === turn.turn),
        'durable pruning must let the original turn recover after auxiliary summary failure')
    }
    if (scenario.failCloseAppend) assert.equal(closeAppendFailures, 1)

    const normalRequestsAfterTool = requests.filter(request => request.path.endsWith('/llm')
      && request.body.purpose === undefined
      && request.body.messages?.some(message => message.role === 'tool'))
    assert.ok(normalRequestsAfterTool.some(request => !JSON.stringify(request.body.messages)
      .includes('BROWSER_NATIVE_LARGE_TOOL_RESULT_MIDDLE_SENTINEL')),
    'the resumed model request must receive the compacted surface, not the middle of the raw tool result')
    assert.equal(requests.filter(request => request.path.endsWith('/workspace/commit')).length, 0,
      'read-only recovery must not create a Workspace revision')

    const llmCountBeforeReload = requests.filter(request => request.path.endsWith('/llm')).length
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForPreview(page)
    await page.getByText(`${scenario.marker}_DONE`, { exact: false }).last().waitFor({ timeout: 30_000 })
    const afterReload = await sessionRequest(origin, 'read', { sessionId: turn.sessionId, offset: 0 })
    assert.deepEqual(afterReload.events.slice(0, events.length), events)
    assert.equal(requests.filter(request => request.path.endsWith('/llm')).length, llmCountBeforeReload,
      'refresh must hydrate the compacted Session without replaying a model request')

    const continuation = await sendTurn({
      page,
      origin,
      requests,
      sessionId: turn.sessionId,
      prompt: 'BROWSER_NATIVE_SCRIPTED_E2E_OK continue after compaction and refresh.',
      marker: 'BROWSER_NATIVE_SCRIPTED_E2E_OK',
      timeout: 60_000,
    })
    assert.equal(continuation.sessionId, turn.sessionId)
    assert.equal(continuation.session.events.filter(event => event.type === 'tool/call'
      && event.data.name === 'read').length, 1)
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(externalRequests, [])
    outcomes.push({
      scenario: scenario.marker,
      sessionId: turn.sessionId,
      eventCount: events.length,
      durableThroughSeq: beforeReload.durableThroughSeq,
      pruneCount: pruneEvents.length,
      summaryCount: summaries.length,
      summaryFailureCount: summaryFailures,
      closeAppendFailureCount: closeAppendFailures,
      llmCountBeforeReload,
      continuedTurn: continuation.turn,
      pageErrors,
      externalRequestCount: externalRequests.length,
    })
  } finally {
    await page?.close().catch(() => {})
    await context?.close().catch(() => {})
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser', largeFileChars: 24_000 })
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  for (const scenario of scenarios) await runScenario(scenario)
  process.stdout.write(`${JSON.stringify({ result: 'passed', browser: 'chrome', scope: 'real-DSH-compaction-pressure-overflow-failure-append-retry-refresh', scenarios: outcomes })}\n`)
} finally {
  await browser?.close()
  await image?.cleanup()
}
