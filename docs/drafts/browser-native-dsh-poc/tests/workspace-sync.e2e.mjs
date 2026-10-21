import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const mode = process.env.DSH_POC_LLM ?? 'real'
const envFile = process.env.DSH_POC_ENV_FILE ?? 'docs/drafts/.env'
const port = Number(process.env.DSH_POC_PORT ?? '4198')
const distRoot = resolve(process.env.DSH_POC_DIST_ROOT ?? 'apps/web/dist')
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-native-workspace-')))
const token = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()
const filePath = '/dsh/home/workspace/workspace-sync.txt'
const exactContents = 'alpha=1\nbeta=2'
const remoteFilePath = '/dsh/home/workspace/concurrent-tab.txt'
const remoteContents = 'remote=committed'
const localConflictPath = '/dsh/home/workspace/local-conflict.txt'
const localConflictContents = 'local=kept'
const firstMarker = `WORKSPACE_SYNC_WRITE_DONE_${token}`
const secondMarker = `WORKSPACE_SYNC_RESTORE_DONE_${token}`
const conflictMarker = `WORKSPACE_SYNC_CONFLICT_SEEN_${token}`
const localReadMarker = `WORKSPACE_SYNC_LOCAL_COPY_READ_${token}`
const firstPrompt = `Call the DSH tool named write with file_path ${JSON.stringify(filePath)} and content ${JSON.stringify(exactContents)}. Then call the DSH tool named read with that exact file_path. The write and read tools are available in this turn. If the read result contains the exact two lines, reply exactly ${firstMarker}.`
const restoredPrompt = `Call the DSH tool named read on this exact file_path: ${JSON.stringify(filePath)}. The read tool is available in this turn. If its result contains the exact two lines alpha=1 and beta=2, reply exactly ${secondMarker}.`
const prompts = [
  firstPrompt,
  restoredPrompt,
]
const conflictWritePrompt = `Use the DSH write tool once to write ${JSON.stringify(localConflictContents)} to ${JSON.stringify(localConflictPath)}. After the tool succeeds, reply exactly ${conflictMarker}.`
const localReadPrompt = `Use the DSH read tool to read ${JSON.stringify(localConflictPath)}. If the tool result contains ${JSON.stringify(localConflictContents)}, reply exactly ${localReadMarker}.`

if (mode !== 'real') throw new Error('workspace-sync.e2e.mjs requires DSH_POC_LLM=real to exercise model-selected DSH tools')
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')
if (mode === 'real' && envFile === undefined) throw new Error('DSH_POC_ENV_FILE is required for real mode')

