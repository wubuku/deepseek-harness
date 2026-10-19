import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId, SessionSeq } from '../../../../../packages/core/session/src/types.ts'
import { MessageId, ToolCallId } from '../../../../../packages/llm/llm/src/brand.ts'
import { DshSegmentedAgent, hydrateHistory, projectHistory } from '../dsh-segmented-agent.ts'
import { FrontendBridgeWithSegments } from '../bridge.ts'

const input = (messages: RunAgentInput['messages']): RunAgentInput => ({ threadId: 'session', runId: crypto.randomUUID(), state: {}, tools: [], context: [], messages, forwardedProps: {} })
function fixture() {
  let entries: SessionEventLikeEntry[] = []
  let prompts = 0
  let cancels = 0
  const listeners = new Set<() => void>()
  const responses: unknown[] = []
  const bridge = new FrontendBridgeWithSegments({ postMessage: value => { responses.push(value) } })
  const binding: ConstructorParameters<typeof DshSegmentedAgent>[0] = {
    sessionId: SessionId('session'),
    eventSource: { getSnapshot: () => ({ entries }), subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    session: {
      beginSubmission: () => { throw new Error('此测试在 prompt 准入前替换提交入口') },
      prompt: async () => { prompts += 1; return { ok: true, value: { accepted: true } } },
      cancel: async () => { cancels += 1; return { ok: true, value: { accepted: true } } },
    },
  }
  const agent = new DshSegmentedAgent(binding, bridge)
  return { binding, agent, bridge, listeners, responses, count: () => ({ prompts, cancels }), append: (...next: SessionEventLikeEntry[]) => { entries = [...entries, ...next]; for (const listener of listeners) listener() } }
}

async function pauseAtTool() {
  const state = fixture()
  state.binding.session.beginSubmission = () => ({ requestId: 'submission' as ReturnType<typeof state.binding.session.beginSubmission>['requestId'], abandon: () => {} })
  state.bridge.register('page_read', () => undefined)
  const paused = new Promise<void>((release, reject) => {
    state.agent.run(input([{ id: 'user', role: 'user', content: '读取页面' }])).subscribe({ complete: release, error: reject })
  })
  state.append(
    { type: 'event', event: { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } } },
    { type: 'event', event: { type: 'assistant/message', seq: SessionSeq(1), time: 1, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: { role: 'assistant', id: MessageId('message'), content: [{ type: 'tool-call', id: ToolCallId('original-call'), name: 'page_read', arguments: '{}' }] } } } },
  )
  state.bridge.handleRequest({ type: 'browser-native-frontend-tool-request', requestId: 'worker-request', sessionId: 'session', callId: 'original-call', name: 'page_read', arguments: {} })
  await paused
  return state
}

test('connect 只 hydration，不提交 prompt，也不重放工具', async () => {
  const state = fixture()
  state.append({ type: 'event', event: { type: 'assistant/message', seq: SessionSeq(1), time: 1, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: { role: 'assistant', id: MessageId('message'), content: [{ type: 'tool-call', id: ToolCallId('call'), name: 'page_read', arguments: '{}' }] } } } })
  const events: BaseEvent[] = []
  state.agent.connect(input([])).subscribe(event => events.push(event))
  assert.equal(events.filter(event => event.type === EventType.MESSAGES_SNAPSHOT).length, 1)
  assert.equal(projectHistory(state.binding.eventSource.getSnapshot().entries)[0].role, 'assistant')
  assert.deepEqual(state.count(), { prompts: 0, cancels: 0 })
  assert.equal(state.bridge.executions.length, 0)
  assert.match(JSON.stringify(hydrateHistory(state.binding.eventSource.getSnapshot().entries)), /执行已中断/)
  assert.equal(hydrateHistory(state.binding.eventSource.getSnapshot().entries).some(message => message.role === 'tool'), false)
})

test('detach/unsubscribe 只撤销观察，不把卸载当成用户 stop', () => {
  const state = fixture()
  const subscription = state.agent.run(input([])).subscribe()
  subscription.unsubscribe()
  assert.equal(state.listeners.size, 0)
  assert.equal(state.count().cancels, 0)
  state.agent.abortRun()
  assert.equal(state.count().cancels, 1)
})

test('同一输入身份拒绝第二次提交，错误可以被下一轮清除', () => {
  const state = fixture()
  const user = { id: 'same-user', role: 'user' as const, content: '测试' }
  state.binding.session.beginSubmission = () => ({ requestId: 'submission' as ReturnType<typeof state.binding.session.beginSubmission>['requestId'], abandon: () => {} })
  const subscription = state.agent.run(input([user])).subscribe()
  subscription.unsubscribe()
  state.agent.run(input([user])).subscribe()
  assert.match(state.agent.getError(), /重复输入/)
  assert.equal(state.count().prompts, 1)
  const next = state.agent.run(input([{ ...user, id: 'next-user' }])).subscribe()
  assert.equal(state.agent.getError(), '')
  next.unsubscribe()
})

test('原生工具结果续接同一 DSH turn，不新增 prompt 或提前结算', async () => {
  const state = await pauseAtTool()
  assert.equal(state.bridge.getSnapshot().length, 1)
  assert.deepEqual(state.responses, [])
  const completed = new Promise<void>((release, reject) => {
    state.agent.run(input([{ id: 'result', role: 'tool', toolCallId: 'original-call', content: '{"ok":true}' }])).subscribe({ complete: release, error: reject })
  })
  assert.deepEqual(state.responses, [{ type: 'browser-native-frontend-tool-response', requestId: 'worker-request', ok: true, result: { ok: true } }])
  assert.equal(state.bridge.getSnapshot().length, 0)
  state.append({ type: 'event', event: { type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } } } })
  await completed
  assert.deepEqual(state.count(), { prompts: 1, cancels: 0 })
  assert.deepEqual(state.agent.segments.map(segment => [segment.kind, segment.turn, segment.paused]), [['prompt', 1, true], ['continue', 1, false]])
  assert.equal(state.listeners.size, 0)
})

test('错误 call id 的续接保留原 waiter，随后正确结果仍可结算', async () => {
  const state = await pauseAtTool()
  state.agent.run(input([{ id: 'wrong-result', role: 'tool', toolCallId: 'unrelated-call', content: '{"ok":true}' }])).subscribe()
  assert.match(state.agent.getError(), /缺少原始 DSH 调用结果/)
  assert.equal(state.bridge.getSnapshot().length, 1)
  assert.deepEqual(state.responses, [])
  const subscription = state.agent.run(input([{ id: 'correct-result', role: 'tool', toolCallId: 'original-call', content: '{"ok":true}' }])).subscribe()
  assert.equal(state.bridge.getSnapshot().length, 0)
  assert.equal(state.responses.length, 1)
  assert.equal(state.count().prompts, 1)
  assert.equal(state.agent.getError(), '')
  subscription.unsubscribe()
  assert.equal(state.listeners.size, 0)
})
