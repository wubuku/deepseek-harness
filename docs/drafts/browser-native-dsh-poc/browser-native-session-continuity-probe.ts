import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentHandle,
  ModelSelection,
  ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {
  Session,
  SessionEvent,
  SessionId,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'

interface ContinuityAgent extends Agent {
  readonly status: 'idle' | 'running'
  readonly session: Session
  readonly inbox: { readonly nextTurn: readonly UserMessage[]; readonly nextStep: readonly UserMessage[] }
  followup(message: UserMessage): void
  cancel(cause: { readonly kind: 'user' }, options?: { readonly keepInbox?: boolean }): void
  whenIdle(): Promise<void>
}

interface ContinuityRegistry {
  create(options: {
    readonly sessionId: SessionId
    readonly seed?: readonly SessionEvent[]
    readonly inheritedEventCount?: SessionLogOffset
    readonly meta?: { readonly parentSession?: SessionId; readonly isSeeded?: boolean }
    readonly agentOptions: ModelSelection
    readonly setup?: (agentCtx: Context, agent: Agent) => void
  }): Promise<AgentHandle>
  resume(options: {
    readonly resumeSessionId: SessionId
    readonly agentOptions: ModelSelection
    readonly setup?: (agentCtx: Context, agent: Agent) => void
  }): Promise<AgentHandle>
  get(id: SessionId): Agent | undefined
}

interface ContinuityContext {
  readonly agents: ContinuityRegistry
}

export interface BrowserNativeSessionContinuityRuntime {
  sessionId(value: string): SessionId
  sessionSeq(value: number): SessionSeq
  sessionLogOffset(value: number): SessionLogOffset
  userMessage(value: string): UserMessage
  buildForkSeed(events: readonly SessionEvent[], boundary: SessionSeq): SessionEvent[]
  installModelSelection(agentCtx: Context, selection: ModelSelectionRef): () => void
}

export interface BrowserNativeSessionContinuityProbe {
  readonly plugin: ((context: ContinuityContext) => () => Promise<void>) & { readonly inject: readonly ['agents'] }
  start(options: { readonly sessionId: string; readonly prompt: string; readonly provider?: string; readonly model?: string }): Promise<{
    readonly sessionId: string
    readonly route: ModelSelection
  }>
  queueFollowup(sessionId: string, prompt: string): { readonly sessionId: string; readonly nextTurnCount: number }
  cancelKeepInbox(sessionId: string): { readonly sessionId: string; readonly nextTurnCount: number }
  resume(sessionId: string, prompt: string): Promise<{ readonly sessionId: string; readonly route: ModelSelection }>
  fork(sessionId: string, childSessionId: string, boundary?: number): Promise<{
    readonly parentSessionId: string
    readonly childSessionId: string
    readonly boundary: number
    readonly inheritedEventCount: number
    readonly seedLength: number
  }>
  followup(sessionId: string, prompt: string): { readonly sessionId: string; readonly nextTurnCount: number }
  status(): readonly {
    readonly sessionId: string
    readonly status: string
    readonly route: ModelSelection
    readonly eventCount: number
    readonly nextTurnCount: number
    readonly parentSessionId?: string
  }[]
  dispose(): Promise<{ readonly disposedCount: number; readonly remainingCount: number }>
}

function assertText(value: string, name: string): void {
  if (value.length === 0 || value.length > 256) throw new Error(`session continuity ${name} is invalid`)
}

function routeOf(agent: ContinuityAgent, fallback: ModelSelection): ModelSelection {
  const config = agent.session.requestHeader()?.config
  if (config === undefined) return { ...fallback }
  return { provider: config.provider, model: config.model }
}

/** Validate durable Agent input and Session branching against the real Worker Host. */
export function createBrowserNativeSessionContinuityProbe(
  resolveRuntime: () => BrowserNativeSessionContinuityRuntime,
): BrowserNativeSessionContinuityProbe {
  let registry: ContinuityRegistry | undefined
  const handles = new Map<string, AgentHandle>()
  const selections = new Map<string, ModelSelectionRef>()
  const parents = new Map<string, string>()

  const dispose = async (): Promise<{ readonly disposedCount: number; readonly remainingCount: number }> => {
    const selected = [...handles.entries()]
    await Promise.all(selected.map(async ([sessionId, handle]) => {
      await handle.dispose()
      handles.delete(sessionId)
      selections.delete(sessionId)
      parents.delete(sessionId)
    }))
    return { disposedCount: selected.length, remainingCount: handles.size }
  }

  const plugin = Object.assign((context: ContinuityContext) => {
    registry = context.agents
    return async () => {
      await dispose()
      registry = undefined
    }
  }, { inject: ['agents'] as const })

  const runtimeFor = (): BrowserNativeSessionContinuityRuntime => resolveRuntime()
  const currentRegistry = (): ContinuityRegistry => {
    if (registry === undefined) throw new Error('session continuity probe is not active')
    return registry
  }
  const routeFor = (provider?: string, model?: string): ModelSelection => ({
    provider: provider ?? 'browser-native',
    model: model ?? 'browser-native',
  })

  const installSelection = (
    agentCtx: Context,
    sessionId: string,
    selection: ModelSelectionRef,
  ): void => {
    selections.set(sessionId, selection)
    agentCtx.effect(() => runtimeFor().installModelSelection(agentCtx, selection), 'browser-native session continuity route')
  }

  const setupSelection = (sessionId: string, fallback: ModelSelection) => (agentCtx: Context, agent: Agent): void => {
    const selected = routeOf(agent as ContinuityAgent, fallback)
    installSelection(agentCtx, sessionId, { current: selected, assembled: undefined })
  }

  return {
    plugin,
    async start(options) {
      assertText(options.sessionId, 'Session id')
      assertText(options.prompt, 'prompt')
      const runtime = runtimeFor()
      const route = routeFor(options.provider, options.model)
      const handle = await currentRegistry().create({
        sessionId: runtime.sessionId(options.sessionId),
        agentOptions: route,
        setup: setupSelection(options.sessionId, route),
      })
      handles.set(options.sessionId, handle)
      handle.agent.followup(runtime.userMessage(options.prompt))
      return { sessionId: options.sessionId, route }
    },
    queueFollowup(sessionId, prompt) {
      assertText(prompt, 'follow-up')
      const handle = handles.get(sessionId)
      if (handle === undefined) throw new Error(`session continuity Session is not mounted: ${sessionId}`)
      handle.agent.followup(runtimeFor().userMessage(prompt))
      return { sessionId, nextTurnCount: (handle.agent as ContinuityAgent).inbox.nextTurn.length }
    },
    cancelKeepInbox(sessionId) {
      const handle = handles.get(sessionId)
      if (handle === undefined) throw new Error(`session continuity Session is not mounted: ${sessionId}`)
      handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
      return { sessionId, nextTurnCount: (handle.agent as ContinuityAgent).inbox.nextTurn.length }
    },
    async resume(sessionId, prompt) {
      assertText(prompt, 'resume prompt')
      const handle = handles.get(sessionId)
      if (handle !== undefined) {
        await handle.dispose()
        handles.delete(sessionId)
        selections.delete(sessionId)
      }
      const runtime = runtimeFor()
      const fallback = routeFor()
      const resumed = await currentRegistry().resume({
        resumeSessionId: runtime.sessionId(sessionId),
        agentOptions: fallback,
        setup: setupSelection(sessionId, fallback),
      })
      handles.set(sessionId, resumed)
      const selection = selections.get(sessionId)
      if (selection === undefined) throw new Error(`session continuity route missing after resume: ${sessionId}`)
      resumed.agent.followup(runtime.userMessage(prompt))
      return { sessionId, route: { ...selection.current } }
    },
    async fork(sessionId, childSessionId, boundary) {
      assertText(childSessionId, 'child Session id')
      const parent = handles.get(sessionId)
      if (parent === undefined) throw new Error(`session continuity parent is not mounted: ${sessionId}`)
      if (handles.has(childSessionId) || currentRegistry().get(runtimeFor().sessionId(childSessionId)) !== undefined) {
        throw new Error(`session continuity child already exists: ${childSessionId}`)
      }
      const parentAgent = parent.agent as ContinuityAgent
      const events = parentAgent.session.snapshotEvents()
      const last = events.at(-1)
      const selectedBoundary = boundary ?? last?.seq
      if (selectedBoundary === undefined) throw new Error('session continuity cannot fork an empty Session')
      const seed = runtimeFor().buildForkSeed(events, runtimeFor().sessionSeq(selectedBoundary))
      const inheritedEventCount = runtimeFor().sessionLogOffset(selectedBoundary + 1)
      const parentRoute = routeOf(parentAgent, routeFor())
      const child = await currentRegistry().create({
        sessionId: runtimeFor().sessionId(childSessionId),
        seed,
        inheritedEventCount,
        meta: { parentSession: runtimeFor().sessionId(sessionId), isSeeded: true },
        agentOptions: parentRoute,
        setup: setupSelection(childSessionId, parentRoute),
      })
      handles.set(childSessionId, child)
      parents.set(childSessionId, sessionId)
      return {
        parentSessionId: sessionId,
        childSessionId,
        boundary: selectedBoundary,
        inheritedEventCount,
        seedLength: seed.length,
      }
    },
    followup(sessionId, prompt) {
      return this.queueFollowup(sessionId, prompt)
    },
    status() {
      return [...handles].map(([sessionId, handle]) => {
        const selection = selections.get(sessionId)
        if (selection === undefined) throw new Error(`session continuity route missing: ${sessionId}`)
        const agent = handle.agent as ContinuityAgent
        return {
          sessionId,
          status: agent.status,
          route: { ...selection.current },
          eventCount: agent.session.snapshotEvents().length,
          nextTurnCount: agent.inbox.nextTurn.length,
          ...(parents.has(sessionId) ? { parentSessionId: parents.get(sessionId) } : {}),
        }
      })
    },
    dispose,
  }
}
