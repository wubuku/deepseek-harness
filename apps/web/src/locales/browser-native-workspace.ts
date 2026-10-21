type WorkspaceState = 'loading' | 'synced' | 'dirty' | 'syncing' | 'error' | 'conflict'

const messages: Record<'en' | 'zh', Record<WorkspaceState, string>> = {
  en: {
    loading: 'Workspace: restoring…',
    synced: 'Workspace synced',
    dirty: 'Workspace changes pending',
    syncing: 'Workspace syncing…',
    error: 'Workspace sync failed',
    conflict: 'Workspace revision conflict',
  },
  zh: {
    loading: '工作区：正在恢复…',
    synced: '工作区已同步',
    dirty: '工作区有未同步修改',
    syncing: '工作区正在同步…',
    error: '工作区同步失败',
    conflict: '工作区发生版本冲突',
  },
}

/** Format the opt-in preview's Workspace sync notice for the page language.
 * @param state - Current synchronization state.
 * @param language - Page language tag.
 * @param revision - Last confirmed server revision.
 * @param dirtyCount - Number of pending local paths.
 * @param message - Optional synchronization failure detail.
 * @returns Localized status text.
 */
export function browserNativeWorkspaceStatusCopy(
  state: WorkspaceState,
  language: string,
  revision: number | undefined,
  dirtyCount: number,
  message: string | undefined,
): string {
  const dictionary = language.startsWith('zh') ? messages.zh : messages.en
  const revisionLabel = revision === undefined ? '' : ` · r${String(revision)}`
  const dirtyLabel = dirtyCount === 0
    ? ''
    : language.startsWith('zh') ? ` · ${String(dirtyCount)} 项待同步` : ` · ${String(dirtyCount)} pending`
  return `${dictionary[state]}${revisionLabel}${dirtyLabel}${message === undefined ? '' : ` — ${message}`}`
}
