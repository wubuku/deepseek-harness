import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyOperation, databaseSchema, fixture, operationSchema, persistedWorkspacesSchema } from '../domain.ts'
import { FrontendBridgeWithSegments } from '../bridge.ts'

test('字段补丁保留人工预算，旧版本不能覆盖新报价', () => {
  const database = fixture()
  applyOperation(database, { operationId: 'human', customerId: 'acme', kind: 'patch', expectedVersion: 1, budget: 150000 }, 'editor')
  applyOperation(database, { operationId: 'agent', customerId: 'acme', kind: 'patch', expectedVersion: 2, discount: 8 }, 'editor')
  assert.equal(database.accounts.acme.quote.budget, 150000)
  assert.equal(database.accounts.acme.quote.discount, 8)
  assert.throws(() => applyOperation(database, { operationId: 'old', customerId: 'acme', kind: 'patch', expectedVersion: 1, budget: 1 }, 'editor'), /报价已被修改/)
})

test('只有人工批准当前版本才可发送，修改会撤销审批', () => {
  const database = fixture()
  assert.throws(() => applyOperation(database, { operationId: 'early', customerId: 'acme', kind: 'send', expectedVersion: 1 }, 'editor'), /人工批准/)
  applyOperation(database, { operationId: 'reject', customerId: 'acme', kind: 'approve', expectedVersion: 1, approved: false }, 'editor')
  assert.throws(() => applyOperation(database, { operationId: 'rejected', customerId: 'acme', kind: 'send', expectedVersion: 1 }, 'editor'), /人工批准/)
  applyOperation(database, { operationId: 'approve', customerId: 'acme', kind: 'approve', expectedVersion: 1, approved: true }, 'editor')
  applyOperation(database, { operationId: 'edit', customerId: 'acme', kind: 'patch', expectedVersion: 1, discount: 8 }, 'editor')
  assert.equal(database.accounts.acme.quote.approval, undefined)
  assert.throws(() => applyOperation(database, { operationId: 'changed', customerId: 'acme', kind: 'send', expectedVersion: 2 }, 'editor'), /人工批准/)
})

test('相同 operation id 重放凭据，不重复写入，改参数被拒绝', () => {
  const database = fixture()
  const operation = operationSchema.parse({ operationId: 'same', customerId: 'acme', kind: 'assign', ticketIds: ['TK-41'], assignee: '周宁' })
  const receipt = applyOperation(database, operation, 'editor')
  assert.deepEqual(applyOperation(database, operation, 'editor'), receipt)
  assert.equal(database.writes, 1)
  assert.throws(() => applyOperation(database, { ...operation, assignee: '陈晨' }, 'editor'), /同一操作/)
  assert.throws(() => applyOperation(database, operation, 'viewer'), /只读/)
})

test('跨客户工单及无效参数不能进入业务写入', () => {
  const database = fixture()
  assert.throws(() => applyOperation(database, { operationId: 'cross', customerId: 'birch', kind: 'assign', ticketIds: ['TK-41'], assignee: '周宁' }, 'editor'), /属于当前客户/)
  assert.equal(operationSchema.safeParse({ operationId: 'bad', customerId: 'acme', kind: 'patch', discount: 90 }).success, false)
  assert.equal(database.writes, 0)
})

test('批量提交必须绑定每个客户当前版本的人工批准', () => {
  const database = fixture()
  const changes = [
    { customerId: 'acme' as const, expectedVersion: 1, budget: 120000, discount: 8 },
    { customerId: 'birch' as const, expectedVersion: 1, budget: 60000, discount: 8 },
  ]
  assert.throws(() => applyOperation(database, { operationId: 'apply-before-approval', customerId: 'acme', kind: 'portfolio_apply', changes }, 'editor'), /人工批准/)
  applyOperation(database, { operationId: 'portfolio-approval', customerId: 'acme', kind: 'portfolio_approve', approved: true, changes }, 'editor')
  assert.equal(database.accounts.acme.quote.approval?.version, 1)
  assert.equal(database.accounts.birch.quote.approval?.version, 1)
  applyOperation(database, { operationId: 'portfolio-apply', customerId: 'acme', kind: 'portfolio_apply', changes }, 'editor')
  assert.equal(database.accounts.acme.quote.version, 2)
  assert.equal(database.accounts.birch.quote.version, 2)
})

