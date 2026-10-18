import test from 'node:test'
import assert from 'node:assert/strict'
import { FrontendBridge } from '../src/frontend-bridge.ts'

const request = { type: 'browser-native-frontend-tool-request', requestId: 'request-1', sessionId: 'session-1', callId: 'call-1', name: 'test', arguments: { value: 1 } }

test('duplicate request executes once; exact result replays without a second handler', async () => {
  const messages: unknown[] = []
  const bridge = new FrontendBridge({ postMessage: value => { messages.push(value) } })
  let executions = 0
  bridge.register('test', () => { executions += 1; return undefined })
  bridge.handleRequest(request)
  bridge.handleRequest(request)
  await Promise.resolve()
  assert.equal(executions, 1)
  assert.equal(bridge.resolve('wrong-id', {}), false)
  assert.equal(bridge.resolve('call-1', { ok: true }), true)
  assert.equal(bridge.resolve('call-1', {}), false)
  bridge.handleRequest({ ...request, requestId: 'retry' })
  assert.equal(executions, 1)
  assert.equal(messages.length, 2)
  bridge.dispose()
})

test('cancel and unmount abort waiters and reject late answers', async () => {
  const bridge = new FrontendBridge({ postMessage: () => {} })
  let executions = 0
  bridge.register('test', () => { executions += 1; return undefined })
  bridge.handleRequest(request)
  const signal = bridge.getSnapshot()[0]?.signal
  assert.equal(bridge.cancel('call-1'), true)
  assert.equal(signal?.aborted, true)
  assert.equal(bridge.resolve('call-1', 'late'), false)
  bridge.handleRequest({ ...request, callId: 'call-2' })
  const second = bridge.getSnapshot()[0]?.signal
  bridge.dispose()
  assert.equal(second?.aborted, true)
  assert.equal(bridge.getSnapshot().length, 0)
  await Promise.resolve()
  assert.equal(executions, 0, 'disposed or cancelled queued handlers cannot execute')
})

test('two calls of the same tool settle independently by exact call id', async () => {
  const messages: unknown[] = []
  const bridge = new FrontendBridge({ postMessage: value => { messages.push(value) } })
  bridge.register('test', () => undefined)
  bridge.handleRequest(request)
  bridge.handleRequest({ ...request, requestId: 'request-2', callId: 'call-2' })
  await Promise.resolve()
  bridge.cancel('call-1')
  assert.equal(bridge.resolve('call-1', 'late'), false)
  assert.equal(bridge.getSnapshot()[0]?.callId, 'call-2')
  assert.equal(bridge.resolve('call-2', { result: 2 }), true)
  assert.equal(messages.length, 2)
  assert.match(JSON.stringify(messages.at(-1)), /request-2/)
  bridge.dispose()
})

test('handler failure and identity conflict cannot settle another call', async () => {
  const messages: unknown[] = []
  const bridge = new FrontendBridge({ postMessage: value => { messages.push(value) } })
  bridge.register('test', () => { throw new Error('handler failed') })
  bridge.handleRequest(request)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(bridge.getSnapshot().length, 0)
  bridge.handleRequest({ ...request, requestId: 'retry', sessionId: 'other' })
  assert.match(JSON.stringify(messages), /identity conflict/)
  assert.match(JSON.stringify(messages), /handler failed/)
  bridge.dispose()
})
