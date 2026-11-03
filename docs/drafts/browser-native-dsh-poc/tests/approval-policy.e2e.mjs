/**
 * Approval-policy product regression against a real model.
 *
 * The `browser-tool-policy` roster mounts the profile-configured per-tool
 * policy (write: ask, edit: deny, read: allow). One real Session changes the
 * policy without reloading, proves a `deny` survives a prepended `allow`
 * listener, confirms the model continues after a rejection, then exercises
 * `allow` and `ask` (with the shipped approval card). Every decision is checked
 * against the durable `tool-policy/decided` audit event.
 *
 * Usage:
 *   DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
 *     node docs/drafts/browser-native-dsh-poc/tests/approval-policy.e2e.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import {
  assistantText, openPreview, rememberSessionPrincipal, sendTurn, sessionRequest, submitPrompt, waitFor,
} from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const envFile = process.env.DSH_POC_ENV_FILE
if (envFile === undefined) throw new Error('approval policy needs DSH_POC_ENV_FILE for the real provider')
const envText = await readFile(envFile, 'utf8')
const envValue = name => envText.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim()
for (const name of ['OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_API_KEY']) {
  if (envValue(name) === undefined) throw new Error(`${name} is required for the approval policy run`)
}

const MARKER = 'POLICY_REAL'
const FILE_A = '/dsh/home/workspace/policy-deny.txt'
const FILE_B = '/dsh/home/workspace/policy-allow.txt'
const FILE_C = '/dsh/home/workspace/policy-ask.txt'
const CONTENT_A = `${MARKER}_DENY_SHOULD_NOT_EXIST\n`
const CONTENT_B = `${MARKER}_ALLOW_OK\n`
const CONTENT_C = `${MARKER}_ASK_OK\n`
const DONE_A = `${MARKER}_DENY_DONE`
const DONE_B = `${MARKER}_ALLOW_DONE`
const DONE_C = `${MARKER}_ASK_DONE`
const PROFILE_POLICY = { tools: { write: 'ask', edit: 'deny', read: 'allow' }, default: 'allow' }
const llmTimeoutMs = Number(process.env.DSH_POC_POLICY_LLM_TIMEOUT_MS ?? 240_000)

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-approval-policy-'))
let image
let app
let browser
let context
let page
const requests = []
const pageErrors = []
let origin

function writePrompt(filePath, content, marker) {
  const args = JSON.stringify({ file_path: filePath, content })
  return `${MARKER}: use the write tool exactly once with these JSON arguments: ${args}. That writes ${filePath}. Do not use any other tool. After the tool result, reply with exactly ${marker} and nothing else.`
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

function auditFor(session, callId) {
  return session.events.filter(event => event.type === 'tool-policy/decided'
    && String(event.data.callId) === String(callId))
}

function toolCall(session, callId) {
  return session.events.find(event => event.type === 'tool/call' && String(event.data.callId) === String(callId))
}

function toolResult(session, callId) {
  return session.events.find(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === String(callId))
}

function assertDenied(session, result, callId, label) {
  const call = toolCall(session, callId)
  assert.ok(call, `${label}: the denied call must be logged`)
  assert.ok(result, `${label}: the denied call must settle`)
  assert.equal(result.data.message.isError, true, `${label}: ${JSON.stringify(result.data.message)}`)
  const text = JSON.stringify(result.data.message)
  assert.match(text, /denied by the profile tool policy/, `${label}: the model must see the policy reason; got ${text}`)
  const audit = auditFor(session, callId)
  assert.equal(audit.length, 1, `${label}: exactly one audit decision; got ${JSON.stringify(audit)}`)
  assert.equal(audit[0].data.policy, 'deny', `${label}: audit must record deny`)
  assert.equal(audit[0].data.tool, 'write')
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
    const url = new URL(request.url())
    if (url.origin !== origin) return
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    requests.push({ path: url.pathname, body })
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

  const profileState = await testAction({ action: 'tool-policy-state' })
  assert.equal(profileState?.ok, true, JSON.stringify(profileState))
  assert.deepEqual(profileState.policy, PROFILE_POLICY, 'policy must come from the profile config')

  // Deny is enforced by a monotonic guard: a prepended allow listener cannot
  // force execution, and no approval answerer is ever consulted.
  const rogue = await testAction({ action: 'tool-policy-rogue-allow' })
  assert.equal(rogue?.ok, true, JSON.stringify(rogue))
  const deniedState = await testAction({
    action: 'tool-policy-set',
    toolPolicy: { tools: { write: 'deny', edit: 'deny', read: 'allow' }, default: 'allow' },
  })
  assert.equal(deniedState?.ok, true, JSON.stringify(deniedState))
  assert.equal(deniedState.policy.tools.write, 'deny', 'policy change must take effect before the turn')

  const deniedTurn = await submitPrompt({
    page, origin, requests, sessionId,
    prompt: writePrompt(FILE_A, CONTENT_A, DONE_A),
    timeout: llmTimeoutMs + 60_000,
  })
  const denialAnswer = assistantText(deniedTurn.session, deniedTurn.turn)
  assert.ok(denialAnswer.trim().length > 0, 'the model must produce a follow-up message after the denial')
  const deniedCalls = eventsOf(deniedTurn.session, 'tool/call').filter(event => event.data.name === 'write')
  assert.ok(deniedCalls.length >= 1, 'the model must attempt the denied tool')
  for (const call of deniedCalls) {
    assertDenied(deniedTurn.session, toolResult(deniedTurn.session, call.data.callId), call.data.callId, 'deny turn')
  }
  assert.equal(eventsOf(deniedTurn.session, 'approval/asked').length, 0,
    'a denied call must not reach the approval answerers')
  const untouched = await testAction({ action: 'read', path: FILE_A })
  assert.notEqual(untouched?.ok, true, `denied write must not create the file: ${JSON.stringify(untouched)}`)

  const allowedState = await testAction({
    action: 'tool-policy-set',
    toolPolicy: { tools: { write: 'allow', edit: 'deny', read: 'allow' }, default: 'allow' },
  })
  assert.equal(allowedState?.ok, true, JSON.stringify(allowedState))
  const allowedTurn = await submitPrompt({
    page, origin, requests, sessionId,
    prompt: writePrompt(FILE_B, CONTENT_B, DONE_B),
    timeout: llmTimeoutMs + 60_000,
  })
  assert.match(assistantText(allowedTurn.session, allowedTurn.turn), new RegExp(DONE_B))
  const allowedCall = eventsOf(allowedTurn.session, 'tool/call').findLast(event => event.data.name === 'write')
  assert.ok(allowedCall, 'the allowed call must be logged')
  assert.equal(toolResult(allowedTurn.session, allowedCall.data.callId).data.message.isError, false)
  assert.equal(eventsOf(allowedTurn.session, 'approval/asked').length, 0, 'allow must not ask for approval')
  const allowedAudit = auditFor(allowedTurn.session, allowedCall.data.callId)
  assert.equal(allowedAudit.length, 1, JSON.stringify(allowedAudit))
  assert.equal(allowedAudit[0].data.policy, 'allow')
  const written = await testAction({ action: 'read', path: FILE_B })
  assert.equal(written?.ok, true, JSON.stringify(written))
  assert.equal(written.content, CONTENT_B)

  const askState = await testAction({
    action: 'tool-policy-set',
    toolPolicy: { tools: { write: 'ask', edit: 'deny', read: 'allow' }, default: 'allow' },
  })
  assert.equal(askState?.ok, true, JSON.stringify(askState))
  let asked
  let cardText
  const askTurn = await submitPrompt({
    page, origin, requests, sessionId,
    prompt: writePrompt(FILE_C, CONTENT_C, DONE_C),
    timeout: llmTimeoutMs + 60_000,
    probeWhileRunning: async () => {
      const deadline = Date.now() + llmTimeoutMs
      while (Date.now() < deadline) {
        const session = await readSession(sessionId)
        const requestsAsked = eventsOf(session, 'approval/asked')
        if (requestsAsked.length >= 1) {
          asked = requestsAsked.at(-1)
          break
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      if (asked === undefined) throw new Error('timed out waiting for the policy approval request')
      const card = page.locator('[data-approval-key]')
      cardText = await waitFor(async () => {
        if (await card.count() !== 1) return undefined
        const text = await card.innerText()
        return text.length > 0 ? text : undefined
      }, 'visible policy approval card', 60_000)
      assert.match(cardText, /Allow once/)
      await card.getByRole('button', { name: 'Allow once' }).click()
    },
  })
  assert.ok(asked !== undefined, 'ask policy must request approval')
  assert.match(assistantText(askTurn.session, askTurn.turn), new RegExp(DONE_C))
  const askCall = toolCall(askTurn.session, asked.data.callId)
  assert.ok(askCall, 'the asked call must be logged')
  assert.equal(toolResult(askTurn.session, asked.data.callId).data.message.isError, false)
  const decided = eventsOf(askTurn.session, 'approval/decided')
    .filter(event => String(event.data.id) === String(asked.data.id))
  assert.equal(decided.length, 1)
  assert.equal(decided[0].data.outcome, 'allowed-once')
  const askAudit = auditFor(askTurn.session, asked.data.callId)
  assert.equal(askAudit.length, 1, JSON.stringify(askAudit))
  assert.equal(askAudit[0].data.policy, 'ask')
  const askWritten = await testAction({ action: 'read', path: FILE_C })
  assert.equal(askWritten?.ok, true, JSON.stringify(askWritten))
  assert.equal(askWritten.content, CONTENT_C)
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'))

  const final = await readSession(sessionId)
  const deniedAudits = eventsOf(final, 'tool-policy/decided').filter(event => event.data.policy === 'deny')
  console.log(JSON.stringify({
    scope: 'real-model-profile-tool-policy-allow-ask-deny',
    sessionId,
    profilePolicy: profileState.policy,
    turns: { deny: deniedTurn.turn, allow: allowedTurn.turn, ask: askTurn.turn },
    deniedCalls: deniedCalls.map(call => String(call.data.callId)),
    approvedCard: cardText,
    audit: {
      deny: deniedAudits.length,
      allow: allowedAudits(final).length,
      ask: eventsOf(final, 'tool-policy/decided').filter(event => event.data.policy === 'ask').length,
    },
    approval: { requestId: String(asked.data.id), callId: String(asked.data.callId) },
    files: { denyAbsent: untouched?.ok !== true, allow: written.content, ask: askWritten.content },
  }, null, 2))
  assert.ok(deniedAudits.length >= 1, 'the final log must retain the denial audit')
} finally {
  if (app !== undefined) await app.close().catch(() => {})
  if (browser !== undefined) await browser.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}

function allowedAudits(session) {
  return eventsOf(session, 'tool-policy/decided').filter(event => event.data.policy === 'allow')
}
