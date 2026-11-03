/**
 * Verify real-model compaction quality in the Browser-Native profile.
 *
 * The profile declares an 8192-token window with a 512-token headroom, so the
 * 0.8 pressure line sits near 6553 tokens and a handful of real turns triggers
 * a real summarize call. A codeword stated only in the first turn must survive
 * the summary and be recalled after compaction; the Session must reload from
 * its durable log and continue with a follow-up turn. Provider usage is
 * requested so the run reports token counts instead of estimates.
 *
 * Skips unless DSH_POC_ENV_FILE points at a dotenv with OPENAI_* LongCat
 * settings, because this test spends real provider requests.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sessionRequest, submitPrompt, waitFor, waitForPreview } from './runtime-test-support.mjs'

const envFile = process.env.DSH_POC_ENV_FILE
if (envFile === undefined) {
  process.stdout.write('{"result":"skipped","reason":"DSH_POC_ENV_FILE is required for real-model compaction"}\n')
  process.exit(0)
}

const envText = await readFile(envFile, 'utf8')
const envValue = name => envText.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim()

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright

const MARKER = 'BROWSER_NATIVE_REAL_COMPACTION_TURN'
const CODEWORD = 'ORANGE-FALCON-42'
const declaredWindow = Number(process.env.DSH_POC_REAL_COMPACTION_WINDOW ?? 8192)
const headroomTokens = Number(process.env.DSH_POC_REAL_COMPACTION_HEADROOM ?? 512)
const fillerChars = Number(process.env.DSH_POC_REAL_COMPACTION_FILLER_CHARS ?? 4_000)
const maxTurns = Number(process.env.DSH_POC_REAL_COMPACTION_MAX_TURNS ?? 12)
const llmTimeoutMs = Number(process.env.DSH_POC_REAL_COMPACTION_LLM_TIMEOUT_MS ?? 240_000)
const compactMaxTokens = Number(process.env.DSH_POC_REAL_COMPACTION_SUMMARY_TOKENS ?? 1_024)

if (!Number.isSafeInteger(declaredWindow) || declaredWindow < 4_096) throw new Error('window must be at least 4096')
if (!Number.isSafeInteger(headroomTokens) || headroomTokens <= 0) throw new Error('headroom must be positive')
if (!Number.isSafeInteger(fillerChars) || fillerChars < 2_000) throw new Error('fillerChars must be at least 2000')
if (!Number.isSafeInteger(maxTurns) || maxTurns < 2) throw new Error('maxTurns must be at least 2')

const filler = ('Reference material for context pressure, kept stable so the pressure line is reached predictably. ').repeat(
  Math.ceil(fillerChars / 88),
).slice(0, fillerChars)

function eventText(event) {
  const content = event.data?.message?.content ?? event.data?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

function summaryText(event) {
  return (event.data?.summary ?? []).filter(block => block?.type === 'text').map(block => block.text).join('')
}

async function readAllSession(origin, sessionId) {
  const events = []
  let offset = 0
  let durableThroughSeq = -1
  while (offset < 1_000_000) {
    const page = await sessionRequest(origin, 'read', { sessionId, offset, length: 2_048 })
    assert.equal(page.status, 200, JSON.stringify(page))
    events.push(...page.events)
    durableThroughSeq = Math.max(durableThroughSeq, page.durableThroughSeq)
    if (page.hasMore !== true) break
    offset = events.length
  }
  return { events, durableThroughSeq }
}

function usageTotals(events) {
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, compactionRequests: 0 }
  for (const event of events) {
    const usage = event.data?.usage
    if (usage === undefined || !Number.isSafeInteger(usage.inputTokens)) continue
    totals.requests += 1
    totals.inputTokens += usage.inputTokens
    totals.outputTokens += usage.outputTokens ?? 0
    totals.totalTokens += usage.totalTokens ?? usage.inputTokens + (usage.outputTokens ?? 0)
    if (event.type === 'compaction/summary') totals.compactionRequests += 1
  }
  return totals
}

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-real-compaction-'))
const previewUrl = origin => `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
let image
let app
let browser
let context
let page
try {
  image = await createRuntimeValidationDist({
    roster: 'browser',
    contextWindow: declaredWindow,
    compactHeadroomTokens: headroomTokens,
    compactMaxTokens,
  })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'real',
    envFile,
    model: envValue('OPENAI_MODEL'),
    llmBaseUrl: envValue('OPENAI_BASE_URL'),
    llmCompletionsPath: 'v1/chat/completions',
    llmApiKey: envValue('OPENAI_API_KEY'),
    llmTimeoutMs,
    llmIncludeUsage: true,
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  const requests = []
  const external = []
  const pageErrors = []
  const logs = []
  const ownerState = { ownerToken: undefined }
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname
    if (!pathname.endsWith('/session/create') && !pathname.endsWith('/session/open')) return
    void response.json().then(payload => {
      if (typeof payload.owner?.ownerToken === 'string') ownerState.ownerToken = payload.owner.ownerToken
    }).catch(() => {})
  })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => logs.push(`${message.type()}: ${message.text()}`))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) {
      external.push(request.url())
      return
    }
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    requests.push({ path: url.pathname, body })
  })

  const startedAt = Date.now()
  await openPreview(page, previewUrl(origin))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

  let sessionId
  let compactionTurn
  let head
  const turnDurations = []
  for (let index = 1; index <= maxTurns; index += 1) {
    const prompt = index === 1
      ? `${MARKER} fact: the access codeword is ${CODEWORD}. Keep this fact for later questions. Do not use tools. Reply with exactly: OK\n\n${filler}`
      : `${MARKER} reference-${String(index)}. Do not use tools. Reply with exactly: OK\n\n${filler}`
    const turnStarted = Date.now()
    const result = await submitPrompt({ page, origin, requests, sessionId, prompt, timeout: llmTimeoutMs + 60_000 })
    sessionId = result.sessionId
    turnDurations.push(Date.now() - turnStarted)
    head = await sessionRequest(origin, 'read', { sessionId, offset: 0, length: 2_048 })
    if (head.events.some(event => event.type === 'compaction/start')) {
      compactionTurn = index
      break
    }
  }
  assert.ok(compactionTurn !== undefined,
    `a ${String(declaredWindow)}-token window must compact within ${String(maxTurns)} turns; events=${(head.events ?? []).map(event => event.type).join(',')}`)

  const ownerToken = await waitFor(() => ownerState.ownerToken, 'Session write owner receipt')
  const flush = await sessionRequest(origin, 'flush', { sessionId, ownerToken })
  assert.equal(flush.status, 200, JSON.stringify(flush))
  const before = await readAllSession(origin, sessionId)
  assert.equal(before.durableThroughSeq, before.events.length - 1,
    'compaction events must be durable before the reload proof')
  const starts = before.events.filter(event => event.type === 'compaction/start')
  const summaries = before.events.filter(event => event.type === 'compaction/summary')
  const ends = before.events.filter(event => event.type === 'compaction/end')
  assert.ok(starts.length >= 1, 'compaction must produce a start event')
  assert.equal(summaries.length, starts.length,
    `every compaction must produce one summary; events=${before.events.map(event => `${event.type}:${event.data?.error ?? ''}`).join(',')}`)
  assert.equal(ends.length, summaries.length, 'every successful summary must close once')
  assert.equal(ends.every(event => event.data.error === undefined), true,
    `compaction must not end with an error: ${JSON.stringify(ends.map(event => event.data.error ?? null))}`)
  const summary = summaries[0]
  assert.equal(summary.data.provider, 'browser-native',
    'the summary records the profile route; the upstream provider is proven by provider-reported usage')
  assert.equal(typeof summary.data.model, 'string', 'the summary must record the real model')
  assert.ok(summaryText(summary).length > 0, 'the real summary must contain text')
  assert.ok(summary.data.shadowedTokenCount > 0, 'the summary must price the shadowed range')

  const usageBeforeRecall = usageTotals(before.events)
  assert.ok(usageBeforeRecall.requests >= 1,
    'provider usage must be reported; the run requested OpenAI stream_options.include_usage')
  assert.ok(usageBeforeRecall.inputTokens > 0, 'provider usage must count input tokens')

  const recall = await submitPrompt({
    page, origin, requests, sessionId,
    prompt: `${MARKER} recall: without using tools, what is the access codeword stated in the first turn? Reply with only that codeword.`,
    timeout: llmTimeoutMs + 60_000,
  })
  const recallText = recall.session.events
    .filter(event => event.type === 'assistant/message' && event.data.turn === recall.turn)
    .flatMap(event => event.data.message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  assert.ok(recallText.includes(CODEWORD),
    `the compacted summary must preserve the codeword; answer=${JSON.stringify(recallText.slice(0, 400))}`)

  const afterRecall = await readAllSession(origin, sessionId)
  const usageAfterRecall = usageTotals(afterRecall.events)
  const recallSummary = afterRecall.events.filter(event => event.type === 'compaction/summary')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const reopened = await readAllSession(origin, sessionId)
  const rebuiltStarts = reopened.events.filter(event => event.type === 'compaction/start')
  const rebuiltSummaries = reopened.events.filter(event => event.type === 'compaction/summary')
  assert.equal(rebuiltStarts.length, afterRecall.events.filter(event => event.type === 'compaction/start').length,
    'hydrate must replay every compaction start from the durable log')
  assert.equal(rebuiltSummaries.length, recallSummary.length, 'hydrate must replay every compaction summary')
  assert.ok(rebuiltSummaries.every(event => summaryText(event).length > 0), 'rebuilt summaries must keep their text')

  const continued = await submitPrompt({
    page, origin, requests, sessionId,
    prompt: `${MARKER} continuation. Do not use tools. Reply with exactly: OK`,
    timeout: llmTimeoutMs + 60_000,
  })
  assert.equal(continued.session.events.some(event => event.type === 'turn/end'
    && event.data.turn === continued.turn && event.data.reason.kind === 'completed'), true,
  'the compacted Session must accept a follow-up turn')

  const durableBytes = (await stat(join(dataDir, 'sessions', `${sessionId}.json`))).size
  assert.deepEqual(external, [])
  assert.deepEqual(pageErrors, [])

  const llmRequests = requests.filter(request => request.path === '/api/browser-native/llm')
  const totalTokens = usageAfterRecall.inputTokens + usageAfterRecall.outputTokens
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    scope: 'real-model-compaction',
    browser: browser.version(),
    provider: 'longcat',
    model: envValue('OPENAI_MODEL'),
    declaredWindow,
    headroomTokens,
    pressureTokens: Math.min(Math.floor(declaredWindow * 0.8), declaredWindow - headroomTokens),
    fillerChars,
    turnsToCompaction: compactionTurn,
    compaction: {
      starts: starts.length,
      summaries: summaries.length,
      ends: ends.length,
      provider: summary.data.provider,
      model: summary.data.model,
      summaryChars: summaryText(summary).length,
      shadowedTokenCount: summary.data.shadowedTokenCount,
      summaryUsage: summary.data.usage ?? null,
    },
    recall: { turn: recall.turn, codeword: CODEWORD, recalled: true, answerChars: recallText.length },
    usage: {
      source: 'provider',
      requests: usageAfterRecall.requests,
      compactionRequests: usageAfterRecall.compactionRequests,
      inputTokens: usageAfterRecall.inputTokens,
      outputTokens: usageAfterRecall.outputTokens,
      totalTokens,
    },
    afterReload: { events: reopened.events.length, starts: rebuiltStarts.length, summaries: rebuiltSummaries.length },
    continuedTurn: continued.turn,
    durableBytes,
    llmRequestBodies: llmRequests.length,
    durationMs: Date.now() - startedAt,
    turnLatencyMedianMs: [...turnDurations].sort((left, right) => left - right)[Math.floor(turnDurations.length / 2)],
    externalRequests: external.length,
    pageErrors,
    warnings: logs.filter(line => line.includes('no context capacity') || line.includes('headroom tokens')).length,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await app?.close()
  await browser?.close()
  await image?.cleanup()
  await rm(dataDir, { recursive: true, force: true })
}
