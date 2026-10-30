import { describe, expect, it } from 'vitest'
import { createBrowserNativeMultiAgentProbe } from '../browser-native-multi-agent-probe.ts'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

interface FakeAgent {
  readonly id: SessionId
  status: 'idle' | 'running'
  readonly prompts: UserMessage[]
  readonly cancelCauses: { readonly kind: 'user' }[]
  followup(message: UserMessage): void
  cancel(cause: { readonly kind: 'user' }): void
}

function fakeRuntime(failCreateSessionId?: string) {
  const agents = new Map<string, FakeAgent>()
  const disposed: string[] = []
  const registry = {
    get(id: SessionId) { return agents.get(String(id)) },
    async create({ sessionId }: { readonly sessionId: SessionId }) {
      if (String(sessionId) === failCreateSessionId) throw new Error('injected Agent creation failure')
      const agent: FakeAgent = {
        id: sessionId,
        status: 'idle',
        prompts: [],
        cancelCauses: [],
        followup(message) {
          agent.prompts.push(message)
          agent.status = 'running'
        },
        cancel(cause) {
          agent.cancelCauses.push(cause)
          agent.status = 'idle'
        },
      }
      agents.set(String(sessionId), agent)
      return {
        agent,
        async dispose() {
          disposed.push(String(sessionId))
          agents.delete(String(sessionId))
        },
      }
    },
  }
  const probe = createBrowserNativeMultiAgentProbe(() => ({
    sessionId: value => value as SessionId,
    userMessage: value => ({
      id: value,
      role: 'user',
      content: [{ type: 'text', text: value }],
      source: { kind: 'user' },
    } as UserMessage),
  }))
  return { agents, disposed, registry, probe }
}

describe('Browser-Native multi-Agent validation probe', () => {
  it('starts distinct Agents in one registry and cancels only the selected Agent', async () => {
    const fake = fakeRuntime()
    const release = fake.probe.plugin({ agents: fake.registry })
    const started = await fake.probe.start([
      { sessionId: 'session-a', prompt: 'prompt-a' },
      { sessionId: 'session-b', prompt: 'prompt-b' },
      { sessionId: 'session-c', prompt: 'prompt-c' },
    ])

    expect(started).toEqual({ sessionIds: ['session-a', 'session-b', 'session-c'], startedCount: 3 })
    expect(fake.probe.status()).toEqual([
      { sessionId: 'session-a', status: 'running', registered: true },
      { sessionId: 'session-b', status: 'running', registered: true },
      { sessionId: 'session-c', status: 'running', registered: true },
    ])
    fake.probe.cancel('session-b')
    expect(fake.agents.get('session-a')?.cancelCauses).toEqual([])
    expect(fake.agents.get('session-b')?.cancelCauses).toEqual([{ kind: 'user' }])
    expect(fake.agents.get('session-c')?.cancelCauses).toEqual([])

    await release()
    expect(fake.disposed.sort()).toEqual(['session-a', 'session-b', 'session-c'])
    expect(fake.probe.status()).toEqual([])
  })

  it('rejects duplicate identities and duplicate live probe ownership', async () => {
    const fake = fakeRuntime()
    fake.probe.plugin({ agents: fake.registry })
    await expect(fake.probe.start([
      { sessionId: 'duplicate', prompt: 'one' },
      { sessionId: 'duplicate', prompt: 'two' },
    ])).rejects.toThrow(/must be unique/)
    await fake.probe.start([
      { sessionId: 'session-a', prompt: 'prompt-a' },
      { sessionId: 'session-b', prompt: 'prompt-b' },
    ])
    await expect(fake.probe.start([
      { sessionId: 'session-c', prompt: 'prompt-c' },
      { sessionId: 'session-d', prompt: 'prompt-d' },
    ])).rejects.toThrow(/already owns live Agents/)
    await fake.probe.dispose()
  })

  it('disposes every previously created Agent when a later Session creation fails', async () => {
    const fake = fakeRuntime('creation-failure')
    fake.probe.plugin({ agents: fake.registry })
    await expect(fake.probe.start([
      { sessionId: 'session-a', prompt: 'prompt-a' },
      { sessionId: 'creation-failure', prompt: 'prompt-b' },
    ])).rejects.toThrow('injected Agent creation failure')

    expect(fake.disposed).toEqual(['session-a'])
    expect([...fake.agents.keys()]).toEqual([])
    expect(fake.probe.status()).toEqual([])
  })
})
