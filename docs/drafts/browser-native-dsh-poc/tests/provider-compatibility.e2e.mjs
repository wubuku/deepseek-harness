/**
 * Verify the Browser-Native LLM proxy against both provider wire protocols.
 *
 * The deterministic section runs local upstream servers that implement the
 * OpenAI Chat Completions and Anthropic Messages streaming contracts. It
 * covers request translation, streamed text, tool calls, usage, HTTP and
 * stream error classification, truncation, empty responses, and client
 * cancellation for both kinds. The real section replays the same route against
 * the configured LongCat (OpenAI-compatible) and MiniMax (Anthropic-compatible)
 * endpoints when DSH_POC_ENV_FILE provides both credential groups.
 *
 * Usage:
 *   node docs/drafts/browser-native-dsh-poc/tests/provider-compatibility.e2e.mjs
 *   DSH_POC_ENV_FILE=docs/drafts/.env node .../provider-compatibility.e2e.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const envFilePath = process.env.DSH_POC_ENV_FILE === undefined ? undefined : resolve(process.env.DSH_POC_ENV_FILE)
const results = []
const temporaryDirectories = []

async function temporaryDirectory(prefix = 'dsh-provider-compat-') {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const { port } = server.address()
  return `http://127.0.0.1:${String(port)}`
}

async function closeServer(server) {
  await new Promise(resolveClose => server.close(resolveClose))
}

async function readRequest(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return { text, json: text.length === 0 ? {} : JSON.parse(text) }
}

async function readNdjson(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const items = []
  let buffer = ''
  while (true) {
    const part = await reader.read()
    buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.length > 0) items.push(JSON.parse(line))
      newline = buffer.indexOf('\n')
    }
    if (part.done) break
  }
  const tail = buffer.trim()
  if (tail.length > 0) items.push(JSON.parse(tail))
  return items
}

function llmBody(messages, tools, extra = {}) {
  return { protocolVersion: 1, requestId: crypto.randomUUID(), messages, tools, ...extra }
}

function chunks(items) {
  return items.filter(item => item.kind === 'chunk').map(item => item.chunk)
}

function textOf(items) {
  return chunks(items).filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
}

function blockEnds(items) {
  return chunks(items).filter(chunk => chunk.type === 'block-end')
}

function terminal(items) {
  return items.at(-1)
}

async function startBackend({ kind, baseUrl, model, path, apiKey, includeUsage }) {
  const dataDir = await temporaryDirectory()
  const envFile = join(dataDir, '.env')
  await writeFile(envFile, ['HTTPS_PROXY=', 'HTTP_PROXY=', ''].join('\n'))
  const app = await createBrowserNativeV2Server({
    dataDir,
    llmMode: 'real',
    llmProviderKind: kind,
    model,
    llmBaseUrl: baseUrl,
    llmCompletionsPath: path,
    llmApiKey: apiKey,
    llmIncludeUsage: includeUsage,
    envFile,
  })
  const origin = await app.listen(0)
  return { origin, app }
}

async function postLlm(origin, body, options = {}) {
  return await fetch(`${origin}/api/browser-native/llm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-browser-native-protocol': '1' },
    body: JSON.stringify(body),
    ...options,
  })
}

/** OpenAI-compatible SSE upstream keyed by the last user prompt. */
async function startOpenAiUpstream() {
  const state = { requests: [], abortedStreams: 0 }
  const server = createServer(async (request, response) => {
    const { json } = await readRequest(request)
    state.requests.push({ headers: request.headers, body: json })
    const prompt = [...(json.messages ?? [])].reverse().find(message => message.role === 'user')?.content ?? ''
    if (prompt.includes('OPENAI_HTTP_ERROR')) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'server_error', message: 'synthetic OpenAI failure' } }))
      return
    }
    if (prompt.includes('OPENAI_EMPTY')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: [DONE]\n\n')
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    response.on('close', () => {
      if (!response.writableEnded) state.abortedStreams += 1
    })
    const write = payload => response.write(`data: ${JSON.stringify(payload)}\n\n`)
    const slow = prompt.includes('OPENAI_SLOW')
    if (prompt.includes('OPENAI_TOOL')) {
      for (const [offset, argumentsDelta] of ['{"value":', '"OPENAI-TOOL-OK"}'].entries()) {
        write({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-openai', function: { name: offset === 0 ? 'echo' : '', arguments: argumentsDelta } }] } }] })
      }
      write({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      if (json.stream_options?.include_usage === true) {
        write({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } })
      }
      response.end('data: [DONE]\n\n')
      return
    }
    const text = 'OPENAI-TEXT-OK'
    for (const reasoningDelta of ['R1', 'R2']) write({ choices: [{ index: 0, delta: { reasoning_content: reasoningDelta } }] })
    for (const character of text) {
      if (response.writableEnded || response.destroyed) return
      write({ choices: [{ index: 0, delta: { content: character } }] })
      await new Promise(resolveDelay => setTimeout(resolveDelay, slow ? 80 : 5))
    }
    write({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    if (json.stream_options?.include_usage === true) {
      write({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })
    }
    response.end('data: [DONE]\n\n')
  })
  const origin = await listen(server)
  return { origin, state, close: async () => await closeServer(server) }
}

/** Anthropic Messages SSE upstream keyed by the last user text block. */
async function startAnthropicUpstream() {
  const state = { requests: [], abortedStreams: 0 }
  const server = createServer(async (request, response) => {
    const { json } = await readRequest(request)
    state.requests.push({ headers: request.headers, body: json })
    const lastUser = [...(json.messages ?? [])].reverse().find(message => message.role === 'user')
    const prompt = (lastUser?.content ?? []).map(block => block.type === 'text' ? block.text : '').join('')
    if (prompt.includes('ANTH_AUTH_ERROR')) {
      response.writeHead(401, { 'content-type': 'application/json', 'retry-after': '1' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'synthetic auth failure' } }))
      return
    }
    if (prompt.includes('ANTH_RATE_LIMIT')) {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'synthetic quota failure' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    response.on('close', () => {
      if (!response.writableEnded) state.abortedStreams += 1
    })
    const event = (name, payload) => response.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
    event('message_start', {
      type: 'message_start',
      message: { id: 'msg-test', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: 0 } },
    })
    event('ping', { type: 'ping' })
    if (prompt.includes('ANTH_EMPTY')) {
      event('message_stop', { type: 'message_stop' })
      response.end()
      return
    }
    if (prompt.includes('ANTH_STREAM_ERROR')) {
      event('error', { type: 'error', error: { type: 'overloaded_error', message: 'synthetic overload' } })
      response.end()
      return
    }
    const slow = prompt.includes('ANTH_SLOW')
    const thinking = prompt.includes('ANTH_THINKING')
    if (thinking) {
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ANTH-REASONING' } })
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'synthetic' } })
      event('content_block_stop', { type: 'content_block_stop', index: 0 })
    }
    const textIndex = thinking ? 1 : 0
    event('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } })
    for (const character of 'ANTH-TEXT-OK') {
      if (response.writableEnded || response.destroyed) return
      event('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: character } })
      await new Promise(resolveDelay => setTimeout(resolveDelay, slow ? 80 : 5))
    }
    event('content_block_stop', { type: 'content_block_stop', index: textIndex })
    const truncated = prompt.includes('ANTH_TRUNCATED')
    if (prompt.includes('ANTH_TOOL')) {
      event('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'call-anthropic', name: 'echo', input: {} },
      })
      for (const partial of ['{"value":', '"ANTH-TOOL-OK"}']) {
        event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: partial } })
      }
      event('content_block_stop', { type: 'content_block_stop', index: 1 })
    }
    if (truncated) {
      response.end()
      return
    }
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: prompt.includes('ANTH_TOOL') ? 'tool_use' : 'end_turn' },
      usage: { input_tokens: 25, output_tokens: 9 },
    })
    event('message_stop', { type: 'message_stop' })
    response.end()
  })
  const origin = await listen(server)
  return { origin, state, close: async () => await closeServer(server) }
}

