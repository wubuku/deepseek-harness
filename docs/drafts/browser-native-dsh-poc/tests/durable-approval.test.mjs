import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

async function openIdentity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const cookies = response.headers.getSetCookie().map(value => value.split(';')[0])
  const body = await response.json()
  return { cookie: cookies.join('; '), workspaceId: body.workspaceId }
}

async function request(origin, pathname, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ protocolVersion: 1, requestId: `approval-${String(Date.now())}`, ...body }) }),
  })
  const payload = await response.json()
  return { status: response.status, body: payload }
}

async function manifestPaths(origin, cookie, workspaceId) {
  const manifest = await request(origin, `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`, { cookie })
  assert.equal(manifest.status, 200, JSON.stringify(manifest.body))
  return (manifest.body.entries ?? []).map(entry => entry.path)
}

async function waitPending(origin, cookie, turnId) {
  let last
  for (let attempt = 0; attempt < 300; attempt += 1) {
    last = await request(origin, `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`, { cookie })
    if (last.body.pendingApproval !== undefined) return last.body.pendingApproval
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  }
  throw new Error(`no pending approval for ${turnId}: ${JSON.stringify(last)}`)
}

async function waitSettled(origin, cookie, turnId) {
  let last
  for (let attempt = 0; attempt < 400; attempt += 1) {
    last = await request(origin, `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`, { cookie })
    if (last.body.status !== 'running') return last.body
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  }
  throw new Error(`turn ${turnId} did not settle: ${JSON.stringify(last)}`)
}

async function eventsOf(origin, cookie, sessionId) {
  const read = await request(origin, '/api/browser-native/session/read', { method: 'POST', cookie, body: { sessionId, offset: 0 } })
  assert.equal(read.status, 200, JSON.stringify(read.body))
  return read.body.events
}

function writeTarget(prompt) {
  return prompt.slice('WRITE_TARGET:'.length)
}

function makeFault(body) {
  const lastUserIndex = body.messages.findLastIndex(message => message.role === 'user')
  const lastUser = body.messages[lastUserIndex]
  const text = typeof lastUser?.content === 'string' ? lastUser.content : ''
  const target = text.startsWith('WRITE_TARGET:') ? writeTarget(text) : '/dsh/home/workspace/approval-default.txt'
  const sawToolResult = body.messages.slice(lastUserIndex + 1).some(message => message.role === 'tool')
  if (sawToolResult) return { kind: 'text', text: 'APPROVAL_TURN_DONE' }
  return {
    kind: 'tool-call',
    call: { id: `write-${target.slice(target.lastIndexOf('/') + 1)}`, name: 'write', arguments: { file_path: target, content: 'APPROVED_BODY' } },
  }
}

