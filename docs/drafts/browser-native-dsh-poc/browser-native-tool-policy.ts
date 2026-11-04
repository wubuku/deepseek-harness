/**
 * Profile-configured per-tool policy for Browser-Native tool calls.
 *
 * The policy maps tool names to `allow`, `ask`, or `deny`, and optionally
 * restricts the file paths a tool may target. `allow` and `ask` run on the
 * extensible `tools/pre-execute` waterfall; `deny` is enforced by a monotonic
 * `ctx.tools.guard`, so a later `allow` listener (or an approval answerer)
 * cannot force execution. Every decision appends a `tool-policy/decided`
 * Session event, which is the durable audit trail next to the existing
 * `approval/asked` + `approval/decided` pair.
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

/**
 * Path restriction for one tool whose arguments carry a file path.
 *
 * A target inside any `allow` prefix keeps the tool-level decision; a target
 * outside every prefix uses `outside`. Paths are compared after normalizing
 * `.` and `..` segments, so a traversal cannot reach an allowed prefix.
 */
export interface ToolPolicyPathRule {
  /** Directory or file prefixes that keep the tool-level decision. */
  readonly allow: readonly string[]
  /** Decision for a target outside every allowed prefix. */
  readonly outside: ToolPolicyAction
  /**
   * Argument that carries the target path; defaults to `file_path`.
   * A missing or non-string argument counts as outside.
   */
  readonly argument?: string
}

/** Profile YAML `config` for the policy plugin. */
export interface ToolPolicyConfig {
  /** Exact tool name → decision. Names absent here use {@link ToolPolicyConfig.default}. */
  readonly tools?: Readonly<Record<string, ToolPolicyAction>>
  /** Tool name → allowed target prefixes and the decision outside them. */
  readonly paths?: Readonly<Record<string, ToolPolicyPathRule>>
  /** Decision for unlisted tools; defaults to `allow`. */
  readonly default?: ToolPolicyAction
}

