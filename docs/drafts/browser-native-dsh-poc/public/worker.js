/**
 * Browser-native PoC Worker.
 *
 * This is the directory-local Agent-loop adapter described in progress.md. It
 * deliberately mirrors the DSH lifecycle facts that the backend persists, but
 * it does not import or reimplement the production DSH AgentLoop class.
 */

const PROTOCOL_VERSION = 1
const OWNER_RENEW_MARGIN_MS = 4_000
const MAX_LLM_STREAM_ITEMS = 10_000
const MAX_LLM_STREAM_BYTES = 8 * 1024 * 1024
const MAX_RESPONSE_LINE_BYTES = 1024 * 1024
const MAX_TEXT_BYTES = 64 * 1024
const TOOL_TIMEOUT_MS = 10_000

let active = false
let sessionId
let owner
let events = []
let renewTimer
let pendingTool

function stopActivity(error = new Error('worker stopped')) {
  active = false
  clearInterval(renewTimer)
  clearTimeout(renewTimer)
  renewTimer = undefined
  if (pendingTool !== undefined) {
    const pending = pendingTool
    pendingTool = undefined
    pending.reject(error)
  }
}

function requestId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`
}

function hasDuplicateJsonKeys(input) {
  let index = 0
  const whitespace = () => { while (/\s/.test(input[index] ?? '')) index += 1 }
  const stringEnd = () => {
    index += 1
    while (index < input.length) {
      if (input[index] === '\\') { index += 2; continue }
      if (input[index] === '"') { index += 1; return }
      index += 1
    }
    throw new Error('invalid JSON string')
  }
  const value = () => {
    whitespace()
    if (input[index] === '"') { stringEnd(); return }
    if (input[index] === '{') {
      index += 1
      whitespace()
      const keys = new Set()
      if (input[index] === '}') { index += 1; return }
      for (;;) {
        whitespace()
        if (input[index] !== '"') throw new Error('invalid JSON object')
        const keyStart = index
        stringEnd()
        const key = JSON.parse(input.slice(keyStart, index))
        if (keys.has(key)) throw new Error('duplicate JSON object key')
        keys.add(key)
        whitespace()
        if (input[index] !== ':') throw new Error('invalid JSON object')
        index += 1
        value()
        whitespace()
        if (input[index] === '}') { index += 1; return }
        if (input[index] !== ',') throw new Error('invalid JSON object')
        index += 1
      }
    }
    if (input[index] === '[') {
      index += 1
      whitespace()
      if (input[index] === ']') { index += 1; return }
      for (;;) {
        value()
        whitespace()
        if (input[index] === ']') { index += 1; return }
        if (input[index] !== ',') throw new Error('invalid JSON array')
        index += 1
      }
    }
    while (index < input.length && !/[\s,}\]]/.test(input[index])) index += 1
  }
  value()
  whitespace()
  return index !== input.length
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function makeEvent(type, payload) {
  return { seq: events.length, type, payload, at: new Date().toISOString() }
}

async function readError(response) {
  let body
  try { body = await response.json() } catch { body = undefined }
  const error = new Error(body?.error?.message ?? `HTTP ${response.status}`)
  error.code = body?.error?.code ?? 'INTERNAL'
  error.status = response.status
  return error
}

async function call(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...body }),
  })
  if (!response.ok) throw await readError(response)
  return response.json()
}

async function openOrCreate(id) {
  try {
    return await call('/api/browser-native/session/open', {
      requestId: requestId('open'), sessionId: id, access: 'write',
    })
  } catch (error) {
    if (error.code !== 'SESSION_NOT_FOUND') throw error
    return await call('/api/browser-native/session/create', {
      requestId: requestId('create'), sessionId: id,
      header: { sessionId: id, version: 1, cwd: '/workspace', createdAt: new Date().toISOString() },
      inheritedEventCount: 0,
    })
  }
}

async function loadEvents() {
  const result = await call('/api/browser-native/session/read', {
    requestId: requestId('read'), sessionId, offset: 0,
  })
  events = result.events
  postMessage({ type: 'events', events, durableThroughSeq: result.durableThroughSeq })
}

async function appendAndFlush(type, payload) {
  const event = makeEvent(type, payload)
  await call('/api/browser-native/session/append', {
    requestId: requestId('append'), sessionId,
    ownerToken: owner.ownerToken, generation: owner.generation,
    expectedNextSeq: events.length, events: [event],
  })
  events.push(event)
  postMessage({ type: 'event', event })
  const flush = await call('/api/browser-native/session/flush', {
    requestId: requestId('flush'), sessionId,
    ownerToken: owner.ownerToken, generation: owner.generation,
  })
  postMessage({ type: 'durable', durableThroughSeq: flush.durableThroughSeq, durabilityReceipt: flush.durabilityReceipt })
}

function messagesFromEvents() {
  return events.flatMap(event => {
    if (event.type === 'user.message') return [{ role: 'user', content: event.payload.content }]
    if (event.type === 'assistant.tool-call') {
      return [{
        role: 'assistant',
        content: '',
        toolCall: { callId: event.payload.callId, name: event.payload.name, args: event.payload.args },
      }]
    }
    if (event.type === 'tool.result') return [{ role: 'tool', content: JSON.stringify(event.payload.result) }]
    if (event.type === 'assistant.final') return [{ role: 'assistant', content: event.payload.content }]
    return []
  })
}

async function streamLlm() {
  const response = await fetch('/api/browser-native/llm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId('llm'),
      sessionId,
      ownerToken: owner.ownerToken,
      generation: owner.generation,
      model: 'poc-scripted',
      messages: messagesFromEvents(),
    }),
  })
  if (!response.ok) throw await readError(response)
  if (response.body === null) throw new Error('LLM response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const items = []
  let terminalSeen = false
  let streamBytes = 0
  const accountStreamBytes = bytes => {
    streamBytes += bytes
    if (streamBytes > MAX_LLM_STREAM_BYTES) {
      throw Object.assign(new Error('LLM stream exceeds the PoC byte limit'), { code: 'REQUEST_TOO_LARGE' })
    }
  }
  const parseItem = line => {
    if (new TextEncoder().encode(line).byteLength > MAX_RESPONSE_LINE_BYTES) {
      throw Object.assign(new Error('LLM stream line exceeds the PoC limit'), { code: 'REQUEST_TOO_LARGE' })
    }
    let item
    try { item = JSON.parse(line) } catch { throw Object.assign(new Error('LLM stream item is not valid JSON'), { code: 'INVALID_REQUEST' }) }
    try {
      if (hasDuplicateJsonKeys(line)) throw new Error('invalid JSON')
    } catch {
      throw Object.assign(new Error('LLM stream item contains invalid or duplicate JSON keys'), { code: 'INVALID_REQUEST' })
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item) || item.protocolVersion !== PROTOCOL_VERSION) {
      throw Object.assign(new Error('LLM stream item has an unsupported protocol version'), { code: 'PROTOCOL_UNSUPPORTED' })
    }
    if (item.kind === 'chunk') {
      if (!hasExactKeys(item, ['protocolVersion', 'kind', 'chunk'])) {
        throw Object.assign(new Error('LLM chunk envelope has unsupported fields'), { code: 'INVALID_REQUEST' })
      }
      if (item.chunk?.type === 'text') {
        if (!hasExactKeys(item.chunk, ['type', 'text']) || typeof item.chunk.text !== 'string'
          || new TextEncoder().encode(item.chunk.text).byteLength > MAX_TEXT_BYTES) {
          throw Object.assign(new Error('LLM text chunk is invalid'), { code: 'INVALID_REQUEST' })
        }
      } else if (item.chunk?.type === 'tool-call') {
        const call = item.chunk
        if (!hasExactKeys(call, ['type', 'callId', 'name', 'args'])
          || typeof call.callId !== 'string' || call.callId.length === 0 || call.callId.length > 512
          || call.name !== 'browser_echo' || !hasExactKeys(call.args, ['text'])
          || typeof call.args.text !== 'string' || call.args.text.length === 0
          || new TextEncoder().encode(call.args.text).byteLength > MAX_TEXT_BYTES) {
          throw Object.assign(new Error('LLM tool-call chunk is invalid'), { code: 'INVALID_REQUEST' })
        }
      } else {
        throw Object.assign(new Error('LLM chunk type is not supported'), { code: 'INVALID_REQUEST' })
      }
    } else if (item.kind === 'error') {
      if (!hasExactKeys(item, ['protocolVersion', 'kind', 'error'])
        || !hasExactKeys(item.error, ['code', 'message'])
        || typeof item.error.code !== 'string' || item.error.code.length === 0 || item.error.code.length > 512
        || typeof item.error.message !== 'string'
        || new TextEncoder().encode(item.error.message).byteLength > MAX_TEXT_BYTES) {
        throw Object.assign(new Error('LLM error item is invalid'), { code: 'INVALID_REQUEST' })
      }
      throw Object.assign(new Error(item.error.message), { code: item.error.code })
    } else if (item.kind === 'end') {
      if (!hasExactKeys(item, ['protocolVersion', 'kind', 'finish']) || typeof item.finish !== 'string' || terminalSeen) {
        throw Object.assign(new Error('LLM stream has an invalid terminal item'), { code: 'INVALID_REQUEST' })
      }
      terminalSeen = true
    } else {
      throw Object.assign(new Error('LLM stream item kind is not supported'), { code: 'INVALID_REQUEST' })
    }
    if (terminalSeen && item.kind !== 'end') throw Object.assign(new Error('LLM stream contains data after terminal item'), { code: 'INVALID_REQUEST' })
    items.push(item)
  }
  for (;;) {
    const next = await reader.read()
    buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done })
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const rawLine = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const rawLineBytes = new TextEncoder().encode(rawLine).byteLength
      if (rawLineBytes > MAX_RESPONSE_LINE_BYTES) {
        throw Object.assign(new Error('LLM stream line exceeds the PoC limit'), { code: 'REQUEST_TOO_LARGE' })
      }
      accountStreamBytes(rawLineBytes + 1)
      const line = rawLine.trim()
      if (line.length > 0) {
        if (items.length >= MAX_LLM_STREAM_ITEMS) throw Object.assign(new Error('LLM stream exceeds the PoC item limit'), { code: 'STREAM_LIMIT' })
        parseItem(line)
      }
    }
    if (new TextEncoder().encode(buffer).byteLength > MAX_RESPONSE_LINE_BYTES) {
      throw Object.assign(new Error('LLM stream partial line exceeds the PoC limit'), { code: 'REQUEST_TOO_LARGE' })
    }
    if (next.done) break
  }
  if (buffer.trim().length > 0) {
    accountStreamBytes(new TextEncoder().encode(buffer).byteLength)
    if (items.length >= MAX_LLM_STREAM_ITEMS) throw Object.assign(new Error('LLM stream exceeds the PoC item limit'), { code: 'STREAM_LIMIT' })
    parseItem(buffer.trim())
  } else if (buffer.length > 0) {
    accountStreamBytes(new TextEncoder().encode(buffer).byteLength)
  }
  if (!terminalSeen) throw Object.assign(new Error('LLM stream ended without a terminal item'), { code: 'INVALID_REQUEST' })
  return items
}

function waitForTool(call) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingTool?.callId !== call.callId) return
      pendingTool = undefined
      reject(Object.assign(new Error('browser Tool did not return before the PoC timeout'), { code: 'TOOL_TIMEOUT' }))
    }, TOOL_TIMEOUT_MS)
    pendingTool = {
      callId: call.callId,
      resolve: value => { clearTimeout(timeout); resolve(value) },
      reject: error => { clearTimeout(timeout); reject(error) },
    }
    postMessage({
      type: 'tool-call',
      protocolVersion: PROTOCOL_VERSION,
      kind: 'browser-tool-call',
      call: { callId: call.callId, name: call.name, args: call.args },
    })
  })
}

async function renewOwner() {
  if (!active || owner === undefined) return
  try {
    owner = (await call('/api/browser-native/session/renew', {
      requestId: requestId('renew'), sessionId,
      ownerToken: owner.ownerToken, generation: owner.generation,
    })).owner
    postMessage({ type: 'owner', owner })
  } catch (error) {
    postMessage({ type: 'error', code: error.code ?? 'SESSION_OWNERSHIP_LOST', message: error.message })
    stopActivity(error)
  }
}

function startRenewal() {
  clearInterval(renewTimer)
  renewTimer = setInterval(() => {
    if (owner === undefined) return
    const delay = Math.max(1000, owner.expiresAt - Date.now() - OWNER_RENEW_MARGIN_MS)
    clearInterval(renewTimer)
    renewTimer = setTimeout(async () => {
      await renewOwner()
      if (active) startRenewal()
    }, delay)
  }, 1000)
}

async function runLoop(prompt) {
  const final = events.find(event => event.type === 'assistant.final')
  if (final !== undefined) {
    postMessage({ type: 'resumed', sessionId, final: final.payload.content, events })
    return
  }
  const lastToolCall = events.findLast(event => event.type === 'assistant.tool-call')

  const appendFinalResponse = async () => {
    postMessage({ type: 'status', value: 'model-request-2' })
    const second = await streamLlm()
    const text = second.filter(item => item.kind === 'chunk' && item.chunk?.type === 'text')
      .map(item => item.chunk.text).join('')
    if (text.length === 0) throw new Error('scripted model did not return final text')
    await appendAndFlush('assistant.final', { content: text })
    postMessage({ type: 'final', sessionId, content: text, events })
  }

  if (lastToolCall !== undefined) {
    const toolCompleted = events.some(event => event.type === 'tool.result' && event.payload.callId === lastToolCall.payload.callId)
    if (!toolCompleted) {
      const error = new Error('the last browser Tool call has no durable result; refusing to replay an unknown side effect')
      error.code = 'REQUEST_OUTCOME_UNKNOWN'
      throw error
    }
    await appendFinalResponse()
    return
  }

  if (!events.some(event => event.type === 'user.message')) await appendAndFlush('user.message', { content: prompt })
  postMessage({ type: 'status', value: 'model-request-1' })
  const first = await streamLlm()
  const toolItem = first.find(item => item.kind === 'chunk' && item.chunk?.type === 'tool-call')
  if (toolItem === undefined) throw new Error('scripted model did not return the expected tool call')
  await appendAndFlush('assistant.tool-call', toolItem.chunk)
  const result = await waitForTool(toolItem.chunk)
  await appendAndFlush('tool.result', { callId: result.callId, name: toolItem.chunk.name, result: result.result })
  await appendFinalResponse()
}

async function start(message) {
  active = true
  try {
    sessionId = message.sessionId
    postMessage({ type: 'status', value: 'opening-session', sessionId })
    const opened = await openOrCreate(sessionId)
    owner = opened.owner
    postMessage({ type: 'owner', owner })
    startRenewal()
    await loadEvents()
    await runLoop(message.prompt)
  } catch (error) {
    stopActivity(error)
    postMessage({ type: 'error', code: error.code ?? 'INTERNAL', message: error.message })
  }
}

self.onmessage = event => {
  const message = event.data
  if (message?.type === 'start') {
    void start(message).catch(error => postMessage({ type: 'error', code: error.code ?? 'INTERNAL', message: error.message }))
    return
  }
  if (message?.type === 'tool-result') {
    if (!hasExactKeys(message, ['type', 'protocolVersion', 'kind', 'callId', 'ok', 'result'])
      && !hasExactKeys(message, ['type', 'protocolVersion', 'kind', 'callId', 'ok', 'error'])) return
    if (message.protocolVersion !== PROTOCOL_VERSION || message.kind !== 'browser-tool-result'
      || typeof message.callId !== 'string' || message.callId.length === 0 || message.callId.length > 512) return
    if (pendingTool === undefined || pendingTool.callId !== message.callId) return
    if (message.ok !== true && message.ok !== false) return
    if (message.ok) {
      if (!hasExactKeys(message, ['type', 'protocolVersion', 'kind', 'callId', 'ok', 'result'])
        || !hasExactKeys(message.result, ['text', 'length'])
        || typeof message.result.text !== 'string'
        || new TextEncoder().encode(message.result.text).byteLength > MAX_TEXT_BYTES
        || !Number.isSafeInteger(message.result.length)
        || message.result.length !== message.result.text.length) return
      const pending = pendingTool
      pendingTool = undefined
      pending.resolve(message)
    } else {
      if (!hasExactKeys(message, ['type', 'protocolVersion', 'kind', 'callId', 'ok', 'error'])
        || !hasExactKeys(message.error, ['code', 'message'])
        || typeof message.error.code !== 'string' || message.error.code.length === 0 || message.error.code.length > 512
        || typeof message.error.message !== 'string' || new TextEncoder().encode(message.error.message).byteLength > MAX_TEXT_BYTES) return
      const pending = pendingTool
      pendingTool = undefined
      pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
    }
    return
  }
  if (message?.type === 'stop') {
    stopActivity()
    return
  }
  if (message?.type === 'close') {
    void (async () => {
      try {
        if (owner !== undefined) {
          await call('/api/browser-native/session/close', {
            requestId: requestId('close'), sessionId,
            ownerToken: owner.ownerToken, generation: owner.generation,
          })
        }
        stopActivity()
        postMessage({ type: 'closed', sessionId })
        self.close()
      } catch (error) {
        stopActivity(error)
        postMessage({ type: 'error', code: error.code ?? 'INTERNAL', message: error.message })
      }
    })()
  }
}

postMessage({ type: 'ready' })
