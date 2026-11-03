import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-quota-tool-`))
const previewUrl = origin => `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`
const requests = []
const commits = []
const pageErrors = []
const externalRequests = []
let image
let app
let browser
let context
let page
let sessionId
let origin

async function workspaceTest(target, request) {
  return await target.evaluate(async value => {
    const test = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof test !== 'function') throw new Error('Browser-Native test port is unavailable')
    return await test(value)
  }, request)
}

function toolResult(session, callId) {
  return session.events.find(event => event.type === 'tool/result'
    && String(event.data.message.toolCallId) === callId)
}

function statusOf(target) {
  return target.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    requests.push({ path: url.pathname, body })
  })
  await page.route(`${origin}/api/browser-native/workspace/commit`, async route => {
    commits.push(route.request().postDataJSON())
    await route.continue()
  })
  await openPreview(page, previewUrl(origin))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const workspaceId = (await statusOf(page)).workspaceId
  assert.equal(typeof workspaceId, 'string')

  const armed = await workspaceTest(page, { action: 'quota-next-opfs-write' })
  assert.equal(armed?.ok, true, JSON.stringify(armed))

  const first = await sendTurn({
    page,
    origin,
    requests,
    prompt: 'BROWSER_NATIVE_QUOTA_TOOL_E2E：把 quota-tool.txt 写入工作区。',
    timeout: 90_000,
  })
  sessionId = first.sessionId
  const firstResult = toolResult(first.session, 'browser-native-quota-write')
  assert.ok(firstResult, 'the failed write must appear as a tool result')
  assert.equal(firstResult.data.message.isError, true, JSON.stringify(firstResult))
  assert.match(JSON.stringify(firstResult.data.message ?? firstResult.data.error),
    /quota/i, 'the tool result must expose the injected quota failure')
  assert.equal(first.session.events.filter(event => event.type === 'tool/call'
    && String(event.data.callId) === 'browser-native-quota-write').length, 1,
  'the failed write must not be replayed inside its turn')
  const stateAfterFirstTurn = await statusOf(page)

  await waitFor(async () => (await statusOf(page)).state === 'synced', 'the store auto-retry to commit', 45_000)
  const revisionAfterAutoRetry = app.workspaces.workspaces.get(workspaceId)?.revision
  assert.equal(commits.length, 1, 'the store must auto-retry the failed write exactly once')
  assert.equal(revisionAfterAutoRetry, 1, 'the auto-retry must commit the first attempt content')
  const contentAfterAutoRetry = await workspaceTest(page, { action: 'read', path: '/dsh/home/workspace/quota-tool.txt' })
  assert.equal(contentAfterAutoRetry?.ok, true, JSON.stringify(contentAfterAutoRetry))
  assert.equal(contentAfterAutoRetry.content, 'quota-tool-first-attempt\n')
  const removals = first.session.events
    .filter(event => event.type === 'developer/message')
    .flatMap(event => event.data.message.content)
    .filter(block => block.type === 'tool-removal')
    .map(block => block.toolName)
  assert.ok(removals.includes('write'),
    `an unconfirmed save must withdraw workspace tools: ${JSON.stringify(removals)}`)

  const second = await sendTurn({
    page,
    origin,
    requests,
    sessionId,
    prompt: 'BROWSER_NATIVE_QUOTA_RETRY_E2E：再次把 quota-tool.txt 写入工作区。',
    timeout: 90_000,
  })
  assert.equal(second.session.events.filter(event => event.type === 'tool/call'
    && String(event.data.callId) === 'browser-native-quota-retry-write').length, 0,
  'workspace tools must stay withdrawn for the rest of the Worker lifetime')
  assert.equal(app.workspaces.workspaces.get(workspaceId)?.revision, 1)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 45_000 })
  const revisionAfterReload = app.workspaces.workspaces.get(workspaceId)?.revision
  assert.equal(revisionAfterReload, 1, 'reload must hydrate the committed revision')
  assert.equal((await statusOf(page)).workspaceId, workspaceId, 'reload must hydrate the same Workspace identity')
  const contentAfterReload = await workspaceTest(page, { action: 'read', path: '/dsh/home/workspace/quota-tool.txt' })
  assert.equal(contentAfterReload.content, 'quota-tool-first-attempt\n')

  const third = await sendTurn({
    page,
    origin,
    requests,
    sessionId,
    prompt: 'BROWSER_NATIVE_QUOTA_RELOAD_RETRY_E2E：再次把 quota-tool.txt 写入工作区。',
    timeout: 90_000,
  })
  const retryCall = third.session.events.find(event => event.type === 'tool/call'
    && String(event.data.callId) === 'browser-native-quota-reload-retry-write')
  assert.ok(retryCall, 'reload must republish workspace tools')
  const retryResult = toolResult(third.session, 'browser-native-quota-reload-retry-write')
  assert.ok(retryResult)
  assert.equal(retryResult.data.message.isError, false, JSON.stringify(retryResult))
  await waitFor(async () => (await statusOf(page)).state === 'synced', 'the retry write to commit', 45_000)
  const revisionAfterRetry = app.workspaces.workspaces.get(workspaceId)?.revision
  assert.equal(revisionAfterRetry, 2, 'the retry write must commit on top of the recovered revision')
  const contentAfterRetry = await workspaceTest(page, { action: 'read', path: '/dsh/home/workspace/quota-tool-retry.txt' })
  assert.equal(contentAfterRetry.content, 'quota-tool-retry-succeeded\n')
  const firstFileAfterRetry = await workspaceTest(page, { action: 'read', path: '/dsh/home/workspace/quota-tool.txt' })
  assert.equal(firstFileAfterRetry.content, 'quota-tool-first-attempt\n',
    'the recovered revision must keep the first file intact')
  assert.equal(commits.length, 2, 'exactly one auto-retry and one explicit retry must commit')
  assert.equal(requests.filter(request => request.path.endsWith('/llm')).length > 0, true)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'OPFS-quota-failure-during-write-tool',
    sessionId,
    workspaceId,
    armed,
    observableFailure: {
      isError: firstResult.data.message.isError,
      message: firstResult.data.message.content.map(block => block.text).join(''),
      stateAfterFirstTurn: stateAfterFirstTurn.state,
      withdrawnTools: removals,
    },
    noSilentLoss: {
      commitsAfterAutoRetry: 1,
      revisionAfterAutoRetry,
      contentAfterAutoRetry: contentAfterAutoRetry.content,
      firstTurnToolCalls: 1,
    },
    failClosed: {
      secondTurnWriteCalls: 0,
      revisionAfterSecondTurn: 1,
    },
    recovery: {
      recoveryRequiresReload: true,
      revisionAfterReload,
      sameWorkspaceId: true,
      reloadContent: contentAfterReload.content,
      retryIsError: retryResult.data.message.isError,
      finalRevision: revisionAfterRetry,
      finalContent: contentAfterRetry.content,
      totalCommitRequests: commits.length,
    },
    note: 'An injected OPFS quota error surfaces as a failed write tool result with a quota diagnostic; the store then auto-retries and commits the first content exactly once, so nothing is lost silently. Because the save was reported unconfirmed, the Worker withdraws every workspace tool for the rest of its lifetime (fail-closed), so a second turn cannot write until the page is reloaded. Reload hydrates the committed revision and republishes the tools; the retry then commits the new content as revision 2.',
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    sessionId,
    pageErrors,
    externalRequests,
    session: sessionId !== undefined && origin !== undefined
      ? await sessionRequest(origin, 'read', { sessionId, offset: 0 }).catch(() => undefined)
      : undefined,
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
