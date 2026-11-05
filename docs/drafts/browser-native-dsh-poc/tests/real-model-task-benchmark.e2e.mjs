/**
 * Real-model task benchmark for the Browser-Native PoC.
 *
 * Runs one fixed ten-task set against a real provider twice: once through the
 * shipped Web Worker harness and once through the durable server host. Each
 * task records provider-reported tokens, model requests, session steps, approval
 * interactions, end-to-end duration, and a failure class so a miss is
 * attributable to the model, a tool, or the harness itself.
 *
 * Usage:
 *   DSH_POC_ENV_FILE=docs/drafts/.env \
 *     node docs/drafts/browser-native-dsh-poc/tests/real-model-task-benchmark.e2e.mjs
 *
 * Environment:
 *   DSH_POC_BENCH_PROVIDER   longcat (default) or minimax
 *   DSH_POC_BENCH_MODES      browser,durable (default: both)
 *   DSH_POC_BENCH_TASKS      comma-separated task ids; default: all
 *   DSH_POC_BENCH_OUTPUT     result JSON path
 *   DSH_POC_BENCH_TURN_TIMEOUT_MS  per-turn provider budget
 *   DSH_POC_INPUT_PRICE_PER_MTOK / DSH_POC_OUTPUT_PRICE_PER_MTOK  optional USD rates
 */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { buildUsageReport, normalizeUsagePricing } from '../usage-report.mjs'
import {
  assistantText, openPreview, sessionRequest, submitPrompt, waitFor,
} from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const here = fileURLToPath(import.meta.url)
const envFile = process.env.DSH_POC_ENV_FILE
if (envFile === undefined) throw new Error('real-model task benchmark needs DSH_POC_ENV_FILE')
const envText = await readFile(envFile, 'utf8')
function envValue(name) {
  return envText.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim()
}

const providerSelection = process.env.DSH_POC_BENCH_PROVIDER ?? 'longcat'
const provider = providerSelection === 'minimax'
  ? {
      kind: 'anthropic',
      model: envValue('ANTHROPIC_MODEL'),
      baseUrl: envValue('ANTHROPIC_BASE_URL'),
      completionsPath: undefined,
      apiKey: envValue('ANTHROPIC_API_KEY'),
      keyVariable: 'ANTHROPIC_API_KEY',
    }
  : providerSelection === 'longcat'
    ? {
        kind: 'openai',
        model: envValue('OPENAI_MODEL'),
        baseUrl: envValue('OPENAI_BASE_URL'),
        completionsPath: 'v1/chat/completions',
        apiKey: envValue('OPENAI_API_KEY'),
        keyVariable: 'OPENAI_API_KEY',
      }
    : undefined
if (provider === undefined) throw new Error('DSH_POC_BENCH_PROVIDER must be longcat or minimax')
for (const [label, value] of [['model', provider.model], ['base URL', provider.baseUrl], [provider.keyVariable, provider.apiKey]]) {
  if (value === undefined || value === '') throw new Error(`${provider.keyVariable} environment is required for ${providerSelection} (${label} missing)`)
}
const model = provider.model

const turnTimeoutMs = Number(process.env.DSH_POC_BENCH_TURN_TIMEOUT_MS ?? 240_000)
const selectedModes = (process.env.DSH_POC_BENCH_MODES ?? 'browser,durable')
  .split(',').map(value => value.trim()).filter(Boolean)
for (const mode of selectedModes) {
  if (mode !== 'browser' && mode !== 'durable') throw new Error(`unknown benchmark mode ${mode}`)
}
const outputPath = process.env.DSH_POC_BENCH_OUTPUT
  ?? fileURLToPath(new URL('../real-model-task-benchmark-results.json', import.meta.url))
const selectedTasks = process.env.DSH_POC_BENCH_TASKS === undefined
  ? undefined
  : new Set(process.env.DSH_POC_BENCH_TASKS.split(',').map(value => value.trim()).filter(Boolean))
