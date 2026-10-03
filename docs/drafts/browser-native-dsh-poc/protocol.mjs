/** Shared browser-native PoC protocol helpers. */

export const PROTOCOL_VERSION = 1
export const MAX_BODY_BYTES = 1024 * 1024
export const MAX_EVENT_BATCH = 256
export const MAX_DURABLE_EVENTS = 1_000_000
export const MAX_TEXT_BYTES = 64 * 1024
export const MAX_LLM_MESSAGES = 256
export const MAX_LLM_STREAM_ITEMS = 10_000
export const MAX_LLM_STREAM_BYTES = 8 * 1024 * 1024
export const MAX_RESPONSE_LINE_BYTES = 1024 * 1024
export const MAX_JSON_DEPTH = 64
export const OWNER_LEASE_MS = 15_000

export class PocError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] @param {{ cause?: unknown }} [options] */
  constructor(code, message, status = 400, options = {}) {
    super(message)
    this.name = 'PocError'
    this.code = code
    this.status = status
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** @param {unknown} value @param {string} name */
export function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new PocError('INVALID_REQUEST', `${name} must be a non-empty string`)
  }
  if (/[\u0000\u007f]/.test(value)) {
    throw new PocError('INVALID_REQUEST', `${name} contains a forbidden control character`)
  }
  return value
}

/** @param {unknown} value @param {string} name */
export function safeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PocError('INVALID_REQUEST', `${name} must be a non-negative safe integer`)
  }
  return value
}

/** @param {unknown} body @param {boolean} [requireRequestId] */
export function assertEnvelope(body, requireRequestId = true) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new PocError('INVALID_REQUEST', 'request must be a JSON object')
  }
  if (body.protocolVersion !== PROTOCOL_VERSION) {
    throw new PocError('PROTOCOL_UNSUPPORTED', 'unsupported browser-native PoC protocol version')
  }
  if (requireRequestId) nonEmptyString(body.requestId, 'requestId')
  assertJsonSafe(body)
  return body
}

/** @param {unknown} value */
export function assertJsonSafe(value) {
  const pending = [{ value, depth: 0 }]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current.depth > MAX_JSON_DEPTH) throw new PocError('INVALID_REQUEST', 'JSON nesting exceeds the PoC limit')
    if (typeof current.value === 'number' && !Number.isFinite(current.value)) {
      throw new PocError('INVALID_REQUEST', 'JSON numbers must be finite')
    }
    if (current.value === null || typeof current.value !== 'object') continue
    const values = Array.isArray(current.value) ? current.value : Object.values(current.value)
    for (const child of values) pending.push({ value: child, depth: current.depth + 1 })
  }
}

/** @param {string} input */
export function assertNoDuplicateJsonKeys(input) {
  let index = 0
  const whitespace = () => { while (/\s/.test(input[index] ?? '')) index += 1 }
  const stringEnd = () => {
    const start = index
    index += 1
    while (index < input.length) {
      if (input[index] === '\\') { index += 2; continue }
      if (input[index] === '"') { index += 1; return JSON.parse(input.slice(start, index)) }
      index += 1
    }
    throw new PocError('INVALID_REQUEST', 'request body is not valid JSON')
  }
  const value = (depth) => {
    if (depth > MAX_JSON_DEPTH) throw new PocError('INVALID_REQUEST', 'JSON nesting exceeds the PoC limit')
    whitespace()
    if (input[index] === '"') { stringEnd(); return }
    if (input[index] === '{') {
      index += 1
      whitespace()
      const keys = new Set()
      if (input[index] === '}') { index += 1; return }
      for (;;) {
        whitespace()
        if (input[index] !== '"') throw new PocError('INVALID_REQUEST', 'request body is not valid JSON')
        const key = stringEnd()
        if (keys.has(key)) throw new PocError('INVALID_REQUEST', 'request body contains a duplicate object key')
        keys.add(key)
        whitespace()
        index += 1
        value(depth + 1)
        whitespace()
        if (input[index] === '}') { index += 1; return }
        index += 1
      }
    }
    if (input[index] === '[') {
      index += 1
      whitespace()
      if (input[index] === ']') { index += 1; return }
      for (;;) {
        value(depth + 1)
        whitespace()
        if (input[index] === ']') { index += 1; return }
        index += 1
      }
    }
    while (index < input.length && !/[\s,}\]]/.test(input[index])) index += 1
  }
  value(0)
}

/** @param {unknown} value @param {readonly string[]} allowed @param {string} [name] */
export function assertAllowedKeys(value, allowed, name = 'request') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PocError('INVALID_REQUEST', `${name} must be a JSON object`)
  }
  const keys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new PocError('INVALID_REQUEST', `${name}.${key} is not supported by this PoC`)
  }
  return value
}

