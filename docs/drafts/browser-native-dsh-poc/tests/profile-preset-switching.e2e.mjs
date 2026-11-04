import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, rememberSessionPrincipal, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
if (browserName !== 'chrome') throw new Error('Profile preset switching validation runs only in Chrome')

const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-profile-preset-')))
const agents = [
  { sessionId: 'preset-a', prompt: 'BROWSER_NATIVE_PRESET_A_HOLD', model: 'browser-native-a' },
  { sessionId: 'preset-b', prompt: 'BROWSER_NATIVE_PRESET_B_READ', model: 'browser-native-b' },
]
const releaseA = Promise.withResolvers()
const requests = []
const pageErrors = []
const workerErrors = []
const externalRequests = []
let image
let app
let browser
let page
let origin

function messageText(message) {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
}

function latestPrompt(body) {
  for (const message of [...(body.messages ?? [])].reverse()) {
    if (message.role !== 'user') continue
    const text = messageText(message)
    const marker = text.lastIndexOf('BROWSER_NATIVE_PRESET_')
    if (marker !== -1) return text.slice(marker)
  }
  return ''
}

function toolCallNames(body) {
  return (body.tools ?? []).map(tool => tool.function?.name ?? tool.name)
}

function sessionRequests(sessionId) {
  return requests.filter(request => request.sessionId === sessionId)
}

function hasToolResult(body, callId) {
  return (body.messages ?? []).some(message => message.role === 'tool'
    && (message.tool_call_id === callId || message.toolCallId === callId))
}

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

function assistantText(session, turn) {
  return session.events.filter(event => event.type === 'assistant/message' && event.data.turn === turn)
    .map(eventText).join('\n')
}

function toolResultFor(session, callId) {
  return session.events.find(event => event.type === 'tool/result' && event.data.message?.toolCallId === callId)
}

function resultContent(result) {
  return (result?.data.message.content ?? []).map(block => block.text ?? '').join(' ')
}

async function workerRequest(request) {
  return await page.evaluate(async value => {
    const invoke = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof invoke !== 'function') throw new Error('Browser-Native Worker test port is unavailable')
    return await invoke(value)
  }, request)
}

async function readSession(sessionId) {
  return await sessionRequest(origin, 'read', { sessionId, offset: 0 })
}

