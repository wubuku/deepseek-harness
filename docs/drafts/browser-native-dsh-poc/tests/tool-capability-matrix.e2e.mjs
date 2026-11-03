/**
 * Model-facing tool roster and degradation behavior in the Browser-Native Worker.
 *
 * The validation roster must expose exactly the browser-safe tools. A scripted
 * model then calls an absent host tool (`bash`) and a present Worker tool
 * (`read`); the absent call must fail as an unknown tool without touching the
 * Workspace, and the present call must return the VFS fixture.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const ABSENT_PROMPT = 'CAPABILITY_MATRIX_ABSENT_TOOL: run the host shell once.'
const READ_PROMPT = 'CAPABILITY_MATRIX_FS_READ: read the validation fixture.'
const DONE = 'CAPABILITY_MATRIX_TURN_DONE'
const EXPECTED_ROSTER = ['edit', 'glob', 'grep', 'read', 'todo_write', 'working_directory', 'write']

function lastUserText(body) {
  const index = body.messages.findLastIndex(message => message.role === 'user'
    && typeof message.content === 'string'
    && !message.content.startsWith('Current runtime context.')
    && !message.content.startsWith('Time sampled while preparing turn'))
  const content = body.messages[index]?.content
  return { index, text: typeof content === 'string' ? content : '' }
}

function matrixFault(body) {
  const { index, text } = lastUserText(body)
  if (body.messages.slice(index + 1).some(message => message.role === 'tool')) {
    return { kind: 'text', text: DONE }
  }
  if (text.includes('CAPABILITY_MATRIX_ABSENT_TOOL')) {
    return {
      kind: 'tool-call',
      call: {
        id: 'absent-host-shell',
        name: 'bash',
        arguments: { command: "printf 'CAPABILITY_MATRIX_SHELL_OK\\n'" },
      },
    }
  }
  if (text.includes('CAPABILITY_MATRIX_FS_READ')) {
    return {
      kind: 'tool-call',
      call: {
        id: 'worker-file-read',
        name: 'read',
        arguments: { file_path: '/dsh/home/browser-validation/input.txt' },
      },
    }
  }
  return { kind: 'text', text: DONE }
}

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-capability-matrix-'))
let image
let app
let browser
let page
const requests = []
const commits = []
const pageErrors = []
let origin

function textOf(result) {
  return result.data.message.content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: { scriptedLlmFault: matrixFault },
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) return
    if (url.pathname.startsWith('/api/browser-native/')) {
      let body = {}
      try { body = request.postDataJSON() ?? {} } catch {}
      requests.push({ path: url.pathname, body })
    }
    if (url.pathname.endsWith('/workspace/commit')) commits.push(request.postDataJSON())
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const seedCommits = commits.length

  const absentTurn = await sendTurn({ page, origin, requests, prompt: ABSENT_PROMPT, marker: DONE })
  const absentCall = absentTurn.session.events.find(event => event.type === 'tool/call'
    && event.data.turn === absentTurn.turn && event.data.name === 'bash')
  assert.ok(absentCall, 'the scripted model must attempt the absent host tool')
  const absentResult = absentTurn.session.events.find(event => event.type === 'tool/result'
    && event.data.message?.toolCallId === absentCall.data.callId)
  assert.ok(absentResult, 'an absent tool call must still settle with a tool result')
  assert.equal(absentResult.data.message.isError, true, 'an absent tool must fail, never appear to run')
  assert.match(textOf(absentResult), /unknown tool "bash"/, 'the failure must classify the tool as unknown')
  assert.equal(commits.length, seedCommits, 'an absent tool must not mutate the Workspace')

  const readTurn = await sendTurn({ page, origin, requests, prompt: READ_PROMPT, marker: DONE })
  const readCall = readTurn.session.events.find(event => event.type === 'tool/call'
    && event.data.turn === readTurn.turn && event.data.name === 'read')
  assert.ok(readCall, 'the Worker file tool must stay model-visible')
  const readResult = readTurn.session.events.find(event => event.type === 'tool/result'
    && event.data.message?.toolCallId === readCall.data.callId)
  assert.ok(readResult, 'the Worker file read must settle')
  assert.equal(readResult.data.message.isError, false)
  assert.match(textOf(readResult), /VFS_INPUT_READY/, 'the Worker file tool must read the VFS fixture')

  const toolNames = requests
    .filter(request => request.path.endsWith('/llm'))
    .flatMap(request => (Array.isArray(request.body.tools) ? request.body.tools : []).map(tool => tool?.function?.name ?? tool?.name))
    .filter(name => typeof name === 'string')
  assert.deepEqual([...new Set(toolNames)].sort(), EXPECTED_ROSTER,
    `the model-facing roster must stay browser-safe: ${toolNames.join(', ')}`)
  for (const name of ['bash', 'pwsh', 'web_search', 'web_fetch', 'subagent', 'subagent_fork', 'job_run', 'read_image']) {
    assert.equal(toolNames.includes(name), false, `the Browser roster must not expose ${name}`)
  }
  assert.equal(toolNames.some(name => name.startsWith('browser_')), false,
    'browser-use tools require a Node/Chromium principal and must not reach the Worker')

  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    roster: [...new Set(toolNames)].sort(),
    absentTool: { name: absentCall.data.name, isError: absentResult.data.message.isError, result: textOf(absentResult) },
    presentTool: { name: readCall.data.name, isError: readResult.data.message.isError },
    workspaceCommitsFromAbsentCall: commits.length - seedCommits,
    pageErrors,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
