/** Existing SaaS forms and API client, shared by GUI dialogs and agent tool cards. */
import React, { createContext, useCallback, useContext, useState, useSyncExternalStore } from 'react'
import type { BusinessFields, OperationKind, Receipt, Workspace } from './domain.ts'
import type { BrowserNativeDshClient } from './dsh-client.ts'
import type { PendingCall } from './frontend-bridge.ts'
import { fieldsSchema } from './schemas.ts'

export interface BusinessContext {
  client: BrowserNativeDshClient
  workspaceId: string
  role: string
  snapshot: Workspace | undefined
  refresh(): Promise<void>
}
export const Business = createContext<BusinessContext | null>(null)
export function useBusiness(): BusinessContext {
  const business = useContext(Business)
  if (business === null) throw new Error('missing SaaS provider')
  return business
}

export async function readWorkspace(workspaceId: string): Promise<Workspace> {
  const response = await fetch(`/api/saas/${encodeURIComponent(workspaceId)}/snapshot`)
  if (!response.ok) throw new Error(`读取业务数据失败：${response.status}`)
  return await response.json() as Workspace
}

export async function submitBusiness(workspaceId: string, role: string, operationId: string, kind: OperationKind, fields: BusinessFields, signal?: AbortSignal): Promise<unknown> {
  try {
    const response = await fetch(`/api/saas/${encodeURIComponent(workspaceId)}/operations`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-mock-role': role },
      body: JSON.stringify({ operationId, kind, fields }), signal,
    })
    return await response.json()
  } catch (error) {
    const receipt = await fetch(`/api/saas/${encodeURIComponent(workspaceId)}/receipts/${encodeURIComponent(operationId)}`)
    if (receipt.ok) return await receipt.json()
    throw error
  }
}

export function BusinessForm({ kind, initial, busy, onConfirm, onCancel }: {
  kind: OperationKind; initial: BusinessFields; busy: boolean
  onConfirm(fields: BusinessFields): void; onCancel(): void
}): React.ReactElement {
  const [fields, setFields] = useState(initial)
  const { snapshot } = useBusiness()
  const set = (key: keyof BusinessFields, value: string): void => { setFields(current => ({ ...current, [key]: value })) }
  const invoice = snapshot?.invoices.find(value => value.id === initial.id)
  return <form className="business-form" data-testid="business-form" onSubmit={event => { event.preventDefault(); onConfirm(fields) }}>
    {kind === 'create_task' ? <label>任务标题<input aria-label="任务标题" required maxLength={120} value={fields.title ?? ''} onChange={event => { set('title', event.target.value) }} /></label> : <p className="record-id">{initial.id} · 版本 {initial.expectedVersion}</p>}
    {kind === 'approve_invoice' ? <div className="invoice-confirm"><span>{invoice?.customer ?? '请核对账单'}</span><strong>¥{invoice?.amount.toLocaleString() ?? '—'}</strong><p>批准将写入业务系统，助手不能代替您确认。</p></div> : <>
      <div className="form-grid"><label>负责人<select aria-label="负责人" value={fields.assignee ?? '林悦'} onChange={event => { set('assignee', event.target.value) }}>{['林悦', '陈晨', '周宁'].map(name => <option key={name}>{name}</option>)}</select></label>
      <label>优先级<select aria-label="优先级" value={fields.priority ?? 'medium'} onChange={event => { set('priority', event.target.value) }}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label></div>
      {kind === 'update_ticket' ? <label>工单状态<select aria-label="工单状态" value={fields.status ?? 'open'} onChange={event => { set('status', event.target.value) }}><option value="open">待处理</option><option value="in_progress">处理中</option><option value="resolved">已解决</option></select></label> : null}
    </>}
    <div className="form-actions"><button type="button" className="secondary" disabled={busy} onClick={onCancel}>取消操作</button><button type="submit" disabled={busy}>{busy ? '提交中…' : kind === 'approve_invoice' ? '确认批准' : '确认保存'}</button></div>
  </form>
}

