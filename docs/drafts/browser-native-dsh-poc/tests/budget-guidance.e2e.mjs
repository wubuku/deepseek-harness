/**
 * Pre-send budget visibility and blocking against a real model.
 *
 * Scenario A starts with generous Session/tenant limits and per-million prices:
 * one real provider turn runs, and the page budget panel must show exactly the
 * provider-reported tokens and the derived cost from the usage audit.
 * Scenario B restarts the same preview build with one-token limits: after the
 * boot turn the page must show the exhausted state, disable the composer send,
 * and refuse both Enter and click submissions without creating another turn or
 * provider request.
 *
 * Usage:
 *   DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
 *     node docs/drafts/browser-native-dsh-poc/tests/budget-guidance.e2e.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright

const envFile = process.env.DSH_POC_ENV_FILE
if (envFile === undefined) throw new Error('budget guidance needs DSH_POC_ENV_FILE for the real provider')
const envText = await readFile(envFile, 'utf8')
const envValue = name => envText.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim()
for (const name of ['OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_API_KEY']) {
  if (envValue(name) === undefined) throw new Error(`${name} is required for the budget guidance run`)
}

const PRICING = { inputUsdPer1M: 1.25, outputUsdPer1M: 2.5 }
const llmTimeoutMs = Number(process.env.DSH_POC_BUDGET_LLM_TIMEOUT_MS ?? 240_000)
const image = await createRuntimeValidationDist({ roster: 'browser' })
const browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })

const BOOT_PROMPT = 'Reply with exactly BUDGET_READY. Do not use any tools.'

async function launchServer(limits) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-budget-guidance-'))
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
    usagePricing: PRICING,
    budgetLimits: limits,
  })
  return { app, dataDir, origin: await app.listen(0) }
}

async function usageAudit(origin, sessionId) {
  const response = await fetch(`${origin}/api/browser-native/usage-audit?sessionId=${encodeURIComponent(sessionId)}`)
  assert.equal(response.status, 200)
  return (await response.json()).entries
}

function expectedCost(entries) {
  return entries.reduce((total, entry) => total
    + (entry.inputTokens / 1_000_000) * PRICING.inputUsdPer1M
    + (entry.outputTokens / 1_000_000) * PRICING.outputUsdPer1M, 0)
}

function sendButton(page) {
  return page.getByRole('button', { name: /^(Send message|发送消息)$/ })
}

async function openBudgetPage(context, origin) {
  const requests = []
  const page = await context.newPage()
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin || !url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    requests.push({ method: request.method(), path: url.pathname, body })
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced',
    undefined, { timeout: 60_000 })
  return { page, requests }
}

const started = []
try {
  // Scenario A: provider usage and cost are shown before the next send.
  const generous = await launchServer({ sessionTokens: 60_000, tenantTokens: 120_000, tenantId: 'poc-tenant', warnRatio: 0.8 })
  started.push(generous)
  const contextA = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 1000 },
  })
  await contextA.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: generous.origin })
  const { page, requests } = await openBudgetPage(contextA, generous.origin)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const boot = await sendTurn({
    page,
    origin: generous.origin,
    requests,
    prompt: BOOT_PROMPT,
    marker: 'BUDGET_READY',
    timeout: llmTimeoutMs + 60_000,
  })
  const sessionId = boot.sessionId
  const panel = page.locator('[data-browser-native-budget]')
  await panel.waitFor({ state: 'visible', timeout: 30_000 })
  const aligned = await waitFor(async () => {
    const shown = Number(await panel.getAttribute('data-session-total'))
    if (!Number.isFinite(shown) || shown < 1) return undefined
    const entries = await usageAudit(generous.origin, sessionId)
    const totalsNow = entries.reduce((total, entry) => ({
      input: total.input + entry.inputTokens,
      output: total.output + entry.outputTokens,
    }), { input: 0, output: 0 })
    return shown === totalsNow.input + totalsNow.output ? { entries, totals: totalsNow } : undefined
  }, 'the budget panel equals provider usage', 45_000)
  const audit = aligned.entries
  const totals = aligned.totals
  const totalTokens = totals.input + totals.output

  assert.equal(Number(await panel.getAttribute('data-session-input')), totals.input)
  assert.equal(Number(await panel.getAttribute('data-session-output')), totals.output)
  const shownCost = Number(await panel.getAttribute('data-session-cost'))
  assert.ok(Math.abs(shownCost - expectedCost(audit)) < 1e-8,
    `displayed cost ${String(shownCost)} must match provider usage priced at the configured rates`)

  const sessionLine = await panel.locator('[data-browser-native-budget-session]').innerText()
  assert.match(sessionLine, new RegExp(`Session ${totalTokens.toLocaleString('en-US')} / 60,000 tokens`), sessionLine)
  const tenantLine = await panel.locator('[data-browser-native-budget-tenant]').innerText()
  const tenantTotal = Number(await panel.getAttribute('data-tenant-total'))
  const tenantRemaining = Number(await panel.getAttribute('data-tenant-remaining'))
  assert.match(tenantLine, new RegExp(`${tenantRemaining.toLocaleString('en-US')} remaining`), tenantLine)
  assert.equal(tenantRemaining, 120_000 - tenantTotal)
  const thresholdLine = await panel.locator('[data-browser-native-budget-threshold]').innerText()
  assert.equal(thresholdLine, 'Warning at 80%')
  assert.equal(await panel.getAttribute('data-state'), 'ok')
  const composerA = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composerA.fill('A send inside the budget stays available')
  assert.equal(await sendButton(page).isDisabled(), false, 'a send inside the budget must stay enabled')
  assert.equal(await sendButton(page).getAttribute('data-browser-native-budget-blocked'), null)
  assert.equal(pageErrors.length, 0, pageErrors.join('; '))

  // Scenario B: exhausted limits must block the composer before the provider runs.
  const exhausted = await launchServer({ sessionTokens: 1, tenantTokens: 2, tenantId: 'poc-tenant', warnRatio: 0.8 })
  started.push(exhausted)
  const contextB = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 1000 },
  })
  await contextB.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: exhausted.origin })
  const pageB = await contextB.newPage()
  const requestsB = []
  pageB.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== exhausted.origin || !url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    requestsB.push({ method: request.method(), path: url.pathname, body })
  })
  const pageErrorsB = []
  pageB.on('pageerror', error => pageErrorsB.push(error.message))
  await openPreview(pageB, `${exhausted.origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  await pageB.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced',
    undefined, { timeout: 60_000 })
  const bootB = await sendTurn({
    page: pageB,
    origin: exhausted.origin,
    requests: requestsB,
    prompt: BOOT_PROMPT,
    marker: 'BUDGET_READY',
    timeout: llmTimeoutMs + 60_000,
  })
  const sessionB = bootB.sessionId
  const panelB = pageB.locator('[data-browser-native-budget]')
  await panelB.waitFor({ state: 'visible', timeout: 30_000 })
  await waitFor(async () => await panelB.getAttribute('data-state') === 'exceeded',
    'the exhausted Session budget reaches the page', 30_000)
  assert.equal(await panelB.getAttribute('data-blocked-scope'), 'session')
  const note = await panelB.locator('[data-browser-native-budget-note]').innerText()
  assert.match(note, /Sending is disabled: the Session token budget is exhausted/)
  assert.match(note, /Ask an administrator to raise the budget/)
  const admin = panelB.locator('[data-browser-native-budget-admin]')
  const diagnostics = panelB.locator('[data-browser-native-budget-diagnostics]')
  assert.equal(await admin.isVisible(), true, 'the blocked panel must offer the administrator path')
  assert.equal(await diagnostics.isVisible(), true, 'the blocked panel must offer diagnostics')

  const send = sendButton(pageB)
  assert.equal(await send.isDisabled(), true, 'the exhausted budget must disable the send button')
  assert.equal(await send.getAttribute('data-browser-native-budget-blocked'), '')

  const before = await sessionRequest(exhausted.origin, 'read', { sessionId: sessionB, offset: 0 })
  const beforeMessages = (before.events ?? []).filter(event => event.type === 'user/message').length
  const auditBefore = (await usageAudit(exhausted.origin, sessionB)).filter(entry => entry.purpose === undefined).length
  const composer = pageB.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.fill('BUDGET_SECOND must never reach the provider')
  await composer.press('Enter')
  await pageB.waitForTimeout(2_000)
  const afterEnter = await sessionRequest(exhausted.origin, 'read', { sessionId: sessionB, offset: 0 })
  assert.equal((afterEnter.events ?? []).filter(event => event.type === 'user/message').length, beforeMessages,
    'Enter must not create a user message while the budget is exhausted')

  // Prove the guard holds even if the disabled attribute were stripped:
  // force-enable the control and click it; the capture listener must still block.
  await pageB.evaluate(() => {
    const target = [...document.querySelectorAll('button[aria-label]')]
      .find(node => /^(Send message|发送消息)$/.test(node.getAttribute('aria-label') ?? ''))
    if (target === undefined) return
    target.disabled = false
    target.removeAttribute('aria-disabled')
  })
  await send.click()
  await pageB.waitForTimeout(2_000)
  const afterClick = await sessionRequest(exhausted.origin, 'read', { sessionId: sessionB, offset: 0 })
  assert.equal((afterClick.events ?? []).filter(event => event.type === 'user/message').length, beforeMessages,
    'a forced click must not create a user message while the budget is exhausted')
  assert.equal((await usageAudit(exhausted.origin, sessionB)).filter(entry => entry.purpose === undefined).length,
    auditBefore, 'a blocked send must not reach the provider')

  await admin.click()
  const result = panelB.locator('[data-browser-native-budget-result]')
  await result.waitFor({ state: 'visible', timeout: 10_000 })
  assert.match(await result.innerText(), /Admin request copied/)
  const copied = await pageB.evaluate(() => navigator.clipboard.readText())
  assert.ok(copied.includes(sessionB), 'the copied budget request must name the Session')
  assert.match(copied, /raise it so I can send again/)

  const download = await Promise.all([
    pageB.waitForEvent('download'),
    diagnostics.click(),
  ])
  assert.equal(download[0].suggestedFilename(), `dsh-support-bundle-${sessionB}.json`)
  await pageB.waitForTimeout(1_500)
  assert.match(await result.innerText(), /Diagnostics bundle exported/)
  assert.equal(pageErrorsB.length, 0, pageErrorsB.join('; '))

  process.stdout.write(`${JSON.stringify({
    alignment: {
      sessionTokens: totalTokens,
      inputTokens: totals.input,
      outputTokens: totals.output,
      costUsd: shownCost,
      tenantRemaining,
      state: 'ok',
    },
    preBlock: {
      state: 'exceeded',
      blockedScope: 'session',
      sendDisabled: true,
      enterBlocked: true,
      forcedClickBlocked: true,
      providerRequestsUnchanged: true,
      adminPath: true,
      diagnostics: `dsh-support-bundle-${sessionB}.json`,
    },
  }, null, 2)}\n`)
} finally {
  await browser.close().catch(() => {})
  for (const { app, dataDir } of started) {
    await app.close().catch(() => {})
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
}