function optionalNumber(value) {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const inputPrice = optionalNumber(envValue('DSH_POC_INPUT_PRICE_PER_MTOK'))
const outputPrice = optionalNumber(envValue('DSH_POC_OUTPUT_PRICE_PER_MTOK'))
const pricing = inputPrice !== undefined && outputPrice !== undefined
  ? normalizeUsagePricing({ inputUsdPer1M: inputPrice, outputUsdPer1M: outputPrice })
  : undefined

const WORKSPACE = '/dsh/home/workspace'
const PREVIEW_QUERY = 'browser-native=1&browser-native-durable=1&browser-native-test=subagent&preview-fixture=none'
const FIXTURE_ROOT = { browser: '/dsh/home/browser-validation', durable: '/dsh/home/workspace/browser-validation' }

function resultPath(name) {
  return `${WORKSPACE}/bench/${name}`
}

function renderPrompt(prompt, mode) {
  return prompt.replaceAll('{fixture}', FIXTURE_ROOT[mode])
}

function promptFor(parts) {
  return parts.join(' ')
}

const tasks = [
  {
    id: 't1-read-write',
    label: 'Read a fixture file and write one derived line',
    capability: 'read + write',
    prompts: [promptFor([
      'Read {fixture}/input.txt, then write ' + resultPath('echo.txt') + ' containing exactly the line that starts with "fixture=".',
      'Do not use any other tool. After the write succeeds, reply with exactly BENCH_T1_DONE and nothing else.',
    ])],
    verify: observation => {
      const read = lastToolResult(observation.session, 'read')
      const write = lastToolCall(observation.session, 'write')
      if (write === undefined) return fail('model', 'the model never called write')
      if (resultError(write)) return fail('tool', `write failed: ${resultError(write)}`)
      if (read === undefined || read.isError === true) return fail('tool', 'the fixture read failed before the write')
      if (!observation.finalText.includes('BENCH_T1_DONE')) return fail('model', 'the final reply missed BENCH_T1_DONE')
      const content = observation.files[resultPath('echo.txt')]
      if (content?.ok !== true) return fail('harness', `workspace read-back failed: ${JSON.stringify(content)}`)
      if (content.content.trim() !== 'fixture=VFS_INPUT_READY') return fail('model', `wrote ${JSON.stringify(content.content)}, expected the fixture line`)
      return pass('file derived and written')
    },
  },
  {
    id: 't2-search',
    label: 'Locate a line across the workspace',
    capability: 'workspace search',
    prompts: [promptFor([
      `Create ${resultPath('search-index.txt')} with exactly three lines: "alpha", "scale-fixture-line-0007 marker", "omega".`,
      'Then search the workspace for scale-fixture-line-0007 and reply with the file path that contains it and the exact matching line, ending with BENCH_T2_DONE.',
    ])],
    verify: observation => {
      const search = lastToolResult(observation.session, 'grep') ?? lastToolResult(observation.session, 'glob')
      if (search === undefined) return fail('model', 'the model never called grep or glob')
      if (search.isError === true) return fail('tool', `search failed: ${search.text}`)
      if (!observation.finalText.includes('bench/search-index.txt')) return fail('model', 'the reply missed the containing file')
      if (!observation.finalText.includes('scale-fixture-line-0007')) return fail('model', 'the reply missed the matched marker')
      if (!observation.finalText.includes('BENCH_T2_DONE')) return fail('model', 'the final reply missed BENCH_T2_DONE')
      return pass('search located the marker')
    },
  },
  {
    id: 't3-write-edit',
    label: 'Create a file and replace one word',
    capability: 'edit',
    prompts: [promptFor([
      `Create ${resultPath('notes.txt')} with content "alpha beta", then edit it so "beta" becomes "gamma".`,
      'Reply with exactly BENCH_T3_DONE and nothing else.',
    ])],
    verify: observation => {
      const write = lastToolCall(observation.session, 'write')
      if (write === undefined || resultError(write)) return fail('tool', `initial write failed: ${write === undefined ? 'missing' : resultError(write)}`)
      const edit = lastToolCall(observation.session, 'edit')
      if (edit === undefined) return fail('model', 'the model never called edit')
      if (resultError(edit)) return fail('tool', `edit failed: ${resultError(edit)}`)
      if (!observation.finalText.includes('BENCH_T3_DONE')) return fail('model', 'the final reply missed BENCH_T3_DONE')
      const content = observation.files[resultPath('notes.txt')]
      if (content?.ok !== true) return fail('harness', `workspace read-back failed: ${JSON.stringify(content)}`)
      if (!content.content.includes('alpha gamma')) return fail('model', `edited content is ${JSON.stringify(content.content)}`)
      return pass('edit applied')
    },
  },
  {
    id: 't4-multifile',
    label: 'Create two small files in one turn',
    capability: 'write',
    prompts: [promptFor([
      `Create exactly two files: ${resultPath('a.txt')} with content "A" and ${resultPath('b.txt')} with content "B".`,
      'Do not use any other tool. Reply with exactly BENCH_T4_DONE and nothing else.',
    ])],
    verify: observation => {
      const writes = toolCalls(observation.session).filter(call => call.name === 'write')
      if (writes.length < 2) return fail('model', `the model made ${String(writes.length)} write calls`)
      const failedWrite = writes.find(call => resultError(call) !== undefined)
      if (failedWrite !== undefined) return fail('tool', `write failed: ${resultError(failedWrite)}`)
      if (!observation.finalText.includes('BENCH_T4_DONE')) return fail('model', 'the final reply missed BENCH_T4_DONE')
      for (const [name, expected] of [['a.txt', 'A'], ['b.txt', 'B']]) {
        const content = observation.files[resultPath(name)]
        if (content?.ok !== true) return fail('harness', `workspace read-back failed for ${name}: ${JSON.stringify(content)}`)
        if (content.content.trim() !== expected) return fail('model', `${name} is ${JSON.stringify(content.content)}, expected ${expected}`)
      }
      return pass('two files written')
    },
  },
  {
    id: 't5-subagent',
    label: 'Delegate one step to a subagent',
    capability: 'subagent',
    prompts: [promptFor([
      'Use the subagent tool exactly once with this child prompt: "Reply with exactly CHILD_OK and nothing else".',
      'After the subagent returns, reply with exactly BENCH_T5_PARENT_DONE and nothing else.',
    ])],
    verify: observation => {
      const call = lastToolCall(observation.session, 'subagent')
      if (call === undefined) return fail('model', `the model never called subagent; calls=${callNames(observation.session)}`)
      if (resultError(call) !== undefined) return fail('tool', `subagent failed: ${resultError(call)}`)
      if (!observation.finalText.includes('BENCH_T5_PARENT_DONE')) return fail('model', 'the parent reply missed BENCH_T5_PARENT_DONE')
      return pass('subagent delegated')
    },
  },
  {
    id: 't6-cross-turn',
    label: 'Modify a file across two user turns',
    capability: 'cross-turn edit',
    prompts: [
      promptFor([
        `Write ${resultPath('config.txt')} with content "value=1".`,
        'Reply with exactly BENCH_T6_TURN1_DONE and nothing else.',
      ]),
      promptFor([
        `Read ${resultPath('config.txt')}, then change its value to "value=2" while keeping the same format.`,
        'Reply with exactly BENCH_T6_TURN2_DONE and nothing else.',
      ]),
    ],
    verify: observation => {
      const writes = toolCalls(observation.session).filter(call => call.name === 'write')
      const read = lastToolResult(observation.session, 'read')
      if (writes.length === 0) return fail('model', 'the model never wrote config.txt')
      const failedWrite = writes.find(call => resultError(call) !== undefined)
      if (failedWrite !== undefined) return fail('tool', `write failed: ${resultError(failedWrite)}`)
      if (read === undefined || read.isError === true) return fail('tool', 'the second turn did not read config.txt successfully')
      if (!observation.finalText.includes('BENCH_T6_TURN2_DONE')) return fail('model', 'the second turn reply missed BENCH_T6_TURN2_DONE')
      const content = observation.files[resultPath('config.txt')]
      if (content?.ok !== true) return fail('harness', `workspace read-back failed: ${JSON.stringify(content)}`)
      if (content.content.trim() !== 'value=2') return fail('model', `config.txt is ${JSON.stringify(content.content)}`)
      return pass('cross-turn edit applied')
    },
  },
  {
    id: 't7-export',
    label: 'Produce a result and export the Session',
    capability: 'session export',
    prompts: [promptFor([
      `Write ${resultPath('summary.json')} containing exactly {"files":["input.txt","scale-input.txt"],"status":"ok"}.`,
      'Reply with exactly BENCH_T7_DONE and nothing else.',
    ])],
    verify: observation => {
      const write = lastToolCall(observation.session, 'write')
      if (write === undefined) return fail('model', 'the model never wrote summary.json')
      if (resultError(write) !== undefined) return fail('tool', `write failed: ${resultError(write)}`)
      if (!observation.finalText.includes('BENCH_T7_DONE')) return fail('model', 'the final reply missed BENCH_T7_DONE')
      if (observation.exportResult?.status !== 200) {
        return fail('harness', `session export returned ${String(observation.exportResult?.status)}`, 'session-export')
      }
      const events = observation.exportResult.body?.session?.events
      if (!Array.isArray(events) || events.length === 0) return fail('harness', 'the exported bundle carried no Session events', 'session-export')
      return pass(`exported ${String(JSON.stringify(observation.exportResult.body).length)} bytes with ${String(events.length)} events`)
    },
  },
  {
    id: 't8-approval',
    label: 'Approve one workspace write',
    capability: 'approval',
    prompts: [promptFor([
      `Write ${resultPath('approval.txt')} with content "APPROVAL_OK".`,
      'Reply with exactly BENCH_T8_DONE and nothing else.',
    ])],
    verify: observation => {
      const write = lastToolCall(observation.session, 'write')
      if (write === undefined) return fail('model', 'the model never called write')
      if (resultError(write) !== undefined) return fail('tool', `write failed: ${resultError(write)}`)
      if (observation.approvals.length === 0) return fail('harness', 'the write completed without any approval request', 'approval')
      if (!observation.finalText.includes('BENCH_T8_DONE')) return fail('model', 'the final reply missed BENCH_T8_DONE')
      return pass(`${String(observation.approvals.length)} approval(s), latency ${String(observation.approvalLatencyMs)} ms`)
    },
  },
  {
    id: 't9-missing-recovery',
    label: 'Recover from a missing file',
    capability: 'tool error recovery',
    prompts: [promptFor([
      `Read ${resultPath('missing-t9.txt')}. If it does not exist, create it with content "BENCH_MISSING".`,
      'Reply with exactly BENCH_T9_DONE and nothing else.',
    ])],
    verify: observation => {
      const read = lastToolResult(observation.session, 'read')
      const write = lastToolCall(observation.session, 'write')
      if (read === undefined) return fail('model', 'the model never called read')
      if (read.isError !== true) return fail('model', 'the missing read did not produce the expected tool error')
      if (write === undefined) return fail('model', 'the model never recovered with a write')
      if (resultError(write) !== undefined) return fail('tool', `recovery write failed: ${resultError(write)}`)
      if (!observation.finalText.includes('BENCH_T9_DONE')) return fail('model', 'the final reply missed BENCH_T9_DONE')
      const content = observation.files[resultPath('missing-t9.txt')]
      if (content?.ok !== true) return fail('harness', `workspace read-back failed: ${JSON.stringify(content)}`)
      if (content.content.trim() !== 'BENCH_MISSING') return fail('model', `recovery content is ${JSON.stringify(content.content)}`)
      return pass('read error surfaced and recovered')
    },
  },
  {
    id: 't10-summarize',
    label: 'Read two files and summarize them',
    capability: 'read',
    prompts: [promptFor([
      'Read both {fixture}/input.txt and {fixture}/scale-input.txt.',
      'Then reply with both file names and one short sentence about each. End with BENCH_T10_DONE.',
    ])],
    verify: observation => {
      const reads = toolCalls(observation.session).filter(call => call.name === 'read')
      if (reads.length < 2) return fail('model', `the model made ${String(reads.length)} read calls`)
      const failedRead = reads.find(call => resultError(call) !== undefined)
      if (failedRead !== undefined) return fail('tool', `read failed: ${resultError(failedRead)}`)
      for (const name of ['input.txt', 'scale-input.txt']) {
        if (!observation.finalText.includes(name)) return fail('model', `the summary missed ${name}`)
      }
      if (!observation.finalText.includes('BENCH_T10_DONE')) return fail('model', 'the final reply missed BENCH_T10_DONE')
      return pass('both files summarized')
    },
  },
]

function pass(detail) {
  return { passed: true, detail }
}

function fail(failureClass, detail, capability) {
  return { passed: false, failureClass, detail, ...(capability === undefined ? {} : { capability }) }
}

function events(session, type) {
  return (session.events ?? []).filter(event => event.type === type)
}

function toolCalls(session) {
  return events(session, 'tool/call').map(event => {
    const result = events(session, 'tool/result')
      .find(candidate => String(candidate.data.message?.toolCallId) === String(event.data.callId))
    return {
      name: event.data.name,
      callId: event.data.callId,
      arguments: event.data.arguments,
      result,
      resultText: result === undefined ? undefined : messageText(result.data.message),
      resultError: result?.data.message?.isError === true ? messageText(result.data.message) : undefined,
    }
  })
}

function lastToolCall(session, name) {
  return toolCalls(session).findLast(call => call.name === name)
}

function lastToolResult(session, name) {
  const call = lastToolCall(session, name)
  if (call === undefined || call.result === undefined) return undefined
  return { isError: call.result.data.message?.isError === true, text: call.resultText, call }
}

function resultError(call) {
  return call.resultError
}

function callNames(session) {
  const names = [...new Set(toolCalls(session).map(call => call.name))]
  return names.length === 0 ? 'none' : names.join(',')
}

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => block?.type === 'text' ? block.text : JSON.stringify(block)).join('')
}

