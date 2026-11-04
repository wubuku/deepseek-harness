/**
 * A failing primary provider must fall back without duplicating output or cost.
 *
 * Each case drives the real `/llm` proxy against two local OpenAI-compatible
 * upstreams. The primary is scripted per case; the fallback always answers. The
 * assertions check three independent ledgers: the NDJSON stream the Session
 * loop would consume, the provider request counters, and the usage audit that
 * prices a turn.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const dataDirs = []
const servers = []

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${String(server.address().port)}`)))
}

function closeServer(server) {
  return new Promise(resolve => {
    server.closeAllConnections?.()
    server.close(resolve)
  })
}

async function readBody(request) {
  let raw = ''
  for await (const chunk of request) raw += chunk
  return raw.length === 0 ? undefined : JSON.parse(raw)
}

function writeEvent(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/** OpenAI-compatible stream that answers with `text` and reported usage. */
function streamText(response, text, usage) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  for (const character of text) writeEvent(response, { choices: [{ index: 0, delta: { content: character } }] })
  writeEvent(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  writeEvent(response, { choices: [], usage })
  response.end('data: [DONE]\n\n')
}

async function startUpstream({ name, behavior }) {
  const state = { requests: 0 }
  const server = createServer(async (request, response) => {
    state.requests += 1
    await readBody(request)
    switch (behavior) {
      case 'ok':
        streamText(response, 'PRIMARY-TEXT', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
        return
      case 'http-500':
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'server_error', message: 'synthetic outage' } }))
        return
      case 'http-401':
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'authentication_error', message: 'synthetic auth failure' } }))
        return
      case 'reset':
        request.socket.destroy()
        return
      case 'timeout':
        return
      case 'empty-close':
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        response.end()
        return
      case 'partial-text':
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        writeEvent(response, { choices: [{ index: 0, delta: { content: 'PARTIAL' } }] })
        await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
        request.socket.destroy()
        return
      case 'partial-tool':
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        writeEvent(response, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-partial', function: { name: 'echo', arguments: '{"value":"X"}' } }] } }] })
        await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
        request.socket.destroy()
        return
      case 'fallback':
        streamText(response, 'FALLBACK-TEXT', { prompt_tokens: 20, completion_tokens: 50, total_tokens: 70 })
        return
      default:
        throw new Error(`${name}: unknown behavior ${behavior}`)
    }
  })
  servers.push(server)
  const origin = await listen(server)
  return { origin, state }
}

async function startBackend(primary, fallback) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-llm-fallback-'))
  dataDirs.push(dataDir)
  const app = await createBrowserNativeV2Server({
    dataDir,
    llmMode: 'real',
    llmProviderKind: 'openai',
    model: 'primary-model',
    llmBaseUrl: primary.origin,
    llmCompletionsPath: 'chat/completions',
    llmApiKey: 'primary-key',
    llmIncludeUsage: true,
    llmTimeoutMs: 400,
    llmFallback: {
      kind: 'openai', model: 'fallback-model', baseUrl: fallback.origin,
      path: 'chat/completions', apiKey: 'fallback-key', provider: 'fallback-provider', timeoutMs: 2_000,
    },
  })
  servers.push({ close: () => app.close() })
  return await app.listen(0)
}

