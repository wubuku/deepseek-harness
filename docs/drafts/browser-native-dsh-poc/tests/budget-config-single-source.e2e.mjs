/**
 * Budget limits have one source.
 *
 * The `browser-budget` image carries no token limits; the mounted plugin adopts
 * the backend-published budget at startup. The run bootstraps the same image
 * twice with two different environment records and asserts the Worker guard and
 * the backend configuration agree after each change, then proves that a missing
 * backend budget refuses startup instead of running unguarded.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { BUDGET_ENV, readBudgetLimitsFromEnv } from '../budget-config.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

let image
let browser
const dataDirs = []
const apps = []

function limitsFor(sessionTokens, tenantTokens) {
  return readBudgetLimitsFromEnv({
    [BUDGET_ENV.sessionTokens]: String(sessionTokens),
    [BUDGET_ENV.tenantTokens]: String(tenantTokens),
    [BUDGET_ENV.tenantId]: 'poc-tenant',
  })
}

async function launch(distRoot, budgetLimits) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-budget-config-'))
  dataDirs.push(dataDir)
  const app = await createBrowserNativeV2Server({
    dataDir,
    distRoot,
    llmMode: 'scripted',
    ...(budgetLimits === undefined ? {} : { budgetLimits }),
  })
  apps.push(app)
  return await app.listen(0)
}

function previewUrl(origin) {
  const query = new URLSearchParams({
    'browser-native': '1',
    'browser-native-durable': '1',
    'browser-native-test': 'approval-integrity',
    'preview-fixture': 'none',
  })
  return `${origin}/preview.html?${query.toString()}`
}

async function openBooted(origin) {
  const page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  await page.goto(previewUrl(origin), { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 45_000 })
  return page
}

async function expectStartupBlocked(origin, code) {
  const pageErrors = []
  const modelRequests = []
  const page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin === origin && url.pathname === '/api/browser-native/llm') modelRequests.push(url.href)
  })
  await page.goto(previewUrl(origin), { waitUntil: 'domcontentloaded' })
  const failure = await waitFor(async () => pageErrors.find(message => message.includes(code)), code, 30_000)
    .catch(async error => {
      const status = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state)
      throw new Error(`${error.message}; errors=${JSON.stringify(pageErrors)}; status=${JSON.stringify(status)}`)
    })
  assert.ok(failure.includes('browser-native startup blocked'), failure)
  assert.deepEqual(modelRequests, [], `${code} must refuse startup before any model request`)
  await page.close()
}

async function assertBothSides(origin, limits) {
  const page = await openBooted(origin)
  const config = await (await fetch(`${origin}/api/browser-native/config`)).json()
  assert.deepEqual(config.budget, {
    sessionTokens: limits.sessionTokens,
    tenantTokens: limits.tenantTokens,
    tenantId: limits.tenantId,
  }, 'the backend must publish the one configured budget')
  const state = await waitFor(async () => {
    const observed = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'budget-state' }))
    return observed?.budget?.limits === undefined ? undefined : observed
  }, 'Worker budget adoption', 15_000)
  assert.equal(state?.ok, true, JSON.stringify(state))
  assert.deepEqual(state.budget.limits, {
    sessionLimit: limits.sessionTokens,
    tenantLimit: limits.tenantTokens,
  }, 'the Worker plugin must enforce the backend-published limits')
  assert.equal(state.budget.tenantId, limits.tenantId)
  await page.close()
}

try {
  // The image is built before any budget environment exists: the profile must
  // not carry limits, so both runs below change only the one server record.
  image = await createRuntimeValidationDist({ roster: 'browser-budget' })
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  const first = limitsFor(12_000, 24_000)
  await assertBothSides(await launch(image.distRoot, first), first)

  const second = limitsFor(15_000, 30_000)
  await assertBothSides(await launch(image.distRoot, second), second)

  await expectStartupBlocked(await launch(image.distRoot), 'BUDGET_LIMITS_UNCONFIGURED')

  console.log(JSON.stringify({
    browser: await browser.version(),
    adoptions: [first, second].map(limits => ({ sessionTokens: limits.sessionTokens, tenantTokens: limits.tenantTokens })),
    refusals: ['BUDGET_LIMITS_UNCONFIGURED'],
  }))
} finally {
  for (const app of apps) await app.close()
  await browser?.close()
  for (const dataDir of dataDirs) await rm(dataDir, { recursive: true, force: true })
  await image?.cleanup()
}
