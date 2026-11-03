import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
const dataDir = await mkdtemp(join(tmpdir(), 'dsh-durable-host-e2e-'))
const sessionId = 'durable-e2e-session'
const gate = Promise.withResolvers()
const modelCalls = []
let app
let browser
let origin

/**
 * Send a same-origin request from a real browser tab.
 * @param {import('playwright').Page} page - Tab that owns the principal cookies.
 * @param {string} pathname - Backend path to request.
 * @param {{method?: string, body?: object}} [options] - Method and JSON body.
 * @returns {Promise<{status: number, body: object}>} Parsed backend response.
 */
async function pageRequest(page, pathname, { method = 'GET', body } = {}) {
  const result = await page.evaluate(async request => {
    const response = await fetch(request.pathname, {
      method: request.method,
      credentials: 'include',
      headers: request.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    })
    return { status: response.status, body: await response.json() }
  }, { pathname, method, body: body === undefined ? undefined : { protocolVersion: 1, requestId: `e2e-${String(Date.now())}`, ...body } })
  return result
}

async function openTab(context, records) {
  const page = await context.newPage()
  page.on('pageerror', error => records.pageErrors.push(error.message))
  await page.goto(`${origin}/api/browser-native/health`)
  await page.evaluate(async () => { await fetch('/api/browser-native/workspace/identity', { credentials: 'include' }) })
  return page
}

async function waitForStatus(page, turnId, expected) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = await pageRequest(page, `/api/browser-native/session/durable?turnId=${turnId}`)
    if (status.body?.status === expected) return status.body
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  throw new Error(`durable turn ${turnId} never reached ${expected}`)
}

try {
  app = await createBrowserNativeV2Server({
    dataDir,
    llmMode: 'scripted',
    durableTurnTimeoutMs: 20_000,
    testHooks: {
      scriptedLlmFault: body => {
        const prompt = [...body.messages].reverse().find(message => message.role === 'user')?.content ?? ''
        if (prompt.includes('DURABLE_HOST_E2E_PRIMARY')) {
          modelCalls.push('primary')
          return {
            kind: 'barrier-text',
            release: gate.promise,
            onReleased: () => modelCalls.push('primary-released'),
            text: 'DURABLE_HOST_E2E_PRIMARY_DONE',
          }
        }
        modelCalls.push('second')
        return { kind: 'text', text: 'DURABLE_HOST_E2E_SECOND_DONE' }
      },
    },
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: browserName })
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const observations = { pageErrors: [] }

  const first = await openTab(context, observations)
  const started = await pageRequest(first, '/api/browser-native/session/durable', {
    method: 'POST',
    body: {
      sessionId,
      turnId: 'durable-e2e-1',
      prompt: 'DURABLE_HOST_E2E_PRIMARY: reply with the marker only.',
    },
  })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  assert.equal(started.body.status, 'running')
  assert.equal(started.body.turn, 1)
  assert.equal(modelCalls.length, 1)

  const during = await pageRequest(first, '/api/browser-native/session/read', {
    method: 'POST',
    body: { sessionId, offset: 0 },
  })
  assert.equal(during.status, 200)
  assert.deepEqual(during.body.events.map(event => event.type), ['turn/start', 'user/message', 'step/start'])
  const closedAt = Date.now()
  await first.close()
  await new Promise(resolveDelay => setTimeout(resolveDelay, 400))

  const reopened = await openTab(context, observations)
  const running = await pageRequest(reopened, '/api/browser-native/session/durable?turnId=durable-e2e-1')
  assert.equal(running.status, 200)
  assert.equal(running.body.status, 'running', 'the server must keep executing after the tab closed')
  const reopenedDuring = await pageRequest(reopened, '/api/browser-native/session/read', {
    method: 'POST',
    body: { sessionId, offset: 0 },
  })
  assert.deepEqual(reopenedDuring.body.events.map(event => event.type), ['turn/start', 'user/message', 'step/start'])
  assert.equal(reopenedDuring.body.events.length, during.body.events.length, 'a closed tab must not append Session events')

  gate.resolve()
  const completed = await waitForStatus(reopened, 'durable-e2e-1', 'completed')
  const after = await pageRequest(reopened, '/api/browser-native/session/read', {
    method: 'POST',
    body: { sessionId, offset: 0 },
  })
  assert.equal(after.status, 200)
  assert.deepEqual(after.body.events.map(event => event.type),
    ['turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
  assert.equal(after.body.events.filter(event => event.type === 'turn/end').length, 1)
  assert.equal(after.body.events.find(event => event.type === 'assistant/message').data.message.content[0].text,
    'DURABLE_HOST_E2E_PRIMARY_DONE')
  assert.equal(after.body.durableThroughSeq, 5)
  assert.equal(completed.nextSeq, 6)

  const replay = await pageRequest(reopened, '/api/browser-native/session/durable', {
    method: 'POST',
    body: { sessionId, turnId: 'durable-e2e-1', prompt: 'DURABLE_HOST_E2E_PRIMARY: replay.' },
  })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.status, 'completed')
  assert.deepEqual(modelCalls, ['primary', 'primary-released'], 'reopening and replaying must not request the model twice')

  const secondTurn = await pageRequest(reopened, '/api/browser-native/session/durable', {
    method: 'POST',
    body: { sessionId, turnId: 'durable-e2e-2', prompt: 'DURABLE_HOST_E2E_SECOND: reply with the marker only.' },
  })
  assert.equal(secondTurn.status, 202)
  assert.equal(secondTurn.body.turn, 2)
  await waitForStatus(reopened, 'durable-e2e-2', 'completed')
  const final = await pageRequest(reopened, '/api/browser-native/session/read', {
    method: 'POST',
    body: { sessionId, offset: 0 },
  })
  assert.deepEqual(final.body.events.map(event => event.type), [
    'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end',
  ])
  assert.equal(final.body.events.filter(event => event.type === 'turn/end' && event.data.turn === 1).length, 1)
  assert.equal(final.body.events.filter(event => event.type === 'turn/end' && event.data.turn === 2).length, 1)

  const takeover = await pageRequest(reopened, '/api/browser-native/session/open', {
    method: 'POST',
    body: { sessionId, access: 'write' },
  })
  assert.equal(takeover.status, 200, 'the reopened tab must take over the settled durable Session')
  assert.equal(typeof takeover.body.owner.ownerToken, 'string')

  const foreignContext = await browser.newContext()
  const foreign = await openTab(foreignContext, observations)
  const foreignStatus = await pageRequest(foreign, '/api/browser-native/session/durable?turnId=durable-e2e-1')
  assert.equal(foreignStatus.status, 404)
  assert.equal(foreignStatus.body.error.code, 'TURN_NOT_FOUND')
  await foreignContext.close()

  assert.deepEqual(observations.pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'durable-host-tab-close-takeover',
    sessionId,
    closedAt,
    modelCalls,
    eventsAtClose: during.body.events.length,
    eventsAfterReopenBeforeRelease: reopenedDuring.body.events.length,
    eventsAfterCompletion: after.body.events.length,
    durableThroughSeq: after.body.durableThroughSeq,
    turnOneTerminalCount: after.body.events.filter(event => event.type === 'turn/end').length,
    replayStatus: replay.body.status,
    takeoverOwnerIssued: typeof takeover.body.owner.ownerToken === 'string',
    crossPrincipalStatus: foreignStatus.status,
    pageErrors: observations.pageErrors.length,
  })}\n`)
} finally {
  await browser?.close()
  await app?.close()
  await rm(dataDir, { recursive: true, force: true })
}
