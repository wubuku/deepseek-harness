import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-file-tools-')))
const pageErrors = []
const workerErrors = []
const externalRequests = []
const commits = []
const requests = []
let image
let app
let browser
let page

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
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
  const lines = Array.from({ length: 300 }, (_, index) => `BROWSER_NATIVE_BOUNDARY_MATCH ${String(index)}`).join('\n')
  assert.equal((await testAction({ action: 'write', path: '/dsh/home/workspace/boundary.txt', content: `${lines}\n` }))?.ok, true)
  const longLine = `${'x'.repeat(70 * 1024)}BROWSER_NATIVE_LONG_EDIT_MARKER\n`
  assert.equal((await testAction({ action: 'write', path: '/dsh/home/workspace/long-edit.txt', content: longLine }))?.ok, true)
  assert.equal((await testAction({ action: 'write-binary', path: '/dsh/home/workspace/binary.bin', base64: 'AP+AQQ==' }))?.ok, true)
  assert.equal((await testAction({ action: 'flush-workspace' }))?.ok, true)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 60_000 })
  const seedCommitCount = commits.length

  const searchTurn = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_FILE_TOOL_BOUNDARY_E2E: search the boundary fixture, then demonstrate invalid regex handling.',
    marker: 'BROWSER_NATIVE_FILE_TOOL_BOUNDARY_DONE',
    timeout: 60_000,
  })
  const searchCalls = searchTurn.session.events.filter(event => event.type === 'tool/call' && event.data.turn === searchTurn.turn)
  assert.deepEqual(searchCalls.map(event => event.data.name), ['grep', 'grep', 'grep'])
  const searchResults = searchTurn.session.events.filter(event => event.type === 'tool/result')
  const firstSearchResult = searchResults.find(event => event.data.message?.toolCallId === searchCalls[0].data.callId)
  const invalidSearchResult = searchResults.find(event => event.data.message?.toolCallId === searchCalls[1].data.callId)
  const binarySearchResult = searchResults.find(event => event.data.message?.toolCallId === searchCalls[2].data.callId)
  assert.ok(firstSearchResult)
  assert.notEqual(firstSearchResult.data.message.isError, true, JSON.stringify(firstSearchResult.data.message))
  assert.match(firstSearchResult.data.message.content.map(block => block.text ?? '').join(''), /Found 250 of 300 matches/)
  assert.ok(JSON.stringify(firstSearchResult.data).length < 64 * 1024)
  assert.ok(invalidSearchResult)
  assert.equal(invalidSearchResult.data.message.isError, true)
  assert.match(invalidSearchResult.data.message.content.map(block => block.text ?? '').join(''), /SEARCH_INVALID_PATTERN/)
  assert.ok(binarySearchResult)
  assert.equal(binarySearchResult.data.message.isError, true)
  assert.match(binarySearchResult.data.message.content.map(block => block.text ?? '').join(''), /SEARCH_BINARY_FILE/)
  assert.equal(assistantText(searchTurn.session, searchTurn.turn).includes('BROWSER_NATIVE_FILE_TOOL_BOUNDARY_DONE'), true)

  const editTurn = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_EDIT_BOUNDARY_E2E: replace the marker in the long line.',
    marker: 'BROWSER_NATIVE_EDIT_BOUNDARY_DONE',
    timeout: 60_000,
  })
  const editCall = editTurn.session.events.find(event => event.type === 'tool/call'
    && event.data.turn === editTurn.turn && event.data.name === 'edit')
  assert.equal(editCall.data.name, 'edit')
  const editResult = editTurn.session.events.find(event => event.type === 'tool/result'
    && event.data.message?.toolCallId === editCall.data.callId)
  assert.ok(editResult)
  assert.equal(editResult.data.message.isError, false)
  const editedFile = await testAction({ action: 'read', path: '/dsh/home/workspace/long-edit.txt' })
  assert.equal(editedFile?.ok, true)
  assert.equal(editedFile.content.includes('BROWSER_NATIVE_LONG_EDIT_REPLACED'), true)
  assert.equal(editedFile.content.includes('BROWSER_NATIVE_LONG_EDIT_MARKER'), false)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 60_000 })
  assert.equal(commits.length, seedCommitCount + 1, 'the chunk-backed edit must create one Workspace commit')

  const continueTurn = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_FILE_TOOL_BOUNDARY_CONTINUE_E2E: continue after the rejected edit.',
    marker: 'BROWSER_NATIVE_FILE_TOOL_BOUNDARY_CONTINUE_OK',
    timeout: 60_000,
  })
  assert.deepEqual(continueTurn.session.events.filter(event => event.type === 'tool/call' && event.data.turn === continueTurn.turn), [])
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    scope: 'real-DSH-browser-native-search-and-edit-boundaries',
    sessionId: searchTurn.sessionId,
    seedCommitCount,
    commitCount: commits.length,
    searchToolSequence: searchCalls.map(event => event.data.name),
    invalidSearchError: invalidSearchResult.data.message.content.map(block => block.text ?? '').join(''),
    binarySearchError: binarySearchResult.data.message.content.map(block => block.text ?? '').join(''),
    editResult: editResult.data.message.content.map(block => block.text ?? '').join(''),
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
