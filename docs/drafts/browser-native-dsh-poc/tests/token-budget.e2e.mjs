/**
 * Token-budget product regression against a real model.
 *
 * The `browser-budget` roster mounts the profile-configured budget plugin
 * (`tenantId: poc-tenant`, session 10000, tenant 20000). The run compares the
 * plugin's Session meter with the upstream provider usage captured by the PoC
 * backend, then lowers the Session limit and finally the tenant limit to prove
 * that the next upstream request is refused before it is sent, the turn ends
 * with a visible budget error, and a durable `budget/exceeded` audit event is
 * written for each scope.
 *
 * Usage:
 *   DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
 *     node docs/drafts/browser-native-dsh-poc/tests/token-budget.e2e.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import {
  openPreview, sendTurn, sessionRequest, submitPrompt, waitFor,
} from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const envFile = process.env.DSH_POC_ENV_FILE
if (envFile === undefined) throw new Error('token budget needs DSH_POC_ENV_FILE for the real provider')
const envText = await readFile(envFile, 'utf8')
const envValue = name => envText.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim()
for (const name of ['OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_API_KEY']) {
  if (envValue(name) === undefined) throw new Error(`${name} is required for the token budget run`)
}

const PROFILE_BUDGET = { tenantId: 'poc-tenant', sessionLimit: 10_000, tenantLimit: 20_000 }
const llmTimeoutMs = Number(process.env.DSH_POC_BUDGET_LLM_TIMEOUT_MS ?? 240_000)

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-token-budget-'))
let app
let browser
let page
const requests = []
const pageErrors = []
let origin

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

async function usageAudit(sessionId) {
  const response = await fetch(`${origin}/api/browser-native/usage-audit?sessionId=${encodeURIComponent(sessionId)}`)
  assert.equal(response.status, 200)
  const payload = await response.json()
  return payload.entries.filter(entry => entry.purpose === undefined)
}

function totalsOf(entries) {
  return entries.reduce((total, entry) => ({
    inputTokens: total.inputTokens + entry.inputTokens,
    outputTokens: total.outputTokens + entry.outputTokens,
  }), { inputTokens: 0, outputTokens: 0 })
}

async function readSession(sessionId) {
  return await sessionRequest(origin, 'read', { sessionId, offset: 0 })
}

function budgetAudit(session, scope) {
  return session.events.filter(event => event.type === 'budget/exceeded' && event.data.scope === scope)
}

function budgetErrorOf(body) {
  const terminal = body.session.events.findLast(event => event.type === 'turn/end' && event.data.turn === body.turn)
  assert.equal(terminal.data.reason.kind, 'error', JSON.stringify(terminal.data.reason))
  return terminal.data.reason.error
}

try {
  const image = await createRuntimeValidationDist({ roster: 'browser-budget' })
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
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin || !url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    requests.push({ path: url.pathname, body })
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=approval-integrity&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

  const boot = await sendTurn({
    page, origin, requests,
    prompt: 'Reply with exactly READY. Do not use any tools.',
    timeout: llmTimeoutMs + 60_000,
  })
  const sessionA = boot.sessionId

  const profileState = await testAction({ action: 'budget-state' })
  assert.equal(profileState?.ok, true, JSON.stringify(profileState))
  assert.deepEqual(profileState.budget.limits, {
    sessionLimit: PROFILE_BUDGET.sessionLimit,
    tenantLimit: PROFILE_BUDGET.tenantLimit,
  }, 'limits must come from the profile config')
  assert.equal(profileState.budget.tenantId, PROFILE_BUDGET.tenantId)

  const providerA = await usageAudit(sessionA)
  assert.ok(providerA.length >= 1, 'the real provider must report usage for the boot request')
  const providerTotals = totalsOf(providerA)
  const sessionState = profileState.budget.sessions.find(session => session.sessionId === sessionA)
  assert.ok(sessionState, JSON.stringify(profileState.budget.sessions))
  assert.deepEqual(
    { inputTokens: sessionState.inputTokens, outputTokens: sessionState.outputTokens },
    providerTotals,
    `Session meter must equal upstream provider usage; meter=${JSON.stringify(sessionState)} provider=${JSON.stringify(providerTotals)}`,
  )
  const tenantState = profileState.budget.tenant
  assert.deepEqual(tenantState, { inputTokens: providerTotals.inputTokens, outputTokens: providerTotals.outputTokens })

  const blockedSession = await testAction({
    action: 'budget-set',
    budgetLimits: { sessionLimit: Math.max(1, sessionState.inputTokens + sessionState.outputTokens - 1), tenantLimit: 20_000 },
  })
  assert.equal(blockedSession?.ok, true, JSON.stringify(blockedSession))
  const sentBefore = (await usageAudit(sessionA)).length
  const sessionTurn = await submitPrompt({
    page, origin, requests, sessionId: sessionA,
    prompt: 'Reply with exactly SECOND. Do not use any tools.',
    timeout: llmTimeoutMs + 60_000,
    expectedReason: 'error',
  })
  const sessionError = budgetErrorOf(sessionTurn)
  assert.equal(sessionError.code, 'TOKEN_BUDGET_EXCEEDED', JSON.stringify(sessionError))
  assert.match(sessionError.message, /token budget exceeded \(session\)/, sessionError.message)
  const sessionLog = await readSession(sessionA)
  assert.equal(budgetAudit(sessionLog, 'session').length, 1, JSON.stringify(budgetAudit(sessionLog, 'session')))
  assert.equal(budgetAudit(sessionLog, 'session')[0].data.tenantId, PROFILE_BUDGET.tenantId)
  assert.equal((await usageAudit(sessionA)).length, sentBefore, 'a blocked request must not reach the provider')
  const errorCard = await waitFor(async () => {
    const text = await page.locator('body').innerText()
    return text.includes('token budget exceeded (session)') ? text : undefined
  }, 'visible session budget error', 30_000)
  assert.match(errorCard, /token budget exceeded \(session\)/)

  const tenantUsed = (await testAction({ action: 'budget-state' })).budget.tenant
  const blockedTenant = await testAction({
    action: 'budget-set',
    budgetLimits: {
      sessionLimit: 100_000,
      tenantLimit: Math.max(1, tenantUsed.inputTokens + tenantUsed.outputTokens - 1),
    },
  })
  assert.equal(blockedTenant?.ok, true, JSON.stringify(blockedTenant))

  const tenantBefore = (await usageAudit(sessionA)).length
  const tenantTurn = await submitPrompt({
    page, origin, requests, sessionId: sessionA,
    prompt: 'Reply with exactly TENANT. Do not use any tools.',
    timeout: llmTimeoutMs + 60_000,
    expectedReason: 'error',
  })
  const tenantError = budgetErrorOf(tenantTurn)
  assert.equal(tenantError.code, 'TOKEN_BUDGET_EXCEEDED', JSON.stringify(tenantError))
  assert.match(tenantError.message, /token budget exceeded \(tenant poc-tenant\)/, tenantError.message)
  const tenantLog = await readSession(sessionA)
  assert.equal(budgetAudit(tenantLog, 'tenant').length, 1, JSON.stringify(budgetAudit(tenantLog, 'tenant')))
  assert.equal(budgetAudit(tenantLog, 'tenant')[0].data.tenantId, PROFILE_BUDGET.tenantId)
  assert.equal((await usageAudit(sessionA)).length, tenantBefore, 'a tenant-blocked request must not reach the provider')
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'))
  console.log(JSON.stringify({
    scope: 'real-model-token-budget-session-tenant',
    tenantId: PROFILE_BUDGET.tenantId,
    profileLimits: profileState.budget.limits,
    meterVsProvider: {
      sessionA: sessionState,
      providerA: providerTotals,
      exact: true,
    },
    sessionBlock: { turn: sessionTurn.turn, code: sessionError.code, message: sessionError.message, providerRequestsAfter: sentBefore },
    tenantBlock: {
      turn: tenantTurn.turn,
      code: tenantError.code,
      message: tenantError.message,
      providerRequestsAfter: tenantBefore,
    },
    audit: { sessionScope: budgetAudit(sessionLog, 'session').length, tenantScope: budgetAudit(tenantLog, 'tenant').length },
    visibleAlert: 'token budget exceeded (session) rendered in the turn error',
  }, null, 2))
} finally {
  if (app !== undefined) await app.close().catch(() => {})
  if (browser !== undefined) await browser.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