async function callLlm(origin) {
  const response = await fetch(`${origin}/api/browser-native/llm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-browser-native-protocol': '1' },
    body: JSON.stringify({
      protocolVersion: 1,
      requestId: randomUUID(),
      messages: [{ role: 'user', content: 'FALLBACK_PROBE' }],
    }),
  })
  return { status: response.status, text: await response.text() }
}

async function auditEntries(origin) {
  const response = await fetch(`${origin}/api/browser-native/usage-audit`)
  assert.equal(response.status, 200)
  return (await response.json()).entries
}

function items(text) {
  return text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line))
}

function renderedText(text) {
  return items(text).filter(item => item.kind === 'chunk' && item.chunk.type === 'text-delta')
    .map(item => item.chunk.text).join('')
}

function chunkTypes(text) {
  return items(text).filter(item => item.kind === 'chunk').map(item => item.chunk.type)
}

async function runCase(primaryBehavior, expectations) {
  const primary = await startUpstream({ name: 'primary', behavior: primaryBehavior })
  const fallback = await startUpstream({ name: 'fallback', behavior: 'fallback' })
  const origin = await startBackend(primary, fallback)
  const result = await callLlm(origin)
  await expectations({ ...result, origin, primary, fallback })
  return { result, origin, primary, fallback }
}

const cases = []
function test(name, run) {
  cases.push({ name, run })
}

test('falls back after a primary 5xx without duplicating text or billing', async () => {
  await runCase('http-500', async ({ status, text, origin, primary, fallback }) => {
    assert.equal(status, 200)
    assert.equal(renderedText(text), 'FALLBACK-TEXT')
    assert.equal(primary.state.requests, 1)
    assert.equal(fallback.state.requests, 1)
    const entries = await auditEntries(origin)
    assert.equal(entries.length, 1, 'one /llm request must produce exactly one usage entry')
    assert.equal(entries[0].fallbackUsed, true)
    assert.equal(entries[0].provider, 'fallback-provider')
    assert.equal(entries[0].attempt, 2)
    assert.equal(entries[0].inputTokens, 20)
    assert.equal(entries[0].outputTokens, 50)
    const report = await (await fetch(`${origin}/api/browser-native/usage-report`)).json()
    assert.equal(report.totals.inputTokens, 20)
    assert.equal(report.totals.outputTokens, 50)
  })
})

test('falls back after an unreachable primary connection', async () => {
  await runCase('reset', async ({ status, text, origin, primary, fallback }) => {
    assert.equal(status, 200)
    assert.equal(renderedText(text), 'FALLBACK-TEXT')
    assert.equal(primary.state.requests, 1)
    assert.equal(fallback.state.requests, 1)
    const entries = await auditEntries(origin)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].provider, 'fallback-provider')
  })
})

test('falls back after a primary timeout that never produced output', async () => {
  await runCase('timeout', async ({ status, text, origin, primary, fallback }) => {
    assert.equal(status, 200)
    assert.equal(renderedText(text), 'FALLBACK-TEXT')
    assert.equal(primary.state.requests, 1)
    assert.equal(fallback.state.requests, 1)
    const entries = await auditEntries(origin)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].fallbackUsed, true)
  })
})

test('falls back after a primary stream that ended before any event', async () => {
  await runCase('empty-close', async ({ status, text, origin, primary, fallback }) => {
    assert.equal(status, 200)
    assert.equal(renderedText(text), 'FALLBACK-TEXT')
    assert.equal(fallback.state.requests, 1)
    const entries = await auditEntries(origin)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].provider, 'fallback-provider')
  })
})

test('does not retry after text already reached the loop', async () => {
  await runCase('partial-text', async ({ status, text, origin, primary, fallback }) => {
    assert.equal(status, 200)
    assert.equal(renderedText(text), 'PARTIAL', 'the partial primary text must be surfaced once, never replayed')
    assert.equal(fallback.state.requests, 0, 'a retry would duplicate visible output')
    const errors = items(text).filter(item => item.kind === 'error')
    assert.equal(errors.length, 1)
    assert.equal(errors[0].error.code, 'UPSTREAM_LLM_STREAM_FAILED')
    assert.equal(primary.state.requests, 1)
    assert.deepEqual(await auditEntries(origin), [], 'an attempt without reported usage records nothing')
  })
})

test('does not retry after a tool call already reached the loop', async () => {
  await runCase('partial-tool', async ({ status, text, origin, fallback }) => {
    assert.equal(status, 200)
    assert.equal(fallback.state.requests, 0, 'a retry would execute the same tool twice')
    const types = chunkTypes(text)
    assert.equal(types.filter(type => type === 'block-start').length, 1)
    assert.equal(types.filter(type => type === 'tool-call-delta').length, 1, 'the failed attempt must expose exactly one tool call')
    assert.equal(types.filter(type => type === 'block-end').length, 0, 'the interrupted block must not be closed as successful')
    assert.equal(items(text).filter(item => item.kind === 'error')[0].error.code, 'UPSTREAM_LLM_STREAM_FAILED')
  })
})

test('does not fall back on a primary credential failure', async () => {
  await runCase('http-401', async ({ status, text, origin, fallback }) => {
    assert.equal(status, 502, 'a provider answer must surface as-is')
    assert.deepEqual(JSON.parse(text).error.code, 'UPSTREAM_LLM_AUTH_FAILED')
    assert.equal(fallback.state.requests, 0, 'auth misconfiguration must not be masked by a fallback')
    assert.deepEqual(await auditEntries(origin), [])
  })
})

const failures = []
for (const { name, run } of cases) {
  try {
    await run()
    process.stdout.write(`ok - ${name}\n`)
  } catch (error) {
    failures.push({ name, error })
    process.stdout.write(`not ok - ${name}: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

for (const resource of servers.reverse()) {
  await (typeof resource.close === 'function' ? resource.close() : closeServer(resource))
}
for (const dataDir of dataDirs) await rm(dataDir, { recursive: true, force: true })

if (failures.length > 0) {
  throw new AggregateError(failures.map(failure => failure.error), `${failures.length} fallback cases failed`)
}
