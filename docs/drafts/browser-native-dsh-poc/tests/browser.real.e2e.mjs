import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { after, before, describe, it } from 'node:test'
import { createBrowserNativeServer } from '../backend.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const envFile = process.env.DSH_POC_ENV_FILE
if (envFile === undefined) throw new Error('Set DSH_POC_ENV_FILE to the local provider .env file')
const { chromium } = await import(playwrightModule)

let browser
let app
let origin
let dataDir

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-real-'))
  app = await createBrowserNativeServer({ dataDir, llmMode: 'real', envFile })
  origin = await app.listen()
  browser = await chromium.launch({ headless: true })
})

after(async () => {
  await browser?.close()
  await app?.close()
  await rm(dataDir, { recursive: true, force: true })
})

describe('browser-native PoC real provider', () => {
  it('runs a real backend LLM through the browser loop and persists the Session', async () => {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    const sessionId = `real-browser-${Date.now()}`
    try {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => document.querySelector('#llm-mode')?.value === 'real', undefined, { timeout: 10_000 })
      const config = await page.evaluate(async () => (await fetch('/api/browser-native/config')).json())
      assert.equal(config.llmMode, 'real')
      assert.equal(typeof config.model, 'string')
      assert.equal(Object.hasOwn(config, 'apiKey'), false)
      await page.locator('#session-id').fill(sessionId)
      await page.locator('#prompt').fill('Use the browser tool to echo a short greeting, then summarize the result in one sentence.')
      await page.getByRole('button', { name: 'Start Worker' }).click()
      await page.getByText('browser tool: browser_echo', { exact: true }).waitFor({ timeout: 180_000 })
      await page.getByText('completed', { exact: true }).waitFor({ timeout: 180_000 })

      const state = await page.evaluate(() => window.__browserNativePoc.state())
      assert.equal(state.llmMode, 'real')
      assert.deepEqual(state.events.map(event => event.type), [
        'user.message', 'assistant.tool-call', 'tool.result', 'assistant.final',
      ])
      assert.equal(state.events.every((event, index) => event.seq === index), true)
      assert.ok(state.final.length > 0)

      const persisted = await page.evaluate(async id => {
        const response = await fetch('/api/browser-native/session/read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ protocolVersion: 1, requestId: `real-read-${id}`, sessionId: id, offset: 0 }),
        })
        return response.json()
      }, sessionId)
      assert.equal(persisted.durableThroughSeq, 3)
      assert.deepEqual(persisted.events.map(event => event.type), state.events.map(event => event.type))
      assert.deepEqual(errors, [])
      console.log(JSON.stringify({
        mode: config.llmMode,
        provider: config.provider,
        model: config.model,
        eventTypes: state.events.map(event => event.type),
        durableThroughSeq: persisted.durableThroughSeq,
      }))
    } finally {
      await page.close()
    }
  }, { timeout: 360_000 })
})
