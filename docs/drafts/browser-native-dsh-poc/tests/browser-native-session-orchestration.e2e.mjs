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
if (browserName !== 'chrome') throw new Error('Session orchestration validation runs only in Chrome')

const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-session-orchestration-')))
const agents = [
  { sessionId: 'orchestration-a', prompt: 'BROWSER_NATIVE_ORCHESTRATION_A', model: 'browser-native-a' },
  { sessionId: 'orchestration-b', prompt: 'BROWSER_NATIVE_ORCHESTRATION_B', model: 'browser-native-b' },
  { sessionId: 'orchestration-c', prompt: 'BROWSER_NATIVE_ORCHESTRATION_C', model: 'browser-native-c' },
]
const barriers = new Map(agents.map(agent => [agent.sessionId, Promise.withResolvers()]))
const requests = []
const pageErrors = []
const workerErrors = []
const externalRequests = []
let image
let app
let browser
let page
let origin

function latestPrompt(body) {
  return [...(body.messages ?? [])].reverse().find(message => message.role === 'user'
    && typeof message.content === 'string'
    && !message.content.startsWith('Current runtime context.')
    && !message.content.startsWith('[model changed:'))?.content ?? ''
}

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

function eventSourceKind(event) {
  return event.data?.source?.kind ?? event.data?.message?.source?.kind
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

async function terminalFor(sessionId, prompt, reason = undefined) {
  let latest
  try {
    return await waitFor(async () => {
    const session = await readSession(sessionId)
    latest = session
    const userIndex = session.events.findLastIndex(event => event.type === 'user/message' && eventText(event) === prompt)
    const terminal = session.events.findLast((event, index) => index > userIndex && event.type === 'turn/end')
    if (terminal === undefined) return undefined
    if (reason !== undefined && terminal.data.reason.kind !== reason) return undefined
    return { session, terminal }
    }, `terminal event for ${sessionId}:${prompt}`, 45_000)
  } catch (error) {
    const summary = latest?.events.map(event => event.type === 'turn/end'
      ? { type: event.type, turn: event.data.turn, reason: event.data.reason }
      : { type: event.type, turn: event.data?.turn })
    throw new Error(`${error instanceof Error ? error.message : String(error)}; session=${JSON.stringify(summary)}; requests=${JSON.stringify(requests.filter(request => request.sessionId === sessionId))}`)
  }
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser-session-orchestration' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: {
      scriptedLlmFault: body => {
        const prompt = latestPrompt(body)
        if (body.model === 'browser-native-fail' && prompt.includes('BROWSER_NATIVE_ORCHESTRATION_FAIL')) {
          return { kind: 'partial-text', code: 'UPSTREAM_LLM_TRUNCATED', text: 'ORCHESTRATION_FAILURE_PREFIX' }
        }
        if (body.model === 'browser-native-recovery' && prompt.includes('BROWSER_NATIVE_ORCHESTRATION_RECOVERY')) {
          return { kind: 'text', text: 'BROWSER_NATIVE_ORCHESTRATION_RECOVERY_DONE' }
        }
        const agent = agents.find(candidate => body.sessionId === candidate.sessionId && prompt.includes(candidate.prompt))
        if (agent !== undefined) {
          return {
            kind: 'barrier-text',
            release: barriers.get(agent.sessionId).promise,
            text: `${agent.prompt}_DONE`,
          }
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
      if (body.purpose === undefined) requests.push({ sessionId: body.sessionId, model: body.model, prompt: latestPrompt(body) })
    } catch {}
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-test=session-orchestration&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })

  const started = await workerRequest({ action: 'session-orchestration-start', agents })
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.equal(started.sessionOrchestration.startedCount, 3)
  for (const agent of agents) await rememberSessionPrincipal(page, origin, agent.sessionId)
  await waitFor(() => requests.filter(request => agents.some(agent => agent.sessionId === request.sessionId)).length === 3,
    'three orchestration model barriers', 30_000)

  const initial = await workerRequest({ action: 'session-orchestration-status' })
  assert.equal(initial.ok, true, JSON.stringify(initial))
  assert.deepEqual(initial.sessionOrchestration.map(item => ({ sessionId: item.sessionId, view: item.mount.view, status: item.status })), [
    { sessionId: 'orchestration-a', view: 'active', status: 'running' },
    { sessionId: 'orchestration-b', view: 'parked', status: 'running' },
    { sessionId: 'orchestration-c', view: 'parked', status: 'running' },
  ])
  const parked = await workerRequest({ action: 'session-orchestration-park', sessionId: 'orchestration-a' })
  const activated = await workerRequest({ action: 'session-orchestration-activate', sessionId: 'orchestration-b' })
  assert.equal(parked.ok, true, JSON.stringify(parked))
  assert.equal(activated.ok, true, JSON.stringify(activated))
  assert.equal(activated.sessionOrchestration.view, 'active')
  const switched = await workerRequest({ action: 'session-orchestration-switch-route', sessionId: 'orchestration-c', provider: 'browser-native', model: 'browser-native-new' })
  assert.equal(switched.ok, false)
  assert.match(switched.error, /MODEL_SWITCH_ACTIVE/)

  const stopped = await workerRequest({ action: 'session-orchestration-cancel', sessionId: 'orchestration-a' })
  assert.equal(stopped.ok, true, JSON.stringify(stopped))
  barriers.get('orchestration-a').resolve()
  barriers.get('orchestration-b').resolve()
  barriers.get('orchestration-c').resolve()
  const aDone = await terminalFor('orchestration-a', agents[0].prompt, 'aborted')
  const bDone = await terminalFor('orchestration-b', agents[1].prompt, 'completed')
  const cDone = await terminalFor('orchestration-c', agents[2].prompt, 'completed')
  assert.equal(aDone.session.events.filter(event => event.type === 'assistant/message').some(event => eventText(event).includes('ORCHESTRATION_A_DONE')), false)
  assert.equal(bDone.session.events.filter(event => event.type === 'assistant/message').some(event => eventText(event).includes('ORCHESTRATION_B_DONE')), true)
  assert.equal(cDone.session.events.filter(event => event.type === 'assistant/message').some(event => eventText(event).includes('ORCHESTRATION_C_DONE')), true)

  const switchedToFailure = await workerRequest({ action: 'session-orchestration-switch-route', sessionId: 'orchestration-b', provider: 'browser-native', model: 'browser-native-fail' })
  assert.equal(switchedToFailure.ok, true, JSON.stringify(switchedToFailure))
  const failedPrompt = 'BROWSER_NATIVE_ORCHESTRATION_FAIL：显式失败 route。'
  const failureFollowup = await workerRequest({ action: 'session-orchestration-followup', sessionId: 'orchestration-b', prompt: failedPrompt })
  assert.equal(failureFollowup.ok, true, JSON.stringify(failureFollowup))
  const failed = await terminalFor('orchestration-b', failedPrompt, 'error')
  assert.equal(requests.filter(request => request.sessionId === 'orchestration-b' && request.model === 'browser-native-fail' && request.prompt === failedPrompt).length, 1)

  const switchedToRecovery = await workerRequest({ action: 'session-orchestration-switch-route', sessionId: 'orchestration-b', provider: 'browser-native', model: 'browser-native-recovery' })
  assert.equal(switchedToRecovery.ok, true, JSON.stringify(switchedToRecovery))
  const recoveryPrompt = 'BROWSER_NATIVE_ORCHESTRATION_RECOVERY：失败后显式继续。'
  const recoveryFollowup = await workerRequest({ action: 'session-orchestration-followup', sessionId: 'orchestration-b', prompt: recoveryPrompt })
  assert.equal(recoveryFollowup.ok, true, JSON.stringify(recoveryFollowup))
  const recovered = await terminalFor('orchestration-b', recoveryPrompt, 'completed')
  assert.equal(requests.filter(request => request.sessionId === 'orchestration-b' && request.model === 'browser-native-recovery' && request.prompt === recoveryPrompt).length, 1)
  assert.equal(recovered.session.events.some(event => event.type === 'user/message' && eventSourceKind(event) === 'model-selection'), true)
  assert.equal(failed.session.events.filter(event => event.type === 'user/message' && eventText(event) === failedPrompt).length, 1)

  const disposed = await workerRequest({ action: 'session-orchestration-dispose' })
  assert.deepEqual(disposed.sessionOrchestration, { disposedCount: 3, remainingCount: 0 })
  const overAdmission = await workerRequest({
    action: 'session-orchestration-start',
    agents: [...agents, { sessionId: 'orchestration-e', prompt: 'BROWSER_NATIVE_ORCHESTRATION_E' }, { sessionId: 'orchestration-f', prompt: 'BROWSER_NATIVE_ORCHESTRATION_F' }],
  })
  assert.equal(overAdmission.ok, false)
  assert.match(overAdmission.error, /accepts 1 to 4 Agents/)
  assert.deepEqual((await workerRequest({ action: 'session-orchestration-status' })).sessionOrchestration, [])
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'single-worker-session-orchestration-park-targeted-stop-route-switch-and-admission',
    workerCount: await page.evaluate(() => window.__dshBrowserWorkers?.length ?? 1),
    sessionIds: agents.map(agent => agent.sessionId),
    modelRequests: requests,
    failedTurn: failed.terminal.data.turn,
    recoveryTurn: recovered.terminal.data.turn,
    pageErrors,
    workerErrors,
    externalRequests,
  })}\n`)
} finally {
  for (const barrier of barriers.values()) barrier.resolve()
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
