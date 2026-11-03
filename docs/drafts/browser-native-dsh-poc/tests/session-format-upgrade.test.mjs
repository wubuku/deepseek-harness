/**
 * A stored Session written by another harness generation must be refused
 * explicitly instead of read as if it were current-format.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const CURRENT_VERSION = 4
const liveApps = new Set()
const temporaryDirectories = new Set()

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'browser-native-format-upgrade-'))
  temporaryDirectories.add(directory)
  return directory
}

async function start(dataDir) {
  const app = await createBrowserNativeV2Server({ port: 0, dataDir, llmMode: 'scripted' })
  const origin = await app.listen()
  liveApps.add(app)
  return { app, origin }
}

async function close(app) {
  await app.close()
  liveApps.delete(app)
}

function envelope(requestId, extra = {}) {
  return { protocolVersion: 1, requestId, ...extra }
}

async function identityFor(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.ok, true)
  const setCookies = response.headers.getSetCookie()
  const sessionCookie = setCookies.find(cookie => cookie.startsWith('dsh-browser-native-session-principal='))
  assert.notEqual(sessionCookie, undefined)
  return {
    principalId: sessionCookie.split(';', 1)[0].split('=', 2)[1],
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

function legacyRecord(id, principalId, version) {
  return JSON.stringify({
    id,
    principalId,
    header: { id, version, createdAt: 1_700_000_000_000, cwd: '/workspace' },
    inheritedEventCount: 0,
    events: [],
    durableThroughSeq: -1,
    ownerEpoch: 0,
    handoffs: {},
  })
}

async function seedLegacySession(dataDir, id, principalId, version) {
  const sessionsDir = join(dataDir, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const path = join(sessionsDir, `${id}.json`)
  await writeFile(path, legacyRecord(id, principalId, version))
  return path
}

afterEach(async () => {
  for (const app of liveApps) await app.close()
  liveApps.clear()
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

describe('browser-native Session format upgrade path', () => {
  it('refuses a stored older-format Session instead of reading it', async () => {
    const dataDir = await temporaryDirectory()
    const first = await start(dataDir)
    const reader = await identityFor(first.origin)
    const other = await identityFor(first.origin)
    await close(first.app)

    const id = 'legacy-format-session'
    const path = await seedLegacySession(dataDir, id, reader.principalId, 3)
    const legacyBytes = await readFile(path, 'utf8')
    const second = await start(dataDir)

    const list = await post(second.origin, '/api/browser-native/session/list', envelope('format-list'), reader.sessionCookie)
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.items, [])
    assert.deepEqual(list.body.snapshots, [])

    const stat = await post(second.origin, '/api/browser-native/session/stat', envelope('format-stat', { sessionId: id }), reader.sessionCookie)
    assert.equal(stat.status, 422)
    assert.equal(stat.body.error.code, 'SESSION_FORMAT_UNSUPPORTED')
    assert.deepEqual(stat.body.error.details, { storedVersion: 3, expectedVersion: CURRENT_VERSION })
    assert.match(stat.body.error.message, /log format v3/)
    assert.match(stat.body.error.message, /reads only v4/)
    assert.equal(await readFile(path, 'utf8'), legacyBytes)

    const open = await post(second.origin, '/api/browser-native/session/open', envelope('format-open', {
      sessionId: id,
      access: 'write',
    }), reader.sessionCookie)
    assert.equal(open.status, 422)
    assert.equal(open.body.error.code, 'SESSION_FORMAT_UNSUPPORTED')

    const foreign = await post(second.origin, '/api/browser-native/session/stat', envelope('format-foreign', { sessionId: id }), other.sessionCookie)
    assert.equal(foreign.status, 404)
    assert.equal(foreign.body.error.code, 'SESSION_NOT_FOUND')

    const overwrite = await post(second.origin, '/api/browser-native/session/create', envelope('format-create', {
      sessionId: id,
      header: { id, version: CURRENT_VERSION, createdAt: 1_700_000_000_000, cwd: '/workspace' },
      inheritedEventCount: 0,
    }), reader.sessionCookie)
    assert.equal(overwrite.status, 422)
    assert.equal(overwrite.body.error.code, 'SESSION_FORMAT_UNSUPPORTED')
    assert.equal(await readFile(path, 'utf8'), legacyBytes)
  })

  it('refuses to create a Session stamped with a foreign format version', async () => {
    const dataDir = await temporaryDirectory()
    const { origin } = await start(dataDir)
    const reader = await identityFor(origin)
    const id = 'foreign-create-session'
    const created = await post(origin, '/api/browser-native/session/create', envelope('foreign-create', {
      sessionId: id,
      header: { id, version: 1, createdAt: 1_700_000_000_000, cwd: '/workspace' },
      inheritedEventCount: 0,
    }), reader.sessionCookie)
    assert.equal(created.status, 422)
    assert.equal(created.body.error.code, 'SESSION_FORMAT_UNSUPPORTED')
    assert.deepEqual(created.body.error.details, { storedVersion: 1, expectedVersion: CURRENT_VERSION })

    const currentId = 'current-create-session'
    const current = await post(origin, '/api/browser-native/session/create', envelope('current-create', {
      sessionId: currentId,
      header: { id: currentId, version: CURRENT_VERSION, createdAt: 1_700_000_000_000, cwd: '/workspace' },
      inheritedEventCount: 0,
    }), reader.sessionCookie)
    assert.equal(current.status, 200)
    const stat = await post(origin, '/api/browser-native/session/stat', envelope('current-stat', { sessionId: currentId }), reader.sessionCookie)
    assert.equal(stat.status, 200)
    assert.equal(stat.body.header.version, CURRENT_VERSION)
    const listed = await post(origin, '/api/browser-native/session/list', envelope('current-list'), reader.sessionCookie)
    assert.deepEqual(listed.body.items.map(item => item.sessionId), [currentId])
  })
})