async function deterministicOpenAi() {
  const upstream = await startOpenAiUpstream()
  const backend = await startBackend({
    kind: 'openai', baseUrl: upstream.origin, model: 'openai-compat-test', path: '/v1/chat/completions', apiKey: 'openai-secret', includeUsage: true,
  })
  try {
    const textResponse = await postLlm(backend.origin, llmBody(
      [{ role: 'system', content: 'SYSTEM CONTRACT' }, { role: 'user', content: 'OPENAI_TEXT' }],
      [],
    ))
    assert.equal(textResponse.status, 200)
    const textItems = await readNdjson(textResponse)
    assert.match(textOf(textItems), /OPENAI-TEXT-OK/)
    assert.equal(terminal(textItems).chunk.reason.kind, 'stop')
    const usage = chunks(textItems).find(chunk => chunk.type === 'usage')
    assert.deepEqual(usage.usage, { inputTokens: 20, outputTokens: 8, totalTokens: 28 })
    const reasoningBlock = blockEnds(textItems).find(block => block.block.type === 'reasoning')
    assert.equal(reasoningBlock.block.text, 'R1R2')
    const request = upstream.state.requests.at(-1)
    assert.equal(request.headers.authorization, 'Bearer openai-secret')
    assert.equal(request.body.messages[0].role, 'system')
    assert.deepEqual(request.body.stream_options, { include_usage: true })

    const toolResponse = await postLlm(backend.origin, llmBody(
      [{ role: 'user', content: 'OPENAI_TOOL' }],
      [{ type: 'function', function: { name: 'echo', description: 'Echo a value', parameters: { type: 'object', properties: { value: { type: 'string' } } } } }],
    ))
    const toolItems = await readNdjson(toolResponse)
    const toolBlock = blockEnds(toolItems).find(block => block.block.type === 'tool-call')
    assert.equal(toolBlock.block.name, 'echo')
    assert.equal(JSON.parse(toolBlock.block.arguments).value, 'OPENAI-TOOL-OK')
    assert.equal(terminal(toolItems).chunk.reason.kind, 'tool-calls')

    const errorResponse = await postLlm(backend.origin, llmBody([{ role: 'user', content: 'OPENAI_HTTP_ERROR' }], []))
    assert.equal(errorResponse.status, 502)
    const errorPayload = await errorResponse.json()
    assert.equal(errorPayload.error.code, 'UPSTREAM_LLM_FAILED')
    assert.equal(errorPayload.error.details.providerStatus, 500)

    const emptyResponse = await postLlm(backend.origin, llmBody([{ role: 'user', content: 'OPENAI_EMPTY' }], []))
    const emptyItems = await readNdjson(emptyResponse)
    assert.equal(terminal(emptyItems).kind, 'error')
    assert.equal(terminal(emptyItems).error.code, 'UPSTREAM_LLM_EMPTY')

    await cancellationProbe({
      backendOrigin: backend.origin,
      prompt: 'OPENAI_SLOW',
      upstream,
      label: 'openai',
      firstDelta: items => chunks(items).find(chunk => chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'),
    })
    results.push({ provider: 'openai', mode: 'deterministic', text: 'OPENAI-TEXT-OK', tool: 'OPENAI-TOOL-OK', usage: '28 tokens', error: 'UPSTREAM_LLM_FAILED', cancel: 'aborted upstream stream' })
  } finally {
    await backend.app.close()
    await upstream.close()
  }
}

async function deterministicAnthropic() {
  const upstream = await startAnthropicUpstream()
  const backend = await startBackend({
    kind: 'anthropic', baseUrl: upstream.origin, model: 'anthropic-compat-test', path: '/v1/messages', apiKey: 'anthropic-secret',
  })
  try {
    const response = await postLlm(backend.origin, llmBody([
      { role: 'system', content: 'SYSTEM A' },
      { role: 'developer', content: 'DEVELOPER B' },
      { role: 'user', content: 'History question' },
      {
        role: 'assistant',
        content: 'Calling echo',
        tool_calls: [{ id: 'history-call', type: 'function', function: { name: 'echo', arguments: '{"value":"history"}' } }],
      },
      { role: 'tool', content: 'history result', tool_call_id: 'history-call' },
      { role: 'user', content: 'ANTH_TEXT' },
    ], [{ type: 'function', function: { name: 'echo', description: 'Echo a value', parameters: { type: 'object', properties: { value: { type: 'string' } } } } }]))
    assert.equal(response.status, 200)
    const items = await readNdjson(response)
    assert.match(textOf(items), /ANTH-TEXT-OK/)
    assert.equal(terminal(items).chunk.reason.kind, 'stop')
    const usage = chunks(items).find(chunk => chunk.type === 'usage')
    assert.deepEqual(usage.usage, { inputTokens: 25, outputTokens: 9, totalTokens: 34 })
    const request = upstream.state.requests.at(-1)
    assert.equal(request.headers['x-api-key'], 'anthropic-secret')
    assert.equal(request.headers['anthropic-version'], '2023-06-01')
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.body.system, 'SYSTEM A\n\nDEVELOPER B')
    assert.equal(request.body.max_tokens, 4096)
    assert.deepEqual(request.body.messages.map(message => message.role), ['user', 'assistant', 'user'])
    assert.deepEqual(request.body.messages[1].content.at(-1), { type: 'tool_use', id: 'history-call', name: 'echo', input: { value: 'history' } })
    assert.deepEqual(request.body.messages[2].content, [
      { type: 'tool_result', tool_use_id: 'history-call', content: 'history result' },
      { type: 'text', text: 'ANTH_TEXT' },
    ])
    assert.deepEqual(request.body.tools[0], {
      name: 'echo', description: 'Echo a value', input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    })

    const thinkingResponse = await postLlm(backend.origin, llmBody([{ role: 'user', content: 'ANTH_THINKING' }], []))
    const thinkingItems = await readNdjson(thinkingResponse)
    const reasoningBlock = blockEnds(thinkingItems).find(block => block.block.type === 'reasoning')
    assert.equal(reasoningBlock.block.text, 'ANTH-REASONING')

    const toolResponse = await postLlm(backend.origin, llmBody([{ role: 'user', content: 'ANTH_TOOL' }], []))
    const toolItems = await readNdjson(toolResponse)
    const toolBlock = blockEnds(toolItems).find(block => block.block.type === 'tool-call')
    assert.equal(toolBlock.index, 1)
    assert.equal(toolBlock.block.name, 'echo')
    assert.equal(JSON.parse(toolBlock.block.arguments).value, 'ANTH-TOOL-OK')
    assert.equal(terminal(toolItems).chunk.reason.kind, 'tool-calls')

    const authResponse = await postLlm(backend.origin, llmBody([{ role: 'user', content: 'ANTH_AUTH_ERROR' }], []))
    assert.equal(authResponse.status, 502)
    const authPayload = await authResponse.json()
    assert.equal(authPayload.error.code, 'UPSTREAM_LLM_AUTH_FAILED')
    assert.equal(authPayload.error.details.providerErrorType, 'authentication_error')

    const quotaResponse = await postLlm(backend.origin, llmBody([{ role: 'user', content: 'ANTH_RATE_LIMIT' }], []))
    assert.equal(quotaResponse.status, 503)
    const quotaPayload = await quotaResponse.json()
    assert.equal(quotaPayload.error.code, 'UPSTREAM_LLM_RATE_LIMITED')
    assert.equal(quotaPayload.error.retryAfterMs, 2_000)
    assert.equal(quotaPayload.error.details.providerStatus, 429)

    const streamErrorResponse = await postLlm(backend.origin, llmBody([{ role: 'user', content: 'ANTH_STREAM_ERROR' }], []))
    const streamErrorItems = await readNdjson(streamErrorResponse)
    assert.equal(terminal(streamErrorItems).kind, 'error')
    assert.equal(terminal(streamErrorItems).error.code, 'UPSTREAM_LLM_UNAVAILABLE')

    const emptyResponse = await postLlm(backend.origin, llmBody([{ role: 'user', content: 'ANTH_EMPTY' }], []))
    const emptyItems = await readNdjson(emptyResponse)
    assert.equal(terminal(emptyItems).kind, 'error')
    assert.equal(terminal(emptyItems).error.code, 'UPSTREAM_LLM_EMPTY')

    const truncatedResponse = await postLlm(backend.origin, llmBody([{ role: 'user', content: 'ANTH_TRUNCATED' }], []))
    const truncatedItems = await readNdjson(truncatedResponse)
    assert.equal(terminal(truncatedItems).kind, 'error')
    assert.equal(terminal(truncatedItems).error.code, 'UPSTREAM_LLM_TRUNCATED')

    await cancellationProbe({
      backendOrigin: backend.origin,
      prompt: 'ANTH_SLOW',
      upstream,
      label: 'anthropic',
      firstDelta: items => chunks(items).find(chunk => chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'),
    })
    results.push({ provider: 'anthropic', mode: 'deterministic', text: 'ANTH-TEXT-OK', tool: 'ANTH-TOOL-OK', usage: '34 tokens', error: 'AUTH/RATE_LIMIT/OVERLOADED/EMPTY/TRUNCATED', cancel: 'aborted upstream stream' })
  } finally {
    await backend.app.close()
    await upstream.close()
  }
}

/**
 * Read the first streamed delta, abort the client request, and prove the
 * backend closed the upstream stream instead of draining it.
 * @param options - Backend origin, upstream state, trigger prompt, and delta selector.
 * @returns Nothing; records the observed abort count.
 */
async function cancellationProbe({ backendOrigin, prompt, upstream, label, firstDelta }) {
  const before = upstream.state.abortedStreams
  const controller = new AbortController()
  const response = await postLlm(backendOrigin, llmBody([{ role: 'user', content: prompt }], []), { signal: controller.signal })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const items = []
  const started = Date.now()
  while (true) {
    const part = await reader.read()
    buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.length > 0) items.push(JSON.parse(line))
      newline = buffer.indexOf('\n')
    }
    if (firstDelta(items) !== undefined) break
    if (part.done) break
  }
  assert.ok(firstDelta(items) !== undefined, `${label} cancellation needs a delta before aborting`)
  controller.abort()
  await reader.cancel().catch(() => undefined)
  const deadline = Date.now() + 2_000
  while (upstream.state.abortedStreams === before && Date.now() < deadline) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  }
  assert.equal(upstream.state.abortedStreams, before + 1, `${label} client abort must close the upstream stream`)
  results.push({ provider: label, mode: 'deterministic-cancel', elapsedMs: Date.now() - started })
}

