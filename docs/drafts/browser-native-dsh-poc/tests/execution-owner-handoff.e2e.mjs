import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, sessionRequest, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const mode = process.env.DSH_POC_LLM_MODE ?? 'scripted'
const envFile = process.env.DSH_POC_ENV_FILE
if (mode !== 'scripted' && mode !== 'real') throw new Error('DSH_POC_LLM_MODE must be scripted or real')
if (mode === 'real' && envFile === undefined) throw new Error('DSH_POC_ENV_FILE is required for real LLM mode')

const requestedDataDir = process.env.DSH_POC_DATA_DIR === undefined ? undefined : resolve(process.env.DSH_POC_DATA_DIR)
const realTimeout = Number(process.env.DSH_POC_TURN_TIMEOUT_MS ?? '240000')
const defaultScenarios = ['normal', 'session-response-lost', 'workspace-release-response-lost']
const selectedScenario = process.env.DSH_POC_HANDOFF_SCENARIO
const scenarios = mode === 'real'
  ? ['normal']
  : selectedScenario === undefined ? defaultScenarios : [selectedScenario]
if (scenarios.some(scenario => !defaultScenarios.includes(scenario))) {
  throw new Error(`DSH_POC_HANDOFF_SCENARIO must be one of ${defaultScenarios.join(', ')}`)
}
let activeScenario = ''
let backendNow = Date.now()
let dropHandoff = true
let dropWorkspaceRelease = true
let image
let app
let browser
let dataDir
const handoffBodies = []
const ownedDataDirs = []

function requestBody(request) {
  try { return request.postDataJSON() ?? {} } catch { return {} }
}

function turnToolCalls(session, turn) {
  return session.events.filter(event => event.type === 'tool/call' && event.data.turn === turn)
}

function resultForCall(session, call) {
  return session.events.find(event => event.type === 'tool/result'
    && event.data.turn === call.data.turn
    && event.data.step === call.data.step
    && (event.data.message?.toolCallId === call.data.callId
      || event.data.message?.source?.callId === call.data.callId))
}

function resultText(result) {
  return result?.data.message?.content?.map(block => block.text ?? '').join('') ?? ''
}

function leaseSummary(lease) {
  return lease === undefined ? null : {
    ok: lease.ok,
    fencingToken: lease.fencingToken,
    state: lease.state,
    renewalScheduled: lease.renewalScheduled,
    renewalPending: lease.renewalPending,
  }
}

function handoffSummary(handoff) {
  const value = handoff?.executionHandoff
  return value === undefined ? null : {
    state: value.state,
    error: value.error,
    checkpoint: value.checkpoint,
    nextOwner: value.nextOwner === undefined ? undefined : {
      ownerEpoch: value.nextOwner.ownerEpoch,
      tokenPresent: typeof value.nextOwner.ownerToken === 'string',
    },
  }
}

async function workspaceManifest(page, workspaceId) {
  return await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
}

