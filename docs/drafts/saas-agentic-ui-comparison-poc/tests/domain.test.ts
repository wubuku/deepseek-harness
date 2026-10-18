import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOperation, fixture } from '../src/domain.ts'

test('same operation id replays receipt once and rejects changed payload', () => {
  const workspace = fixture()
  const input = { operationId: 'op-1', kind: 'create_task' as const, fields: { title: '任务', assignee: '林悦' as const, priority: 'high' as const } }
  const first = applyOperation(workspace, input, 'editor')
  assert.deepEqual(applyOperation(workspace, input, 'editor'), first)
  assert.equal(workspace.tasks.length, 2)
  assert.throws(() => applyOperation(workspace, { ...input, fields: { ...input.fields, title: '另一任务' } }, 'editor'), /不得用于不同参数/)
})

test('viewer cannot write or read a write receipt by resubmitting', () => {
  const workspace = fixture()
  const input = { operationId: 'invoice', kind: 'approve_invoice' as const, fields: { id: 'INV-2026-018', expectedVersion: 1 } }
  assert.throws(() => applyOperation(workspace, input, 'viewer'), /只读角色/)
  assert.equal(workspace.invoices[0]?.status, 'pending')
  applyOperation(workspace, input, 'editor')
  assert.throws(() => applyOperation(workspace, input, 'viewer'), /只读角色/)
})

test('stale version cannot mutate a ticket or create receipt', () => {
  const workspace = fixture()
  const input = { operationId: 'ticket', kind: 'update_ticket' as const, fields: { id: 'TICKET-42', expectedVersion: 1, assignee: '周宁' as const, priority: 'high' as const, status: 'in_progress' as const } }
  applyOperation(workspace, input, 'editor')
  assert.equal(workspace.tickets[0]?.version, 2)
  assert.throws(() => applyOperation(workspace, { ...input, operationId: 'ticket-stale' }, 'editor'), /工单已变化/)
  assert.equal(Object.keys(workspace.receipts).length, 1)
})
