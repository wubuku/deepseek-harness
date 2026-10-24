import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const port = Number(process.env.DSH_POC_PORT ?? '0')
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-opfs-agent-file-tools-')))
const filePath = '/dsh/home/workspace/opfs-agent-file.txt'
const fileBytes = Number(process.env.DSH_POC_OPFS_AGENT_FILE_BYTES ?? 12 * 1024 * 1024)
const turnTimeoutMs = Number(process.env.DSH_POC_AGENT_TURN_TIMEOUT_MS ?? 120_000)
const targetBefore = 'BROWSER_NATIVE_OPFS_EDIT_TARGET_V1'
const targetAfter = 'BROWSER_NATIVE_OPFS_EDIT_TARGET_V2'
const firstPrompt = 'BROWSER_NATIVE_OPFS_AGENT_TOOLS_E2E: read line 2, grep the marker, replace it once, then read line 2 again.'
const secondPrompt = 'BROWSER_NATIVE_OPFS_AGENT_AFTER_REFRESH_E2E: read line 2 from the same file and report the marker.'

if (!Number.isSafeInteger(fileBytes) || fileBytes < 10 * 1024 * 1024 || fileBytes > 16 * 1024 * 1024) {
  throw new Error('DSH_POC_OPFS_AGENT_FILE_BYTES must be between 10 MiB and 16 MiB')
}
if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 5_000) throw new Error('DSH_POC_AGENT_TURN_TIMEOUT_MS must be at least 5000')
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')

