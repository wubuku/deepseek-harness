import type { BrowserNativeWorkspaceStatus } from '../browser-native-control-channel.ts'

/** Next action offered beside a failure explanation. */
export type BrowserNativeFailureAction = 'retry' | 'reload' | 'request-access' | 'contact-admin' | 'diagnostics'

/** Localized explanation and next action for one failure or rejection code. */
export interface BrowserNativeFailureGuidance {
  readonly code: string
  readonly title: string
  readonly explanation: string
  readonly action: BrowserNativeFailureAction
  readonly actionLabel: string
  readonly copyText: string
  readonly diagnostics: boolean
}

interface FailureCopy {
  readonly title: string
  readonly explanation: string
  readonly actionLabel: string
  readonly copyText: string
}

interface FailureEntry {
  readonly action: BrowserNativeFailureAction
  readonly diagnostics?: boolean
  readonly en: FailureCopy
  readonly zh: FailureCopy
}

const FAILURES: Record<string, FailureEntry> = {
  SESSION_ALREADY_OWNED: {
    action: 'reload',
    en: {
      title: 'This Session is open in another tab',
      explanation: 'Only one tab can write a Session at a time. Close the other tab, or reload after its write lease expires to take over.',
      actionLabel: 'Reload and take over',
      copyText: '',
    },
    zh: {
      title: '该会话已在另一个标签页写入',
      explanation: '同一会话同时只能有一个写入者。请关闭另一个标签页，或等待其写租约到期后重新加载接管。',
      actionLabel: '重新加载并接管',
      copyText: '',
    },
  },
  SESSION_EDITOR_LEASE_HELD: {
    action: 'reload',
    en: {
      title: 'Another editor holds the write lease',
      explanation: 'A shared Session allows one writer. Wait for the current editor to finish, then reload to claim the lease.',
      actionLabel: 'Reload to claim the lease',
      copyText: '',
    },
    zh: {
      title: '另一个编辑者持有写入租约',
      explanation: '共享会话只允许一个写入者。请等待当前编辑者结束，然后重新加载获取租约。',
      actionLabel: '重新加载获取租约',
      copyText: '',
    },
  },
  SESSION_OWNERSHIP_LOST: {
    action: 'reload',
    en: {
      title: 'Write access moved to another tab',
      explanation: 'This tab lost the Session lease and cannot append more events. Reload to reclaim it.',
      actionLabel: 'Reload and reclaim',
      copyText: '',
    },
    zh: {
      title: '写入权已转移到另一个标签页',
      explanation: '当前标签页已失去会话租约，不能继续追加事件。重新加载可重新获取。',
      actionLabel: '重新加载并重新获取',
      copyText: '',
    },
  },
  SESSION_READ_ONLY: {
    action: 'request-access',
    en: {
      title: 'You can only view this Session',
      explanation: 'Shared Sessions are read-only for viewers. Ask the Session owner to grant you editor access, then reopen the Session.',
      actionLabel: 'Copy access request',
      copyText: 'Please grant me editor access to Session {session}. I can currently only view it.',
    },
    zh: {
      title: '你对这个会话只有查看权限',
      explanation: '共享会话对查看者是只读的。请让会话所有者授予你编辑权限，然后重新打开会话。',
      actionLabel: '复制权限申请',
      copyText: '请授予我会话 {session} 的编辑权限；我目前只能查看。',
    },
  },
  SESSION_OWNER_REQUIRED: {
    action: 'request-access',
    en: {
      title: 'Only the Session owner can do this',
      explanation: 'This change requires the owner write lease. Ask the owner to make it, or to grant you editor access.',
      actionLabel: 'Copy access request',
      copyText: 'Please grant me editor access to Session {session}; this change requires the owner write lease.',
    },
    zh: {
      title: '该操作需要会话所有者的写权限',
      explanation: '此修改需要所有者写租约。请让所有者执行，或请其授予你编辑权限。',
      actionLabel: '复制权限申请',
      copyText: '请授予我会话 {session} 的编辑权限；此修改需要所有者写租约。',
    },
  },
  SHARE_REQUIRED: {
    action: 'request-access',
    en: {
      title: 'This Session is not shared with you',
      explanation: 'Ask the owner for a share link or viewer grant, then reopen the Session.',
      actionLabel: 'Copy access request',
      copyText: 'Please share Session {session} with me so I can open it.',
    },
    zh: {
      title: '这个会话尚未共享给你',
      explanation: '请让所有者提供分享链接或查看授权，然后重新打开会话。',
      actionLabel: '复制权限申请',
      copyText: '请把会话 {session} 共享给我，以便我打开。',
    },
  },
  SESSION_NOT_FOUND: {
    action: 'request-access',
    en: {
      title: 'This Session is unavailable',
      explanation: 'Your access may have been revoked or the share link expired. Ask the owner for a new share.',
      actionLabel: 'Copy access request',
      copyText: 'Please send me a new share link for Session {session}; my previous access no longer works.',
    },
    zh: {
      title: '无法访问该会话',
      explanation: '你的访问可能已被撤销，或分享链接已过期。请让所有者重新共享。',
      actionLabel: '复制权限申请',
      copyText: '请重新给我会话 {session} 的分享链接；此前的访问已失效。',
    },
  },
  TOKEN_BUDGET_EXCEEDED: {
    action: 'contact-admin',
    diagnostics: true,
    en: {
      title: 'Token budget exhausted',
      explanation: 'The request was blocked before it reached the model, so no new provider cost was incurred. Ask an administrator to raise the Session or tenant budget, then retry the turn.',
      actionLabel: 'Copy admin request',
      copyText: 'Session {session} stopped with TOKEN_BUDGET_EXCEEDED{turn}. Please raise the Session or tenant token budget, then let me retry.',
    },
    zh: {
      title: 'Token 预算已用尽',
      explanation: '请求在发送给模型前被拦下，没有产生新的 provider 费用。请联系管理员调高 Session 或租户预算，然后重试该轮。',
      actionLabel: '复制管理员说明',
      copyText: '会话 {session} 因 TOKEN_BUDGET_EXCEEDED{turn} 停止，请调整 Session 或租户 token 预算后让我重试。',
    },
  },
  UPSTREAM_LLM_AUTH_FAILED: {
    action: 'contact-admin',
    diagnostics: true,
    en: {
      title: 'The model provider rejected its credentials',
      explanation: 'The configured provider key is invalid or expired. An administrator must fix the key before retrying.',
      actionLabel: 'Copy admin request',
      copyText: 'Session {session} failed with UPSTREAM_LLM_AUTH_FAILED{turn}. Please verify the model provider credentials.',
    },
    zh: {
      title: '模型服务拒绝了凭据',
      explanation: '配置的 provider 密钥无效或已过期。需由管理员修正密钥后才能重试。',
      actionLabel: '复制管理员说明',
      copyText: '会话 {session} 因 UPSTREAM_LLM_AUTH_FAILED{turn} 失败，请检查模型服务凭据。',
    },
  },
  UPSTREAM_LLM_RATE_LIMITED: {
    action: 'retry',
    en: {
      title: 'The model provider rate-limited this turn',
      explanation: 'Wait briefly, then retry. Repeated rate limits mean the provider quota needs raising.',
      actionLabel: 'Retry the turn',
      copyText: '',
    },
    zh: {
      title: '模型服务限流了本轮请求',
      explanation: '请稍等后重试。若持续限流，说明需要提高 provider 配额。',
      actionLabel: '重试该轮',
      copyText: '',
    },
  },
  UPSTREAM_LLM_TIMEOUT: {
    action: 'retry',
    diagnostics: true,
    en: {
      title: 'The model request timed out',
      explanation: 'The upstream provider did not finish in time. Retry the turn; if it repeats, export the diagnostics bundle.',
      actionLabel: 'Retry the turn',
      copyText: '',
    },
    zh: {
      title: '模型请求超时',
      explanation: '上游 provider 未在时限内完成。可重试该轮；若反复出现，请导出诊断包。',
      actionLabel: '重试该轮',
      copyText: '',
    },
  },
  UPSTREAM_LLM_UNAVAILABLE: {
    action: 'retry',
    diagnostics: true,
    en: {
      title: 'The model provider is unavailable',
      explanation: 'The provider could not be reached. Check connectivity and retry; persistent failures need an administrator.',
      actionLabel: 'Retry the turn',
      copyText: '',
    },
    zh: {
      title: '模型服务不可用',
      explanation: '无法连接上游 provider。请检查网络后重试；持续失败需联系管理员。',
      actionLabel: '重试该轮',
      copyText: '',
    },
  },
  UPSTREAM_LLM_STREAM_FAILED: {
    action: 'retry',
    diagnostics: true,
    en: {
      title: 'The model stream broke before completion',
      explanation: 'The response stream ended unexpectedly. Retry the turn; export the diagnostics bundle if it repeats.',
      actionLabel: 'Retry the turn',
      copyText: '',
    },
    zh: {
      title: '模型响应流中途断开',
      explanation: '响应流意外结束。可重试该轮；若反复出现，请导出诊断包。',
      actionLabel: '重试该轮',
      copyText: '',
    },
  },
  UPSTREAM_LLM_EMPTY: {
    action: 'retry',
    en: {
      title: 'The model returned no output',
      explanation: 'The provider closed the stream before producing text. Retry the turn.',
      actionLabel: 'Retry the turn',
      copyText: '',
    },
    zh: {
      title: '模型没有返回内容',
      explanation: 'provider 在产生文本前关闭了响应流。请重试该轮。',
      actionLabel: '重试该轮',
      copyText: '',
    },
  },
  ADMISSION_TIMEOUT: {
    action: 'retry',
    en: {
      title: 'The turn waited too long for a model slot',
      explanation: 'Other turns held the concurrency limit. Retry when the queue is shorter, or raise the limit.',
      actionLabel: 'Retry the turn',
      copyText: '',
    },
    zh: {
      title: '本轮等待模型执行槽位超时',
      explanation: '其他轮次占满了并发上限。请在队列较短时重试，或提高并发上限。',
      actionLabel: '重试该轮',
      copyText: '',
    },
  },
  SESSION_MOUNT_LIMIT: {
    action: 'reload',
    en: {
      title: 'Too many Sessions are open',
      explanation: 'The backend mounts at most 16 Sessions at once. Close an unused Session tab, then reload.',
      actionLabel: 'Reload after closing a Session',
      copyText: '',
    },
    zh: {
      title: '同时打开的会话过多',
      explanation: '后端最多同时挂载 16 个会话。请关闭不再使用的会话标签页后重新加载。',
      actionLabel: '关闭会话后重新加载',
      copyText: '',
    },
  },
  SESSION_TURN_ACTIVE: {
    action: 'retry',
    en: {
      title: 'A turn is already running for this Session',
      explanation: 'Another client is mid-turn. Wait for it to settle, then retry.',
      actionLabel: 'Retry the turn',
      copyText: '',
    },
    zh: {
      title: '该会话已有正在运行的轮次',
      explanation: '另一个客户端正在执行本轮。请等待其结算后重试。',
      actionLabel: '重试该轮',
      copyText: '',
    },
  },
  SESSION_RECOVERY_REQUIRED: {
    action: 'reload',
    en: {
      title: 'This Session needs a backend reload',
      explanation: 'Write access is blocked until the backend reloads its durable state. Contact an administrator if it persists.',
      actionLabel: 'Reload',
      copyText: '',
    },
    zh: {
      title: '该会话需要后端重新加载',
      explanation: '在后端重新加载持久化状态前，写入被阻止。若持续存在请联系管理员。',
      actionLabel: '重新加载',
      copyText: '',
    },
  },
  WORKSPACE_SNAPSHOT_STALE: {
    action: 'reload',
    en: {
      title: 'This read-only Workspace snapshot is stale',
      explanation: 'Another tab changed the Workspace. Reload to load the latest revision.',
      actionLabel: 'Reload the Workspace',
      copyText: '',
    },
    zh: {
      title: '当前只读工作区快照已过期',
      explanation: '另一个标签页修改了工作区。重新加载可获取最新版本。',
      actionLabel: '重新加载工作区',
      copyText: '',
    },
  },
}

