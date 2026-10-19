/** Existing mock SaaS workspace with exactly one URL-selected chat presentation. */
import './symbol-dispose.ts'
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import '@copilotkit/react-core/v2/styles.css'
import { bootBrowserNativeDshClient, type BrowserNativeDshClient } from './dsh-client.ts'
import { AssistantLayer, CopilotLayer, NativeLayer } from './chat.tsx'
import { Business, executeCommand, pageContext, QuoteEditor, readWorkspace, submit, type BusinessState } from './business.tsx'
import type { Database } from './domain.ts'
import './styles.css'

const query = new URLSearchParams(location.search)
const ui = query.get('ui') ?? 'copilot'
if (!['native', 'assistant', 'copilot'].includes(ui)) throw new Error('未知聊天路线')
const workspace = query.get('workspace') ?? `complex-${ui}`

function Workbench({ client, data, refresh }: { client: BrowserNativeDshClient; data: Database; refresh(): Promise<void> }): React.ReactElement {
  const [page, setPage] = useState<'tickets' | 'quote' | 'portfolio'>('tickets')
  const [customerId, setCustomer] = useState<'acme' | 'birch'>('acme')
  const [role, setRole] = useState<'editor' | 'viewer'>('editor')
  const [selected, setSelected] = useState(['TK-41', 'TK-42'])
  const [portfolioSelected, setPortfolioSelected] = useState<Array<'acme' | 'birch'>>(['acme', 'birch'])
  const [notice, setNotice] = useState('')
  const business = useMemo(() => ({ client, data, workspace, page, customerId, role, selected, portfolioSelected, refresh }), [client, data, page, customerId, role, selected, portfolioSelected, refresh])
  const latest = useRef<BusinessState>(business)
  latest.current = business
  const pending = useSyncExternalStore(client.frontendTools.subscribe, client.frontendTools.getSnapshot)
  const ownershipError = useSyncExternalStore(client.subscribeOwnership, client.ownershipError)
  useEffect(() => {
    const unregister = ['page_read', 'bulk_assign', 'quote_patch', 'quote_send', 'portfolio_review', 'portfolio_apply', 'ask_user_question'].map(name => client.frontendTools.register(name, (args, call) => {
      if (ui === 'copilot' || name === 'ask_user_question' || name === 'portfolio_review') return undefined
      client.frontendTools.context = [{ description: '当前 SaaS 页面', value: { page: latest.current.page, ...pageContext(latest.current) } }]
      client.frontendTools.executions.push({ callId: call.callId, name, channel: ui })
      return executeCommand(latest.current, name, args, call)
    }))
    Object.defineProperty(window, '__complexEvidence', { configurable: true, get: () => ({ executions: client.frontendTools.executions, pending: client.frontendTools.getSnapshot().map(call => ({ callId: call.callId, name: call.name })), page: latest.current.page, customerId: latest.current.customerId }) })
    return () => { for (const dispose of unregister) dispose(); delete (window as Window & { __complexEvidence?: unknown }).__complexEvidence }
  }, [client])
  useEffect(() => { client.worker.postMessage({ type: 'saas-capabilities', page, role }) }, [client, page, role])
  const account = data.accounts[customerId]
  const changeCustomer = (value: 'acme' | 'birch'): void => { setCustomer(value); setSelected([]) }
  return <Business.Provider value={business}><div className="complex-app" data-testid="complex-ready" data-ui={ui}>
    <header className="app-header"><a className="brand" href="?ui=copilot">Orbit<span>客户运营</span></a><div className="route-tabs">{[['native', 'DSH 原生'], ['assistant', 'assistant-ui'], ['copilot', 'CopilotKit']].map(([route, label]) => <a key={route} aria-current={ui === route ? 'page' : undefined} href={`?ui=${route}`}>{label}</a>)}</div><label className="role-picker">模拟角色<select aria-label="模拟角色" value={role} disabled={pending.length > 0} onChange={event => { setRole(event.target.value as 'editor' | 'viewer') }}><option value="editor">可操作</option><option value="viewer">只读</option></select></label></header>
    <div className="app-layout"><main className="business-page"><div className="page-heading"><div><p>客户续约协作</p><h1>{page === 'portfolio' ? '续约组合工作台' : account.name}</h1></div>{page === 'portfolio' ? <span className="status-badge">已选 {portfolioSelected.length} 个客户</span> : <select aria-label="当前客户" disabled={pending.length > 0} value={customerId} onChange={event => { changeCustomer(event.target.value as 'acme' | 'birch') }}><option value="acme">青禾科技</option><option value="birch">白桦设计</option></select>}</div><div className="page-tabs"><button className={page === 'tickets' ? 'active' : 'secondary'} disabled={pending.length > 0} onClick={() => { setPage('tickets') }}>支持工单</button><button className={page === 'quote' ? 'active' : 'secondary'} disabled={pending.length > 0} onClick={() => { setPage('quote') }}>续约报价</button><button className={page === 'portfolio' ? 'active' : 'secondary'} disabled={pending.length > 0} onClick={() => { setPage('portfolio') }}>续约组合</button></div>
      {page === 'tickets' ? <section className="business-section"><div className="section-heading"><h2>待处理工单</h2><span>已选择 {selected.length} 项</span></div><table><thead><tr><th>选择</th><th>工单</th><th>负责人</th></tr></thead><tbody>{account.tickets.map(ticket => <tr key={ticket.id}><td><input type="checkbox" aria-label={`选择 ${ticket.id}`} checked={selected.includes(ticket.id)} onChange={event => { setSelected(previous => event.target.checked ? [...previous, ticket.id] : previous.filter(id => id !== ticket.id)) }} /></td><td><small>{ticket.id}</small><span>{ticket.title}</span></td><td data-testid={`assignee-${ticket.id}`}>{ticket.assignee}</td></tr>)}</tbody></table><button className="secondary" disabled={role !== 'editor' || !selected.length} onClick={() => { void submit(business, { operationId: `gui:${crypto.randomUUID()}`, customerId, kind: 'assign', ticketIds: selected, assignee: '周宁' }).then(result => { setNotice(result.ok ? '所选工单已分配给周宁' : String(result.error)) }) }}>分配所选给周宁</button><p className="muted">可以使用已有 GUI，也可以让右侧助手调用相同业务命令。</p></section> : page === 'quote' ? <section className="business-section" data-testid="quote-page"><div className="section-heading"><h2>年度续约报价</h2><span className="status-badge">{account.quote.status === 'sent' ? '已发送' : '草稿'} · v{account.quote.version}</span></div><div className="quote-total">¥{Math.round(account.quote.budget * (1 - account.quote.discount / 100)).toLocaleString()}<small>折扣后年度金额</small></div><QuoteEditor key={customerId} quote={account.quote} disabled={role !== 'editor' || account.quote.status === 'sent'} save={fields => submit(business, { ...fields, operationId: `gui:${crypto.randomUUID()}`, customerId, kind: 'patch' })} /><div className="approval-state">审批：{account.quote.approval ? `${account.quote.approval.approved ? '批准' : '拒绝'} v${account.quote.version}` : '尚未批准当前版本'}</div></section> : <PortfolioPage business={business} selected={portfolioSelected} setSelected={setPortfolioSelected} />}
      {notice ? <p role="status">{notice}</p> : null}<section className="audit-section"><h2>业务审计</h2><p><span data-testid="write-count">{data.writes}</span> 次成功写入 · {Object.keys(data.receipts).length} 份幂等凭据</p><ol>{Object.values(data.receipts).slice(-5).reverse().map(({ receipt }) => <li key={receipt.operationId}><span>{receipt.kind} · {data.accounts[receipt.customerId].name}</span><small>{receipt.operationId.slice(-28)}</small></li>)}</ol></section><p className="muted">等待人工审核时，请先完成或停止操作，再切换页面与客户。</p>
    </main><aside className={`chat-panel route-${ui}`}><header className="chat-header"><div><span className="online-dot" /><h2>业务协作助手</h2></div><button className="secondary" onClick={() => { client.startNewSession() }}>新会话</button></header><div className="context-strip">{page === 'portfolio' ? `续约组合 / ${portfolioSelected.length} 个客户` : `${account.name} / ${page === 'tickets' ? '支持工单' : '续约报价'}`}<small>{ui === 'copilot' ? '原生前端工具与人工介入' : 'DSH Session 事件投影'}</small></div><div className="chat-body" inert={ownershipError !== undefined}>{ui === 'copilot' ? <CopilotLayer /> : ui === 'assistant' ? <AssistantLayer /> : <NativeLayer />}</div>{ownershipError ? <p role="alert">会话写权不可用：{ownershipError}</p> : null}<footer>执行由 Browser-Native DSH 负责 · 重要操作需要人工确认</footer></aside></div>
  </div></Business.Provider>
}