async function testAction(page, request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

function eventText(event) {
  const content = event.data?.message?.content ?? event.data?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
}

function toolResultId(event) {
  return event.data?.message?.toolCallId ?? event.data?.toolCallId ?? event.data?.callId
}

async function workspaceCookieHeader(page, origin) {
  const cookies = await page.context().cookies(`${origin}/api/browser-native/workspace`)
  const principal = cookies.find(cookie => cookie.name === 'dsh-browser-native-principal')
  assert.ok(principal, 'browser Workspace principal cookie is missing')
  return `${principal.name}=${principal.value}`
}

async function readManifest(origin, workspaceId, cookieHeader) {
  const response = await fetch(`${origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`, {
    headers: { cookie: cookieHeader },
  })
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  return body
}

async function hashBlob(origin, workspaceId, hash, cookieHeader) {
  const response = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`, {
    headers: { cookie: cookieHeader },
  })
  assert.equal(response.ok, true, `blob fetch failed with HTTP ${response.status}`)
  const digest = createHash('sha256')
  let byteLength = 0
  let tail = Buffer.alloc(0)
  let prefix = Buffer.alloc(0)
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk)
    byteLength += bytes.byteLength
    digest.update(bytes)
    tail = Buffer.concat([tail, bytes]).subarray(-128)
    if (prefix.byteLength < 16_384) prefix = Buffer.concat([prefix, bytes]).subarray(0, 16_384)
  }
  return { byteLength, digest: digest.digest('hex'), tail: tail.toString('utf8'), prefix: prefix.toString('utf8') }
}

let image
let app
let browser
let page
let holdNextCommit = false
let heldCommit = false
let releaseCommit
const commitGate = new Promise(resolveCommit => { releaseCommit = resolveCommit })
const pageErrors = []
const workerErrors = []
const nonLocalRequests = []
const requests = []
const llmBodies = []
const appendBodies = []
const commits = []
const llmStatuses = []
const commitStatuses = []
const consoleMessages = []

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(port)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => consoleMessages.push({ type: message.type(), text: message.text().slice(0, 500) }))
  page.on('requestfailed', request => requests.push({ path: new URL(request.url()).pathname, failed: request.failure()?.errorText }))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
    if (url.pathname === '/api/browser-native/session/create') {
      let body
      try { body = request.postDataJSON() } catch { body = undefined }
      requests.push({ path: url.pathname, body })
    }
    if (url.pathname === '/api/browser-native/llm') llmBodies.push(request.postData() ?? '')
    if (url.pathname === '/api/browser-native/session/append') appendBodies.push(request.postData() ?? '')
    if (url.pathname === '/api/browser-native/workspace/commit') {
      let body
      try { body = request.postDataJSON() } catch { body = undefined }
      commits.push(body)
    }
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname === '/api/browser-native/llm') llmStatuses.push(response.status())
    if (url.pathname === '/api/browser-native/workspace/commit') commitStatuses.push(response.status())
  })
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    if (holdNextCommit) {
      holdNextCommit = false
      heldCommit = true
      await commitGate
    }
    await route.continue()
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const beforeWriteUsage = await testAction(page, { action: 'usage' })
  const invalidPattern = await testAction(page, {
    action: 'write-pattern', path: '/dsh/home/workspace/invalid-pattern.txt',
    byteLength: 64, byteValue: 0x41, markerLine: 2, marker: 'MISSING_LINE_WIDTH',
  })
  assert.equal(invalidPattern?.ok, false, 'marker generation must reject a missing line width')
  assert.match(invalidPattern.error, /marker requires lineBytes and markerLine/)
  const generated = await testAction(page, {
    action: 'write-pattern', path: filePath, byteLength: fileBytes, byteValue: 0x41,
    lineBytes: 4096, markerLine: 2, marker: targetBefore,
  })
  assert.equal(generated?.ok, true, JSON.stringify(generated))
  assert.equal((await testAction(page, { action: 'flush-workspace' }))?.ok, true)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 120_000 })
  const identity = await page.evaluate(async () => await (await fetch('/api/browser-native/workspace/identity')).json())
  const cookieHeader = await workspaceCookieHeader(page, origin)
  const seedCommitCount = commits.length
  assert.ok(seedCommitCount >= 1, 'the generated file and marker must be committed before cold hydration')
  const seededManifest = await readManifest(origin, identity.workspaceId, cookieHeader)
  assert.equal(seededManifest.revision, seedCommitCount)
  assert.deepEqual(seededManifest.entries.map(entry => entry.path), ['opfs-agent-file.txt'])
  const seededEntry = seededManifest.entries[0]
  assert.equal(seededEntry.bytes, fileBytes)
  const seededUsage = await testAction(page, { action: 'usage' })
  assert.ok(seededUsage.residentBytes >= beforeWriteUsage.residentBytes + fileBytes, JSON.stringify({ beforeWriteUsage, seededUsage }))

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const coldUsage = await testAction(page, { action: 'usage' })
  assert.ok(coldUsage.logicalBytes >= fileBytes, JSON.stringify(coldUsage))
  assert.ok(coldUsage.residentBytes < seededUsage.residentBytes - fileBytes / 2,
    JSON.stringify({ seededUsage, coldUsage }))

  holdNextCommit = true
  const firstTurnPromise = sendTurn({
    page,
    origin,
    requests,
    prompt: firstPrompt,
    marker: 'BROWSER_NATIVE_OPFS_AGENT_TOOLS_DONE',
    timeout: turnTimeoutMs,
  })
  firstTurnPromise.catch(() => {})
  try {
    await waitFor(async () => heldCommit, 'Agent edit Workspace commit to pause', Math.min(90_000, turnTimeoutMs - 1_000))
  } catch (error) {
    const sessionId = requests.find(request => request.path.endsWith('/session/create'))?.body?.sessionId
    const session = sessionId === undefined ? undefined : await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const summary = session?.events?.map(event => event.type === 'tool/call'
      ? { type: event.type, name: event.data.name, callId: event.data.callId }
      : event.type === 'tool/result'
        ? { type: event.type, callId: toolResultId(event), isError: event.data.message?.isError ?? false, text: eventText(event).slice(0, 200) }
        : event.type === 'turn/end'
          ? { type: event.type, reason: event.data.reason }
          : { type: event.type, turn: event.data?.turn })
    process.stderr.write(`${JSON.stringify({
      failure: String(error),
      llmRequestCount: llmBodies.length,
      workspaceCommitRequests: commits.length,
      commitStatuses,
      workspaceStatus: await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__),
      usage: await testAction(page, { action: 'usage' }),
      consoleWarnings: consoleMessages.filter(message => message.type === 'warning').slice(-8),
      events: summary,
    })}\n`)
    throw error
  }
  const duringEditUsage = await testAction(page, { action: 'usage' })
  assert.ok(duringEditUsage.residentBytes >= coldUsage.residentBytes + fileBytes / 2,
    JSON.stringify({ coldUsage, duringEditUsage }))
  const pendingState = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state)
  assert.notEqual(pendingState, 'synced', 'Workspace must not claim sync while the edit commit is blocked')
  releaseCommit()
  let firstTurn
  try {
    firstTurn = await firstTurnPromise
  } catch (error) {
    const sessionId = requests.find(request => request.path.endsWith('/session/create'))?.body?.sessionId
    const session = sessionId === undefined ? undefined : await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const events = session?.events?.map(event => {
      if (event.type === 'tool/call') return { type: event.type, name: event.data.name, callId: event.data.callId }
      if (event.type === 'tool/result') return {
        type: event.type,
        callId: toolResultId(event),
        isError: event.data.message?.isError ?? event.data.isError ?? false,
        bytes: Buffer.byteLength(JSON.stringify(event.data)),
        text: eventText(event).slice(0, 300),
      }
      if (event.type === 'assistant/message') return {
        type: event.type,
        turn: event.data.turn,
        bytes: Buffer.byteLength(JSON.stringify(event.data.message?.content ?? [])),
      }
      if (event.type === 'turn/end') return { type: event.type, turn: event.data.turn, reason: event.data.reason }
      if (event.type === 'browser-native/workspace-receipt') return {
        type: event.type,
        toolName: event.data.toolName,
        revision: event.data.revision,
      }
      return { type: event.type, turn: event.data?.turn }
    })
    const workspaceStatus = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
    const usage = await testAction(page, { action: 'usage' })
    process.stderr.write(`${JSON.stringify({
      failure: String(error),
      llmRequestCount: llmBodies.length,
      workspaceCommitRequests: commits.length,
      commitStatuses,
      workspaceStatus,
      usage,
      requests: requests.map(request => ({ path: request.path, failed: request.failed })),
      consoleMessages,
      events,
    })}\n`)
    throw error
  }

  const firstCalls = firstTurn.session.events.filter(event => event.type === 'tool/call' && event.data.turn === firstTurn.turn)
  assert.deepEqual(firstCalls.map(event => event.data.name), ['read', 'grep', 'edit', 'read'])
  const results = new Map(firstTurn.session.events.filter(event => event.type === 'tool/result').map(event => [toolResultId(event), event]))
  for (const call of firstCalls) {
    const result = results.get(call.data.callId)
    assert.ok(result, `missing tool result for ${call.data.name}/${call.data.callId}`)
    if (call.data.name === 'grep') {
      assert.notEqual(result.data.message?.isError, true, `browser-native grep failed: ${eventText(result)}`)
      assert.match(eventText(result), new RegExp(targetBefore))
    } else {
      assert.notEqual(result.data.message?.isError, true, `${call.data.name} failed: ${eventText(result)}`)
    }
    const resultBytes = Buffer.byteLength(JSON.stringify(result.data))
    assert.ok(resultBytes < 64 * 1024,
      `${call.data.name} result exceeded the expected bounded metadata/result size (${resultBytes} bytes; keys=${Object.keys(result.data).join(',')})`)
  }
  assert.match(eventText(results.get(firstCalls[0].data.callId)), new RegExp(targetBefore))
  assert.match(eventText(results.get(firstCalls[3].data.callId)), new RegExp(targetAfter))
  assert.equal(assistantText(firstTurn.session, firstTurn.turn).includes('BROWSER_NATIVE_OPFS_AGENT_TOOLS_DONE'), true)

  const receipts = firstTurn.session.events.filter(event => event.type === 'browser-native/workspace-receipt'
    && event.data.turn === firstTurn.turn)
  const editCall = firstCalls.find(event => event.data.name === 'edit')
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].data.callId, editCall.data.callId)
  assert.equal(receipts[0].data.toolName, 'edit')
  assert.deepEqual(receipts[0].data.paths, ['opfs-agent-file.txt'])
  assert.equal(receipts[0].data.revision, seededManifest.revision + 1)

  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 120_000 })
  assert.equal(commits.length, seedCommitCount + 1, 'the DSH edit must add exactly one Workspace commit')
  assert.deepEqual(llmStatuses, Array.from({ length: 6 }, () => 200))
  assert.deepEqual(commitStatuses, Array.from({ length: seedCommitCount + 1 }, () => 200))
  const operation = await page.evaluate(async ({ workspaceId, operationId }) => await (await fetch(
    `/api/browser-native/workspace/operation/${encodeURIComponent(operationId)}?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
  )).json(), { workspaceId: identity.workspaceId, operationId: receipts[0].data.operationId })
  assert.equal(operation.found, true)
  assert.deepEqual(operation.receipt.changedPaths, ['opfs-agent-file.txt'])
  const manifest = await readManifest(origin, identity.workspaceId, cookieHeader)
  assert.equal(manifest.revision, seededManifest.revision + 1)
  assert.deepEqual(manifest.entries.map(entry => entry.path), ['opfs-agent-file.txt'], 'atomic-write staging paths must not enter the manifest')
  const blob = await hashBlob(origin, identity.workspaceId, manifest.entries[0].hash, cookieHeader)
  assert.equal(blob.byteLength, seededEntry.bytes)
  assert.equal(blob.digest, manifest.entries[0].hash)
  assert.equal(blob.prefix.includes(targetAfter), true)

  const serializedSession = JSON.stringify(firstTurn.session.events)
  const repeatedFileContent = 'A'.repeat(4096)
  assert.equal(serializedSession.includes(repeatedFileContent), false, 'large file bytes leaked into the Session')
  const largestLlmBody = Math.max(...llmBodies.map(body => Buffer.byteLength(body)))
  const largestAppendBody = Math.max(...appendBodies.map(body => Buffer.byteLength(body)))
  assert.ok(largestLlmBody < 512 * 1024, `LLM request unexpectedly large: ${largestLlmBody}`)
  assert.ok(largestAppendBody < 512 * 1024, `Session append unexpectedly large: ${largestAppendBody}`)
  assert.equal(llmBodies.some(body => body.includes(repeatedFileContent)), false, 'large file bytes leaked into a model request')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const restoredUsage = await testAction(page, { action: 'usage' })
  assert.ok(restoredUsage.residentBytes < duringEditUsage.residentBytes - fileBytes / 2,
    JSON.stringify({ duringEditUsage, restoredUsage }))
  const restoredTurn = await sendTurn({
    page,
    origin,
    requests,
    sessionId: firstTurn.sessionId,
    prompt: secondPrompt,
    marker: 'BROWSER_NATIVE_OPFS_AGENT_AFTER_REFRESH_DONE',
    timeout: 60_000,
  })
  const restoredCalls = restoredTurn.session.events.filter(event => event.type === 'tool/call' && event.data.turn === restoredTurn.turn)
  assert.deepEqual(restoredCalls.map(event => event.data.name), ['read'])
  const restoredResults = restoredTurn.session.events.filter(event => event.type === 'tool/result')
  const restoredResult = restoredResults.find(event => toolResultId(event) === restoredCalls[0].data.callId)
  assert.ok(restoredResult)
  assert.notEqual(restoredResult.data.message?.isError, true, eventText(restoredResult))
  assert.match(eventText(restoredResult), new RegExp(targetAfter))
  assert.equal(commits.length, seedCommitCount + 1, 'refresh and read must not replay the edit or add a Workspace commit')
  const finalSession = await sessionRequest(origin, 'read', { sessionId: firstTurn.sessionId, offset: 0 })
  assert.equal(finalSession.status, 200)
  assert.equal(finalSession.events.filter(event => event.type === 'browser-native/workspace-receipt').length, 1)
  assert.equal((await readManifest(origin, identity.workspaceId, cookieHeader)).revision, seededManifest.revision + 1)
  assert.deepEqual(llmStatuses, Array.from({ length: 8 }, () => 200))
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(nonLocalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    modelMode: 'scripted-tool-selection',
    scope: 'real-DSH-read-grep-edit-over-cold-OPFS-backed-file',
    fileBytes: blob.byteLength,
    sessionId: firstTurn.sessionId,
    workspaceId: identity.workspaceId,
    firstTurnToolSequence: firstCalls.map(event => event.data.name),
    grepResult: eventText(results.get(firstCalls[1].data.callId)),
    restoredTurnToolSequence: restoredCalls.map(event => event.data.name),
    seedResidentBytes: seededUsage.residentBytes,
    coldResidentBytes: coldUsage.residentBytes,
    materializedResidentBytes: duringEditUsage.residentBytes,
    restoredResidentBytes: restoredUsage.residentBytes,
    seedCommitCount,
    commitCount: commits.length,
    workspaceRevision: manifest.revision,
    editReceiptOperationId: receipts[0].data.operationId,
    blobHash: manifest.entries[0].hash,
    largestLlmBody,
    largestSessionAppendBody: largestAppendBody,
    llmStatuses,
    pageErrors,
    workerErrors,
    nonLocalRequests,
  })}\n`)
} finally {
  releaseCommit()
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
