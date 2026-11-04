/**
 * Tenant cost report against a real provider.
 *
 * Two browser contexts create two principals and one Session each. The test
 * compares the report totals with the provider-reported usage audit entries,
 * checks per-principal and per-Session grouping, verifies price arithmetic,
 * and downloads the CSV export.
 *
 * Usage:
 *   DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
 *     node docs/drafts/browser-native-dsh-poc/tests/usage-report.e2e.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const envFile = process.env.DSH_POC_ENV_FILE
if (envFile === undefined) throw new Error('usage report needs DSH_POC_ENV_FILE for the real provider')
const envText = await readFile(envFile, 'utf8')
const envValue = name => envText.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim()
for (const name of ['OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_API_KEY']) {
  if (envValue(name) === undefined) throw new Error(`${name} is required for the usage report run`)
}

const PRICING = { inputUsdPer1M: 1.25, outputUsdPer1M: 2.5 }
const PROMPT = 'Reply with exactly READY. Do not use any tools.'
const llmTimeoutMs = Number(process.env.DSH_POC_BUDGET_LLM_TIMEOUT_MS ?? 240_000)
const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-usage-report-'))
let app
let browser
let origin

/** Sum provider-reported tokens and price them with the configured rates. */
function totalsOf(entries) {
  return entries.reduce((total, entry) => ({
    requests: total.requests + 1,
    inputTokens: total.inputTokens + entry.inputTokens,
    outputTokens: total.outputTokens + entry.outputTokens,
    totalTokens: total.totalTokens + entry.inputTokens + entry.outputTokens,
    costUsd: total.costUsd
      + (entry.inputTokens / 1_000_000) * PRICING.inputUsdPer1M
      + (entry.outputTokens / 1_000_000) * PRICING.outputUsdPer1M,
  }), { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 })
}

/** Parse the flat CSV export into numeric rows keyed by principal and Session. */
function parseCsv(text) {
  const lines = text.trimEnd().split('\n')
  assert.equal(lines[0], 'principal_id,session_id,requests,input_tokens,output_tokens,total_tokens,cost_usd')
  return lines.slice(1).map(line => {
    const fields = line.split(',')
    assert.equal(fields.length, 7, line)
    return {
      principalId: fields[0] === '' ? null : fields[0],
      sessionId: fields[1] === '' ? null : fields[1],
      requests: Number(fields[2]),
      inputTokens: Number(fields[3]),
      outputTokens: Number(fields[4]),
      totalTokens: Number(fields[5]),
      costUsd: Number(fields[6]),
    }
  })
}

try {
  const image = await createRuntimeValidationDist()
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
    usagePricing: PRICING,
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  const sessions = []
  for (const label of ['first', 'second']) {
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
    const turn = await sendTurn({ page, origin, requests, prompt: PROMPT, timeout: llmTimeoutMs + 60_000 })
    const cookies = await context.cookies()
    const principalId = cookies.find(cookie => cookie.name === 'dsh-browser-native-principal')?.value
    assert.ok(principalId, `${label} context must hold a principal cookie`)
    sessions.push({ label, principalId, sessionId: turn.sessionId })
  }

  const auditResponse = await fetch(`${origin}/api/browser-native/usage-audit`)
  assert.equal(auditResponse.status, 200)
  const audit = (await auditResponse.json()).entries
  assert.ok(audit.length >= sessions.length, `the provider must report usage; entries=${String(audit.length)}`)
  assert.ok(audit.every(entry => typeof entry.principalId === 'string' && entry.principalId.length > 0),
    'every usage entry must carry the calling principal')
  const provider = totalsOf(audit)

  const reportResponse = await fetch(`${origin}/api/browser-native/usage-report`)
  assert.equal(reportResponse.status, 200)
  const report = await reportResponse.json()
  assert.equal(report.model, envValue('OPENAI_MODEL'))
  assert.deepEqual(report.pricing, PRICING)
  assert.equal(report.totals.requests, provider.requests)
  assert.equal(report.totals.inputTokens, provider.inputTokens)
  assert.equal(report.totals.outputTokens, provider.outputTokens)
  assert.equal(report.totals.totalTokens, provider.totalTokens)
  assert.ok(Math.abs(report.totals.costUsd - provider.costUsd) <= 1e-9,
    `report cost ${String(report.totals.costUsd)} must equal priced provider usage ${String(provider.costUsd)}`)

  const reportPrincipals = new Map(report.principals.map(principal => [principal.principalId, principal]))
  assert.equal(report.principals.length, 2)
  for (const session of sessions) {
    const principal = reportPrincipals.get(session.principalId)
    assert.ok(principal, `report must group usage under principal ${session.principalId}`)
    assert.ok(principal.sessions.some(row => row.sessionId === session.sessionId),
      `principal ${session.principalId} must group usage under Session ${session.sessionId}`)
  }
  const reportTotal = report.principals.reduce((total, principal) => ({
    requests: total.requests + principal.requests,
    inputTokens: total.inputTokens + principal.inputTokens,
    outputTokens: total.outputTokens + principal.outputTokens,
    totalTokens: total.totalTokens + principal.totalTokens,
    costUsd: total.costUsd + principal.costUsd,
  }), { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 })
  assert.equal(reportTotal.totalTokens, report.totals.totalTokens)
  assert.ok(Math.abs(reportTotal.costUsd - report.totals.costUsd) <= 1e-9)

  const csvResponse = await fetch(`${origin}/api/browser-native/usage-report?format=csv`)
  assert.equal(csvResponse.status, 200)
  assert.match(csvResponse.headers.get('content-type') ?? '', /text\/csv/)
  assert.match(csvResponse.headers.get('content-disposition') ?? '', /attachment; filename="usage-report-\d{4}-\d{2}-\d{2}\.csv"/)
  const rows = parseCsv(await csvResponse.text())
  assert.equal(rows.length, report.principals.reduce((count, principal) => count + principal.sessions.length, 0))
  const csvTotal = rows.reduce((total, row) => ({
    requests: total.requests + row.requests,
    inputTokens: total.inputTokens + row.inputTokens,
    outputTokens: total.outputTokens + row.outputTokens,
    totalTokens: total.totalTokens + row.totalTokens,
    costUsd: total.costUsd + row.costUsd,
  }), { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 })
  assert.equal(csvTotal.requests, report.totals.requests)
  assert.equal(csvTotal.totalTokens, report.totals.totalTokens)
  assert.ok(Math.abs(csvTotal.costUsd - report.totals.costUsd) <= rows.length * 1e-6)

  process.stdout.write(`${JSON.stringify({
    scope: 'real-model-tenant-cost-report',
    model: report.model,
    sessions: sessions.map(session => ({ label: session.label, principalId: session.principalId, sessionId: session.sessionId })),
    providerUsage: provider,
    reportTotals: report.totals,
    csvRows: rows.length,
    exactTokenMatch: true,
    costMatch: true,
  }, null, 2)}\n`)
} finally {
  if (app !== undefined) await app.close().catch(() => {})
  if (browser !== undefined) await browser.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
