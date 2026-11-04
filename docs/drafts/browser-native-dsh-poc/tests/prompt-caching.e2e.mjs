/**
 * Verify Anthropic-protocol prompt-cache reporting and the cost effect of an
 * explicit `cache_control` marker.
 *
 * The deterministic section runs a local Anthropic Messages upstream and
 * asserts three behaviours of the PoC LLM proxy: `promptCaching: true` adds
 * exactly one `cache_control` block after the system prompt, the flag is absent
 * by default, and `cache_read_input_tokens` / `cache_creation_input_tokens`
 * reach the usage chunk and audit fields.
 *
 * The real section sends identical-prefix requests to the configured
 * Anthropic-compatible endpoint twice: three with `promptCaching: true` and
 * three with it disabled. It reports per-request cache creation, cache read,
 * uncached input, hit ratio and a cost scenario, then classifies whether the
 * explicit marker changed billing on this endpoint. An unsupported endpoint is
 * a measured outcome, not a test failure; inconsistent token totals or failed
 * requests do fail.
 *
 * Usage:
 *   node docs/drafts/browser-native-dsh-poc/tests/prompt-caching.e2e.mjs
 *   DSH_POC_ENV_FILE=docs/drafts/.env node docs/drafts/browser-native-dsh-poc/tests/prompt-caching.e2e.mjs
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const envFilePath = process.env.DSH_POC_ENV_FILE === undefined ? undefined : resolve(process.env.DSH_POC_ENV_FILE)
const results = []
const temporaryDirectories = []

async function temporaryDirectory(prefix = 'dsh-prompt-caching-') {
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
    body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), ...body }),
    ...options,
  })
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

function chunks(items) {
  return items.filter(item => item.kind === 'chunk').map(item => item.chunk)
}

function textOf(items) {
  return chunks(items).filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
}

function usageOf(items) {
  return chunks(items).find(chunk => chunk.type === 'usage')?.usage
}

function promptTokensOf(usage) {
  return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** Anthropic's published cache multipliers relative to the base input price. */
function inputCostUnits(usage, { cacheRead = 0.1, cacheWrite = 1.25 } = {}) {
  return (usage.inputTokens ?? 0) + cacheWrite * (usage.cacheWriteTokens ?? 0) + cacheRead * (usage.cacheReadTokens ?? 0)
}

/** Local Anthropic Messages SSE that reports cache counters in both usage events. */
async function startAnthropicUpstream() {
  const state = { requests: [] }
  const server = createServer(async (request, response) => {
    const { json } = await readRequest(request)
    state.requests.push({ body: json })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    const event = (name, payload) => response.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
    event('message_start', {
      type: 'message_start',
      message: {
        id: 'msg-cache', type: 'message', role: 'assistant', content: [],
        usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 7, cache_read_input_tokens: 11 },
      },
    })
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'CACHE-TEXT-OK' } })
    event('content_block_stop', { type: 'content_block_stop', index: 0 })
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 12, output_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 11 },
    })
    event('message_stop', { type: 'message_stop' })
    response.end()
  })
  const origin = await listen(server)
  return { origin, state, close: async () => await closeServer(server) }
}

async function deterministicTranslation() {
  const upstream = await startAnthropicUpstream()
  const backend = await startBackend({
    kind: 'anthropic', baseUrl: upstream.origin, model: 'anthropic-cache-test', path: '/v1/messages', apiKey: 'anthropic-secret',
  })
  try {
    const cachedResponse = await postLlm(backend.origin, {
      messages: [{ role: 'system', content: 'STABLE SYSTEM PREFIX' }, { role: 'user', content: 'CACHE_ON' }],
      tools: [],
      promptCaching: true,
    })
    assert.equal(cachedResponse.status, 200)
    const cachedItems = await readNdjson(cachedResponse)
    assert.match(textOf(cachedItems), /CACHE-TEXT-OK/)
    const cachedUsage = usageOf(cachedItems)
    assert.deepEqual(cachedUsage, { inputTokens: 12, outputTokens: 5, totalTokens: 35, cacheReadTokens: 11, cacheWriteTokens: 7 })
    const cachedRequest = upstream.state.requests.at(-1).body
    assert.deepEqual(cachedRequest.system, [{ type: 'text', text: 'STABLE SYSTEM PREFIX', cache_control: { type: 'ephemeral' } }])
    assert.equal(cachedRequest.messages.length, 1)

    const plainResponse = await postLlm(backend.origin, {
      messages: [{ role: 'system', content: 'STABLE SYSTEM PREFIX' }, { role: 'user', content: 'CACHE_OFF' }],
      tools: [],
    })
    assert.equal(plainResponse.status, 200)
    const plainItems = await readNdjson(plainResponse)
    const plainRequest = upstream.state.requests.at(-1).body
    assert.equal(plainRequest.system, 'STABLE SYSTEM PREFIX')
    const plainUsage = usageOf(plainItems)
    assert.equal(plainUsage.cacheReadTokens, 11, 'usage parsing is independent of the request marker')

    results.push({
      section: 'deterministic',
      result: 'passed',
      requestMarker: cachedRequest.system,
      usage: cachedUsage,
    })
  } finally {
    await backend.app.close()
    await upstream.close()
  }
}

