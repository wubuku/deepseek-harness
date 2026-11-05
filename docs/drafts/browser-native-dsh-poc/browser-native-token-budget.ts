/**
 * Validation-only Session and tenant token budget for Browser-Native DSH.
 *
 * The plugin meters durable provider usage through Token-meter's `tokenUsage`
 * projection, sums the sessions of the backend-published tenant, and appends
 * one `budget/exceeded` audit event per session/scope crossing. Enforcement
 * happens in two places inside the Worker: the Browser-Native LLM adapter asks
 * {@link BrowserNativeTokenBudgetProbe.canRequest} before each upstream request,
 * and a monotonic `ctx.tools.guard` refuses tool execution once a limit is
 * crossed. The guard is the tool-execution-layer stop: it still refuses when the
 * request preflight is skipped or a caller bypasses the adapter.
 *
 * The profile carries no limits: the runtime probe refuses startup when the
 * image requires a budget the backend does not publish, and plugin load adopts
 * the probed limits so the page and the Worker cannot meter different budgets.
 *
 * The probe is test-only. It reads the live counters, replaces the limits, and
 * toggles the request preflight without reloading the profile.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { StaticModuleFactory } from '../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import type { ToolExecution } from '../../../packages/core/tools/src/index.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-session-projection'
import { readBrowserNativeProbedBudget } from './browser-native-runtime-probes.ts'

/** Limits the mounted plugin enforces; both consumers read these values. */
interface MountedBudget {
  readonly tenantId: string
  readonly sessionLimit: number
  readonly tenantLimit: number
}

/** One Session's metered totals. */
export interface TokenBudgetSessionState {
  readonly sessionId: string
  readonly inputTokens: number
  readonly outputTokens: number
}

/** Live budget state returned by the test port. */
export interface TokenBudgetState {
  readonly tenantId: string
  readonly limits: { readonly sessionLimit: number; readonly tenantLimit: number } | undefined
  readonly sessions: readonly TokenBudgetSessionState[]
  readonly tenant: { readonly inputTokens: number; readonly outputTokens: number }
  readonly blocked: readonly string[]
  readonly exceeded: readonly string[]
}