function countSteps(session) {
  return events(session, 'step/start').length
}

function lastTurnReason(session) {
  const terminal = events(session, 'turn/end').at(-1)
  return terminal?.data.reason ?? null
}

function harnessTurnError(session) {
  const reason = lastTurnReason(session)
  if (reason?.kind !== 'error') return undefined
  const message = reason.error?.message ?? JSON.stringify(reason.error)
  return `the turn ended with a harness error: ${message}${reason.error?.code === undefined ? '' : ` (${reason.error.code})`}`
}

async function usageEntries(origin) {
  const response = await fetch(`${origin}/api/browser-native/usage-audit`)
  assert.equal(response.status, 200, 'usage audit requires real-LLM mode')
  return (await response.json()).entries
}

function usageDelta(before, after) {
  const entries = after.slice(before.length)
  const report = buildUsageReport(entries, { pricing, model, now: Date.now() })
  return {
    reports: report.totals,
    inputTokens: report.totals.inputTokens,
    outputTokens: report.totals.outputTokens,
    totalTokens: report.totals.totalTokens,
    costUsd: report.totals.costUsd,
    requests: report.totals.requests,
    components: entries.map(entry => entry.purpose ?? 'turn'),
    requestSizes: entries.map(entry => entry.request).filter(request => request !== undefined),
  }
}

