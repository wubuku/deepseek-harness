/**
 * Budget snapshot copy and number formatting for the browser-native preview.
 *
 * The snapshot values come from provider-reported usage aggregated by the
 * backend; this module only formats them and names the pre-send action.
 */

/** Provider-reported usage totals for one Session or the whole tenant. */
export interface BrowserNativeBudgetUsage {
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly costUsd: number | null
}

/** Budget state returned by `GET /api/browser-native/session/budget`. */
export interface BrowserNativeBudgetSnapshot {
  readonly sessionId: string
  readonly tenantId: string | null
  readonly state: 'ok' | 'warning' | 'exceeded'
  readonly blockedScope: 'session' | 'tenant' | null
  readonly warningScope: 'session' | 'tenant'
  readonly warnRatio: number
  readonly limits: { readonly sessionTokens: number; readonly tenantTokens: number }
  readonly session: BrowserNativeBudgetUsage
  readonly tenant: BrowserNativeBudgetUsage
  readonly remaining: { readonly sessionTokens: number; readonly tenantTokens: number }
}

/** Localized budget lines and the administrator request text. */
export interface BrowserNativeBudgetCopy {
  readonly title: string
  readonly sessionLine: string
  readonly tenantLine: string
  readonly thresholdLine: string
  readonly warning: string
  readonly blocked: string
  readonly adminAction: string
  readonly diagnosticsAction: string
  readonly adminRequest: string
}

function formatTokens(language: string, value: number): string {
  return value.toLocaleString(language.startsWith('zh') ? 'zh-CN' : 'en-US')
}

function formatCost(language: string, value: number | null): string {
  return value === null ? (language.startsWith('zh') ? '费用不可用' : 'cost unavailable') : `$${value.toFixed(6)}`
}

/**
 * Format the budget snapshot as page copy.
 * @param language - Page language tag.
 * @param snapshot - Validated snapshot from the backend.
 * @returns Localized usage, warning, and blocked-send lines.
 */
export function browserNativeBudgetCopy(language: string, snapshot: BrowserNativeBudgetSnapshot): BrowserNativeBudgetCopy {
  const zh = language.startsWith('zh')
  const scope = zh
    ? snapshot.blockedScope === 'tenant' ? '租户' : '会话'
    : snapshot.blockedScope === 'tenant' ? 'tenant' : 'Session'
  const warningScope = zh
    ? snapshot.warningScope === 'tenant' ? '租户' : '会话'
    : snapshot.warningScope === 'tenant' ? 'tenant' : 'Session'
  const tenantLabel = snapshot.tenantId === null
    ? (zh ? '租户' : 'Tenant')
    : `${zh ? '租户' : 'Tenant'} ${snapshot.tenantId}`
  const sessionLine = zh
    ? `会话 ${formatTokens(language, snapshot.session.totalTokens)} / ${formatTokens(language, snapshot.limits.sessionTokens)} tokens（输入 ${formatTokens(language, snapshot.session.inputTokens)}，输出 ${formatTokens(language, snapshot.session.outputTokens)}）· ${formatCost(language, snapshot.session.costUsd)}`
    : `Session ${formatTokens(language, snapshot.session.totalTokens)} / ${formatTokens(language, snapshot.limits.sessionTokens)} tokens (in ${formatTokens(language, snapshot.session.inputTokens)}, out ${formatTokens(language, snapshot.session.outputTokens)}) · ${formatCost(language, snapshot.session.costUsd)}`
  const tenantLine = zh
    ? `${tenantLabel} ${formatTokens(language, snapshot.tenant.totalTokens)} / ${formatTokens(language, snapshot.limits.tenantTokens)} tokens · 剩余 ${formatTokens(language, snapshot.remaining.tenantTokens)} · ${formatCost(language, snapshot.tenant.costUsd)}`
    : `${tenantLabel} ${formatTokens(language, snapshot.tenant.totalTokens)} / ${formatTokens(language, snapshot.limits.tenantTokens)} tokens · ${formatTokens(language, snapshot.remaining.tenantTokens)} remaining · ${formatCost(language, snapshot.tenant.costUsd)}`
  const thresholdLine = zh
    ? `预警阈值 ${String(Math.round(snapshot.warnRatio * 100))}%`
    : `Warning at ${String(Math.round(snapshot.warnRatio * 100))}%`
  const warning = zh
    ? `${warningScope}预算已使用 ${String(Math.round(snapshot.warnRatio * 100))}% 或以上。达到上限后将禁用发送。`
    : `${warningScope} budget is at least ${String(Math.round(snapshot.warnRatio * 100))}% used. Sending is disabled when the limit is reached.`
  const blocked = zh
    ? `发送已禁用：${scope} token 预算已用尽。请联系管理员调高预算，或导出诊断包提交支持。`
    : `Sending is disabled: the ${scope} token budget is exhausted. Ask an administrator to raise the budget, or export diagnostics for support.`
  const adminRequest = zh
    ? `会话 ${snapshot.sessionId} 已使用 ${formatTokens(language, snapshot.session.totalTokens)}/${formatTokens(language, snapshot.limits.sessionTokens)} tokens，${tenantLabel} 已使用 ${formatTokens(language, snapshot.tenant.totalTokens)}/${formatTokens(language, snapshot.limits.tenantTokens)} tokens。${scope}预算已用尽，请调高预算，以便我继续发送。`
    : `Session ${snapshot.sessionId} has used ${formatTokens(language, snapshot.session.totalTokens)}/${formatTokens(language, snapshot.limits.sessionTokens)} tokens and ${tenantLabel} has used ${formatTokens(language, snapshot.tenant.totalTokens)}/${formatTokens(language, snapshot.limits.tenantTokens)} tokens. The ${scope} budget is exhausted; please raise it so I can send again.`
  return {
    title: zh ? '预算' : 'Budget',
    sessionLine,
    tenantLine,
    thresholdLine,
    warning,
    blocked,
    adminAction: zh ? '复制管理员说明' : 'Copy admin request',
    diagnosticsAction: zh ? '导出诊断包' : 'Export diagnostics',
    adminRequest,
  }
}
