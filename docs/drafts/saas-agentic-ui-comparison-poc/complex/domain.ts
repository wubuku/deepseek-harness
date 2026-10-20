/** Versioned mock SaaS operations, shared by the existing GUI and agent actions. */
import { z } from 'zod'

/** Wire validation shared by GUI and Agent writes; authorization remains server-owned. */
export const operationSchema = z.object({
  operationId: z.string().min(1).max(250),
  customerId: z.enum(['acme', 'birch']),
  kind: z.enum(['assign', 'patch', 'approve', 'portfolio_approve', 'send', 'portfolio_apply', 'billing_patch', 'billing_approve', 'billing_apply']),
  expectedVersion: z.number().int().positive().optional(),
  ticketIds: z.array(z.string()).optional(),
  assignee: z.enum(['林悦', '周宁', '陈晨']).optional(),
  budget: z.number().min(1000).max(1_000_000).optional(),
  discount: z.number().min(0).max(30).optional(),
  creditAmount: z.number().min(0).max(1_000_000).optional(),
  reason: z.string().min(1).max(500).optional(),
  approved: z.boolean().optional(),
  changes: z.array(z.object({
    customerId: z.enum(['acme', 'birch']),
    expectedVersion: z.number().int().positive(),
    budget: z.number().min(1000).max(1_000_000).optional(),
    discount: z.number().min(0).max(30).optional(),
  }).strict()).min(1).max(2).optional(),
}).strict()
/** Validated write input; replay requires the same operation id and parameters. */
export type Operation = z.infer<typeof operationSchema>
/** A revisioned quote whose approval applies only to its recorded version. */
export interface Quote { budget: number; discount: number; version: number; status: 'draft' | 'sent'; approval?: { version: number; approved: boolean; portfolioPlan?: string } }
/** A revisioned billing dispute whose credit requires human approval. */
export interface BillingCase { invoiceId: string; amount: number; disputed: number; creditAmount: number; reason: string; version: number; status: 'open' | 'credited'; approval?: { version: number; approved: boolean; creditAmount: number; reason: string } }
/** Customer-owned records used by both the existing GUI and chat tools. */
export interface Account { name: string; quote: Quote; billing: BillingCase; tickets: { id: string; title: string; assignee: string }[] }
/** Immutable write evidence replayed when the original operation is retried. */
export interface Receipt { ok: true; operationId: string; kind: Operation['kind']; customerId: string; record: Account | { accounts: Record<string, Account> } }
/** One mock workspace's durable business state, separate from DSH history. */
export interface Database { accounts: Record<string, Account>; receipts: Record<string, { fingerprint: string; receipt: Receipt }>; writes: number }

const quoteSchema = z.object({ budget: z.number().min(1000).max(1_000_000), discount: z.number().min(0).max(30), version: z.number().int().positive(), status: z.enum(['draft', 'sent']), approval: z.object({ version: z.number().int().positive(), approved: z.boolean(), portfolioPlan: z.string().optional() }).strict().optional() }).strict()
const billingSchema = z.object({ invoiceId: z.string().min(1), amount: z.number().positive(), disputed: z.number().nonnegative(), creditAmount: z.number().nonnegative(), reason: z.string(), version: z.number().int().positive(), status: z.enum(['open', 'credited']), approval: z.object({ version: z.number().int().positive(), approved: z.boolean(), creditAmount: z.number().nonnegative(), reason: z.string().min(1) }).strict().optional() }).strict()
const accountSchema = z.object({ name: z.string().min(1), quote: quoteSchema, billing: billingSchema, tickets: z.array(z.object({ id: z.string().min(1), title: z.string(), assignee: z.string() }).strict()) }).strict()
const receiptSchema = z.object({ ok: z.literal(true), operationId: z.string().min(1), kind: operationSchema.shape.kind, customerId: z.string().min(1), record: z.union([accountSchema, z.object({ accounts: z.record(z.string(), accountSchema) }).strict()]) }).strict()

/** Validate persisted and HTTP business snapshots before they enter application state. */
export const databaseSchema = z.object({ accounts: z.object({ acme: accountSchema, birch: accountSchema }).strict(), receipts: z.record(z.string(), z.object({ fingerprint: z.string(), receipt: receiptSchema }).strict()), writes: z.number().int().nonnegative() }).strict()

/** Reject a malformed durable workspace map instead of silently resetting business data. */
export const persistedWorkspacesSchema = z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), databaseSchema)

/** Create independent business data, without sharing mutable fixture objects.
 * @returns An unshared initial workspace with no receipts.
 */
