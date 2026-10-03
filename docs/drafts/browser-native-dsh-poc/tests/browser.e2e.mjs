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
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry when this worktree has no node_modules')
    }
  })()
const { chromium } = await import(playwrightModule)

let browser
let app
let origin
let dataDir

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'browser-native-poc-browser-'))
  app = await createBrowserNativeServer({ dataDir })
  origin = await app.listen()
  browser = await chromium.launch({ headless: true })
})

after(async () => {
  await browser?.close()
  await app?.close()
  await rm(dataDir, { recursive: true, force: true })
})

describe('browser-native PoC browser loop', () => {
  it('runs the Worker loop, Main Thread tool, durable events, close, and crash resume', async () => {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    try {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
      await page.locator('#session-id').fill('browser-e2e')
      await page.getByRole('button', { name: 'Start Worker' }).click()
      await page.getByText('completed', { exact: true }).waitFor({ timeout: 10_000 })
      assert.match(await page.locator('#final').textContent(), /browser_echo completed/)
      const firstState = await page.evaluate(() => window.__browserNativePoc.state())
      assert.equal(firstState.sessionId, 'browser-e2e')
      assert.deepEqual(firstState.events.map(event => event.type), [
        'user.message', 'assistant.tool-call', 'tool.result', 'assistant.final',
      ])
      assert.equal(firstState.events.every((event, index) => event.seq === index), true)

      const persisted = await page.evaluate(async () => {
        const response = await fetch('/api/browser-native/session/read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ protocolVersion: 1, requestId: 'browser-read', sessionId: 'browser-e2e', offset: 0 }),
        })
        return response.json()
      })
      assert.equal(persisted.durableThroughSeq, 3)
      assert.equal(persisted.events.length, 4)

      await page.getByRole('button', { name: 'Close Worker' }).click()
      await page.getByText('worker-closed-gracefully', { exact: true }).waitFor({ timeout: 10_000 })
      const rejectedTool = await page.evaluate(() => window.__browserNativePoc.executeTool({
        callId: 'unknown-tool', name: 'not-allowlisted', args: {},
      }))
      assert.equal(rejectedTool.ok, false)
      assert.equal(rejectedTool.error.code, 'TOOL_NOT_ALLOWED')

      await page.getByRole('button', { name: 'Start Worker' }).click()
      await page.getByText('resumed-from-flushed-session', { exact: true }).waitFor({ timeout: 10_000 })
      await page.getByRole('button', { name: 'Terminate Worker' }).click()
      await page.waitForTimeout(15_500)
      await page.getByRole('button', { name: 'Resume Session' }).click()
      await page.getByText('resumed-from-flushed-session', { exact: true }).waitFor({ timeout: 10_000 })
      assert.match(await page.locator('#final').textContent(), /browser_echo completed/)
      assert.deepEqual((await page.evaluate(() => window.__browserNativePoc.state())).events.map(event => event.type), [
        'user.message', 'assistant.tool-call', 'tool.result', 'assistant.final',
      ])
      assert.deepEqual(errors, [])
    } finally {
      await page.close()
    }
  }, { timeout: 60_000 })

  it('continues from a durable Tool result before the final response', async () => {
    const page = await browser.newPage()
    try {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
      await page.evaluate(async () => {
        const request = async (path, body) => {
          const response = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (!response.ok) throw new Error(await response.text())
          return response.json()
        }
        const created = await request('/api/browser-native/session/create', {
          protocolVersion: 1, requestId: 'seed-create', sessionId: 'browser-tool-result-resume',
          header: { sessionId: 'browser-tool-result-resume', version: 1, cwd: '/workspace' }, inheritedEventCount: 0,
        })
        await request('/api/browser-native/session/append', {
          protocolVersion: 1, requestId: 'seed-append', sessionId: 'browser-tool-result-resume',
          ownerToken: created.owner.ownerToken, generation: created.owner.generation, expectedNextSeq: 0,
          events: [
            { seq: 0, type: 'user.message', payload: { content: 'resume after tool' } },
            { seq: 1, type: 'assistant.tool-call', payload: { callId: 'poc-call-1', name: 'browser_echo', args: { text: 'seed' } } },
            { seq: 2, type: 'tool.result', payload: { callId: 'poc-call-1', name: 'browser_echo', result: { text: 'seed', length: 4 } } },
          ],
        })
        await request('/api/browser-native/session/flush', {
          protocolVersion: 1, requestId: 'seed-flush', sessionId: 'browser-tool-result-resume',
          ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        })
        await request('/api/browser-native/session/close', {
          protocolVersion: 1, requestId: 'seed-close', sessionId: 'browser-tool-result-resume',
          ownerToken: created.owner.ownerToken, generation: created.owner.generation,
        })
      })
      await page.locator('#session-id').fill('browser-tool-result-resume')
      await page.getByRole('button', { name: 'Start Worker' }).click()
      await page.getByText('completed', { exact: true }).waitFor({ timeout: 10_000 })
      assert.match(await page.locator('#final').textContent(), /browser_echo completed/)
      assert.deepEqual((await page.evaluate(() => window.__browserNativePoc.state())).events.map(event => event.type), [
        'user.message', 'assistant.tool-call', 'tool.result', 'assistant.final',
      ])
    } finally {
      await page.close()
    }
  })

  it('ignores late messages from a replaced Worker instance', async () => {
    const page = await browser.newPage()
    await page.addInitScript(() => {
      window.__fakeWorkers = []
      class FakeWorker {
        constructor() {
          this.messages = []
          this.terminated = false
          window.__fakeWorkers.push(this)
        }

        postMessage(message) {
          this.messages.push(message)
        }

        terminate() {
          this.terminated = true
        }

        emit(data) {
          this.onmessage?.({ data })
        }
      }
      window.Worker = FakeWorker
    })
    try {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: 'Start Worker' }).click()
      await page.evaluate(() => window.__fakeWorkers[0].emit({ type: 'ready' }))
      await page.getByRole('button', { name: 'Start Worker' }).click()
      await page.evaluate(() => {
        const [oldWorker, currentWorker] = window.__fakeWorkers
        oldWorker.emit({ type: 'ready' })
        oldWorker.emit({ type: 'status', value: 'stale-status' })
        oldWorker.emit({ type: 'error', code: 'STALE', message: 'stale error' })
        currentWorker.emit({ type: 'ready' })
        currentWorker.emit({ type: 'status', value: 'current-status' })
        oldWorker.emit({ type: 'status', value: 'late-stale-status' })
      })
      assert.equal(await page.locator('#status').textContent(), 'current-status')
      const workerState = await page.evaluate(() => window.__fakeWorkers.map(item => ({
        terminated: item.terminated,
        messages: item.messages,
      })))
      assert.equal(workerState[0].terminated, true)
      assert.equal(workerState[0].messages.length, 1)
      assert.equal(workerState[1].messages.length, 1)
      assert.equal(workerState[1].messages[0].type, 'start')
    } finally {
      await page.close()
    }
  })

  it('rejects oversized LLM stream lines', async () => {
    const oversized = ' '.repeat(1024 * 1024 + 1)
    for (const [sessionId, body] of [
      ['browser-large-unterminated', oversized],
      ['browser-large-terminated', `${oversized}\n`],
    ]) {
      const page = await browser.newPage()
      try {
        await page.route('**/api/browser-native/llm', route => route.fulfill({
          status: 200,
          contentType: 'application/x-ndjson; charset=utf-8',
          body,
        }))
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
        await page.locator('#session-id').fill(sessionId)
        await page.getByRole('button', { name: 'Start Worker' }).click()
        await page.getByText(/error: REQUEST_TOO_LARGE:/).waitFor({ timeout: 10_000 })
        assert.match(await page.locator('#status').textContent(), /line exceeds the PoC limit/)
      } finally {
        await page.close()
      }
    }
  })

  it('rejects malformed LLM error items', async () => {
    const page = await browser.newPage()
    try {
      await page.route('**/api/browser-native/llm', route => route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson; charset=utf-8',
        body: `${JSON.stringify({ protocolVersion: 1, kind: 'error', error: { code: {}, message: 'bad' } })}\n`,
      }))
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
      await page.locator('#session-id').fill('browser-malformed-error')
      await page.getByRole('button', { name: 'Start Worker' }).click()
      await page.getByText('error: INVALID_REQUEST: LLM error item is invalid', { exact: true }).waitFor({ timeout: 10_000 })
    } finally {
      await page.close()
    }
  })

  it('rejects an LLM stream that exceeds the cumulative byte limit', async () => {
    const page = await browser.newPage()
    const chunk = 'x'.repeat(64 * 1024)
    const body = Array.from({ length: 129 }, () => JSON.stringify({
      protocolVersion: 1, kind: 'chunk', chunk: { type: 'text', text: chunk },
    })).join('\n')
    try {
      await page.route('**/api/browser-native/llm', route => route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson; charset=utf-8',
        body,
      }))
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
      await page.locator('#session-id').fill('browser-large-stream')
      await page.getByRole('button', { name: 'Start Worker' }).click()
      await page.getByText(/error: REQUEST_TOO_LARGE: LLM stream exceeds the PoC byte limit/).waitFor({ timeout: 10_000 })
    } finally {
      await page.close()
    }
  })
})
