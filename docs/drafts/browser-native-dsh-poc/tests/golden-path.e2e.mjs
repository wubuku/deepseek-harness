/**
 * Golden-path product regression against a real model.
 *
 * One Browser-Native Session runs the full loop: prompt, approval-gated tool
 * execution, a workspace write, a page refresh that rebuilds the conversation
 * from the durable log, and Session export/import under a new id. The flow uses
 * the shipped preview UI, the real composer, the real approval card, and the
 * configured OpenAI-compatible provider.
 *
 * Usage:
 *   DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
 *     node docs/drafts/browser-native-dsh-poc/tests/golden-path.e2e.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import {
  assistantText, openPreview, rememberSessionPrincipal, sendTurn, sessionRequest, submitPrompt, waitFor, waitForPreview,
} from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const envFile = process.env.DSH_POC_ENV_FILE
if (envFile === undefined) throw new Error('golden path needs DSH_POC_ENV_FILE for the real provider')
const envText = await readFile(envFile, 'utf8')
const envValue = name => envText.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim()
for (const name of ['OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_API_KEY']) {
  if (envValue(name) === undefined) throw new Error(`${name} is required for the golden path`)
}

const MARKER = 'GOLDEN_PATH_REAL'
const DONE = `${MARKER}_DONE`
const FILE_CONTENT = `${MARKER}_OK\n`
const FILE_PATH = '/dsh/home/workspace/golden-path.txt'
const llmTimeoutMs = Number(process.env.DSH_POC_GOLDEN_LLM_TIMEOUT_MS ?? 240_000)
const toolArguments = JSON.stringify({ file_path: FILE_PATH, content: FILE_CONTENT })

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-golden-path-'))
let image
let app
let browser
let context
let page
const requests = []
const pageErrors = []
const external = []

function llmCount() {
  return requests.filter(request => request.path.endsWith('/llm')).length
}

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

async function readSession(sessionId) {
  return await sessionRequest(origin, 'read', { sessionId, offset: 0 })
}

function toolCallFor(session, callId) {
  return session.events.find(event => event.type === 'tool/call' && String(event.data.callId) === String(callId))
}

function toolResultFor(session, callId) {
  return session.events.find(event => event.type === 'tool/result' && String(event.data.message.toolCallId) === String(callId))
}

let origin
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
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
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) {
      external.push(request.url())
      return
    }
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    requests.push({ path: url.pathname, body })
  })

  const bootStarted = Date.now()
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=approval-integrity&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const bootMs = Date.now() - bootStarted

  const boot = await sendTurn({
    page, origin, requests,
    prompt: 'Reply with exactly READY. Do not use any tools.',
    timeout: llmTimeoutMs + 60_000,
  })
  const sessionId = boot.sessionId

  await page.locator('button[aria-label^="Access mode"]').first().click()
  await page.getByRole('menuitem', { name: 'Read Only' }).click()
  await page.locator('button[aria-label="Access mode, current: Read Only"]').waitFor({ timeout: 15_000 })

  const goldenPrompt = `${MARKER}: use the write tool exactly once with these JSON arguments: ${toolArguments}. That writes ${FILE_PATH}. Do not use any other tool. After the tool result, reply with exactly ${DONE} and nothing else.`
  const goldenStarted = Date.now()
  let approval
  const golden = await submitPrompt({
    page, origin, requests, sessionId,
    prompt: goldenPrompt,
    timeout: llmTimeoutMs + 60_000,
    probeWhileRunning: async () => {
      const deadline = Date.now() + llmTimeoutMs
      while (Date.now() < deadline) {
        const session = await readSession(sessionId)
        const asked = session.events.filter(event => event.type === 'approval/asked')
        if (asked.length >= 1) {
          approval = { session, request: asked.at(-1), cardText: undefined }
          break
        }
        const goldenUser = session.events.find(event => event.type === 'user/message'
          && JSON.stringify(event.data).includes(MARKER))
        if (goldenUser !== undefined && session.events.some(event => event.type === 'turn/end' && event.seq > goldenUser.seq)) {
          const calls = session.events.filter(event => event.type === 'tool/call')
            .map(event => ({ name: event.data.name, arguments: event.data.arguments }))
          throw new Error(`golden turn ended without an approval request; calls=${JSON.stringify(calls)}; text=${assistantText(session).slice(-400)}`)
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
      }
      if (approval === undefined) throw new Error('timed out waiting for the golden approval request')
      const card = page.locator('[data-approval-key]')
      const cardText = await waitFor(async () => {
        if (await card.count() !== 1) return undefined
        const text = await card.innerText()
        return text.length > 0 ? text : undefined
      }, 'visible approval card', 60_000)
      approval.cardText = cardText
      assert.match(cardText, /Allow once/)
      assert.match(cardText, /workspace-write/)
      await card.getByRole('button', { name: 'Allow once' }).click()
    },
  })
  const goldenMs = Date.now() - goldenStarted

  assert.ok(approval !== undefined, 'the golden turn must ask for approval')
  const goldenCall = toolCallFor(golden.session, approval.request.data.callId)
  const result = toolResultFor(golden.session, approval.request.data.callId)
  assert.ok(goldenCall !== undefined, 'the approved call must be logged')
  assert.ok(result !== undefined, 'the approved call must settle with a result')
  assert.equal(result.data.message.isError, false, JSON.stringify(result.data.message))
  const decided = golden.session.events.filter(event => event.type === 'approval/decided'
    && String(event.data.id) === String(approval.request.data.id))
  assert.equal(decided.length, 1)
  assert.equal(decided[0].data.outcome, 'allowed-once')
  assert.match(assistantText(golden.session, golden.turn), new RegExp(DONE))

  const written = await testAction({ action: 'read', path: FILE_PATH })
  assert.equal(written?.ok, true, JSON.stringify(written))
  assert.equal(written.content, FILE_CONTENT)

  const ownerCookie = (await context.cookies()).map(entry => `${entry.name}=${entry.value}`).join('; ')
  const beforeRefresh = await readSession(sessionId)
  const eventsBeforeRefresh = beforeRefresh.events.length
  const llmBeforeRefresh = llmCount()

  const refreshStarted = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  await page.getByText(DONE, { exact: false }).last().waitFor({ timeout: 60_000 })
  const refreshMs = Date.now() - refreshStarted
  const afterRefresh = await readSession(sessionId)
  assert.deepEqual(afterRefresh.events.slice(0, eventsBeforeRefresh), beforeRefresh.events,
    'refresh must rebuild the durable prefix without rewriting it')
  assert.ok(assistantText(afterRefresh).includes(DONE))
  const llmAfterRefresh = llmCount()
  assert.equal(llmAfterRefresh, llmBeforeRefresh, 'refresh must not replay the model request')

  const httpCall = async (path, { method = 'POST', body, cookie = ownerCookie } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = await response.json().catch(() => undefined)
    return { status: response.status, body: payload }
  }
  const identity = await httpCall('/api/browser-native/workspace/identity', { method: 'GET' })
  assert.equal(identity.status, 200, JSON.stringify(identity.body))
  const workspaceId = identity.body.workspaceId
  assert.equal(typeof workspaceId, 'string')

  const exported = await httpCall('/api/browser-native/session/export', { body: { workspaceId, sessionId } })
  assert.equal(exported.status, 200, JSON.stringify(exported.body))
  const bundle = exported.body
  assert.equal(bundle.format, 'dsh-session-bundle')
  assert.equal(bundle.formatVersion, 1)
  assert.equal(bundle.sessionFormatVersion, 4)
  assert.equal(bundle.session.id, sessionId)
  assert.ok(bundle.session.events.length >= eventsBeforeRefresh)
  assert.deepEqual(bundle.session.events.map(event => event.seq), bundle.session.events.map((_, index) => index))

  const importedId = `golden-import-${randomUUID().slice(0, 8)}`
  const copy = {
    ...bundle,
    session: { ...bundle.session, id: importedId, header: { ...bundle.session.header, id: importedId } },
  }
  const imported = await httpCall('/api/browser-native/session/import', { body: { workspaceId, bundle: copy } })
  assert.equal(imported.status, 200, JSON.stringify(imported.body))
  assert.equal(imported.body.imported, true)
  assert.equal(imported.body.eventCount, bundle.session.events.length)
  assert.equal(imported.body.attachmentCount, 0)
  await rememberSessionPrincipal(page, origin, importedId)
  const readImported = await readSession(importedId)
  assert.equal(readImported.status, 200, JSON.stringify(readImported))
  assert.deepEqual(readImported.events.map(event => event.seq), bundle.session.events.map(event => event.seq))
  const importedResults = readImported.events.filter(event => event.type === 'tool/result')
  const importedDecisions = readImported.events.filter(event => event.type === 'approval/decided')
  assert.ok(importedResults.some(event => event.data.message.isError === true), 'the read-only denial must be logged')
  assert.ok(importedResults.some(event => event.data.message.isError === false), 'the approved write must succeed')
  assert.equal(importedDecisions.length, 1, 'the golden turn must decide exactly one approval')
  assert.equal(importedDecisions[0].data.outcome, 'allowed-once')
  assert.match(assistantText(readImported), new RegExp(DONE))
  assert.equal(readImported.durableThroughSeq, bundle.session.durableThroughSeq)

  const durableBytes = (await stat(join(dataDir, 'sessions', `${sessionId}.json`))).size
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(external, [])
  const afterReloadRead = await testAction({ action: 'read', path: FILE_PATH })
  assert.equal(afterReloadRead.ok, true)
  assert.equal(afterReloadRead.path, written.path)
  assert.equal(afterReloadRead.content, written.content)
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    scope: 'real-model-golden-path-approval-write-refresh-export-import',
    browser: browser.version(),
    provider: 'longcat',
    model: envValue('OPENAI_MODEL'),
    sessionId,
    bootMs,
    goldenMs,
    llmRequests: llmCount(),
    approval: {
      requestId: String(approval.request.data.id),
      callId: String(approval.request.data.callId),
      toolName: approval.request.data.toolName,
      outcome: decided[0].data.outcome,
      cardMentionsArguments: /golden-path\.txt/.test(approval.cardText),
      cardText: approval.cardText,
    },
    workspaceFile: { path: FILE_PATH, bytes: Buffer.byteLength(FILE_CONTENT) },
    refresh: { ms: refreshMs, eventsRebuilt: eventsBeforeRefresh, llmRequests: llmAfterRefresh },
    export: {
      bytes: Buffer.byteLength(JSON.stringify(bundle)),
      eventCount: bundle.session.events.length,
      durableThroughSeq: bundle.durableThroughSeq,
      importedId,
      importedEvents: readImported.events.length,
    },
    durableBytes,
  })}\n`)
} finally {
  if (app !== undefined) await app.close().catch(() => {})
  if (browser !== undefined) await browser.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
