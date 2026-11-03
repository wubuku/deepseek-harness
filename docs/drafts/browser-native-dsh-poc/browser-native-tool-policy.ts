/**
 * Profile-configured per-tool policy for Browser-Native tool calls.
 *
 * The policy maps tool names to `allow`, `ask`, or `deny`. `allow` and `ask`
 * run on the extensible `tools/pre-execute` waterfall; `deny` is enforced by a
 * monotonic `ctx.tools.guard`, so a later `allow` listener (or an approval
 * answerer) cannot force execution. Every decision appends a
 * `tool-policy/decided` Session event, which is the durable audit trail next to
 * the existing `approval/asked` + `approval/decided` pair.
 *
 * The probe is test-only: the Worker test port reads the live policy and
 * replaces it without reloading the profile.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { StaticModuleFactory } from '../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import type { ToolExecution, PreToolDecision } from '../../../packages/core/tools/src/index.ts'
import type {} from '@deepseek-ai/dsh-session'

/** One configured decision for a tool name. */
export type ToolPolicyAction = 'allow' | 'ask' | 'deny'

/** Profile YAML `config` for the policy plugin. */
export interface ToolPolicyConfig {
  /** Exact tool name → decision. Names absent here use {@link ToolPolicyConfig.default}. */
  readonly tools?: Readonly<Record<string, ToolPolicyAction>>
  /** Decision for unlisted tools; defaults to `allow`. */
  readonly default?: ToolPolicyAction
}

/** Immutable snapshot of the effective policy. */
export interface ToolPolicySnapshot {
  readonly tools: Readonly<Record<string, ToolPolicyAction>>
  readonly default: ToolPolicyAction
}

/** Test-only operations exposed through the Worker test port. */
export interface BrowserNativeToolPolicyProbe {
  readonly factory: StaticModuleFactory
  /**
   * Read the live policy without starting a turn.
   * @returns the current exact-name table and fallback decision.
   */
  state(): ToolPolicySnapshot
  /**
   * Replace the policy immediately for the next tool call.
   * @param policy - validated replacement; unknown names or decisions throw.
   * @returns the applied snapshot.
   */
  setPolicy(policy: ToolPolicyConfig): ToolPolicySnapshot
  /**
   * Register a permissive `tools/pre-execute` listener ahead of the policy
   * waterfall, proving the monotonic deny guard still wins.
   */
  armRogueAllow(): void
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * Durable audit of one profile tool-policy decision, appended inside the
     * open turn before the call outcome. Log-only; it carries no surface op.
     */
    'tool-policy/decided': {
      readonly tool: string
      readonly callId?: string
      readonly policy: ToolPolicyAction
    }
  }
}

const ACTIONS: readonly ToolPolicyAction[] = ['allow', 'ask', 'deny']
const DEFAULT_POLICY: ToolPolicySnapshot = { tools: {}, default: 'allow' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isAction(value: unknown): value is ToolPolicyAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value)
}

/** Validate one policy object at the profile or test-port boundary. */
function parsePolicy(value: unknown): ToolPolicySnapshot {
  if (value === undefined) return DEFAULT_POLICY
  if (!isRecord(value)) throw new Error('tool policy: config must be an object')
  const tools = value.tools ?? {}
  if (!isRecord(tools)) throw new Error('tool policy: "tools" must be a name → decision object')
  const parsed: Record<string, ToolPolicyAction> = {}
  for (const [name, action] of Object.entries(tools)) {
    if (name.length === 0) throw new Error('tool policy: tool names must be non-empty')
    if (!isAction(action)) {
      throw new Error(`tool policy: tool "${name}" must be one of ${ACTIONS.join(', ')}, got ${JSON.stringify(action)}`)
    }
    parsed[name] = action
  }
  const fallback = value.default ?? 'allow'
  if (!isAction(fallback)) {
    throw new Error(`tool policy: "default" must be one of ${ACTIONS.join(', ')}, got ${JSON.stringify(fallback)}`)
  }
  return { tools: parsed, default: fallback }
}

/**
 * Create the policy plugin and its test probe.
 *
 * The plugin reads the profile `config` through the loader's normal
 * `apply(ctx, config)` path, so composition — not a hardcoded constant —
 * owns the initial policy. The probe's `setPolicy` swaps the same variable the
 * two live registrations read, making changes effective on the next call.
 * @returns the static module factory plus test-only policy operations.
 */
export function createBrowserNativeToolPolicy(): BrowserNativeToolPolicyProbe {
  let activeContext: Context | undefined
  let policy: ToolPolicySnapshot = DEFAULT_POLICY

  const actionFor = (name: string): ToolPolicyAction => policy.tools[name] ?? policy.default

  const audit = (exec: ToolExecution, action: ToolPolicyAction): void => {
    const session = exec.agent?.session
    if (session === undefined) return
    session.append('tool-policy/decided', {
      tool: exec.name,
      ...(exec.callId === undefined ? {} : { callId: String(exec.callId) }),
      policy: action,
    })
  }

  const denyReason = (name: string): string => `tool "${name}" is denied by the profile tool policy`

  const module = {
    default: {
      name: 'browser-native-tool-policy',
      inject: ['tools'],
      apply(ctx: Context, config?: unknown): void {
        policy = parsePolicy(config)
        ctx.effect(() => {
          activeContext = ctx
          return () => {
            if (activeContext === ctx) activeContext = undefined
          }
        }, 'browser-native tool policy')
        // Monotonic deny: consulted after the waterfall even when another
        // listener returned `allow`, and after an approval grants the call.
        ctx.effect(() => ctx.tools.guard((exec) => {
          if (actionFor(exec.name) !== 'deny') return undefined
          audit(exec, 'deny')
          return denyReason(exec.name)
        }), 'browser-native tool policy guard')
        ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
          const action = actionFor(exec.name)
          if (action === 'deny') {
            // Early deterministic denial; the guard above remains the backstop
            // when a prepended listener short-circuits this waterfall.
            audit(exec, 'deny')
            return Promise.resolve({ kind: 'deny', reason: denyReason(exec.name) })
          }
          audit(exec, action)
          return action === 'ask'
            ? Promise.resolve({ kind: 'ask', reason: `tool "${exec.name}" requires approval under the profile tool policy` })
            : next()
        }, { prepend: true })
      },
    },
  }

  return {
    factory: () => module,
    state: () => policy,
    setPolicy: (next) => {
      policy = parsePolicy(next)
      return policy
    },
    armRogueAllow: () => {
      const ctx = activeContext
      if (ctx === undefined) throw new Error('browser-native tool policy: plugin is not mounted')
      let armed = true
      ctx.on('tools/pre-execute', (_exec, next) => {
        if (!armed) return next()
        armed = false
        return Promise.resolve<PreToolDecision>({ kind: 'allow' })
      }, { prepend: true })
    },
  }
}
