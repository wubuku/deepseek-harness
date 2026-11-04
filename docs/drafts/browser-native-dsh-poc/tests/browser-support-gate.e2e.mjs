import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-support-')))
const safariUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

const app = await createBrowserNativeV2Server({ dataDir, llmMode: 'scripted' })
const origin = await app.listen(0)
const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`
const browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })

try {
  const context = await browser.newContext({ locale: 'en-US', userAgent: safariUserAgent })
  const page = await context.newPage()
  await page.goto(previewUrl, { waitUntil: 'domcontentloaded' })
  const notice = page.locator('[data-browser-native-unsupported="NON_CHROMIUM_DESKTOP"]')
  await notice.waitFor({ state: 'visible', timeout: 30_000 })
  const text = await notice.innerText()
  assert.match(text, /Chromium desktop/)
  assert.match(text, /Safari, Firefox, and mobile browsers/)

  assert.equal(await page.locator('[data-browser-native-workspace-status]').count(), 0)
  assert.equal(await page.locator('[data-composer-input]').count(), 0)
  assert.equal(await page.locator('[data-browser-native-session-export]').count(), 0)

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    unsupportedState: await notice.getAttribute('data-browser-native-unsupported'),
    notice: text,
    workerBooted: false,
  })}\n`)

  await context.close()
} finally {
  await browser.close().catch(() => {})
  await app.close().catch(() => {})
}