/** @param {string} value */
export function assertSessionId(value) {
  nonEmptyString(value, 'sessionId')
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new PocError('INVALID_REQUEST', 'sessionId contains unsupported characters')
  }
  return value
}

/** @param {unknown} value @param {string} sessionId */
export function assertHeader(value, sessionId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PocError('INVALID_REQUEST', 'header must be a JSON object')
  }
  if (value.sessionId !== undefined && value.sessionId !== sessionId) {
    throw new PocError('INVALID_REQUEST', 'header.sessionId must match sessionId')
  }
  return value
}

/** @param {unknown} value */
export function assertMessages(value) {
  if (!Array.isArray(value) || value.length > MAX_LLM_MESSAGES) {
    throw new PocError('INVALID_REQUEST', 'messages must be a bounded array')
  }
  return value.map((message, index) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      throw new PocError('INVALID_REQUEST', `messages[${index}] must be an object`)
    }
    assertAllowedKeys(message, message.role === 'assistant' ? ['role', 'content', 'toolCall'] : ['role', 'content'], `messages[${index}]`)
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') {
      throw new PocError('INVALID_REQUEST', `messages[${index}].role is not supported`)
    }
    if (typeof message.content !== 'string' || new TextEncoder().encode(message.content).byteLength > MAX_TEXT_BYTES) {
      throw new PocError('INVALID_REQUEST', `messages[${index}].content must be bounded text`)
    }
    if (message.toolCall !== undefined) {
      if (message.role !== 'assistant') throw new PocError('INVALID_REQUEST', `messages[${index}].toolCall requires assistant role`)
      assertAllowedKeys(message.toolCall, ['callId', 'name', 'args'], `messages[${index}].toolCall`)
      nonEmptyString(message.toolCall.callId, `messages[${index}].toolCall.callId`)
      if (message.toolCall.name !== 'browser_echo') throw new PocError('INVALID_REQUEST', `messages[${index}].toolCall.name is not supported`)
      assertAllowedKeys(message.toolCall.args, ['text'], `messages[${index}].toolCall.args`)
      if (typeof message.toolCall.args.text !== 'string' || new TextEncoder().encode(message.toolCall.args.text).byteLength > MAX_TEXT_BYTES) {
        throw new PocError('INVALID_REQUEST', `messages[${index}].toolCall.args.text must be bounded text`)
      }
    }
    return message
  })
}

/** @param {unknown} value */
export function assertEvents(value) {
  if (!Array.isArray(value) || value.length > MAX_EVENT_BATCH) {
    throw new PocError('INVALID_REQUEST', 'events must be a bounded array')
  }
  return value.map((event, index) => assertEvent(event, index))
}

/** @param {unknown} event @param {number} index */
function assertEvent(event, index) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new PocError('INVALID_REQUEST', `events[${index}] must be an object`)
    }
    assertAllowedKeys(event, ['seq', 'type', 'payload', 'at'], `events[${index}]`)
    safeInteger(event.seq, `events[${index}].seq`)
    nonEmptyString(event.type, `events[${index}].type`)
    if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      throw new PocError('INVALID_REQUEST', `events[${index}].payload must be an object`)
    }
    if (event.at !== undefined && typeof event.at !== 'string') {
      throw new PocError('INVALID_REQUEST', `events[${index}].at must be text`)
    }
    return event
}

/** @param {unknown} value */
export function assertDurableEvents(value) {
  if (!Array.isArray(value) || value.length > MAX_DURABLE_EVENTS) {
    throw new PocError('INVALID_REQUEST', 'durable events must be a bounded array')
  }
  const events = value.map((event, index) => assertEvent(event, index))
  events.forEach((event, index) => {
    if (event.seq !== index) throw new PocError('INVALID_REQUEST', 'durable events must have contiguous sequence numbers')
  })
  return events
}

/** @param {unknown} value */
export function assertOwner(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PocError('INVALID_REQUEST', 'owner is required')
  }
  nonEmptyString(value.ownerToken, 'ownerToken')
  safeInteger(value.generation, 'generation')
  return value
}

/** @param {unknown} value */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** @param {Response} response */
export async function readJsonResponse(response) {
  const body = await response.json()
  if (!response.ok) {
    throw new PocError(body?.error?.code ?? 'INTERNAL', body?.error?.message ?? `HTTP ${response.status}`, response.status)
  }
  return body
}

/** @param {string} type @param {object} payload */
export function makeEvent(type, payload) {
  return { seq: -1, type, payload, at: new Date().toISOString() }
}

/** @param {unknown} value */
export function assertToolText(value) {
  nonEmptyString(value, 'tool text')
  if (new TextEncoder().encode(value).byteLength > MAX_TEXT_BYTES) {
    throw new PocError('REQUEST_TOO_LARGE', 'tool text exceeds the PoC limit')
  }
  return value
}