async function readDurableFiles(origin, cookie, workspaceId, paths) {
  const query = `protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`
  const response = await fetch(`${origin}/api/browser-native/workspace/manifest?${query}`, { headers: { cookie } })
  assert.equal(response.status, 200, 'durable manifest read-back must succeed')
  const entries = (await response.json()).entries ?? []
  const files = {}
  for (const absolute of paths) {
    const relative = absolute.startsWith(`${WORKSPACE}/`) ? absolute.slice(WORKSPACE.length + 1) : absolute
    const entry = entries.find(candidate => candidate.path === relative && candidate.kind === 'file')
    if (entry === undefined) {
      files[absolute] = { ok: false, error: 'not in manifest' }
      continue
    }
    const blob = await fetch(`${origin}/api/browser-native/workspace/blob/${entry.hash}?${query}`, { headers: { cookie } })
    files[absolute] = blob.ok ? { ok: true, content: await blob.text() } : { ok: false, error: `HTTP ${String(blob.status)}` }
  }
  return files
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

async function browserPageCookie(context) {
  return (await context.cookies()).map(entry => `${entry.name}=${entry.value}`).join('; ')
}

async function browserWorkspaceId(origin, cookie) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`, { headers: { cookie } })
  assert.equal(response.status, 200, 'workspace identity must resolve for export')
  return (await response.json()).workspaceId
}

async function exportSession(origin, cookie, workspaceId, sessionId) {
  const response = await fetch(`${origin}/api/browser-native/session/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), workspaceId, sessionId }),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

async function readBrowserFiles(page, paths) {
  const files = {}
  for (const path of paths) {
    files[path] = await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), { action: 'read', path })
      .catch(error => ({ ok: false, error: String(error) }))
  }
  return files
}

async function answerApprovals({ page, origin, sessionId, timeout, approvals }) {
  const deadline = Date.now() + timeout
  const seen = new Set()
  let submittedUserSeq
  let quietPolls = 0
  while (Date.now() < deadline) {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    submittedUserSeq ??= events(session, 'user/message').at(-1)?.seq
    const asked = events(session, 'approval/asked')
    let handled = false
    for (const event of asked) {
      if (submittedUserSeq !== undefined && event.seq <= submittedUserSeq) continue
      const id = String(event.data.id)
      if (seen.has(id)) continue
      seen.add(id)
      quietPolls = 0
      const requestedAt = Date.now()
      const card = page.locator('[data-approval-key]')
      await waitFor(async () => {
        if (await card.count() !== 1) return undefined
        const text = await card.innerText()
        return text.length > 0 ? text : undefined
      }, 'visible approval card', 60_000)
      const cardText = await card.innerText()
      approvals.push({ name: event.data.toolName ?? event.data.name, callId: event.data.callId, cardText, requestedAt })
      await card.getByRole('button', { name: /^(Allow once|允许一次)$/ }).click({ timeout: 20_000 })
      approvals.at(-1).decidedAt = Date.now()
      handled = true
    }
    const terminal = submittedUserSeq === undefined
      ? false
      : events(session, 'turn/end').some(event => event.seq > submittedUserSeq)
    if (terminal && !handled) {
      quietPolls += 1
      if (quietPolls >= 2) return
    } else if (!handled) {
      quietPolls = 0
    }
    await delay(150)
  }
  throw new Error('timed out waiting for the browser turn to settle')
}