/** Immutable snapshot of the effective policy. */
export interface ToolPolicySnapshot {
  readonly tools: Readonly<Record<string, ToolPolicyAction>>
  readonly default: ToolPolicyAction
  /** Present only when the profile configures path rules. */
  readonly paths?: Readonly<Record<string, ToolPolicyPathRule>>
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
      /** Normalized target path when a path rule produced the decision. */
      readonly path?: string
      /** Allowed prefixes echoed for a path-rule decision. */
      readonly allowedPaths?: readonly string[]
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

/** Collapse `.` and `..` segments; a `..` above root stays at root. */
function normalizeTarget(value: string): string {
  const parts: string[] = []
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function isWithin(target: string, prefix: string): boolean {
  if (prefix === '/') return target.startsWith('/')
  return target === prefix || target.startsWith(`${prefix}/`)
}

/** Decision resolved for one tool call, including the path rule that produced it. */
export interface ToolPolicyDecision {
  readonly action: ToolPolicyAction
  /** Normalized target path when the tool has a path rule. */
  readonly path?: string
  /** Normalized allowed prefixes when the tool has a path rule. */
  readonly allowedPaths?: readonly string[]
}

/**
 * Resolve the effective decision for one tool call target.
 *
 * A tool with a path rule keeps its tool-level decision only when the target
 * argument resolves inside one of the allowed prefixes; otherwise the rule's
 * `outside` decision applies. `arguments` is untrusted model JSON, so a
 * missing or non-string target counts as outside.
 * @param policy - effective policy snapshot.
 * @param tool - tool name being dispatched.
 * @param args - parsed tool arguments.
 * @returns the action plus the path-rule evidence used for audit.
 */
export function resolveToolPolicyAction(
  policy: ToolPolicySnapshot,
  tool: string,
  args: unknown,
): ToolPolicyDecision {
  const rule = policy.paths?.[tool]
  if (rule !== undefined) {
    const argument = rule.argument ?? 'file_path'
    const raw = isRecord(args) ? args[argument] : undefined
    const path = typeof raw === 'string' && raw.length > 0 ? normalizeTarget(raw) : undefined
    const allowedPaths = rule.allow.map(entry => normalizeTarget(entry))
    const inside = path !== undefined && allowedPaths.some(prefix => isWithin(path, prefix))
    return {
      action: inside ? policy.tools[tool] ?? policy.default : rule.outside,
      ...(path === undefined ? {} : { path }),
      allowedPaths,
    }
  }
  return { action: policy.tools[tool] ?? policy.default }
}

function parsePathRule(name: string, value: unknown): ToolPolicyPathRule {
  if (!isRecord(value)) throw new Error(`tool policy: paths["${name}"] must be an object`)
  const allow = value.allow
  if (!Array.isArray(allow) || allow.length === 0) {
    throw new Error(`tool policy: paths["${name}"].allow must be a non-empty array of path prefixes`)
  }
  for (const entry of allow) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`tool policy: paths["${name}"].allow entries must be non-empty strings`)
    }
  }
  const outside = value.outside ?? 'deny'
  if (!isAction(outside)) {
    throw new Error(`tool policy: paths["${name}"].outside must be one of ${ACTIONS.join(', ')}, got ${JSON.stringify(value.outside)}`)
  }
  const argument = value.argument
  if (argument !== undefined && (typeof argument !== 'string' || argument.length === 0)) {
    throw new Error(`tool policy: paths["${name}"].argument must be a non-empty string when given`)
  }
  return {
    allow: allow as string[],
    outside,
    ...(argument === undefined ? {} : { argument }),
  }
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
  const paths = value.paths ?? {}
  if (!isRecord(paths)) throw new Error('tool policy: "paths" must be a name → rule object')
  const parsedPaths: Record<string, ToolPolicyPathRule> = {}
  for (const [name, rule] of Object.entries(paths)) {
    if (name.length === 0) throw new Error('tool policy: path rule tool names must be non-empty')
    parsedPaths[name] = parsePathRule(name, rule)
  }
  const fallback = value.default ?? 'allow'
  if (!isAction(fallback)) {
    throw new Error(`tool policy: "default" must be one of ${ACTIONS.join(', ')}, got ${JSON.stringify(fallback)}`)
  }
  return {
    tools: parsed,
    default: fallback,
    ...(Object.keys(parsedPaths).length === 0 ? {} : { paths: parsedPaths }),
  }
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

  interface ResolvedDecision {
    readonly action: ToolPolicyAction
    readonly path?: string
    readonly allowedPaths?: readonly string[]
  }

  const resolve = (exec: ToolExecution): ResolvedDecision => resolveToolPolicyAction(policy, exec.name, exec.arguments)

  const audit = (exec: ToolExecution, decision: ResolvedDecision): void => {
    const session = exec.agent?.session
    if (session === undefined) return
    session.append('tool-policy/decided', {
      tool: exec.name,
      ...(exec.callId === undefined ? {} : { callId: String(exec.callId) }),
      policy: decision.action,
      ...(decision.path === undefined ? {} : { path: decision.path }),
      ...(decision.allowedPaths === undefined ? {} : { allowedPaths: decision.allowedPaths }),
    })
  }

  const reason = (exec: ToolExecution, decision: ResolvedDecision, action: 'deny' | 'ask'): string => {
    if (decision.path === undefined) {
      return action === 'deny'
        ? `tool "${exec.name}" is denied by the profile tool policy`
        : `tool "${exec.name}" requires approval under the profile tool policy`
    }
    const allowed = (decision.allowedPaths ?? []).join(', ')
    return action === 'deny'
      ? `tool "${exec.name}" is denied by the profile tool policy: "${decision.path}" is outside the allowed paths; use one of: ${allowed}`
      : `tool "${exec.name}" targeting "${decision.path}" requires approval under the profile tool policy; allowed paths: ${allowed}`
  }

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
          const decision = resolve(exec)
          if (decision.action !== 'deny') return undefined
          audit(exec, decision)
          return reason(exec, decision, 'deny')
        }), 'browser-native tool policy guard')
        ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
          const decision = resolve(exec)
          if (decision.action === 'deny') {
            // Early deterministic denial; the guard above remains the backstop
            // when a prepended listener short-circuits this waterfall.
            audit(exec, decision)
            return Promise.resolve({ kind: 'deny', reason: reason(exec, decision, 'deny') })
          }
          audit(exec, decision)
          return decision.action === 'ask'
            ? Promise.resolve({ kind: 'ask', reason: reason(exec, decision, 'ask') })
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