/** Test-only operations exposed through the Worker test port. */
export interface BrowserNativeTokenBudgetProbe {
  readonly factory: StaticModuleFactory
  /**
   * Read live limits and meter totals.
   * @returns the limits plus each known Session and the tenant aggregate.
   */
  state(): TokenBudgetState
  /**
   * Replace both limits immediately and clear per-scope crossing markers.
   * @param limits - positive integer token limits.
   * @returns the applied state.
   */
  setLimits(limits: { sessionLimit: number; tenantLimit: number }): TokenBudgetState
  /**
   * Decide whether one upstream request may proceed.
   * @param sessionId - Session requesting the model call, when known.
   * @returns `undefined` to proceed, otherwise a user-visible budget reason.
   */
  canRequest(sessionId: string | undefined): string | undefined
  /**
   * Toggle the adapter's pre-request check, so a test can prove the tool
   * execution guard refuses on its own.
   * @param enabled - whether {@link BrowserNativeTokenBudgetProbe.canRequest} still refuses.
   * @returns the applied toggle state.
   */
  setRequestCheck(enabled: boolean): { readonly enabled: boolean }
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * Durable record that one Session crossed a token limit. Log-only; the
     * enforcing visible error is the failed model request that follows.
     */
    'budget/exceeded': {
      readonly scope: 'session' | 'tenant'
      readonly tenantId: string
      readonly sessionId: string
      readonly inputTokens: number
      readonly outputTokens: number
      readonly limit: number
    }
  }
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`token budget: "${name}" must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Refuse plugin load with the code the startup probe reports. */
class BudgetConfigError extends Error {
  constructor(readonly code: 'BUDGET_LIMITS_UNCONFIGURED', message: string) {
    super(`${message} (${code})`)
  }
}

/**
 * Read the budget the runtime probe received from the backend.
 * @returns the limits every budget consumer shares.
 */
function probedBudgetOrFail(): MountedBudget {
  const budget = readBrowserNativeProbedBudget()
  if (budget === undefined) {
    throw new BudgetConfigError('BUDGET_LIMITS_UNCONFIGURED', 'token budget: backend did not publish budget limits')
  }
  return {
    tenantId: budget.tenantId,
    sessionLimit: budget.sessionTokens,
    tenantLimit: budget.tenantTokens,
  }
}

/**
 * Create the budget plugin and its test probe.
 * @returns the static module factory plus live metering and enforcement.
 */
export function createBrowserNativeTokenBudget(): BrowserNativeTokenBudgetProbe {
  let ctx: Context | undefined
  let config: MountedBudget | undefined
  const sessions = new Map<string, Session>()
  const exceeded = new Set<string>()
  /** Meter states already audited, so several refusals at one usage append once. */
  const audited = new Set<string>()
  let requestCheck = true

  const meterOf = (session: Session): { inputTokens: number; outputTokens: number } => {
    const state = ctx?.sessionProjections.stateOf(session, 'tokenUsage')
    const totals = state?.totals
    return {
      inputTokens: (totals?.uncachedInputTokens ?? 0) + (totals?.cacheReadTokens ?? 0) + (totals?.cacheWriteTokens ?? 0),
      outputTokens: totals?.outputTokens ?? 0,
    }
  }

  const tenantTotals = (): { inputTokens: number; outputTokens: number } => {
    const total = { inputTokens: 0, outputTokens: 0 }
    for (const session of sessions.values()) {
      const meter = meterOf(session)
      total.inputTokens += meter.inputTokens
      total.outputTokens += meter.outputTokens
    }
    return total
  }

  const audit = (session: Session, scope: 'session' | 'tenant'): void => {
    if (config === undefined) return
    const meter = meterOf(session)
    const key = `${String(session.id)}:${scope}`
    exceeded.add(key)
    // Usage that grew after the first refusal is a new crossing, so record it
    // once for that meter state; identical totals stay deduplicated.
    const meterKey = `${key}:${meter.inputTokens}:${meter.outputTokens}`
    if (audited.has(meterKey)) return
    audited.add(meterKey)
    session.append('budget/exceeded', {
      scope,
      tenantId: config.tenantId,
      sessionId: String(session.id),
      inputTokens: meter.inputTokens,
      outputTokens: meter.outputTokens,
      limit: scope === 'session' ? config.sessionLimit : config.tenantLimit,
    })
  }

  const resolveSession = (sessionId: string | undefined): Session | undefined => {
    if (sessionId === undefined) return undefined
    return sessions.get(sessionId)
  }

  const reasonFor = (session: Session | undefined): string | undefined => {
    if (config === undefined) return undefined
    const totals = tenantTotals()
    if (session !== undefined) {
      const meter = meterOf(session)
      if (meter.inputTokens + meter.outputTokens > config.sessionLimit) {
        audit(session, 'session')
        return `token budget exceeded (session): ${meter.inputTokens + meter.outputTokens}/${config.sessionLimit} tokens`
      }
    }
    if (totals.inputTokens + totals.outputTokens > config.tenantLimit) {
      if (session !== undefined) audit(session, 'tenant')
      return `token budget exceeded (tenant ${config.tenantId}): ${totals.inputTokens + totals.outputTokens}/${config.tenantLimit} tokens`
    }
    return undefined
  }

  const module = {
    default: {
      name: 'browser-native-token-budget',
      inject: ['sessionProjections', 'tools'],
      apply(applyCtx: Context): void {
        ctx = applyCtx
        // The runtime probe already fetched the backend configuration; adoption
        // is synchronous and adds no second limit source.
        config = probedBudgetOrFail()
        ctx.on('session/event', (session) => {
          sessions.set(String(session.id), session)
        })
        // Tool execution is the in-place stop: it holds even when the request
        // preflight is skipped, so a bypassed adapter cannot execute a call.
        ctx.effect(() => ctx.tools.guard((exec: Readonly<ToolExecution>) => reasonFor(exec.agent?.session)),
          'browser-native token budget guard')
      },
    },
  }

  return {
    factory: () => module,
    state: () => {
      const totals = tenantTotals()
      return {
        tenantId: config?.tenantId ?? '',
        limits: config === undefined
          ? undefined
          : { sessionLimit: config.sessionLimit, tenantLimit: config.tenantLimit },
        sessions: [...sessions.values()].map(session => ({ sessionId: String(session.id), ...meterOf(session) })),
        tenant: totals,
        blocked: [...sessions.keys()].filter(id => exceeded.has(`${id}:session`) || exceeded.has(`${id}:tenant`)),
        exceeded: [...exceeded],
      }
    },
    setLimits: (limits) => {
      if (config === undefined) throw new Error('token budget: plugin is not mounted')
      config = {
        ...config,
        sessionLimit: positiveInteger(limits.sessionLimit, 'sessionLimit'),
        tenantLimit: positiveInteger(limits.tenantLimit, 'tenantLimit'),
      }
      exceeded.clear()
      audited.clear()
      return {
        tenantId: config.tenantId,
        limits: { sessionLimit: config.sessionLimit, tenantLimit: config.tenantLimit },
        sessions: [...sessions.values()].map(session => ({ sessionId: String(session.id), ...meterOf(session) })),
        tenant: tenantTotals(),
        blocked: [],
        exceeded: [],
      }
    },
    canRequest: (sessionId) => requestCheck ? reasonFor(resolveSession(sessionId)) : undefined,
    setRequestCheck: (enabled) => {
      requestCheck = enabled
      return { enabled: requestCheck }
    },
  }
}