const localNoProxy = new Set((process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').filter(Boolean))
localNoProxy.add('127.0.0.1')
localNoProxy.add('localhost')
process.env.NO_PROXY = [...localNoProxy].join(',')
process.env.no_proxy = process.env.NO_PROXY

function requestJson(request) {
  const body = request.postData()
  if (body === null) return undefined
  try { return JSON.parse(body) } catch { return undefined }
}

function summarizeLlmStream(status, stream, truncated) {
  const toolNames = new Map()
  const finishReasons = []
  let textCharacters = 0
  let malformedRecords = 0
  for (const line of stream.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data.length === 0 || data === '[DONE]') continue
    try {
      const record = JSON.parse(data)
      for (const choice of record.choices ?? []) {
        const delta = choice.delta ?? {}
        if (typeof delta.content === 'string') textCharacters += delta.content.length
        for (const toolCall of delta.tool_calls ?? []) {
          const index = toolCall.index ?? 0
          toolNames.set(index, `${toolNames.get(index) ?? ''}${toolCall.function?.name ?? ''}`)
        }
        if (typeof choice.finish_reason === 'string') finishReasons.push(choice.finish_reason)
      }
    } catch {
      malformedRecords += 1
    }
  }
  return { status, textCharacters, toolNames: [...toolNames.values()], finishReasons, malformedRecords, truncated }
}

function llmRequestSummary(status, body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const userMessages = messages.filter(message => message?.role === 'user')
  const lastUserMessage = userMessages.at(-1)?.content
  return {
    status,
    availableToolNames: (body?.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter(name => typeof name === 'string'),
    messageRoles: messages.map(message => message?.role),
    lastUserMessage: typeof lastUserMessage === 'string' ? lastUserMessage.slice(0, 400) : undefined,
  }
}

function observeLlmStreams() {
  const originalFetch = globalThis.fetch
  const callOriginalFetch = originalFetch.bind(globalThis)
  const pending = new Set()
  const summaries = []
  globalThis.fetch = async (input, init) => {
    const response = await callOriginalFetch(input, init)
    if (new Headers(init?.headers).get('accept') === 'text/event-stream' && response.body !== null) {
      let requestBody
      try { requestBody = JSON.parse(String(init?.body ?? '')) } catch { requestBody = undefined }
      const request = llmRequestSummary(response.status, requestBody)
      const reader = response.clone().body.getReader()
      const observation = { reader, task: undefined, truncated: false }
      observation.task = (async () => {
        const decoder = new TextDecoder()
        let stream = ''
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            stream += decoder.decode(value, { stream: true })
            if (stream.length > 2_000_000) {
              stream = stream.slice(0, 2_000_000)
              observation.truncated = true
              await reader.cancel()
              break
            }
          }
          stream += decoder.decode()
          summaries.push({ ...request, ...summarizeLlmStream(response.status, stream, observation.truncated) })
        } catch (error) {
          summaries.push({
            ...request,
            observationError: error instanceof Error ? error.message : String(error),
            truncated: observation.truncated,
          })
        }
      })()
      pending.add(observation)
      void observation.task.then(() => pending.delete(observation))
    }
    return response
  }
  return {
    summaries,
    settle: async (timeoutMs = 5_000) => {
      const observations = [...pending]
      if (observations.length === 0) return 0
      let timer
      const complete = await Promise.race([
        Promise.all(observations.map(observation => observation.task)).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) }),
      ])
      clearTimeout(timer)
      if (!complete) {
        for (const observation of observations) observation.truncated = true
        let cleanupTimer
        await Promise.race([
          Promise.allSettled(observations.flatMap(observation => [
            observation.reader.cancel(),
            observation.task,
          ])),
          new Promise(resolve => { cleanupTimer = setTimeout(resolve, 1_000) }),
        ])
        clearTimeout(cleanupTimer)
      }
      return pending.size
    },
    restore: () => { globalThis.fetch = originalFetch },
  }
}

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

