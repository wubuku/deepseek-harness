/**
 * Verify the formal Web preview's main composer routes a new Session's prompt to
 * the durable server host, and that the same Session continues on the durable
 * host after a page reload.
 *
 * The page keeps the Worker as an explicit fallback only; this case proves the
 * default route, the persisted turn events, and continuation after reload.
 *
 * Usage:
 *   node docs/drafts/browser-native-dsh-poc/tests/durable-composer.e2e.mjs
 *   DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
 *     DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/durable-composer.e2e.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-durable-composer-`))
const pages = []
const pageErrors = []
let image
let app
let browser
let context
let origin

const FIRST_PROMPT = 'DURABLE COMPOSER E2E ONE：主 composer 的首轮提交。'
const SECOND_PROMPT = 'DURABLE COMPOSER E2E TWO：刷新后的续跑提交。'

/**
 * Scripted LLM: answer the composer prompts with a stable marker so the
 * persisted assistant message can be matched to each turn.
 * @param {{ messages: { role: string, content: unknown }[] }} body - Provider request.
 * @returns {{ kind: 'text', text: string }} Scripted reply.
 */
function scriptedLlmFault(body) {
  const lastUser = body.messages.findLast(message => message.role === 'user')
  const text = typeof lastUser?.content === 'string' ? lastUser.content : ''
  if (text.includes('DURABLE COMPOSER E2E')) return { kind: 'text', text: `${text} → DONE` }
  return { kind: 'text', text: 'UNRELATED' }
}

async function jsonRequest(method, pathname, body) {
  const response = await context.request.fetch(`${origin}${pathname}`, {
    method,
    ...(body === undefined ? {} : { data: body }),
  })
  const payload = await response.json()
  return { status: response.status(), body: payload }
}

async function waitDurable(turnId, expected) {
  return await waitFor(async () => {
    const status = await jsonRequest('GET', `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`)
    assert.equal(status.status, 200, JSON.stringify(status.body))
    return status.body.status === expected ? status.body : undefined
  }, `durable turn ${turnId} to settle as ${expected}`, 30_000)
}

async function sessionEvents(sessionId) {
  const read = await jsonRequest('POST', '/api/browser-native/session/read', {
    protocolVersion: 1, requestId: `durable-composer-read-${String(Date.now())}`, sessionId, offset: 0,
  })
  assert.equal(read.status, 200, JSON.stringify(read.body))
  return read.body.events
}

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

/**
 * Wait until the page knows which Session the main composer will hand off, and
 * that the route is the durable server host.
 * @param {import('playwright').Page} page - Preview page.
 * @param {string} [expectedSessionId] - Session that must remain active after reload.
 * @returns {Promise<string>} Composer Session id.
 */
async function waitComposerSession(page, expectedSessionId) {
  await page.waitForFunction((expected) => {
    const route = window.__DSH_BROWSER_NATIVE_COMPOSER_ROUTE__
    return route?.state === 'durable' && typeof route.sessionId === 'string'
      && (expected === undefined || route.sessionId === expected)
  }, expectedSessionId, { timeout: 45_000 })
  return await page.evaluate(() => window.__DSH_BROWSER_NATIVE_COMPOSER_ROUTE__.sessionId)
}

/**
 * Submit through the real composer and return the durable turn the page started.
 * @param {import('playwright').Page} page - Preview page.
 * @param {string} prompt - Prompt text typed into the composer.
 * @param {string} sessionId - Session the composer must hand off.
 * @returns {Promise<{ sessionId: string, turnId: string }>} Started durable turn.
 */
async function submitDurablePrompt(page, prompt, sessionId) {
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.fill(prompt)
  assert.equal(await page.evaluate(() => document.querySelector('[data-composer-input][contenteditable="true"]')?.innerText.trim().length > 0), true)
  await composer.press('Enter')
  await page.waitForFunction(([expectedSession]) => {
    const turn = window.__DSH_LAST_DURABLE_TURN__
    return typeof turn?.turnId === 'string' && turn.sessionId === expectedSession
  }, [sessionId], { timeout: 30_000 })
  return await page.evaluate(() => window.__DSH_LAST_DURABLE_TURN__)
}

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    durableTurnTimeoutMs: 20_000,
    testHooks: { scriptedLlmFault },
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  context.on('page', page => {
    pages.push(page)
    page.on('pageerror', error => pageErrors.push(error.message))
  })

  const identity = await context.request.get(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(identity.status(), 200)

  const page = await context.newPage()
  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-durable-turn=1&preview-fixture=none`
  await openPreview(page, previewUrl)

  const sessionId = await waitComposerSession(page)
  const first = await submitDurablePrompt(page, FIRST_PROMPT, sessionId)
  assert.equal(first.sessionId, sessionId, 'the main composer must hand off the active Session')
  const firstStatus = await waitDurable(first.turnId, 'completed')
  assert.equal(firstStatus.status, 'completed')

  const firstEvents = await sessionEvents(sessionId)
  const firstUsers = firstEvents.filter(event => event.type === 'user/message')
  assert.equal(firstUsers.some(event => eventText(event).includes('DURABLE COMPOSER E2E ONE')), true,
    'the durable host must persist the composer prompt')
  const firstAssistant = firstEvents.filter(event => event.type === 'assistant/message').at(-1)
  assert.match(eventText(firstAssistant), /DONE/, 'the durable host must persist the assistant reply')

  // Reload: the same Session must reopen on the durable host and accept a second turn.
  await openPreview(page, previewUrl)
  const resumedSessionId = await waitComposerSession(page, sessionId)
  assert.equal(resumedSessionId, sessionId, 'a reload must reopen the durable Session')

  const second = await submitDurablePrompt(page, SECOND_PROMPT, sessionId)
  assert.notEqual(second.turnId, first.turnId, 'continuation must start a new durable turn')
  const secondStatus = await waitDurable(second.turnId, 'completed')
  assert.equal(secondStatus.status, 'completed')

  const resumedEvents = await sessionEvents(sessionId)
  const turnStarts = resumedEvents.filter(event => event.type === 'turn/start')
  assert.equal(turnStarts.length, 2, 'both durable turns must be persisted in the same Session')
  const secondUser = resumedEvents.filter(event => event.type === 'user/message')
    .find(event => eventText(event).includes('DURABLE COMPOSER E2E TWO'))
  assert.ok(secondUser, 'the second composer prompt must persist after reload')
  assert.equal(resumedEvents.at(-1).type, 'turn/end')

  assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(' | ')}`)
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    scope: 'durable-composer',
    sessionId,
    route: await page.evaluate(() => window.__DSH_BROWSER_NATIVE_COMPOSER_ROUTE__),
    first: { turnId: first.turnId, status: firstStatus.status },
    resumed: { turnId: second.turnId, status: secondStatus.status, turnStarts: turnStarts.length },
    promptsPersisted: [FIRST_PROMPT.slice(0, 24), SECOND_PROMPT.slice(0, 24)],
    pageErrors,
  })}\n`)
} finally {
  await browser?.close()
  await app?.close()
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}
