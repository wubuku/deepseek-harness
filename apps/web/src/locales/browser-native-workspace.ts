import type { BrowserNativeSupportIssueCode } from '../browser-native-support.ts'

type WorkspaceState = 'loading' | 'synced' | 'dirty' | 'syncing' | 'error' | 'conflict'
  | 'local-corrupt' | 'local-newer-version' | 'lease-conflict' | 'recovery-conflict'
  | 'recovery-unavailable' | 'identity-missing' | 'identity-mismatch' | 'read-only' | 'stale'
  | 'session-conflict'

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
    'identity-missing': 'Local Workspace data is retained, but its browser identity is unavailable',
    'identity-mismatch': 'Local Workspace data does not match the current browser identity',
    'read-only': 'Workspace is read-only while another tab owns write access',
    stale: 'Workspace changed; this read-only snapshot is stale',
    'session-conflict': 'This Session is open in another tab',
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
    'identity-missing': '本地工作区数据仍在，但无法确认对应的浏览器身份',
    'identity-mismatch': '本地工作区数据与当前浏览器身份不匹配',
    'read-only': '另一个标签页持有写权限，当前工作区为只读',
    stale: '工作区已变化；当前只读快照已过期',
    'session-conflict': '该会话已在另一个标签页打开',
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

/** Format the live admission queue position for the page language.
 * @param language - Page language tag.
 * @param position - Zero-free position of this request in the waiting queue.
 * @param queued - Number of requests waiting, including this one.
 * @param activeTurns - Turns currently holding an admission slot.
 * @param limit - Concurrent turn limit, when the backend reports one.
 * @returns Localized queue status text.
 */
export function browserNativeQueueStatusCopy(
  language: string,
  position: number,
  queued: number,
  activeTurns: number,
  limit: number | undefined,
): string {
  const capacity = limit === undefined ? '' : language.startsWith('zh')
    ? ` · ${String(activeTurns)}/${String(limit)} 运行中`
    : ` · ${String(activeTurns)}/${String(limit)} active`
  return language.startsWith('zh')
    ? `等待模型执行槽位 · 队列第 ${String(position)} 位（共 ${String(queued)} 位）${capacity}`
    : `Waiting for a model slot · position ${String(position)} of ${String(queued)}${capacity}`
}

/** Format the notice shown when the page cannot host the Browser-Native preview.
 * @param language - Page language tag.
 * @param issue - First missing platform requirement.
 * @returns Localized notice text.
 */
export function browserNativeUnsupportedBrowserCopy(language: string, issue: BrowserNativeSupportIssueCode): string {
  const reason = UNSUPPORTED_BROWSER_REASONS[issue]
  return language.startsWith('zh')
    ? `Browser-Native DSH 预览无法在此浏览器运行：${reason.zh}`
    : `The Browser-Native DSH preview cannot run in this browser: ${reason.en}`
}

const UNSUPPORTED_BROWSER_REASONS: Record<BrowserNativeSupportIssueCode, { readonly en: string; readonly zh: string }> = {
  NON_CHROMIUM_DESKTOP: {
    en: 'only Chromium desktop (Chrome, Edge, or Chromium) is supported; Safari, Firefox, and mobile browsers are not.',
    zh: '目前仅支持 Chromium 桌面版（Chrome、Edge 或 Chromium）；Safari、Firefox 与移动浏览器不在支持范围。',
  },
  NO_DEDICATED_WORKER: {
    en: 'a Dedicated Worker cannot be started, so the Agent cannot run off the UI thread.',
    zh: '无法启动 Dedicated Worker，Agent 无法脱离 UI 线程运行。',
  },
  NO_MESSAGE_CHANNEL: {
    en: 'MessageChannel is unavailable, so the page cannot observe Worker lifecycle state.',
    zh: 'MessageChannel 不可用，页面无法观察 Worker 生命周期状态。',
  },
  NO_OPFS: {
    en: 'the Origin Private File System is unavailable, so Workspace files cannot be stored.',
    zh: 'Origin Private File System 不可用，无法存放 Workspace 文件。',
  },
  NO_INDEXED_DB: {
    en: 'IndexedDB is unavailable, so Workspace metadata cannot be stored.',
    zh: 'IndexedDB 不可用，无法存放 Workspace 元数据。',
  },
  NO_SUBTLE_CRYPTO: {
    en: 'SubtleCrypto is unavailable, so Workspace content hashes cannot be verified.',
    zh: 'SubtleCrypto 不可用，无法校验 Workspace 内容哈希。',
  },
}

/** Format the explicit retry action for a Session owned by another tab.
 * @param language - Page language tag.
 * @returns Localized button label.
 */
export function browserNativeSessionRetryCopy(language: string): string {
  return language.startsWith('zh') ? '重新打开该会话' : 'Retry opening this Session'
}

/** Format the user-initiated Session bundle action.
 * @param language - Page language tag.
 * @returns Localized button label.
 */
export function browserNativeSessionExportCopy(language: string): string {
  return language.startsWith('zh') ? '下载会话包' : 'Download Session bundle'
}

/** Format the result of a Session bundle download.
 * @param language - Page language tag.
 * @param success - Whether the browser started the download.
 * @returns Localized result text.
 */
export function browserNativeSessionExportResultCopy(language: string, success: boolean): string {
  if (language.startsWith('zh')) {
    return success ? '会话包已下载。' : '会话包下载失败；会话数据未更改。'
  }
  return success ? 'Session bundle downloaded.' : 'Session bundle download failed; Session data was not changed.'
}

/** Format the explicit retry action for a Browser-Native writer lease conflict.
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

/** Format the explicit page reload action for a Workspace observer. */
export function browserNativeWorkspaceRefreshCopy(language: string, stale: boolean): string {
  if (language.startsWith('zh')) return stale ? '刷新工作区' : '刷新并尝试获取写权限'
  return stale ? 'Refresh Workspace' : 'Refresh and request write access'
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
    ? '本地恢复包可能包含敏感文件，大小上限为 64 MiB。请妥善保存；此操作不会上传或清除数据。'
    : 'Local recovery bundles may contain sensitive files and are limited to 64 MiB. Store them securely; this does not upload or clear data.'
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
