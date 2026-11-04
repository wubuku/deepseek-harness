/**
 * Delegation trace report contract.
 *
 * Builds a two-Session delegation tree without a server and checks the trace
 * id, parent call linkage, audit attribution, per-Session and total usage cost,
 * unpriced mode, and the principal boundary.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTraceReport, traceIdFor } from '../subagent-trace.mjs'
import { normalizeUsagePricing } from '../usage-report.mjs'

const PRICING = normalizeUsagePricing({ inputUsdPer1M: 1.25, outputUsdPer1M: 2.5 })

/** Compare floating costs without depending on binary representation details. */
function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= 1e-9, `${String(actual)} must be within 1e-9 of ${String(expected)}`)
}

function storedSession(id, { principalId = 'p1', parentSession, depth = 0, createdAt = 0, events = [] } = {}) {
  return {
    id,
    principalId,
    header: { parentSession, origin: parentSession === undefined ? 'user' : 'subagent', delegationDepth: depth, createdAt },
    events: events.map((event, index) => ({ seq: index, ...event })),
  }
}

function fakeStore(sessions) {
  const map = new Map(sessions.map(session => [session.id, session]))
  return {
    sessions: map,
    get: id => {
      const session = map.get(id)
      if (session === undefined) throw new Error(`unknown session ${id}`)
      return session
    },
    isExpired: () => false,
  }
}

const PARENT_CALL = { type: 'tool/call', data: { callId: 'call-1', name: 'subagent' } }
const PARENT_RESULT = { type: 'tool/result', data: { message: { toolCallId: 'call-1', content: 'started subagent child-1' } } }
const ALLOW = { type: 'tool-policy/decided', data: { policy: 'allow', tool: 'read' } }
const DENY = { type: 'tool-policy/decided', data: { policy: 'deny', tool: 'write' } }
const ASK = { type: 'tool-policy/decided', data: { policy: 'ask', tool: 'shell' } }
const TURN = { type: 'turn/end', data: { reason: { kind: 'completed' } } }

test('root Session id is the trace id for its delegated children', () => {
  const parent = storedSession('parent-1', { createdAt: 1, events: [TURN] })
  const child = storedSession('child-1', { parentSession: 'parent-1', depth: 1, createdAt: 2, events: [TURN] })
  const store = fakeStore([parent, child])
  assert.equal(traceIdFor(store, parent), 'parent-1')
  assert.equal(traceIdFor(store, child), 'parent-1')
})

test('ancestry stops at an unknown or cyclic parent without inventing a trace', () => {
  const orphan = storedSession('orphan-1', { parentSession: 'missing-parent', depth: 1, createdAt: 1 })
  const a = storedSession('a', { parentSession: 'b', depth: 2, createdAt: 1 })
  const b = storedSession('b', { parentSession: 'a', depth: 1, createdAt: 1 })
  const store = fakeStore([orphan, a, b])
  assert.equal(traceIdFor(store, orphan), 'orphan-1')
  assert.equal(traceIdFor(store, a), 'a', 'a cycle resolves to its smallest member on both paths')
  assert.equal(traceIdFor(store, b), 'a')
})

test('report reconstructs parent call, audit, and per-Session cost', () => {
  const parent = storedSession('parent-1', {
    createdAt: 1,
    events: [{ type: 'turn/start', data: { turn: 2 } }, PARENT_CALL, PARENT_RESULT, ALLOW, DENY, ASK, TURN],
  })
  const child = storedSession('child-1', { parentSession: 'parent-1', depth: 1, createdAt: 2, events: [TURN] })
  const other = storedSession('other-1', { principalId: 'p2', createdAt: 3, events: [TURN] })
  const store = fakeStore([parent, child, other])
  const usage = [
    { principalId: 'p1', sessionId: 'parent-1', traceId: 'parent-1', inputTokens: 1_000, outputTokens: 200 },
    { principalId: 'p1', sessionId: 'child-1', traceId: 'parent-1', inputTokens: 500, outputTokens: 100 },
    { principalId: 'p2', sessionId: 'other-1', traceId: 'other-1', inputTokens: 900, outputTokens: 900 },
  ]
  const fromChild = buildTraceReport(store, usage, { pricing: PRICING, model: 'priced-model', now: 0 }, child)
  assert.equal(fromChild.traceId, 'parent-1')
  assert.equal(fromChild.rootSessionId, 'parent-1')
  assert.equal(fromChild.sessionId, 'child-1')
  assert.equal(fromChild.sessions.length, 2, 'only members of this principal and trace are included')
  const [parentRow, childRow] = fromChild.sessions
  assert.equal(parentRow.sessionId, 'parent-1')
  assert.equal(parentRow.parentSession, null)
  assert.equal(parentRow.audit.toolPolicy.allow, 1)
  assert.equal(parentRow.audit.toolPolicy.ask, 1)
  assert.equal(parentRow.audit.toolPolicy.deny, 1)
  assert.equal(parentRow.usage.inputTokens, 1_000)
  closeTo(parentRow.usage.costUsd, (1_000 / 1_000_000) * 1.25 + (200 / 1_000_000) * 2.5)
  assert.equal(childRow.sessionId, 'child-1')
  assert.equal(childRow.parentSession, 'parent-1')
  assert.equal(childRow.parentCallId, 'call-1')
  assert.equal(childRow.parentTurn, 2)
  assert.equal(childRow.delegationDepth, 1)
  assert.equal(childRow.usage.inputTokens, 500)
  assert.equal(fromChild.totals.sessions, 2)
  assert.equal(fromChild.totals.inputTokens, 1_500)
  assert.equal(fromChild.totals.outputTokens, 300)
  closeTo(fromChild.totals.costUsd, (1_500 / 1_000_000) * 1.25 + (300 / 1_000_000) * 2.5)
  assert.deepEqual(fromChild.accessDenials, [])

  const fromParent = buildTraceReport(store, usage, { pricing: PRICING, model: 'priced-model', now: 0 }, parent)
  assert.deepEqual(fromParent.sessions.map(row => row.sessionId), ['parent-1', 'child-1'])
  assert.deepEqual(fromParent.totals, fromChild.totals)
})

test('unpriced mode keeps tokens and reports no cost', () => {
  const parent = storedSession('parent-1', { createdAt: 1, events: [TURN] })
  const store = fakeStore([parent])
  const report = buildTraceReport(store, [
    { principalId: 'p1', sessionId: 'parent-1', inputTokens: 10, outputTokens: 4 },
  ], { now: 0, accessDenials: [] }, parent)
  assert.equal(report.sessions[0].usage.inputTokens, 10)
  closeTo(report.sessions[0].usage.totalTokens, 14)
  assert.equal(report.sessions[0].usage.costUsd, null)
  assert.equal(report.totals.costUsd, null)
})

test('access denials are kept only for trace members', () => {
  const parent = storedSession('parent-1', { createdAt: 1, events: [TURN] })
  const store = fakeStore([parent])
  const report = buildTraceReport(store, [], {
    now: 0,
    accessDenials: [
      { resourceId: 'parent-1', path: '/api/browser-native/session/read', status: 403 },
      { resourceId: 'outside-trace', path: '/api/browser-native/session/read', status: 403 },
    ],
  }, parent)
  assert.equal(report.accessDenials.length, 1)
  assert.equal(report.accessDenials[0].resourceId, 'parent-1')
})
