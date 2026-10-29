import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const mode = process.env.DSH_POC_LLM ?? 'scripted'
const envFile = process.env.DSH_POC_ENV_FILE
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-file-attachment-')))
const content = mode === 'scripted' ? Buffer.alloc(16 * 1024 * 1024, 0x61)
  : Buffer.from('BROWSER_NATIVE_ATTACHMENT_CONTENT_V1\n')
if (mode === 'scripted') {
  Buffer.from('BROWSER_NATIVE_ATTACHMENT_CONTENT_V1').copy(content)
  for (let offset = 1023; offset < content.byteLength; offset += 1024) content[offset] = 0x0a
}
const hash = createHash('sha256').update(content).digest('hex')
const attachmentPath = `/dsh/home/attachments/v1/files/${hash.slice(0, 2)}/${hash}/attachment-fixture.txt`
const marker = 'BROWSER_NATIVE_ATTACHMENT_READ_E2E'
const pageErrors = []
const backendRequests = []
const browserRequests = []
const browserResponses = []
const browserRequestFailures = []
const consoleMessages = []
const attachmentStages = []
const attachmentUploadChunks = []
let image
let app
let browser
let page

if (!['scripted', 'real'].includes(mode)) throw new Error('DSH_POC_LLM must be scripted or real')
if (mode === 'real' && envFile === undefined) throw new Error('DSH_POC_ENV_FILE is required for real mode')
const noProxy = new Set((process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').filter(Boolean))
noProxy.add('127.0.0.1')
noProxy.add('localhost')
process.env.NO_PROXY = [...noProxy].join(',')
process.env.no_proxy = process.env.NO_PROXY

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: mode, envFile,
    testHooks: {
      onAttachmentStage: stage => attachmentStages.push(stage),
      onAttachmentChunk: bytes => attachmentUploadChunks.push(bytes),
    } })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Singapore', viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => consoleMessages.push(`${message.type()}: ${message.text()}`))
  page.on('request', request => browserRequests.push({ url: request.url(), method: request.method() }))
  page.on('response', response => browserResponses.push({
    url: response.url(), status: response.status(), method: response.request().method(),
  }))
  page.on('requestfailed', request => browserRequestFailures.push({
    url: request.url(), method: request.method(), error: request.failure()?.errorText,
  }))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/browser-native/')) {
      let body
      try { body = request.postDataJSON() } catch {}
      backendRequests.push({ path: url.pathname, method: request.method(), body })
    }
  })

  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await openPreview(page, previewUrl)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
  const workspaceBefore = await page.evaluate(async () => {
    const identity = await (await fetch('/api/browser-native/workspace/identity')).json()
    const response = await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(identity.workspaceId)}`)
    return { identity, manifest: await response.json() }
  })

  const uploadResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname.startsWith('/api/browser-native/workspace/attachments/')
      && response.request().method() === 'PUT'
  }, { timeout: 20_000 })
  await page.locator('input[type="file"]').last().setInputFiles({
    name: 'attachment-fixture.txt',
    mimeType: 'text/plain',
    buffer: content,
  })
  const uploaded = await uploadResponse.catch(async error => {
    process.stderr.write(`${JSON.stringify({
      uploadError: error.message,
      bodyText: (await page.locator('body').innerText()).slice(-4000),
      pageErrors,
      consoleMessages,
      attachmentStages,
      browserResponses: browserResponses.filter(response => response.url.includes('upload')
        || response.url.includes('attachment') || response.url.includes('/api/browser-native/')),
      browserRequestFailures,
      browserRequests: browserRequests.filter(request => request.url.includes('upload')
        || request.url.includes('attachment') || request.url.includes('/api/browser-native/')),
    })}\n`)
    throw error
  })
  assert.equal(uploaded.status(), 200)
  const uploadReceipt = await uploaded.json()
  assert.equal(uploadReceipt.attachmentId, `sha256:${hash}`)
  assert.equal(uploadReceipt.name, 'attachment-fixture.txt')
  assert.equal(uploadReceipt.bytes, content.byteLength)
  assert.equal(attachmentUploadChunks.reduce((total, chunk) => total + chunk, 0), content.byteLength)
  if (content.byteLength > 1024 * 1024) {
    assert.ok(attachmentUploadChunks.length > 1, 'large attachments must reach the backend as multiple streamed chunks')
  }
  assert.ok(Math.max(...attachmentUploadChunks) <= 1024 * 1024, 'attachment upload chunks must remain bounded')
  await page.getByText('attachment-fixture.txt', { exact: false }).last().waitFor({ timeout: 20_000 })

  const prompt = mode === 'scripted'
    ? `${marker}: read ${attachmentPath} with the standard read tool and report its content.`
    : `Call the available read tool exactly once with file_path ${attachmentPath}. Then state the exact returned contents. Do not claim the tool is unavailable and do not guess.`
  const first = await sendTurn({
    page,
    origin,
    requests: backendRequests,
    prompt,
    ...(mode === 'scripted' ? { marker: 'BROWSER_NATIVE_ATTACHMENT_READ_DONE' } : {}),
    timeout: mode === 'real' ? 600_000 : 90_000,
  })
  const userMessage = first.session.events.find(event => event.type === 'user/message'
    && event.data.content?.some(block => block.type === 'file' && block.attachment.attachmentId === `sha256:${hash}`))
  assert.ok(userMessage, 'the Session must contain the authoritative FileBlock')
  const firstRead = first.session.events.find(event => event.type === 'tool/call'
    && event.data.turn === first.turn && event.data.name === 'read')
  assert.ok(firstRead, `the DSH Agent must call the standard read tool; ${JSON.stringify({
    events: first.session.events.filter(event => event.data.turn === first.turn)
      .map(event => ({ type: event.type, tool: event.data.name, reason: event.data.reason?.kind })),
    assistant: assistantText(first.session, first.turn),
    offeredTools: backendRequests.filter(request => request.path.endsWith('/llm'))
      .flatMap(request => request.body?.tools ?? [])
      .map(tool => tool.function?.name ?? tool.name)
      .filter((name, index, names) => names.indexOf(name) === index),
  })}`)
  assert.equal(JSON.parse(firstRead.data.arguments).file_path, attachmentPath)
  const firstResult = first.session.events.find(event => event.type === 'tool/result'
    && event.data.turn === first.turn && event.data.message?.toolCallId === firstRead.data.callId)
  assert.ok(firstResult, 'the attachment read must settle with the matching call id')
  assert.notEqual(firstResult.data.message.isError, true, JSON.stringify(firstResult.data.message))
  assert.match(firstResult.data.message.content.map(block => block.text ?? '').join('\n'), /BROWSER_NATIVE_ATTACHMENT_CONTENT_V1/)
  if (mode === 'real') assert.match(assistantText(first.session, first.turn), /BROWSER_NATIVE_ATTACHMENT_CONTENT_V1/)

  await page.goto(`${origin}/api/browser-native/health`, { waitUntil: 'domcontentloaded' })
  const clearedDirectories = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const names = []
    for await (const [name] of root.entries()) {
      if (name === 'dsh-browser-native-attachments-v1') {
        await root.removeEntry(name, { recursive: true })
        names.push(name)
      }
    }
    return names
  })
  assert.deepEqual(clearedDirectories, ['dsh-browser-native-attachments-v1'])
  const downloadsBefore = backendRequests.filter(request => request.path.includes('/workspace/attachments/')
    && request.method === 'GET').length
  await openPreview(page, previewUrl)
  const restored = await waitFor(async () => {
    const downloads = backendRequests.filter(request => request.path.includes('/workspace/attachments/')
      && request.method === 'GET')
    return downloads.length > downloadsBefore ? downloads.length : undefined
  }, 'Session FileBlock attachment to rehydrate from the backend after OPFS eviction', 60_000)
  assert.ok(restored > downloadsBefore)
  const followupPrompt = mode === 'scripted'
    ? `${marker}: read ${attachmentPath} again after refresh.`
    : `After refreshing, call the available read tool exactly once with file_path ${attachmentPath}. Then state the exact returned contents. Do not claim the tool is unavailable and do not guess.`
  const second = await sendTurn({
    page,
    origin,
    requests: backendRequests,
    sessionId: first.sessionId,
    prompt: followupPrompt,
    ...(mode === 'scripted' ? { marker: 'BROWSER_NATIVE_ATTACHMENT_READ_DONE' } : {}),
    timeout: mode === 'real' ? 600_000 : 90_000,
  })
  assert.equal(second.sessionId, first.sessionId, 'refresh must resume the same DSH Session')
  const secondRead = second.session.events.find(event => event.type === 'tool/call'
    && event.data.turn === second.turn && event.data.name === 'read')
  assert.ok(secondRead, 'the resumed Agent must read the restored attachment through DSH')
  const secondResult = second.session.events.find(event => event.type === 'tool/result'
    && event.data.turn === second.turn && event.data.message?.toolCallId === secondRead.data.callId)
  assert.ok(secondResult)
  assert.notEqual(secondResult.data.message.isError, true, JSON.stringify(secondResult.data.message))
  assert.match(secondResult.data.message.content.map(block => block.text ?? '').join('\n'), /BROWSER_NATIVE_ATTACHMENT_CONTENT_V1/)

  assert.notEqual(first.turn, second.turn, 'refresh continuation must create a new DSH turn')
  for (const [turn, result, promptText] of [
    [first.turn, first, prompt],
    [second.turn, second, followupPrompt],
  ]) {
    assert.equal(result.session.events.filter(event => event.type === 'tool/call'
      && event.data.turn === turn && event.data.name === 'read').length, 1,
    `turn ${String(turn)} must execute exactly one attachment read`)
    assert.equal(result.session.events.filter(event => event.type === 'user/message'
      && event.data.content?.some(block => block.type === 'text' && block.text === promptText)).length, 1,
    `turn ${String(turn)} must persist its prompt once`)
  }

  const workspaceAfter = await page.evaluate(async workspaceId => {
    const response = await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`)
    return await response.json()
  }, workspaceBefore.identity.workspaceId)
  assert.equal(workspaceAfter.revision, workspaceBefore.manifest.revision,
    'Session attachment upload and restoration must not change Workspace revision')
  assert.deepEqual(workspaceAfter.entries, workspaceBefore.manifest.entries,
    'Session attachment bytes must remain outside the Workspace manifest')
  assert.deepEqual(pageErrors, [])
  const crossOriginRequests = browserRequests.filter(request => new URL(request.url).origin !== origin)
  assert.deepEqual(crossOriginRequests, [], 'the page and Worker must not call external services')

  const sessionFile = await readFile(join(dataDir, 'sessions', `${first.sessionId}.json`), 'utf8')
  assert.equal(sessionFile.includes(`sha256:${hash}`), true, 'the durable Session must retain the FileBlock reference')
  process.stdout.write(`${JSON.stringify({
    mode,
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    browserVersion: browser.version(),
    sessionId: first.sessionId,
    attachmentBytes: content.byteLength,
    attachmentSha256: hash,
    uploadChunkCount: attachmentUploadChunks.length,
    maxUploadChunkBytes: Math.max(...attachmentUploadChunks),
    fileBlockCount: first.session.events.filter(event => event.type === 'user/message'
      && event.data.content?.some(block => block.type === 'file')).length,
    readCallIds: [firstRead.data.callId, secondRead.data.callId],
    modelRequestCount: backendRequests.filter(request => request.path.endsWith('/llm')).length,
    backendAttachmentDownloadsAfterCacheClear: restored - downloadsBefore,
    workspaceRevision: workspaceAfter.revision,
    pageErrors,
  })}\n`)
} finally {
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