/**
 * Run the task set through the Web Worker harness.
 * @returns {Promise<object>} Mode report with per-task results.
 */
async function runBrowserMode() {
  const startedAt = Date.now()
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-bench-browser-'))
  const image = await createRuntimeValidationDist({ roster: 'browser-benchmark' })
  const app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'real',
    llmProviderKind: provider.kind,
    envFile,
    model: provider.model,
    llmBaseUrl: provider.baseUrl,
    ...(provider.completionsPath === undefined ? {} : { llmCompletionsPath: provider.completionsPath }),
    llmApiKey: provider.apiKey,
    llmTimeoutMs: turnTimeoutMs,
    llmIncludeUsage: true,
  })
  const origin = await app.listen(0)
  const browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  const results = []
  try {
    for (const task of selectedTasksForMode()) {
      const taskStartedAt = Date.now()
      const usageBefore = await usageEntries(origin)
      const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
      const page = await context.newPage()
      const requestLog = []
      const pageErrors = []
      page.on('pageerror', error => pageErrors.push(error.message))
      page.on('request', request => {
        const url = new URL(request.url())
        if (url.origin !== origin || !url.pathname.startsWith('/api/browser-native/')) return
        let body = {}
        try { body = request.postDataJSON() ?? {} } catch {}
        requestLog.push({ path: url.pathname, body })
      })
      let sessionId
      let bootMs
      let interactionStartedAt = taskStartedAt
      let session
      const approvals = []
      let exportResult
      let files = {}
      let failure
      try {
        const bootStarted = Date.now()
        await openPreview(page, `${origin}/preview.html?${PREVIEW_QUERY}`)
        await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
        bootMs = Date.now() - bootStarted
        interactionStartedAt = Date.now()
        for (const prompt of task.prompts) {
          const submitted = await submitPrompt({
            page, origin, requests: requestLog, prompt: renderPrompt(prompt, 'browser'), sessionId,
            timeout: turnTimeoutMs + 60_000,
            expectedReason: null,
            probeWhileRunning: async probe => {
              await answerApprovals({ ...probe, origin, approvals, timeout: turnTimeoutMs + 30_000 })
            },
          })
          sessionId = submitted.sessionId
          session = submitted.session
        }
        const expectedPaths = expectedFilePaths(task.id)
        files = await readBrowserFiles(page, expectedPaths)
        if (task.id === 't7-export') {
          const cookie = await browserPageCookie(context)
          const workspaceId = await browserWorkspaceId(origin, cookie)
          exportResult = await exportSession(origin, cookie, workspaceId, sessionId)
        }
        const observation = {
          mode: 'browser', session, sessionId, finalText: assistantText(session),
          approvals, files, manifestPaths: [], exportResult, pageErrors,
          approvalLatencyMs: approvals.length === 0 ? 0 : (approvals.at(-1).decidedAt ?? Date.now()) - approvals[0].requestedAt,
        }
        const turnError = harnessTurnError(session)
        const verdict = turnError === undefined ? task.verify(observation) : fail('harness', turnError)
        if (!verdict.passed) failure = verdict
        else if (pageErrors.length > 0) failure = fail('harness', `page errors: ${pageErrors.join('; ')}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (session !== undefined) {
          try {
            session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
            const turnError = harnessTurnError(session)
            if (turnError !== undefined) {
              failure = fail('harness', turnError)
            } else {
              const verdict = task.verify({
                mode: 'browser', session, sessionId, finalText: assistantText(session),
                approvals, files, manifestPaths: [], exportResult, pageErrors,
                approvalLatencyMs: approvals.length === 0 ? 0 : (approvals.at(-1).decidedAt ?? Date.now()) - approvals[0].requestedAt,
              })
              failure = verdict.passed
                ? fail('harness', `turn raised ${message}`)
                : { ...verdict, detail: `${message}; ${verdict.detail}` }
            }
          } catch {
            failure = fail('harness', `turn raised before any Session was readable: ${message}`)
          }
        } else {
          failure = fail('harness', `task setup failed: ${message}`)
        }
      } finally {
        await context.close().catch(() => {})
      }
      const usageAfter = await usageEntries(origin)
      results.push(taskRecord({
        task, mode: 'browser', failure, session, approvals, exportResult,
        delta: usageDelta(usageBefore, usageAfter), durationMs: Date.now() - interactionStartedAt, bootMs,
        extra: { readBackPaths: Object.keys(files).length },
      }))
      await checkpoint(results, 'browser', startedAt)
    }
    return {
      mode: 'browser-worker',
      roster: 'browser-benchmark',
      tasks: results,
      summary: summarize(results),
      bootMs: null,
      e2eMs: Date.now() - startedAt,
    }
  } finally {
    await browser.close().catch(() => {})
    await app.close().catch(() => {})
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
    await image.cleanup?.().catch(() => {})
  }
}

async function request(origin, pathname, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), ...body }) }),
  })
  return { status: response.status, body: await response.json() }
}

async function durableStatus(origin, cookie, turnId) {
  return request(origin, `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`, { cookie })
}

async function readDurableSession(origin, cookie, sessionId) {
  return request(origin, '/api/browser-native/session/read', { method: 'POST', cookie, body: { sessionId, offset: 0 } })
}

async function durableManifest(origin, cookie, workspaceId) {
  const manifest = await request(origin, `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`, { cookie })
  assert.equal(manifest.status, 200, 'durable workspace manifest must resolve')
  return (manifest.body.entries ?? []).map(entry => entry.path)
}

async function seedDurableWorkspace(origin, cookie, identity) {
  const scaleLines = Array.from({ length: 24 }, (_, index) => `scale-fixture-line-${String(index).padStart(4, '0')} ${'y'.repeat(60)}\n`).join('')
  const files = [
    ['browser-validation/input.txt', 'runtime=DedicatedWorker\nfixture=VFS_INPUT_READY\n'],
    ['browser-validation/scale-input.txt', scaleLines],
  ]
  const changes = []
  for (const [path, content] of files) {
    const bytes = Buffer.from(content)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const upload = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}`, {
      method: 'PUT',
      headers: {
        'x-browser-native-protocol': '1',
        'x-workspace-id': identity.workspaceId,
        'x-request-id': randomUUID(),
        'content-type': 'application/octet-stream',
        cookie,
      },
      body: bytes,
    })
    assert.equal(upload.status, 200, `durable fixture blob upload failed: ${await upload.text()}`)
    changes.push({ kind: 'file', path, hash, bytes: bytes.length, mode: 0o644 })
  }
  const commit = await fetch(`${origin}/api/browser-native/workspace/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      protocolVersion: 1,
      requestId: randomUUID(),
      workspaceId: identity.workspaceId,
      operationId: randomUUID(),
      baseRevision: 0,
      changes,
    }),
  })
  assert.equal(commit.status, 200, `durable fixture commit failed: ${await commit.text()}`)
}

async function durableTurn(origin, cookie, { sessionId, turnId, prompt, approvals, state }) {
  const startedAt = Date.now()
  const started = await request(origin, '/api/browser-native/session/durable', {
    method: 'POST', cookie, body: { sessionId, turnId, prompt },
  })
  if (started.status !== 202) throw new Error(`durable turn rejected: ${started.status} ${JSON.stringify(started.body)}`)
  const deadline = startedAt + turnTimeoutMs + 60_000
  const seen = new Set()
  while (Date.now() < deadline) {
    const current = await durableStatus(origin, cookie, turnId)
    const pending = current.body.pendingApproval
    if (pending !== undefined && !seen.has(pending.approvalId)) {
      seen.add(pending.approvalId)
      const requestedAt = Date.now()
      const decided = await request(origin, '/api/browser-native/session/durable/approve', {
        method: 'POST', cookie, body: { turnId, approvalId: pending.approvalId, decision: 'approve' },
      })
      if (decided.status !== 202) throw new Error(`durable approval rejected: ${decided.status} ${JSON.stringify(decided.body)}`)
      approvals.push({ name: pending.name, approvalId: pending.approvalId, requestedAt, decidedAt: Date.now() })
      continue
    }
    if (current.body.status !== 'running') {
      state.status = current.body.status
      state.reason = current.body.reason ?? current.body.error ?? null
      return { status: current.body.status, body: current.body }
    }
    await delay(150)
  }
  throw new Error(`durable turn ${turnId} did not settle within the budget`)
}

/**
 * Run the task set through the durable server host.
 * @returns {Promise<object>} Mode report with per-task results.
 */
async function runDurableMode() {
  const startedAt = Date.now()
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-bench-durable-'))
  const script = fileURLToPath(new URL('./fixtures/real-durable-backend-process.mjs', import.meta.url))
  const child = fork(script, [dataDir, envFile, providerSelection, String(turnTimeoutMs)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      NO_PROXY: process.env.NO_PROXY,
      no_proxy: process.env.no_proxy,
    },
  })
  const stderr = []
  child.stderr?.on('data', chunk => stderr.push(String(chunk)))
  const ready = await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`durable backend did not start: ${stderr.join('')}`)), 120_000)
    child.once('exit', code => {
      clearTimeout(timer)
      rejectReady(new Error(`durable backend exited before readiness (${String(code)}): ${stderr.join('')}`))
    })
    child.on('message', message => {
      if (message?.type !== 'ready') return
      clearTimeout(timer)
      resolveReady(message)
    })
  })
  const origin = ready.origin
  const identityResponse = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(identityResponse.status, 200, 'durable workspace identity must resolve')
  const cookie = identityResponse.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const identity = await identityResponse.json()
  const workspaceId = identity.workspaceId
  await seedDurableWorkspace(origin, cookie, identity)
  const results = []
  try {
    for (const [index, task] of selectedTasksForMode().entries()) {
      const taskStartedAt = Date.now()
      const usageBefore = await usageEntries(origin)
      const sessionId = `bench-${String(index + 1)}-${randomUUID()}`
      const approvals = []
      const state = { status: 'failed', reason: null }
      let session
      let failure
      let exportResult
      try {
        for (const [promptIndex, prompt] of task.prompts.entries()) {
          const turnId = `${sessionId}-turn-${String(promptIndex + 1)}`
          const settled = await durableTurn(origin, cookie, { sessionId, turnId, prompt: renderPrompt(prompt, 'durable'), approvals, state })
          if (settled.status !== 'completed') {
            failure = fail('harness', `durable turn ended as ${settled.status}: ${JSON.stringify(state.reason)}`)
            break
          }
          session = (await readDurableSession(origin, cookie, sessionId)).body
        }
        if (failure === undefined) {
          assert.ok(session !== undefined, 'a completed durable turn must produce a Session')
          const manifestPaths = await durableManifest(origin, cookie, workspaceId)
          const files = await readDurableFiles(origin, cookie, workspaceId, expectedFilePaths(task.id))
          if (task.id === 't7-export') exportResult = await exportSession(origin, cookie, workspaceId, sessionId)
          const turnError = harnessTurnError(session)
          const verdict = turnError === undefined
            ? task.verify({
                mode: 'durable', session, sessionId, finalText: assistantText(session),
                approvals, files, manifestPaths, exportResult, pageErrors: [],
                approvalLatencyMs: approvals.length === 0 ? 0 : (approvals.at(-1).decidedAt ?? Date.now()) - approvals[0].requestedAt,
              })
            : fail('harness', turnError)
          failure = verdict.passed ? undefined : verdict
        }
      } catch (error) {
        failure = fail('harness', `durable task raised: ${error instanceof Error ? error.message : String(error)}`)
      }
      const usageAfter = await usageEntries(origin)
      results.push(taskRecord({
        task, mode: 'durable', failure, session, approvals, exportResult,
        delta: usageDelta(usageBefore, usageAfter), durationMs: Date.now() - taskStartedAt, bootMs: null,
        extra: { manifestPaths: (await durableManifest(origin, cookie, workspaceId).catch(() => [])).length },
      }))
      await checkpoint(results, 'durable', startedAt)
    }
    return {
      mode: 'durable-host',
      roster: null,
      tasks: results,
      summary: summarize(results),
      bootMs: null,
      e2eMs: Date.now() - startedAt,
    }
  } finally {
    child.kill('SIGTERM')
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
}

function expectedFilePaths(taskId) {
  if (taskId === 't1-read-write') return [resultPath('echo.txt')]
  if (taskId === 't3-write-edit') return [resultPath('notes.txt')]
  if (taskId === 't4-multifile') return [resultPath('a.txt'), resultPath('b.txt')]
  if (taskId === 't6-cross-turn') return [resultPath('config.txt')]
  if (taskId === 't7-export') return [resultPath('summary.json')]
  if (taskId === 't8-approval') return [resultPath('approval.txt')]
  if (taskId === 't9-missing-recovery') return [resultPath('missing-t9.txt')]
  return []
}

function selectedTasksForMode() {
  if (selectedTasks === undefined) return tasks
  return tasks.filter(task => selectedTasks.has(task.id))
}

function taskRecord({ task, mode, failure, session, approvals, exportResult, delta, durationMs, bootMs, extra }) {
  const finalText = session === undefined ? '' : assistantText(session)
  return {
    id: task.id,
    label: task.label,
    capability: task.capability,
    mode,
    userTurns: task.prompts.length,
    result: failure === undefined ? 'passed' : 'failed',
    failureClass: failure?.failureClass ?? null,
    failureCapability: failure?.capability ?? null,
    detail: failure?.detail ?? (failure === undefined ? 'passed' : ''),
    modelRequests: delta.requests,
    inputTokens: delta.inputTokens,
    outputTokens: delta.outputTokens,
    totalTokens: delta.totalTokens,
    costUsd: delta.costUsd,
    requestSizes: delta.requestSizes,
    steps: session === undefined ? 0 : countSteps(session),
    turnReason: session === undefined ? null : lastTurnReason(session),
    approvalCount: approvals.length,
    approvalLatencyMs: approvals.length === 0
      ? 0
      : (approvals.at(-1).decidedAt ?? Date.now()) - approvals[0].requestedAt,
    exportBytes: exportResult === undefined ? null : JSON.stringify(exportResult.body).length,
    durationMs,
    bootMs,
    finalTextLength: finalText.length,
    finalTextPreview: finalText.slice(0, 240),
    toolTrace: session === undefined ? [] : toolCalls(session).map(call => ({
      name: call.name,
      isError: call.result?.data.message?.isError === true,
      resultPreview: (call.resultText ?? '').slice(0, 160),
    })).slice(-12),
    ...extra,
  }
}

function summarize(records) {
  const passed = records.filter(record => record.result === 'passed')
  const mean = values => values.length === 0 ? 0 : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
  const compositions = records.flatMap(record => record.requestSizes)
  const totalInputTokens = records.reduce((sum, record) => sum + record.inputTokens, 0)
  const totalModelRequests = records.reduce((sum, record) => sum + record.modelRequests, 0)
  return {
    tasks: records.length,
    passed: passed.length,
    failed: records.length - passed.length,
    successRate: records.length === 0 ? 0 : Number((passed.length / records.length).toFixed(3)),
    avgModelRequestsPerTask: mean(records.map(record => record.modelRequests)),
    avgSessionStepsPerTask: mean(records.map(record => record.steps)),
    avgDurationMs: mean(records.map(record => record.durationMs)),
    totalInputTokens,
    totalOutputTokens: records.reduce((sum, record) => sum + record.outputTokens, 0),
    totalTokens: records.reduce((sum, record) => sum + record.totalTokens, 0),
    totalCostUsd: pricing === undefined
      ? null
      : Number(records.reduce((sum, record) => sum + (record.costUsd ?? 0), 0).toFixed(6)),
    totalModelRequests,
    inputTokensPerRequest: totalModelRequests === 0 ? null : Number((totalInputTokens / totalModelRequests).toFixed(1)),
    requestComposition: {
      observedRequests: compositions.length,
      systemPromptRequests: compositions.filter(request => request.systemChars > 0).length,
      avgMessageCount: mean(compositions.map(request => request.messageCount)),
      avgToolCount: mean(compositions.map(request => request.toolCount)),
      avgSystemCharsPerRequest: mean(compositions.map(request => request.systemChars)),
      avgHistoryCharsPerRequest: mean(compositions.map(request => request.historyChars)),
      avgToolSchemaCharsPerRequest: mean(compositions.map(request => request.toolSchemaChars)),
    },
    failuresByClass: {
      model: records.filter(record => record.failureClass === 'model').length,
      tool: records.filter(record => record.failureClass === 'tool').length,
      harness: records.filter(record => record.failureClass === 'harness').length,
    },
  }
}

const document = {
  startedAt: new Date().toISOString(),
  provider: providerSelection,
  model,
  llmMode: 'real',
  pricing: pricing === undefined
    ? { configured: false, note: 'no DSH_POC_INPUT_PRICE_PER_MTOK / DSH_POC_OUTPUT_PRICE_PER_MTOK; tokens are reported, cost is null' }
    : { configured: true, inputUsdPer1M: inputPrice, outputUsdPer1M: outputPrice },
  selection: { modes: selectedModes, tasks: selectedTasks === undefined ? 'all' : [...selectedTasks] },
  taskSet: tasks.map(task => ({ id: task.id, label: task.label, capability: task.capability, userTurns: task.prompts.length })),
  modes: [],
  partial: true,
}

async function checkpoint(results, mode, startedAt) {
  const existing = document.modes.find(entry => entry.mode === `${mode}-${mode === 'browser' ? 'worker' : 'host'}`)
  const summary = summarize(results)
  if (existing === undefined) {
    document.modes.push({
      mode: mode === 'browser' ? 'browser-worker' : 'durable-host',
      roster: mode === 'browser' ? 'browser-benchmark' : null,
      tasks: results,
      summary,
      e2eMs: Date.now() - startedAt,
      bootMs: null,
    })
  } else {
    existing.tasks = results
    existing.summary = summary
    existing.e2eMs = Date.now() - startedAt
  }
  document.partial = true
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`)
}

async function main() {
  let failed = false
  try {
    if (selectedModes.includes('browser')) {
      const report = await runBrowserMode()
      const existing = document.modes.find(entry => entry.mode === report.mode)
      if (existing === undefined) document.modes.push(report)
      else Object.assign(existing, report)
      await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`)
    }
    if (selectedModes.includes('durable')) {
      const report = await runDurableMode()
      const existing = document.modes.find(entry => entry.mode === report.mode)
      if (existing === undefined) document.modes.push(report)
      else Object.assign(existing, report)
      await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`)
    }
  } catch (error) {
    failed = true
    document.error = error instanceof Error ? error.message : String(error)
    await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`)
    throw error
  } finally {
    if (!failed) {
      document.partial = false
      document.finishedAt = new Date().toISOString()
      document.comparison = buildComparison()
      await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`)
      process.stdout.write(`${JSON.stringify({
        output: outputPath,
        provider: providerSelection,
        model,
        comparison: document.comparison,
      }, null, 2)}\n`)
    }
  }
}

