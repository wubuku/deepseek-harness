/**
 * Minimal server-owned durable turn host for the Browser-Native DSH PoC.
 *
 * The browser Worker normally owns and executes every Agent turn. Closing a tab
 * therefore strands an in-flight turn. This host keeps the turn on the backend
 * instead: it claims the Session, writes the turn envelope, requests the model
 * through the same-origin LLM route, and settles the turn after the requesting
 * page is gone. A reopened page reads the same durable Session log.
 *
 * The prototype executes text turns only. Tool calls, workspace mutations,
 * approvals, cancellation, and process-restart recovery are not implemented; a
 * tool-call response settles the turn as an explicit error instead of replaying
 * or fabricating a result.
 */
import { randomUUID } from 'node:crypto'

const MAX_TURN_ID_LENGTH = 200
const MAX_PROMPT_CHARS = 10_000

/**
 * Structured failure raised by the durable host.
 *
 * It carries the HTTP status and stable code the backend reports, so callers can
 * distinguish a transport refusal from an untrusted Session log.
 */
export class DurableTurnError extends Error {
  /**
   * @param {string} code - Stable error code returned to the client.
   * @param {string} message - Human-readable failure text.
   * @param {number} [status] - HTTP status for the refusal.
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'DurableTurnError'
    this.code = code
    this.status = status
  }
}

/**
 * Read the assistant text and finish reason from the backend LLM stream.
 * @param {ReadableStream<Uint8Array>} body - NDJSON response body.
 * @returns {Promise<{text: string, finishReason: string, toolCallCount: number}>} Parsed completion.
 */
async function parseCompletion(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let finishReason
  let toolCallCount = 0
  let streamedError
  const consume = line => {
    if (line === '') return
    const item = JSON.parse(line)
    if (item.kind === 'error') {
      streamedError = item.error
      return
    }
    if (item.kind === 'finish') {
      finishReason = item.chunk?.reason?.kind
      return
    }
    if (item.kind !== 'chunk') return
    const chunk = item.chunk
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
      text = chunk.block.text
    }
    if (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call') toolCallCount += 1
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) consume(line)
    }
    buffer += decoder.decode()
    if (buffer !== '') consume(buffer)
  } finally {
    reader.releaseLock()
  }
  if (streamedError !== undefined) {
    throw new DurableTurnError(
      typeof streamedError.code === 'string' ? streamedError.code : 'DURABLE_LLM_STREAM_FAILED',
      typeof streamedError.message === 'string' ? streamedError.message : 'the model stream failed',
      502,
    )
  }
  return { text, finishReason: finishReason ?? 'stop', toolCallCount }
}

/**
 * Reject a Session log whose next turn cannot be appended safely.
 * @param {object} session - Session record owned by the formal store.
 * @returns {number} Turn number the new server-owned turn must use.
 */
function nextTurnNumber(session) {
  let lastTurn = 0
  let activeTurn
  const openCalls = new Set()
  for (const event of session.events) {
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') {
      throw new DurableTurnError('SESSION_LOG_INVALID', 'Session contains an invalid event envelope', 409)
    }
    switch (event.type) {
      case 'turn/start': {
        const turn = event.data?.turn
        if (!Number.isSafeInteger(turn) || turn <= lastTurn) {
          throw new DurableTurnError('SESSION_LOG_INVALID', 'Session turn order is invalid', 409)
        }
        activeTurn = turn
        lastTurn = turn
        break
      }
      case 'turn/end':
        activeTurn = undefined
        break
      case 'tool/call': {
        const callId = event.data?.callId
        if (typeof callId === 'string') openCalls.add(callId)
        break
      }
      case 'tool/result': {
        const callId = event.data?.message?.toolCallId
        if (typeof callId === 'string') openCalls.delete(callId)
        break
      }
      default:
        break
    }
  }
  if (activeTurn !== undefined) {
    throw new DurableTurnError('SESSION_TURN_ACTIVE', 'Session already has an active turn', 409)
  }
  if (openCalls.size > 0) {
    throw new DurableTurnError('SESSION_STATE_UNSUPPORTED', 'Session has unsettled tool calls the minimal host cannot resume', 409)
  }
  return lastTurn + 1
}

function assertBoundedText(value, name, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new DurableTurnError('INVALID_REQUEST', `${name} must contain 1 to ${String(maximum)} characters`)
  }
  return value
}

/**
 * Create the server-owned durable turn host.
 * @param {{store: object, admission?: object, model: string, originOf: () => string|undefined, timeoutMs: number}} options - Session store, admission controller, served origin, and model timeout.
 * @returns {{start: Function, status: Function, version: number}} Host operations.
 */
