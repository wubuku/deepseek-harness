import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { createObservabilityJournal } from '../observability-journal.mjs'

const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-share-')))
let image
let app
let origin
const principalCookie = 'dsh-browser-native-principal'
const sessionCookie = 'dsh-browser-native-session-principal'
const auditEntries = []

async function call(cookie, path, options = {}) {
  const headers = { cookie: `${principalCookie}=${cookie}; ${sessionCookie}=${cookie}`, ...options.headers }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

async function createIdentity() {
  const known = new Set(app.workspaces.identities.keys())
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  const text = await response.text()
  assert.equal(response.status, 200, text)
  const principal = [...app.workspaces.identities.keys()].find(key => !known.has(key))
  assert.equal(typeof principal, 'string')
  return { principal, workspaceId: app.workspaces.identities.get(principal) }
}

async function restart() {
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    accessAuditSink: entry => auditEntries.push(entry),
  })
  origin = await app.listen(0)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  await restart()
  const owner = await createIdentity()
  const viewer = await createIdentity()
  assert.notEqual(owner.principal, viewer.principal)

  const sessionId = `sess-share-${randomUUID()}`
  const created = await call(owner.principal, '/api/browser-native/session/create', {
    body: {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      header: { id: sessionId, version: 4, createdAt: Date.now(), cwd: '/dsh/home/workspace' },
    },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const ownerRef = { ownerToken: created.body.owner.ownerToken, ownerEpoch: created.body.owner.ownerEpoch }
  const appended = await call(owner.principal, '/api/browser-native/session/append', {
    body: {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      ...ownerRef,
      expectedNextSeq: 0,
      events: [
        { seq: 0, type: 'user', data: { text: 'shared transcript' } },
        { seq: 1, type: 'assistant', data: { text: 'visible to the viewer' } },
      ],
    },
  })
  assert.equal(appended.status, 200, JSON.stringify(appended.body))

  const viewerOpen = await call(viewer.principal, '/api/browser-native/session/open', {
    body: { protocolVersion: 1, requestId: randomUUID(), sessionId, access: 'read' },
  })
  assert.equal(viewerOpen.status, 404, 'sharing must precede access')

  const shared = await call(owner.principal, '/api/browser-native/session/share', {
    body: { protocolVersion: 1, requestId: randomUUID(), sessionId, viewerPrincipalId: viewer.principal },
  })
  assert.equal(shared.status, 200, JSON.stringify(shared.body))
  assert.equal(shared.body.share.viewerPrincipalId, viewer.principal)
  assert.equal(shared.body.shares.length, 1)
  assert.equal(shared.body.owner, undefined, 'a share response must not carry the owner lease')

  const readOpen = await call(viewer.principal, '/api/browser-native/session/open', {
    body: { protocolVersion: 1, requestId: randomUUID(), sessionId, access: 'read' },
  })
  assert.equal(readOpen.status, 200, JSON.stringify(readOpen.body))
  assert.equal(readOpen.body.shared, true)
  assert.equal(readOpen.body.owner, undefined, 'viewer open must not receive the owner lease')
  const read = await call(viewer.principal, '/api/browser-native/session/read', {
    body: { protocolVersion: 1, requestId: randomUUID(), sessionId },
  })
  assert.equal(read.status, 200, JSON.stringify(read.body))
  assert.deepEqual(read.body.events.map(event => event.seq), [0, 1])
  assert.equal(read.body.ownerToken, undefined)

  const writeOpen = await call(viewer.principal, '/api/browser-native/session/open', {
    body: { protocolVersion: 1, requestId: randomUUID(), sessionId, access: 'write' },
  })
  assert.equal(writeOpen.status, 403, JSON.stringify(writeOpen.body))
  assert.equal(writeOpen.body.error.code, 'SESSION_READ_ONLY')
  const append = await call(viewer.principal, '/api/browser-native/session/append', {
    body: {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      ...ownerRef,
      expectedNextSeq: 2,
      events: [{ seq: 2, type: 'user', data: { text: 'cross-principal write' } }],
    },
  })
  assert.equal(append.status, 403, JSON.stringify(append.body))
  assert.equal(append.body.error.code, 'SESSION_READ_ONLY')
  const handoff = await call(viewer.principal, '/api/browser-native/session/handoff', {
    body: { protocolVersion: 1, requestId: randomUUID(), sessionId, handoffId: 'viewer-handoff', ...ownerRef },
  })
  assert.equal(handoff.status, 403)
  const renew = await call(viewer.principal, '/api/browser-native/session/renew', {
    body: { protocolVersion: 1, requestId: randomUUID(), sessionId, ...ownerRef },
  })
  assert.equal(renew.status, 403)
  const viewerShare = await call(viewer.principal, '/api/browser-native/session/share', {
    body: { protocolVersion: 1, requestId: randomUUID(), sessionId, viewerPrincipalId: owner.principal },
  })
  assert.equal(viewerShare.status, 404, 'only the owner may grant shares')

  const ownerAppend = await call(owner.principal, '/api/browser-native/session/append', {
    body: {
      protocolVersion: 1,
      requestId: randomUUID(),
      sessionId,
      ...ownerRef,
      expectedNextSeq: 2,
      events: [{ seq: 2, type: 'user', data: { text: 'owner keeps writing' } }],
    },
  })
  assert.equal(ownerAppend.status, 200, JSON.stringify(ownerAppend.body))
  const flushed = await call(owner.principal, '/api/browser-native/session/flush', {
    body: { protocolVersion: 1, requestId: randomUUID(), sessionId, ...ownerRef },
  })
  assert.equal(flushed.status, 200, JSON.stringify(flushed.body))

  const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
  const denials = auditEntries.filter(entry => entry.code === 'SESSION_READ_ONLY')
  assert.ok(denials.length >= 2, JSON.stringify(auditEntries))
  for (const denial of denials) {
    assert.equal(denial.resource, 'session')
    assert.equal(denial.resourceId, sessionId)
    assert.equal(denial.principalDigest, digest(viewer.principal))
    assert.equal(denial.status, 403)
  }

  const ownerExport = await call(owner.principal, '/api/browser-native/session/export', {
    body: { workspaceId: owner.workspaceId, sessionId },
  })
  assert.equal(ownerExport.status, 200)
  assert.deepEqual(ownerExport.body.session.events.map(event => event.seq), [0, 1, 2])
  const viewerExport = await call(viewer.principal, '/api/browser-native/session/export', {
    body: { workspaceId: owner.workspaceId, sessionId },
  })
  assert.notEqual(viewerExport.status, 200, 'export stays owner-only')

  await app.close()
  app = undefined
  const journal = createObservabilityJournal({ dataDir })
  const restored = await journal.restore()
  assert.equal(restored.integrity.verified, true)
  assert.ok(restored.accessDenials.some(entry => entry.code === 'SESSION_READ_ONLY' && entry.principalDigest === digest(viewer.principal)))

  const shareFile = JSON.parse(await readFile(join(dataDir, 'session-shares.json'), 'utf8'))
  assert.equal(shareFile.version, 2)
  assert.deepEqual(shareFile.links, [], 'grant-only sharing writes no links')
  assert.deepEqual(shareFile.shares.map(share => [share.sessionId, share.ownerPrincipalId, share.viewerPrincipalId]),
    [[sessionId, owner.principal, viewer.principal]])

  await restart()
  const reopen = await call(viewer.principal, '/api/browser-native/session/open', {
    body: { protocolVersion: 1, requestId: randomUUID(), sessionId, access: 'read' },
  })
  assert.equal(reopen.status, 200, 'the grant must survive a backend restart')
  assert.equal(reopen.body.shared, true)
  const afterRestartOwner = await call(owner.principal, '/api/browser-native/session/open', {
    body: { protocolVersion: 1, requestId: randomUUID(), sessionId, access: 'read' },
  })
  assert.equal(afterRestartOwner.status, 200)
  assert.equal(afterRestartOwner.body.shared, undefined)

  const summary = {
    result: 'passed',
    scope: 'read-only-session-sharing',
    sessionId,
    viewerPrincipalDigest: digest(viewer.principal),
    viewerReadEvents: 2,
    viewerWriteDenied: 'SESSION_READ_ONLY',
    viewerLeaseAcquired: false,
    ownerWriteAfterShare: true,
    auditDenials: denials.length,
    grantSurvivedRestart: true,
  }
  if (process.env.DSH_POC_RESULT_FILE !== undefined) {
    await writeFile(resolve(process.env.DSH_POC_RESULT_FILE), `${JSON.stringify(summary, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} finally {
  await app?.close().catch(() => {})
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
