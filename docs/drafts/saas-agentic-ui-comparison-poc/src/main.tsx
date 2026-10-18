import './symbol-dispose.ts'
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import '@copilotkit/react-core/v2/styles.css'
import { bootBrowserNativeDshClient, type BrowserNativeDshClient } from './dsh-client.ts'
import { Business, BusinessWorkbench, readWorkspace } from './business-ui.tsx'
import { AssistantChat, CopilotChatLayer, NativeChat } from './chat-layers.tsx'
import type { Workspace } from './domain.ts'
import { fieldsSchema } from './schemas.ts'
import './styles.css'

const query = new URLSearchParams(location.search)
const ui = query.get('ui') ?? 'native'
if (!['native', 'assistant', 'copilot'].includes(ui)) throw new Error('ui 必须是 native / assistant / copilot')
const workspaceId = query.get('workspace') ?? `comparison-${ui}`

function App({ client }: { client: BrowserNativeDshClient }): React.ReactElement {
  const [snapshot, setSnapshot] = useState<Workspace>()
  const [role, setRole] = useState(query.get('role') ?? 'editor')
  const [error, setError] = useState('')
  const ownershipError = useSyncExternalStore(client.subscribeOwnership, client.ownershipError)
  const refresh = useCallback(async () => { setSnapshot(await readWorkspace(workspaceId)) }, [])
  const business = useMemo(() => ({ client, workspaceId, role, snapshot, refresh }), [client, role, snapshot, refresh])
  useEffect(() => { void refresh().catch(reason => { setError(String(reason)) }) }, [refresh])
  useEffect(() => {
    const dispose = client.frontendTools.register('saas_read_workspace', async () => ({ ...await readWorkspace(workspaceId), role }))
    const waits = ['saas_create_task', 'saas_update_ticket', 'saas_approve_invoice'].map(name => client.frontendTools.register(name, args => { fieldsSchema.parse(args); return undefined }))
    waits.push(client.frontendTools.register('ask_user_question', () => undefined))
    return () => { dispose(); for (const wait of waits) wait() }
  }, [client, role])
  return <Business.Provider value={business}><div className="saas-shell" data-testid="comparison-ready" data-ui={ui}>
    <header className="topbar"><a className="brand" href="?ui=native"><span>◈</span> orbit<span className="brand-sub">OPERATIONS</span></a><nav><a className="active">工作台</a><a>项目</a><a>客户</a><a>财务</a></nav><label className="role-select">模拟角色<select aria-label="模拟角色" value={role} onChange={event => { setRole(event.target.value) }}><option value="editor">可操作</option><option value="viewer">只读</option></select></label><span className="avatar">林</span></header>
    <div className="experiment-bar"><span>同口径实验</span>{[['native', 'DSH 原生 UI'], ['assistant', 'assistant-ui'], ['copilot', 'CopilotKit']].map(([key, name]) => <a key={key} className={ui === key ? 'selected' : ''} href={`?ui=${key}`}>{name}</a>)}<small>相同 API · 相同表单 · 相同 DSH Loop</small></div>
    {error ? <p role="alert">{error}</p> : null}
    <div className="workspace-layout"><BusinessWorkbench /><aside className={`chat-panel route-${ui}`}><header className="chat-header"><div><span className="agent-mark">✧</span><strong>业务助手</strong><span className="live-dot" /></div><button className="secondary" onClick={() => { client.startNewSession() }}>新会话</button></header><div className="chat-meta">{ui === 'native' ? 'DSH 原生聊天与工具 slot' : ui === 'assistant' ? 'assistant-ui · ExternalStoreRuntime' : 'CopilotKit v2 · AG-UI projection'}<small title={String(client.binding.sessionId)}>{String(client.binding.sessionId).slice(0, 24)}…</small></div>
      <section className="chat-body" inert={ownershipError !== undefined}>{snapshot === undefined ? <p>加载业务数据…</p> : ui === 'native' ? <NativeChat /> : ui === 'assistant' ? <AssistantChat /> : <CopilotChatLayer />}</section>
      {ownershipError ? <p role="alert">会话写权不可用：{ownershipError}。关闭其他标签页后刷新。</p> : null}
      <footer className="chat-footnote">操作前请核对字段 · 重要业务需要您确认</footer>
    </aside></div>
  </div></Business.Provider>
}

void bootBrowserNativeDshClient().then(client => {
  const root = document.getElementById('root')
  if (root === null) throw new Error('app root missing')
  createRoot(root).render(<App client={client} />)
}).catch(error => { const root = document.getElementById('root'); if (root !== null) root.textContent = `启动失败：${String(error)}`; console.error(error) })