async function readSession(origin, id) {
  const response = await fetch(`${origin}/api/browser-native/session/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, requestId: `workspace-e2e-${randomUUID()}`, sessionId: id, offset: 0 }),
  })
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  return body
}

async function waitForTurn(origin, id, prompt, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await readSession(origin, id)
    const userIndex = latest.events.findLastIndex(event => event.type === 'user/message' && eventText(event).trim() === prompt.trim())
    if (userIndex >= 0) {
      const turnEnd = latest.events.slice(userIndex + 1).find(event => event.type === 'turn/end')
      if (turnEnd !== undefined) return { session: latest, turnEnd }
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  throw new Error(`Session did not complete prompt ${prompt}; recent events: ${JSON.stringify(latest?.events?.slice(-10).map(event => ({
    type: event.type,
    name: event.data?.name,
    reason: event.data?.reason,
  })) ?? [])}`)
}

async function chooseWorkspace(page) {
  const chooser = page.getByRole('textbox', { name: /^(Choose workspace|选择工作区)$/ }).first()
  await chooser.click()
  const dialog = page.getByRole('dialog', { name: /^(Select Workspace Directory|选择工作区目录)$/ })
  await dialog.waitFor({ timeout: 15_000 })
  const editPath = dialog.getByRole('button', { name: /^(Edit path|编辑路径)$/ })
  if (await editPath.count() > 0 && await editPath.isVisible()) await editPath.click()
  const pathInput = dialog.getByRole('textbox', { name: /^(Edit path|编辑路径)$/ })
  if (await pathInput.count() > 0) {
    await pathInput.fill('/dsh/home/workspace/')
    await pathInput.press('Enter')
  }
  await dialog.getByRole('button', { name: /^(Open|打开)$/ }).click()
}

async function startServer() {
  const llmTimeoutMs = Number(process.env.DSH_POC_LLM_TIMEOUT_MS ?? '180000')
  const app = await createBrowserNativeV2Server({ dataDir, distRoot, llmMode: mode, envFile, llmTimeoutMs })
  const origin = await app.listen(port)
  return { app, origin, pid: process.pid }
}

function monitorChildProcessLaunches() {
  const childProcess = require('node:child_process')
  const names = ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']
  const originals = new Map()
  let launches = 0
  for (const name of names) {
    const original = childProcess[name]
    originals.set(name, original)
    childProcess[name] = function (...args) {
      launches += 1
      return Reflect.apply(original, this, args)
    }
  }
  return {
    count: () => launches,
    restore: () => {
      for (const [name, original] of originals) childProcess[name] = original
    },
  }
}

async function readSecrets(file) {
  try {
    const text = await readFile(file, 'utf8')
    return text.split(/\r?\n/)
      .map(line => line.match(/^(?:OPENAI_NEXT_(?:GPT|GROK)_API_KEY|DEEPSEEK_API_KEY)=(.*)$/)?.[1])
      .filter(value => value !== undefined && value.length > 0)
  } catch {
    return []
  }
}

let app
let browser
let page
let context
let sessionId
let workspaceId
let latestSession
let secondTab
let serverRestartCount = 0
let backendPid
let childProcessMonitor
let coldStartMs
let restoreMs
let workerCreations = 0
const requests = []
const externalBrowserRequests = []
const pageErrors = []
const consoleErrors = []
const llmStatuses = []
const llmObserver = observeLlmStreams()

try {
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  childProcessMonitor = monitorChildProcessLaunches()
  const firstServer = await startServer()
  app = firstServer.app
  const origin = firstServer.origin
  backendPid = firstServer.pid
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  page.on('worker', () => { workerCreations += 1 })
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) externalBrowserRequests.push(request.url())
    if (request.url().includes('/api/browser-native/')) requests.push({
      url: request.url(),
      method: request.method(),
      body: requestJson(request),
      bytes: request.postDataBuffer()?.byteLength ?? 0,
    })
  })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('response', response => {
    if (response.url().endsWith('/api/browser-native/llm')) llmStatuses.push(response.status())
  })

  const coldStart = performance.now()
  await page.goto(`${origin}/preview.html?browser-native=1&preview-fixture=none`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  const continueButton = page.getByRole('button', { name: /^(Continue|继续)$/ }).first()
  if (await continueButton.count() > 0 && await continueButton.isVisible()) await continueButton.click()
  await chooseWorkspace(page)
  await page.getByText('Browser-native remote', { exact: true }).waitFor({ timeout: 15_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  coldStartMs = performance.now() - coldStart

  const sendButton = page.getByRole('button', { name: /^(Send message|发送消息)$/ })
  for (const [index, prompt] of prompts.entries()) {
    const currentInput = page.locator('[data-composer-input][contenteditable="true"]').last()
    await currentInput.fill(prompt)
    assert.equal(await sendButton.isEnabled(), true, 'the chat UI must accept the Workspace prompt')
    await sendButton.click()
    if (sessionId === undefined) {
      const deadline = Date.now() + 15_000
      while (sessionId === undefined && Date.now() < deadline) {
        sessionId = requests.find(request => request.url.endsWith('/session/create'))?.body?.sessionId
        if (typeof sessionId !== 'string') {
          sessionId = undefined
          await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
        }
      }
      assert.equal(typeof sessionId, 'string', 'the DSH Web UI did not create its Session')
    }
    const { session, turnEnd } = await waitForTurn(origin, sessionId, prompt,
      Number(process.env.DSH_POC_TURN_TIMEOUT_MS ?? (mode === 'real' ? 600_000 : 60_000)))
    latestSession = session
    assert.equal(turnEnd.data.reason.kind, 'completed', `turn ended as ${JSON.stringify(turnEnd.data.reason)}`)
    const turnText = session.events
      .filter(event => event.type === 'assistant/message' && event.data.turn === turnEnd.data.turn)
      .map(eventText)
      .join('\n')
    assert.equal(turnText.includes(index === 0 ? firstMarker : secondMarker), true,
      `turn did not include its success marker: ${JSON.stringify(turnText.slice(-1_000))}`)
    await page.getByText(index === 0 ? firstMarker : secondMarker, { exact: false }).last().waitFor({ timeout: 30_000 })
    if (index === 0) {
      const storedSession = JSON.parse(await readFile(join(dataDir, 'sessions', `${sessionId}.json`), 'utf8'))
      assert.equal(storedSession.header.cwd, '/dsh/home/workspace',
        'the Session sandbox root must be exactly the synced Workspace directory')
      await page.waitForFunction(() => {
        const status = window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__
        return status?.state === 'synced' && (status.revision ?? 0) >= 1
      }, undefined, { timeout: 30_000 })
      const status = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
      workspaceId = status?.workspaceId
      assert.equal(typeof workspaceId, 'string')
      const cookie = (await context.cookies(`${origin}/api/browser-native/workspace`))
        .find(value => value.name === 'dsh-browser-native-principal')
      assert.notEqual(cookie, undefined, 'the backend identity cookie must be HttpOnly and browser-owned')
      assert.equal(cookie?.httpOnly, true)
      assert.equal(await page.evaluate(() => document.cookie.includes('dsh-browser-native-principal')), false,
        'page JavaScript must not read the backend identity cookie')
      const manifestResponse = await fetch(`${origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${workspaceId}`, {
        headers: { cookie: `${cookie?.name}=${cookie?.value}` },
      })
      const manifest = await manifestResponse.json()
      const relativePath = filePath.slice('/dsh/home/workspace/'.length)
      const entry = manifest.entries.find(value => value.path === relativePath)
      assert.notEqual(entry, undefined, 'DSH file-tool write must be present in the committed manifest')
      assert.equal(manifest.revision, 1, 'one atomic DSH file write must publish one final Workspace revision')
      assert.deepEqual(manifest.entries.map(value => value.path), [relativePath],
        'DSH atomic-write staging paths must never enter the Workspace manifest')
      assert.equal(entry.bytes, Buffer.byteLength(exactContents))
      const blobResponse = await fetch(`${origin}/api/browser-native/workspace/blob/${entry.hash}?protocolVersion=1&workspaceId=${workspaceId}`, {
        headers: { cookie: `${cookie?.name}=${cookie?.value}` },
      })
      const blob = Buffer.from(await blobResponse.arrayBuffer())
      assert.equal(blob.toString('utf8'), exactContents)
      assert.equal(createHash('sha256').update(blob).digest('hex'), entry.hash)
      const workspaceNotice = page.locator('[data-browser-native-workspace-status]')
      await workspaceNotice.waitFor({ state: 'visible' })
      assert.match(await workspaceNotice.textContent() ?? '', /synced|已同步/)
      const fileCalls = session.events.filter(event => event.type === 'tool/call' && ['write', 'read'].includes(event.data.name))
      assert.equal(fileCalls.some(event => JSON.stringify(event.data.arguments).includes(relativePath)), true,
        'the DSH Session must record the path used by its file tool')
      assert.equal(fileCalls.filter(event => event.data.name === 'write'
        && JSON.stringify(event.data.arguments).includes(relativePath)).length, 1,
      'the DSH write tool must execute exactly once for the target file')
      process.stdout.write(`${JSON.stringify({ phase: 'workspace-commit', workspaceId, revision: manifest.revision, path: relativePath, bytes: blob.byteLength })}\n`)

      await app.close()
      const restarted = await startServer()
      app = restarted.app
      serverRestartCount += 1
      const restartedPid = restarted.pid
      assert.equal(restartedPid, backendPid, 'the shared backend service must keep one process across Sessions and turns')
      const restoreStart = performance.now()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await page.getByText(firstMarker, { exact: false }).last().waitFor({ timeout: 30_000 })
      await page.waitForFunction(() => {
        const status = window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__
        return status?.state === 'synced' && (status.revision ?? 0) >= 1
      }, undefined, { timeout: 30_000 })
      restoreMs = performance.now() - restoreStart
    }
  }

  const contextMessages = await readSession(origin, sessionId)
  latestSession = contextMessages
  assert.equal(contextMessages.events.filter(event => event.type === 'turn/end').length >= 2, true,
    'the same Session must accept another turn after backend and Worker restart')
  const restoredRead = contextMessages.events.filter(event => event.type === 'tool/call'
    && event.data.turn === 2 && event.data.name === 'read')
  assert.equal(restoredRead.length >= 1, true, 'the post-restart turn must call the DSH read tool')
  const restoredResults = new Map(contextMessages.events.filter(event => event.type === 'tool/result')
    .map(event => [event.data.message?.toolCallId ?? event.data.message?.source?.callId ?? event.data.callId, event]))
  const restoredReadResult = restoredResults.get(restoredRead[0].data.callId)
  assert.notEqual(restoredReadResult, undefined)
  assert.equal(restoredReadResult.data.message.isError, false)
  assert.equal(restoredReadResult.data.meta.lines.map(line => line.text).join('\n'), exactContents,
    'the DSH tool result after restart must contain the exact restored file contents')

  secondTab = await context.newPage()
  secondTab.on('worker', () => { workerCreations += 1 })
  secondTab.on('request', request => {
    if (new URL(request.url()).origin !== origin) externalBrowserRequests.push(request.url())
    if (request.url().includes('/api/browser-native/')) requests.push({
      url: request.url(),
      method: request.method(),
      body: requestJson(request),
      bytes: request.postDataBuffer()?.byteLength ?? 0,
    })
  })
  secondTab.on('pageerror', error => pageErrors.push(error.message))
  secondTab.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await secondTab.goto(`${origin}/preview.html?browser-native=1&preview-fixture=none`, { waitUntil: 'domcontentloaded' })
  await secondTab.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  const secondContinueButton = secondTab.getByRole('button', { name: /^(Continue|继续)$/ }).first()
  if (await secondContinueButton.count() > 0 && await secondContinueButton.isVisible()) await secondContinueButton.click()
  await secondTab.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const secondTabWorkspace = await secondTab.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
  assert.equal(secondTabWorkspace.workspaceId, workspaceId, 'both browser tabs must address the same cookie-owned Workspace')
  assert.equal(secondTabWorkspace.revision, 1)
  const remoteCommit = await secondTab.evaluate(async ({ path, content }) => {
    const bytes = new TextEncoder().encode(content)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
    const uploaded = await fetch(`/api/browser-native/workspace/blob/${hash}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/octet-stream',
        'x-browser-native-protocol': '1',
        'x-request-id': crypto.randomUUID(),
        'x-workspace-id': window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId ?? '',
      },
      body: bytes,
    })
    if (!uploaded.ok) return { status: uploaded.status, body: await uploaded.json() }
    const response = await fetch('/api/browser-native/workspace/commit', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        workspaceId: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId,
        baseRevision: 1,
        operationId: crypto.randomUUID(),
        changes: [{ path, kind: 'file', hash, bytes: bytes.byteLength, mode: 0o600 }],
      }),
    })
    return { status: response.status, body: await response.json() }
  }, { path: remoteFilePath.slice('/dsh/home/workspace/'.length), content: remoteContents })
  assert.equal(remoteCommit.status, 200, JSON.stringify(remoteCommit.body))
  assert.equal(remoteCommit.body.revision, 2)

  const conflictInput = page.locator('[data-composer-input][contenteditable="true"]').last()
  await conflictInput.fill(conflictWritePrompt)
  await sendButton.click()
  const conflictTurn = await waitForTurn(origin, sessionId, conflictWritePrompt,
    Number(process.env.DSH_POC_TURN_TIMEOUT_MS ?? 600_000))
  latestSession = conflictTurn.session
  assert.equal(conflictTurn.turnEnd.data.reason.kind, 'completed', JSON.stringify(conflictTurn.turnEnd.data.reason))
  assert.equal(latestSession.events.filter(event => event.type === 'assistant/message' && event.data.turn === 3)
    .map(eventText).join('\n').includes(conflictMarker), true)
  await page.getByText(conflictMarker, { exact: false }).last().waitFor({ timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'conflict', undefined, { timeout: 30_000 })
  const conflictStatus = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
  assert.equal(conflictStatus.revision, 1, 'the stale Worker must retain its confirmed revision')
  assert.equal(conflictStatus.dirtyCount > 0, true, 'the stale Worker must preserve its uncommitted local file')

  const localReadInput = page.locator('[data-composer-input][contenteditable="true"]').last()
  await localReadInput.fill(localReadPrompt)
  await sendButton.click()
  const localReadTurn = await waitForTurn(origin, sessionId, localReadPrompt,
    Number(process.env.DSH_POC_TURN_TIMEOUT_MS ?? 600_000))
  latestSession = localReadTurn.session
  assert.equal(localReadTurn.turnEnd.data.reason.kind, 'completed', JSON.stringify(localReadTurn.turnEnd.data.reason))
  assert.equal(latestSession.events.filter(event => event.type === 'assistant/message' && event.data.turn === 4)
    .map(eventText).join('\n').includes(localReadMarker), true)
  await page.getByText(localReadMarker, { exact: false }).last().waitFor({ timeout: 30_000 })

  const finalManifest = await secondTab.evaluate(async workspaceIdValue => {
    const response = await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceIdValue)}`)
    return await response.json()
  }, workspaceId)
  assert.equal(finalManifest.revision, 2)
  assert.deepEqual(finalManifest.entries.map(entry => entry.path).sort(), [
    filePath.slice('/dsh/home/workspace/'.length),
    remoteFilePath.slice('/dsh/home/workspace/'.length),
  ].sort())

  const finalSession = await readSession(origin, sessionId)
  latestSession = finalSession
  const finalToolCalls = finalSession.events.filter(event => event.type === 'tool/call')
  const finalToolResults = new Map(finalSession.events.filter(event => event.type === 'tool/result')
    .map(event => [event.data.message?.toolCallId ?? event.data.message?.source?.callId ?? event.data.callId, event]))
  const localWrite = finalToolCalls.find(event => event.data.turn === 3 && event.data.name === 'write')
  assert.notEqual(localWrite, undefined)
  assert.equal(JSON.parse(localWrite.data.arguments).file_path, localConflictPath)
  assert.equal(JSON.parse(localWrite.data.arguments).content, localConflictContents)
  const localRead = finalToolCalls.find(event => event.data.turn === 4 && event.data.name === 'read')
  assert.notEqual(localRead, undefined)
  const localReadResult = finalToolResults.get(localRead.data.callId)
  assert.notEqual(localReadResult, undefined)
  assert.equal(localReadResult.data.message.isError, false)
  assert.equal(localReadResult.data.meta.lines.map(line => line.text).join('\n'), localConflictContents,
    'the stale Worker must retain its local file after the cloud CAS conflict')
  assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors)}`)
  assert.deepEqual(consoleErrors.filter(message => /workspace.*failed|worker host startup failed/i.test(message)), [],
    `workspace/worker errors: ${JSON.stringify(consoleErrors)}`)
  assert.equal(llmStatuses.every(status => status === 200), true, JSON.stringify(llmStatuses))
  assert.equal(llmStatuses.length >= 4, true, 'all DSH turns must reach the real LLM proxy')
  assert.deepEqual(externalBrowserRequests, [], 'browser traffic must stay same-origin; LLM credentials remain backend-only')
  const toolCallsByTurn = new Map()
  for (const event of finalToolCalls) {
    const calls = toolCallsByTurn.get(event.data.turn) ?? []
    calls.push(event)
    toolCallsByTurn.set(event.data.turn, calls)
  }
  assert.deepEqual(toolCallsByTurn.get(1)?.filter(event => event.data.name === 'write').length, 1,
    'the initial turn must write the target file exactly once')
  assert.equal(toolCallsByTurn.get(1)?.filter(event => event.data.name === 'read').length >= 1, true,
    'the initial turn must read the target file after writing it')
  assert.deepEqual(toolCallsByTurn.get(2)?.map(event => event.data.name), ['read'],
    'the restored turn must read the committed file once')
  assert.deepEqual(toolCallsByTurn.get(3)?.map(event => event.data.name), ['write'],
    'the conflict turn must write the local file once')
  assert.deepEqual(toolCallsByTurn.get(4)?.map(event => event.data.name), ['read'],
    'the recovery turn must read the local file once')
  const allPrompts = [...prompts, conflictWritePrompt, localReadPrompt]
  assert.equal(finalSession.events.filter(event => event.type === 'user/message'
    && allPrompts.some(prompt => eventText(event).trim() === prompt.trim())).length, allPrompts.length,
  'each requested turn must be appended once to the authoritative DSH Session')
  const wire = JSON.stringify(requests)
  for (const secret of await readSecrets(envFile)) {
    assert.equal(wire.includes(secret), false, 'provider secret leaked into browser API traffic')
    assert.equal(JSON.stringify(finalSession).includes(secret), false, 'provider secret leaked into the Session log')
    assert.equal(JSON.stringify(finalManifest).includes(secret), false, 'provider secret leaked into the Workspace manifest')
  }
  assert.equal(childProcessMonitor?.count(), 0, 'the shared backend must not launch OS child processes for DSH work')

  const pendingLlmStreams = await llmObserver.settle()
  assert.equal(pendingLlmStreams, 0, 'the LLM stream observer must finish before E2E success')
  assert.equal(llmObserver.summaries.some(summary => summary.truncated === true), false,
    'LLM stream summaries must not be truncated on a passing run')
  const screenshotPath = join(dataDir, 'workspace-sync-final.png')
  await page.screenshot({ path: screenshotPath, fullPage: true })
  const evidence = {
    result: 'passed',
    mode,
    browser: 'Chrome',
    browserVersion: browser.version(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    backendPid,
    backendInstanceRestarts: serverRestartCount,
    coldStartMs,
    restoreMs,
    workerCreations,
    workspaceFileBytes: finalManifest.entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0),
    manifestBytes: Buffer.byteLength(JSON.stringify(finalManifest)),
    uploadedBlobBytes: requests.filter(request => request.method === 'PUT' && request.url.includes('/workspace/blob/'))
      .reduce((total, request) => total + request.bytes, 0),
    sessionId,
    turns: allPrompts.length,
    llmStatuses,
    upstreamLlmStreams: llmObserver.summaries,
    pendingLlmStreams,
    toolCalls: (latestSession?.events ?? []).filter(event => event.type === 'tool/call').length,
    workspaceStatus: await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__),
    screenshotPath,
    expectedStaleWriterConflict: true,
    apiRoutes: [...new Set(requests.map(request => new URL(request.url).pathname))],
    backendChildProcessLaunches: childProcessMonitor?.count() ?? null,
    externalBrowserRequests,
    pageErrors,
    consoleErrors,
  }
  await writeFile(join(dataDir, 'workspace-sync-result.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
} catch (error) {
  const pendingLlmStreams = await llmObserver.settle()
  let failureScreenshot
  let visiblePageText
  let failureCaptureError
  try {
    if (page !== undefined && !page.isClosed()) {
      failureScreenshot = join(dataDir, 'workspace-sync-failure.png')
      await page.screenshot({ path: failureScreenshot, fullPage: true })
      visiblePageText = (await page.locator('body').innerText({ timeout: 2_000 })).slice(0, 4_000)
    }
  } catch (captureError) {
    failureCaptureError = captureError instanceof Error ? captureError.message : String(captureError)
  }
  process.stderr.write(`${JSON.stringify({
    result: 'failed',
    error: error instanceof Error ? error.message : String(error),
    dataDir,
    failureScreenshot,
    pageUrl: page?.url(),
    visiblePageText,
    failureCaptureError,
    sessionId,
    llmStatuses,
    upstreamLlmStreams: llmObserver.summaries,
    pendingLlmStreams,
    apiRequests: requests.map(request => ({ path: new URL(request.url).pathname, method: request.method })),
    llmRequestTools: requests.filter(request => request.url.endsWith('/llm')).map(request => llmRequestSummary(
      undefined,
      request.body,
    )),
    sessionToolCalls: latestSession?.events?.filter(event => event.type === 'tool/call')
      .map(event => event.data?.name),
    externalBrowserRequests,
    recentEvents: latestSession?.events?.slice(-20).map(event => ({ type: event.type, name: event.data?.name, reason: event.data?.reason })),
    pageErrors,
    consoleErrors,
  })}\n`)
  process.exitCode = 1
} finally {
  llmObserver.restore()
  childProcessMonitor?.restore()
  await browser?.close()
  await app?.close()
  if (process.env.DSH_POC_KEEP_DATA !== '1') await rm(dataDir, { recursive: true, force: true })
}
