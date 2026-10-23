import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-interaction-tools-')))
const prompt = 'BROWSER_NATIVE_INTERACTION_TOOLS_E2E: ask before changing directory, then write a relative file.'
const targetDirectory = '/dsh/home/workspace/interaction-dir'
const workspaceFile = 'interaction-dir/relative-result.txt'
let image
let app
let browser
let page
const requests = []
const modelRequests = []
const pageErrors = []
const externalRequests = []

function toolResult(session, callId) {
  return session.events.find(event => event.type === 'tool/result'
    && event.data.message?.toolCallId === callId)
}

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (url.pathname.startsWith('/api/browser-native/')) {
      let body = {}
      try { body = request.postDataJSON() ?? {} } catch {}
      requests.push({ path: url.pathname, body })
      if (url.pathname === '/api/browser-native/llm') modelRequests.push(body)
    }
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const seededDirectory = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'mkdir', path,
  }), targetDirectory)
  assert.equal(seededDirectory?.ok, true, JSON.stringify(seededDirectory))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })

  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(prompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const createRequest = await waitFor(
    () => requests.find(request => request.path.endsWith('/session/create')),
    'interaction test Session creation',
  )
  const sessionId = createRequest.body.sessionId
  const asked = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const call = session.events?.find(event => event.type === 'tool/call'
      && event.data.name === 'ask_user_question')
    return call === undefined ? undefined : { session, call }
  }, 'logged ask_user_question tool call', 60_000)

  const question = page.locator('[data-question-key]')
  await question.waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByText('May I continue with the file operation?', { exact: true }).waitFor()
  const yes = question.getByRole('radio', { name: 'Yes' })
  await yes.click()
  await yes.press('Enter')

  const completed = await waitFor(async () => {
    const session = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const terminal = session.events?.findLast(event => event.type === 'turn/end')
    return terminal === undefined ? undefined : { session, terminal }
  }, 'interaction tools turn completion', 60_000)
  const calls = completed.session.events.filter(event => event.type === 'tool/call'
    && event.data.turn === completed.terminal.data.turn)
  assert.deepEqual(calls.map(call => call.data.name), ['ask_user_question', 'working_directory', 'write'])
  for (const call of calls) {
    const result = toolResult(completed.session, call.data.callId)
    assert.ok(result, `missing tool result for ${call.data.name}`)
    assert.equal(result.data.message.isError, false, `tool failed: ${call.data.name}`)
  }
  assert.ok(JSON.stringify(toolResult(completed.session, asked.call.data.callId)).includes('Yes'))
  assert.ok(completed.session.events.some(event => event.type === 'working-directory/change'
    && event.data.cwd === targetDirectory), 'the selected directory must be recorded in the Session')
  assert.deepEqual(JSON.parse(calls[1].data.arguments), { cd: targetDirectory })
  assert.deepEqual(JSON.parse(calls[2].data.arguments), {
    file_path: 'relative-result.txt',
    content: 'working-directory-relative-write-ok\n',
  })
  assert.equal(completed.terminal.data.reason.kind, 'completed')
  assert.match(assistantText(completed.session, completed.terminal.data.turn), /BROWSER_NATIVE_INTERACTION_TOOLS_DONE/)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 2, undefined, { timeout: 30_000 })
  const writtenFile = await page.evaluate(async path => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
    action: 'read', path,
  }), `/dsh/home/workspace/${workspaceFile}`)
  assert.deepEqual({ ok: writtenFile?.ok, content: writtenFile?.content }, {
    ok: true,
    content: 'working-directory-relative-write-ok\n',
  })

  const request = modelRequests.find(item => JSON.stringify(item.messages).includes(prompt))
  const toolNames = (request?.tools ?? []).map(tool => tool.function?.name ?? tool.name)
  for (const name of ['ask_user_question', 'working_directory', 'write']) {
    assert.ok(toolNames.includes(name), `model request omitted ${name}: ${toolNames.join(', ')}`)
  }
  assert.equal(toolNames.includes('read_image'), false, 'unknown image modality must not expose read_image')
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'default-DSH-question-UI-working-directory-and-relative-file-tool-loop',
    sessionId,
    toolNames: calls.map(call => call.data.name),
    workspaceRevision: 2,
    workspaceFile,
    readImageExposed: toolNames.includes('read_image'),
    llmRequestCount: modelRequests.length,
    pageErrors,
    externalRequests,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
