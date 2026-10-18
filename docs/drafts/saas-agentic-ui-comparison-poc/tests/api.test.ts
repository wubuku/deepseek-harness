import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComparisonServer } from '../server.mjs'

test('HTTP receipts survive dropped response, retries and backend restart', async context => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-saas-api-'))
  context.after(() => rm(dataDir, { recursive: true, force: true }))
  let app = await createComparisonServer({ dataDir, llmMode: 'scripted', testHooks: { dropBusinessResponse: true } })
  context.after(() => app.close())
  await app.listen(0)
  let origin = `http://127.0.0.1:${app.server.address().port}`
  const operation = { operationId: 'lost-response-op', kind: 'create_task', fields: { title: '已提交', assignee: '林悦', priority: 'high' } }
  const post = (value: object, headers: Record<string, string> = {}) => fetch(`${origin}/api/saas/workspace/operations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mock-role': 'editor', ...headers }, body: JSON.stringify(value) })
  await assert.rejects(post(operation, { 'x-poc-drop-response': 'once' }), /fetch failed/)
  const receiptResponse = await fetch(`${origin}/api/saas/workspace/receipts/lost-response-op`)
  assert.equal(receiptResponse.status, 200)
  const receipt = await receiptResponse.json()
  assert.deepEqual(await (await post(operation)).json(), receipt)
  assert.equal((await (await fetch(`${origin}/api/saas/workspace/snapshot`)).json()).tasks.length, 2)
  assert.equal((await post({ ...operation, fields: { ...operation.fields, title: '改变请求' } })).status, 409)
  assert.equal((await post({ ...operation, operationId: 'viewer' }, { 'x-mock-role': 'viewer' })).status, 403)
  await app.close()
  app = await createComparisonServer({ dataDir, llmMode: 'scripted' })
  await app.listen(0)
  origin = `http://127.0.0.1:${app.server.address().port}`
  assert.deepEqual(await (await fetch(`${origin}/api/saas/workspace/receipts/lost-response-op`)).json(), receipt)
  assert.equal((await (await fetch(`${origin}/api/saas/workspace/snapshot`)).json()).tasks.length, 2)
})