const names: Record<string, string> = { saas_read_workspace: '读取业务工作台', saas_create_task: '创建项目任务', saas_update_ticket: '处理支持工单', saas_approve_invoice: '审批客户账单', ask_user_question: '需要您确认' }
const kinds: Record<string, OperationKind> = { saas_create_task: 'create_task', saas_update_ticket: 'update_ticket', saas_approve_invoice: 'approve_invoice' }

export function BusinessToolCard({ callId, name }: { callId: string; name: string }): React.ReactElement {
  const business = useBusiness()
  const pending = useSyncExternalStore(business.client.frontendTools.subscribe, business.client.frontendTools.getSnapshot)
  const source = business.client.binding.eventSource
  const events = useSyncExternalStore(useCallback(listener => source.subscribe(listener), [source]), useCallback(() => source.getSnapshot(), [source]))
  const call = pending.find(value => value.callId === callId)
  const result = events.entries.findLast(entry => entry.type === 'event' && entry.event.type === 'tool/result' && String(entry.event.data.message.toolCallId) === callId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const kind = kinds[name]
  const initial = call !== undefined && kind !== undefined ? fieldsSchema.safeParse(call.arguments) : undefined
  const confirm = async (fields: BusinessFields): Promise<void> => {
    if (call === undefined || call.signal.aborted || busy || kind === undefined) return
    setBusy(true)
    try {
      const response = await submitBusiness(business.workspaceId, business.role, `${call.sessionId}:${call.callId}`, kind, fields, call.signal)
      business.client.frontendTools.resolve(call.callId, response)
      await business.refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }
  const text = result?.type === 'event' && result.event.type === 'tool/result'
    ? result.event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') : undefined
  let summary: string | undefined
  if (text !== undefined) {
    try {
      const value = JSON.parse(text) as { ok?: boolean; cancelled?: boolean; error?: string; record?: { title?: string; status?: string; id?: string } }
      summary = value.cancelled ? '您已取消，未写入业务系统' : value.ok === false ? `未执行：${value.error}` : name === 'saas_read_workspace' ? '已读取任务、工单和账单，数据已进入 DSH Session' : `已完成 · ${value.record?.title ?? value.record?.id ?? ''} ${value.record?.status ?? ''}`
    } catch (reason) { summary = text }
  }
  return <article className="business-tool" data-testid="business-tool" data-call-id={callId} data-tool={name}>
    <div className="tool-heading"><span className="tool-icon">◇</span><strong>{names[name] ?? name}</strong><small>{call === undefined ? result === undefined ? '等待 / 已中断' : '已记录' : '等待确认'}</small></div>
    {error ? <p role="alert">{error}。可重试同一操作，或取消。</p> : null}
    {call !== undefined && kind !== undefined ? initial?.success === true ? <BusinessForm key={callId} kind={kind} initial={initial.data} busy={busy} onConfirm={fields => { void confirm(fields) }} onCancel={() => { business.client.frontendTools.resolve(callId, { ok: false, cancelled: true, error: '用户取消，未执行操作' }) }} /> : <p role="alert">业务参数无效，未打开操作表单。</p>
      : call !== undefined && name === 'ask_user_question' ? <QuestionForm call={call} />
        : <p className="tool-summary">{summary ?? (name === 'saas_read_workspace' ? '正在读取业务 API…' : '当前页面没有可结算的调用。刷新中断的操作需要重新发起；不会重放副作用。')}</p>}
  </article>
}

function QuestionForm({ call }: { call: PendingCall }): React.ReactElement {
  const { client } = useBusiness()
  const [answer, setAnswer] = useState('')
  const questions = call.arguments as { questions: { id: string; question: string }[] }
  return <form onSubmit={event => { event.preventDefault(); client.frontendTools.resolve(call.callId, { answers: questions.questions.map(question => ({ id: question.id, selected: [], custom: answer })) }) }}><p>{questions.questions.map(question => question.question).join('；')}</p><input aria-label="回答" required value={answer} onChange={event => { setAnswer(event.target.value) }} /><button>提交回答</button></form>
}

export function BusinessWorkbench(): React.ReactElement {
  const business = useBusiness()
  const [dialog, setDialog] = useState<{ kind: OperationKind; fields: BusinessFields; operationId: string }>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const open = (kind: OperationKind, fields: BusinessFields): void => { setDialog({ kind, fields, operationId: `gui:${crypto.randomUUID()}` }) }
  const confirm = async (fields: BusinessFields): Promise<void> => {
    if (!dialog || busy) return
    setBusy(true)
    try {
      const result = await submitBusiness(business.workspaceId, business.role, dialog.operationId, dialog.kind, fields) as Receipt & { error?: string }
      setNotice(result.ok ? `已保存 · 凭据 ${result.operationId}` : result.error ?? '操作未完成')
      if (result.ok) setDialog(undefined)
      await business.refresh()
    } catch (error) { setNotice(String(error)) }
    finally { setBusy(false) }
  }
  const snapshot = business.snapshot
  return <main className="workbench">
    <div className="page-title"><div><span className="eyebrow">WORKSPACE / OCTOBER 2026</span><h1>客户运营工作台</h1><p>既有业务页面。手动操作与助手调用同一组件、同一 API。</p></div><button onClick={() => { open('create_task', { title: '', assignee: '林悦', priority: 'medium' }) }}>＋ 新建任务</button></div>
    <section className="metrics"><div><span>项目任务</span><strong>{snapshot?.tasks.length ?? '—'}</strong><small>客户门户交付</small></div><div><span>支持工单</span><strong>{snapshot?.tickets.filter(ticket => ticket.status !== 'resolved').length ?? '—'}</strong><small>需要团队跟进</small></div><div><span>待审批金额</span><strong>¥{snapshot?.invoices.filter(invoice => invoice.status === 'pending').reduce((sum, invoice) => sum + invoice.amount, 0).toLocaleString() ?? '—'}</strong><small>需人工确认</small></div></section>
    <section className="data-panel"><header><h2>项目任务</h2><span>客户门户 / 本月交付</span></header><table><thead><tr><th>任务</th><th>负责人</th><th>优先级</th></tr></thead><tbody>{snapshot?.tasks.map(task => <tr key={task.id}><td>{task.title}<small>{task.id}</small></td><td>{task.assignee}</td><td><span className={`tag ${task.priority}`}>{task.priority}</span></td></tr>)}</tbody></table></section>
    <section className="data-panel"><header><h2>支持工单</h2><span>客户成功</span></header>{snapshot?.tickets.map(ticket => <div className="record-row" key={ticket.id}><div><strong>{ticket.title}</strong><small>{ticket.id} · {ticket.assignee} · {ticket.status} · v{ticket.version}</small></div><button className="secondary" onClick={() => { open('update_ticket', { id: ticket.id, expectedVersion: ticket.version, assignee: ticket.assignee as BusinessFields['assignee'], priority: ticket.priority as BusinessFields['priority'], status: ticket.status as BusinessFields['status'] }) }}>处理工单</button></div>)}</section>
    <section className="data-panel"><header><h2>账单审批</h2><span>财务中心</span></header>{snapshot?.invoices.map(invoice => <div className="record-row" key={invoice.id}><div><strong>{invoice.customer} · ¥{invoice.amount.toLocaleString()}</strong><small>{invoice.id} · {invoice.status} · v{invoice.version}</small></div><button className="secondary" disabled={invoice.status !== 'pending'} onClick={() => { open('approve_invoice', { id: invoice.id, expectedVersion: invoice.version }) }}>审批账单</button></div>)}</section>
    <p className="audit-count" data-testid="receipt-count">业务凭据：{Object.keys(snapshot?.receipts ?? {}).length} · workspace: {business.workspaceId}</p>
    {notice ? <p role="status">{notice}</p> : null}
    {dialog ? <div className="dialog-backdrop"><section className="business-dialog" role="dialog" aria-label="业务操作"><h2>业务操作</h2><BusinessForm key={dialog.operationId} kind={dialog.kind} initial={dialog.fields} busy={busy} onConfirm={fields => { void confirm(fields) }} onCancel={() => { setDialog(undefined) }} /></section></div> : null}
  </main>
}
