import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

/**
 * Read both principal cookies issued by the identity endpoint.
 * @param {string} origin - Loopback server origin.
 * @returns {Promise<{session: string, workspace: string}>} Cookie header values.
 */
async function openIdentity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const cookies = response.headers.getSetCookie()
  const pick = name => {
    const cookie = cookies.find(value => value.startsWith(`${name}=`))
    assert.ok(cookie, `identity must issue ${name}`)
    return cookie.split(';')[0]
  }
  return {
    session: pick('dsh-browser-native-session-principal'),
    workspace: pick('dsh-browser-native-principal'),
  }
}

async function request(origin, pathname, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ protocolVersion: 1, requestId: `obs-${String(Date.now())}`, ...body }) }),
  })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = text
  }
  return { status: response.status, body: payload }
}

async function settleDurableTurn(origin, cookie, sessionId, turnId, prompt) {
  const started = await request(origin, '/api/browser-native/session/durable', {
    method: 'POST',
    cookie,
    body: { sessionId, turnId, prompt },
  })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  let status
  for (let attempt = 0; attempt < 200; attempt += 1) {
    status = await request(origin, `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`, { cookie })
    if (status.body.status !== 'running') break
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  }
  return status.body
}

test('structured metrics classify failures and export a minimal evidence bundle for one turn', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-observability-'))
  const app = await createBrowserNativeV2Server({
    dataDir,
    llmMode: 'scripted',
    durableTurnTimeoutMs: 20_000,
    testHooks: {
      scriptedLlmFault: body => {
        const prompt = [...body.messages].reverse().find(message => message.role === 'user')?.content ?? ''
        return prompt === 'OBSERVABILITY_EMPTY_TURN' ? { kind: 'text', text: '   ' } : { kind: 'text', text: 'ok' }
      },
    },
  })
  let origin
  try {
    origin = await app.listen(0)
    const first = await openIdentity(origin)

    const unauthenticated = await request(origin, '/api/browser-native/session/create', {
      method: 'POST',
      body: { sessionId: 'obs-unauthorized', header: { id: 'obs-unauthorized', version: 4, createdAt: Date.now(), cwd: '/workspace' } },
    })
    assert.equal(unauthenticated.status, 401)
    const missingRoute = await request(origin, '/api/browser-native/observability-missing')
    assert.equal(missingRoute.status, 404)

    const failed = await settleDurableTurn(origin, first.session, 'obs-session', 'obs-turn-failed', 'OBSERVABILITY_EMPTY_TURN')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error.code, 'DURABLE_EMPTY_RESPONSE')
    const completed = await settleDurableTurn(origin, first.session, 'obs-session', 'obs-turn-ok', 'OBSERVABILITY_OK_TURN')
    assert.equal(completed.status, 'completed')

    // A scrape cannot include itself, so the metrics route appears only from the next capture onward.
    let metrics
    for (let attempt = 0; attempt < 100; attempt += 1) {
      metrics = await request(origin, '/api/browser-native/observability/metrics')
      assert.equal(metrics.status, 200)
      if (metrics.body.requests.failuresByCode.NOT_FOUND >= 1
        && metrics.body.requests.byRouteStatus['GET /api/browser-native/observability/metrics 200'] >= 1
        && metrics.body.durableTurns.failed === 1
        && metrics.body.durableTurns.completed === 1) break
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
    }

    assert.equal(metrics.body.metricsVersion, 1)
    assert.equal(metrics.body.requests.failuresByCode.NOT_FOUND >= 1, true)
    assert.equal(metrics.body.requests.failuresByCode.UNAUTHENTICATED >= 1, true)
    assert.ok(metrics.body.requests.byRouteStatus['GET /api/browser-native/observability/metrics 200'] >= 1)
    assert.ok(metrics.body.requests.durationMs.count >= 1)
    assert.ok(metrics.body.model.requests >= 2, 'both durable turns must request the model')
    assert.equal(metrics.body.model.failures, 0, 'a whitespace completion is a durable failure, not a model transport failure')
    assert.equal(metrics.body.durableTurns.failed, 1)
    assert.equal(metrics.body.durableTurns.completed, 1)
    assert.equal(metrics.body.durableTurns.running, 0)
    assert.ok(metrics.body.durableTurns.recentSettled.length >= 2)
    const failedSettlement = metrics.body.durableTurns.recentSettled.find(entry => entry.turnId === 'obs-turn-failed')
    assert.equal(failedSettlement.errorCode, 'DURABLE_EMPTY_RESPONSE')
    assert.ok(failedSettlement.elapsedMs >= 0)
    assert.equal(metrics.body.queue.queuedTurns, 0)
    assert.equal(metrics.body.queue.activeTurns, 0)
    assert.equal(metrics.body.queue.limits.maxConcurrentTurns, 8)
    assert.equal(metrics.body.leases.sessions, 1)
    assert.equal(metrics.body.leases.held, 0, 'a settled durable turn must release its lease')
    assert.equal(typeof metrics.body.process.rssBytes, 'number')
    assert.ok(metrics.body.process.rssBytes > 0)

    const prometheus = await fetch(`${origin}/api/browser-native/observability/metrics?format=prometheus`)
    assert.equal(prometheus.status, 200)
    assert.match(prometheus.headers.get('content-type'), /text\/plain/)
    const text = await prometheus.text()
    assert.match(text, /dsh_browser_native_http_requests_total \d+/)
    assert.match(text, /dsh_browser_native_failures_total{code="NOT_FOUND"} \d+/)
    assert.match(text, /dsh_browser_native_durable_turns_failed 1/)
    assert.match(text, /dsh_browser_native_process_rss_bytes \d+/)
    assert.ok(text.endsWith('\n'))

    const evidence = await request(origin, '/api/browser-native/observability/failure?turnId=obs-turn-failed', { cookie: first.session })
    assert.equal(evidence.status, 200)
    assert.equal(evidence.body.evidenceVersion, 1)
    assert.equal(evidence.body.turn.status, 'failed')
    assert.equal(evidence.body.turn.error.code, 'DURABLE_EMPTY_RESPONSE')
    assert.equal(evidence.body.turn.sessionId, 'obs-session')
    assert.equal(evidence.body.turn.turn, 1)
    assert.ok(evidence.body.events.length >= 1 && evidence.body.events.length <= 12)
    const lastEvent = evidence.body.events.at(-1)
    assert.equal(lastEvent.type, 'turn/end')
    assert.equal(lastEvent.reason, 'error')
    assert.equal(lastEvent.errorCode, 'DURABLE_EMPTY_RESPONSE')
    assert.equal(evidence.body.lease.held, false)
    assert.equal(evidence.body.lease.writeBlocked, false)
    assert.ok(evidence.body.lease.durableThroughSeq >= 0)
    assert.equal(evidence.body.metrics.durableTurns.failed, 1)
    assert.ok(Array.isArray(evidence.body.accessDenials))
    assert.equal(JSON.stringify(evidence.body).includes('OBSERVABILITY_EMPTY_TURN'), false, 'evidence must not contain the prompt')

    const foreign = await openIdentity(origin)
    const foreignEvidence = await request(origin, '/api/browser-native/observability/failure?turnId=obs-turn-failed', { cookie: foreign.session })
    assert.equal(foreignEvidence.status, 404)
    assert.equal(foreignEvidence.body.error.code, 'TURN_NOT_FOUND')
    const unknown = await request(origin, '/api/browser-native/observability/failure?turnId=obs-turn-missing', { cookie: first.session })
    assert.equal(unknown.status, 404)
    const anonymous = await request(origin, '/api/browser-native/observability/failure?turnId=obs-turn-failed')
    assert.equal(anonymous.status, 401)

    const completedEvidence = await request(origin, '/api/browser-native/observability/failure?turnId=obs-turn-ok', { cookie: first.session })
    assert.equal(completedEvidence.status, 200)
    assert.equal(completedEvidence.body.turn.status, 'completed')
    assert.equal(completedEvidence.body.turn.error, undefined)
    assert.equal(completedEvidence.body.events.at(-1).reason, 'completed')

    process.stdout.write(`${JSON.stringify({
      result: 'passed',
      scope: 'observability',
      failureCodes: metrics.body.requests.failuresByCode,
      modelRequests: metrics.body.model.requests,
      durableTurns: { failed: metrics.body.durableTurns.failed, completed: metrics.body.durableTurns.completed },
      failedElapsedMs: failedSettlement.elapsedMs,
      evidenceEvents: evidence.body.events.length,
      evidenceBytes: JSON.stringify(evidence.body).length,
      prometheusLines: text.trim().split('\n').length,
    })}\n`)
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