async function runScenario(name) {
  activeScenario = name
  backendNow = Date.now()
  dropHandoff = true
  dropWorkspaceRelease = true
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const firstPage = await context.newPage()
  const secondPage = await context.newPage()
  const pageErrors = []
  const externalRequests = []
  const requests = []
  const llmRequests = []
  const cookieScopes = []
  const commits = []
  const requestRecords = new WeakMap()
  const url = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`

  for (const page of [firstPage, secondPage]) {
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('request', request => {
      const requestUrl = new URL(request.url())
      if (requestUrl.origin !== origin) externalRequests.push(request.url())
      if (!requestUrl.pathname.startsWith('/api/browser-native/')) return
      const body = requestBody(request)
      const record = { page, path: requestUrl.pathname, body, status: undefined }
      requestRecords.set(request, record)
      requests.push(record)
      if (record.path === '/api/browser-native/llm') llmRequests.push(record)
      if (record.path === '/api/browser-native/llm' || record.path === '/api/browser-native/session/handoff') {
        cookieScopes.push(request.allHeaders().then(headers => ({
          path: record.path,
          hasWorkspaceIdentity: (headers.cookie ?? '').includes('dsh-browser-native-principal='),
          hasHandoffIdentity: (headers.cookie ?? '').includes('dsh-browser-native-handoff-principal='),
        })))
      }
      if (record.path === '/api/browser-native/workspace/commit') {
        commits.push({
          workspaceId: body.workspaceId,
          operationId: body.operationId,
          paths: Array.isArray(body.changes) ? body.changes.map(change => change.path) : [],
          status: undefined,
        })
      }
    })
    page.on('response', response => {
      const record = requestRecords.get(response.request())
      if (record !== undefined) record.status = response.status()
      const commit = record?.path === '/api/browser-native/workspace/commit'
        ? commits.findLast(item => item.operationId === record.body.operationId)
        : undefined
      if (commit !== undefined) commit.status = response.status()
    })
  }

  try {
    await openPreview(firstPage, url)
    await firstPage.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
    const firstPrompt = mode === 'scripted'
      ? 'BROWSER_NATIVE_WRITER_HANDOFF_FIRST_E2E: create the first worker file.'
      : `Use exactly this tool sequence and no other tool calls: (1) call the DSH write tool once with file_path ${JSON.stringify('/dsh/home/workspace/writer-first.txt')} and content ${JSON.stringify('first-worker-write-ok')}; (2) call the DSH read tool once with file_path ${JSON.stringify('/dsh/home/workspace/writer-first.txt')}. Confirm that the read result contains the exact content. After both calls succeed, reply exactly REAL_OWNER_HANDOFF_FIRST_DONE.`
    const firstMarker = mode === 'scripted' ? 'BROWSER_NATIVE_WRITER_HANDOFF_FIRST_DONE' : 'REAL_OWNER_HANDOFF_FIRST_DONE'
    let firstTurn
    try {
      firstTurn = await sendTurn({
        page: firstPage,
        origin,
        requests,
        prompt: firstPrompt,
        marker: firstMarker,
        timeout: realTimeout,
      })
    } catch (error) {
      const createdSessionId = requests.find(request => request.path.endsWith('/session/create'))?.body.sessionId
      const createdSession = typeof createdSessionId === 'string'
        ? await sessionRequest(origin, 'read', { sessionId: createdSessionId, offset: 0 }).catch(() => null)
        : null
      process.stderr.write(`${JSON.stringify({
        scenario: name,
        status: await firstPage.evaluate(() => {
          const status = window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__
          return status === undefined ? null : {
            state: status.state,
            workspaceId: status.workspaceId,
            revision: status.revision,
            error: status.error,
          }
        }),
        composer: await firstPage.locator('[data-composer-input][contenteditable="true"]').last().evaluate(node => ({
          textLength: node.textContent?.length ?? 0,
          disabled: node.getAttribute('aria-disabled'),
        })),
        session: createdSession === null ? null : {
          id: createdSessionId,
          events: createdSession.events.map(event => ({ type: event.type, turn: event.data?.turn })),
          promptAppended: createdSession.events.some(event => event.type === 'user/message'
            && event.data?.message?.content?.some(block => block.type === 'text' && block.text === firstPrompt)),
        },
        pageErrors,
        apiRequests: requests.map(({ path, status }) => ({ path, status })),
        error: String(error),
      })}\n`)
      throw error
    }
    try {
      await firstPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
        && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision >= 1, undefined, { timeout: 30_000 })
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        scenario: name,
        status: await firstPage.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__ ?? null),
        lease: await firstPage.evaluate(async () => {
          return leaseSummary(await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
        }),
        turn: firstTurn.turn,
        events: firstTurn.session.events.filter(event => ['tool/call', 'tool/result', 'turn/end'].includes(event.type)),
        commits: commits.map(commit => ({ ...commit })),
        pageErrors,
      })}\n`)
      throw error
    }

    const initialSession = await sessionRequest(origin, 'read', { sessionId: firstTurn.sessionId, offset: 0 })
    const initialOwnerToken = await firstPage.evaluate(id => sessionStorage.getItem(
      `dsh.browser-native.owner.${encodeURIComponent(id)}`,
    ), firstTurn.sessionId)
    assert.equal(typeof initialOwnerToken, 'string')
    const firstLease = await firstPage.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
    assert.equal(firstLease?.ok, true, JSON.stringify(leaseSummary(firstLease)))
    const workspaceId = await firstPage.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
    assert.equal(typeof workspaceId, 'string')

    await secondPage.goto(url, { waitUntil: 'domcontentloaded' })
    await secondPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'lease-conflict', undefined, { timeout: 30_000 })
    assert.equal(llmRequests.filter(request => request.page === secondPage).length, 0,
      'the receiving Worker must not call the model before it owns the Workspace')

    const priorLlmCount = llmRequests.length
    const handoffId = `execution-handoff-${name}`
    const handoffBodiesBefore = handoffBodies.length
    const handoff = await firstPage.evaluate(async input => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
      action: 'execution-handoff',
      ...input,
      terminateAfter: true,
    }), {
      sessionId: firstTurn.sessionId,
      ownerId: 'chrome-worker-a',
      ownerToken: initialOwnerToken,
      ownerEpoch: initialSession.ownerEpoch,
      handoffId,
    })
    const handoffRequest = handoffBodies.at(handoffBodiesBefore)
    assert.equal(handoffRequest?.checkpoint?.epoch, initialSession.ownerEpoch, JSON.stringify(
      {
        checkpoints: handoffBodies.map(({ checkpoint }) => checkpoint === undefined ? null : {
          epoch: checkpoint.epoch,
          ownerEpoch: checkpoint.ownerEpoch,
          keys: Object.keys(checkpoint),
        }),
        handoff: handoffSummary(handoff),
      },
    ))
    assert.equal(Object.hasOwn(handoffRequest?.checkpoint ?? {}, 'ownerEpoch'), false)
    assert.equal(llmRequests.length, priorLlmCount, 'handoff must not issue another model request')
    const expectedState = name === 'session-response-lost' ? 'session-unknown'
      : name === 'workspace-release-response-lost' ? 'workspace-release-unknown'
        : 'complete'
    assert.equal(handoff?.executionHandoff?.state, expectedState, JSON.stringify(handoffSummary(handoff)))

    const afterHandoff = await sessionRequest(origin, 'read', { sessionId: firstTurn.sessionId, offset: 0 })
    assert.equal(afterHandoff.ownerEpoch, initialSession.ownerEpoch + 1)
    if (handoff.executionHandoff.nextOwner !== undefined) {
      assert.equal(handoff.executionHandoff.nextOwner.ownerEpoch, afterHandoff.ownerEpoch)
      await secondPage.evaluate(({ sessionId, ownerToken }) => {
        sessionStorage.setItem(`dsh.browser-native.owner.${encodeURIComponent(sessionId)}`, ownerToken)
      }, { sessionId: firstTurn.sessionId, ownerToken: handoff.executionHandoff.nextOwner.ownerToken })
    } else {
      assert.equal(name, 'session-response-lost')
      const earlyClaim = await sessionRequest(origin, 'open', { sessionId: firstTurn.sessionId, access: 'write' })
      assert.equal(earlyClaim.status, 409)
      assert.equal(earlyClaim.error?.code, 'SESSION_ALREADY_OWNED')
    }

    await firstPage.close()
    if (name === 'session-response-lost') backendNow += 30_001
    await secondPage.reload({ waitUntil: 'domcontentloaded' })
    await (await import('./runtime-test-support.mjs')).waitForPreview(secondPage)
    await secondPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 30_000 })
    const secondLease = await secondPage.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'lease-info' }))
    assert.equal(secondLease?.ok, true, JSON.stringify(leaseSummary(secondLease)))
    assert.ok(secondLease.fencingToken > firstLease.fencingToken)
    assert.equal(llmRequests.filter(request => request.page === secondPage).length, 0,
      'opening the recovered Session must not itself send a model request')

    const secondPrompt = mode === 'scripted'
      ? 'BROWSER_NATIVE_WRITER_HANDOFF_SECOND_E2E: create the second worker file.'
      : `Use exactly this tool sequence and no other tool calls: (1) call the DSH read tool once with file_path ${JSON.stringify('/dsh/home/workspace/writer-first.txt')} and verify the result contains ${JSON.stringify('first-worker-write-ok')}; (2) call the DSH write tool once with file_path ${JSON.stringify('/dsh/home/workspace/writer-second.txt')} and content ${JSON.stringify('second-worker-write-ok')}; (3) call the DSH read tool once with file_path ${JSON.stringify('/dsh/home/workspace/writer-second.txt')} and verify the result contains ${JSON.stringify('second-worker-write-ok')}. After all three calls succeed, reply exactly REAL_OWNER_HANDOFF_SECOND_DONE.`
    const secondMarker = mode === 'scripted' ? 'BROWSER_NATIVE_WRITER_HANDOFF_SECOND_DONE' : 'REAL_OWNER_HANDOFF_SECOND_DONE'
    const secondTurn = await sendTurn({
      page: secondPage,
      origin,
      requests,
      sessionId: firstTurn.sessionId,
      prompt: secondPrompt,
      marker: secondMarker,
      timeout: realTimeout,
    })
    assert.equal(secondTurn.sessionId, firstTurn.sessionId, 'the receiving Worker must continue the original Session')
    await secondPage.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
      && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.revision >= 2, undefined, { timeout: 30_000 })

    const finalSession = await sessionRequest(origin, 'read', { sessionId: firstTurn.sessionId, offset: 0 })
    const calls = [
      ...turnToolCalls(finalSession, firstTurn.turn),
      ...turnToolCalls(finalSession, secondTurn.turn),
    ]
    assert.equal(calls.filter(call => call.data.name === 'write').length, 2,
      'the two turns must each produce one DSH write call')
    for (const call of calls) {
      const result = resultForCall(finalSession, call)
      assert.ok(result, `missing result for tool call ${call.data.callId}`)
      assert.notEqual(result.data.message?.isError, true, `${call.data.name} failed: ${resultText(result)}`)
    }
    if (mode === 'real') {
      const firstCalls = calls.filter(call => call.data.turn === firstTurn.turn)
      const secondCalls = calls.filter(call => call.data.turn === secondTurn.turn)
      assert.deepEqual(firstCalls.map(call => call.data.name), ['write', 'read'])
      assert.deepEqual(secondCalls.map(call => call.data.name), ['read', 'write', 'read'])
      assert.ok(resultText(resultForCall(finalSession, firstCalls[1])).includes('first-worker-write-ok'))
      assert.ok(resultText(resultForCall(finalSession, secondCalls[0])).includes('first-worker-write-ok'))
      assert.ok(resultText(resultForCall(finalSession, secondCalls[2])).includes('second-worker-write-ok'))
      for (const call of calls.filter(call => call.data.name === 'write')) {
        const args = JSON.parse(call.data.arguments)
        assert.equal(args.content.trim(), call.data.turn === firstTurn.turn ? 'first-worker-write-ok' : 'second-worker-write-ok')
      }
    }
    const receipts = finalSession.events.filter(event => event.type === 'browser-native/workspace-receipt')
    assert.equal(receipts.length, 2)
    assert.equal(new Set(receipts.map(receipt => receipt.data.operationId)).size, receipts.length)

    const manifest = await workspaceManifest(secondPage, workspaceId)
    assert.equal(manifest.revision, 2)
    assert.deepEqual(manifest.entries.filter(entry => entry.kind === 'file').map(entry => entry.path).sort(), [
      'writer-first.txt', 'writer-second.txt',
    ])
    assert.equal(commits.filter(commit => commit.workspaceId === workspaceId && commit.status === 200).length, 2,
      'each successful tool side effect must commit exactly once')
    assert.equal(new Set(commits.filter(commit => commit.workspaceId === workspaceId && commit.status === 200)
      .map(commit => commit.operationId)).size, 2)

    const staleRenew = await secondPage.evaluate(async input => {
      const response = await fetch('/api/browser-native/workspace/lease', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          requestId: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          operation: 'renew',
          writerToken: input.writerToken,
          fencingToken: input.fencingToken,
        }),
      })
      return { status: response.status, body: await response.json() }
    }, { workspaceId, writerToken: firstLease.writerToken, fencingToken: firstLease.fencingToken })
    assert.equal(staleRenew.status, 409)
    assert.equal(staleRenew.body.error.code, 'WORKSPACE_OWNERSHIP_LOST')

    const staleAppend = await fetch(`${origin}/api/browser-native/session/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: `stale-session-${name}`,
        sessionId: firstTurn.sessionId,
        ownerToken: initialOwnerToken,
        ownerEpoch: initialSession.ownerEpoch,
        expectedNextSeq: finalSession.nextSeq,
        events: [{
          seq: finalSession.nextSeq,
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'STALE_EXECUTION_HANDOFF_MUST_NOT_APPEND' }] } },
        }],
      }),
    })
    assert.equal(staleAppend.status, 409)
    assert.equal((await staleAppend.json()).error.code, 'SESSION_OWNERSHIP_LOST')

    const staleModelCount = llmRequests.length
    const staleModel = await secondPage.evaluate(async input => {
      const response = await fetch('/api/browser-native/llm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          requestId: crypto.randomUUID(),
          sessionId: input.sessionId,
          ownerToken: input.ownerToken,
          ownerEpoch: input.ownerEpoch,
          messages: [],
          tools: [],
        }),
      })
      return { status: response.status, body: await response.json() }
    }, { sessionId: firstTurn.sessionId, ownerToken: initialOwnerToken, ownerEpoch: initialSession.ownerEpoch })
    assert.equal(staleModel.status, 409)
    assert.equal(staleModel.body.error.code, 'SESSION_OWNERSHIP_LOST')
    assert.equal(llmRequests.length, staleModelCount + 1, 'the only added LLM endpoint request is the rejected stale-owner probe')

    const persisted = JSON.parse(await readFile(join(dataDir, 'sessions', `${firstTurn.sessionId}.json`), 'utf8'))
    assert.equal(persisted.durableThroughSeq, persisted.events.length - 1)
    assert.equal(persisted.events.some(event => JSON.stringify(event).includes('STALE_EXECUTION_HANDOFF_MUST_NOT_APPEND')), false)
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(externalRequests, [])
    const observedCookieScopes = await Promise.all(cookieScopes)
    assert.ok(observedCookieScopes.some(scope => scope.path === '/api/browser-native/session/handoff'
      && !scope.hasWorkspaceIdentity && scope.hasHandoffIdentity))
    assert.ok(observedCookieScopes.filter(scope => scope.path === '/api/browser-native/llm')
      .every(scope => !scope.hasWorkspaceIdentity && !scope.hasHandoffIdentity))

    process.stdout.write(`${JSON.stringify({
      result: 'passed',
      mode,
      browser: 'chrome',
      scenario: name,
      sessionId: firstTurn.sessionId,
      handoffState: handoff.executionHandoff.state,
      sessionOwnerEpoch: { before: initialSession.ownerEpoch, after: finalSession.ownerEpoch },
      workspaceRevision: manifest.revision,
      workspaceFencingToken: { before: firstLease.fencingToken, after: secondLease.fencingToken },
      toolCalls: calls.length,
      durableReceipts: receipts.length,
      successfulWorkspaceCommits: commits.filter(commit => commit.workspaceId === workspaceId && commit.status === 200).length,
      llmRequests: { firstWorker: llmRequests.filter(request => request.page === firstPage).length, secondWorker: llmRequests.filter(request => request.page === secondPage).length },
      staleWorkspaceRenewStatus: staleRenew.status,
      staleSessionAppendStatus: staleAppend.status,
      staleModelStatus: staleModel.status,
      pageErrors,
      externalRequests,
      principalCookiesOnLlmRequests: observedCookieScopes.filter(scope => scope.path === '/api/browser-native/llm')
        .filter(scope => scope.hasWorkspaceIdentity || scope.hasHandoffIdentity).length,
    })}\n`)
  } finally {
    await secondPage.close().catch(() => {})
    await firstPage.close().catch(() => {})
    await context.close().catch(() => {})
  }
}

let origin
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  for (const scenario of scenarios) {
    if (requestedDataDir === undefined) {
      dataDir = await mkdtemp(join(tmpdir(), `dsh-browser-execution-handoff-${scenario}-`))
      ownedDataDirs.push(dataDir)
    } else {
      dataDir = scenarios.length === 1 ? requestedDataDir : join(requestedDataDir, scenario)
    }
    app = await createBrowserNativeV2Server({
      dataDir,
      distRoot: image.distRoot,
      llmMode: mode,
      ...(envFile === undefined ? {} : { envFile }),
      ownerLeaseMs: 30_000,
      testHooks: {
        now: () => backendNow,
        workspaceWriterLeaseMs: 10_000,
        onSessionOperationQueued: (operation, body) => {
          if (operation === 'handoff') handoffBodies.push({ checkpoint: structuredClone(body.checkpoint) })
        },
        dropSessionHandoffResponse: body => {
          if (activeScenario !== 'session-response-lost' || !dropHandoff || body.handoffId !== 'execution-handoff-session-response-lost') return false
          dropHandoff = false
          return true
        },
        dropWorkspaceLeaseReleaseResponse: body => {
          if (activeScenario !== 'workspace-release-response-lost' || !dropWorkspaceRelease) return false
          dropWorkspaceRelease = false
          return true
        },
      },
    })
    origin = await app.listen(0)
    await runScenario(scenario)
    await app.close()
    app = undefined
  }
} finally {
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  await Promise.all(ownedDataDirs.map(directory => rm(directory, { recursive: true, force: true })))
}
