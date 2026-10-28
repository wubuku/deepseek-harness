import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { sendTurn, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-first-claim-')))
const contexts = []
const pageErrors = []
const externalRequests = []
const llmRequests = []
const commits = []
const sessionRequests = []
let image
let app
let browser
let ownerPage

async function raceEndpoint(pages, origin, pathname, body) {
  let arrivals = 0
  let release
  const barrier = new Promise(resolveBarrier => { release = resolveBarrier })
  const routeUrl = `${origin}${pathname}`
  const handlers = pages.map(page => async route => {
    arrivals += 1
    if (arrivals === pages.length) release()
    await barrier
    await route.continue()
  })
  await Promise.all(pages.map((page, index) => page.route(routeUrl, handlers[index])))
  try {
    return await Promise.all(pages.map(page => page.evaluate(async ({ requestPath, requestBody }) => {
      const response = await fetch(requestPath, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
      })
      return { status: response.status, body: await response.json() }
    }, { requestPath: pathname, requestBody: body() })))
  } finally {
    await Promise.all(pages.map((page, index) => page.unroute(routeUrl, handlers[index])))
  }
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  await writeFile(join(image.distRoot, 'lifecycle-control.html'), '<!doctype html><meta charset="utf-8"><title>Lifecycle control</title>')
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: { workspaceWriterLeaseMs: 30_000 },
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  contexts.push(context)
  context.on('page', page => {
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin !== origin) externalRequests.push(request.url())
      if (url.pathname === '/api/browser-native/llm') llmRequests.push(request)
      if (url.pathname === '/api/browser-native/workspace/commit') commits.push(request)
      if (url.pathname.endsWith('/session/create')) {
        sessionRequests.push({ path: url.pathname, body: request.postDataJSON() })
      }
    })
  })

  ownerPage = await context.newPage()
  await ownerPage.goto(`${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`, { waitUntil: 'domcontentloaded' })
  await waitForPreview(ownerPage)
  await ownerPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
  const initial = await sendTurn({
    page: ownerPage,
    origin,
    requests: sessionRequests,
    prompt: 'BROWSER_NATIVE_FIRST_CLAIM_BASELINE',
    marker: 'BROWSER_NATIVE_FIRST_CLAIM_BASELINE',
    timeout: 60_000,
  })
  const workspaceId = await ownerPage.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  const workspaceLease = await ownerPage.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
  const sessionOwnerToken = await ownerPage.evaluate(id => sessionStorage.getItem(
    `dsh.browser-native.owner.${encodeURIComponent(id)}`,
  ), initial.sessionId)
  assert.equal(typeof workspaceId, 'string')
  assert.equal(typeof sessionOwnerToken, 'string')
  assert.equal(workspaceLease?.ok, true)
  const before = await ownerPage.evaluate(async ({ sessionId, workspaceId }) => {
    const sessionResponse = await fetch('/api/browser-native/session/read', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId, offset: 0 }),
    })
    const session = await sessionResponse.json()
    const manifestResponse = await fetch(`/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`)
    const manifest = await manifestResponse.json()
    return { nextSeq: session.nextSeq, revision: manifest.revision }
  }, { sessionId: initial.sessionId, workspaceId })
  const llmRequestsBeforeClaims = llmRequests.length
  const commitsBeforeClaims = commits.length

  const controlPages = await Promise.all([context.newPage(), context.newPage()])
  await Promise.all(controlPages.map(async page => {
    await page.goto(`${origin}/lifecycle-control.html`, { waitUntil: 'domcontentloaded' })
    assert.equal(await page.evaluate(() => sessionStorage.length), 0, 'claim contenders must start without recovery credentials')
  }))

  await ownerPage.evaluate(async ({ sessionId, ownerToken }) => {
    const response = await fetch('/api/browser-native/session/close', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId, ownerToken }),
    })
    if (!response.ok && response.status !== 409) throw new Error(`Session release failed with ${response.status}`)
  }, { sessionId: initial.sessionId, ownerToken: sessionOwnerToken })
  const workspaceRelease = await ownerPage.evaluate(async ({ workspaceId, writerToken, fencingToken }) => {
    const response = await fetch('/api/browser-native/workspace/lease', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), workspaceId, operation: 'release', writerToken, fencingToken }),
    })
    return { status: response.status }
  }, { workspaceId, writerToken: workspaceLease.writerToken, fencingToken: workspaceLease.fencingToken })
  assert.equal(workspaceRelease.status, 200)

  const sessionClaims = await raceEndpoint(
    controlPages,
    origin,
    '/api/browser-native/session/open',
    () => ({ protocolVersion: 1, requestId: randomUUID(), sessionId: initial.sessionId, access: 'write' }),
  )
  assert.deepEqual(sessionClaims.map(result => result.status).sort(), [200, 409])
  const sessionWinnerIndex = sessionClaims.findIndex(result => result.status === 200)
  const sessionWinner = sessionClaims[sessionWinnerIndex].body.owner
  assert.equal(typeof sessionWinner?.ownerToken, 'string')
  const sessionAfter = await controlPages[sessionWinnerIndex].evaluate(async sessionId => {
    const response = await fetch('/api/browser-native/session/read', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId, offset: 0 }),
    })
    return await response.json()
  }, initial.sessionId)
  assert.equal(sessionAfter.nextSeq, before.nextSeq, 'claiming a writer must not append Session events')
  await controlPages[sessionWinnerIndex].evaluate(async ({ sessionId, ownerToken }) => {
    const response = await fetch('/api/browser-native/session/close', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId, ownerToken }),
    })
    if (!response.ok) throw new Error(`Winning Session claim release failed with ${response.status}`)
  }, { sessionId: initial.sessionId, ownerToken: sessionWinner.ownerToken })

  const workspaceClaims = await raceEndpoint(
    controlPages,
    origin,
    '/api/browser-native/workspace/lease',
    () => ({ protocolVersion: 1, requestId: randomUUID(), workspaceId, operation: 'claim' }),
  )
  assert.deepEqual(workspaceClaims.map(result => result.status).sort(), [200, 409])
  const workspaceWinnerIndex = workspaceClaims.findIndex(result => result.status === 200)
  const workspaceWinner = workspaceClaims[workspaceWinnerIndex].body
  const manifestAfter = await controlPages[workspaceWinnerIndex].evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  assert.equal(manifestAfter.revision, before.revision, 'claiming a writer must not commit Workspace changes')
  const finalSession = await controlPages[workspaceWinnerIndex].evaluate(async sessionId => await (await fetch('/api/browser-native/session/read', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId, offset: 0 }),
  })).json(), initial.sessionId)
  assert.equal(finalSession.nextSeq, before.nextSeq)
  assert.equal(llmRequests.length, llmRequestsBeforeClaims, 'claim requests must not start another model run')
  assert.equal(commits.length, commitsBeforeClaims, 'claim requests must not commit Workspace mutations')
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])

  await controlPages[workspaceWinnerIndex].evaluate(async ({ workspaceId, writerToken, fencingToken }) => {
    await fetch('/api/browser-native/workspace/lease', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), workspaceId, operation: 'release', writerToken, fencingToken }),
    })
  }, { workspaceId, writerToken: workspaceWinner.writerToken, fencingToken: workspaceWinner.fencingToken })
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'real-chrome-first-claim-race-through-same-origin-Session-and-Workspace-APIs',
    claimContenders: controlPages.length,
    sessionClaimStatuses: sessionClaims.map(result => result.status),
    workspaceClaimStatuses: workspaceClaims.map(result => result.status),
    sessionWinnerPage: sessionWinnerIndex,
    workspaceWinnerPage: workspaceWinnerIndex,
    sessionSeqUnchanged: finalSession.nextSeq === before.nextSeq,
    workspaceRevisionUnchanged: manifestAfter.revision === before.revision,
    modelRequestsAfterBaseline: llmRequests.length - llmRequestsBeforeClaims,
    workspaceCommitsDuringClaim: commits.length - commitsBeforeClaims,
  })}\n`)
} finally {
  for (const context of contexts) await context.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