const UNKNOWN_FAILURE_ENTRY: FailureEntry = {
  action: 'retry',
  diagnostics: true,
  en: {
    title: 'The operation failed',
    explanation: 'Retry once. If it still fails, export the diagnostics bundle and contact an administrator with the error code.',
    actionLabel: 'Export diagnostics bundle',
    copyText: '',
  },
  zh: {
    title: '操作失败',
    explanation: '请先重试一次；若仍失败，请导出诊断包并把错误码发给管理员。',
    actionLabel: '导出诊断包',
    copyText: '',
  },
}

const STATE_CODES: Partial<Record<BrowserNativeWorkspaceStatus['state'], string>> = {
  'session-conflict': 'SESSION_ALREADY_OWNED',
  'lease-conflict': 'SESSION_EDITOR_LEASE_HELD',
  'read-only': 'SESSION_READ_ONLY',
  stale: 'WORKSPACE_SNAPSHOT_STALE',
}

/**
 * Resolve the failure code behind a blocking Workspace state.
 * @param state - Workspace synchronization state shown to the user.
 * @returns The matching failure code, or undefined when the state has no dedicated guidance.
 */
export function browserNativeFailureCodeForState(state: BrowserNativeWorkspaceStatus['state']): string | undefined {
  return STATE_CODES[state]
}

