import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../../browser-native-dsh-poc/backend-v2.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../../../..')
const repositoryRequire = createRequire(resolve(repositoryRoot, 'apps/web/package.json'))
const playwright = await import(repositoryRequire.resolve('playwright'))
const browserTypes = playwright.default ?? playwright

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
  }
  throw new Error(`${label} timed out`)
}

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-assistant-ui-ownership-'))
const app = await createBrowserNativeV2Server({ dataDir, llmMode: 'scripted', ownerLeaseMs: 1_500 })
await app.listen(0)
const origin = `http://127.0.0.1:${app.server.address().port}`
const browser = await browserTypes.chromium.launch({ headless: true, channel: 'chrome' })
const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
let first
let second

try {
  first = await context.newPage()
  await first.goto(`${origin}/assistant-ui-poc/index.html`, { waitUntil: 'domcontentloaded' })
  await first.getByTestId('assistant-ui-ready').waitFor({ timeout: 60_000 })
  const sessionId = new URL(first.url()).searchParams.get('sessionId')
  assert.equal(typeof sessionId, 'string')
  await waitFor(() => app.store.get(sessionId).ownerToken !== undefined, 10_000, 'initial Session owner')

  second = await context.newPage()
  await second.goto(first.url(), { waitUntil: 'domcontentloaded' })
  await second.getByTestId('assistant-ui-ready').waitFor({ timeout: 60_000 })
  await second.getByTestId('assistant-ui-error').waitFor({ timeout: 60_000 })
  const ownershipError = await second.getByTestId('assistant-ui-error').textContent()
  assert.match(ownershipError ?? '', /cannot accept messages|already owned/)

  const draft = 'OWNERSHIP_CONFLICT_DRAFT_MUST_SURVIVE'
  const secondInput = second.getByTestId('assistant-ui-input')
  const secondSend = second.getByTestId('assistant-ui-send')
  await secondInput.fill(draft)
  assert.equal(await secondInput.inputValue(), draft)
  assert.equal(await secondSend.isDisabled(), true)
  assert.equal(await second.locator('[data-role="user"]').count(), 0)

  await first.close()
  await waitFor(() => app.store.get(sessionId).ownerToken === undefined, 10_000, 'owner release after first tab close')
  await second.getByTestId('assistant-ui-reconnect').click()
  await second.getByTestId('assistant-ui-ready').waitFor({ timeout: 60_000 })
  await waitFor(() => app.store.get(sessionId).ownerToken !== undefined, 10_000, 'reconnected Session owner')
  assert.equal(await second.getByTestId('assistant-ui-error').count(), 0)
  assert.equal(await secondSend.isEnabled(), true)
  assert.equal(await secondInput.inputValue(), draft)

  const prompt = 'Reply with exactly this marker: OWNERSHIP_RECOVERY_OK'
  await secondInput.fill(prompt)
  await secondSend.click()
  await second.waitForFunction(expected => [...document.querySelectorAll('[data-role="user"]')]
    .some(row => row.textContent?.includes(expected)), prompt, { timeout: 15_000 })
  await second.waitForFunction(() => [...document.querySelectorAll('[data-role="assistant"]:not([data-dsh-live="true"])')]
    .at(-1)?.textContent?.includes('OWNERSHIP_RECOVERY_OK') ?? false, undefined, { timeout: 60_000 })

  process.stdout.write(`${JSON.stringify({
    browser: 'chrome',
    sessionId,
    ownershipErrorVisible: true,
    draftRetained: true,
    ownerReleased: true,
    reconnected: true,
    recoveryReplyVisible: true,
  })}\n`)
} finally {
  await second?.close()
  await first?.close()
  await browser.close()
  await app.close()
  await rm(dataDir, { recursive: true, force: true })
}
