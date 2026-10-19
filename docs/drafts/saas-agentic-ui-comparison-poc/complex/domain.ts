/** Versioned mock SaaS operations, shared by the existing GUI and agent actions. */
import { z } from 'zod'

/** Wire validation shared by GUI and Agent writes; authorization remains server-owned. */
export const operationSchema = z.object({
  operationId: z.string().min(1).max(250),
  customerId: z.enum(['acme', 'birch']),
  kind: z.enum(['assign', 'patch', 'approve', 'send']),
  expectedVersion: z.number().int().positive().optional(),
  ticketIds: z.array(z.string()).optional(),
  assignee: z.enum(['林悦', '周宁', '陈晨']).optional(),
  budget: z.number().min(1000).max(1_000_000).optional(),
  discount: z.number().min(0).max(30).optional(),
  approved: z.boolean().optional(),
}).strict()
/** Validated write input; replay requires the same operation id and parameters. */
export type Operation = z.infer<typeof operationSchema>
/** A revisioned quote whose approval applies only to its recorded version. */
export interface Quote { budget: number; discount: number; version: number; status: 'draft' | 'sent'; approval?: { version: number; approved: boolean } }
/** Customer-owned records used by both the existing GUI and chat tools. */
export interface Account { name: string; quote: Quote; tickets: { id: string; title: string; assignee: string }[] }
/** Immutable write evidence replayed when the original operation is retried. */
export interface Receipt { ok: true; operationId: string; kind: Operation['kind']; customerId: string; record: Account }
/** One mock workspace's durable business state, separate from DSH history. */
export interface Database { accounts: Record<string, Account>; receipts: Record<string, { fingerprint: string; receipt: Receipt }>; writes: number }

const quoteSchema = z.object({ budget: z.number().min(1000).max(1_000_000), discount: z.number().min(0).max(30), version: z.number().int().positive(), status: z.enum(['draft', 'sent']), approval: z.object({ version: z.number().int().positive(), approved: z.boolean() }).strict().optional() }).strict()
const accountSchema = z.object({ name: z.string().min(1), quote: quoteSchema, tickets: z.array(z.object({ id: z.string().min(1), title: z.string(), assignee: z.string() }).strict()) }).strict()
const receiptSchema = z.object({ ok: z.literal(true), operationId: z.string().min(1), kind: operationSchema.shape.kind, customerId: z.string().min(1), record: accountSchema }).strict()

/** Validate persisted and HTTP business snapshots before they enter application state. */
export const databaseSchema = z.object({ accounts: z.object({ acme: accountSchema, birch: accountSchema }).strict(), receipts: z.record(z.string(), z.object({ fingerprint: z.string(), receipt: receiptSchema }).strict()), writes: z.number().int().nonnegative() }).strict()

/** Reject a malformed durable workspace map instead of silently resetting business data. */
export const persistedWorkspacesSchema = z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), databaseSchema)

/** Create independent business data, without sharing mutable fixture objects.
 * @returns An unshared initial workspace with no receipts.
 */
export function fixture(): Database {
  return { accounts: {
    acme: { name: '青禾科技', quote: { budget: 120000, discount: 5, version: 1, status: 'draft' }, tickets: [{ id: 'TK-41', title: '导出报表超时', assignee: '陈晨' }, { id: 'TK-42', title: '续约账号迁移', assignee: '林悦' }, { id: 'TK-43', title: '账单邮箱变更', assignee: '陈晨' }] },
    birch: { name: '白桦设计', quote: { budget: 60000, discount: 0, version: 1, status: 'draft' }, tickets: [{ id: 'TK-81', title: '成员邀请失败', assignee: '林悦' }] },
  }, receipts: {}, writes: 0 }
}

/** Business rejection with an HTTP status; rejected writes never commit the draft. */
export class BusinessError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message) }
}

/** Apply one authorized operation to a transaction-local draft, replaying its original receipt.
 * @param database - Transaction-local data committed only after durable storage succeeds.
 * @param input - Validated write with a stable operation id.
 * @param role - Mock server-side permission, not a production identity.
 * @returns The original or newly created write receipt.
 */
export function applyOperation(database: Database, input: Operation, role: string): Receipt {
  if (role !== 'editor') throw new BusinessError('FORBIDDEN', '只读角色不能修改业务数据', 403)
  const { operationId, ...fields } = input
  const fingerprint = JSON.stringify(Object.entries(fields).sort(([left], [right]) => left.localeCompare(right)))
  const previous = database.receipts[operationId]
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new BusinessError('IDEMPOTENCY_CONFLICT', '同一操作不能更改提交内容')
    return previous.receipt
  }
  const account = database.accounts[input.customerId]
  if (!account) throw new BusinessError('NOT_FOUND', '客户不存在', 404)
  const quote = account.quote
  if (input.kind === 'assign') {
    if (!input.ticketIds?.length || !input.assignee || new Set(input.ticketIds).size !== input.ticketIds.length || input.ticketIds.some(id => !account.tickets.some(ticket => ticket.id === id))) throw new BusinessError('INVALID_SELECTION', '工单必须属于当前客户且不能重复', 400)
    for (const ticket of account.tickets) if (input.ticketIds.includes(ticket.id)) ticket.assignee = input.assignee
  } else {
    if (input.expectedVersion !== quote.version) throw new BusinessError('VERSION_CONFLICT', '报价已被修改，请重新读取并确认')
    if (quote.status === 'sent') throw new BusinessError('ALREADY_SENT', '报价已经发送')
    if (input.kind === 'patch') {
      if (input.budget === undefined && input.discount === undefined) throw new BusinessError('EMPTY_PATCH', '至少修改一个报价字段', 400)
      if (input.budget !== undefined) quote.budget = input.budget
      if (input.discount !== undefined) quote.discount = input.discount
      quote.version += 1
      delete quote.approval
    } else if (input.kind === 'approve') {
      if (input.approved === undefined) throw new BusinessError('MISSING_DECISION', '需要明确批准或拒绝', 400)
      quote.approval = { approved: input.approved, version: quote.version }
    } else {
      if (!quote.approval?.approved || quote.approval.version !== quote.version) throw new BusinessError('APPROVAL_REQUIRED', '发送前需要人工批准当前版本', 403)
      quote.status = 'sent'
      quote.version += 1
    }
  }
  const receipt: Receipt = { ok: true, operationId, kind: input.kind, customerId: input.customerId, record: structuredClone(account) }
  database.receipts[operationId] = { fingerprint, receipt }
  database.writes += 1
  return receipt
}