/**
 * Explain a failure or rejection code and name the user's next action.
 * Unknown codes fall back to retry-once plus diagnostics guidance.
 * @param language - Page language tag.
 * @param code - Failure code recorded by the backend or Session log.
 * @param context - Optional Session id and turn number used in the copyable request text.
 * @returns Localized title, explanation, action, and copyable message.
 */
export function browserNativeFailureGuidanceCopy(
  language: string,
  code: string | undefined,
  context: { readonly sessionId?: string; readonly turn?: number } = {},
): BrowserNativeFailureGuidance {
  const normalized = code === undefined || code.length === 0 ? 'UNKNOWN_FAILURE' : code
  const entry = FAILURES[normalized] ?? UNKNOWN_FAILURE_ENTRY
  const copy = language.startsWith('zh') ? entry.zh : entry.en
  const turn = context.turn === undefined
    ? ''
    : language.startsWith('zh') ? `（第 ${String(context.turn)} 轮）` : ` (turn ${String(context.turn)})`
  return {
    code: normalized,
    title: copy.title,
    explanation: copy.explanation,
    action: entry.action,
    actionLabel: copy.actionLabel,
    copyText: copy.copyText
      .replaceAll('{session}', context.sessionId ?? '')
      .replaceAll('{turn}', turn),
    diagnostics: entry.diagnostics === true,
  }
}