function PortfolioPage({ business, selected, setSelected }: { business: BusinessState; selected: Array<'acme' | 'birch'>; setSelected: React.Dispatch<React.SetStateAction<Array<'acme' | 'birch'>>> }): React.ReactElement {
  return <section className="business-section portfolio-page" data-testid="portfolio-page"><div className="section-heading"><h2>批量续约方案</h2><span>{selected.length} 个客户</span></div><p className="muted">选择多个客户后，助手可以把现有报价编辑器带入聊天，先生成可修改的预览，再等待批准。</p>{(['acme', 'birch'] as const).map(customerId => { const account = business.data.accounts[customerId]; return <article className="portfolio-account" key={customerId}><label><input type="checkbox" aria-label={`选择客户 ${account.name}`} checked={selected.includes(customerId)} onChange={event => { setSelected(previous => event.target.checked ? [...previous, customerId] : previous.filter(value => value !== customerId)) }} />{account.name}</label><span>报价 v{account.quote.version} · ¥{account.quote.budget.toLocaleString()} · 折扣 {account.quote.discount}%</span></article> })}</section>
}

function App({ client }: { client: BrowserNativeDshClient }): React.ReactElement {
  const [data, setData] = useState<Database>()
  const [error, setError] = useState('')
  const refresh = useCallback(async () => { setData(await readWorkspace(workspace)) }, [])
  useEffect(() => { void refresh().catch(reason => { setError(String(reason)) }) }, [refresh])
  return error ? <p role="alert">{error}</p> : data ? <Workbench client={client} data={data} refresh={refresh} /> : <p>正在读取业务数据…</p>
}

void bootBrowserNativeDshClient().then(client => {
  const root = document.getElementById('root')
  if (!root) throw new Error('页面根节点不存在')
  createRoot(root).render(<App client={client} />)
}).catch(error => { const root = document.getElementById('root'); if (root) root.textContent = `启动失败：${String(error)}`; console.error(error) })
