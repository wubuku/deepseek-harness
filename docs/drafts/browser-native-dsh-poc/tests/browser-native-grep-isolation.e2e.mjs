import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const llmMode = process.env.DSH_POC_LLM ?? 'scripted'
const envFile = process.env.DSH_POC_ENV_FILE
const turnTimeout = Number(process.env.DSH_POC_TURN_TIMEOUT_MS ?? (llmMode === 'real' ? 600_000 : 30_000))
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-grep-isolation-')))
const pageErrors = []
const workerErrors = []
const externalRequests = []
const commits = []
const requests = []
let image
let app
let browser
let page

if (!['scripted', 'real'].includes(llmMode)) throw new Error('DSH_POC_LLM must be scripted or real')
if (llmMode === 'real' && envFile === undefined) throw new Error('DSH_POC_ENV_FILE is required for real mode')

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode, envFile })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== new URL(origin).origin) externalRequests.push(request.url())
    if (url.pathname.startsWith('/api/browser-native/')) {
      let body
      try { body = request.postDataJSON() } catch {}
      requests.push({ path: url.pathname, body })
    }
    if (url.pathname.endsWith('/workspace/commit')) commits.push(request.postDataJSON())
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  assert.equal((await testAction({
    action: 'write',
    path: '/dsh/home/workspace/regex-stress.txt',
    content: `SAFE_PARTIAL_MUST_NOT_ESCAPE\n${'a'.repeat(48)}!`,
  }))?.ok, true)
  assert.equal((await testAction({
    action: 'write-pattern',
    path: '/dsh/home/workspace/long-no-match.txt',
    byteLength: 70 * 1024,
    byteValue: 0x78,
  }))?.ok, true)
  assert.equal((await testAction({
    action: 'write',
    path: '/dsh/home/workspace/regex-safe.txt',
    content: 'SAFE_SEARCH_OK\n',
  }))?.ok, true)
  assert.equal((await testAction({
    action: 'write',
    path: `/dsh/home/workspace/${'a'.repeat(48)}.txt`,
    content: 'glob path fixture\n',
  }))?.ok, true)
  assert.equal((await testAction({ action: 'flush-workspace' }))?.ok, true)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 60_000 })
  const seededCommitCount = commits.length

  const cancellationStartedAt = Date.now()
  const canceled = await testAction({
    action: 'cancel-file-search',
    path: '/dsh/home/workspace/regex-stress.txt',
    pattern: '^(a|aa)+$',
    delayMs: 0,
  })
  const cancellationElapsedMs = Date.now() - cancellationStartedAt
  assert.equal(canceled?.ok, true, JSON.stringify(canceled))
  assert.equal(canceled?.canceled, true, JSON.stringify(canceled))
  assert.ok(cancellationElapsedMs < 5_000, `matcher cancellation took ${cancellationElapsedMs} ms`)

  const prompt = llmMode === 'scripted'
    ? 'BROWSER_NATIVE_GREP_ISOLATION_E2E: run the configured search sequence.'
    : 'Use the grep tool to search /dsh/home/workspace/regex-safe.txt for the exact line SAFE_SEARCH_OK. Do not use read. Report the exact matched line.'
  const turn = await sendTurn({
    page,
    origin,
    requests,
    prompt,
    ...(llmMode === 'scripted' ? { marker: 'BROWSER_NATIVE_GREP_ISOLATION_COMPLETED' } : {}),
    timeout: turnTimeout,
  })
  const calls = turn.session.events.filter(event => event.type === 'tool/call' && event.data.turn === turn.turn)
  const results = new Map(turn.session.events.filter(event => event.type === 'tool/result')
    .map(event => [event.data.message?.toolCallId, event]))
  let isolationResults
  if (llmMode === 'scripted') {
    assert.deepEqual(calls.map(event => event.data.name), ['grep', 'grep', 'glob', 'grep', 'grep', 'glob'])
    const longLineResult = results.get(calls[0].data.callId)
    const timeoutResult = results.get(calls[1].data.callId)
    const globTimeoutResult = results.get(calls[2].data.callId)
    const includeTimeoutResult = results.get(calls[3].data.callId)
    const safeResult = results.get(calls[4].data.callId)
    const safeGlobResult = results.get(calls[5].data.callId)
    assert.ok(longLineResult)
    assert.equal(longLineResult.data.message.isError, true)
    assert.match(longLineResult.data.message.content.map(block => block.text ?? '').join(''), /SEARCH_LINE_TOO_LONG/)
    assert.ok(timeoutResult)
    assert.equal(timeoutResult.data.message.isError, true)
    const timeoutText = timeoutResult.data.message.content.map(block => block.text ?? '').join('')
    assert.match(timeoutText, /SEARCH_REGEX_TIMEOUT/)
    assert.doesNotMatch(timeoutText, /SAFE_PARTIAL_MUST_NOT_ESCAPE/)
    assert.ok(globTimeoutResult)
    assert.equal(globTimeoutResult.data.message.isError, true)
    assert.match(globTimeoutResult.data.message.content.map(block => block.text ?? '').join(''), /SEARCH_REGEX_TIMEOUT/)
    assert.ok(includeTimeoutResult)
    assert.equal(includeTimeoutResult.data.message.isError, true)
    assert.match(includeTimeoutResult.data.message.content.map(block => block.text ?? '').join(''), /SEARCH_REGEX_TIMEOUT/)
    assert.ok(safeResult)
    assert.equal(safeResult.data.message.isError, false)
    assert.match(safeResult.data.message.content.map(block => block.text ?? '').join(''), /SAFE_SEARCH_OK/)
    assert.ok(safeGlobResult)
    assert.equal(safeGlobResult.data.message.isError, false)
    assert.match(safeGlobResult.data.message.content.map(block => block.text ?? '').join(''), /regex-safe\.txt/)
    isolationResults = { longLineResult, timeoutResult, globTimeoutResult, includeTimeoutResult, safeResult, safeGlobResult }
  } else {
    const grepCalls = calls.filter(event => event.data.name === 'grep')
    assert.ok(grepCalls.length >= 1, `real model did not select grep: ${calls.map(event => event.data.name).join(', ')}`)
    const safeResult = grepCalls.map(call => results.get(call.data.callId))
      .find(result => result !== undefined && result.data.message?.isError !== true
        && result.data.message?.content?.some(block => block.text?.includes('SAFE_SEARCH_OK')))
    assert.ok(safeResult, 'real model grep did not return the fixture marker')
    isolationResults = { safeResult }
  }
  assert.equal(commits.length, seededCommitCount, 'search timeout and retry must not mutate the Workspace')
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    modelMode: llmMode === 'scripted' ? 'scripted-tool-selection' : 'real-llm-tool-selection',
    scope: 'real-DSH-grep-timeout-cancellation-and-same-turn-recovery',
    sessionId: turn.sessionId,
    turn: turn.turn,
    toolSequence: calls.map(event => event.data.name),
    longLineError: isolationResults.longLineResult?.data.message.content.map(block => block.text ?? '').join(''),
    timeoutError: isolationResults.timeoutResult?.data.message.content.map(block => block.text ?? '').join(''),
    globTimeoutError: isolationResults.globTimeoutResult?.data.message.content.map(block => block.text ?? '').join(''),
    includeTimeoutError: isolationResults.includeTimeoutResult?.data.message.content.map(block => block.text ?? '').join(''),
    safeSearchCompleted: isolationResults.safeResult !== undefined,
    cancellationElapsedMs,
    workspaceCommitCount: commits.length,
    pageErrors,
    workerErrors,
    externalRequests,
  })}\n`)
} finally {
  await page?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
