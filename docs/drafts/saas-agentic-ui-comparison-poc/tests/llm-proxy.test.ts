import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../../browser-native-dsh-poc/backend-v2.mjs'

test('shared real proxy preserves text followed by multiple fragmented tool calls', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-saas-stream-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const upstream = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-not-a-real-key')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const deltas = [
      { content: '先读取数据。' },
      { tool_calls: [{ index: 0, id: 'call-a', function: { name: 'read_a', arguments: '{"a":' } }, { index: 1, id: 'call-b', function: { name: 'read_b', arguments: '{"b":' } }] },
      { tool_calls: [{ index: 1, function: { arguments: '2}' } }, { index: 0, function: { arguments: '1}' } }] },
    ]
    for (const delta of deltas) response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
    response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
  })
  context.after(() => new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.ok(address !== null && typeof address === 'object')
  const envFile = join(directory, '.env')
  await writeFile(envFile, `OPENAI_NEXT_GPT_MODEL=fixture\nOPENAI_NEXT_GPT_BASE_URL=http://127.0.0.1:${address.port}\nOPENAI_NEXT_GPT_COMPLETIONS_PATH=/chat/completions\nOPENAI_NEXT_GPT_API_KEY=fixture-not-a-real-key\n`)
  const app = await createBrowserNativeV2Server({ dataDir: join(directory, 'sessions'), envFile, llmMode: 'real' })
  context.after(() => app.close())
  await app.listen(0)
  const endpoint = app.server.address()
  assert.ok(endpoint !== null && typeof endpoint === 'object')
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/api/browser-native/llm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 1, requestId: 'text-then-tools', messages: [{ role: 'user', content: 'run fixture' }] }) })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.equal(text.includes('fixture-not-a-real-key'), false)
  const chunks = text.trim().split('\n').map(line => JSON.parse(line).chunk)
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => [chunk.index, chunk.block]), [
    [0, { type: 'text', text: '先读取数据。' }],
    [1, { type: 'tool-call', id: 'call-a', name: 'read_a', arguments: '{"a":1}' }],
    [2, { type: 'tool-call', id: 'call-b', name: 'read_b', arguments: '{"b":2}' }],
  ])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})
