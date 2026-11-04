/**
 * Real-model proof that a Workspace skill changes behaviour in the browser.
 *
 * One Session receives the same probe prompt twice: first with no skill
 * installed, then after a skill is written into the Workspace skill root.
 * The control turn must answer the absence marker with no tool call; the
 * treatment turn must load the skill, read a Workspace file the skill body
 * names, and answer with the file contents in the skill-mandated format.
 *
 * The turn also asserts progressive disclosure: the first model request
 * carries only the catalog name/description, while the skill body appears
 * only after the `skill` tool result and in the continuation request.
 *
 * Usage:
 *   DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
 *     node docs/drafts/browser-native-dsh-poc/tests/skill-application.e2e.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const PROBE = 'BROWSER_NATIVE_SKILL_APPLICATION_PROBE'
const ABSENT = 'BROWSER_NATIVE_SKILL_APPLICATION_ABSENT'
const APPLIED = 'BROWSER_NATIVE_SKILL_APPLICATION_APPLIED'
const BODY_MARKER = 'BROWSER_SKILL_APPLICATION_BODY_MARKER'
const DESCRIPTION = 'Applies to BROWSER_NATIVE_SKILL_APPLICATION_PROBE requests and requires a workspace file read'
const CODEWORD = 'BROWSER_SKILL_APPLICATION_CODEWORD_7F3A'
const PROBE_PROMPT = label => `${PROBE}: If an available skill applies to this request, load and follow it exactly. Otherwise reply exactly ${ABSENT} and call no tools.\nProbe label: ${label}.`
const CONTROL_LABEL = 'BROWSER_SKILL_PROBE_CONTROL'
const TREATMENT_LABEL = 'BROWSER_SKILL_PROBE_TREATMENT'
const PROOF_PATH = '/dsh/home/workspace/proof.txt'
const SKILL_ROOT = '/dsh/home/workspace/.agents/skills'
const SKILL_PATH = `${SKILL_ROOT}/browser-proof/SKILL.md`
const SKILL_BODY = [
  '---',
  'name: browser-proof',
  `description: ${DESCRIPTION}`,
  '---',
  '',
  `Body marker: ${BODY_MARKER}`,
  '',
  `When the request contains ${PROBE}:`,
  '1. Call the `read` tool with file_path `/dsh/home/workspace/proof.txt`.',
  `2. Reply exactly ${APPLIED}:<the trimmed file contents>.`,
  '',
].join('\n')
const mode = process.env.DSH_POC_LLM ?? 'scripted'
const envFile = process.env.DSH_POC_ENV_FILE ?? 'docs/drafts/.env'
if (mode !== 'scripted' && mode !== 'real') throw new Error('DSH_POC_LLM must be scripted or real')

const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-skill-application-')))
const llmRequests = []
const apiRequests = []
const pageErrors = []
const workerErrors = []
const external = []
let image
let app
let browser
let page
let origin

function requestBody(request) {
  try { return request.postDataJSON() } catch { return undefined }
}

function catalogText(request) {
  return [...(request.messages ?? [])].reverse().find(message => message.role === 'user'
    && typeof message.content === 'string' && message.content.includes('<available_skills>'))?.content ?? ''
}
function allText(request) {
  return (request.messages ?? []).map(message => typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content ?? '')).join('\n')
}

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
}

function toolCalls(session, turn) {
  return session.events.filter(event => event.type === 'tool/call' && event.data.turn === turn)
}

function toolResult(session, callId) {
  return session.events.find(event => event.type === 'tool/result'
    && (event.data.message?.toolCallId ?? event.data.toolCallId ?? event.data.callId) === callId)
}

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

const TIMEOUT = 240_000
try {
  image = await createRuntimeValidationDist({ roster: 'browser-skill' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: mode, envFile })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) {
      external.push(request.url())
      return
    }
    if (!url.pathname.startsWith('/api/browser-native/')) return
    const body = requestBody(request)
    apiRequests.push({ path: url.pathname, body })
    if (url.pathname === '/api/browser-native/llm' && body !== undefined) llmRequests.push(body)
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=skill-filesystem&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 60_000 })
  const proof = await testAction({ action: 'write', path: PROOF_PATH, content: `${CODEWORD}\n` })
  assert.equal(proof?.ok, true, JSON.stringify(proof))

  // Control: no skill exists, so the same probe must take the absence branch.
  const controlStart = llmRequests.length
  const control = await sendTurn({ page, origin, requests: apiRequests, prompt: PROBE_PROMPT(CONTROL_LABEL), timeout: TIMEOUT })
  const controlText = assistantText(control.session, control.turn)
  assert.match(controlText, new RegExp(ABSENT))
  assert.equal(controlText.includes(BODY_MARKER), false)
  const controlCalls = toolCalls(control.session, control.turn)
  assert.equal(controlCalls.some(event => event.data.name === 'skill'), false,
    'the control turn must not load a skill that does not exist')
  const controlRequests = llmRequests.slice(controlStart).filter(request => request.purpose !== 'session-title')
  assert.ok(controlRequests.length > 0)
  for (const request of controlRequests) {
    assert.equal(catalogText(request).includes('browser-proof'), false, 'no skill may appear before it is written')
    assert.equal(allText(request).includes(BODY_MARKER), false, 'no skill body may reach a request before creation')
  }

  // Treatment: write the skill, then repeat the identical probe in the same
  // Session. The skill body is only disclosed after the tool result.
  const created = await testAction({ action: 'mkdir', path: `${SKILL_ROOT}/browser-proof` })
  assert.equal(created?.ok, true, JSON.stringify(created))
  const written = await testAction({ action: 'write', path: SKILL_PATH, content: SKILL_BODY })
  assert.equal(written?.ok, true, JSON.stringify(written))
  const flush = await testAction({ action: 'flush-workspace' })
  assert.equal(flush?.ok, true, JSON.stringify(flush))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 60_000 })
  const treatmentStart = llmRequests.length
  const treatment = await sendTurn({
    page, origin, requests: apiRequests, sessionId: control.sessionId, prompt: PROBE_PROMPT(TREATMENT_LABEL), timeout: TIMEOUT,
  })
  const treatmentText = assistantText(treatment.session, treatment.turn)
  const treatmentCalls = toolCalls(treatment.session, treatment.turn)
  assert.match(treatmentText, new RegExp(`${APPLIED}:${CODEWORD}`))
  assert.deepEqual(treatmentCalls.map(event => event.data.name), ['skill', 'read'],
    'the skill must be loaded before the read it mandates')
  assert.equal(JSON.parse(treatmentCalls[0].data.arguments).name, 'browser-proof')
  const skillResult = toolResult(treatment.session, treatmentCalls[0].data.callId)
  assert.ok(skillResult)
  assert.equal(skillResult.data.message.isError, false)
  assert.ok(eventText(skillResult).includes(BODY_MARKER), 'the skill tool result must carry the body')
  const readResult = toolResult(treatment.session, treatmentCalls[1].data.callId)
  assert.ok(readResult)
  assert.equal(readResult.data.message.isError, false)
  assert.ok(eventText(readResult).includes(CODEWORD), 'the read result must carry the workspace file')

  const treatmentRequests = llmRequests.slice(treatmentStart).filter(request => request.purpose !== 'session-title')
  assert.ok(treatmentRequests.length >= 3, 'skill and read each require a continuation request')
  assert.ok(catalogText(treatmentRequests[0]).includes('browser-proof'))
  assert.ok(catalogText(treatmentRequests[0]).includes(DESCRIPTION))
  assert.equal(allText(treatmentRequests[0]).includes(BODY_MARKER), false,
    'the first request may carry only catalog metadata, not the body')
  assert.ok(treatmentRequests.slice(1).every(request => allText(request).includes(BODY_MARKER)),
    'the body must enter every request after the skill result')
  assert.ok(toolNames(treatmentRequests[1]).includes('skill'))
  assert.equal(treatment.session.events.filter(event => event.type === 'user/message'
    && event.data.source?.kind === 'user' && eventText(event).includes(PROBE)).length, 2)

  await page.getByText(`${APPLIED}:${CODEWORD}`, { exact: false }).last().waitFor({ timeout: 60_000 })
  assert.equal(await page.locator('[data-approval-key]').count(), 0)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(external, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    scope: 'skill-application-with-and-without-skill',
    mode,
    browser: browser.version(),
    sessionId: treatment.sessionId,
    control: { text: controlText.trim().slice(0, 200), toolCalls: controlCalls.map(event => event.data.name), requests: controlRequests.length },
    treatment: {
      text: treatmentText.trim().slice(0, 200),
      toolCalls: treatmentCalls.map(event => event.data.name),
      requests: treatmentRequests.length,
      catalogHasBody: allText(treatmentRequests[0]).includes(BODY_MARKER),
      continuationHasBody: allText(treatmentRequests[1]).includes(BODY_MARKER),
    },
    workspace: { proofPath: PROOF_PATH, skillPath: SKILL_PATH },
    pageErrors,
    workerErrors,
    external,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup?.()
  await rm(dataDir, { recursive: true, force: true })
}

function toolNames(request) {
  return (request.tools ?? []).map(tool => (tool.function ?? tool).name)
}
