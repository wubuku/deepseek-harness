import type { Context } from '@deepseek-ai/cordis'
import type { StaticModuleFactory } from '../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'

/** The permission state observed for one live Browser-Native Session. */
export interface BrowserNativePermissionSnapshot {
  readonly sessionId: string
  readonly currentPreset: string
  readonly sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly approvalPolicy: 'ask' | 'never'
  readonly availablePresets: readonly string[]
  readonly workspaceRoot: string
}

/** Static module plus permission-inspection and Agent-cancellation test operations. */
export interface BrowserNativePermissionProbe {
  readonly factory: StaticModuleFactory
  /**
   * Read permission services for one live Session without changing them.
   * @param sessionId - Session identifier selected by the browser test.
   * @returns The current permission and sandbox values.
   * @throws when the probe is not mounted or the Session is not live.
   */
  readonly inspect: (sessionId: string) => BrowserNativePermissionSnapshot
  /**
   * Cancel one running Agent through its public runtime API.
   * @param sessionId - Session identifier owned by the Agent.
   * @returns Whether a running Agent received cancellation.
   */
  readonly cancel: (sessionId: string) => boolean
}

interface BrowserNativeCancelableAgent extends Agent {
  readonly status: 'idle' | 'running'
  cancel(cause: { readonly kind: 'user' }, options?: { readonly keepInbox?: boolean }): void
}

interface BrowserNativeAgentRegistry {
  get(sessionId: SessionId): BrowserNativeCancelableAgent | undefined
}

function sessionFor(ctx: Context, sessionId: string): Session {
  const sessions = ctx.get('sessions') as { list(): readonly Session[] }
  const session = sessions.list().find(candidate => String(candidate.id) === sessionId)
  if (session === undefined) throw new Error(`browser-native permission probe: Session "${sessionId}" is not live`)
  return session
}

interface BrowserNativePermissionServices {
  readonly permissionPresets: {
    current(session: Session): string
    catalog(): { options: readonly { value: string }[] }
  }
  readonly sandboxPolicy: {
    resolve(request: { session: Session }): {
      mode: BrowserNativePermissionSnapshot['sandboxMode']
      workspaceRoot: string
    }
  }
  readonly approval: {
    config: { policy?: BrowserNativePermissionSnapshot['approvalPolicy'] }
    overrideOf(session: Session): BrowserNativePermissionSnapshot['approvalPolicy'] | undefined
  }
}

/**
 * Create a Worker-local probe for the formal permission services and live Agents.
 *
 * The probe is not a permission provider and exposes no model tool. Its
 * inspection and cancellation methods are available only through the PoC test
 * MessagePort.
 * @returns A memoized static module and its test operations.
 */
export function createBrowserNativePermissionProbe(): BrowserNativePermissionProbe {
  let activeContext: Context | undefined
  const cancel = (sessionId: string): boolean => {
    const ctx = activeContext
    if (ctx === undefined) throw new Error('browser-native permission probe: service is not mounted')
    const agents = ctx.get('agents') as BrowserNativeAgentRegistry
    const agent = agents.get(sessionId as SessionId)
    if (agent?.status !== 'running') return false
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return true
  }
  const inspect = (sessionId: string): BrowserNativePermissionSnapshot => {
    const ctx = activeContext
    if (ctx === undefined) throw new Error('browser-native permission probe: service is not mounted')
    const session = sessionFor(ctx, sessionId)
    const services = {
      permissionPresets: ctx.get('permissionPresets'),
      sandboxPolicy: ctx.get('sandboxPolicy'),
      approval: ctx.get('approval'),
    } as BrowserNativePermissionServices
    const policy = services.sandboxPolicy.resolve({ session })
    return {
      sessionId,
      currentPreset: services.permissionPresets.current(session),
      sandboxMode: policy.mode,
      approvalPolicy: services.approval.overrideOf(session) ?? services.approval.config.policy ?? 'ask',
      availablePresets: [...services.permissionPresets.catalog().options.map(option => option.value)],
      workspaceRoot: policy.workspaceRoot,
    }
  }
  const module = {
    default: (ctx: Context): void => {
      ctx.effect(() => {
        activeContext = ctx
        return () => {
          if (activeContext === ctx) activeContext = undefined
        }
      }, 'browser-native permission probe')
    },
  }
  return { factory: () => module, inspect, cancel }
}
