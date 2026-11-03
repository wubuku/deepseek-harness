/**
 * Minimal server-owned durable turn host for the Browser-Native DSH PoC.
 *
 * The browser Worker normally owns and executes every Agent turn. Closing a tab
 * therefore strands an in-flight turn. This host keeps the turn on the backend
 * instead: it claims the Session, writes the turn envelope, requests the model
 * through the same-origin LLM route, and settles the turn after the requesting
 * page is gone. A reopened page reads the same durable Session log.
 *
 * The host also executes the Workspace `read`/`write` tool calls it advertises
 * to the model, so a tool step started before the tab closed still finishes on
 * the backend. Approvals, cancellation, process-restart recovery, and every
 * other tool are not implemented: an unsupported or missing tool result settles
 * the turn as an explicit error instead of replaying or fabricating a value.
 *
 * A reopened page can attach to the turn's event stream from any sequence number.
 * The stream replays persisted events and then follows appends until the turn
 * settles; attaching never executes a model request or a tool again.
 */
import { randomUUID } from 'node:crypto'

const MAX_TURN_ID_LENGTH = 200
const MAX_PROMPT_CHARS = 10_000
const MAX_DURABLE_STEPS = 8
const MAX_TOOL_RESULT_CHARS = 32_000
const MAX_ATTACH_SEQ = 1_000_000

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
 * Read assistant content blocks and the finish reason from the backend LLM stream.
 * @param {ReadableStream<Uint8Array>} body - NDJSON response body.
 * @returns {Promise<{text: string, finishReason: string, blocks: object[]}>} Parsed completion; `blocks` keeps text and tool-call blocks in stream order.
 */
async function parseCompletion(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let finishReason
  const blocks = []
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
    if (chunk?.type === 'finish') {
      finishReason = chunk.reason?.kind
      return
    }
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
      text = chunk.block.text
      blocks.push({ type: 'text', text: chunk.block.text })
    }
    if (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call') {
      const call = chunk.block
      if (typeof call.id !== 'string' || typeof call.name !== 'string' || typeof call.arguments !== 'string') {
        throw new DurableTurnError('DURABLE_LLM_STREAM_FAILED', 'the model stream contains a malformed tool call', 502)
      }
      blocks.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
    }
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
  return { text, finishReason: finishReason ?? 'stop', blocks }
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
 * @param {{store: object, admission?: object, model: string, originOf: () => string|undefined, timeoutMs: number, tools?: object[], executeTool?: Function}} options - Session store, admission controller, served origin, model timeout, advertised tool definitions, and their server-side executor.
 * @returns {{start: Function, status: Function, subscribe: Function, version: number}} Host operations.
 */
