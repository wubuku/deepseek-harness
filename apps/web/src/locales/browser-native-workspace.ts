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

/** Format the Workspace switcher labels for the page language.
 * @param language - Page language tag.
 * @returns Localized label, create action, file-count formatter, and failure text.
 */
export function browserNativeWorkspaceSwitcherCopy(language: string): {
  readonly label: string
  readonly create: string
  readonly empty: string
  readonly loadFailed: string
  readonly createFailed: string
  readonly switchFailed: string
  readonly fileCount: (count: number) => string
} {
  const zh = language.startsWith('zh')
  return {
    label: zh ? '工作区' : 'Workspace',
    create: zh ? '新建工作区' : 'New workspace',
    empty: zh ? '没有可用工作区' : 'No workspaces available',
    loadFailed: zh ? '无法加载工作区列表' : 'Could not load workspaces',
    createFailed: zh ? '无法创建工作区' : 'Could not create a workspace',
    switchFailed: zh ? '无法切换工作区' : 'Could not switch workspace',
    fileCount: count => zh ? `${String(count)} 个文件` : `${String(count)} files`,
  }
}

/** Format the opt-in preview's Workspace sync notice for the page language.
 *
 * The visible notice carries only locale-owned copy. Backend failure detail
 * stays on the status channel for diagnostics and never reaches the rendered
 * text, so a Chinese page cannot surface an English provider message.
 * @param state - Current synchronization state.
 * @param language - Page language tag.
 * @param revision - Last confirmed server revision.
 * @param dirtyCount - Number of pending local paths.
 * @returns Localized status text.
 */
