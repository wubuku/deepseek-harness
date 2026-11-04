/**
 * Path-scoped approval policy against a real model.
 *
 * The `browser-tool-policy` roster mounts the per-tool policy plugin. This run
 * replaces the live policy with a `write` path rule that allows only
 * `/dsh/home/workspace/allowed` and denies every other target. The model is
 * asked to write outside that prefix; the denial must name the allowed path,
 * the model must retry inside it, and the durable audit must record both the
 * normalized denied target and the allowed prefixes.
 *
 * Usage:
 *   DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
 *     node docs/drafts/browser-native-dsh-poc/tests/approval-policy-paths.e2e.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import {
  assistantText, openPreview, sendTurn, sessionRequest, submitPrompt,
} from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const envFile = process.env.DSH_POC_ENV_FILE
if (envFile === undefined) throw new Error('approval policy paths need DSH_POC_ENV_FILE for the real provider')
const envText = await readFile(envFile, 'utf8')
const envValue = name => envText.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim()
for (const name of ['OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_API_KEY']) {
  if (envValue(name) === undefined) throw new Error(`${name} is required for the approval policy paths run`)
}

const MARKER = 'POLICY_PATHS'
const ALLOWED = '/dsh/home/workspace/allowed'
const DENIED_FILE = '/dsh/home/workspace/forbidden/policy-paths-denied.txt'
const ALLOWED_FILE = `${ALLOWED}/policy-paths-allowed.txt`
const DENIED_CONTENT = `${MARKER}_DENIED_SHOULD_NOT_EXIST\n`
const ALLOWED_CONTENT = `${MARKER}_ALLOWED_OK\n`
const DONE = `${MARKER}_DONE`
const POLICY = {
  tools: { write: 'allow', read: 'allow' },
  paths: { write: { allow: [ALLOWED], outside: 'deny' } },
  default: 'allow',
}
const llmTimeoutMs = Number(process.env.DSH_POC_POLICY_LLM_TIMEOUT_MS ?? 240_000)

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-approval-policy-paths-'))
let image
let app
let browser
let context
let page
const pageErrors = []
const requests = []
let origin

function prompt() {
  return `${MARKER}: first call the write tool exactly once with these JSON arguments: ${JSON.stringify({ file_path: DENIED_FILE, content: DENIED_CONTENT })}. If the tool result is an error that names an allowed path, immediately call write again with exactly these JSON arguments: ${JSON.stringify({ file_path: ALLOWED_FILE, content: ALLOWED_CONTENT })}. Do not use any other tool. After the successful write, reply with exactly ${DONE} and nothing else.`
}

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

async function readSession(sessionId) {
  return await sessionRequest(origin, 'read', { sessionId, offset: 0 })
}

function eventsOf(session, type) {
  return session.events.filter(event => event.type === type)
}

function toolCall(session, callId) {
  return session.events.find(event => event.type === 'tool/call' && String(event.data.callId) === String(callId))
}

function toolResult(session, callId) {
  return session.events.find(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === String(callId))
}

function auditFor(session, callId) {
  return eventsOf(session, 'tool-policy/decided').filter(event => String(event.data.callId) === String(callId))
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser-tool-policy' })
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
    if (!request.url().includes('/api/browser-native/session/')) return
    const body = request.postData()
    if (body === null) return
    try {
      requests.push({ path: new URL(request.url()).pathname, body: JSON.parse(body) })
    } catch {
      // Non-JSON Session requests are not protocol operations.
    }
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=approval-integrity&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

  const boot = await sendTurn({
    page, origin, requests,
    prompt: 'Reply with exactly READY. Do not use any tools.',
    timeout: llmTimeoutMs + 60_000,
  })
  const sessionId = boot.sessionId

  await page.locator('button[aria-label^="Access mode"]').first().click()
  await page.getByRole('menuitem', { name: 'Workspace Write' }).click()
  await page.locator('button[aria-label="Access mode, current: Workspace Write"]').waitFor({ timeout: 15_000 })

  const created = await testAction({ action: 'mkdir', path: ALLOWED })
  assert.equal(created?.ok, true, `allowed directory must exist first: ${JSON.stringify(created)}`)

  const applied = await testAction({ action: 'tool-policy-set', toolPolicy: POLICY })
  assert.equal(applied?.ok, true, JSON.stringify(applied))
  assert.deepEqual(applied.policy.paths.write.allow, [ALLOWED], 'the allowed prefix must come from the applied policy')

  const turn = await submitPrompt({
    page, origin, requests, sessionId,
    prompt: prompt(),
    timeout: llmTimeoutMs + 120_000,
  })

  const writes = eventsOf(turn.session, 'tool/call').filter(event => event.data.name === 'write')
  assert.ok(writes.length >= 2, `the model must call write outside and then inside the allowed prefix; got ${writes.length}`)

  const deniedCall = writes.find(call => toolResult(turn.session, call.data.callId)?.data.message.isError === true)
  assert.ok(deniedCall, 'one write call must be rejected by the path rule')
  const deniedResult = toolResult(turn.session, deniedCall.data.callId)
  const deniedText = JSON.stringify(deniedResult.data.message)
  assert.match(deniedText, /denied by the profile tool policy/, `the model must see the policy reason; got ${deniedText}`)
  assert.match(deniedText, new RegExp(DENIED_FILE.replaceAll('/', '\\/')), `the reason must name the denied target; got ${deniedText}`)
  assert.match(deniedText, new RegExp(ALLOWED.replaceAll('/', '\\/')), `the reason must name the allowed path; got ${deniedText}`)
  const deniedAudit = auditFor(turn.session, deniedCall.data.callId)
  assert.equal(deniedAudit.length, 1, `exactly one audit decision for the denied call; got ${JSON.stringify(deniedAudit)}`)
  assert.deepEqual(deniedAudit[0].data, {
    tool: 'write',
    callId: String(deniedCall.data.callId),
    policy: 'deny',
    path: DENIED_FILE,
    allowedPaths: [ALLOWED],
  })

  const allowedCall = writes.findLast(call => toolResult(turn.session, call.data.callId)?.data.message.isError === false)
  assert.ok(allowedCall, 'the model must retry the write inside the allowed prefix')
  assert.equal(toolResult(turn.session, allowedCall.data.callId).data.message.isError, false)
  const allowedAudit = auditFor(turn.session, allowedCall.data.callId)
  assert.equal(allowedAudit.length, 1, JSON.stringify(allowedAudit))
  assert.equal(allowedAudit[0].data.policy, 'allow')
  assert.equal(allowedAudit[0].data.path, ALLOWED_FILE)

  assert.match(assistantText(turn.session, turn.turn), new RegExp(DONE))

  const deniedFile = await testAction({ action: 'read', path: DENIED_FILE })
  assert.notEqual(deniedFile?.ok, true, `the denied write must not create its file: ${JSON.stringify(deniedFile)}`)
  const allowedFile = await testAction({ action: 'read', path: ALLOWED_FILE })
  assert.equal(allowedFile?.ok, true, JSON.stringify(allowedFile))
  assert.equal(allowedFile.content, ALLOWED_CONTENT)
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'))

  const final = await readSession(sessionId)
  const audits = eventsOf(final, 'tool-policy/decided')
  console.log(JSON.stringify({
    scope: 'real-model-path-scoped-tool-policy',
    sessionId,
    turns: { pathPolicy: turn.turn },
    writeCalls: writes.length,
    deniedReason: deniedResult.data.message.content?.find(block => block.type === 'text')?.text,
    audit: {
      deny: audits.filter(event => event.data.policy === 'deny').length,
      allow: audits.filter(event => event.data.policy === 'allow').length,
      deniedPath: deniedAudit[0].data.path,
    },
    files: { deniedAbsent: deniedFile?.ok !== true, allowed: allowedFile.content },
    pageErrors: pageErrors.length,
  }, null, 2))
} finally {
  if (app !== undefined) await app.close().catch(() => {})
  if (browser !== undefined) await browser.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
