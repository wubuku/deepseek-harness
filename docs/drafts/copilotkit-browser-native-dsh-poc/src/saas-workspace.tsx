import React, { type ReactNode } from 'react'

export type WorkItemPriority = 'High' | 'Medium' | 'Low'
export type WorkItemStatus = 'In progress' | 'Review' | 'Planned'

export interface SaaSProject {
  readonly id: string
  readonly name: string
  readonly color: string
  readonly openItems: number
}

export interface SaaSWorkItem {
  readonly id: string
  readonly projectId: string
  readonly title: string
  readonly priority: WorkItemPriority
  readonly status: WorkItemStatus
  readonly assignee: string
  readonly updatedAt: string
}

export interface SaaSWorkspaceSnapshot {
  readonly projects: readonly SaaSProject[]
  readonly workItems: readonly SaaSWorkItem[]
}

export const initialSaaSWorkspace: SaaSWorkspaceSnapshot = {
  projects: [
    { id: 'growth', name: 'Growth launch', color: '#3b82f6', openItems: 4 },
    { id: 'platform', name: 'Platform refresh', color: '#8b5cf6', openItems: 3 },
    { id: 'customer', name: 'Customer operations', color: '#14b8a6', openItems: 2 },
  ],
  workItems: [
    { id: 'work-101', projectId: 'growth', title: 'Review campaign landing page', priority: 'High', status: 'In progress', assignee: 'Mina', updatedAt: 'Today, 09:42' },
    { id: 'work-102', projectId: 'platform', title: 'Confirm browser session policy', priority: 'Medium', status: 'Review', assignee: 'Jon', updatedAt: 'Yesterday' },
    { id: 'work-103', projectId: 'customer', title: 'Prepare renewal health summary', priority: 'Low', status: 'Planned', assignee: 'You', updatedAt: 'Mon' },
  ],
}

const WORKSPACE_STORAGE_KEY = 'dsh-copilotkit-saas-workspace'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isProject(value: unknown): value is SaaSProject {
  return isRecord(value)
    && isString(value.id)
    && isString(value.name)
    && isString(value.color)
    && typeof value.openItems === 'number'
}

function isWorkItem(value: unknown): value is SaaSWorkItem {
  return isRecord(value)
    && isString(value.id)
    && isString(value.projectId)
    && isString(value.title)
    && (value.priority === 'High' || value.priority === 'Medium' || value.priority === 'Low')
    && (value.status === 'In progress' || value.status === 'Review' || value.status === 'Planned')
    && isString(value.assignee)
    && isString(value.updatedAt)
}

function isWorkspace(value: unknown): value is SaaSWorkspaceSnapshot {
  return isRecord(value)
    && Array.isArray(value.projects)
    && value.projects.every(isProject)
    && Array.isArray(value.workItems)
    && value.workItems.every(isWorkItem)
}

/** Load the mock SaaS state used by this PoC after a page refresh. */
export function loadSaaSWorkspace(): SaaSWorkspaceSnapshot {
  try {
    const raw = globalThis.localStorage?.getItem(WORKSPACE_STORAGE_KEY)
    if (raw === null || raw === undefined) return initialSaaSWorkspace
    const parsed: unknown = JSON.parse(raw)
    return isWorkspace(parsed) ? parsed : initialSaaSWorkspace
  } catch {
    return initialSaaSWorkspace
  }
}

/** Persist the mock SaaS state without putting it into the model context. */
export function saveSaaSWorkspace(workspace: SaaSWorkspaceSnapshot): void {
  globalThis.localStorage?.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace))
}

/** Remove the mock SaaS state so the PoC returns to its deterministic fixture. */
export function resetSaaSWorkspace(): void {
  globalThis.localStorage?.removeItem(WORKSPACE_STORAGE_KEY)
}

interface SaaSWorkspacePanelProps {
  readonly workspace: SaaSWorkspaceSnapshot
  readonly onReset: () => void
}

/** Render the existing SaaS work surface that the agent can operate through the chat. */
export function SaaSWorkspacePanel({ workspace, onReset }: SaaSWorkspacePanelProps): ReactNode {
  const projectById = new Map(workspace.projects.map(project => [project.id, project]))
  const highPriorityCount = workspace.workItems.filter(item => item.priority === 'High').length

  return (
    <section className="dsh-saas-panel" aria-labelledby="dsh-saas-panel-title">
      <header className="dsh-saas-panel-header">
        <div>
          <p className="dsh-section-label">Existing SaaS GUI</p>
          <h2 id="dsh-saas-panel-title">Operations workspace</h2>
          <p>Projects, work items, ownership, and status already live here.</p>
        </div>
        <button className="dsh-reset-workspace" type="button" onClick={onReset}>Reset demo</button>
      </header>
      <div className="dsh-saas-metrics" aria-label="Workspace summary">
        <div><strong>{workspace.workItems.length}</strong><span>Open work items</span></div>
        <div><strong>{workspace.projects.length}</strong><span>Active projects</span></div>
        <div><strong>{highPriorityCount}</strong><span>Needs attention</span></div>
      </div>
      <div className="dsh-project-list" aria-label="Projects">
        {workspace.projects.map(project => (
          <div className="dsh-project-row" key={project.id}>
            <span className="dsh-project-dot" style={{ backgroundColor: project.color }} aria-hidden="true" />
            <span className="dsh-project-name">{project.name}</span>
            <span className="dsh-project-count">{project.openItems} open</span>
          </div>
        ))}
      </div>
      <div className="dsh-work-items">
        <div className="dsh-table-heading"><span>Recent work</span><span>Updated</span></div>
        {workspace.workItems.map(item => {
          const project = projectById.get(item.projectId)
          return (
            <div className="dsh-work-item-row" key={item.id}>
              <div className="dsh-work-item-copy">
                <span className="dsh-work-item-title">{item.title}</span>
                <span className="dsh-work-item-meta"><i style={{ backgroundColor: project?.color }} aria-hidden="true" />{project?.name ?? item.projectId} · {item.assignee}</span>
              </div>
              <div className="dsh-work-item-side">
                <span className={`dsh-priority dsh-priority-${item.priority.toLowerCase()}`}>{item.priority}</span>
                <span className="dsh-work-item-date">{item.updatedAt}</span>
              </div>
            </div>
          )
        })}
      </div>
      <div className="dsh-saas-panel-footer">
        <span><span className="dsh-live-dot" aria-hidden="true" />SaaS state is local to this PoC</span>
        <span>Agent actions appear in the conversation</span>
      </div>
    </section>
  )
}

/** Render the shared work-item summary used by the business surface and Agentic UI cards. */
export function WorkItemSummary({
  item,
  projectName,
  children,
}: {
  readonly item: Pick<SaaSWorkItem, 'title' | 'priority' | 'assignee' | 'status'>
  readonly projectName: string
  readonly children?: ReactNode
}): ReactNode {
  return (
    <div className="dsh-agentic-work-item">
      <div className="dsh-agentic-work-item-heading">
        <span className="dsh-work-item-title">{item.title}</span>
        <span className={`dsh-priority dsh-priority-${item.priority.toLowerCase()}`}>{item.priority}</span>
      </div>
      <span className="dsh-work-item-meta">{projectName} · {item.assignee} · {item.status}</span>
      {children}
    </div>
  )
}