export function browserNativeWorkspaceStatusCopy(
  state: WorkspaceState,
  language: string,
  revision: number | undefined,
  dirtyCount: number,
): string {
  const dictionary = language.startsWith('zh') ? messages.zh : messages.en
  const revisionLabel = revision === undefined ? '' : ` · r${String(revision)}`
  const dirtyLabel = dirtyCount === 0
    ? ''
    : language.startsWith('zh') ? ` · ${String(dirtyCount)} 项待同步` : ` · ${String(dirtyCount)} pending`
  return `${dictionary[state]}${revisionLabel}${dirtyLabel}`
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

/** Format the connectivity notice shown while Session requests wait for the network.
 * @param language - Page language tag.
 * @param state - Connectivity state reported by the page or Worker.
 * @param queued - Number of Session requests waiting for connectivity.
 * @returns Localized connectivity text.
 */
export function browserNativeOfflineStatusCopy(
  language: string,
  state: 'offline' | 'replaying' | 'online',
  queued: number,
): string {
  const request = (count: number): string => language.startsWith('zh')
    ? `${String(count)} 个请求进入可重试队列`
    : `${String(count)} request${count === 1 ? '' : 's'} queued for retry`
  if (state === 'offline') {
    return language.startsWith('zh')
      ? `网络已断开 · ${request(queued)}；恢复后将自动重放`
      : `Offline · ${request(queued)}; replay resumes when the connection returns`
  }
  if (state === 'replaying') {
    return language.startsWith('zh')
      ? `正在恢复连接 · 重放 ${request(queued)}`
      : `Reconnecting · replaying ${request(queued)}`
  }
  return language.startsWith('zh') ? '连接已恢复，队列已清空' : 'Connected; retry queue is empty'
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

/** Copy for the failed-turn retry banner.
 * @param language - Page language tag.
 * @param turn - Failed Agent turn number.
 * @param reason - Terminal reason kind recorded by the Session log.
 * @returns Banner message, action label, submitted, duplicate, and failure text.
 */
export function browserNativeTurnRetryCopy(language: string, turn: number, reason: string): {
  readonly message: string
  readonly action: string
  readonly submitted: string
  readonly duplicate: string
  readonly failed: string
} {
  const zh = language.startsWith('zh')
  return {
    message: zh
      ? `第 ${String(turn)} 轮以 ${reason} 结束；可从原始提示重试。`
      : `Turn ${String(turn)} ended as ${reason}; retry from its original prompt.`,
    action: zh ? `重试第 ${String(turn)} 轮` : `Retry turn ${String(turn)}`,
    submitted: zh ? `第 ${String(turn)} 轮重试已提交。` : `Retry submitted for turn ${String(turn)}.`,
    duplicate: zh
      ? `第 ${String(turn)} 轮已重试过，未再次提交。`
      : `Turn ${String(turn)} was already retried; nothing was submitted.`,
    failed: zh ? '重试失败，未提交新的轮次。' : 'Retry failed; no new turn was submitted.',
  }
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

/** Format the label for exporting a redacted support bundle.
 * @param language - Page language tag.
 * @returns Localized button label.
 */
export function browserNativeSupportBundleCopy(language: string): string {
  return language.startsWith('zh') ? '导出支持包' : 'Export support bundle'
}

/** Format the result of a support bundle export.
 * @param language - Page language tag.
 * @param success - Whether the browser started the download.
 * @returns Localized result text.
 */
export function browserNativeSupportBundleResultCopy(language: string, success: boolean): string {
  if (language.startsWith('zh')) {
    return success ? '支持包已导出（不含 prompt、密钥或 token）。' : '支持包导出失败；会话数据未更改。'
  }
  return success
    ? 'Support bundle exported without prompts, credentials, or auth tokens.'
    : 'Support bundle export failed; Session data was not changed.'
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

/** Format the first-use guide shown on a browser's first visit.
 *
 * The guide names the first turn's three steps and offers one sample task; the
 * page inserts that task into the existing composer instead of submitting a
 * request, so the user still controls the first model call.
 * @param language - Page language tag.
 * @returns Localized guide copy and the sample task text.
 */
export function browserNativeFirstUseCopy(language: string): {
  readonly label: string
  readonly title: string
  readonly body: string
  readonly steps: readonly string[]
  readonly sampleAction: string
  readonly sampleTask: string
  readonly dismiss: string
  readonly filled: string
  readonly composerMissing: string
} {
  if (language.startsWith('zh')) {
    return {
      label: '首次使用引导',
      title: '第一次在浏览器里运行 DSH',
      body: '这个预览在 Dedicated Worker 中运行真实 DSH Agent Loop；模型请求经同源后端代理，工作区文件保存在当前浏览器。',
      steps: [
        '在下方输入框写下任务，或使用示例任务。',
        '按发送按钮，等待助手回复完成。',
        '顶部显示“工作区已同步”后，这次运行已持久化。',
      ],
      sampleAction: '填入示例任务',
      sampleTask: '请用三句话介绍你在这个浏览器工作区里能完成的事情。',
      dismiss: '不再显示',
      filled: '示例任务已填入输入框，按发送开始第一次运行。',
      composerMissing: '未找到对话输入框；请在页面底部输入任务。',
    }
  }
  return {
    label: 'First-run guide',
    title: 'Run DSH in the browser for the first time',
    body: 'This preview runs the real DSH Agent Loop in a Dedicated Worker; model requests go through the same-origin backend proxy, and Workspace files stay in this browser.',
    steps: [
      'Write a task in the composer below, or use the sample task.',
      'Press Send and wait for the assistant reply to finish.',
      'Once the header shows “Workspace synced”, the run is persisted.',
    ],
    sampleAction: 'Use the sample task',
    sampleTask: 'In three sentences, describe what you can do inside this browser Workspace.',
    dismiss: 'Don’t show again',
    filled: 'Sample task inserted. Press Send to run your first turn.',
    composerMissing: 'No composer was found; type a task at the bottom of the page.',
  }
}

/** Format the main composer's execution route for the page language.
 *
 * The chip states which host runs a submitted prompt: the durable server host by
 * default, or the browser Worker after an explicit downgrade. `reason` carries
 * the degraded condition so users can tell why their turn left durable mode.
 * @param language - Page language tag.
 * @returns Localized route labels with an interpolated fallback reason.
 */
export function browserNativeDurableRouteCopy(language: string): {
  readonly label: string
  readonly durable: string
  readonly workerFallback: (reason: string) => string
  readonly sessionNotReady: string
  readonly waitingWorker: string
  readonly startUnavailable: (detail: string) => string
  readonly queued: string
} {
  if (language.startsWith('zh')) {
    return {
      label: '执行路由',
      durable: '主 composer 由 durable 服务端执行',
      workerFallback: reason => `已降级到浏览器 Worker：${reason}`,
      sessionNotReady: 'Session 尚未就绪',
      waitingWorker: 'Session 未就绪，本轮使用浏览器 Worker',
      startUnavailable: detail => `durable 服务端不可用（${detail}）`,
      queued: '已排队，等待当前 durable turn 结束',
    }
  }
  return {
    label: 'Execution route',
    durable: 'Main composer runs on the durable server host',
    workerFallback: reason => `Fell back to the browser Worker: ${reason}`,
    sessionNotReady: 'the Session is not ready',
    waitingWorker: 'the Session is not ready; this prompt uses the browser Worker',
    startUnavailable: detail => `the durable server host is unavailable (${detail})`,
    queued: 'Queued behind the running durable turn',
  }
}

/** Format the durable turn's pending-approval surface for the page language.
 *
 * The page renders this surface from the durable host's status, not from the
 * Worker host's remote approval request, so a server-owned turn that waits on a
 * write stays visible after the page has no local execution to pause.
 * @param language - Page language tag.
 * @returns Localized approval labels and interpolated status text.
 */
export function browserNativeDurableApprovalCopy(language: string): {
  readonly title: (name: string) => string
  readonly waiting: string
  readonly target: (target: string) => string
  readonly approve: string
  readonly reject: string
  readonly deciding: string
  readonly running: string
  readonly completed: string
  readonly retry: string
  readonly failed: (status: number | undefined) => string
} {
  if (language.startsWith('zh')) {
    return {
      title: name => `需要审批：${name}`,
      waiting: '服务端 turn 正在等待你的决定。',
      target: target => `目标：${target}`,
      approve: '批准',
      reject: '拒绝',
      deciding: '正在提交决定…',
      running: '服务端 turn 正在运行',
      completed: '服务端 turn 已完成',
      retry: '重试该轮',
      failed: status => status === undefined ? '审批决定提交失败' : `审批决定提交失败（HTTP ${String(status)}）`,
    }
  }
  return {
    title: name => `Approval needed: ${name}`,
    waiting: 'A server-side turn is waiting for your decision.',
    target: target => `Target: ${target}`,
    approve: 'Approve',
    reject: 'Reject',
    deciding: 'Submitting decision…',
    running: 'Server turn running',
    completed: 'Server turn completed',
    retry: 'Retry this turn',
    failed: status => status === undefined ? 'The approval decision could not be submitted' : `The approval decision could not be submitted (HTTP ${String(status)})`,
  }
}
