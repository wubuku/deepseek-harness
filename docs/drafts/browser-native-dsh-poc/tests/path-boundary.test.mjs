/**
 * Path-boundary probes for the Browser-Native backend: traversal, encoded
 * separators, absolute paths, NUL bytes, and symlinked preview files must not
 * reach content outside their roots.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const SECRET = 'outside-root-secret'
const liveApps = new Set()
const temporaryDirectories = new Set()

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'browser-native-path-'))
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
  assert.notEqual(workspaceCookie, undefined)
  assert.notEqual(sessionCookie, undefined)
  return {
    workspaceId: body.workspaceId,
    workspaceCookie: workspaceCookie.split(';', 1)[0],
    sessionCookie: sessionCookie.split(';', 1)[0],
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

async function get(origin, path, cookie) {
  const response = await fetch(`${origin}${path}`, { headers: cookie === undefined ? {} : { cookie } })
  return { status: response.status, text: await response.text() }
}

function containsSecret(text) {
  return text.includes(SECRET)
}

afterEach(async () => {
  for (const app of liveApps) await app.close()
  liveApps.clear()
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

describe('browser-native path boundaries', () => {
  it('rejects traversal and encoded separators in Workspace paths without creating files', async () => {
    const root = await temporaryRoot()
    const dataDir = join(root, 'data')
    const outside = join(root, 'outside')
    await mkdir(dataDir, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'escape.txt'), SECRET)
    const app = await createBrowserNativeV2Server({ port: 0, dataDir, llmMode: 'scripted' })
    liveApps.add(app)
    const origin = await app.listen()
    const owner = await identity(origin)

    const invalidPaths = [
      '../escape.txt', 'a/../../escape.txt', '/etc/passwd', 'C:/escape.txt',
      'a\\b.txt', 'a\0b.txt', 'a//b.txt', './a.txt', 'a/../b.txt', 'a/',
      '..%2fescape.txt', '%2e%2e%2fescape.txt', '..%5cescape.txt', 'a%00b.txt',
    ]
    for (const path of invalidPaths) {
      const result = await post(origin, '/api/browser-native/workspace/commit', envelope(`commit-${randomUUID()}`, {
        workspaceId: owner.workspaceId,
        baseRevision: 0,
        operationId: randomUUID(),
        changes: [{ path, kind: 'directory', mode: 0o755 }],
      }), owner.workspaceCookie)
      assert.equal(result.status, 400, `${JSON.stringify(path)} must be refused, got ${result.status}`)
      assert.equal(result.body.error.code, 'INVALID_PATH')
    }

    const manifest = await get(origin, `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${owner.workspaceId}`, owner.workspaceCookie)
    assert.equal(manifest.status, 200)
    assert.deepEqual(JSON.parse(manifest.text).entries, [])
    assert.deepEqual(await readdir(outside), ['escape.txt'])
    assert.equal(await readFile(join(outside, 'escape.txt'), 'utf8'), SECRET)
  })

  it('rejects traversal ids in attachments, blobs, sessions, and durable routes', async () => {
    const root = await temporaryRoot()
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { recursive: true })
    const app = await createBrowserNativeV2Server({ port: 0, dataDir, llmMode: 'scripted' })
    liveApps.add(app)
    const origin = await app.listen()
    const owner = await identity(origin)

    const badIds = ['..', '../escape', '..%2fescape', '/etc/passwd', 'a\0b', 'a/b']
    for (const workspaceId of badIds) {
      const attachment = await get(origin, `/api/browser-native/workspace/attachments/${'a'.repeat(64)}?workspaceId=${encodeURIComponent(workspaceId)}`, owner.workspaceCookie)
      assert.equal(attachment.status, 400, `attachment workspaceId ${JSON.stringify(workspaceId)} must be refused`)
      const upload = await post(origin, '/api/browser-native/workspace/blob-upload/start', envelope(`upload-${randomUUID()}`, { workspaceId }), owner.workspaceCookie)
      assert.equal(upload.status, 400, `blob workspaceId ${JSON.stringify(workspaceId)} must be refused`)
    }

    for (const sessionId of ['../escape', '..%2fescape', '/etc/passwd', 'a\0b', 'a/b']) {
      const create = await post(origin, '/api/browser-native/session/create', envelope(`session-${randomUUID()}`, {
        sessionId,
        header: { id: sessionId, version: 4, createdAt: 1_700_000_000_000, cwd: '/workspace' },
        inheritedEventCount: 0,
      }), owner.sessionCookie)
      assert.equal(create.status, 400, `session id ${JSON.stringify(sessionId)} must be refused`)
      const durable = await post(origin, '/api/browser-native/session/durable', envelope(`durable-${randomUUID()}`, {
        sessionId,
        turnId: 'turn-1',
        prompt: 'hello',
      }), owner.sessionCookie)
      assert.equal(durable.status, 400, `durable session id ${JSON.stringify(sessionId)} must be refused`)
    }

    const sessions = await post(origin, '/api/browser-native/session/list', envelope(`list-${randomUUID()}`), owner.sessionCookie)
    assert.equal(sessions.status, 200)
    assert.deepEqual(sessions.body.items, [])
  })

  it('reduces an attachment upload name to its leaf and keeps it inside the workspace', async () => {
    const root = await temporaryRoot()
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { recursive: true })
    const app = await createBrowserNativeV2Server({ port: 0, dataDir, llmMode: 'scripted' })
    liveApps.add(app)
    const origin = await app.listen()
    const owner = await identity(origin)
    const payload = Buffer.from('payload')
    const hash = createHash('sha256').update(payload).digest('hex')
    const response = await fetch(`${origin}/api/browser-native/workspace/attachments/${hash}?workspaceId=${owner.workspaceId}&name=${encodeURIComponent('../../escape.txt')}`, {
      method: 'PUT',
      headers: { cookie: owner.workspaceCookie, 'content-type': 'application/octet-stream' },
      body: payload,
    })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.name, 'escape.txt')
    const record = await readFile(join(dataDir, 'attachments-v1', owner.workspaceId, hash.slice(0, 2), hash), 'utf8')
    assert.equal(record, 'payload')
  })

  it('static preview requests cannot read outside the dist root', async () => {
    const root = await temporaryRoot()
    const dataDir = join(root, 'data')
    const dist = join(root, 'dist')
    await mkdir(dataDir, { recursive: true })
    await mkdir(dist, { recursive: true })
    await writeFile(join(dist, 'preview.html'), '<html>preview</html>')
    await writeFile(join(root, 'secret.txt'), SECRET)
    await symlink(join(root, 'secret.txt'), join(dist, 'linked.txt'))
    const app = await createBrowserNativeV2Server({ port: 0, dataDir, distRoot: dist, llmMode: 'scripted' })
    liveApps.add(app)
    const origin = await app.listen()

    const probes = [
      '/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/..%5csecret.txt',
      '/..\\secret.txt', '/%2fsecret.txt', '/etc/passwd', '/%00', '/linked.txt',
    ]
    for (const path of probes) {
      const result = await get(origin, path)
      assert.equal(result.status, 404, `${JSON.stringify(path)} must not escape, got ${result.status}`)
      assert.equal(containsSecret(result.text), false, `${JSON.stringify(path)} leaked the secret`)
    }
    const protocolRelative = await get(origin, '//secret.txt')
    assert.equal(containsSecret(protocolRelative.text), false)
    const preview = await get(origin, '/preview.html')
    assert.equal(preview.status, 200)
  })
})
