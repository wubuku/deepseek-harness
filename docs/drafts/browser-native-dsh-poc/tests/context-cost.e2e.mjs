/**
 * Context-cost default policy against a real provider.
 *
 * Two measurements share one real OpenAI-compatible model:
 * 1. Four short turns prove the rendered system prompt is byte-stable across
 *    requests and that the provider reports prompt-cache reads once its cache
 *    warms up.
 * 2. A single turn whose `read` tool result exceeds the compaction pressure
 *    line runs twice: with the default tool-result pruner and with an
 *    unreachable threshold. Billed input tokens are compared to show whether
 *    the default pruner thresholds save tokens before summarization.
 *
 * Usage:
 *   DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
 *     node docs/drafts/browser-native-dsh-poc/tests/context-cost.e2e.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, sessionRequest } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const envFile = process.env.DSH_POC_ENV_FILE
if (envFile === undefined) throw new Error('context-cost needs DSH_POC_ENV_FILE for the real provider')
const envText = await readFile(envFile, 'utf8')
const envValue = name => envText.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim()
for (const name of ['OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_API_KEY']) {
  if (envValue(name) === undefined) throw new Error(`${name} is required for the context-cost run`)
}

const MODEL_WINDOW = 8_192
const COMPACT_HEADROOM_TOKENS = 512
const COMPACT_MAX_TOKENS = 512
const STABLE_TURNS = 4
const TOOL_FILE = '/dsh/home/workspace/context-cost-large.log'
const TOOL_PROMPT = `Call the read tool exactly once with arguments {"path":"${TOOL_FILE}"} and no offset or limit. After the tool result, reply with exactly CONTEXT_COST_DONE.`
const TOOL_MARKER = 'CONTEXT_COST_DONE'
const llmTimeoutMs = Number(process.env.DSH_POC_CONTEXT_COST_LLM_TIMEOUT_MS ?? 240_000)
const largeContent = Array.from({ length: 600 }, (_, index) => {
  const line = `log ${String(index).padStart(6, '0')} level=info code=E${String(index % 97).padStart(3, '0')} payload=${'x'.repeat(40)}`
  return line
}).join('\n')

function billedInput(entry) {
  // The ledger records the provider's full prompt count, so cached reads are
  // already inside `inputTokens`; `cacheReadTokens` is the cache breakdown.
  return entry.inputTokens
}

async function usageEntries(origin, sessionId) {
  const response = await fetch(`${origin}/api/browser-native/usage-audit?sessionId=${encodeURIComponent(sessionId)}`)
  assert.equal(response.status, 200)
  return (await response.json()).entries
}

function systemPromptDigest(request) {
  const messages = Array.isArray(request.body?.messages) ? request.body.messages : []
  const system = messages.filter(message => message.role === 'system')
  return createHash('sha256').update(JSON.stringify(system)).digest('hex').slice(0, 16)
}

async function startRun(image, dataDir) {
  const app = await createBrowserNativeV2Server({
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
  const origin = await app.listen(0)
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const requests = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin || !url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    requests.push({ path: url.pathname, body })
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=approval-integrity&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 120_000 })
  return { app, origin, context, page, requests, pageErrors }
}

const browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
const cleanup = []

try {
  const cacheImage = await createRuntimeValidationDist({ roster: 'browser', contextWindow: MODEL_WINDOW, compactHeadroomTokens: COMPACT_HEADROOM_TOKENS, compactMaxTokens: COMPACT_MAX_TOKENS })
  cleanup.push(cacheImage)
  const cacheDir = await mkdtemp(join(tmpdir(), 'dsh-context-cache-'))
  cleanup.push({ cleanup: () => rm(cacheDir, { recursive: true, force: true }) })
  const cache = await startRun(cacheImage, cacheDir)
  cleanup.push(cache.app, cache.context)
  let cacheSession
  for (let turn = 1; turn <= STABLE_TURNS; turn += 1) {
    cacheSession = await sendTurn({
      page: cache.page, origin: cache.origin, requests: cache.requests,
      prompt: `Reply with exactly STABLE_TURN_${String(turn)}. Do not use any tools.`,
      marker: `STABLE_TURN_${String(turn)}`,
      sessionId: cacheSession?.sessionId,
      timeout: llmTimeoutMs * 2,
    })
  }
  const cacheEntries = (await usageEntries(cache.origin, cacheSession.sessionId)).filter(entry => entry.purpose === undefined)
  const digests = cache.requests
    .filter(request => request.path.endsWith('/llm') && request.body?.purpose === undefined)
    .map(systemPromptDigest)
  const digestSet = new Set(digests)
  assert.equal(digestSet.size, 1, `system prompt must stay byte-stable across turns; digests=${[...digestSet].join(',')}`)
  const perTurnCache = cacheEntries.map(entry => ({
    billedInput: billedInput(entry),
    cacheReadTokens: entry.cacheReadTokens ?? 0,
  }))
  assert.equal(perTurnCache.length, STABLE_TURNS,
    `the ledger must record one turn request per stable turn; entries=${JSON.stringify(cacheEntries)}`)
  for (const turn of perTurnCache) {
    assert.ok(turn.cacheReadTokens <= turn.billedInput,
      `cache reads cannot exceed the billed prompt; turns=${JSON.stringify(perTurnCache)}`)
  }
  const reusedTurns = perTurnCache.slice(1).filter(turn => turn.cacheReadTokens > 0)
  assert.ok(reusedTurns.length >= STABLE_TURNS - 2,
    `a byte-stable prompt prefix must be reused after the first turn; turns=${JSON.stringify(perTurnCache)}`)
  const cacheBilledInput = cacheEntries.reduce((total, entry) => total + billedInput(entry), 0)
  const cacheReadTotal = perTurnCache.reduce((total, turn) => total + turn.cacheReadTokens, 0)
  assert.deepEqual(cache.pageErrors, [])

  const scenarios = []
  for (const scenario of [
    { label: 'default-pruner', thresholdChars: undefined },
    { label: 'pruner-disabled', thresholdChars: 1_000_000 },
  ]) {
    const image = await createRuntimeValidationDist({
      roster: 'browser',
      contextWindow: MODEL_WINDOW,
      compactHeadroomTokens: COMPACT_HEADROOM_TOKENS,
      compactMaxTokens: COMPACT_MAX_TOKENS,
      ...(scenario.thresholdChars === undefined ? {} : { toolResultPrunerThresholdChars: scenario.thresholdChars }),
    })
    cleanup.push(image)
    const dataDir = await mkdtemp(join(tmpdir(), `dsh-context-${scenario.label}-`))
    cleanup.push({ cleanup: () => rm(dataDir, { recursive: true, force: true }) })
    const run = await startRun(image, dataDir)
    cleanup.push(run.app, run.context)
    const written = await run.page.evaluate(async ({ path, content }) => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'write', path, content }),
      { path: TOOL_FILE, content: largeContent })
    assert.equal(written?.ok, true, JSON.stringify(written))
    const turn = await sendTurn({
      page: run.page, origin: run.origin, requests: run.requests,
      prompt: TOOL_PROMPT, marker: TOOL_MARKER, timeout: llmTimeoutMs * 2,
    })
    const entries = await usageEntries(run.origin, turn.sessionId)
    const turnEntries = entries.filter(entry => entry.purpose === undefined)
    const compactionEntries = entries.filter(entry => entry.purpose === 'compaction')
    const total = turnEntries.reduce((sum, entry) => sum + billedInput(entry), 0)
    const peak = Math.max(...turnEntries.map(billedInput))
    const compactionTotal = compactionEntries.reduce((sum, entry) => sum + billedInput(entry), 0)
    const session = await sessionRequest(run.origin, 'read', { sessionId: turn.sessionId, offset: 0 })
    const readResults = session.events.filter(event => event.type === 'tool/result')
    const pruned = session.events.filter(event => event.type === 'tool/result' && event.surfaceOp?.op === 'replace')
    scenarios.push({
      label: scenario.label,
      totalBilledInput: total,
      peakRequestInput: peak,
      compactionRequests: compactionEntries.length,
      compactionBilledInput: compactionTotal,
      toolResults: readResults.length,
      prunedEvents: pruned.length,
    })
    assert.deepEqual(run.pageErrors, [])
  }

  const [pruned, unpruned] = scenarios
  assert.ok(pruned.compactionRequests > 0 || unpruned.compactionRequests > 0,
    `the oversized tool result must cross the compaction pressure line; scenarios=${JSON.stringify(scenarios)}`)
  assert.ok(pruned.totalBilledInput < unpruned.totalBilledInput,
    `default pruning must reduce billed input; scenarios=${JSON.stringify(scenarios)}`)
  const savings = unpruned.totalBilledInput - pruned.totalBilledInput
  const savingsRatio = savings / unpruned.totalBilledInput

  const summary = {
    result: 'passed',
    model: envValue('OPENAI_MODEL'),
    systemPromptDigests: [...digestSet],
    cache: {
      requests: cacheEntries.length,
      billedInput: cacheBilledInput,
      cacheReadTokens: cacheReadTotal,
      cacheReadRatio: Number((cacheReadTotal / cacheBilledInput).toFixed(3)),
      turns: perTurnCache,
    },
    pruning: {
      ...Object.fromEntries(scenarios.map(scenario => [scenario.label, {
        totalBilledInput: scenario.totalBilledInput,
        peakRequestInput: scenario.peakRequestInput,
        compactionRequests: scenario.compactionRequests,
        compactionBilledInput: scenario.compactionBilledInput,
        prunedEvents: scenario.prunedEvents,
      }])),
      savings,
      savingsRatio: Number(savingsRatio.toFixed(3)),
    },
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} finally {
  for (const resource of cleanup.reverse()) {
    try {
      if (resource?.cleanup !== undefined) await resource.cleanup()
      else if (resource?.close !== undefined) await resource.close()
    } catch {}
  }
  await browser.close()
}
