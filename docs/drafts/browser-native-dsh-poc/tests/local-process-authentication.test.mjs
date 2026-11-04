/**
 * Contract tests for same-machine process authentication.
 *
 * A loopback-only listener still admits any local process. With
 * `requireLocalAuth`, the backend generates a per-process token, writes it to a
 * 0600 file, and refuses every browser-native route until the caller presents
 * that token in `x-browser-native-auth` or the HttpOnly handshake cookie.
 */
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const liveClosures = new Set()

async function start() {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-local-auth-'))
  const app = await createBrowserNativeV2Server({
    dataDir,
    port: 0,
    llmMode: 'scripted',
    requireLocalAuth: true,
    apiPort: 0,
  })
  const origin = await app.listen()
  const close = async () => {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
  liveClosures.add(close)
  return { app, origin, dataDir, close }
}

afterEach(async () => {
  for (const close of liveClosures) await close()
  liveClosures.clear()
})

function call(origin, path, { headers = {} } = {}) {
  return fetch(`${origin}${path}`, { headers })
}

function authHeader(app) {
  return { 'x-browser-native-auth': app.authToken }
}

function authCookie(app) {
  return { cookie: `dsh-browser-native-auth=${app.authToken}` }
}

describe('browser-native same-machine process authentication', () => {
  it('refuses unauthenticated local processes and admits the token holder', async () => {
    const { app, origin, dataDir, close } = await start()
    const apiOrigin = app.apiOrigin
    assert.ok(typeof apiOrigin === 'string', 'split mode exposes the API origin')

    const tokenFile = join(dataDir, 'browser-native-auth-token')
    const fileStat = await stat(tokenFile)
    assert.equal(fileStat.mode & 0o777, 0o600, 'the token file is readable by owner only')
    assert.equal((await readFile(tokenFile, 'utf8')).trim(), app.authToken)

    const anonymous = await call(origin, '/api/browser-native/workspace/identity')
    assert.equal(anonymous.status, 401, 'a local process without the token cannot mint a principal')
    assert.equal((await anonymous.json()).error.code, 'AUTH_REQUIRED')

    const forged = await call(origin, '/api/browser-native/workspace/identity', {
      headers: { 'x-browser-native-auth': 'not-the-token' },
    })
    assert.equal(forged.status, 401)

    const forgedPrincipal = await call(origin, '/api/browser-native/session/list', {
      headers: { cookie: 'dsh-browser-native-session-principal=00000000-0000-4000-8000-000000000000' },
    })
    assert.equal(forgedPrincipal.status, 401, 'a stolen principal cookie does not replace process authentication')

    const apiAnonymous = await call(apiOrigin, '/api/browser-native/health')
    assert.equal(apiAnonymous.status, 401, 'the split API listener enforces the same token')

    const identity = await call(apiOrigin, '/api/browser-native/workspace/identity', { headers: authHeader(app) })
    assert.equal(identity.status, 200)
    const cookies = identity.headers.getSetCookie().map(value => value.split(';', 1)[0])
    assert.ok(cookies.some(value => value.startsWith('dsh-browser-native-principal=')))
    assert.ok(cookies.some(value => value.startsWith('dsh-browser-native-session-principal=')))

    const apiWithHeader = await call(apiOrigin, '/api/browser-native/health', { headers: authHeader(app) })
    assert.equal(apiWithHeader.status, 200)

    const cookieOnly = await call(apiOrigin, '/api/browser-native/workspace/identity', { headers: authCookie(app) })
    assert.equal(cookieOnly.status, 200, 'the handshake cookie authorizes subsequent requests')
    const apiWithCookie = await call(apiOrigin, '/api/browser-native/health', { headers: authCookie(app) })
    assert.equal(apiWithCookie.status, 200, 'a same-host cookie reaches the split API port')

    await app.close()
    await assert.rejects(access(tokenFile), { code: 'ENOENT' }, 'closing the process removes its token file')
    liveClosures.delete(close)
    await rm(dataDir, { recursive: true, force: true })
  })

  it('exchanges the handshake token for an HttpOnly cookie and redirects without it', async () => {
    const { app, origin } = await start()
    const previewPath = '/preview.html?browser-native=1&preview-fixture=none'

    const refused = await call(origin, '/auth/handshake?token=wrong', { headers: {} })
    assert.equal(refused.status, 401)

    const handshake = await fetch(`${origin}/auth/handshake?token=${encodeURIComponent(app.authToken)}&next=${encodeURIComponent(previewPath)}`, {
      redirect: 'manual',
    })
    assert.equal(handshake.status, 302)
    assert.equal(handshake.headers.get('location'), previewPath, 'the token never lands in the page URL')
    assert.equal(handshake.headers.get('cache-control'), 'no-store')
    const setCookie = handshake.headers.getSetCookie().find(value => value.startsWith('dsh-browser-native-auth='))
    assert.ok(setCookie, 'the handshake issues the auth cookie')
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)
    assert.match(setCookie, /Path=\//)

    const openRedirect = await fetch(`${origin}/auth/handshake?token=${encodeURIComponent(app.authToken)}&next=${encodeURIComponent('//evil.invalid/')}`, {
      redirect: 'manual',
    })
    assert.equal(openRedirect.headers.get('location'), '/', 'protocol-relative redirects are refused')

    const page = await call(origin, previewPath, { headers: authCookie(app) })
    assert.equal(page.status, 200, 'the preview page loads after the handshake')
  })
})