/**
 * Report the outcome of the guidance action.
 * @param language - Page language tag.
 * @param action - Action that was invoked.
 * @param success - Whether the browser completed the action.
 * @param code - Failure code shown in the failure copy.
 * @returns Localized result text.
 */
export function browserNativeFailureActionResultCopy(
  language: string,
  action: BrowserNativeFailureAction,
  success: boolean,
  code: string,
): string {
  const zh = language.startsWith('zh')
  if (action === 'request-access') {
    return zh
      ? success ? '权限申请已复制，可发送给会话所有者。' : `复制失败；请手动提供错误码 ${code}。`
      : success ? 'Access request copied; send it to the Session owner.' : `Copy failed; report code ${code} manually.`
  }
  if (action === 'contact-admin') {
    return zh
      ? success ? '管理员说明已复制；请附上诊断包。' : `复制失败；请手动提供错误码 ${code}。`
      : success ? 'Admin request copied; attach the diagnostics bundle.' : `Copy failed; report code ${code} manually.`
  }
  if (action === 'diagnostics') {
    return zh
      ? success ? '诊断包已导出；会话数据未更改。' : `诊断包导出失败；请记录错误码 ${code}。`
      : success ? 'Diagnostics bundle exported; Session data was not changed.' : `Diagnostics export failed; record code ${code}.`
  }
  return zh ? '操作已提交。' : 'Action submitted.'
}