test('批量批准后版本变化会拒绝旧方案', () => {
  const database = fixture()
  const changes = [
    { customerId: 'acme' as const, expectedVersion: 1, budget: 120000, discount: 8 },
    { customerId: 'birch' as const, expectedVersion: 1, budget: 60000, discount: 8 },
  ]
  applyOperation(database, { operationId: 'portfolio-approval', customerId: 'acme', kind: 'portfolio_approve', approved: true, changes }, 'editor')
  applyOperation(database, { operationId: 'external-edit', customerId: 'acme', kind: 'patch', expectedVersion: 1, discount: 6 }, 'editor')
  assert.throws(() => applyOperation(database, { operationId: 'stale-apply', customerId: 'acme', kind: 'portfolio_apply', changes }, 'editor'), /报价已被修改/)
})

test('批量批准绑定完整内容，改折扣、预算、客户集合或拒绝后不能提交', () => {
  const database = fixture()
  const changes = [
    { customerId: 'acme' as const, expectedVersion: 1, budget: 120000, discount: 8 },
    { customerId: 'birch' as const, expectedVersion: 1, budget: 60000, discount: 8 },
  ]
  applyOperation(database, { operationId: 'approve-plan', customerId: 'acme', kind: 'portfolio_approve', approved: true, changes }, 'editor')
  for (const altered of [[{ ...changes[0], discount: 30 }, changes[1]], [{ ...changes[0], budget: 900000 }, changes[1]], [changes[0]]]) {
    assert.throws(() => applyOperation(database, { operationId: 'altered', customerId: 'acme', kind: 'portfolio_apply', changes: altered }, 'editor'), /人工批准/)
  }
  assert.equal(database.writes, 1)
  applyOperation(database, { operationId: 'reject-plan', customerId: 'acme', kind: 'portfolio_approve', approved: false, changes }, 'editor')
  assert.throws(() => applyOperation(database, { operationId: 'after-rejection', customerId: 'acme', kind: 'portfolio_apply', changes }, 'editor'), /人工批准/)
  assert.equal(database.writes, 2)
})

test('原生 handler 不提前结算 DSH waiter；取消后拒绝迟到副作用', async () => {
  const messages: unknown[] = []
  const bridge = new FrontendBridgeWithSegments({ postMessage: value => { messages.push(value) } })
  bridge.register('quote_patch', () => undefined)
  bridge.handleRequest({ type: 'browser-native-frontend-tool-request', requestId: 'request', sessionId: 'session', callId: 'call', name: 'quote_patch', arguments: {} })
  await bridge.executeNative('call', 'quote_patch', async () => ({ ok: true }))
  assert.equal(messages.length, 0)
  assert.equal(bridge.getSnapshot().length, 1)
  bridge.cancel('call')
  await assert.rejects(bridge.executeNative('call', 'quote_patch', async () => { throw new Error('不应执行') }), /已结束/)
  assert.equal(bridge.resolve('call', { ok: true }), false)
  bridge.dispose()
})

test('持久化与 API 快照必须有完整客户、有效版本和写入计数', () => {
  assert.deepEqual(databaseSchema.parse(fixture()), fixture())
  assert.equal(databaseSchema.safeParse({ ...fixture(), accounts: {} }).success, false)
  assert.equal(databaseSchema.safeParse({ ...fixture(), writes: -1 }).success, false)
  assert.equal(persistedWorkspacesSchema.safeParse(3).success, false)
  assert.equal(persistedWorkspacesSchema.safeParse({ 'invalid/workspace': fixture() }).success, false)
  assert.deepEqual(persistedWorkspacesSchema.parse({ manual: fixture() }), { manual: fixture() })
})
