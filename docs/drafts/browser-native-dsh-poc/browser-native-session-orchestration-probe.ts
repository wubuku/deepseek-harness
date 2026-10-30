import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentHandle,
  ModelSelection,
  ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  BrowserNativeSessionMountCoordinator,
  type BrowserNativeSessionMountSnapshot,
} from './browser-native-session-mount.ts'

interface OrchestrationAgent extends Agent {
  readonly status: 'idle' | 'running'
  followup(message: UserMessage): void
  cancel(cause: { readonly kind: 'user' }): void
  whenIdle(): Promise<void>
}

interface OrchestrationRegistry {
  create(options: {
    readonly sessionId: SessionId
    readonly agentOptions: { readonly provider: string; readonly model: string }
    readonly setup?: (agentCtx: Context, agent: Agent) => void
  }): Promise<AgentHandle>
  get(id: SessionId): Agent | undefined
}

interface OrchestrationContext {
  readonly agents: OrchestrationRegistry
}

export interface BrowserNativeSessionOrchestrationSpec {
  readonly sessionId: string
  readonly prompt: string
  readonly provider?: string
  readonly model?: string
}

export interface BrowserNativeSessionOrchestrationRuntime {
  sessionId(value: string): SessionId
  userMessage(value: string): UserMessage
  installModelSelection(agentCtx: Context, selection: ModelSelectionRef): () => void
}

export interface BrowserNativeSessionOrchestrationProbe {
  readonly plugin: ((context: OrchestrationContext) => () => Promise<void>) & { readonly inject: readonly ['agents'] }
  start(specs: readonly BrowserNativeSessionOrchestrationSpec[]): Promise<{
    readonly sessionIds: readonly string[]
    readonly startedCount: number
    readonly activeSessionId: string
  }>
  activate(sessionId: string): BrowserNativeSessionMountSnapshot
  park(sessionId: string): BrowserNativeSessionMountSnapshot
  cancel(sessionId: string): { readonly sessionId: string; readonly status: string }
  followup(sessionId: string, prompt: string): { readonly sessionId: string; readonly status: string }
  switchRoute(sessionId: string, route: ModelSelection): { readonly sessionId: string; readonly route: ModelSelection }
  status(): readonly {
    readonly sessionId: string
    readonly status: string
    readonly route: ModelSelection
    readonly mount: BrowserNativeSessionMountSnapshot
  }[]
  dispose(): Promise<{ readonly disposedCount: number; readonly remainingCount: number }>
}

const MAX_PROBE_AGENTS = 4

function assertIdentifier(value: string, name: string): void {
  if (value.length === 0 || value.length > 128) throw new Error(`session orchestration ${name} is invalid`)
}

function validateRoute(route: ModelSelection): ModelSelection {
  const provider = route.provider
  const model = route.model
  assertIdentifier(provider, 'provider')
  assertIdentifier(model, 'model')
  return { provider, model }
}

function routeOf(spec: BrowserNativeSessionOrchestrationSpec): ModelSelection {
  return validateRoute({ provider: spec.provider ?? 'browser-native', model: spec.model ?? 'browser-native' })
}

