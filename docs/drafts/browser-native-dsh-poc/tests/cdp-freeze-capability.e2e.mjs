import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-cdp-freeze-')))
const leaseDurationMs = 5_000
const renewResponses = []
const pageErrors = []
let image
let app
let browser
let page
let cdp

function sleep(durationMs) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, durationMs))
}

async function attempt(method, params) {
  return await cdp.send(method, params).then(() => ({ supported: true }), error => ({
    supported: false,
    error: error.message,
  }))
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: { workspaceWriterLeaseMs: leaseDurationMs },
  })
  const lease = app.workspaces.lease.bind(app.workspaces)
  app.workspaces.lease = async (request, body) => {
    const renewed = await lease(request, body)
    if (body.operation === 'renew') renewResponses.push({ at: Date.now() })
    return renewed
  }
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', error => pageErrors.push(error.message))
  cdp = await page.context().newCDPSession(page)

  await openPreview(page,
    `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

  const lifecycleEvents = []
  cdp.on('Page.lifecycleEvent', event => lifecycleEvents.push(event.name))
  await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true })
  const visibilityOverride = await attempt('Emulation.setPageVisibilityOverride', { visibilityState: 'hidden' })

  await page.evaluate(() => {
    globalThis.__freezeTicks = 0
    globalThis.__freezeTimer = setInterval(() => { globalThis.__freezeTicks += 1 }, 100)
  })
  const leaseBeforeFreeze = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'lease-info',
  }))
  assert.equal(leaseBeforeFreeze?.state, 'active', JSON.stringify(leaseBeforeFreeze))
  const freezeRequest = await attempt('Page.setWebLifecycleState', { state: 'frozen' })
  const freezeStartedAt = Date.now()
  await sleep(2_500)
  const during = await page.evaluate(() => ({
    visibility: document.visibilityState,
    ticks: globalThis.__freezeTicks,
  }))
  const renewalsDuringFreeze = renewResponses.filter(response => response.at > freezeStartedAt + 400
    && response.at < freezeStartedAt + 2_100).length
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})

  assert.equal(visibilityOverride.supported, false,
    'CDP must still lack a page visibility override, otherwise this evidence needs re-recording')
  assert.equal(freezeRequest.supported, true, JSON.stringify(freezeRequest))
  assert.equal(lifecycleEvents.includes('frozen'), false,
    `Page.setWebLifecycleState must not produce a frozen lifecycle event in this Chrome build: ${JSON.stringify(lifecycleEvents)}`)
  assert.equal(during.visibility, 'visible',
    'Page.setWebLifecycleState must not change document.visibilityState')
  assert.equal(renewalsDuringFreeze >= 1, true,
    `the Worker lease heartbeat must keep renewing while Page.setWebLifecycleState reports frozen: ${JSON.stringify(renewResponses)}`)

  const virtualTimePause = await attempt('Emulation.setVirtualTimePolicy', { policy: 'pause' })
  const virtualPauseStartedAt = Date.now()
  const virtualBefore = await page.evaluate(() => ({
    visibility: document.visibilityState,
    ticks: globalThis.__freezeTicks,
  }))
  await sleep(2_500)
  const virtualPaused = await page.evaluate(() => ({
    visibility: document.visibilityState,
    ticks: globalThis.__freezeTicks,
  }))
  const renewalsWhileVirtualPaused = renewResponses.filter(response => response.at > virtualPauseStartedAt + 400
    && response.at < Date.now() - 200).length
  await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 1_000 }).catch(() => {})
  await sleep(300)
  const virtualAdvance = await page.evaluate(() => ({
    visibility: document.visibilityState,
    ticks: globalThis.__freezeTicks,
  }))
  assert.equal(virtualTimePause.supported, true, JSON.stringify(virtualTimePause))
  assert.equal(virtualPaused.ticks <= virtualBefore.ticks, true,
    'virtual time pause must stop page timers')
  assert.equal(virtualAdvance.ticks > virtualPaused.ticks, true,
    'advancing virtual time must resume page timers; it still does not emulate visibility or a lifecycle freeze')

  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    browserVersion: browser.version(),
    verdict: 'cdp-page-freeze-unavailable',
    excluded: {
      visibilityOverride: visibilityOverride.supported ? 'supported' : visibilityOverride.error,
      pageSetWebLifecycleState: {
        commandAccepted: freezeRequest.supported,
        lifecycleEvents,
        visibility: during.visibility,
        mainThreadTicks: during.ticks,
        leaseRenewalsDuringFreeze: renewalsDuringFreeze,
      },
      virtualTimePolicy: {
        commandAccepted: virtualTimePause.supported,
        visibilityWhilePaused: virtualPaused.visibility,
        pageTicksWhilePaused: virtualPaused.ticks,
        pageTicksAfterAdvance: virtualAdvance.ticks,
        renewalsWhileVirtualPaused,
        note: 'controls virtual time only; cannot return the page to real-time execution',
      },
    },
    pageErrors,
  })}\n`)
} finally {
  try { await cdp?.send('Page.setWebLifecycleState', { state: 'active' }) } catch {}
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
