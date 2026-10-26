type WorkspaceState = 'loading' | 'synced' | 'dirty' | 'syncing' | 'error' | 'conflict'
  | 'local-corrupt' | 'local-newer-version' | 'lease-conflict' | 'recovery-conflict'
  | 'recovery-unavailable'

const messages: Record<'en' | 'zh', Record<WorkspaceState, string>> = {
  en: {
    loading: 'Workspace: restoring…',
    synced: 'Workspace synced',
    dirty: 'Workspace changes pending',
    syncing: 'Workspace syncing…',
    error: 'Workspace sync failed',
    conflict: 'Workspace revision conflict',
    'local-corrupt': 'Local Workspace state is corrupt',
    'local-newer-version': 'Local Workspace uses a newer unsupported format',
    'lease-conflict': 'Another tab currently owns Workspace write access',
    'recovery-conflict': 'Another tab is already using these DSH recovery credentials',
    'recovery-unavailable': 'Safe DSH writer recovery is unavailable in this browser context',
  },
  zh: {
    loading: '工作区：正在恢复…',
    synced: '工作区已同步',
    dirty: '工作区有未同步修改',
    syncing: '工作区正在同步…',
    error: '工作区同步失败',
    conflict: '工作区发生版本冲突',
    'local-corrupt': '本地工作区状态损坏',
    'local-newer-version': '本地工作区格式版本较新，当前版本无法读取',
    'lease-conflict': '另一个标签页正在写入工作区',
    'recovery-conflict': '另一个标签页正在使用这组 DSH 恢复凭据',
    'recovery-unavailable': '当前浏览器上下文无法安全恢复 DSH 写入权',
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

/** Format an explicit retry action for a Browser-Native writer lease conflict.
 * @param language - Page language tag.
 * @param remainingMs - Time until the backend lease was expected to expire.
 * @returns Localized button label.
 */
export function browserNativeWorkspaceRetryCopy(language: string, remainingMs: number): string {
  if (language.startsWith('zh')) {
    return remainingMs > 0 ? `等待 ${String(Math.ceil(remainingMs / 1000))} 秒后重试` : '重新获取写权限'
  }
  return remainingMs > 0 ? `Retry in ${String(Math.ceil(remainingMs / 1000))}s` : 'Retry write access'
}

/** Explain why saved writer recovery is unavailable in the current browser context.
 * @param language - Page language tag.
 * @returns Localized recovery limitation text.
 */
export function browserNativeRecoveryErrorCopy(language: string): string {
  return language.startsWith('zh')
    ? '当前浏览器无法安全协调同源标签页的写入恢复。请使用支持 Web Locks 的安全上下文。'
    : 'This browser cannot safely coordinate same-origin writer recovery. Use a secure context with Web Locks support.'
}

/** Format the warning shown before a local recovery bundle download.
 * @param language - Page language tag.
 * @returns Localized warning about sensitive local files.
 */
export function browserNativeWorkspaceRecoveryWarningCopy(language: string): string {
  return language.startsWith('zh')
    ? '恢复包可能包含敏感文件；请先下载并妥善保存。此操作不会上传或清除数据。'
    : 'The bundle may contain sensitive files. Store it securely. This does not upload or clear data.'
}

/** Format the user-initiated local recovery bundle action.
 * @param language - Page language tag.
 * @returns Localized button label.
 */
export function browserNativeWorkspaceRecoveryExportCopy(language: string): string {
  return language.startsWith('zh') ? '下载本地恢复包' : 'Download local recovery bundle'
}

/** Format the result of a local recovery bundle download.
 * @param language - Page language tag.
 * @param success - Whether the browser started the download.
 * @returns Localized result text.
 */
export function browserNativeWorkspaceRecoveryResultCopy(language: string, success: boolean): string {
  if (language.startsWith('zh')) return success ? '恢复包已下载，请妥善保管。' : '恢复包导出失败；本地数据未更改。'
  return success ? 'Recovery bundle downloaded. Store it securely.' : 'Recovery export failed; local data was not changed.'
}
