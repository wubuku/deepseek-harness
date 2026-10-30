import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

interface ProbeAgent {
  readonly id: SessionId
  readonly status: string
  followup(message: UserMessage): void
  cancel(cause: { readonly kind: 'user' }): void
}

interface ProbeAgentHandle {
  readonly agent: ProbeAgent
  dispose(): Promise<void>
}

interface ProbeAgentRegistry {
  create(options: {
    readonly sessionId: SessionId
    readonly agentOptions: { readonly provider: string; readonly model: string }
  }): Promise<ProbeAgentHandle>
  get(id: SessionId): ProbeAgent | undefined
}

interface ProbeContext {
  readonly agents: ProbeAgentRegistry
}

export interface BrowserNativeMultiAgentSpec {
  readonly sessionId: string
  readonly prompt: string
}

export interface BrowserNativeMultiAgentRuntime {
  sessionId(value: string): SessionId
  userMessage(value: string): UserMessage
}

export interface BrowserNativeMultiAgentProbe {
  readonly plugin: ((context: ProbeContext) => () => Promise<void>) & { readonly inject: readonly ['agents'] }
  start(specs: readonly BrowserNativeMultiAgentSpec[]): Promise<{
    readonly sessionIds: readonly string[]
    readonly startedCount: number
  }>
  cancel(sessionId: string): { readonly sessionId: string; readonly status: string }
  status(): readonly { readonly sessionId: string; readonly status: string; readonly registered: boolean }[]
  dispose(sessionIds?: readonly string[]): Promise<{ readonly disposedCount: number; readonly remainingCount: number }>
}

const MAX_PROBE_AGENTS = 4

/** Create a validation-only controller for real AgentRegistry instances in one Worker Host. */
export function createBrowserNativeMultiAgentProbe(
  resolveRuntime: () => BrowserNativeMultiAgentRuntime,
): BrowserNativeMultiAgentProbe {
  let registry: ProbeAgentRegistry | undefined
  const handles = new Map<string, ProbeAgentHandle>()

  const dispose = async (sessionIds: readonly string[] = [...handles.keys()]): Promise<{
    readonly disposedCount: number
    readonly remainingCount: number
  }> => {
    const selected = [...new Set(sessionIds)]
    const outcomes = await Promise.all(selected.map(async sessionId => {
      const handle = handles.get(sessionId)
      if (handle === undefined) return false
      await handle.dispose()
      handles.delete(sessionId)
      return true
    }))
    return { disposedCount: outcomes.filter(Boolean).length, remainingCount: handles.size }
  }

  const plugin = Object.assign((context: ProbeContext) => {
    registry = context.agents
    return async () => {
      await dispose()
      registry = undefined
    }
  }, { inject: ['agents'] as const })

  return {
    plugin,
    async start(specs) {
      const currentRegistry = registry
      if (currentRegistry === undefined) throw new Error('multi-Agent probe plugin is not active')
      if (handles.size > 0) throw new Error('multi-Agent probe already owns live Agents')
      if (specs.length < 2 || specs.length > MAX_PROBE_AGENTS) {
        throw new Error(`multi-Agent probe accepts 2 to ${String(MAX_PROBE_AGENTS)} Agents`)
      }
      const ids = specs.map(spec => spec.sessionId)
      if (new Set(ids).size !== ids.length) throw new Error('multi-Agent probe Session ids must be unique')
      const runtime = resolveRuntime()
      for (const spec of specs) {
        if (spec.sessionId.length === 0 || spec.prompt.length === 0) {
          throw new Error('multi-Agent probe requires a Session id and prompt for every Agent')
        }
        if (currentRegistry.get(runtime.sessionId(spec.sessionId)) !== undefined) {
          throw new Error(`multi-Agent probe Session is already registered: ${spec.sessionId}`)
        }
      }

      try {
        for (const spec of specs) {
          const handle = await currentRegistry.create({
            sessionId: runtime.sessionId(spec.sessionId),
            agentOptions: { provider: 'browser-native', model: 'browser-native' },
          })
          handles.set(spec.sessionId, handle)
        }
        for (const spec of specs) {
          const handle = handles.get(spec.sessionId)
          if (handle === undefined) throw new Error(`multi-Agent probe lost Session owner: ${spec.sessionId}`)
          handle.agent.followup(runtime.userMessage(spec.prompt))
        }
      } catch (error) {
        await dispose()
        throw error
      }

      return { sessionIds: ids, startedCount: handles.size }
    },
    cancel(sessionId) {
      const handle = handles.get(sessionId)
      if (handle === undefined) throw new Error(`multi-Agent probe Session is not mounted: ${sessionId}`)
      handle.agent.cancel({ kind: 'user' })
      return { sessionId, status: handle.agent.status }
    },
    status() {
      const currentRegistry = registry
      return [...handles].map(([sessionId, handle]) => ({
        sessionId,
        status: handle.agent.status,
        registered: currentRegistry?.get(handle.agent.id) === handle.agent,
      }))
    },
    async dispose(sessionIds) {
      return await dispose(sessionIds)
    },
  }
}
