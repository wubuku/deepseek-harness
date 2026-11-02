import { mountLocalActivations } from './local-activation.ts'
/** A user stop of a parent turn reaches the work it delegated. */
import { setImmediate, setTimeout } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { NO_START_CAPABILITIES } from '../src/index.ts'
import { installSubagentStopPropagation } from '../src/stop-propagation.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { managerState } from './manager-internals.ts'

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function turnEnds(session: Session) {
  return session.snapshotEvents().filter((event): event is SessionEvent<'turn/end'> => event.type === 'turn/end')
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (check()) return
    await setTimeout(5)
  }
  throw new Error('condition was not reached')
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountLocalActivations(ctx)
  await ctx.plugin(SubagentRuntime)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.subagents.registerProvider({
    name: 'local',
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,
    prepareContinuable: () => Promise.resolve({}),
  })
  const { agent: parent } = await ctx.agents.create({
    sessionId: SessionId('stop-root'),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  return { ctx, parent, adapter }
}

describe('subagent stop propagation', () => {
  it('stops a running child when the user stops the parent turn, without waking the parent', async () => {
    const { ctx, parent, adapter } = await setup(['hang', 'hang'])
    const activation = await ctx.subagents.startActivation({
      provider: 'local',
      label: 'child task',
      delivery: 'parent',
      signal: new AbortController().signal,
      request: { parent, prompt: [{ type: 'text', text: 'child task' }] },
    })
    const child = ctx.agents.get(activation.childId)
    if (child === undefined) throw new Error('expected a live child Agent')
    try {
      await eventually(() => child.status === 'running')
      parent.followup(message('stop this work'))
      await eventually(() => parent.status === 'running')
      parent.cancel({ kind: 'user' })
      await parent.whenIdle()
      const requestsAtStop = adapter.requests.length
      await eventually(() => child.status === 'idle')

      // The child's turn records the stop it was given, and the parent's turn
      // records the user's stop; both are durable and neither is synthetic.
      expect(turnEnds(parent.session).map(event => event.data.reason)).toEqual([
        { kind: 'aborted', reason: { kind: 'user' } },
      ])
      expect(turnEnds(child.session).map(event => event.data.reason)).toEqual([
        { kind: 'aborted', reason: { kind: 'parent' } },
      ])

      // The settlement notice is recorded for the next turn but does not wake
      // the agent the user stopped: no further model request runs.
      await eventually(() => parent.inbox.nextStep.length === 1)
      const [notice] = parent.inbox.nextStep
      expect(notice?.source.kind).toBe('subagent-settled')
      expect(notice?.content[0]?.type === 'text' ? notice.content[0].text : '').toContain(String(activation.childId))
      await setImmediate()
      expect(parent.status).toBe('idle')
      expect(adapter.requests).toHaveLength(requestsAtStop)
      await eventually(() => managerState(ctx).resident.size === 0)
    } finally {
      await activation.dispose().catch(() => undefined)
      await ctx.fiber.dispose()
    }
  })

  it('ignores targeted, non-user, and non-turn stops', async () => {
    const ctx = new Context()
    const stopped: string[] = []
    installSubagentStopPropagation(ctx, id => stopped.push(String(id)))
    const topLevel = { id: SessionId('top-level'), header: {} } as Session
    const child = { id: SessionId('child'), header: { parentSession: SessionId('top-level') } } as Session
    ctx.root.emit('session/event', topLevel, {
      type: 'turn/start',
      seq: 1,
      data: { turn: 2 },
    } as SessionEvent<'turn/start'>)
    ctx.root.emit('session/event', topLevel, {
      type: 'turn/end',
      seq: 2,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as SessionEvent<'turn/end'>)
    ctx.root.emit('session/event', topLevel, {
      type: 'turn/end',
      seq: 3,
      data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'parent' } } },
    } as SessionEvent<'turn/end'>)
    ctx.root.emit('session/event', child, {
      type: 'turn/end',
      seq: 4,
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    } as SessionEvent<'turn/end'>)
    expect(stopped).toEqual([])
    await ctx.fiber.dispose()
  })

  it('leaves a child running when the parent turn ends normally', async () => {
    const { ctx, parent } = await setup(['hang', textResponse('done')])
    const activation = await ctx.subagents.startActivation({
      provider: 'local',
      label: 'child task',
      delivery: 'parent',
      signal: new AbortController().signal,
      request: { parent, prompt: [{ type: 'text', text: 'child task' }] },
    })
    const child = ctx.agents.get(activation.childId)
    if (child === undefined) throw new Error('expected a live child Agent')
    try {
      await eventually(() => child.status === 'running')
      parent.followup(message('parent work'))
      await parent.whenIdle()
      expect(turnEnds(parent.session).map(event => event.data.reason)).toEqual([{ kind: 'completed' }])
      expect(child.status).toBe('running')
    } finally {
      await activation.dispose().catch(() => undefined)
      await ctx.fiber.dispose()
    }
  })
})
