/**
 * Contract tests for the loopback request guard.
 *
 * A browser page from another origin (including a DNS-rebinding page that owns
 * the hostname) must not be able to read a Workspace, spend the model budget, or
 * fingerprint the service. Credentials must stay in JSON bodies and headers,
 * never in URLs.
 */
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

async function start(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-guard-test-'))
  const app = await createBrowserNativeV2Server({ dataDir, port: 0, llmMode: 'scripted', ...options })
  const origin = await app.listen()
  const close = async () => {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
  return { app, origin, close, port: Number(new URL(origin).port) }
}

function call(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(payload.byteLength) }),
        ...headers,
      },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

function json(response) {
  return JSON.parse(response.body)
}

async function identity(port) {
  const response = await call(port, { path: '/api/browser-native/workspace/identity' })
  assert.equal(response.status, 200)
  const cookies = response.headers['set-cookie'] ?? []
  return {
    workspaceId: json(response).workspaceId,
    cookie: cookies.map(value => value.split(';')[0]).join('; '),
    setCookies: cookies,
  }
}

const llmBody = {
  protocolVersion: 1,
  requestId: 'guard-llm-probe',
  messages: [{ role: 'user', content: 'GUARD_LLM_PROBE' }],
}

describe('browser-native loopback request guard', () => {
  it('refuses forged Origin and cross-site requests before routing', async () => {
    const { close, port, origin } = await start()
    try {
      const browser = await identity(port)
      const manifestPath = `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${browser.workspaceId}`

      assert.equal((await call(port, { path: manifestPath, headers: { cookie: browser.cookie } })).status, 200)

      const forgedOrigin = await call(port, { path: manifestPath, headers: { cookie: browser.cookie, origin: 'http://evil.example' } })
      assert.equal(forgedOrigin.status, 403)
      assert.equal(json(forgedOrigin).error.code, 'ORIGIN_FORBIDDEN')
      assert.equal(forgedOrigin.body.includes(browser.workspaceId), false, 'a refused request must not leak Workspace data')

      const crossSite = await call(port, { path: manifestPath, headers: { cookie: browser.cookie, 'sec-fetch-site': 'cross-site' } })
      assert.equal(crossSite.status, 403)
      assert.equal(json(crossSite).error.code, 'ORIGIN_FORBIDDEN')

      const forgedLlm = await call(port, {
        method: 'POST', path: '/api/browser-native/llm',
        headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' }, body: llmBody,
      })
      assert.equal(forgedLlm.status, 403, 'a foreign page must not spend the model budget')
      assert.equal(json(forgedLlm).error.code, 'ORIGIN_FORBIDDEN')

      const sameOriginLlm = await call(port, {
        method: 'POST', path: '/api/browser-native/llm', headers: { origin }, body: llmBody,
      })
      assert.equal(sameOriginLlm.status, 200)
      assert.equal(sameOriginLlm.body.trim().split('\n').at(-1).includes('finish'), true)
    } finally {
      await close()
    }
  })

  it('refuses non-loopback Host headers and credential-shaped query parameters', async () => {
    const { close, port } = await start()
    try {
      const rebound = await call(port, { path: '/api/browser-native/health', headers: { host: 'attacker.example' } })
      assert.equal(rebound.status, 403)
      assert.equal(json(rebound).error.code, 'HOST_FORBIDDEN')
      assert.equal(rebound.body.includes('scripted'), false, 'a rebound host must not fingerprint the service')

      const queryToken = await call(port, { path: '/api/browser-native/health?access_token=probe-secret' })
      assert.equal(queryToken.status, 400)
      assert.equal(json(queryToken).error.code, 'CREDENTIAL_IN_QUERY')

      const loopback = await call(port, { path: '/api/browser-native/health', headers: { host: `127.0.0.1:${String(port)}` } })
      assert.equal(loopback.status, 200)
    } finally {
      await close()
    }
  })

  it('keeps identity cookies HttpOnly, SameSite=Strict, and path-scoped', async () => {
    const { close, port } = await start()
    try {
      const browser = await identity(port)
      assert.equal(json(await call(port, { path: '/api/browser-native/workspace/identity' })).workspaceId !== undefined, true)
      assert.equal(browser.setCookies.length, 2)
      const [workspaceCookie, sessionCookie] = browser.setCookies
      assert.equal(workspaceCookie.includes('HttpOnly'), true)
      assert.equal(workspaceCookie.includes('SameSite=Strict'), true)
      assert.equal(workspaceCookie.includes('Path=/api/browser-native/workspace'), true)
      assert.equal(sessionCookie.includes('Path=/api/browser-native/session'), true)
      assert.equal(browser.setCookies.some(value => /ownerToken|credential|token=/i.test(value)), false)

      const listed = await call(port, { path: '/api/browser-native/session/list?ownerToken=probe-secret', method: 'POST', body: { protocolVersion: 1, requestId: 'guard-session-list' } })
      assert.equal(listed.status, 400)
      assert.equal(json(listed).error.code, 'CREDENTIAL_IN_QUERY')
    } finally {
      await close()
    }
  })

  it('does not advertise cross-origin access', async () => {
    const { close, port } = await start()
    try {
      const browser = await identity(port)
      const manifestPath = `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${browser.workspaceId}`
      const response = await call(port, { path: manifestPath, headers: { cookie: browser.cookie, origin: 'http://127.0.0.1:1' } })
      assert.equal(response.headers['access-control-allow-origin'], undefined)
      assert.equal(response.headers['x-content-type-options'], 'nosniff')
    } finally {
      await close()
    }
  })

  it('lets the shared state token bypass browser-origin checks only', async () => {
    const token = 'shared-state-token-that-is-long-enough-for-the-guard'
    const { close, port } = await start({ stateAuthorityToken: token })
    try {
      const internal = await call(port, {
        method: 'POST', path: '/api/browser-native/session/list',
        headers: { 'x-browser-native-state-token': token, origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'cross-site' },
        body: { protocolVersion: 1, requestId: 'guard-internal' },
      })
      assert.equal(internal.status, 401, 'the token bypasses origin checks, not principal authentication')

      const wrongToken = await call(port, {
        method: 'POST', path: '/api/browser-native/session/list',
        headers: { 'x-browser-native-state-token': 'wrong-token', origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'cross-site' },
        body: { protocolVersion: 1, requestId: 'guard-wrong-token' },
      })
      assert.equal(wrongToken.status, 403)
      assert.equal(json(wrongToken).error.code, 'ORIGIN_FORBIDDEN')
    } finally {
      await close()
    }
  })
})