test('durable write requires approval, settles once, and honours timeout and cancellation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-durable-approval-'))
  const app = await createBrowserNativeV2Server({
    dataDir,
    llmMode: 'scripted',
    durableTurnTimeoutMs: 20_000,
    durableApprovalTimeoutMs: 900,
    testHooks: { scriptedLlmFault: makeFault },
  })
  let origin
  try {
    origin = await app.listen(0)
    const { cookie, workspaceId } = await openIdentity(origin)
    const sessionId = 'durable-approval-session'
    const rejectedPath = '/dsh/home/workspace/approval-rejected.txt'
    const approvedPath = '/dsh/home/workspace/approval-approved.txt'
    const timeoutPath = '/dsh/home/workspace/approval-timeout.txt'
    const cancelledPath = '/dsh/home/workspace/approval-cancelled.txt'

    // Rejection: the write must not run and the turn continues with an error tool result.
    const rejectedTurn = 'approval-turn-reject'
    const rejectedStart = await request(origin, '/api/browser-native/session/durable', {
      method: 'POST', cookie, body: { sessionId, turnId: rejectedTurn, prompt: `WRITE_TARGET:${rejectedPath}` },
    })
    assert.equal(rejectedStart.status, 202, JSON.stringify(rejectedStart.body))
    const rejectedPending = await waitPending(origin, cookie, rejectedTurn)
    assert.equal(rejectedPending.name, 'write')
    assert.equal(rejectedPending.target, rejectedPath)
    assert.equal((await manifestPaths(origin, cookie, workspaceId)).includes('approval-rejected.txt'), false, 'the write must not run before approval')
    const rejectedDecision = await request(origin, '/api/browser-native/session/durable/approve', {
      method: 'POST', cookie, body: { turnId: rejectedTurn, approvalId: rejectedPending.approvalId, decision: 'reject' },
    })
    assert.equal(rejectedDecision.status, 202, JSON.stringify(rejectedDecision.body))
    const rejectedSettled = await waitSettled(origin, cookie, rejectedTurn)
    assert.equal(rejectedSettled.status, 'completed')
    assert.equal((await manifestPaths(origin, cookie, workspaceId)).includes('approval-rejected.txt'), false)
    const rejectedEvents = await eventsOf(origin, cookie, sessionId)
    const rejectedResult = rejectedEvents.find(event => event.type === 'tool/result')
    assert.equal(rejectedResult.data.message.isError, true)
    assert.match(rejectedResult.data.message.content[0].text, /rejected/i)

    // Approval: the write runs once and the file appears after the decision.
    const approvedTurn = 'approval-turn-approve'
    await request(origin, '/api/browser-native/session/durable', {
      method: 'POST', cookie, body: { sessionId, turnId: approvedTurn, prompt: `WRITE_TARGET:${approvedPath}` },
    })
    const approvedPending = await waitPending(origin, cookie, approvedTurn)
    assert.equal((await manifestPaths(origin, cookie, workspaceId)).includes('approval-approved.txt'), false)
    const approvedDecision = await request(origin, '/api/browser-native/session/durable/approve', {
      method: 'POST', cookie, body: { turnId: approvedTurn, approvalId: approvedPending.approvalId, decision: 'approve' },
    })
    assert.equal(approvedDecision.status, 202)
    const approvedSettled = await waitSettled(origin, cookie, approvedTurn)
    assert.equal(approvedSettled.status, 'completed')
    assert.equal((await manifestPaths(origin, cookie, workspaceId)).includes('approval-approved.txt'), true)

    // Two clients: the first decision wins and the second is refused.
    const twiceTurn = 'approval-turn-twice'
    await request(origin, '/api/browser-native/session/durable', {
      method: 'POST', cookie, body: { sessionId, turnId: twiceTurn, prompt: `WRITE_TARGET:${approvedPath}2` },
    })
    const twicePending = await waitPending(origin, cookie, twiceTurn)
    const firstDecision = await request(origin, '/api/browser-native/session/durable/approve', {
      method: 'POST', cookie, body: { turnId: twiceTurn, approvalId: twicePending.approvalId, decision: 'approve' },
    })
    assert.equal(firstDecision.status, 202)
    const secondDecision = await request(origin, '/api/browser-native/session/durable/approve', {
      method: 'POST', cookie, body: { turnId: twiceTurn, approvalId: twicePending.approvalId, decision: 'reject' },
    })
    assert.equal(secondDecision.status, 409, JSON.stringify(secondDecision.body))
    assert.equal(secondDecision.body.error.code, 'APPROVAL_ALREADY_DECIDED')
    assert.equal((await waitSettled(origin, cookie, twiceTurn)).status, 'completed')

    // Timeout: an undecided approval fails the turn and settles the tool call.
    const timeoutTurn = 'approval-turn-timeout'
    await request(origin, '/api/browser-native/session/durable', {
      method: 'POST', cookie, body: { sessionId, turnId: timeoutTurn, prompt: `WRITE_TARGET:${timeoutPath}` },
    })
    await waitPending(origin, cookie, timeoutTurn)
    const timeoutSettled = await waitSettled(origin, cookie, timeoutTurn)
    assert.equal(timeoutSettled.status, 'failed')
    assert.equal(timeoutSettled.error.code, 'DURABLE_APPROVAL_TIMEOUT')
    assert.equal((await manifestPaths(origin, cookie, workspaceId)).includes('approval-timeout.txt'), false)
    const timeoutEvents = await eventsOf(origin, cookie, sessionId)
    const timeoutResult = timeoutEvents.filter(event => event.type === 'tool/result').at(-1)
    assert.equal(timeoutResult.data.message.isError, true)
    assert.match(timeoutResult.data.message.content[0].text, /not approved/i)
    assert.equal(timeoutEvents.filter(event => event.type === 'tool/result').length, timeoutEvents.filter(event => event.type === 'tool/call').length, 'every tool call must settle')

    // Cancellation while awaiting approval: cancelled, not timed out, and the tool call is settled.
    const cancelledTurn = 'approval-turn-cancel'
    await request(origin, '/api/browser-native/session/durable', {
      method: 'POST', cookie, body: { sessionId, turnId: cancelledTurn, prompt: `WRITE_TARGET:${cancelledPath}` },
    })
    await waitPending(origin, cookie, cancelledTurn)
    const stopped = await request(origin, '/api/browser-native/session/durable/stop', {
      method: 'POST', cookie, body: { turnId: cancelledTurn },
    })
    assert.equal(stopped.status, 202)
    const cancelledSettled = await waitSettled(origin, cookie, cancelledTurn)
    assert.equal(cancelledSettled.status, 'cancelled')
    assert.equal(cancelledSettled.pendingApproval, undefined)
    assert.equal((await manifestPaths(origin, cookie, workspaceId)).includes('approval-cancelled.txt'), false)
    const cancelledEvents = await eventsOf(origin, cookie, sessionId)
    const cancelledResult = cancelledEvents.filter(event => event.type === 'tool/result').at(-1)
    assert.equal(cancelledResult.data.message.isError, true)
    assert.match(cancelledResult.data.message.content[0].text, /cancelled/i)

    // A settled tool call leaves the Session able to start another turn.
    const afterCancelTurn = 'approval-turn-after-cancel'
    const afterCancel = await request(origin, '/api/browser-native/session/durable', {
      method: 'POST', cookie, body: { sessionId, turnId: afterCancelTurn, prompt: `WRITE_TARGET:${timeoutPath}.after` },
    })
    assert.equal(afterCancel.status, 202, JSON.stringify(afterCancel.body))
    await waitPending(origin, cookie, afterCancelTurn)
    await request(origin, '/api/browser-native/session/durable/stop', { method: 'POST', cookie, body: { turnId: afterCancelTurn } })
    await waitSettled(origin, cookie, afterCancelTurn)

    // Ownership: another principal and an anonymous caller cannot decide.
    const foreign = await openIdentity(origin)
    const foreignDecision = await request(origin, '/api/browser-native/session/durable/approve', {
      method: 'POST', cookie: foreign.cookie, body: { turnId: twiceTurn, approvalId: twicePending.approvalId, decision: 'approve' },
    })
    assert.equal(foreignDecision.status, 404)
    assert.equal(foreignDecision.body.error.code, 'TURN_NOT_FOUND')
    const anonymousDecision = await request(origin, '/api/browser-native/session/durable/approve', {
      method: 'POST', body: { turnId: twiceTurn, approvalId: twicePending.approvalId, decision: 'approve' },
    })
    assert.equal(anonymousDecision.status, 401)

    const metrics = await request(origin, '/api/browser-native/observability/metrics')
    assert.equal(metrics.status, 200)
    assert.deepEqual(metrics.body.durableTurns.approvals, { pending: 0, requested: 6, approved: 2, rejected: 1, timedOut: 1, cancelled: 2 })
    const lastSessionEvents = await eventsOf(origin, cookie, sessionId)
    assert.equal(lastSessionEvents.filter(event => event.type === 'tool/result').length, lastSessionEvents.filter(event => event.type === 'tool/call').length)

    process.stdout.write(`${JSON.stringify({
      result: 'passed',
      scope: 'durable-approval',
      rejected: { status: rejectedSettled.status, wroteFile: false },
      approved: { status: approvedSettled.status, wroteFile: true },
      doubleDecision: secondDecision.body.error.code,
      timeout: { status: timeoutSettled.status, code: timeoutSettled.error.code },
      cancellation: { status: cancelledSettled.status, pendingApproval: cancelledSettled.pendingApproval ?? null },
      approvals: metrics.body.durableTurns.approvals,
      toolCallsBalanced: true,
      foreignDecision: foreignDecision.status,
      anonymousDecision: anonymousDecision.status,
    })}\n`)
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
