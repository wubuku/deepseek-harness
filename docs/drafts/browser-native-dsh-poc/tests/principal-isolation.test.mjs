/**
 * Prove that two principals in one browser profile stay isolated across
 * Sessions, Workspace blobs, attachments, and the writer lease, and that every
 * denied cross-principal probe leaves a correlated audit entry.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

function call(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined
      : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'content-length': String(payload.byteLength) }),
        ...headers,
      },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const text = buffer.toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: response.statusCode, headers: response.headers, buffer, text, json })
      })
    })
    request.on('error', reject)
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

function envelope(requestId, fields) {
  return { protocolVersion: 1, requestId, ...fields }
}

function principalDigest(cookieValue) {
  return createHash('sha256').update(cookieValue).digest('hex').slice(0, 16)
}

async function openPrincipal(port) {
  const response = await call(port, { path: '/api/browser-native/workspace/identity' })
  assert.equal(response.status, 200, response.text)
  const setCookies = response.headers['set-cookie'] ?? []
  const workspaceCookie = setCookies.find(value => value.startsWith('dsh-browser-native-principal='))
  const sessionCookie = setCookies.find(value => value.startsWith('dsh-browser-native-session-principal='))
  assert.ok(workspaceCookie, 'workspace cookie must be issued')
  assert.ok(sessionCookie, 'session cookie must be issued')
  return {
    workspaceId: response.json.workspaceId,
    cookie: workspaceCookie.split(';', 1)[0],
    sessionCookie: sessionCookie.split(';', 1)[0],
    cookieValue: workspaceCookie.slice(workspaceCookie.indexOf('=') + 1, workspaceCookie.indexOf(';')),
  }
}

async function start() {
  const dataDir = await mkdtemp(join(tmpdir(), 'browser-native-principal-isolation-'))
  const sink = []
  const app = await createBrowserNativeV2Server({
    dataDir, port: 0, llmMode: 'scripted', accessAuditSink: entry => sink.push(entry),
  })
  const origin = await app.listen()
  return {
    app, sink, origin, port: Number(new URL(origin).port),
    close: async () => {
      await app.close()
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

function entriesFor(audit, predicate) {
  return audit.filter(predicate)
}

describe('browser-native principal isolation', () => {
  it('denies cross-principal Workspace, Session, attachment, and lease access', async () => {
    const { app, close, port, sink } = await start()
    try {
      const alice = await openPrincipal(port)
      const bob = await openPrincipal(port)
      assert.notEqual(alice.workspaceId, bob.workspaceId)

      assert.equal((await call(port, { path: `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${alice.workspaceId}`, headers: { cookie: alice.cookie } })).status, 200)
      const foreignManifest = await call(port, {
        path: `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${alice.workspaceId}`,
        headers: { cookie: bob.cookie },
      })
      assert.equal(foreignManifest.status, 403)
      assert.equal(foreignManifest.json.error.code, 'WORKSPACE_FORBIDDEN')

      const bytes = Buffer.from(`alice-only-${randomUUID()}`)
      const hash = createHash('sha256').update(bytes).digest('hex')
      const uploaded = await call(port, {
        method: 'PUT',
        path: `/api/browser-native/workspace/attachments/${hash}?workspaceId=${alice.workspaceId}&name=alice.txt`,
        headers: { cookie: alice.cookie }, body: bytes,
      })
      assert.equal(uploaded.status, 200, uploaded.text)
      const ownDownload = await call(port, {
        path: `/api/browser-native/workspace/attachments/${hash}?workspaceId=${alice.workspaceId}`,
        headers: { cookie: alice.cookie },
      })
      assert.equal(ownDownload.status, 200)
      assert.deepEqual(ownDownload.buffer, bytes)

      const foreignAttachment = await call(port, {
        path: `/api/browser-native/workspace/attachments/${hash}?workspaceId=${alice.workspaceId}`,
        headers: { cookie: bob.cookie },
      })
      assert.equal(foreignAttachment.status, 403)
      assert.equal(foreignAttachment.json.error.code, 'WORKSPACE_FORBIDDEN')
      assert.equal(foreignAttachment.text.includes('alice-only'), false)

      const missingAttachment = await call(port, {
        path: `/api/browser-native/workspace/attachments/${hash}?workspaceId=${bob.workspaceId}`,
        headers: { cookie: bob.cookie },
      })
      assert.equal(missingAttachment.status, 404)
      assert.equal(missingAttachment.json.error.code, 'ATTACHMENT_NOT_FOUND')

      const sessionId = `sess-${randomUUID()}`
      const created = await call(port, {
        method: 'POST', path: '/api/browser-native/session/create', headers: { cookie: alice.sessionCookie },
        body: envelope('isolation-create', {
          sessionId,
          header: { id: sessionId, version: 4, createdAt: 1_700_000_000_000, cwd: '/workspace' },
          inheritedEventCount: 0,
        }),
      })
      assert.equal(created.status, 200, created.text)

      const ownRead = await call(port, {
        method: 'POST', path: '/api/browser-native/session/read', headers: { cookie: alice.sessionCookie },
        body: envelope('isolation-read-own', { sessionId, offset: 0 }),
      })
      assert.equal(ownRead.status, 200)
      assert.equal(ownRead.json.nextSeq, 0)

      const foreignRead = await call(port, {
        method: 'POST', path: '/api/browser-native/session/read', headers: { cookie: bob.sessionCookie },
        body: envelope('isolation-read-foreign', { sessionId, offset: 0 }),
      })
      assert.equal(foreignRead.status, 404)
      assert.equal(foreignRead.json.error.code, 'SESSION_NOT_FOUND')

      const foreignAppend = await call(port, {
        method: 'POST', path: '/api/browser-native/session/append', headers: { cookie: bob.sessionCookie },
        body: envelope('isolation-append-foreign', {
          sessionId,
          ownerToken: created.json.owner.ownerToken,
          ownerEpoch: created.json.owner.ownerEpoch,
          expectedNextSeq: 0,
          events: [],
        }),
      })
      assert.equal(foreignAppend.status, 404)
      assert.equal(foreignAppend.json.error.code, 'SESSION_NOT_FOUND')

      const foreignList = await call(port, {
        method: 'POST', path: '/api/browser-native/session/list', headers: { cookie: bob.sessionCookie },
        body: envelope('isolation-list-foreign', {}),
      })
      assert.equal(foreignList.status, 200)
      assert.equal(JSON.stringify(foreignList.json).includes(sessionId), false)

      const foreignLease = await call(port, {
        method: 'POST', path: '/api/browser-native/workspace/lease', headers: { cookie: bob.cookie },
        body: envelope('isolation-lease-foreign', { workspaceId: alice.workspaceId, operation: 'claim' }),
      })
      assert.equal(foreignLease.status, 403)
      assert.equal(foreignLease.json.error.code, 'WORKSPACE_FORBIDDEN')

      const ownLease = await call(port, {
        method: 'POST', path: '/api/browser-native/workspace/lease', headers: { cookie: alice.cookie },
        body: envelope('isolation-lease-own', { workspaceId: alice.workspaceId, operation: 'claim' }),
      })
      assert.equal(ownLease.status, 200)
      assert.equal(typeof ownLease.json.writerToken, 'string')

      const audit = app.accessAudit()
      const bobDigest = principalDigest(bob.cookieValue)
      const aliceDigest = principalDigest(alice.cookieValue)
      const denials = entriesFor(audit, entry => entry.principalDigest === bobDigest)
      assert.ok(denials.length >= 5, `expected at least 5 denied probes, got ${String(denials.length)}`)

      const manifestDenial = denials.find(entry => entry.route === '/api/browser-native/workspace/manifest')
      assert.deepEqual(
        { code: manifestDenial.code, status: manifestDenial.status, resource: manifestDenial.resource, resourceId: manifestDenial.resourceId },
        { code: 'WORKSPACE_FORBIDDEN', status: 403, resource: 'workspace', resourceId: alice.workspaceId },
      )
      const sessionDenial = denials.find(entry => entry.route === '/api/browser-native/session/read')
      assert.deepEqual(
        { code: sessionDenial.code, status: sessionDenial.status, resource: sessionDenial.resource },
        { code: 'SESSION_NOT_FOUND', status: 404, resource: 'session' },
      )
      assert.ok(denials.some(entry => entry.route.startsWith('/api/browser-native/workspace/attachments/')))
      assert.ok(denials.some(entry => entry.route === '/api/browser-native/workspace/lease'))
      assert.equal(denials.every(entry => entry.principalDigest === bobDigest), true)
      assert.equal(audit.some(entry => entry.principalDigest === aliceDigest), false, 'authorized alice requests must not be logged as denials')
      assert.equal(audit.length, sink.length, 'the audit sink receives every retained entry')

      const serialized = JSON.stringify(audit)
      assert.equal(serialized.includes(alice.cookieValue), false, 'audit must not contain raw principal ids')
      assert.equal(serialized.includes(bob.cookieValue), false, 'audit must not contain raw principal ids')
      assert.equal(serialized.includes(created.json.owner.ownerToken), false, 'audit must not contain owner tokens')
      assert.equal(serialized.includes('alice-only'), false, 'audit must not contain attachment bytes')
      for (const entry of audit) {
        assert.match(entry.principalDigest, /^[a-f0-9]{16}$/)
        assert.equal(typeof entry.at, 'number')
        assert.equal(typeof entry.method, 'string')
        assert.equal(typeof entry.route, 'string')
        assert.equal(typeof entry.status, 'number')
      }
    } finally {
      await close()
    }
  })
})
