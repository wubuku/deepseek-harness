/** Shared mock SaaS request validation, fixtures, and business operations. */
import { createHash } from 'node:crypto'
import type { Operation, OperationKind } from './schemas.ts'
export { fieldsSchema, operationSchema } from './schemas.ts'
export type { Operation, BusinessFields, OperationKind } from './schemas.ts'
export interface Task { id: string; title: string; assignee: string; priority: string; version: number }
export interface Ticket { id: string; title: string; assignee: string; priority: string; status: string; version: number }
export interface Invoice { id: string; customer: string; amount: number; status: string; version: number }
export interface Receipt {
  operationId: string
  kind: OperationKind
  ok: true
  record: Task | Ticket | Invoice
  actor: string
}
export interface Workspace {
  tasks: Task[]
  tickets: Ticket[]
  invoices: Invoice[]
  receipts: Record<string, { fingerprint: string; receipt: Receipt }>
}

export class BusinessError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}

/** Return an independent fixture for one isolated comparison workspace. */
export function fixture(): Workspace {
  return {
    tasks: [{ id: 'TASK-100', title: '上线客户门户', assignee: '林悦', priority: 'medium', version: 1 }],
    tickets: [{ id: 'TICKET-42', title: '客户无法导出报表', assignee: '陈晨', priority: 'medium', status: 'open', version: 1 }],
    invoices: [{ id: 'INV-2026-018', customer: '青禾科技', amount: 12800, status: 'pending', version: 1 }],
    receipts: {},
  }
}

/** Apply to a transaction-local copy; replay identical operations without repeating a write. */
export function applyOperation(workspace: Workspace, input: Operation, role: string): Receipt {
  if (role !== 'editor') throw new BusinessError('FORBIDDEN', '只读角色无权执行业务操作', 403)
  const fingerprint = JSON.stringify([input.kind, Object.entries(input.fields).sort(([left], [right]) => left.localeCompare(right))])
  const previous = workspace.receipts[input.operationId]
  if (previous !== undefined) {
    if (previous.fingerprint !== fingerprint) throw new BusinessError('IDEMPOTENCY_CONFLICT', '同一 operation id 不得用于不同参数', 409)
    return previous.receipt
  }
  let record: Receipt['record']
  const fields = input.fields
  if (input.kind === 'create_task') {
    if (!fields.title || !fields.assignee || !fields.priority) throw new BusinessError('INVALID_FIELDS', '任务需要标题、负责人和优先级')
    record = { id: `TASK-${createHash('sha256').update(input.operationId).digest('hex').slice(0, 10)}`, title: fields.title, assignee: fields.assignee, priority: fields.priority, version: 1 }
    workspace.tasks.push(record)
  } else if (input.kind === 'update_ticket') {
    const ticket = workspace.tickets.find(value => value.id === fields.id)
    if (ticket === undefined) throw new BusinessError('NOT_FOUND', '工单不存在', 404)
    if (ticket.version !== fields.expectedVersion) throw new BusinessError('VERSION_CONFLICT', '工单已变化，请刷新后重新确认', 409)
    if (!fields.assignee || !fields.priority || !fields.status) throw new BusinessError('INVALID_FIELDS', '工单需要负责人、优先级和状态')
    Object.assign(ticket, { assignee: fields.assignee, priority: fields.priority, status: fields.status, version: ticket.version + 1 })
    record = ticket
  } else {
    const invoice = workspace.invoices.find(value => value.id === fields.id)
    if (invoice === undefined) throw new BusinessError('NOT_FOUND', '账单不存在', 404)
    if (invoice.version !== fields.expectedVersion) throw new BusinessError('VERSION_CONFLICT', '账单已变化，请刷新后重新确认', 409)
    if (invoice.status !== 'pending') throw new BusinessError('ALREADY_APPROVED', '账单已经审批', 409)
    invoice.status = 'approved'
    invoice.version += 1
    record = invoice
  }
  const receipt: Receipt = { operationId: input.operationId, kind: input.kind, ok: true, record: structuredClone(record), actor: role }
  workspace.receipts[input.operationId] = { fingerprint, receipt }
  return receipt
}