export function createDurableTurnHost({ store, admission, model, originOf, timeoutMs, tools = [], executeTool }) {
  if (typeof store?.exclusive !== 'function') throw new TypeError('durable host requires the formal Session store')
  if (typeof originOf !== 'function') throw new TypeError('durable host requires the served origin resolver')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 300) throw new TypeError('durable host timeoutMs must be an integer of at least 300')
  if (!Array.isArray(tools)) throw new TypeError('durable host tools must be an array')
  if (tools.length > 0 && typeof executeTool !== 'function') throw new TypeError('durable host tools require an executeTool function')
  const runs = new Map()
  const settledRuns = []

  const recordSettled = run => {
    settledRuns.push({
      turnId: run.turnId,
      sessionId: run.sessionId,
      status: run.status,
      ...(run.error === undefined ? {} : { errorCode: run.error.code }),
      elapsedMs: (run.settledAt ?? Date.now()) - run.startedAt,
      settledAt: run.settledAt ?? Date.now(),
    })
    if (settledRuns.length > 20) settledRuns.shift()
  }

  const wakeChannel = run => {
    for (const done of run.channelWaiters) done()
    run.channelWaiters.clear()
  }

  const publish = (run, event) => {
    run.channelEvents.push(event)
    wakeChannel(run)
  }

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

  const requestCompletion = async (run, messages, owner) => {
    const origin = originOf()
    if (typeof origin !== 'string') throw new DurableTurnError('DURABLE_HOST_NOT_READY', 'the durable host has no served origin', 503)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const timedOut = () => new DurableTurnError('DURABLE_LLM_TIMEOUT', `the model did not answer within ${String(timeoutMs)}ms`, 504)
    try {
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
            messages,
            tools,
          }),
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) throw timedOut()
        throw new DurableTurnError('DURABLE_LLM_UNAVAILABLE', `the model route could not be reached: ${String(error)}`, 502)
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
      try {
        return await parseCompletion(response.body)
      } catch (error) {
        if (controller.signal.aborted) throw timedOut()
        throw error
      }
    } finally {
      clearTimeout(timer)
    }
  }

  const appendEvents = async (run, owner, events) => {
    const written = await store.exclusive(run.sessionId, async () => {
      const session = store.get(run.sessionId)
      store.assertOwner(session, owner.ownerToken, owner.ownerEpoch)
      const base = session.events.length
      const rows = events.map((event, index) => ({ seq: base + index, ...event }))
      session.events.push(...rows)
      await store.flush(session)
      run.nextSeq = session.events.length
      return rows
    })
    for (const event of written) publish(run, event)
    return written
  }

  const assistantMessage = (run, step, content) => ({
    id: `durable-assistant-${run.turn}-${step}-${randomUUID()}`,
    role: 'assistant',
    source: { kind: 'model', provider: 'browser-native-durable', model },
    content,
  })

  const driveTurn = async (run, prompt, owner) => {
    const messages = [{ role: 'user', content: prompt }]
    let step = 1
    while (step <= MAX_DURABLE_STEPS) {
      run.step = step
      const completion = await requestCompletion(run, messages, owner)
      const calls = completion.blocks.filter(block => block.type === 'tool-call')
      if (completion.finishReason === 'tool-calls') {
        if (calls.length === 0) {
          throw new DurableTurnError('DURABLE_EMPTY_RESPONSE', 'the model asked for tools without naming a call', 502)
        }
        if (typeof executeTool !== 'function') {
          throw new DurableTurnError('DURABLE_TOOL_UNSUPPORTED', 'the durable host does not execute tool calls', 409)
        }
        const textBlocks = completion.blocks.filter(block => block.type === 'text' && block.text.trim() !== '')
        const content = [...textBlocks, ...calls]
        await appendEvents(run, owner, [
          { type: 'assistant/message', data: { turn: run.turn, step, message: assistantMessage(run, step, content) } },
          { type: 'step/end', data: { turn: run.turn, step } },
        ])
        const toolMessages = []
        for (const call of calls) {
          await appendEvents(run, owner, [
            { type: 'tool/call', data: { turn: run.turn, step, callId: call.id, name: call.name, arguments: call.arguments } },
          ])
          let result
          try {
            result = await executeTool({
              principalId: run.principalId,
              sessionId: run.sessionId,
              turnId: run.turnId,
              turn: run.turn,
              step,
              callId: call.id,
              name: call.name,
              arguments: call.arguments,
            })
          } catch (error) {
            result = { text: `tool ${call.name} failed: ${typeof error?.message === 'string' ? error.message : String(error)}`, isError: true }
          }
          const resultText = typeof result?.text === 'string' ? result.text : String(result)
          if (resultText.length > MAX_TOOL_RESULT_CHARS) {
            throw new DurableTurnError('DURABLE_TOOL_RESULT_TOO_LARGE', `tool ${call.name} returned more than ${String(MAX_TOOL_RESULT_CHARS)} characters`, 409)
          }
          const toolMessage = {
            id: `durable-tool-${call.id}-${randomUUID()}`,
            role: 'tool',
            source: { kind: 'tool', callId: call.id },
            toolCallId: call.id,
            content: [{ type: 'text', text: resultText }],
            ...(result?.isError === true ? { isError: true } : {}),
          }
          await appendEvents(run, owner, [{ type: 'tool/result', data: { turn: run.turn, step, message: toolMessage } }])
          toolMessages.push({ role: 'tool', tool_call_id: call.id, content: resultText })
        }
        messages.push({
          role: 'assistant',
          content: textBlocks.map(block => block.text).join('') || null,
          tool_calls: calls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        }, ...toolMessages)
        step += 1
        await appendEvents(run, owner, [{ type: 'step/start', data: { turn: run.turn, step } }])
        continue
      }
      if (completion.finishReason !== 'stop' || completion.text.trim() === '') {
        throw new DurableTurnError('DURABLE_EMPTY_RESPONSE', 'the model completed without assistant text')
      }
      const written = await appendEvents(run, owner, [
        {
          type: 'assistant/message',
          data: { turn: run.turn, step, message: assistantMessage(run, step, [{ type: 'text', text: completion.text }]) },
        },
        { type: 'step/end', data: { turn: run.turn, step } },
        { type: 'turn/end', data: { turn: run.turn, reason: { kind: 'completed' } } },
      ])
      run.endSeqs = written.map(event => event.seq)
      run.status = 'completed'
      run.settledAt = Date.now()
      recordSettled(run)
      wakeChannel(run)
      return
    }
    throw new DurableTurnError('DURABLE_STEP_LIMIT', `the durable host allows at most ${String(MAX_DURABLE_STEPS)} model steps per turn`, 409)
  }

  const settleFailure = async (run, owner, error) => {
    await store.exclusive(run.sessionId, async () => {
      const session = store.get(run.sessionId)
      store.assertOwnerToken(session, owner.ownerToken, owner.ownerEpoch)
      if (run.turn === undefined) return
      const step = run.step ?? 1
      const hasStepEnd = session.events.some(event => event.type === 'step/end' && event.data?.turn === run.turn && event.data?.step === step)
      const hasTurnEnd = session.events.some(event => event.type === 'turn/end' && event.data?.turn === run.turn)
      const events = []
      if (!hasStepEnd) events.push({ type: 'step/end', data: { turn: run.turn, step } })
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
      const rows = events.map((event, index) => ({ seq: base + index, ...event }))
      session.events.push(...rows)
      await store.flush(session)
      run.endSeqs = rows.map(event => event.seq)
      run.nextSeq = session.events.length
      for (const event of rows) publish(run, event)
      wakeChannel(run)
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
        for (const event of events) publish(run, event)
        return { ownerToken: claimed.ownerToken, ownerEpoch: claimed.ownerEpoch }
      })
      admission?.mountSession(run.sessionId)
    } catch (error) {
      run.phaseOne.resolve({ error })
      throw error
    }
    run.phaseOne.resolve({ ok: true })
    try {
      await driveTurn(run, prompt, owner)
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
      channelEvents: [],
      channelWaiters: new Set(),
    }
    runs.set(turnId, run)
    void execute(run, prompt, header).catch(error => {
      run.status = 'failed'
      run.error = {
        code: typeof error?.code === 'string' ? error.code : 'DURABLE_TURN_FAILED',
        message: typeof error?.message === 'string' ? error.message : String(error),
      }
      run.settledAt = Date.now()
      recordSettled(run)
      wakeChannel(run)
    })
    const phase = await run.phaseOne.promise
    if (phase.error !== undefined) {
      run.status = 'failed'
      run.error = {
        code: typeof phase.error.code === 'string' ? phase.error.code : 'DURABLE_TURN_FAILED',
        message: typeof phase.error.message === 'string' ? phase.error.message : String(phase.error),
      }
      run.settledAt = Date.now()
      recordSettled(run)
      throw new DurableTurnError(run.error.code, run.error.message, typeof phase.error.status === 'number' ? phase.error.status : 409)
    }
    return runStatus(run)
  }

  /**
   * Summarize durable turn count, latency, and failure classification.
   *
   * The snapshot contains no prompts, tool output, owner tokens, or principal
   * identifiers, so it is safe to export to an operator surface.
   * @returns {object} Versioned gauge and recent-settlement summary.
   */
  const snapshot = () => {
    let running = 0
    let completed = 0
    let failed = 0
    const runningTurns = []
    const now = Date.now()
    for (const run of runs.values()) {
      if (run.status === 'running') {
        running += 1
        runningTurns.push({
          turnId: run.turnId,
          sessionId: run.sessionId,
          startedAt: run.startedAt,
          elapsedMs: now - run.startedAt,
          step: run.step ?? 1,
        })
      } else if (run.status === 'completed') completed += 1
      else failed += 1
    }
    return {
      version: 1,
      total: runs.size,
      running,
      completed,
      failed,
      runningTurns: runningTurns.slice(-16),
      recentSettled: [...settledRuns].reverse().slice(0, 12),
    }
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

  /**
   * Follow a turn's persisted events from a sequence number until it settles.
   *
   * The snapshot is read synchronously with the waiter registration, so an
   * event appended after the snapshot wakes the caller instead of being lost.
   * Attaching never triggers a model request or a tool execution.
   * @param {{turnId: string, principalId: string, fromSeq?: number, signal?: AbortSignal}} query - Turn identity, requesting principal, first sequence, and optional client-abort signal.
   * @returns {{status: () => object, next: () => Promise<object|undefined>}} Snapshot accessor and an iterator that ends after the turn settles.
   */
  const subscribe = ({ turnId, principalId, fromSeq = 0, signal }) => {
    assertBoundedText(turnId, 'turnId', MAX_TURN_ID_LENGTH)
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0 || fromSeq > MAX_ATTACH_SEQ) {
      throw new DurableTurnError('INVALID_REQUEST', 'fromSeq must be an integer between 0 and 1000000')
    }
    const run = runs.get(turnId)
    if (run === undefined || run.principalId !== principalId) {
      throw new DurableTurnError('TURN_NOT_FOUND', 'durable turn does not exist', 404)
    }
    let cursor = fromSeq
    const next = async () => {
      while (true) {
        if (signal?.aborted === true) return undefined
        const event = run.channelEvents.find(candidate => candidate.seq >= cursor)
        if (event !== undefined) {
          cursor = event.seq + 1
          return event
        }
        if (run.status !== 'running') return undefined
        await new Promise(resolve => {
          const done = () => {
            run.channelWaiters.delete(done)
            signal?.removeEventListener('abort', done)
            resolve()
          }
          run.channelWaiters.add(done)
          signal?.addEventListener('abort', done, { once: true })
        })
      }
    }
    return { status: () => runStatus(run), next }
  }

  return { start, status, subscribe, snapshot, version: 1 }
}
