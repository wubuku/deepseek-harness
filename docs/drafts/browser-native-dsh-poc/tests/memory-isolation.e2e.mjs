/**
 * Session-scoped memory in the Browser-Native Worker.
 *
 * A scripted model writes and recalls one entry through the real `memory`
 * tool, the page is reloaded to prove OPFS persistence, and probes confirm
 * that a second Session scope and a second browser context never see the
 * first Session's entries. Tampering with a file header must fail closed.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const WRITE_PROMPT = 'MEMORY_WRITE_A: store the alpha marker in Session memory.'
const RECALL_PROMPT = 'MEMORY_RECALL_A: recall the alpha marker from Session memory.'
const MEMORY_TEXT_A = `memory-isolation-alpha-${randomUUID()}`
const MEMORY_TEXT_B = `memory-isolation-beta-${randomUUID()}`
const DONE = 'MEMORY_TURN_DONE'

function lastUserText(body) {
  const index = body.messages.findLastIndex(message => message.role === 'user'
    && typeof message.content === 'string'
    && !message.content.startsWith('Current runtime context.')
    && !message.content.startsWith('Time sampled while preparing turn'))
  const content = body.messages[index]?.content
  return { index, text: typeof content === 'string' ? content : '' }
}

function memoryFault(body) {
  const { index, text } = lastUserText(body)
  if (body.messages.slice(index + 1).some(message => message.role === 'tool')) {
    return { kind: 'text', text: DONE }
  }
  if (text.includes('MEMORY_WRITE_A')) {
    return {
      kind: 'tool-call',
      call: {
        id: 'memory-write-a',
        name: 'memory',
        arguments: { action: 'write', text: MEMORY_TEXT_A, tags: ['alpha', 'session-a'] },
      },
    }
  }
  if (text.includes('MEMORY_RECALL_A')) {
    return {
      kind: 'tool-call',
      call: { id: 'memory-recall-a', name: 'memory', arguments: { action: 'recall', query: 'memory-isolation-alpha' } },
    }
  }
  return { kind: 'text', text: DONE }
}

function parseArguments(value) {
  return typeof value === 'string' ? JSON.parse(value) : value
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-memory-'))
let image
let app
let browser
let context
let page
let secondary
let secondaryPage
const requests = []
const pageErrors = []
let origin

async function testAction(target, request) {
  return await target.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

async function memoryAction(request) {
  const response = await testAction(page, request)
  assert.equal(response?.ok, true, JSON.stringify(response))
  return response
}

function toolEvents(session, type) {
  return session.events.filter(event => event.type === type)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser', memoryIsolation: true })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: { scriptedLlmFault: memoryFault },
  })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin || !url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    requests.push({ path: url.pathname, body })
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=memory-isolation&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

  const writeTurn = await sendTurn({ page, origin, requests, prompt: WRITE_PROMPT, marker: DONE })
  const sessionId = writeTurn.sessionId
  const writeCall = toolEvents(writeTurn.session, 'tool/call').find(event => event.data.name === 'memory')
  assert.ok(writeCall, 'the scripted model must call the memory tool')
  assert.equal('sessionId' in parseArguments(writeCall.data.arguments), false, 'the model cannot choose a memory scope')
  const writeResult = toolEvents(writeTurn.session, 'tool/result').find(event => event.data.message?.toolCallId === writeCall.data.callId)
  assert.ok(writeResult, 'memory write must produce a tool result')
  assert.equal(writeResult.data.message.content.filter(block => block?.type === 'text').map(block => block.text).join('').includes(MEMORY_TEXT_A), true)
  const entryEvent = writeTurn.session.events.find(event => event.type === 'memory/entry')
  assert.ok(entryEvent, 'memory write must append a durable memory/entry event')
  assert.equal(entryEvent.data.text, MEMORY_TEXT_A)
  assert.deepEqual(entryEvent.data.tags, ['alpha', 'session-a'])

  const afterWrite = await memoryAction({ action: 'memory-inspect', sessionId })
  assert.equal(afterWrite.memory.sessionId, sessionId)
  assert.equal(afterWrite.memory.entries, 1)
  assert.ok(afterWrite.memory.bytes > 0)

  const recallTurn = await sendTurn({ page, origin, requests, prompt: RECALL_PROMPT, marker: DONE })
  const recallCall = toolEvents(recallTurn.session, 'tool/call').find(event => event.data.name === 'memory')
  const recallResult = toolEvents(recallTurn.session, 'tool/result').find(event => event.data.message?.toolCallId === recallCall?.data.callId)
  assert.ok(recallResult, 'memory recall must produce a tool result')
  const recallText = recallResult.data.message.content.filter(block => block?.type === 'text').map(block => block.text).join('')
  assert.equal(recallText.includes(MEMORY_TEXT_A), true)
  assert.equal(recallText.includes(MEMORY_TEXT_B), false, 'recall must not see another Session entry')

  const toolSchema = requests
    .filter(request => request.path.endsWith('/llm'))
    .flatMap(request => Array.isArray(request.body.tools) ? request.body.tools : [])
    .map(tool => tool?.function ?? tool)
    .find(tool => tool?.name === 'memory')
  assert.ok(toolSchema, 'the model request must advertise the memory tool')
  assert.deepEqual(toolSchema.parameters?.required ?? [], ['action'])
  assert.equal('sessionId' in (toolSchema.parameters?.properties ?? {}), false, 'a model-visible memory schema must not expose scopes')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const reloadedSession = sessionId
  await waitFor(async () => {
    const response = await sessionRequest(origin, 'read', { sessionId: reloadedSession, offset: 0 })
    return (response.events ?? []).some(event => event.type === 'memory/entry')
  }, 'memory/entry after reload')
  const afterReload = await memoryAction({ action: 'memory-inspect', sessionId })
  assert.equal(afterReload.memory.sessionId, reloadedSession)
  assert.equal(afterReload.memory.entries, 1, 'OPFS memory must survive a page reload')

  const isolatedSessionId = `memory-isolated-${randomUUID()}`
  await memoryAction({ action: 'memory-isolated-write', sessionId: isolatedSessionId, content: MEMORY_TEXT_B })
  const readA = await memoryAction({ action: 'memory-isolated-read', sessionId: reloadedSession })
  const readB = await memoryAction({ action: 'memory-isolated-read', sessionId: isolatedSessionId })
  assert.equal(readA.entries.some(entry => entry.text === MEMORY_TEXT_A), true)
  assert.equal(readA.entries.some(entry => entry.text === MEMORY_TEXT_B), false)
  assert.equal(readB.entries.some(entry => entry.text === MEMORY_TEXT_B), true)
  assert.equal(readB.entries.some(entry => entry.text === MEMORY_TEXT_A), false)
  const files = (await memoryAction({ action: 'memory-list' })).files
  assert.equal(files.includes(`${reloadedSession}.json`), true)
  assert.equal(files.includes(`${isolatedSessionId}.json`), true)

  const tampered = await memoryAction({
    action: 'memory-tamper-read',
    sessionId: isolatedSessionId,
    headerSessionId: reloadedSession,
  })
  assert.equal(tampered.result.code, 'MEMORY_ISOLATION_VIOLATION', 'a mismatched file header must fail closed')

  const benchSessionId = `memory-bench-${randomUUID()}`
  const benchResponse = await testAction(page, { action: 'memory-benchmark', sessionId: benchSessionId, iterations: 8 })
  assert.equal(benchResponse?.ok, true, JSON.stringify(benchResponse))
  const samples = benchResponse.benchmark
  const evidence = {
    scope: { kind: 'workspace+session+opfs-file', headerTamper: tampered.result.code },
    persistence: { eventsAfterReload: afterReload.memory.entries, bytes: afterReload.memory.bytes },
    isolation: {
      sessionA: { entries: readA.entries.length, hasA: true, hasB: false },
      sessionB: { entries: readB.entries.length, hasA: false, hasB: true },
      files,
    },
    cost: {
      writeMs: { median: percentile(samples.writeMs, 0.5), max: Math.max(...samples.writeMs) },
      readMs: { median: percentile(samples.readMs, 0.5), max: Math.max(...samples.readMs) },
      bytes: samples.bytes,
      entries: samples.entries,
      toolTurnMs: { write: writeTurn.elapsedMs, recall: recallTurn.elapsedMs },
    },
  }

  secondary = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 } })
  secondaryPage = await secondary.newPage()
  await openPreview(secondaryPage, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=memory-isolation&preview-fixture=none`)
  await secondaryPage.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
  const crossContext = (await testAction(secondaryPage, { action: 'memory-inspect', sessionId })).memory
  assert.equal(crossContext.entries, 0, 'a second browser context must not see the first context memory')
  const crossContextList = (await testAction(secondaryPage, { action: 'memory-list' })).files
  assert.deepEqual(crossContextList, [], 'a second browser context must have no memory files')
  evidence.isolation.crossContext = { entries: crossContext.entries, files: crossContextList }

  assert.deepEqual(pageErrors, [], 'the preview must not raise page errors')
  console.log(JSON.stringify({ memory: evidence }))
} finally {
  await secondary?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.dispose?.().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