function envValues(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/)
    if (match !== null) values[match[1]] = match[2].trim()
  }
  return values
}

/**
 * Build a unique, non-repeating prefix so provider-side reuse of boilerplate
 * text cannot masquerade as `cache_control` effectiveness. Random words keep
 * the token count attributable to this request.
 */
function novelPrefix(stamp, label, words) {
  const parts = [`prompt-cache ${stamp} ${label}`]
  for (let index = 0; index < words; index += 1) parts.push(randomBytes(3).toString('hex'))
  return parts.join(' ')
}

async function measuredRequests(origin, { promptCaching, stamp, label }) {
  const prefix = novelPrefix(stamp, label, 1500)
  const tools = [{
    type: 'function',
    function: {
      name: 'echo',
      description: 'Echo a value. Do not call this tool.',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    },
  }]
  const turns = []
  for (let turn = 1; turn <= 3; turn += 1) {
    const started = Date.now()
    const response = await postLlm(origin, {
      messages: [{ role: 'system', content: prefix }, { role: 'user', content: `Reply with exactly CACHE-${label}-OK and do not call a tool.` }],
      tools,
      maxTokens: 16,
      promptCaching,
    })
    assert.equal(response.status, 200, `${label} turn ${String(turn)} must return 200`)
    const items = await readNdjson(response)
    assert.match(textOf(items), new RegExp(`CACHE-${label}-OK`))
    const usage = usageOf(items)
    assert.ok(usage !== undefined, `${label} turn ${String(turn)} must report usage`)
    turns.push({ turn, durationMs: Date.now() - started, usage, promptTokens: promptTokensOf(usage) })
  }
  return turns
}

async function realEndpoint({ baseUrl, model, apiKey }) {
  const backend = await startBackend({ kind: 'anthropic', baseUrl, model, path: 'v1/messages', apiKey })
  const stamp = String(Date.now())
  try {
    const cacheOn = await measuredRequests(backend.origin, { promptCaching: true, stamp, label: 'ON' })
    const cacheOff = await measuredRequests(backend.origin, { promptCaching: false, stamp, label: 'OFF' })
    const totals = turns => turns.reduce((total, turn) => ({
      promptTokens: total.promptTokens + turn.promptTokens,
      inputTokens: total.inputTokens + turn.usage.inputTokens,
      cacheReadTokens: total.cacheReadTokens + (turn.usage.cacheReadTokens ?? 0),
      cacheWriteTokens: total.cacheWriteTokens + (turn.usage.cacheWriteTokens ?? 0),
      outputTokens: total.outputTokens + turn.usage.outputTokens,
    }), { promptTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })
    const on = totals(cacheOn)
    const off = totals(cacheOff)
    const deviation = Math.abs(on.promptTokens - off.promptTokens) / Math.max(on.promptTokens, off.promptTokens)
    assert.ok(deviation <= 0.05, `cache on/off prompt totals must match within 5%, got ${String(on.promptTokens)} vs ${String(off.promptTokens)}`)
    const onReadRatio = on.cacheReadTokens / on.promptTokens
    const offReadRatio = off.cacheReadTokens / off.promptTokens
    const onCost = inputCostUnits(on)
    const offCost = inputCostUnits(off)
    const effective = on.cacheWriteTokens > 0 && onReadRatio >= 0.5
    results.push({
      section: 'real',
      provider: 'anthropic-compatible',
      model,
      result: effective ? 'cache-effective' : 'cache-not-effective',
      requests: { cacheOn: cacheOn.length, cacheOff: cacheOff.length },
      cacheOn: { ...on, cacheReadRatio: onReadRatio, inputCostUnits: onCost },
      cacheOff: { ...off, cacheReadRatio: offReadRatio, inputCostUnits: offCost },
      costRatioCacheOnOverOff: onCost / offCost,
      conclusions: {
        explicitCacheCreationReported: on.cacheWriteTokens > 0,
        automaticProviderCaching: offReadRatio >= 0.5,
        markerChangedCost: Math.abs(onCost / offCost - 1) > 0.05,
      },
      turns: { cacheOn, cacheOff },
    })
  } finally {
    await backend.app.close()
  }
}

try {
  await deterministicTranslation()
  if (envFilePath === undefined) {
    results.push({ section: 'real', result: 'skipped', reason: 'DSH_POC_ENV_FILE is required for the real endpoint measurement' })
  } else {
    const values = envValues(await readFile(envFilePath, 'utf8'))
    for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY']) {
      if (typeof values[name] !== 'string' || values[name].length === 0) {
        throw new Error(`${name} is required for the real Anthropic-protocol measurement`)
      }
    }
    await realEndpoint({
      baseUrl: values.ANTHROPIC_BASE_URL,
      model: values.ANTHROPIC_MODEL,
      apiKey: values.ANTHROPIC_API_KEY,
    })
  }
  for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true })
}
