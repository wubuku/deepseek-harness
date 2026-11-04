/**
 * Export a support bundle from the page and prove it localizes a failed turn
 * without carrying prompts, credentials, Session cookies, or owner tokens.
 *
 * The bundle is the operator artifact for a single Session: event-type counts,
 * turn outcomes, failure codes, bounded usage/access logs, and observability
 * state. The test fails the scripted model so the exported evidence has a real
 * failure to identify, then compares two exports for the same facts.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, submitPrompt } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const image = await createRuntimeValidationDist({ roster: 'browser' })
const PROMPT_MARKER = 'SUPPORT_BUNDLE_ONLY_PROMPT'
const FAILURE_CODE = 'SCRIPTED_SUPPORT_BUNDLE_FAILURE'

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-support-bundle-'))
const app = await createBrowserNativeV2Server({
  dataDir,
  distRoot: image.distRoot,
  llmMode: 'scripted',
  testHooks: {
    scriptedLlmFault: body => {
      if (body?.purpose !== undefined) return undefined
      if (!JSON.stringify(body?.messages ?? []).includes(PROMPT_MARKER)) return undefined
      return { kind: 'error', code: FAILURE_CODE, message: 'support bundle probe: injected model failure' }
    },
  },
})
const origin = await app.listen(0)
const browser = await chromium.launch({
  headless: true,
  ...(process.env.DSH_POC_BROWSER === 'chromium' ? {} : { channel: 'chrome' }),
})

async function exportBundle(page) {
  await page.locator('[data-browser-native-support-bundle]').waitFor({ state: 'visible', timeout: 30_000 })
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }).catch(() => undefined),
    page.locator('[data-browser-native-support-bundle]').click(),
  ])
  if (download === undefined) throw new Error('support bundle download did not start')
  const path = await download.path()
  return { download, bundle: JSON.parse(await readFile(path, 'utf8')) }
}

try {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const requests = []
  page.on('request', request => {
    if (!request.url().includes('/api/browser-native/')) return
    requests.push({ url: request.url(), path: new URL(request.url()).pathname, body: request.postDataJSON?.() })
  })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const turn = await submitPrompt({
    page, origin, requests, prompt: `${PROMPT_MARKER} localize this failure`, expectedReason: 'error', timeout: 60_000,
  })
  const terminal = turn.session.events.findLast(event => event.type === 'turn/end')
  assert.equal(terminal.data.reason.kind, 'error', 'the injected failure must end the turn as an error')

  const first = await exportBundle(page)
  assert.equal(first.bundle.format, 'dsh-browser-native-support-bundle-v1')
  assert.equal(first.bundle.formatVersion, 1)
  assert.equal(first.download.suggestedFilename(), `dsh-support-bundle-${turn.sessionId}.json`)
  assert.equal(first.bundle.session.sessionId, turn.sessionId)
  assert.equal(first.bundle.environment.llmMode, 'scripted')
  assert.equal(first.bundle.environment.provider, 'scripted')
  assert.ok(first.bundle.session.eventCount > 0, 'the bundle must summarize persisted Session events')
  assert.ok(first.bundle.session.eventTypes['turn/end'] >= 1, 'the bundle must count the terminal turn')
  assert.equal(first.bundle.session.turnOutcomes.error, 1)
  const exportedCodes = Object.keys(first.bundle.session.errorCodes)
  assert.equal(exportedCodes.length, 1, 'the failed turn must export exactly one failure code')
  assert.equal(first.bundle.session.errorCodes[FAILURE_CODE], 1, 'the failure code must be the injected one')
  assert.ok(Array.isArray(first.bundle.logs), 'the bundle must carry bounded log entries')
  assert.ok(first.bundle.audit.usage.totals !== undefined, 'the bundle must carry a usage audit summary')
  assert.ok(Array.isArray(first.bundle.audit.accessDenials), 'the bundle must carry an access-denial summary')
  const failures = first.bundle.logs.filter(entry => entry.kind === 'model-failure')
  assert.equal(failures.length, 1, 'the failure log must record the failed model attempt')
  assert.equal(failures[0].code, FAILURE_CODE)
  assert.ok(JSON.stringify(first.bundle.state.observability).includes(FAILURE_CODE),
    'observability counters must also identify the failure code')

  const secrets = [
    PROMPT_MARKER,
    ...(await context.cookies(origin)).map(cookie => cookie.value),
    ...await page.evaluate(() => [...Object.values(sessionStorage), ...Object.values(localStorage)]),
    await readFile(join(dataDir, 'browser-native-auth-token'), 'utf8').catch(() => ''),
  ].filter(secret => secret.length >= 8)
  const serialized = JSON.stringify(first.bundle)
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false, 'the support bundle must not contain a prompt, credential, cookie, or owner token')
  }

  const second = await exportBundle(page)
  assert.deepEqual(second.bundle.session, first.bundle.session, 'the same Session must export identical facts on a repeat export')
  assert.deepEqual(second.bundle.audit, first.bundle.audit, 'the same Session must export an identical audit summary on a repeat export')
  assert.deepEqual(second.bundle.environment, first.bundle.environment)
  assert.deepEqual(pageErrors, [])
  console.log(JSON.stringify({
    session: first.bundle.session,
    logs: first.bundle.logs.length,
    audit: first.bundle.audit.usage.totals,
    redactedSecrets: secrets.length,
    repeatable: true,
  }, null, 2))
} finally {
  await browser.close()
  await app.close()
  await rm(dataDir, { recursive: true, force: true })
  await image.cleanup()
}
