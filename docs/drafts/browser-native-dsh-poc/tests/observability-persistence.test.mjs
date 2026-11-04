import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createObservabilityJournal } from '../observability-journal.mjs'

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
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

function journalDirectory(dataDir) {
  return join(dataDir, 'observability')
}

test('journal persists access denials, usage entries, and the last metrics snapshot', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-observability-journal-'))
  try {
    const first = createObservabilityJournal({ dataDir, now: () => 1_760_000_000_000 })
    await first.appendAccessDenial({ at: 1, method: 'POST', route: '/api/browser-native/session/create', status: 401, code: 'UNAUTHENTICATED' })
    await first.appendUsage({ requestId: 'usage-1', sessionId: 'journal-session', inputTokens: 12, outputTokens: 4 })
    await first.appendUsage({ requestId: 'usage-2', sessionId: 'journal-session', inputTokens: 7, outputTokens: 3 })
    await first.persistMetrics({ metricsVersion: 1, requests: { total: 3 } })
    await first.close()

    const denialLines = (await readFile(join(journalDirectory(dataDir), 'access-denials.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(denialLines.length, 1)
    const usageLines = (await readFile(join(journalDirectory(dataDir), 'usage.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(usageLines.length, 2)

    const second = createObservabilityJournal({ dataDir })
    const restored = await second.restore()
    assert.deepEqual(restored.accessDenials, [{ at: 1, method: 'POST', route: '/api/browser-native/session/create', status: 401, code: 'UNAUTHENTICATED' }])
    assert.deepEqual(restored.usage.map(entry => entry.requestId), ['usage-1', 'usage-2'])
    assert.equal(restored.truncated, false)
    assert.equal(restored.invalidLines, 0)
    assert.equal(restored.metrics.capturedAt, 1_760_000_000_000)
    assert.equal(restored.metrics.view.requests.total, 3)
    assert.equal(restored.metricsError, undefined)
    assert.deepEqual(second.status(), { healthy: true, writeFailures: 0, path: journalDirectory(dataDir) })
    await second.close()
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('journal keeps the newest entries, counts torn lines, and survives a corrupt metrics snapshot', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-observability-journal-'))
  try {
    const directory = journalDirectory(dataDir)
    const journal = createObservabilityJournal({ dataDir })
    await journal.persistMetrics({ metricsVersion: 1 })
    await journal.close()

    const denials = Array.from({ length: 205 }, (_, index) => JSON.stringify({ at: index, route: '/denial', status: 401 }))
    await writeFile(join(directory, 'access-denials.jsonl'), `${denials.join('\n')}\nnot-json\n[1,2]\n`, 'utf8')
    await writeFile(join(directory, 'metrics.json'), JSON.stringify({ version: 1, capturedAt: 'yesterday', view: {} }), 'utf8')

    const restored = await createObservabilityJournal({ dataDir }).restore()
    assert.equal(restored.accessDenials.length, 200)
    assert.equal(restored.accessDenials[0].at, 5, 'older entries beyond the limit are dropped')
    assert.equal(restored.truncated, true)
    assert.equal(restored.invalidLines, 2)
    assert.equal(restored.metrics, undefined)
    assert.equal(typeof restored.metricsError, 'string')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a restarted backend reconciles restored denials with the previous metrics snapshot', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-observability-restart-'))
  try {
    const first = await createBrowserNativeV2Server({ dataDir, llmMode: 'scripted' })
    let firstOrigin
    let identity
    try {
      firstOrigin = await first.listen(0)
      identity = await openIdentity(firstOrigin)
      const denial = await request(firstOrigin, '/api/browser-native/session/create', {
        method: 'POST',
        body: {
          protocolVersion: 1,
          requestId: 'restart-denial',
          sessionId: 'restart-session',
          header: { id: 'restart-session', version: 4, createdAt: Date.now(), cwd: '/workspace' },
        },
      })
      assert.equal(denial.status, 401)
      const metrics = await request(firstOrigin, '/api/browser-native/observability/metrics')
      assert.equal(metrics.status, 200)
      assert.equal(first.accessAudit().length, 1)
    } finally {
      await first.close()
    }

    const denialLines = (await readFile(join(journalDirectory(dataDir), 'access-denials.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(denialLines.length, 1)

    const second = await createBrowserNativeV2Server({ dataDir, llmMode: 'scripted' })
    try {
      const secondOrigin = await second.listen(0)
      const reconciliation = await request(secondOrigin, '/api/browser-native/observability/reconciliation', { cookie: identity.session })
      assert.equal(reconciliation.status, 200, JSON.stringify(reconciliation.body))
      assert.equal(reconciliation.body.protocolVersion, 1)
      assert.equal(reconciliation.body.restored.accessDenials, 1)
      assert.equal(reconciliation.body.restored.usageEntries, 0)
      assert.equal(reconciliation.body.restored.truncated, false)
      assert.equal(reconciliation.body.restored.invalidLines, 0)
      assert.equal(reconciliation.body.journal.healthy, true)
      assert.equal(reconciliation.body.journal.writeFailures, 0)
      assert.equal(typeof reconciliation.body.previousProcess.capturedAt, 'number')
      assert.equal(reconciliation.body.previousProcess.view.metricsVersion, 1)
      assert.ok(reconciliation.body.previousProcess.view.requests.total >= 2)
      assert.equal(reconciliation.body.current.accessDenials, 1, 'the denial ledger must include restored entries')
      assert.equal(reconciliation.body.current.metrics.metricsVersion, 1)
      assert.equal(reconciliation.body.recoveredTurns, 0)
      assert.equal(second.accessAudit().length, 1)

      const anonymous = await request(secondOrigin, '/api/browser-native/observability/reconciliation')
      assert.equal(anonymous.status, 401)
    } finally {
      await second.close()
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