/** Coordinate real DSH Agents and page-local Session projection for validation only. */
export function createBrowserNativeSessionOrchestrationProbe(
  resolveRuntime: () => BrowserNativeSessionOrchestrationRuntime,
): BrowserNativeSessionOrchestrationProbe {
  let registry: OrchestrationRegistry | undefined
  let workerInstanceId: string | undefined
  const handles = new Map<string, AgentHandle>()
  const selections = new Map<string, ModelSelectionRef>()
  const executionIds = new Map<string, string>()
  const coordinator = new BrowserNativeSessionMountCoordinator()

  const dispose = async (): Promise<{ readonly disposedCount: number; readonly remainingCount: number }> => {
    const selected = [...handles.entries()]
    await Promise.all(selected.map(async ([sessionId, handle]) => {
      await handle.dispose()
      handles.delete(sessionId)
      selections.delete(sessionId)
      executionIds.delete(sessionId)
    }))
    coordinator.dispose('session orchestration probe disposed')
    return { disposedCount: selected.length, remainingCount: handles.size }
  }

  const plugin = Object.assign((context: OrchestrationContext) => {
    registry = context.agents
    workerInstanceId = crypto.randomUUID()
    return async () => {
      await dispose()
      registry = undefined
      workerInstanceId = undefined
    }
  }, { inject: ['agents'] as const })

  const recordCompletion = (sessionId: string, agent: OrchestrationAgent, executionId: string): void => {
    void agent.whenIdle().then(() => {
      const mount = coordinator.snapshots().find(snapshot => snapshot.sessionId === sessionId)
      if (mount?.execution?.executionId !== executionId) return
      if (mount.execution.state === 'running' || mount.execution.state === 'waiting') {
        coordinator.settleExecution(sessionId, executionId, { settlement: 'confirmed', message: 'Agent became idle' })
      }
    })
  }

  const begin = (sessionId: string): string => {
    const executionId = `execution-${sessionId}-${crypto.randomUUID()}`
    executionIds.set(sessionId, executionId)
    coordinator.beginExecution(sessionId, executionId)
    return executionId
  }

  return {
    plugin,
    async start(specs) {
      const currentRegistry = registry
      if (currentRegistry === undefined || workerInstanceId === undefined) throw new Error('session orchestration probe is not active')
      if (handles.size > 0) throw new Error('session orchestration probe already owns live Agents')
      if (specs.length < 1 || specs.length > MAX_PROBE_AGENTS) {
        throw new Error(`session orchestration probe accepts 1 to ${String(MAX_PROBE_AGENTS)} Agents`)
      }
      const ids = specs.map(spec => spec.sessionId)
      if (new Set(ids).size !== ids.length) throw new Error('session orchestration Session ids must be unique')
      const first = specs[0]
      if (first === undefined) throw new Error('session orchestration needs one Agent')
      const runtime = resolveRuntime()
      try {
        for (const spec of specs) {
          assertIdentifier(spec.sessionId, 'Session id')
          if (spec.prompt.length === 0 || spec.prompt.length > 256) throw new Error('session orchestration prompt is invalid')
          if (currentRegistry.get(runtime.sessionId(spec.sessionId)) !== undefined) {
            throw new Error(`session orchestration Session is already registered: ${spec.sessionId}`)
          }
          const route = routeOf(spec)
          const selection: ModelSelectionRef = { current: route, assembled: undefined }
          selections.set(spec.sessionId, selection)
          const handle = await currentRegistry.create({
            sessionId: runtime.sessionId(spec.sessionId),
            agentOptions: route,
            setup(agentCtx) {
              agentCtx.effect(() => runtime.installModelSelection(agentCtx, selection), 'browser-native session route selection')
            },
          })
          handles.set(spec.sessionId, handle)
          coordinator.mount({
            sessionId: spec.sessionId,
            identity: {
              sessionId: spec.sessionId,
              backendId: 'browser-native-orchestration-backend',
              workerInstanceId,
              ownerEpoch: 1,
            },
            ownerId: 'browser-native-orchestration-owner',
          })
          coordinator.hydrate(spec.sessionId, [], 0)
        }
        coordinator.activate(first.sessionId)
        for (const spec of specs) {
          const handle = handles.get(spec.sessionId)
          if (handle === undefined) throw new Error(`session orchestration lost ${spec.sessionId}`)
          begin(spec.sessionId)
        }
        for (const spec of specs) {
          const handle = handles.get(spec.sessionId)
          if (handle === undefined) throw new Error(`session orchestration lost ${spec.sessionId}`)
          handle.agent.followup(runtime.userMessage(spec.prompt))
          const executionId = executionIds.get(spec.sessionId)
          if (executionId === undefined) throw new Error(`session orchestration lost execution: ${spec.sessionId}`)
          recordCompletion(spec.sessionId, handle.agent as OrchestrationAgent, executionId)
        }
      } catch (error) {
        await dispose()
        throw error
      }
      return { sessionIds: ids, startedCount: handles.size, activeSessionId: first.sessionId }
    },
    activate(sessionId) {
      return coordinator.activate(sessionId)
    },
    park(sessionId) {
      return coordinator.park(sessionId)
    },
    cancel(sessionId) {
      const handle = handles.get(sessionId)
      if (handle === undefined) throw new Error(`session orchestration Session is not mounted: ${sessionId}`)
      handle.agent.cancel({ kind: 'user' })
      const executionId = executionIds.get(sessionId)
      if (executionId !== undefined) coordinator.settleExecution(sessionId, executionId, {
        settlement: 'failed',
        message: 'targeted user stop',
      })
      return { sessionId, status: (handle.agent as OrchestrationAgent).status }
    },
    followup(sessionId, prompt) {
      const handle = handles.get(sessionId)
      if (handle === undefined) throw new Error(`session orchestration Session is not mounted: ${sessionId}`)
      if (prompt.length === 0 || prompt.length > 256) throw new Error('session orchestration followup is invalid')
      const agent = handle.agent as OrchestrationAgent
      if (agent.status === 'running') throw new Error('session orchestration followup requires an idle Agent')
      const executionId = begin(sessionId)
      agent.followup(resolveRuntime().userMessage(prompt))
      recordCompletion(sessionId, agent, executionId)
      return { sessionId, status: agent.status }
    },
    switchRoute(sessionId, route) {
      const handle = handles.get(sessionId)
      if (handle === undefined) throw new Error(`session orchestration Session is not mounted: ${sessionId}`)
      const agent = handle.agent as OrchestrationAgent
      if (agent.status === 'running') throw new Error('MODEL_SWITCH_ACTIVE: route changes apply only before the next turn')
      const nextRoute = validateRoute({ provider: route.provider, model: route.model })
      const selection = selections.get(sessionId)
      if (selection === undefined) throw new Error(`session orchestration route is missing: ${sessionId}`)
      selection.current = nextRoute
      return { sessionId, route: nextRoute }
    },
    status() {
      return [...handles].map(([sessionId, handle]) => {
        const selection = selections.get(sessionId)
        const mount = coordinator.snapshots().find(snapshot => snapshot.sessionId === sessionId)
        if (selection === undefined || mount === undefined) throw new Error(`session orchestration state is missing: ${sessionId}`)
        return {
          sessionId,
          status: (handle.agent as OrchestrationAgent).status,
          route: { ...selection.current } as ModelSelection,
          mount,
        }
      })
    },
    dispose,
  }
}
