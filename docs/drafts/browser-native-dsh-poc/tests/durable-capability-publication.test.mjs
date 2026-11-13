import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

/**
 * Read the session principal cookie issued by the identity endpoint.
 * @param {string} origin - Loopback server origin.
 * @returns {Promise<string>} Session principal cookie pair.
 */
async function openIdentity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const cookie = response.headers.getSetCookie()
    .find(value => value.startsWith('dsh-browser-native-session-principal='))
  assert.ok(cookie, 'identity must issue a session principal')
  return cookie.split(';')[0]
}

async function request(origin, pathname, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ protocolVersion: 1, requestId: `capability-${String(Date.now())}`, ...body }) }),
  })
  return { status: response.status, body: await response.json() }
}

async function pollStatus(origin, cookie, turnId) {
  let last
  for (let attempt = 0; attempt < 200; attempt += 1) {
    last = await request(origin, `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`, { cookie })
    if (last.body.status !== 'running') return last
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  }
  return last
}

/**
 * Run one durable turn and capture the tool names the model request received.
 * @param {{probe?: Function}} options - Optional capability probe hook.
 * @returns {Promise<{report: object, wireTools: string[], toolNames: string[]}>} Evidence.
 */
async function runScenario(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-capability-'))
  let wireTools
  const app = await createBrowserNativeV2Server({
    dataDir,
    llmMode: 'scripted',
    durableTurnTimeoutMs: 20_000,
    testHooks: {
      scriptedLlmFault: body => {
        wireTools = (body.tools ?? []).map(tool => tool.function.name)
        return { kind: 'text', text: 'CAPABILITY_PROBE_OK' }
      },
      ...(options.probe === undefined ? {} : { durableCapabilityProbe: options.probe }),
    },
  })
  try {
    const origin = await app.listen(0)
    const cookie = await openIdentity(origin)
    const report = await request(origin, '/api/browser-native/session/durable/capabilities', { cookie })
    assert.equal(report.status, 200, JSON.stringify(report.body))
    const started = await request(origin, '/api/browser-native/session/durable', {
      method: 'POST',
      cookie,
      body: { sessionId: 'capability-session', turnId: 'capability-turn-1', prompt: 'CAPABILITY_TURN' },
    })
    assert.equal(started.status, 202, JSON.stringify(started.body))
    const settled = await pollStatus(origin, cookie, 'capability-turn-1')
    assert.equal(settled.body.status, 'completed', JSON.stringify(settled.body))
    return {
      report: report.body,
      wireTools,
      toolNames: report.body.tools.map(tool => tool.name),
    }
  } finally {
    await app.close().catch(() => {})
    await rm(dataDir, { recursive: true, force: true })
  }
}

test('a probed-unsupported tool stays out of the model schema and is explained in the report', async () => {
  const result = await runScenario({
    probe: name => (name === 'edit' ? { supported: false, reason: 'workspace is read-only for this profile' } : undefined),
  })
  assert.deepEqual(result.toolNames, ['write', 'read', 'grep', 'glob', 'edit', 'subagent'])
  const edit = result.report.tools.find(tool => tool.name === 'edit')
  assert.equal(edit.declared, true)
  assert.equal(edit.probed, false)
  assert.equal(edit.published, false)
  assert.equal(edit.reason, 'workspace is read-only for this profile')
  assert.deepEqual(result.report.unsupported, ['edit'])
  assert.deepEqual(result.report.published, ['write', 'read', 'grep', 'glob', 'subagent'])
  assert.deepEqual(result.wireTools, ['write', 'read', 'grep', 'glob', 'subagent'], 'a degraded tool must not reach the model')
})

test('every declared tool is published when all probes pass', async () => {
  const result = await runScenario()
  assert.deepEqual(result.report.unsupported, [])
  assert.equal(result.report.tools.every(tool => tool.declared && tool.probed && tool.published), true)
  assert.deepEqual(result.wireTools, result.toolNames)
  const edit = result.report.tools.find(tool => tool.name === 'edit')
  assert.equal(edit.requiresApproval, true)
  assert.equal(edit.reason, undefined)
})
