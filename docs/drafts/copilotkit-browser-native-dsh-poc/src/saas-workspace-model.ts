import type {
  SaaSProject,
  SaaSWorkItem,
  SaaSWorkspaceSnapshot,
  WorkItemPriority,
} from './saas-workspace.tsx'

export interface CreateSaaSWorkItemInput {
  readonly projectId: string
  readonly title: string
  readonly priority: WorkItemPriority
  readonly assignee: string
  readonly userEditedFields?: readonly string[]
}

export interface CreateSaaSWorkItemResult {
  readonly ok: true
  readonly operationId: string
  readonly itemId: string
  readonly title: string
  readonly project: string
  readonly projectId: string
  readonly priority: WorkItemPriority
  readonly assignee: string
  readonly status: SaaSWorkItem['status']
  readonly userConfirmed: true
  readonly userEditedFields: readonly string[]
}

export interface CreatedSaaSWorkItem {
  readonly workspace: SaaSWorkspaceSnapshot
  readonly item: SaaSWorkItem
  readonly result: CreateSaaSWorkItemResult
}

/** Apply one confirmed work-item operation to the existing SaaS workspace state. */
export function createSaaSWorkItem(
  workspace: SaaSWorkspaceSnapshot,
  input: CreateSaaSWorkItemInput,
  itemId: string,
  operationId: string,
): CreatedSaaSWorkItem {
  const project = workspace.projects.find(candidate => candidate.id === input.projectId)
  if (project === undefined) throw new Error(`Unknown SaaS project: ${input.projectId}`)
  const item: SaaSWorkItem = {
    id: itemId,
    projectId: input.projectId,
    title: input.title,
    priority: input.priority,
    status: 'Planned',
    assignee: input.assignee,
    updatedAt: 'Just now',
  }
  const nextProjects: readonly SaaSProject[] = workspace.projects.map(candidate => candidate.id === input.projectId
    ? { ...candidate, openItems: candidate.openItems + 1 }
    : candidate)
  const nextWorkspace: SaaSWorkspaceSnapshot = {
    ...workspace,
    projects: nextProjects,
    workItems: [item, ...workspace.workItems],
  }
  return {
    workspace: nextWorkspace,
    item,
    result: {
      ok: true,
      operationId,
      itemId,
      title: item.title,
      project: project.name,
      projectId: item.projectId,
      priority: item.priority,
      assignee: item.assignee,
      status: item.status,
      userConfirmed: true,
      userEditedFields: input.userEditedFields ?? [],
    },
  }
}