function buildComparison() {
  const comparison = {}
  for (const mode of document.modes) {
    comparison[mode.mode] = {
      successRate: mode.summary.successRate,
      passed: mode.summary.passed,
      tasks: mode.summary.tasks,
      avgModelRequestsPerTask: mode.summary.avgModelRequestsPerTask,
      avgSessionStepsPerTask: mode.summary.avgSessionStepsPerTask,
      avgDurationMs: mode.summary.avgDurationMs,
      totalTokens: mode.summary.totalTokens,
      totalCostUsd: mode.summary.totalCostUsd,
      failuresByClass: mode.summary.failuresByClass,
      e2eMs: mode.e2eMs,
    }
  }
  const worker = document.modes.find(mode => mode.mode === 'browser-worker')
  const durable = document.modes.find(mode => mode.mode === 'durable-host')
  if (worker !== undefined && durable !== undefined) {
    const requestChars = composition => ({
      systemPrompt: Math.round(composition.avgSystemCharsPerRequest * composition.observedRequests),
      toolSchemas: Math.round(composition.avgToolSchemaCharsPerRequest * composition.observedRequests),
      history: Math.round(composition.avgHistoryCharsPerRequest * composition.observedRequests),
    })
    const workerChars = requestChars(worker.summary.requestComposition)
    const durableChars = requestChars(durable.summary.requestComposition)
    const scale = (chars, inputTokens) => inputTokens / (chars.systemPrompt + chars.toolSchemas + chars.history)
    const workerScale = scale(workerChars, worker.summary.totalInputTokens)
    const durableScale = scale(durableChars, durable.summary.totalInputTokens)
    const attribute = (chars, inputScale) => ({
      systemPrompt: Math.round(chars.systemPrompt * inputScale),
      toolSchemas: Math.round(chars.toolSchemas * inputScale),
      history: Math.round(chars.history * inputScale),
    })
    const workerTokens = attribute(workerChars, workerScale)
    const durableTokens = attribute(durableChars, durableScale)
    comparison.tokenAttribution = {
      workerInputTokensPerRequest: worker.summary.inputTokensPerRequest,
      durableInputTokensPerRequest: durable.summary.inputTokensPerRequest,
      inputTokenGapPerRequest: Number((worker.summary.inputTokensPerRequest - durable.summary.inputTokensPerRequest).toFixed(1)),
      extraModelRequests: worker.summary.totalModelRequests - durable.summary.totalModelRequests,
      requestChars: { worker: workerChars, durable: durableChars },
      estimatedInputTokens: {
        worker: workerTokens,
        durable: durableTokens,
        gap: {
          systemPrompt: workerTokens.systemPrompt - durableTokens.systemPrompt,
          toolSchemas: workerTokens.toolSchemas - durableTokens.toolSchemas,
          history: workerTokens.history - durableTokens.history,
        },
      },
      workerComposition: worker.summary.requestComposition,
      durableComposition: durable.summary.requestComposition,
      note: 'Char totals come from each observed request; the per-mode chars-to-token scale maps them onto the provider input count, so the three gap terms sum to the observed input difference within rounding.',
    }
  }
  return comparison
}

await main()
