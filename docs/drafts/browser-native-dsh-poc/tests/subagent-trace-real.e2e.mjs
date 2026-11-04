/**
 * Real-provider smoke for trace attribution of recorded usage.
 *
 * The backend attaches the root Session id as `traceId` when the real LLM proxy
 * records provider usage. This run sends one real turn, then checks the trace
 * report and the durable usage ledger agree on that id and that the report
 * carries provider-reported tokens.
 *
 * Usage:
 *   DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
 *     node docs/drafts/browser-native-dsh-poc/tests/subagent-trace-real.e2e.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, rememberSessionPrincipal, sendTurn, sessionGetRequest } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const envFile = process.env.DSH_POC_ENV_FILE
if (envFile === undefined) throw new Error('real trace smoke needs DSH_POC_ENV_FILE for the real provider')
const envText = await readFile(envFile, 'utf8')
const envValue = name => envText.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim()
for (const name of ['OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_API_KEY']) {
  if (envValue(name) === undefined) throw new Error(`${name} is required for the real trace smoke`)
}

const PROMPT = 'Reply with exactly REAL_TRACE_SMOKE_OK. Do not use any tools.'
const llmTimeoutMs = Number(process.env.DSH_POC_BUDGET_LLM_TIMEOUT_MS ?? 240_000)
const dataDir = await mkdtemp(join(tmpdir(), 'dsh-subagent-trace-real-'))
let app
let browser
let origin

/** Read durable usage records from the hash-chained observability ledger. */
async function usageJournalRecords() {
  const raw = await readFile(join(dataDir, 'observability', 'usage.jsonl'), 'utf8')
  return raw.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line).record)
}

try {
  const image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'real',
    llmProviderKind: 'openai',
    envFile,
    model: envValue('OPENAI_MODEL'),
    llmBaseUrl: envValue('OPENAI_BASE_URL'),
    llmCompletionsPath: 'v1/chat/completions',
    llmApiKey: envValue('OPENAI_API_KEY'),
    llmTimeoutMs,
    llmIncludeUsage: true,
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const requests = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin || !url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    requests.push({ path: url.pathname, body })
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const turn = await sendTurn({ page, origin, requests, prompt: PROMPT, marker: 'REAL_TRACE_SMOKE_OK', timeout: llmTimeoutMs + 60_000 })
  const cookies = await context.cookies()
  const principalId = cookies.find(cookie => cookie.name === 'dsh-browser-native-principal')?.value
  assert.ok(principalId, 'the page must hold a principal cookie')
  await rememberSessionPrincipal(page, origin, turn.sessionId)

  const trace = await sessionGetRequest(origin, 'trace', { sessionId: turn.sessionId }, turn.sessionId)
  assert.equal(trace.status, 200)
  assert.equal(trace.traceId, turn.sessionId, 'a root Session is its own trace')
  assert.equal(trace.sessions.length, 1, 'the smoke run delegates to no child')
  const row = trace.sessions[0]
  assert.equal(row.parentSession, null)
  assert.equal(row.delegationDepth, 0)
  assert.ok(row.usage.requests >= 1, `the provider must report usage; row=${JSON.stringify(row.usage)}`)
  assert.ok(row.usage.totalTokens > 0, `the provider must report tokens; row=${JSON.stringify(row.usage)}`)
  assert.equal(trace.totals.requests, row.usage.requests)
  assert.equal(trace.totals.totalTokens, row.usage.totalTokens)
  assert.equal(trace.totals.costUsd, null, 'unpriced runs report no cost')
  assert.equal(trace.model, envValue('OPENAI_MODEL'))

  const journal = (await usageJournalRecords()).filter(record => record.sessionId === turn.sessionId)
  assert.ok(journal.length >= 1, 'the usage ledger must record this turn')
  assert.ok(journal.every(record => record.traceId === turn.sessionId),
    `every usage record must carry the trace id; records=${JSON.stringify(journal)}`)
  assert.ok(journal.every(record => record.principalId === principalId),
    'every usage record must carry the calling principal')

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    scope: 'real-model-trace-usage-attribution',
    traceId: trace.traceId,
    sessionId: turn.sessionId,
    model: trace.model,
    usageRows: row.usage,
    usageRecords: journal.length,
    journalTraceIds: [...new Set(journal.map(record => record.traceId))],
  })}\n`)
} finally {
  await browser?.close().catch(() => undefined)
  await app?.close().catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true })
}
