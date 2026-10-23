import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-default-profile-')))
const marker = 'BROWSER_NATIVE_DEFAULT_PROFILE_TOOL_E2E'
const requests = []
const requestRecords = []
const externalRequests = []
const pageErrors = []
let image
let app
let browser
let page

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (url.pathname.startsWith('/api/browser-native/')) {
      let body = {}
      try { body = JSON.parse(request.postData() ?? '{}') } catch {}
      requests.push({ path: url.pathname, body })
    }
    if (url.pathname === '/api/browser-native/llm') {
      try { requestRecords.push(JSON.parse(request.postData() ?? '{}')) } catch { requestRecords.push({}) }
    }
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&preview-fixture=none`)
  await page.getByText('Browser-native remote', { exact: true }).waitFor({ timeout: 20_000 })
  let result
  try {
    result = await sendTurn({
      page,
      origin,
      requests,
      prompt: `Run the Browser Worker shell verification. ${marker}`,
      marker: 'BROWSER_NATIVE_DEFAULT_PROFILE_TOOL_LOOP_OK',
      timeout: 60_000,
    })
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      failure: error instanceof Error ? error.message : String(error),
      requests: requests.map(request => ({ path: request.path, status: request.status, body: request.body })),
      pageText: (await page.locator('body').innerText()).slice(-2500),
      pageErrors,
    })}\n`)
    throw error
  }

  const modelRequest = requestRecords.find(request => JSON.stringify(request.messages).includes(marker))
  assert.ok(modelRequest, 'the Agent turn must send a model request carrying the Browser profile prompt')
  const toolNames = (modelRequest.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter(Boolean)
  for (const name of ['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'todo_write', 'ask_user_question']) {
    assert.equal(toolNames.includes(name), true, `Browser standard preset omitted expected tool ${name}: ${toolNames.join(', ')}`)
  }
  for (const name of ['web_search', 'web_fetch', 'pwsh', 'subagent', 'subagent_fork', 'job_run']) {
    assert.equal(toolNames.includes(name), false, `Browser standard preset exposed unsupported tool ${name}: ${toolNames.join(', ')}`)
  }

  const call = result.session.events.find(event => event.type === 'tool/call'
    && event.data.name === 'bash' && event.data.turn === result.turn)
  assert.ok(call, 'the real DSH Agent Loop must execute bash in the Worker')
  assert.deepEqual(JSON.parse(call.data.arguments), {
    command: "printf 'BROWSER_NATIVE_WORKER_SHELL_OK\\n'",
    description: 'Verify the Worker shell command table',
  })
  const toolResult = result.session.events.find(event => event.type === 'tool/result'
    && event.data.message?.toolCallId === call.data.callId)
  assert.ok(toolResult, 'the Worker shell call must have a DSH tool result')
  assert.equal(toolResult.data.message.isError, false)
  assert.match(toolResult.data.message.content.map(block => block.text ?? '').join(''), /BROWSER_NATIVE_WORKER_SHELL_OK/)
  const callAppendIndex = requests.findIndex(request => request.path.endsWith('/session/append')
    && request.body.events?.some(event => event.type === 'tool/call' && event.data.callId === call.data.callId))
  const callCheckpointIndex = requests.findIndex((request, index) => index > callAppendIndex
    && request.path.endsWith('/session/flush'))
  const resultAppendIndex = requests.findIndex((request, index) => index > callCheckpointIndex
    && request.path.endsWith('/session/append')
    && request.body.events?.some(event => event.type === 'tool/result' && event.data.message?.toolCallId === call.data.callId))
  assert.ok(callAppendIndex >= 0, 'the Session tool/call must be sent before dispatch')
  assert.ok(callCheckpointIndex > callAppendIndex, 'the tool/call must be durably checkpointed before the tool result exists')
  assert.ok(resultAppendIndex > callCheckpointIndex, 'the DSH tool result must follow the pre-dispatch checkpoint')
  assert.match(assistantText(result.session, result.turn), /BROWSER_NATIVE_DEFAULT_PROFILE_TOOL_LOOP_OK/)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    toolNames,
    executedTool: call.data.name,
    toolResultError: toolResult.data.message.isError,
    sessionId: result.sessionId,
    eventCount: result.session.events.length,
    sessionAppendRequests: requests.filter(request => request.path.endsWith('/session/append')).length,
    sessionFlushRequests: requests.filter(request => request.path.endsWith('/session/flush')).length,
    externalRequestCount: externalRequests.length,
    pageErrors,
  })}\n`)
} finally {
  await page?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
