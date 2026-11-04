import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const PROBE_KEY = 'threat-model-probe-secret-9f2c'

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
  return { status: response.status, headers: response.headers, text }
}

test('the backend keeps the provider key out of every client-visible response', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-threat-model-'))
  const app = await createBrowserNativeV2Server({
    dataDir,
    llmMode: 'real',
    llmApiKey: PROBE_KEY,
    llmBaseUrl: 'http://127.0.0.1:1',
    llmCompletionsPath: '/v1/chat/completions',
    model: 'threat-model-probe',
  })
  try {
    const origin = await app.listen(0)
    const health = await request(origin, '/api/browser-native/health')
    const config = await request(origin, '/api/browser-native/config')
    assert.equal(health.status, 200)
    assert.equal(config.status, 200)
    assert.equal(health.text.includes(PROBE_KEY), false, 'health must not expose the provider key')
    assert.equal(config.text.includes(PROBE_KEY), false, 'config must not expose the provider key')
    assert.match(health.text, /"llmMode":"real"/)
    assert.match(config.text, /"provider":"gpt"/)

    // A refused upstream is the most likely path to echo a credential in an error body.
    const failed = await request(origin, '/api/browser-native/llm', {
      method: 'POST',
      body: { protocolVersion: 1, requestId: 'threat-model-llm', messages: [{ role: 'user', content: 'probe' }] },
    })
    assert.equal(failed.status, 502)
    assert.match(failed.text, /UPSTREAM_LLM_UNAVAILABLE/)
    assert.equal(failed.text.includes(PROBE_KEY), false, 'upstream failures must not echo the provider key')
    for (const surface of [health, config, failed]) {
      assert.equal(surface.headers.get('access-control-allow-origin'), null, 'the API must not enable CORS')
      assert.equal(surface.headers.get('x-content-type-options'), 'nosniff')
    }
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('access audit stores a principal digest instead of the raw principal cookie', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-threat-model-'))
  const app = await createBrowserNativeV2Server({ dataDir, llmMode: 'scripted' })
  try {
    const origin = await app.listen(0)
    const identity = await openIdentity(origin)
    const principal = identity.session.split('=')[1]

    const missing = await request(origin, '/api/browser-native/observability/failure?turnId=threat-model-missing', {
      cookie: identity.session,
    })
    assert.equal(missing.status, 404)
    assert.equal(missing.text.includes(principal), false, 'a refusal must not echo the principal cookie value')

    const audit = app.accessAudit()
    assert.equal(audit.length, 1)
    const entry = audit[0]
    assert.equal(entry.route, '/api/browser-native/observability/failure')
    assert.equal(entry.status, 404)
    assert.equal(entry.principalDigest, createHash('sha256').update(principal).digest('hex').slice(0, 16))
    assert.equal(JSON.stringify(audit).includes(principal), false, 'the audit ledger must not store the raw principal cookie')
    assert.equal(missing.headers.get('content-type'), 'application/json; charset=utf-8')
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