export function createDurableTurnHost({ store, admission, model, originOf, timeoutMs }) {
  if (typeof store?.exclusive !== 'function') throw new TypeError('durable host requires the formal Session store')
  if (typeof originOf !== 'function') throw new TypeError('durable host requires the served origin resolver')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 300) throw new TypeError('durable host timeoutMs must be an integer of at least 300')
  const runs = new Map()

  const runStatus = run => ({
    version: 1,
    turnId: run.turnId,
    sessionId: run.sessionId,
    status: run.status,
    ...(run.turn === undefined ? {} : { turn: run.turn }),
    model,
    startedAt: run.startedAt,
    ...(run.settledAt === undefined ? {} : { settledAt: run.settledAt, elapsedMs: run.settledAt - run.startedAt }),
    ...(run.startSeqs === undefined ? {} : { startSeqs: [...run.startSeqs] }),
    ...(run.endSeqs === undefined ? {} : { endSeqs: [...run.endSeqs] }),
    ...(run.nextSeq === undefined ? {} : { nextSeq: run.nextSeq }),
    ...(run.error === undefined ? {} : { error: { ...run.error } }),
  })

  const requestCompletion = async (run, prompt, owner) => {
    const origin = originOf()
    if (typeof origin !== 'string') throw new DurableTurnError('DURABLE_HOST_NOT_READY', 'the durable host has no served origin', 503)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetch(`${origin}/api/browser-native/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          requestId: run.turnId,
          sessionId: run.sessionId,
          ownerToken: owner.ownerToken,
          ownerEpoch: owner.ownerEpoch,
          messages: [{ role: 'user', content: prompt }],
          tools: [],
        }),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) throw new DurableTurnError('DURABLE_LLM_TIMEOUT', `the model did not answer within ${String(timeoutMs)}ms`, 504)
      throw new DurableTurnError('DURABLE_LLM_UNAVAILABLE', `the model route could not be reached: ${String(error)}`, 502)
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok || response.body === null) {
      let detail
      try { detail = await response.json() } catch { detail = undefined }
      throw new DurableTurnError(
        typeof detail?.error?.code === 'string' ? detail.error.code : 'DURABLE_LLM_FAILED',
        typeof detail?.error?.message === 'string' ? detail.error.message : `the model route returned HTTP ${String(response.status)}`,
        response.status,
      )
    }
    return await parseCompletion(response.body)
  }

  const settleSuccess = async (run, owner, completion) => {
    await store.exclusive(run.sessionId, async () => {
      const session = store.get(run.sessionId)
      store.assertOwner(session, owner.ownerToken, owner.ownerEpoch)
      const turn = run.turn
      let events
      if (completion.finishReason === 'stop' && completion.text.trim() !== '') {
        events = [
          {
            type: 'assistant/message',
            data: {
              turn,
              step: 1,
              message: {
                id: `durable-assistant-${turn}-1-${randomUUID()}`,
                role: 'assistant',
                source: { kind: 'model', provider: 'browser-native-durable', model },
                content: [{ type: 'text', text: completion.text }],
              },
            },
          },
          { type: 'step/end', data: { turn, step: 1 } },
          { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
        ]
      } else if (completion.finishReason === 'tool-calls') {
        events = [
          { type: 'step/end', data: { turn, step: 1 } },
          {
            type: 'turn/end',
            data: {
              turn,
              reason: {
                kind: 'error',
                error: {
                  code: 'DURABLE_TOOL_UNSUPPORTED',
                  message: 'the minimal durable host does not execute tool calls',
                },
              },
            },
          },
        ]
      } else {
        events = [
          { type: 'step/end', data: { turn, step: 1 } },
          {
            type: 'turn/end',
            data: {
              turn,
              reason: {
                kind: 'error',
                error: { code: 'DURABLE_EMPTY_RESPONSE', message: 'the model completed without assistant text' },
              },
            },
          },
        ]
      }
      const base = session.events.length
      for (const [index, event] of events.entries()) session.events.push({ seq: base + index, ...event })
      await store.flush(session)
      run.endSeqs = events.map((event, index) => base + index)
      run.nextSeq = session.events.length
      run.status = 'completed'
      run.settledAt = Date.now()
    })
  }

  const settleFailure = async (run, owner, error) => {
    await store.exclusive(run.sessionId, async () => {
      const session = store.get(run.sessionId)
      store.assertOwnerToken(session, owner.ownerToken, owner.ownerEpoch)
      if (run.turn === undefined) return
      const hasStepEnd = session.events.some(event => event.type === 'step/end' && event.data?.turn === run.turn)
      const hasTurnEnd = session.events.some(event => event.type === 'turn/end' && event.data?.turn === run.turn)
      const events = []
      if (!hasStepEnd) events.push({ type: 'step/end', data: { turn: run.turn, step: 1 } })
      if (!hasTurnEnd) {
        events.push({
          type: 'turn/end',
          data: {
            turn: run.turn,
            reason: {
              kind: 'error',
              error: {
                code: typeof error?.code === 'string' ? error.code : 'DURABLE_TURN_FAILED',
                message: typeof error?.message === 'string' ? error.message : String(error),
              },
            },
          },
        })
      }
      if (events.length === 0) return
      const base = session.events.length
      for (const [index, event] of events.entries()) session.events.push({ seq: base + index, ...event })
      await store.flush(session)
      run.endSeqs = events.map((event, index) => base + index)
      run.nextSeq = session.events.length
    })
  }

  const releaseOwner = async (run, owner) => {
    await store.exclusive(run.sessionId, async () => {
      const session = store.sessions.get(run.sessionId)
      if (session === undefined || session.ownerToken !== owner.ownerToken) return
      session.ownerToken = undefined
      session.ownerExpiresAt = 0
    })
  }

  const execute = async (run, prompt, header) => {
    let owner
    try {
      owner = await store.exclusive(run.sessionId, async () => {
        let session = store.sessions.get(run.sessionId)
        if (session === undefined) {
          session = store.create(run.sessionId, header, 0, run.principalId)
        } else if (session.principalId !== run.principalId) {
          throw new DurableTurnError('SESSION_NOT_FOUND', 'session does not exist', 404)
        }
        const turn = nextTurnNumber(session)
        const claimed = store.claim(session)
        const base = session.events.length
        const events = [
          { seq: base, type: 'turn/start', data: { turn } },
          { seq: base + 1, type: 'user/message', data: { content: prompt } },
          { seq: base + 2, type: 'step/start', data: { turn, step: 1 } },
        ]
        session.events.push(...events)
        await store.flush(session)
        run.turn = turn
        run.startSeqs = events.map(event => event.seq)
        run.nextSeq = session.events.length
        return { ownerToken: claimed.ownerToken, ownerEpoch: claimed.ownerEpoch }
      })
      admission?.mountSession(run.sessionId)
    } catch (error) {
      run.phaseOne.resolve({ error })
      throw error
    }
    run.phaseOne.resolve({ ok: true })
    try {
      const completion = await requestCompletion(run, prompt, owner)
      await settleSuccess(run, owner, completion)
    } catch (error) {
      try {
        await settleFailure(run, owner, error)
      } catch {
        // The Session log may already be untrusted; ownership below still releases.
      }
      throw error
    } finally {
      try {
        await releaseOwner(run, owner)
      } catch {
        // A release failure leaves only a lease that expires; the run result stands.
      }
      admission?.releaseMount(run.sessionId)
    }
  }

  /**
   * Start or replay a server-owned turn.
   * @param {{sessionId: string, principalId: string, turnId: string, prompt: string, header: object}} request - Turn identity, owner principal, prompt, and Session header.
   * @returns {Promise<object>} Current run status; a replayed turn never executes twice.
   */
  const start = async ({ sessionId, principalId, turnId, prompt, header }) => {
    assertBoundedText(turnId, 'turnId', MAX_TURN_ID_LENGTH)
    assertBoundedText(prompt, 'prompt', MAX_PROMPT_CHARS)
    const existing = runs.get(turnId)
    if (existing !== undefined) {
      if (existing.sessionId !== sessionId || existing.principalId !== principalId) {
        throw new DurableTurnError('TURN_CONFLICT', 'turnId is already bound to another Session or principal', 409)
      }
      return { ...runStatus(existing), replayed: true }
    }
    const run = {
      turnId,
      sessionId,
      principalId,
      status: 'running',
      startedAt: Date.now(),
      phaseOne: Promise.withResolvers(),
    }
    runs.set(turnId, run)
    void execute(run, prompt, header).catch(error => {
      run.status = 'failed'
      run.error = {
        code: typeof error?.code === 'string' ? error.code : 'DURABLE_TURN_FAILED',
        message: typeof error?.message === 'string' ? error.message : String(error),
      }
      run.settledAt = Date.now()
    })
    const phase = await run.phaseOne.promise
    if (phase.error !== undefined) {
      run.status = 'failed'
      run.error = {
        code: typeof phase.error.code === 'string' ? phase.error.code : 'DURABLE_TURN_FAILED',
        message: typeof phase.error.message === 'string' ? phase.error.message : String(phase.error),
      }
      run.settledAt = Date.now()
      throw new DurableTurnError(run.error.code, run.error.message, typeof phase.error.status === 'number' ? phase.error.status : 409)
    }
    return runStatus(run)
  }

  /**
   * Read a server-owned turn without exposing its owner credential.
   * @param {{turnId: string, principalId: string}} query - Turn identity and requesting principal.
   * @returns {object} Current run status.
   */
  const status = ({ turnId, principalId }) => {
    assertBoundedText(turnId, 'turnId', MAX_TURN_ID_LENGTH)
    const run = runs.get(turnId)
    if (run === undefined || run.principalId !== principalId) {
      throw new DurableTurnError('TURN_NOT_FOUND', 'durable turn does not exist', 404)
    }
    return runStatus(run)
  }

  return { start, status, version: 1 }
}
