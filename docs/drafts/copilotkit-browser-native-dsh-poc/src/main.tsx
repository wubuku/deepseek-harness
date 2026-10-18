import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  CopilotChat,
  CopilotKitProvider,
  useRenderTool,
  useFrontendTool,
} from '@copilotkit/react-core/v2'
import { z } from 'zod'
import '@copilotkit/react-core/v2/styles.css'
import { bootBrowserNativeDshClient, type BrowserNativeDshClient } from './dsh-client.ts'
import { DshAgUiAgent } from './dsh-agui-agent.ts'
import {
  initialSaaSWorkspace,
  loadSaaSWorkspace,
  resetSaaSWorkspace,
  saveSaaSWorkspace,
  SaaSWorkspacePanel,
  WorkItemSummary,
  type SaaSWorkItem,
  type SaaSWorkspaceSnapshot,
  type WorkItemPriority,
} from './saas-workspace.tsx'
import { createSaaSWorkItem } from './saas-workspace-model.ts'
import './styles.css'

interface AppState {
  readonly client: BrowserNativeDshClient
  readonly agent: DshAgUiAgent
}

const probeParameters = z.object({ label: z.string() })
const questionParameters = z.object({
  questions: z.array(z.object({
    id: z.string(),
    question: z.string(),
    header: z.string().optional(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
    multi_select: z.boolean().optional(),
  })),
})
const workspaceParameters = z.object({})
const createWorkItemParameters = z.object({
  projectId: z.string(),
  title: z.string(),
  priority: z.string(),
  assignee: z.string(),
})

function resolveProjectId(workspace: SaaSWorkspaceSnapshot, value: string): string {
  const normalized = value.trim().toLocaleLowerCase()
  return workspace.projects.find(project => project.id.toLocaleLowerCase() === normalized
    || project.name.toLocaleLowerCase() === normalized)?.id
    ?? workspace.projects[0]?.id
    ?? value
}

function resultRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function SaaSWorkItemActionCard({
  client,
  workspace,
  setWorkspace,
  toolCallId,
  parameters,
}: {
  readonly client: BrowserNativeDshClient
  readonly workspace: SaaSWorkspaceSnapshot
  readonly setWorkspace: React.Dispatch<React.SetStateAction<SaaSWorkspaceSnapshot>>
  readonly toolCallId: string
  readonly parameters: z.infer<typeof createWorkItemParameters>
}): JSX.Element {
  const [projectId, setProjectId] = useState(() => resolveProjectId(workspace, parameters.projectId))
  const [title, setTitle] = useState(parameters.title)
  const [priority, setPriority] = useState<WorkItemPriority>(
    ['High', 'Medium', 'Low'].find(value => value.toLowerCase() === parameters.priority.toLowerCase()) as WorkItemPriority | undefined ?? 'Medium',
  )
  const [assignee, setAssignee] = useState(parameters.assignee)
  const [submitting, setSubmitting] = useState(false)
  const project = workspace.projects.find(candidate => candidate.id === projectId)
  const assignees = [...new Set(['You', ...workspace.workItems.map(item => item.assignee), assignee])]
  const preview: Pick<SaaSWorkItem, 'title' | 'priority' | 'assignee' | 'status'> = {
    title,
    priority,
    assignee,
    status: 'Planned',
  }

  const commit = (): void => {
    if (submitting) return
    if (title.trim().length === 0 || project === undefined) return
    setSubmitting(true)
    try {
      const created = createSaaSWorkItem(
        workspace,
        {
          projectId,
          title: title.trim(),
          priority,
          assignee,
          userEditedFields: [
            ...(projectId !== resolveProjectId(workspace, parameters.projectId) ? ['project'] : []),
            ...(title.trim() !== parameters.title.trim() ? ['title'] : []),
            ...(priority.toLowerCase() !== parameters.priority.toLowerCase() ? ['priority'] : []),
            ...(assignee !== parameters.assignee ? ['assignee'] : []),
          ],
        },
        `work-${globalThis.crypto.randomUUID().slice(0, 8)}`,
        `saas-create:${toolCallId}`,
      )
      saveSaaSWorkspace(created.workspace)
      setWorkspace(created.workspace)
      client.frontendTools.resolve(toolCallId, created.result)
        || client.frontendTools.resolveLatest('saas_create_work_item', String(client.binding.sessionId), created.result)
    } catch (error) {
      setSubmitting(false)
      const reason = error instanceof Error ? error : new Error(String(error))
      client.frontendTools.reject(toolCallId, reason)
        || client.frontendTools.rejectLatest('saas_create_work_item', String(client.binding.sessionId), reason)
    }
  }

  const cancel = (): void => {
    const error = new Error('The user cancelled the SaaS work-item creation')
    client.frontendTools.reject(toolCallId, error)
      || client.frontendTools.rejectLatest('saas_create_work_item', String(client.binding.sessionId), error)
  }

  return (
    <div className="dsh-tool-card dsh-agentic-action-card" data-testid="saas-create-work-item-card">
      <span className="dsh-tool-kicker">Agentic UI · Existing SaaS action</span>
      <strong>Review and adjust this work item</strong>
      <div className="dsh-agentic-form">
        <label>Project
          <select aria-label="Project" value={projectId} onChange={event => setProjectId(event.currentTarget.value)}>
            {workspace.projects.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
        <label>Work item title
          <input aria-label="Work item title" value={title} onChange={event => setTitle(event.currentTarget.value)} />
        </label>
        <div className="dsh-agentic-form-row">
          <label>Priority
            <select aria-label="Priority" value={priority} onChange={event => setPriority(event.currentTarget.value as WorkItemPriority)}>
              <option>High</option><option>Medium</option><option>Low</option>
            </select>
          </label>
          <label>Assignee
            <select aria-label="Assignee" value={assignee} onChange={event => setAssignee(event.currentTarget.value)}>
              {assignees.map(candidate => <option key={candidate}>{candidate}</option>)}
            </select>
          </label>
        </div>
      </div>
      <WorkItemSummary item={preview} projectName={project?.name ?? parameters.projectId}>
        <span className="dsh-agentic-explanation">The card edits fields from the existing SaaS workflow. Confirm to apply the same operation to the workspace.</span>
      </WorkItemSummary>
      <div className="dsh-hitl-actions">
        <button className="dsh-hitl-choice" type="button" disabled={submitting || title.trim().length === 0 || project === undefined} onClick={commit}>{submitting ? 'Adding…' : 'Add to workspace'}</button>
        <button className="dsh-hitl-secondary" type="button" disabled={submitting} onClick={cancel}>Cancel</button>
      </div>
    </div>
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function FrontendCapabilityProbe({
  client,
  workspace,
  setWorkspace,
}: {
  readonly client: BrowserNativeDshClient
  readonly workspace: SaaSWorkspaceSnapshot
  readonly setWorkspace: React.Dispatch<React.SetStateAction<SaaSWorkspaceSnapshot>>
}): null {
  const workspaceRef = useRef(workspace)
  useEffect(() => { workspaceRef.current = workspace }, [workspace])

  const runProbe = useCallback(async ({ label }: { readonly label: string }) => ({
    accepted: true,
    label,
    completedAt: new Date().toISOString(),
  }), [])

  useFrontendTool({
    name: 'browser_native_ui_probe',
    description: 'Show a Browser-Native DSH UI capability probe and return its result.',
    parameters: probeParameters,
    handler: runProbe,
    render: ({ args, status, result }) => (
      <div className={`dsh-tool-card dsh-tool-card-${status}`} data-testid="frontend-tool-card">
        <strong>Browser UI capability</strong>
        <span>{typeof args?.label === 'string' ? args.label : 'Waiting for input'}</span>
        <small>{status === 'complete' ? `Completed: ${JSON.stringify(result)}` : `Status: ${status}`}</small>
      </div>
    ),
  }, [runProbe])

  useRenderTool({
    name: 'browser_native_ui_probe',
    agentId: 'dsh-browser-native',
    parameters: probeParameters,
    render: ({ parameters, status, result }) => (
      <div className={`dsh-tool-card dsh-tool-card-${status}`} data-testid="dsh-frontend-tool-card">
        <strong>Browser UI capability</strong>
        <span>{parameters.label}</span>
        <small>{status === 'complete' ? `Completed: ${result}` : `Status: ${status}`}</small>
      </div>
    ),
  })

  useEffect(() => client.frontendTools.register('browser_native_ui_probe', (argumentsValue) => {
    if (!isRecord(argumentsValue) || typeof argumentsValue.label !== 'string') {
      throw new Error('browser_native_ui_probe requires a string label')
    }
    return runProbe({ label: argumentsValue.label })
  }), [client, runProbe])

  useEffect(() => client.frontendTools.register('saas_get_workspace', () => workspaceRef.current), [client])
  useEffect(() => client.frontendTools.register('saas_create_work_item', () => new Promise<unknown>(() => {})), [client])

  useRenderTool({
    name: 'saas_get_workspace',
    agentId: 'dsh-browser-native',
    parameters: workspaceParameters,
    render: ({ status }) => (
      <div className={`dsh-tool-card dsh-tool-card-${status}`} data-testid="saas-workspace-tool-card">
        <span className="dsh-tool-kicker">Existing SaaS data</span>
        <strong>Workspace context loaded</strong>
        <small>{status === 'complete' ? `${workspaceRef.current.workItems.length} work items across ${workspaceRef.current.projects.length} projects.` : 'Reading the current workspace…'}</small>
      </div>
    ),
  })

  useRenderTool({
    name: 'saas_create_work_item',
    agentId: 'dsh-browser-native',
    parameters: createWorkItemParameters,
    render: ({ parameters, status, result, toolCallId }) => {
      const project = workspaceRef.current.projects.find(candidate => candidate.id === parameters.projectId)
      if (status === 'complete') {
        const completed = resultRecord(result)
        const item: Pick<SaaSWorkItem, 'title' | 'priority' | 'assignee' | 'status'> = {
          title: typeof completed?.title === 'string' ? completed.title : parameters.title,
          priority: completed?.priority === 'High' || completed?.priority === 'Low' ? completed.priority : 'Medium',
          assignee: typeof completed?.assignee === 'string' ? completed.assignee : parameters.assignee,
          status: 'Planned',
        }
        const projectName = typeof completed?.project === 'string' ? completed.project : project?.name ?? parameters.projectId
        return (
          <div className="dsh-tool-card dsh-tool-card-complete" data-testid="saas-create-work-item-result">
            <span className="dsh-tool-kicker">Existing SaaS action</span>
            <strong>Work item added to the workspace</strong>
            <WorkItemSummary item={item} projectName={projectName} />
          </div>
        )
      }
      return (
        <SaaSWorkItemActionCard
          key={toolCallId}
          client={client}
          workspace={workspaceRef.current}
          setWorkspace={setWorkspace}
          toolCallId={toolCallId}
          parameters={parameters}
        />
      )
    },
  })

  useEffect(() => client.frontendTools.register('ask_user_question', () => new Promise<unknown>(() => {})), [client])

  useRenderTool({
    name: 'ask_user_question',
    agentId: 'dsh-browser-native',
    parameters: questionParameters,
    render: ({ parameters, status, result, toolCallId }) => {
      if (status === 'complete') {
        return <div className="dsh-tool-card dsh-tool-card-complete" data-testid="hitl-result-card"><span className="dsh-tool-kicker">Human decision</span><strong>Decision recorded</strong><small>{result}</small></div>
      }
      const question = parameters.questions[0]
      if (question === undefined) return <div className="dsh-tool-card">No question was provided.</div>
      const answer = (selected: readonly string[]): void => {
        const result = { answers: [{ id: question.id, selected: [...selected] }] }
        client.frontendTools.resolve(toolCallId, result)
          || client.frontendTools.resolveLatest('ask_user_question', String(client.binding.sessionId), result)
      }
      const cancel = (): void => {
        client.frontendTools.reject(toolCallId, new Error('The user cancelled the question'))
          || client.frontendTools.rejectLatest('ask_user_question', String(client.binding.sessionId), new Error('The user cancelled the question'))
      }
      return (
        <div className="dsh-tool-card dsh-hitl-card" data-testid="hitl-card">
          <span className="dsh-tool-kicker">Action requires approval</span>
          <strong>{question.header ?? 'Your input is needed'}</strong>
          <span>{question.question}</span>
          <div className="dsh-hitl-actions">
            {(question.options ?? []).map(option => (
              <button className="dsh-hitl-choice" key={option.label} type="button" onClick={() => answer([option.label])}>{option.label}</button>
            ))}
            <button className="dsh-hitl-secondary" type="button" onClick={() => answer([])}>Skip</button>
            <button className="dsh-hitl-secondary" type="button" onClick={cancel}>Cancel</button>
          </div>
          {status === 'inProgress' ? <small>Preparing question…</small> : null}
        </div>
      )
    },
  })

  return null
}

function App({ state }: { readonly state: AppState }): JSX.Element {
  const [status, setStatus] = useState('Connected to DSH Session')
  const [workspace, setWorkspace] = useState(loadSaaSWorkspace)
  const [ownershipError, setOwnershipError] = useState(state.client.ownershipError())
  const agentMap = useMemo(() => ({ 'dsh-browser-native': state.agent }), [state.agent])

  useEffect(() => {
    const refreshOwnership = (): void => setOwnershipError(state.client.ownershipError())
    return state.client.subscribeOwnership(refreshOwnership)
  }, [state.client])

  useEffect(() => {
    const onError = (event: ErrorEvent): void => setStatus(`Browser error: ${event.message}`)
    window.addEventListener('error', onError)
    return () => window.removeEventListener('error', onError)
  }, [])

  return (
    <CopilotKitProvider
      agentId="dsh-browser-native"
      agents__unsafe_dev_only={agentMap}
      enableInspector={false}
      showIntelligenceIndicator={false}
    >
      <FrontendCapabilityProbe client={state.client} workspace={workspace} setWorkspace={setWorkspace} />
      <div className="dsh-app-shell">
        <header className="dsh-app-header">
          <div className="dsh-brand-lockup">
            <div className="dsh-brand-mark" aria-hidden="true">✦</div>
            <div>
              <p className="dsh-eyebrow">Browser-Native DSH</p>
              <h1>Agent workspace</h1>
              <p className="dsh-status" data-testid="connection-status">{status}</p>
            </div>
          </div>
          <div className="dsh-header-actions">
            <span className="dsh-session-badge"><span className="dsh-status-dot" aria-hidden="true" />Session active</span>
            <button className="dsh-new-session" type="button" onClick={() => state.client.startNewSession()}>New session</button>
          </div>
        </header>
        <main className="dsh-main">
          <section className="dsh-page-intro" aria-labelledby="dsh-page-title">
            <div className="dsh-page-intro-copy">
              <p className="dsh-section-label">Agentic UI proof of concept</p>
              <h2 id="dsh-page-title">Describe the work. DSH carries it out.</h2>
              <p>Use natural language to explore a SaaS workflow. The chat is rendered by CopilotKit while DSH keeps execution, tools, and session history authoritative.</p>
            </div>
            <div className="dsh-capability-list" aria-label="Runtime capabilities">
              <span><i className="dsh-capability-icon" aria-hidden="true">✓</i> Durable Session</span>
              <span><i className="dsh-capability-icon" aria-hidden="true">✓</i> Browser tools</span>
              <span><i className="dsh-capability-icon" aria-hidden="true">✓</i> Human approval</span>
            </div>
          </section>
          <div className="dsh-workbench">
            <SaaSWorkspacePanel workspace={workspace} onReset={() => { resetSaaSWorkspace(); setWorkspace(initialSaaSWorkspace) }} />
            <section className="dsh-chat-panel" aria-label="DSH agent conversation">
              <div className="dsh-chat-panel-header">
                <div className="dsh-agent-identity">
                  <div className="dsh-agent-avatar" aria-hidden="true">DSH</div>
                  <div>
                    <h2>DSH Agent</h2>
                    <p>Bring the workspace into the conversation</p>
                  </div>
                </div>
                <div className="dsh-chat-panel-meta">
                  <span className="dsh-runtime-chip">AG-UI bridge</span>
                  <span className="dsh-session-id" title={String(state.client.binding.sessionId)}>Session {state.client.binding.sessionId}</span>
                </div>
              </div>
              <div className="dsh-chat-interaction" inert={ownershipError !== undefined}>
                  <CopilotChat
                    agentId="dsh-browser-native"
                    threadId={String(state.client.binding.sessionId)}
                    labels={{ title: 'DSH Agent', initial: 'Ask the agent to work with the SaaS workspace.' }}
                    suggestions={[
                      { title: 'Read workspace', message: 'Use the SaaS workspace tool to inspect the current projects and open work items.' },
                      { title: 'Draft a work item', message: 'Create a planned work item in the Growth launch project titled "Prepare launch review", assign it to You, and let me confirm it in the conversation.' },
                      { title: 'Test memory', message: 'Remember that my preferred project is Browser-Native DSH.' },
                    ]}
                  />
                </div>
                {ownershipError !== undefined ? (
                  <div className="dsh-session-lock-notice" role="alert" data-testid="session-lock-notice">
                    <strong>This Session is open in another tab.</strong>
                    <span>To protect the conversation from conflicting writes, this tab is read-only. Close the other tab and refresh to continue.</span>
                    <small>{ownershipError}</small>
                  </div>
              ) : null}
            </section>
          </div>
          <p className="dsh-footnote">The model can make mistakes. Verify important actions before applying them to production data.</p>
        </main>
      </div>
    </CopilotKitProvider>
  )
}

async function bootstrap(): Promise<void> {
  const root = document.querySelector('#root')
  if (!(root instanceof HTMLElement)) throw new Error('CopilotKit PoC root element is missing')
  root.textContent = 'Starting Browser-Native DSH…'
  try {
    const client = await bootBrowserNativeDshClient()
    const agent = new DshAgUiAgent({
      binding: client.binding,
      threadId: String(client.binding.sessionId),
    })
    createRoot(root).render(<App state={{ client, agent }} />)
  } catch (error) {
    root.textContent = `Session create failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

void bootstrap()