function envValues(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/)
    if (match !== null) values[match[1]] = match[2].trim()
  }
  return values
}

async function realProvider({ kind, label, model, baseUrl, path, apiKey, includeUsage }) {
  const backend = await startBackend({ kind, baseUrl, model, path, apiKey, includeUsage })
  try {
    const started = Date.now()
    const textResponse = await postLlm(backend.origin, llmBody([
      { role: 'system', content: 'Answer directly and concisely.' },
      { role: 'user', content: `Reply with exactly "REAL-${label}-TEXT-OK" and nothing else.` },
    ], []))
    assert.equal(textResponse.status, 200)
    const textItems = await readNdjson(textResponse)
    assert.match(textOf(textItems), new RegExp(`REAL-${label}-TEXT-OK`))
    const usage = chunks(textItems).find(chunk => chunk.type === 'usage')
    assert.ok(usage !== undefined, `${label} must report usage`)
    assert.ok(usage.usage.inputTokens > 0 && usage.usage.outputTokens > 0, `${label} usage must be positive`)
    const textMs = Date.now() - started

    const toolStarted = Date.now()
    const toolResponse = await postLlm(backend.origin, llmBody([
      { role: 'system', content: 'You must call the echo tool exactly once with the requested value.' },
      { role: 'user', content: `Call the echo tool with value "REAL-${label}-TOOL-OK". Do not reply with text only.` },
    ], [{ type: 'function', function: { name: 'echo', description: 'Echo a value', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } }]))
    assert.equal(toolResponse.status, 200)
    const toolItems = await readNdjson(toolResponse)
    const toolBlock = blockEnds(toolItems).find(block => block.block.type === 'tool-call')
    assert.ok(toolBlock !== undefined, `${label} must emit a tool call; text was ${JSON.stringify(textOf(toolItems))}`)
    assert.equal(toolBlock.block.name, 'echo')
    assert.equal(JSON.parse(toolBlock.block.arguments).value, `REAL-${label}-TOOL-OK`)
    const toolMs = Date.now() - toolStarted

    const cancelStarted = Date.now()
    const controller = new AbortController()
    const cancelResponse = await postLlm(backend.origin, llmBody([
      { role: 'user', content: 'Write a long continuous essay about tea. Do not stop early.' },
    ], [], { maxTokens: 512 }), { signal: controller.signal })
    assert.equal(cancelResponse.status, 200)
    const reader = cancelResponse.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawDelta = false
    while (!sawDelta) {
      const part = await reader.read()
      buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('{')) {
          const chunkType = JSON.parse(line).chunk?.type
          sawDelta = chunkType === 'text-delta' || chunkType === 'reasoning-delta'
        }
        newline = buffer.indexOf('\n')
      }
      if (part.done) break
    }
    assert.equal(sawDelta, true, `${label} cancellation needs a streamed delta`)
    controller.abort()
    await reader.cancel().catch(() => undefined)
    const cancelMs = Date.now() - cancelStarted
    assert.ok(cancelMs < 5_000, `${label} cancellation took ${cancelMs}ms`)

    results.push({
      provider: label,
      mode: 'real',
      text: textOf(textItems),
      textMs,
      tool: JSON.parse(toolBlock.block.arguments).value,
      toolMs,
      usage: usage.usage,
      cancelMs,
    })
  } finally {
    await backend.app.close()
  }
}

try {
  await deterministicOpenAi()
  await deterministicAnthropic()
  if (envFilePath === undefined) {
    results.push({ mode: 'real', result: 'skipped', reason: 'DSH_POC_ENV_FILE is required for real provider smoke' })
  } else {
    const values = envValues(await readFile(envFilePath, 'utf8'))
    for (const name of ['OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY']) {
      if (typeof values[name] !== 'string' || values[name].length === 0) {
        throw new Error(`${name} is required for the real dual-provider smoke`)
      }
    }
    await realProvider({
      kind: 'openai',
      label: 'longcat',
      model: values.OPENAI_MODEL,
      baseUrl: values.OPENAI_BASE_URL,
      path: 'v1/chat/completions',
      apiKey: values.OPENAI_API_KEY,
      includeUsage: true,
    })
    await realProvider({
      kind: 'anthropic',
      label: 'minimax',
      model: values.ANTHROPIC_MODEL,
      baseUrl: values.ANTHROPIC_BASE_URL,
      path: 'v1/messages',
      apiKey: values.ANTHROPIC_API_KEY,
    })
  }
  for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true })
}
