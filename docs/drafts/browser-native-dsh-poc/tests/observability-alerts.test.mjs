import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createAlertEvaluator, normalizeAlertConfig } from '../observability-alerts.mjs'

/** Start a loopback webhook receiver and collect its JSON bodies. */
async function createWebhookReceiver() {
  const received = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      received.push({ headers: request.headers, body: JSON.parse(body) })
      response.writeHead(204).end()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    received,
    url: `${origin}/alerts`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

test('threshold alerts fire once, recover once, and normalize invalid configuration', async () => {
  assert.throws(() => normalizeAlertConfig({ failureRate: { ratio: 1.5 } }), /ratio/)
  assert.throws(() => normalizeAlertConfig({ webhookUrl: 'ftp://example.invalid' }), /http/)
  assert.equal(normalizeAlertConfig({}), undefined)
  assert.throws(() => createAlertEvaluator({
    config: { budgetUsd: 0.5 },
  }), /usagePricing/)

  const emitted = []
  const evaluator = createAlertEvaluator({
    config: { failureRate: { ratio: 0.5, minSamples: 4, windowSize: 4 } },
    emit: event => emitted.push(event),
  })
  for (const status of [500, 500, 200, 200]) evaluator.recordRequest({ status, aborted: false })
  assert.equal(evaluator.snapshot().window.samples, 4)
  assert.equal((await evaluator.run()).length, 1)
  assert.equal(emitted[0].type, 'alert')
  assert.equal(emitted[0].alert, 'failure-rate')
  assert.equal(emitted[0].value, 0.5)
  assert.equal((await evaluator.run()).length, 0, 'an active alert must not repeat')

  for (const status of [200, 200, 200, 200]) evaluator.recordRequest({ status, aborted: false })
  assert.equal((await evaluator.run()).length, 1)
  assert.equal(emitted[1].type, 'recovery')
  assert.deepEqual(evaluator.snapshot().active, [])

  let queuedTurns = 3
  const queueEvaluator = createAlertEvaluator({
    config: { queueBacklog: { queuedTurns: 2 } },
    queue: () => ({ queuedTurns }),
    emit: event => emitted.push(event),
  })
  assert.equal((await queueEvaluator.run()).length, 1)
  assert.equal(emitted[2].alert, 'queue-backlog')
  queuedTurns = 1
  assert.equal((await queueEvaluator.run()).length, 1)
  assert.equal(emitted[3].type, 'recovery')
})

test('budget alerts follow provider cost and require configured pricing', async () => {
  const emitted = []
  const usage = [
    { inputTokens: 400, outputTokens: 300, sessionId: 's1' },
    { inputTokens: 0, outputTokens: 0, sessionId: 's2' },
  ]
  const evaluator = createAlertEvaluator({
    config: { budgetUsd: 0.0005 },
    pricing: { inputUsdPer1M: 1, outputUsdPer1M: 2 },
    usage: () => usage,
    emit: event => emitted.push(event),
  })
  assert.equal((await evaluator.run()).length, 1)
  assert.equal(emitted[0].alert, 'budget')
  assert.equal(emitted[0].value, 0.001)
  assert.equal(emitted[0].threshold, 0.0005)
  usage.push({ inputTokens: 1_000_000, outputTokens: 0, sessionId: 's3' })
  assert.equal((await evaluator.run()).length, 0, 'a still-over-budget total must not repeat')
})

test('webhook delivery carries transitions and survives an unreachable receiver', async () => {
  const receiver = await createWebhookReceiver()
  try {
    let queuedTurns = 0
    const evaluator = createAlertEvaluator({
      config: { queueBacklog: { queuedTurns: 2 }, webhookUrl: receiver.url },
      queue: () => ({ queuedTurns }),
      emit: () => {},
    })
    queuedTurns = 2
    assert.equal((await evaluator.run()).length, 1)
    assert.equal(receiver.received.length, 1)
    assert.equal(receiver.received[0].headers['content-type'], 'application/json')
    assert.equal(receiver.received[0].body.type, 'alert')
    assert.equal(receiver.received[0].body.alert, 'queue-backlog')
    assert.equal(receiver.received[0].body.source, 'browser-native')

    queuedTurns = 0
    assert.equal((await evaluator.run()).length, 1)
    assert.equal(receiver.received.length, 2)
    assert.equal(receiver.received[1].body.type, 'recovery')
  } finally {
    await receiver.close()
  }

  let queuedTurns = 2
  const unreachable = createAlertEvaluator({
    config: { queueBacklog: { queuedTurns: 2 }, webhookUrl: receiver.url },
    queue: () => ({ queuedTurns }),
    emit: () => {},
  })
  assert.equal((await unreachable.run()).length, 1)
  assert.equal(unreachable.snapshot().webhookFailures, 1, 'a failed webhook must not reject the evaluation')
})

test('backend exposes alert thresholds, window samples, and no false active alerts', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-alerts-'))
  const app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: join(dataDir, 'dist'),
    llmMode: 'scripted',
    alerts: {
      failureRate: { ratio: 0.5, minSamples: 4, windowSize: 8 },
      queueBacklog: { queuedTurns: 1 },
    },
  })
  try {
    const origin = await app.listen(0)
    for (let index = 0; index < 4; index += 1) {
      const response = await fetch(`${origin}/api/browser-native/health`)
      assert.equal(response.status, 200)
      await response.text()
    }
    const response = await fetch(`${origin}/api/browser-native/observability/alerts`)
    assert.equal(response.status, 200)
    const snapshot = await response.json()
    assert.equal(snapshot.enabled, true)
    assert.equal(snapshot.thresholds.failureRate.ratio, 0.5)
    assert.equal(snapshot.thresholds.queueBacklog.queuedTurns, 1)
    assert.equal(snapshot.thresholds.webhookConfigured, false)
    assert.equal(snapshot.window.samples, 4)
    assert.equal(snapshot.window.failures, 0)
    assert.deepEqual(snapshot.active, [])
    assert.deepEqual(snapshot.history, [])
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
