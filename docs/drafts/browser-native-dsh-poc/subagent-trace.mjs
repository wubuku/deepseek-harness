/**
 * Delegation trace reconstruction for the browser-native DSH PoC.
 *
 * A trace id is the root Session id of a delegation tree. Subagent children
 * persist `parentSession`, `origin`, and `delegationDepth` in their headers,
 * so the backend recomputes the same trace after a restart without a counter.
 * The report joins stored Session events, retained LLM usage, and tool-policy
 * audit decisions so one delegation can be followed from parent to child.
 */
import { buildUsageReport } from './usage-report.mjs'

/**
 * Resolve the trace id shared by a Session and every delegation ancestor.
 * @param {object} store - Session store exposing `get`.
 * @param {object} session - Stored Session whose lineage is resolved.
 * @returns {string} Root Session id of this delegation tree.
 */
export function traceIdFor(store, session) {
  let current = session
  const visited = new Set([current.id])
  while (current.header.parentSession !== undefined) {
    const parentId = current.header.parentSession
    if (visited.has(parentId)) return [...visited].sort()[0]
    visited.add(parentId)
    let parent
    try {
      parent = store.get(parentId)
    } catch {
      break
    }
    current = parent
  }
  return current.id
}

/**
 * Text of a tool result produced by a delegated call.
 * @param {object|undefined} event - `tool/result` event.
 * @returns {string} Concatenated visible text, or an empty string.
 */
function toolResultText(event) {
  const content = event?.data?.message?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('') : ''
}

/**
 * Find the parent call that started a delegated child Session.
 * @param {object|undefined} parent - Stored parent Session.
 * @param {string} childId - Child Session id named in the tool result.
 * @returns {{callId: string, turn: number} | undefined} Parent call linkage.
 */
function subagentCallFor(parent, childId) {
  if (parent === undefined) return undefined
  for (const event of parent.events) {
    if (event.type !== 'tool/call' || event.data.name !== 'subagent') continue
    const result = parent.events.find(candidate => candidate.type === 'tool/result'
      && candidate.data.message?.toolCallId === event.data.callId)
    if (!toolResultText(result).includes(`started subagent ${childId}`)) continue
    const turnStart = parent.events.slice(0, event.seq).findLast(candidate => candidate.type === 'turn/start')
    return { callId: event.data.callId, turn: turnStart?.data.turn ?? 0 }
  }
  return undefined
}

/**
 * Reconstruct one delegation tree from stored Sessions, usage, and audit events.
 * @param {object} store - Session store with `sessions`, `get`, and `isExpired`.
 * @param {object[]} usage - Retained usage entries for this principal.
 * @param {object} options - `pricing`, `model`, `now`, and `accessDenials`.
 * @param {object} session - Session the caller asked about; any tree member is accepted.
 * @returns {object} Trace report rooted at the delegation tree's top-level Session.
 */
export function buildTraceReport(store, usage, options, session) {
  const traceId = traceIdFor(store, session)
  const members = [...store.sessions.values()]
    .filter(candidate => candidate.principalId === session.principalId && !store.isExpired(candidate)
      && traceIdFor(store, candidate) === traceId)
    .sort((left, right) => left.header.createdAt - right.header.createdAt)
  const usageRows = new Map()
  for (const principal of buildUsageReport(
    usage.filter(entry => members.some(candidate => candidate.id === entry.sessionId)),
    { pricing: options.pricing, model: options.model, now: options.now },
  ).principals) {
    for (const row of principal.sessions) usageRows.set(row.sessionId, row)
  }
  const sessions = members.map(candidate => {
    const terminal = candidate.events.filter(event => event.type === 'turn/end')
    const decisions = candidate.events.filter(event => event.type === 'tool-policy/decided')
    const linkage = candidate.header.parentSession === undefined
      ? undefined
      : subagentCallFor(members.find(parent => parent.id === candidate.header.parentSession), candidate.id)
    return {
      sessionId: candidate.id,
      parentSession: candidate.header.parentSession ?? null,
      parentCallId: linkage?.callId ?? null,
      parentTurn: linkage?.turn ?? null,
      origin: candidate.header.origin ?? null,
      delegationDepth: candidate.header.delegationDepth ?? 0,
      createdAt: candidate.header.createdAt,
      turns: terminal.length,
      lastTurnReason: terminal.at(-1)?.data.reason?.kind ?? null,
      usage: usageRows.get(candidate.id) ?? {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: options.pricing === undefined ? null : 0,
      },
      audit: {
        toolPolicy: {
          allow: decisions.filter(event => event.data.policy === 'allow').length,
          ask: decisions.filter(event => event.data.policy === 'ask').length,
          deny: decisions.filter(event => event.data.policy === 'deny').length,
        },
      },
    }
  })
  const memberIds = new Set(members.map(candidate => candidate.id))
  const totals = sessions.reduce((sum, row) => ({
    sessions: sum.sessions + 1,
    turns: sum.turns + row.turns,
    requests: sum.requests + row.usage.requests,
    inputTokens: sum.inputTokens + row.usage.inputTokens,
    outputTokens: sum.outputTokens + row.usage.outputTokens,
    totalTokens: sum.totalTokens + row.usage.totalTokens,
    costUsd: sum.costUsd + (row.usage.costUsd ?? 0),
  }), { sessions: 0, turns: 0, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 })
  return {
    traceId,
    rootSessionId: traceId,
    sessionId: session.id,
    model: options.model ?? null,
    sessions,
    totals: { ...totals, costUsd: options.pricing === undefined ? null : totals.costUsd },
    accessDenials: (options.accessDenials ?? []).filter(entry => memberIds.has(entry.resourceId)),
  }
}
