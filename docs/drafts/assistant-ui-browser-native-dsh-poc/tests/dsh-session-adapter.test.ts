import assert from 'node:assert/strict'
import test from 'node:test'
import { DshSessionAdapter, projectDshEvents } from '../src/dsh-session-adapter.ts'

function sessionSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-test',
    pendingSubmissions: [],
    running: false,
    subagent: null,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
    ...overrides,
  }
}

function eventSource(entries: readonly object[]) {
  return {
    getSnapshot: () => ({ entries }),
    subscribe: () => () => {},
  }
}

function fakeSession(overrides: Record<string, unknown> = {}) {
  const listeners = new Set<() => void>()
  const calls = { beginSubmission: 0, prompt: 0, cancel: 0 }
  let snapshot = sessionSnapshot()
  const session = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    beginSubmission: ({ text }: { text: string }) => {
      calls.beginSubmission += 1
      snapshot = { ...snapshot, pendingSubmissions: [{ requestId: 'request-test', placement: 'transcript', time: 1, text, attachments: [] }] }
      for (const listener of listeners) listener()
      return { requestId: 'request-test', abandon: () => {} }
    },
    prompt: async () => {
      calls.prompt += 1
      return { ok: true, value: { accepted: true } } as const
    },
    cancel: async () => {
      calls.cancel += 1
      return { ok: true, value: { accepted: true } } as const
    },
    loadOlder: async () => {},
    ...overrides,
  }
  return { session, calls }
}

test('projects durable DSH user and assistant events without creating a second history', () => {
  const projected = projectDshEvents({
    getSnapshot: () => sessionSnapshot(),
  }, eventSource([
    {
      type: 'event',
      event: {
        type: 'user/message',
        seq: 1,
        time: 10,
        data: { id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
      },
    },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 2,
        time: 20,
        data: {
          turn: 1,
          step: 1,
          message: { id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'scripted', model: 'scripted' }, content: [{ type: 'text', text: 'world' }] },
          stream: [{ type: 'chunk', time: 20, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
        },
      },
    },
  ]))
  assert.deepEqual(projected.messages.map(message => [message.role, message.content]), [
    ['user', [{ type: 'text', text: 'hello' }]],
    ['assistant', [{ type: 'text', text: 'world' }]],
  ])
})

test('projects persisted tool results onto assistant-ui tool-call parts', () => {
  const projected = projectDshEvents({
    getSnapshot: () => sessionSnapshot(),
  }, eventSource([
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 1,
        time: 10,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'assistant-tool-call',
            role: 'assistant',
            source: { kind: 'model', provider: 'scripted', model: 'scripted' },
            content: [{ type: 'tool-call', id: 'call-1', name: 'todo_write', arguments: '{"todos":[]}' }],
          },
          stream: [{ type: 'chunk', time: 10, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
        },
      },
    },
    {
      type: 'event',
      event: {
        type: 'tool/result',
        seq: 2,
        time: 20,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'tool-result-1',
            role: 'tool',
            source: { kind: 'tool', callId: 'call-1' },
            toolCallId: 'call-1',
            content: [{ type: 'text', text: 'Updated todo list: 1 pending.' }],
            isError: false,
          },
        },
      },
    },
  ]))

  assert.deepEqual(projected.messages[0]?.content, [{
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'todo_write',
    argsText: '{"todos":[]}',
    result: 'Updated todo list: 1 pending.',
    isError: false,
  }])
})

test('projects live DSH text chunks as an incremental running assistant message', () => {
  const projected = projectDshEvents({
    getSnapshot: () => sessionSnapshot({ running: true }),
  }, eventSource([{
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      seq: 1.5,
      time: 20,
      data: {
        attemptId: 'attempt-live',
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'partial answer' },
      },
    },
  }]))

  assert.equal(projected.isRunning, true)
  assert.deepEqual(projected.messages.map(message => ({
    id: message.id,
    role: message.role,
    content: message.content,
    status: message.status,
  })), [{
    id: 'dsh-live-attempt-live',
    role: 'assistant',
    content: [{ type: 'text', text: 'partial answer' }],
    status: { type: 'running' },
  }])
})

test('projects a durable turn failure for the UI and clears failed live attempts', () => {
  const projected = projectDshEvents({
    getSnapshot: () => sessionSnapshot({ running: false }),
  }, eventSource([
    {
      type: 'transient',
      event: {
        type: 'assistant/live-chunk',
        seq: 1.5,
        time: 20,
        data: {
          attemptId: 'attempt-failed',
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'partial' },
        },
      },
    },
    {
      type: 'event',
      event: {
        type: 'assistant/attempt',
        seq: 2,
        time: 30,
        data: {
          turn: 1,
          step: 1,
          stream: [{ type: 'chunk', time: 30, chunk: { type: 'finish', reason: { kind: 'error', error: { message: 'upstream failed' } } } }],
        },
      },
    },
    {
      type: 'event',
      event: {
        type: 'turn/end',
        seq: 3,
        time: 40,
        data: { turn: 1, reason: { kind: 'error', error: { message: 'upstream failed' } } },
      },
    },
  ]))

  assert.equal(projected.isRunning, false)
  assert.equal(projected.errorMessage, 'upstream failed')
  assert.deepEqual(projected.messages, [])
})

test('coalesces duplicate in-flight onNew calls for one message object', async () => {
  const { session, calls } = fakeSession()
  const adapter = new DshSessionAdapter({ binding: { session: session as never, eventSource: eventSource([]) } })
  const message = {
    role: 'user',
    content: 'hello',
    parentId: null,
    sourceId: null,
    runConfig: undefined,
  } as never
  await Promise.all([adapter.onNew(message), adapter.onNew(message)])
  assert.equal(calls.beginSubmission, 1)
  assert.equal(calls.prompt, 1)
  adapter.dispose()
})
