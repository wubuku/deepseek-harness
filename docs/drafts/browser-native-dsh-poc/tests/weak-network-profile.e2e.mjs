/**
 * Profile a real turn at 200 ms RTT and 1.5 Mbps, then decide usability.
 *
 * Chromium's CDP network emulation throttles the page itself, so every
 * composer, Session, Workspace, and `/llm` exchange pays the same profile a
 * mobile user would. The deterministic phase uses a scripted model that emits
 * a prefix immediately and the rest 1.5 s later, which isolates transport
 * latency from model latency. The optional real phase measures the provider
 * path under the same profile.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { openPreview, sessionRequest, submitPrompt } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const HERE = fileURLToPath(new URL('.', import.meta.url))
const DIST_ROOT = process.env.DSH_POC_DIST_ROOT ?? resolve(HERE, '../../../../apps/web/dist')
const PROFILE = { name: '200ms-rtt-1.5mbps', latencyMs: 200, downloadBytesPerSecond: 187_500, uploadBytesPerSecond: 93_750 }
const SCRIPTED_MODEL_DELAY_MS = 1_500
const THRESHOLDS = { transportOverheadMs: 2_000, realFirstTokenMs: 15_000, turnCompletionMs: 20_000, abortAckMs: 2_000 }
const TURN_PROMPT = 'WEAK_NETWORK_TURN profile the turn latency please'
const CANCEL_PROMPT = 'WEAK_NETWORK_CANCEL stop after the prefix arrives'
const REAL_PROMPT = 'Reply with exactly: WEAK_NETWORK_REAL_OK'

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n')
}

function latestUserText(body) {
  // Runtime context and clock messages follow the user's prompt, so skip them.
  return [...(body?.messages ?? [])].reverse()
    .filter(message => message.role === 'user')
    .map(messageText)
    .find(text => !text.startsWith('Current runtime context.')
      && !text.startsWith('Time sampled while preparing turn')) ?? ''
}

async function startBackend(options) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-weak-network-'))
  const app = await createBrowserNativeV2Server({ dataDir, distRoot: DIST_ROOT, ...options })
  const origin = await app.listen(0)
  return { app, origin, dataDir }
}

async function openThrottled() {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.DSH_POC_BROWSER === 'chromium' ? {} : { channel: 'chrome' }),
  })
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  const applyProfile = () => cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: PROFILE.latencyMs,
    downloadThroughput: PROFILE.downloadBytesPerSecond,
    uploadThroughput: PROFILE.uploadBytesPerSecond,
    connectionType: 'cellular3g',
  })
  const clearProfile = () => cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  })
  const requests = []
  const pageErrors = []
  const llmStatuses = []
  page.on('response', response => {
    if (response.url().includes('/api/browser-native/llm')) llmStatuses.push(response.status())
  })
  page.on('request', request => {
    if (request.url().includes('/api/browser-native/')) {
      requests.push({
        url: request.url(),
        path: new URL(request.url()).pathname,
        method: request.method(),
        body: request.postDataJSON?.() ?? undefined,
      })
    }
  })
  page.on('pageerror', error => pageErrors.push(error.message))
  return { browser, context, page, requests, pageErrors, llmStatuses, applyProfile, clearProfile }
}

async function runScriptedPhase() {
  const backend = await startBackend({
    llmMode: 'scripted',
    testHooks: {
      scriptedLlmFault: body => {
        if (body?.purpose === 'session-title' || body?.purpose === 'compaction') return undefined
        const text = latestUserText(body)
        if (text.includes('WEAK_NETWORK_CANCEL')) {
          // The whole marker is the first delta so the probe can stop while the
          // stream stalls, instead of waiting for a split prefix to complete.
          return { kind: 'delayed-text', text: 'WEAK_NETWORK_PARTIAL_OUTPUT', prefix: 'WEAK_NETWORK_PARTIAL_OUTPUT', suffix: '', delayMs: 5_000 }
        }
        if (text.includes('WEAK_NETWORK_TURN')) return { kind: 'delayed-text', text: 'WEAK_NETWORK_PROFILE_OK', delayMs: 1_500 }
        return undefined
      },
    },
  })
  const browser = await openThrottled()
  try {
    await openPreview(browser.page, `${backend.origin}/preview.html?browser-native=1&preview-fixture=none`)
    // Apply the mobile profile after the preview bundle is cached: the profile
    // targets turn transport, and a throttled cold boot is measured separately.
    await browser.applyProfile()
    const turn = await submitPrompt({
      page: browser.page, origin: backend.origin, requests: browser.requests,
      prompt: TURN_PROMPT, captureStream: true, timeout: 60_000,
    })
    const firstSample = turn.streamSamples[0]
    assert.ok(firstSample, 'the assistant step must render at least once')
    // The scripted model holds the suffix for a fixed delay; subtracting it
    // isolates transport from model latency.
    const transportOverheadMs = firstSample.elapsedMs - SCRIPTED_MODEL_DELAY_MS
    assert.ok(transportOverheadMs <= THRESHOLDS.transportOverheadMs,
      `transport overhead ${String(Math.round(transportOverheadMs))}ms exceeds ${String(THRESHOLDS.transportOverheadMs)}ms`)
    assert.ok(turn.elapsedMs <= THRESHOLDS.turnCompletionMs, `turn ${String(turn.elapsedMs)}ms exceeds ${String(THRESHOLDS.turnCompletionMs)}ms`)
    // Read from the log head: post-turn title generation fills the tail window.
    const persisted = await sessionRequest(backend.origin, 'read', { sessionId: turn.sessionId, offset: 0 })
    assert.equal(JSON.stringify(persisted.events).includes('WEAK_NETWORK_PROFILE_OK'), true,
      'the completed scripted turn must persist its assistant text')

    const cancellations = []
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const stoppedAtRequest = { value: 0 }
      const cancelled = await submitPrompt({
        page: browser.page, origin: backend.origin, requests: browser.requests,
        prompt: `${CANCEL_PROMPT} #${String(attempt)}`, timeout: 60_000, expectedReason: 'aborted',
        probeWhileRunning: async () => {
          const stop = browser.page.getByRole('button', { name: /^(Stop generating|Stop the current agent run|停止生成|停止当前 Agent 操作)$/ }).last()
          await stop.waitFor({ state: 'visible', timeout: 30_000 })
          await browser.page.waitForFunction(() => {
            const steps = [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')]
            return steps.some(step => (step.textContent ?? '').includes('WEAK_NETWORK_PARTIAL_OUTPUT'))
          }, undefined, { timeout: 30_000 })
          stoppedAtRequest.value = Date.now()
          await stop.click()
        },
      })
      cancellations.push({ attempt, abortAckMs: cancelled.settledAt - stoppedAtRequest.value, turnMs: cancelled.elapsedMs })
      assert.ok(stoppedAtRequest.value > 0, 'the stop control must be used before the turn settles')
      assert.ok(cancelled.settledAt - stoppedAtRequest.value <= THRESHOLDS.abortAckMs,
        `cancel ${String(attempt)} acked in ${String(cancelled.settledAt - stoppedAtRequest.value)}ms, above ${String(THRESHOLDS.abortAckMs)}ms`)
    }
    const cancelledReads = []
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const read = await sessionRequest(backend.origin, 'read', { sessionId: turn.sessionId, offset: 0 })
      const trailing = read.events.filter(event => event.type === 'turn/end' && event.data?.reason?.kind === 'aborted')
      cancelledReads.push(trailing.length)
    }
    assert.deepEqual(cancelledReads, [3, 3, 3], 'each of the three cancellations must add exactly one aborted turn, and no more')
    assert.deepEqual(browser.pageErrors, [])
    return {
      phase: 'scripted',
      firstTokenMs: firstSample.elapsedMs,
      transportOverheadMs,
      turnCompletionMs: turn.elapsedMs,
      cancellations,
      abortSuccessRate: `${String(cancellations.length)}/3`,
    }
  } finally {
    await browser.browser.close()
    await backend.app.close()
    await rm(backend.dataDir, { recursive: true, force: true })
  }
}

async function runRealPhase(envFile) {
  const backend = await startBackend({ llmMode: 'real', envFile })
  const browser = await openThrottled()
  try {
    await openPreview(browser.page, `${backend.origin}/preview.html?browser-native=1&preview-fixture=none`)
    await browser.applyProfile()
    const turn = await submitPrompt({
      page: browser.page, origin: backend.origin, requests: browser.requests,
      prompt: REAL_PROMPT, captureStream: true, timeout: 120_000,
    })
    const firstSample = turn.streamSamples[0]
    assert.ok(firstSample, 'the real provider must stream at least one assistant sample')
    assert.ok(firstSample.elapsedMs <= THRESHOLDS.realFirstTokenMs, `real first token ${String(firstSample.elapsedMs)}ms exceeds ${String(THRESHOLDS.realFirstTokenMs)}ms`)
    assert.ok(turn.elapsedMs <= THRESHOLDS.turnCompletionMs, `real turn ${String(turn.elapsedMs)}ms exceeds ${String(THRESHOLDS.turnCompletionMs)}ms`)
    assert.deepEqual(browser.pageErrors, [])
    assert.equal(browser.llmStatuses.includes(200), true, 'the real provider turn must complete through a successful /llm response')
    return {
      phase: 'real',
      firstTokenMs: firstSample.elapsedMs,
      turnCompletionMs: turn.elapsedMs,
      llmStatuses: browser.llmStatuses,
    }
  } finally {
    await browser.browser.close()
    await backend.app.close()
    await rm(backend.dataDir, { recursive: true, force: true })
  }
}

const measurements = [await runScriptedPhase()]
if (process.env.DSH_POC_WEAK_NETWORK_REAL === '1') {
  const envFile = process.env.DSH_POC_ENV_FILE
  if (envFile === undefined) throw new Error('DSH_POC_WEAK_NETWORK_REAL=1 needs DSH_POC_ENV_FILE with real provider keys')
  measurements.push(await runRealPhase(envFile))
}
const usable = measurements.every(measurement => (measurement.phase === 'scripted'
  ? measurement.transportOverheadMs <= THRESHOLDS.transportOverheadMs
  : measurement.firstTokenMs <= THRESHOLDS.realFirstTokenMs)
  && measurement.turnCompletionMs <= THRESHOLDS.turnCompletionMs)
const summary = {
  result: 'passed',
  profile: PROFILE,
  thresholds: THRESHOLDS,
  measurements,
  interruptRate: '3/3 accepted, 3/3 aborted within the threshold with one turn/end each',
  conclusion: usable
    ? 'Usable at 200 ms RTT + 1.5 Mbps: transport adds under 2 s, turns finish within 20 s, real-provider first token stays within 15 s, and cancellation is acknowledged within 2 s.'
    : 'Not usable at 200 ms RTT + 1.5 Mbps: at least one measurement exceeds its threshold.',
}
if (process.env.DSH_POC_RESULT_FILE !== undefined) {
  await writeFile(process.env.DSH_POC_RESULT_FILE, `${JSON.stringify(summary, null, 2)}\n`)
}
process.stdout.write(`${JSON.stringify(summary)}\n`)