async function terminalFor(sessionId, prompt, reason) {
  return await waitFor(async () => {
    const session = await readSession(sessionId)
    const userIndex = session.events.findLastIndex(event => event.type === 'user/message' && eventText(event).includes(prompt))
    if (userIndex === -1) return undefined
    const terminal = session.events.findLast((event, index) => index > userIndex && event.type === 'turn/end')
    if (terminal === undefined || terminal.data.reason.kind !== reason) return undefined
    return { session, turn: terminal.data.turn }
  }, `terminal event for ${sessionId}:${prompt}`, 45_000)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser-profile-preset' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: {
      scriptedLlmFault: body => {
        if (body.purpose !== undefined) return undefined
        const prompt = latestPrompt(body)
        if (prompt.startsWith('BROWSER_NATIVE_PRESET_A_HOLD')) {
          if (!hasToolResult(body, 'preset-a-write')) {
            return {
              kind: 'barrier-tool-call',
              release: releaseA.promise,
              call: {
                id: 'preset-a-write',
                name: 'write',
                arguments: { file_path: '/dsh/home/workspace/preset-a.txt', content: 'preset-a\n' },
              },
            }
          }
          return { kind: 'text', text: 'BROWSER_NATIVE_PRESET_A_DONE' }
        }
        if (prompt.startsWith('BROWSER_NATIVE_PRESET_B_READ')) return { kind: 'text', text: 'BROWSER_NATIVE_PRESET_B_READ_DONE' }
        if (prompt.startsWith('BROWSER_NATIVE_PRESET_B_WRITE')) {
          if (!hasToolResult(body, 'preset-b-write')) {
            return {
              kind: 'tool-call',
              call: {
                id: 'preset-b-write',
                name: 'write',
                arguments: { file_path: '/dsh/home/workspace/preset-b.txt', content: 'preset-b\n' },
              },
            }
          }
          return { kind: 'text', text: 'BROWSER_NATIVE_PRESET_B_WRITE_DONE' }
        }
        if (prompt.startsWith('BROWSER_NATIVE_PRESET_B_ROUTE')) return { kind: 'text', text: 'BROWSER_NATIVE_PRESET_B_ROUTE_DONE' }
        if (prompt.startsWith('BROWSER_NATIVE_PRESET_B_POLICY')) {
          if (!hasToolResult(body, 'preset-b-policy')) {
            return {
              kind: 'tool-call',
              call: {
                id: 'preset-b-policy',
                name: 'write',
                arguments: { file_path: '/dsh/home/workspace/preset-b-policy.txt', content: 'policy\n' },
              },
            }
          }
          return { kind: 'text', text: 'BROWSER_NATIVE_PRESET_B_POLICY_DONE' }
        }
        return { kind: 'text', text: `${prompt}_DONE` }
      },
    },
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: browserName })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url())
    if (!request.url().endsWith('/api/browser-native/llm')) return
    try {
      const body = JSON.parse(request.postData() ?? '{}')
      if (body.purpose === undefined) {
        requests.push({
          sessionId: body.sessionId,
          model: body.model,
          prompt: latestPrompt(body),
          tools: toolCallNames(body),
        })
      }
    } catch {}
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-test=profile-preset&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })

  const started = await workerRequest({ action: 'session-orchestration-start', agents })
  assert.equal(started.ok, true, JSON.stringify(started))
  for (const agent of agents) await rememberSessionPrincipal(page, origin, agent.sessionId)
  await waitFor(() => requests.some(request => request.prompt.startsWith('BROWSER_NATIVE_PRESET_A_HOLD')), 'Session A barrier request', 30_000)
  const bRead = await terminalFor('preset-b', 'BROWSER_NATIVE_PRESET_B_READ', 'completed')

  const aHeld = sessionRequests('preset-a')[0]
  const bBefore = sessionRequests('preset-b')[0]
  assert.ok(aHeld.tools.includes('write') && aHeld.tools.includes('edit'), `Session A must start with the full tool surface: ${JSON.stringify(aHeld.tools)}`)

  const activatedB = await workerRequest({ action: 'session-orchestration-activate', sessionId: 'preset-b' })
  assert.equal(activatedB.ok, true, JSON.stringify(activatedB))
  const pinnedPreset = await workerRequest({ action: 'profile-preset-set', sessionId: 'preset-b', preset: 'read-only' })
  assert.equal(pinnedPreset.ok, true, JSON.stringify(pinnedPreset))
  assert.deepEqual(pinnedPreset.preset.sessions, { 'preset-b': 'read-only' })
  const state = await workerRequest({ action: 'profile-preset-state' })
  assert.equal(state.ok, true, JSON.stringify(state))
  assert.equal(state.preset.global, 'full')

  const switchedRoute = await workerRequest({ action: 'session-orchestration-switch-route', sessionId: 'preset-b', provider: 'browser-native', model: 'browser-native-recovery' })
  assert.equal(switchedRoute.ok, true, JSON.stringify(switchedRoute))
  const aRoute = await workerRequest({ action: 'session-orchestration-switch-route', sessionId: 'preset-a', provider: 'browser-native', model: 'browser-native-recovery' })
  assert.equal(aRoute.ok, false)
  assert.match(aRoute.error, /MODEL_SWITCH_ACTIVE/)
  const aRunning = await workerRequest({ action: 'session-orchestration-status' })
  assert.equal(aRunning.sessionOrchestration.find(item => item.sessionId === 'preset-a').status, 'running')

  const bWritePrompt = 'BROWSER_NATIVE_PRESET_B_WRITE'
  const followed = await workerRequest({ action: 'session-orchestration-followup', sessionId: 'preset-b', prompt: bWritePrompt })
  assert.equal(followed.ok, true, JSON.stringify(followed))
  const bWrite = await terminalFor('preset-b', bWritePrompt, 'completed')
  const bWriteRequest = sessionRequests('preset-b').at(-1)
  assert.equal(bWriteRequest.tools.includes('write'), false, 'the read-only preset must withdraw write from the next request')
  assert.equal(bWriteRequest.tools.includes('edit'), false)
  assert.equal(bWriteRequest.tools.includes('bash'), false)
  const deniedWrite = toolResultFor(bWrite.session, 'preset-b-write')
  assert.equal(deniedWrite.data.message.isError, true)
  assert.match(resultContent(deniedWrite), /denied by the active profile preset/)
  assert.equal(assistantText(bWrite.session, bWrite.turn).includes('BROWSER_NATIVE_PRESET_B_WRITE_DONE'), true)
  assert.equal(requests.filter(request => request.sessionId === 'preset-a').length, 1, 'Session A must not issue a new request while held')

  const bRoutePrompt = 'BROWSER_NATIVE_PRESET_B_ROUTE'
  const routed = await workerRequest({ action: 'session-orchestration-followup', sessionId: 'preset-b', prompt: bRoutePrompt })
  assert.equal(routed.ok, true, JSON.stringify(routed))
  const bRoute = await terminalFor('preset-b', bRoutePrompt, 'completed')
  const bRouteRequest = sessionRequests('preset-b').at(-1)
  assert.equal(bRouteRequest.model, 'browser-native-recovery')
  assert.equal(bRouteRequest.tools.includes('write'), false, 'the preset must survive an idle route switch')
  assert.equal(bRoute.session.events.some(event => event.type === 'user/message' && event.data?.source?.kind === 'model-selection'), true)

  releaseA.resolve()
  const aDone = await terminalFor('preset-a', 'BROWSER_NATIVE_PRESET_A_HOLD', 'completed')
  const aContinuation = sessionRequests('preset-a').at(-1)
  assert.ok(aContinuation.tools.includes('write') && aContinuation.tools.includes('edit'), 'the running Session keeps its original tool surface')
  const aWrite = toolResultFor(aDone.session, 'preset-a-write')
  assert.equal(aWrite.data.message.isError, false)
  assert.equal(assistantText(aDone.session, aDone.turn).includes('BROWSER_NATIVE_PRESET_A_DONE'), true)
  const writtenA = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'read', path: '/dsh/home/workspace/preset-a.txt' }))
  assert.equal(writtenA?.ok, true, 'the unaffected Session must still write while another Session is read-only')

  const restoredPreset = await workerRequest({ action: 'profile-preset-set', sessionId: 'preset-b', preset: 'full' })
  assert.equal(restoredPreset.ok, true, JSON.stringify(restoredPreset))
  const policy = await workerRequest({ action: 'tool-policy-set', toolPolicy: { tools: { write: 'deny' }, default: 'allow' } })
  assert.equal(policy.ok, true, JSON.stringify(policy))
  const bPolicyPrompt = 'BROWSER_NATIVE_PRESET_B_POLICY'
  const policyFollowup = await workerRequest({ action: 'session-orchestration-followup', sessionId: 'preset-b', prompt: bPolicyPrompt })
  assert.equal(policyFollowup.ok, true, JSON.stringify(policyFollowup))
  const bPolicy = await terminalFor('preset-b', bPolicyPrompt, 'completed')
  const policyDenied = toolResultFor(bPolicy.session, 'preset-b-policy')
  assert.equal(policyDenied.data.message.isError, true)
  assert.match(resultContent(policyDenied), /denied by the profile tool policy/)
  assert.equal(bPolicy.session.events.some(event => event.type === 'tool-policy/decided'
    && event.data.callId === 'preset-b-policy' && event.data.policy === 'deny'), true)
  const restoredPolicy = await workerRequest({ action: 'tool-policy-set', toolPolicy: { tools: {}, default: 'allow' } })
  assert.equal(restoredPolicy.ok, true, JSON.stringify(restoredPolicy))

  const disposed = await workerRequest({ action: 'session-orchestration-dispose' })
  assert.deepEqual(disposed.sessionOrchestration, { disposedCount: 2, remainingCount: 0 })
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'per-session-toolset-model-route-and-approval-preset-switching',
    sessionATools: aHeld.tools.length,
    sessionBToolsBefore: bBefore.tools.length,
    sessionBToolsAfter: bWriteRequest.tools.length,
    bRouteModel: bRouteRequest.model,
    bWriteDeniedByPreset: resultContent(deniedWrite).trim(),
    bPolicyAuditEvents: bPolicy.session.events.filter(event => event.type === 'tool-policy/decided').length,
    pageErrors: pageErrors.length,
  })}\n`)
} finally {
  releaseA.resolve()
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
