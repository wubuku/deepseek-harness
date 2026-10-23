import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-worker-handoff-')))
const leaseDurationMs = 10_000
let image
let app
let browser
let context
let firstPage
let secondPage
const pageErrors = []
const externalRequests = []
const modelRequests = []
const commits = []
const firstRequests = []
const secondRequests = []

async function staleLeaseRequest(page, input) {
  return await page.evaluate(async value => {
    const response = await fetch('/api/browser-native/workspace/lease', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        workspaceId: value.workspaceId,
        operation: 'renew',
        writerToken: value.writerToken,
        fencingToken: value.fencingToken,
      }),
    })
    return { status: response.status, body: await response.json() }
  }, input)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: { workspaceWriterLeaseMs: leaseDurationMs },
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  firstPage = await context.newPage()
  secondPage = await context.newPage()
  for (const page of [firstPage, secondPage]) {
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('request', request => {
      if (new URL(request.url()).origin !== origin) externalRequests.push(request.url())
      if (!request.url().includes('/api/browser-native/')) return
      let body = {}
      try { body = request.postDataJSON() ?? {} } catch {}
      const record = { path: new URL(request.url()).pathname, body }
      ;(page === firstPage ? firstRequests : secondRequests).push(record)
      if (record.path === '/api/browser-native/llm') modelRequests.push({ page, body })
      if (record.path === '/api/browser-native/workspace/commit') commits.push(body)
    })
  }
  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await openPreview(firstPage, previewUrl)
  await firstPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const firstLease = await firstPage.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
  assert.equal(firstLease?.ok, true, JSON.stringify(firstLease))
  assert.equal(firstLease.fencingToken, 1)
  const workspaceId = await firstPage.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)

  const firstTurn = await sendTurn({
    page: firstPage,
    origin,
    requests: firstRequests,
    prompt: 'BROWSER_NATIVE_WRITER_HANDOFF_FIRST_E2E: create the first worker file.',
    marker: 'BROWSER_NATIVE_WRITER_HANDOFF_FIRST_DONE',
    timeout: 60_000,
  })
  const firstCall = firstTurn.session.events.find(event => event.type === 'tool/call'
    && event.data.name === 'write' && event.data.turn === firstTurn.turn)
  assert.ok(firstCall)
  const firstResult = firstTurn.session.events.find(event => event.type === 'tool/result'
    && event.data.message?.toolCallId === firstCall.data.callId)
  assert.ok(firstResult, 'first Worker DSH write must have a tool result')
  assert.equal(firstResult.data.message.isError, false, JSON.stringify(firstResult.data))
  try {
    await firstPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
      && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 1, undefined, { timeout: 30_000 })
  } catch (error) {
    const diagnostic = {
      status: await firstPage.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__),
      commits,
      manifest: await firstPage.evaluate(async id => await (await fetch(
        `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
      )).json(), workspaceId),
      toolResult: firstResult.data,
      pageErrors,
    }
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`)
    throw error
  }

  await secondPage.goto(previewUrl, { waitUntil: 'domcontentloaded' })
  await secondPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'lease-conflict', undefined, { timeout: 30_000 })
  assert.equal(modelRequests.filter(request => request.page === secondPage).length, 0,
    'the page without the lease must not start an Agent turn or model request')
  assert.equal(commits.length, 1)
  const retry = secondPage.locator('[data-browser-native-workspace-retry]')
  assert.equal(await retry.isVisible(), true)
  await firstPage.close()
  await waitFor(async () => await retry.isEnabled(), 'lease expiry after closing the first Worker page', 20_000)
  await retry.click()
  await waitForPreview(secondPage)
  await secondPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const secondLease = await secondPage.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
  assert.equal(secondLease?.ok, true, JSON.stringify(secondLease))
  assert.ok(secondLease.fencingToken > firstLease.fencingToken)

  let secondTurn
  try {
    secondTurn = await sendTurn({
      page: secondPage,
      origin,
      requests: secondRequests,
      sessionId: firstTurn.sessionId,
      prompt: 'BROWSER_NATIVE_WRITER_HANDOFF_SECOND_E2E: create the second worker file.',
      marker: 'BROWSER_NATIVE_WRITER_HANDOFF_SECOND_DONE',
      timeout: 60_000,
    })
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      secondRequests: secondRequests.map(request => ({ path: request.path, status: request.status })),
      status: await secondPage.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__),
      pageErrors,
      bodyText: (await secondPage.locator('body').innerText().catch(() => '')).slice(-2500),
      error: error instanceof Error ? error.message : String(error),
    })}\n`)
    throw error
  }
  assert.equal(secondTurn.sessionId, firstTurn.sessionId, 'the handoff must continue the original DSH Session')
  await secondPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision === 2, undefined, { timeout: 30_000 })
  const secondCall = secondTurn.session.events.find(event => event.type === 'tool/call'
    && event.data.name === 'write' && event.data.turn === secondTurn.turn)
  assert.ok(secondCall)
  assert.equal(secondTurn.session.events.some(event => event.type === 'tool/result'
    && event.data.message?.toolCallId === secondCall.data.callId
    && event.data.message.isError === false), true)

  const staleRenew = await staleLeaseRequest(secondPage, {
    workspaceId,
    writerToken: firstLease.writerToken,
    fencingToken: firstLease.fencingToken,
  })
  assert.equal(staleRenew.status, 409, JSON.stringify(staleRenew))
  assert.equal(staleRenew.body.error.code, 'WORKSPACE_OWNERSHIP_LOST')
  const staleCommit = await secondPage.evaluate(async input => {
    const response = await fetch('/api/browser-native/workspace/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        baseRevision: 2,
        operationId: crypto.randomUUID(),
        changes: [{ path: 'stale-writer.txt', deleted: true }],
        writerToken: input.writerToken,
        fencingToken: input.fencingToken,
      }),
    })
    return { status: response.status, body: await response.json() }
  }, { workspaceId, writerToken: firstLease.writerToken, fencingToken: firstLease.fencingToken })
  assert.equal(staleCommit.status, 409, JSON.stringify(staleCommit))
  assert.equal(staleCommit.body.error.code, 'WORKSPACE_OWNERSHIP_LOST')
  const manifest = await secondPage.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(manifest.revision, 2)
  assert.deepEqual(manifest.entries.filter(entry => entry.kind === 'file').map(entry => entry.path).sort(), [
    'writer-first.txt', 'writer-second.txt',
  ])
  assert.equal(commits.length, 3, 'two Workspace commits and one deliberately rejected stale-token commit must be observed')
  assert.equal(commits.filter(commit => commit.changes?.some(change => change.path === 'stale-writer.txt')).length, 1)
  assert.equal(modelRequests.filter(request => request.page === secondPage).length, 2,
    'the second Worker must begin its first model turn only after acquiring the lease')
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'closed-worker-lease-expiry-new-worker-fencing-and-real-DSH-file-tools',
    workspaceId,
    leaseDurationMs,
    firstFencingToken: firstLease.fencingToken,
    secondFencingToken: secondLease.fencingToken,
    firstSessionId: firstTurn.sessionId,
    secondSessionId: secondTurn.sessionId,
    workspaceRevision: manifest.revision,
    commits: commits.length,
    staleRenewStatus: staleRenew.status,
    staleCommitStatus: staleCommit.status,
    pageErrors,
    externalRequests,
  })}\n`)
} finally {
  await secondPage?.close().catch(() => {})
  await firstPage?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
