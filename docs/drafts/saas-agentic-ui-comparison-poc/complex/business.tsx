/** Existing business components and commands, independent of the selected chat framework. */
import React, { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { z } from 'zod'
import type { BrowserNativeDshClient } from './dsh-client.ts'
import { databaseSchema, type BillingCase, type Database, type Operation, type Quote } from './domain.ts'
import type { PendingCall } from './bridge.ts'

/** Shared SaaS state consumed by the independent GUI and tool renderers. */
export interface BusinessState {
  client: BrowserNativeDshClient
  workspace: string
  data: Database
  customerId: 'acme' | 'birch'
  page: 'tickets' | 'quote' | 'portfolio' | 'billing'
  role: 'editor' | 'viewer'
  selected: string[]
  portfolioSelected: Array<'acme' | 'birch'>
  refresh(): Promise<void>
}
/** SaaS-owned state, independent of either third-party chat runtime. */
export const Business = createContext<BusinessState | undefined>(undefined)
/** Require the live SaaS provider.
 * @returns The current business context, never an empty fallback.
 */
export function useBusiness(): BusinessState { const value = useContext(Business); if (!value) throw new Error('业务上下文未挂载'); return value }

/** Fetch the authoritative mock business state; chat copies are not the database.
 * @param workspace - Mock workspace selected by the page URL.
 * @returns A validated business snapshot.
 */
export async function readWorkspace(workspace: string): Promise<Database> {
  const response = await fetch(`/api/complex/${workspace}/snapshot`)
  if (!response.ok) throw new Error('无法读取业务数据')
  return databaseSchema.parse(await response.json())
}

/** Submit a stable operation id and recover a lost response by querying its receipt.
 * @param business - Current workspace, role and refresh callback.
 * @param operation - Write with an id stable for this submission and receipt lookup.
 * @param signal - Original tool cancellation, if executing for DSH.
 * @returns A receipt or an explicit unsuccessful/unknown outcome.
 */
export async function submit(business: BusinessState, operation: Operation, signal?: AbortSignal): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`/api/complex/${business.workspace}/operations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mock-role': business.role }, body: JSON.stringify(operation), signal })
    const result = await response.json() as Record<string, unknown>
    await business.refresh()
    return result
  } catch (error) {
    const receipt = await fetch(`/api/complex/${business.workspace}/receipts/${encodeURIComponent(operation.operationId)}`)
    if (receipt.ok) { await business.refresh(); return receipt.json() as Promise<Record<string, unknown>> }
    return { ok: false, code: signal?.aborted ? 'CANCELLED' : 'UNKNOWN_OUTCOME', error: error instanceof Error ? error.message : String(error) }
  }
}

const argsSchema = z.object({ customerId: z.enum(['acme', 'birch']), expectedVersion: z.number().optional(), ticketIds: z.array(z.string()).optional(), assignee: z.enum(['林悦', '周宁', '陈晨']).optional(), budget: z.number().optional(), discount: z.number().optional(), creditAmount: z.number().optional(), reason: z.string().optional(), changes: z.array(z.object({ customerId: z.enum(['acme', 'birch']), expectedVersion: z.number(), budget: z.number().optional(), discount: z.number().optional() }).strict()).optional() }).strict()
/** Data-only DSH questions accepted by the shared review card. */
export const questionSchema = z.object({ questions: z.array(z.object({ id: z.string(), question: z.string(), options: z.array(z.object({ label: z.string() }).passthrough()).optional() }).passthrough()).min(1) })
const portfolioChangeSchema = z.object({ customerId: z.enum(['acme', 'birch']), expectedVersion: z.number().int().positive(), budget: z.number().min(1000).max(1_000_000), discount: z.number().min(0).max(30) }).strict()
const portfolioPlanSchema = z.object({ changes: z.array(portfolioChangeSchema).min(1).max(2) }).strict()
/** Editable billing plan accepted by the approval card. */
export const billingReviewSchema = z.object({ customerId: z.enum(['acme', 'birch']), expectedVersion: z.number().int().positive(), creditAmount: z.number().nonnegative(), reason: z.string().min(1) }).strict()

/** Build the model-visible page read, including framework context only through a logged tool result.
 * @param business - Refreshed state for the selected customer.
 * @returns Data persisted in the DSH page-read result.
 */
export function pageContext(business: BusinessState): Record<string, unknown> {
  if (business.page === 'portfolio') return {
    page: business.page,
    selectedCustomers: business.portfolioSelected,
    portfolio: Object.fromEntries(business.portfolioSelected.map(customerId => [customerId, { customer: business.data.accounts[customerId].name, quote: business.data.accounts[customerId].quote }])),
    role: business.role,
  }
  if (business.page === 'billing') return {
    page: business.page,
    customerId: business.customerId,
    customer: business.data.accounts[business.customerId].name,
    billing: business.data.accounts[business.customerId].billing,
    role: business.role,
  }
  return { page: business.page, customerId: business.customerId, customer: business.data.accounts[business.customerId].name, selected: business.selected, quote: business.data.accounts[business.customerId].quote, role: business.role }
}

/** Execute existing business commands; never settle the DSH mailbox from a CopilotKit handler.
 * @param business - Live page and customer state, not a historical card snapshot.
 * @param name - Original DSH tool name.
 * @param args - Model arguments validated before writing.
 * @param call - Original pending identity and cancellation signal.
 * @returns Page data or the existing business API outcome.
 */
export async function executeCommand(business: BusinessState, name: string, args: unknown, call: PendingCall): Promise<Record<string, unknown>> {
  if (call.signal.aborted) return { ok: false, code: 'CANCELLED' }
  if (name === 'page_read') {
    const fresh = await readWorkspace(business.workspace)
    return { ok: true, page: business.page, context: pageContext({ ...business, data: fresh }), frameworkContext: business.client.frontendTools.context }
  }
  if (name === 'portfolio_apply') {
    const plan = portfolioPlanSchema.parse(args)
    if (business.page !== 'portfolio' || business.role !== 'editor' || plan.changes.some(change => !business.portfolioSelected.includes(change.customerId))) return { ok: false, code: 'PAGE_CHANGED', error: '批量续约页面或客户选择已变化，请重新读取' }
    return submit(business, { operationId: `${call.sessionId}:${call.callId}`, customerId: plan.changes[0].customerId, kind: 'portfolio_apply', changes: plan.changes }, call.signal)
  }
  if (name === 'billing_apply') {
    const input = argsSchema.parse(args)
    if (business.page !== 'billing' || business.role !== 'editor' || input.customerId !== business.customerId) return { ok: false, code: 'PAGE_CHANGED', error: '账单页面或客户已变化，请重新读取' }
    if (input.expectedVersion === undefined || input.creditAmount === undefined || input.reason === undefined) return { ok: false, code: 'INVALID_CREDIT', error: '账单减免缺少版本、金额或原因' }
    return submit(business, { operationId: `${call.sessionId}:${call.callId}`, customerId: input.customerId, kind: 'billing_apply', expectedVersion: input.expectedVersion, creditAmount: input.creditAmount, reason: input.reason }, call.signal)
  }
  const input = argsSchema.parse(args)
  if (input.customerId !== business.customerId || (name === 'bulk_assign' ? business.page !== 'tickets' : business.page !== 'quote')) return { ok: false, code: 'PAGE_CHANGED', error: '页面或客户已变化，请重新读取' }
  if (name === 'bulk_assign' && (JSON.stringify([...input.ticketIds ?? []].sort()) !== JSON.stringify([...business.selected].sort()))) return { ok: false, code: 'SELECTION_CHANGED', error: '工单选择已变化，未执行操作' }
  const kind = name === 'bulk_assign' ? 'assign' : name === 'quote_patch' ? 'patch' : 'send'
  return submit(business, { ...input, kind, operationId: `${call.sessionId}:${call.callId}` }, call.signal)
}

/** The same version-aware editor appears in the business page and in the approval conversation.
 * @param props - Quote revision, shared save command and interaction availability.
 * @returns A form retaining dirty fields during background refresh.
 */
export function QuoteEditor({ quote, save, disabled = false, labelPrefix = '' }: { quote: Quote; save: (fields: { budget: number; discount: number; expectedVersion: number }) => Promise<Record<string, unknown>>; disabled?: boolean; labelPrefix?: string }): React.ReactElement {
  const [budget, setBudget] = useState(quote.budget)
  const [discount, setDiscount] = useState(quote.discount)
  const [version, setVersion] = useState(quote.version)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => { if (!dirty) { setBudget(quote.budget); setDiscount(quote.discount); setVersion(quote.version) } }, [quote.budget, quote.discount, quote.version, dirty])
  return <form className="quote-editor" onSubmit={event => {
    event.preventDefault(); if (busy) return; setBusy(true)
    void save({ budget, discount, expectedVersion: version }).then(result => { setNotice(result.ok ? '草稿已保存' : String(result.error ?? result.code)); if (result.ok) setDirty(false) }).finally(() => { setBusy(false) })
  }}><div className="field-row"><label>年度预算<input aria-label={`${labelPrefix ? `${labelPrefix} / ` : ''}年度预算`} type="number" min="1000" value={budget} onChange={event => { setBudget(Number(event.target.value)); setDirty(true) }} /></label><label>折扣（%）<input aria-label={`${labelPrefix ? `${labelPrefix} / ` : ''}折扣`} type="number" min="0" max="30" value={discount} onChange={event => { setDiscount(Number(event.target.value)); setDirty(true) }} /></label></div><div className="editor-footer"><span>编辑基于 v{version}{dirty ? ' · 未保存' : ''}</span><button disabled={disabled || busy || !dirty}>保存草稿</button></div>{notice ? <p role="status">{notice}</p> : null}</form>
}

/** A human decision is logged by the DSH question service, not an independent chat conversation.
 * @param props - Original DSH call and optional native CopilotKit response callback.
 * @returns An editable review only while the original Worker waiter is active.
 */
export function ReviewCard({ callId, respond }: { callId: string; respond?: (value: unknown) => Promise<void> }): React.ReactElement {
  const business = useBusiness()
  const calls = useSyncExternalStore(business.client.frontendTools.subscribe, business.client.frontendTools.getSnapshot)
  const call = calls.find(item => item.callId === callId)
  const card = useRef<HTMLElement>(null)
  useEffect(() => { if (call) card.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }) }, [call])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const customerId = business.customerId
  const quote = business.data.accounts[customerId].quote
  const questions = call ? questionSchema.safeParse(call.arguments) : undefined
  const save = (fields: { budget: number; discount: number; expectedVersion: number }): Promise<Record<string, unknown>> => submit(business, { ...fields, customerId, kind: 'patch', operationId: `gui:${crypto.randomUUID()}` }, call?.signal)
  const decide = async (approved: boolean): Promise<void> => {
    if (!call || !questions?.success || busy || call.signal.aborted) return
    setBusy(true)
    const answer = async (): Promise<unknown> => {
      const receipt = await submit(business, { operationId: `${call.sessionId}:${callId}:decision`, customerId, kind: 'approve', expectedVersion: quote.version, approved }, call.signal)
      if (!receipt.ok) throw new Error(String(receipt.error ?? receipt.code))
      return { answers: questions.data.questions.map(question => ({ id: question.id, selected: [approved ? question.options?.find(option => /批准|approve/i.test(option.label))?.label ?? '批准' : question.options?.find(option => /拒绝|reject/i.test(option.label))?.label ?? '拒绝'], custom: `客户 ${customerId}，报价 v${quote.version}，预算 ${quote.budget}，折扣 ${quote.discount}。${approved ? '批准' : '拒绝'}。` })) }
    }
    try {
      if (respond) await respond(await business.client.frontendTools.executeNative(callId, 'ask_user_question', answer))
      else business.client.frontendTools.resolve(callId, await answer())
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) }
  }
  return <article ref={card} className="action-card" data-testid="review-card" data-call-id={callId}><header><span>人工审核</span><small>{call ? '等待您的决定' : '已结束 / 历史记录'}</small></header>{call && questions?.success ? <><p>{questions.data.questions.map(question => question.question).join('；')}</p><p className="review-customer">{business.data.accounts[customerId].name} · 当前报价 v{quote.version}</p><QuoteEditor quote={quote} save={save} disabled={busy} />{error ? <p role="alert">{error}</p> : null}<div className="decision-row"><button className="secondary" disabled={busy} onClick={() => { void decide(false) }}>拒绝方案</button><button disabled={busy} onClick={() => { void decide(true) }}>批准当前版本</button></div></> : <p>决定以 DSH Session 和业务审批记录为准。刷新不会重新执行审批。</p>}</article>
}

/** Reuse the SaaS quote editors for a versioned, server-recorded batch decision.
 * @param props - Original DSH call and optional framework response callback.
 * @returns An editable plan only while its original Worker waiter remains active.
 */
export function PortfolioReviewCard({ callId, respond }: { callId: string; respond?: (value: unknown) => Promise<void> }): React.ReactElement {
  const business = useBusiness()
  const calls = useSyncExternalStore(business.client.frontendTools.subscribe, business.client.frontendTools.getSnapshot)
  const call = calls.find(item => item.callId === callId)
  const card = useRef<HTMLElement>(null)
  const parsed = call ? portfolioPlanSchema.safeParse(call.arguments) : undefined
  const [changes, setChanges] = useState(parsed?.success ? parsed.data.changes : [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (call) card.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }) }, [call])
  useEffect(() => { if (parsed?.success) setChanges(parsed.data.changes) }, [call?.callId])
  const update = (customerId: 'acme' | 'birch', next: { budget: number; discount: number }): Promise<Record<string, unknown>> => {
    setChanges(previous => previous.map(change => change.customerId === customerId ? { ...change, ...next } : change))
    return Promise.resolve({ ok: true })
  }
  const decide = async (approved: boolean): Promise<void> => {
    if (!call || busy || call.signal.aborted) return
    setBusy(true)
    const answer = { approved, changes }
    try {
      const receipt = await submit(business, { operationId: `gui:${call.sessionId}:${callId}:portfolio-decision`, customerId: 'acme', kind: 'portfolio_approve', approved, changes }, call.signal)
      if (!receipt.ok) throw new Error(String(receipt.error ?? receipt.code))
      if (respond) await respond(answer)
      else business.client.frontendTools.resolve(callId, answer)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) }
  }
  return <article ref={card} className="action-card" data-testid="review-card" data-call-id={callId}><header><span>批量续约预览</span><small>{call ? '请检查并确认' : '已结束 / 历史记录'}</small></header>{call && parsed?.success ? <><p>这些报价将使用当前版本提交，您可以先修改预览中的字段。</p>{changes.map(change => { const account = business.data.accounts[change.customerId]; const quote = { ...account.quote, budget: change.budget, discount: change.discount }; return <section className="portfolio-review" key={change.customerId}><h3>{account.name}</h3><QuoteEditor labelPrefix={account.name} quote={quote} save={fields => update(change.customerId, { budget: fields.budget, discount: fields.discount })} disabled={busy} /></section> })}{error ? <p role="alert">{error}</p> : null}<div className="decision-row"><button className="secondary" disabled={busy} onClick={() => { void decide(false) }}>拒绝批量方案</button><button disabled={busy} onClick={() => { void decide(true) }}>批准批量方案</button></div></> : <p>决定以 DSH Session 和业务凭据为准。刷新不会重新执行批量提交。</p>}</article>
}

/** The existing billing editor reused inside the business page and Agent approval card. */
export function BillingEditor({ billing, save, disabled = false }: { billing: BillingCase; save: (fields: { creditAmount: number; reason: string; expectedVersion: number }) => Promise<Record<string, unknown>>; disabled?: boolean }): React.ReactElement {
  const [creditAmount, setCreditAmount] = useState(billing.creditAmount)
  const [reason, setReason] = useState(billing.reason)
  const [version, setVersion] = useState(billing.version)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => { if (!dirty) { setCreditAmount(billing.creditAmount); setReason(billing.reason); setVersion(billing.version) } }, [billing.creditAmount, billing.reason, billing.version, dirty])
  return <form className="billing-editor" onSubmit={event => {
    event.preventDefault(); if (busy) return; setBusy(true)
    void save({ creditAmount, reason, expectedVersion: version }).then(result => { setNotice(result.ok ? '减免草稿已保存' : String(result.error ?? result.code)); if (result.ok) setDirty(false) }).finally(() => { setBusy(false) })
  }}><div className="field-row"><label>减免金额<input aria-label="账单减免金额" type="number" min="0" max={billing.disputed} value={creditAmount} onChange={event => { setCreditAmount(Number(event.target.value)); setDirty(true) }} /></label><label>争议金额<span className="field-value">¥{billing.disputed.toLocaleString()}</span></label></div><label className="field-label">减免原因<textarea aria-label="账单减免原因" rows={3} value={reason} onChange={event => { setReason(event.target.value); setDirty(true) }} /></label><div className="editor-footer"><span>发票 {billing.invoiceId} · 基于 v{version}{dirty ? ' · 未保存' : ''}</span><button disabled={disabled || busy || !dirty}>保存减免草稿</button></div>{notice ? <p role="status">{notice}</p> : null}</form>
}

/** Reuse the billing editor as a CopilotKit or DSH human approval surface. */
export function BillingReviewCard({ callId, respond }: { callId: string; respond?: (value: unknown) => Promise<void> }): React.ReactElement {
  const business = useBusiness()
  const calls = useSyncExternalStore(business.client.frontendTools.subscribe, business.client.frontendTools.getSnapshot)
  const call = calls.find(item => item.callId === callId)
  const card = useRef<HTMLElement>(null)
  const parsed = call ? billingReviewSchema.safeParse(call.arguments) : undefined
  const [plan, setPlan] = useState(parsed?.success ? parsed.data : undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (call) card.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }) }, [call])
  useEffect(() => { if (parsed?.success) setPlan(parsed.data) }, [call?.callId])
  const billing = business.data.accounts[business.customerId].billing
  const decide = async (approved: boolean): Promise<void> => {
    if (!call || !plan || busy || call.signal.aborted) return
    setBusy(true)
    const answer = { approved, ...plan }
    try {
      const receipt = await submit(business, { operationId: `gui:${call.sessionId}:${callId}:billing-decision`, customerId: plan.customerId, kind: 'billing_approve', expectedVersion: plan.expectedVersion, creditAmount: plan.creditAmount, reason: plan.reason, approved }, call.signal)
      if (!receipt.ok) throw new Error(String(receipt.error ?? receipt.code))
      if (respond) await respond(answer)
      else business.client.frontendTools.resolve(callId, answer)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) }
  }
  const editedBilling = plan ? { ...billing, creditAmount: plan.creditAmount, reason: plan.reason, version: plan.expectedVersion } : billing
  return <article ref={card} className="action-card" data-testid="billing-review-card" data-call-id={callId}><header><span>账单减免预览</span><small>{call ? '请检查并确认' : '已结束 / 历史记录'}</small></header>{call && plan ? <><p>减免金额不能超过当前争议金额；批准后 Agent 才能提交。</p><BillingEditor billing={editedBilling} save={fields => { setPlan(previous => previous ? { ...previous, creditAmount: fields.creditAmount, reason: fields.reason } : previous); return Promise.resolve({ ok: true }) }} disabled={busy} />{error ? <p role="alert">{error}</p> : null}<div className="decision-row"><button className="secondary" disabled={busy} onClick={() => { void decide(false) }}>拒绝账单减免</button><button disabled={busy} onClick={() => { void decide(true) }}>批准账单减免</button></div></> : <p>决定以 DSH Session 和业务凭据为准。刷新不会重新执行账单减免。</p>}</article>
}

const names: Record<string, string> = { page_read: '读取当前页面', bulk_assign: '批量分配工单', quote_patch: '调整报价草稿', quote_send: '发送已审批报价', portfolio_apply: '提交批量续约方案', billing_apply: '提交账单减免' }
/** Render actual DSH results; historical cards never replay business operations.
 * @param props - Original call id and tool name.
 * @returns Shared tool status or an active human review card.
 */
export function ToolCard({ callId, name }: { callId: string; name: string }): React.ReactElement {
  const { client } = useBusiness()
  const calls = useSyncExternalStore(client.frontendTools.subscribe, client.frontendTools.getSnapshot)
  const state = useSyncExternalStore(listener => client.binding.eventSource.subscribe(listener), () => client.binding.eventSource.getSnapshot())
  if (name === 'ask_user_question') return <ReviewCard callId={callId} />
  if (name === 'portfolio_review') return <PortfolioReviewCard callId={callId} />
  if (name === 'billing_review') return <BillingReviewCard callId={callId} />
  const result = state.entries.findLast(entry => entry.type === 'event' && entry.event.type === 'tool/result' && String(entry.event.data.message.toolCallId) === callId)
  const value = result?.type === 'event' && result.event.type === 'tool/result' ? result.event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') : ''
  let summary = calls.some(call => call.callId === callId) ? '执行中…' : '已中断 / 等待记录'
  if (value) { try { const parsed = JSON.parse(value) as Record<string, unknown>; summary = parsed.ok === false ? String(parsed.error ?? parsed.code) : name === 'page_read' ? '页面与业务上下文已写入 DSH Session' : '业务操作已完成，凭据已记录' } catch { summary = value.slice(0, 180) } }
  return <article className="action-card compact" data-tool={name} data-call-id={callId}><header><span>{names[name] ?? name}</span><small>{callId.slice(-8)}</small></header><p>{summary}</p></article>
}