export function fixture(): Database {
  return { accounts: {
    acme: { name: '青禾科技', quote: { budget: 120000, discount: 5, version: 1, status: 'draft' }, billing: { invoiceId: 'INV-1007', amount: 50000, disputed: 12000, creditAmount: 0, reason: '', version: 1, status: 'open' }, tickets: [{ id: 'TK-41', title: '导出报表超时', assignee: '陈晨' }, { id: 'TK-42', title: '续约账号迁移', assignee: '林悦' }, { id: 'TK-43', title: '账单邮箱变更', assignee: '陈晨' }] },
    birch: { name: '白桦设计', quote: { budget: 60000, discount: 0, version: 1, status: 'draft' }, billing: { invoiceId: 'INV-2003', amount: 24000, disputed: 4000, creditAmount: 0, reason: '', version: 1, status: 'open' }, tickets: [{ id: 'TK-81', title: '成员邀请失败', assignee: '林悦' }] },
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
  if (input.kind === 'billing_patch' || input.kind === 'billing_approve' || input.kind === 'billing_apply') {
    const billing = account.billing
    if (input.expectedVersion !== billing.version) throw new BusinessError('VERSION_CONFLICT', '账单争议已被修改，请重新读取并确认')
    if (billing.status === 'credited') throw new BusinessError('ALREADY_CREDITED', '账单减免已经提交')
    if (input.creditAmount === undefined || input.creditAmount > billing.disputed) throw new BusinessError('INVALID_CREDIT', '减免金额不能超过争议金额', 400)
    if (!input.reason?.trim()) throw new BusinessError('MISSING_REASON', '账单减免必须填写原因', 400)
    if (input.kind === 'billing_patch') {
      billing.creditAmount = input.creditAmount
      billing.reason = input.reason
      billing.version += 1
      delete billing.approval
    } else if (input.kind === 'billing_approve') {
      if (input.approved === undefined) throw new BusinessError('MISSING_DECISION', '需要明确批准或拒绝', 400)
      billing.approval = { approved: input.approved, version: billing.version, creditAmount: input.creditAmount, reason: input.reason }
    } else {
      if (!billing.approval?.approved || billing.approval.version !== billing.version || billing.approval.creditAmount !== input.creditAmount || billing.approval.reason !== input.reason) throw new BusinessError('APPROVAL_REQUIRED', '提交前需要批准当前账单减免方案')
      billing.creditAmount = input.creditAmount
      billing.reason = input.reason
      billing.status = 'credited'
      billing.version += 1
      delete billing.approval
    }
    return commitReceipt(database, input, structuredClone(account))
  }
  if (input.kind === 'portfolio_approve' || input.kind === 'portfolio_apply') {
    if (!input.changes?.length || new Set(input.changes.map(change => change.customerId)).size !== input.changes.length) throw new BusinessError('INVALID_PLAN', '批量续约方案必须包含不同客户的报价变更', 400)
    const portfolioPlan = JSON.stringify(input.changes.map(change => ({ customerId: change.customerId, expectedVersion: change.expectedVersion, budget: change.budget, discount: change.discount })).sort((left, right) => left.customerId.localeCompare(right.customerId)))
    for (const change of input.changes) {
      const target = database.accounts[change.customerId]
      if (change.expectedVersion !== target.quote.version) throw new BusinessError('VERSION_CONFLICT', `客户 ${change.customerId} 的报价已被修改，请重新读取批量方案`)
      if (target.quote.status === 'sent') throw new BusinessError('ALREADY_SENT', `客户 ${change.customerId} 的报价已经发送`)
      if (change.budget === undefined && change.discount === undefined) throw new BusinessError('EMPTY_PATCH', '批量方案至少修改一个报价字段', 400)
    }
    if (input.kind === 'portfolio_approve') {
      if (input.approved === undefined) throw new BusinessError('MISSING_DECISION', '需要明确批准或拒绝', 400)
      for (const change of input.changes) database.accounts[change.customerId].quote.approval = { approved: input.approved, version: change.expectedVersion, portfolioPlan }
      return commitReceipt(database, input, { accounts: Object.fromEntries(input.changes.map(change => [change.customerId, structuredClone(database.accounts[change.customerId])])) })
    }
    for (const change of input.changes) {
      const target = database.accounts[change.customerId]
      if (!target.quote.approval?.approved || target.quote.approval.version !== target.quote.version || target.quote.approval.portfolioPlan !== portfolioPlan) throw new BusinessError('APPROVAL_REQUIRED', `客户 ${change.customerId} 的当前报价没有匹配的人工批准`)
    }
    for (const change of input.changes) {
      const target = database.accounts[change.customerId]
      if (change.budget !== undefined) target.quote.budget = change.budget
      if (change.discount !== undefined) target.quote.discount = change.discount
      target.quote.version += 1
      delete target.quote.approval
    }
    return commitReceipt(database, input, { accounts: Object.fromEntries(input.changes.map(change => [change.customerId, structuredClone(database.accounts[change.customerId])])) })
  }
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
  return commitReceipt(database, input, structuredClone(account))
}

function commitReceipt(database: Database, input: Operation, record: Receipt['record']): Receipt {
  const { operationId, ...fields } = input
  const fingerprint = JSON.stringify(Object.entries(fields).sort(([left], [right]) => left.localeCompare(right)))
  const receipt: Receipt = { ok: true, operationId, kind: input.kind, customerId: input.customerId, record }
  database.receipts[operationId] = { fingerprint, receipt }
  database.writes += 1
  return receipt
}
