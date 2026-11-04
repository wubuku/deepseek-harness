/**
 * Share-link end-to-end: an owner mints an expiring viewer link, another
 * principal exchanges it for read-only access, and expiry, revocation, and
 * single-use semantics are checked against the real backend.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-share-link-'))
let image
let app
let origin
const principalCookie = 'dsh-browser-native-principal'
const sessionCookie = 'dsh-browser-native-session-principal'
const auditEntries = []

/** Call the backend as one principal with both cookies. */
async function call(cookie, path, body, method) {
  const response = await fetch(`${origin}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { cookie: `${principalCookie}=${cookie}; ${sessionCookie}=${cookie}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

/** Create a fresh anonymous principal and return its id. */
async function createIdentity() {
  const known = new Set(app.workspaces.identities.keys())
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const principal = [...app.workspaces.identities.keys()].find(key => !known.has(key))
  assert.equal(typeof principal, 'string')
  return principal
}

/** Start the backend over the retained data directory. */
async function restart() {
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    accessAuditSink: entry => auditEntries.push(entry),
  })
  origin = await app.listen(0)
}

const protocol = () => ({ protocolVersion: 1, requestId: randomUUID() })
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 16)

/** Poll until a viewer open stops returning 200, proving the grant expired. */
async function waitForReadDenied(cookie, sessionId) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const open = await call(cookie, '/api/browser-native/session/open', { ...protocol(), sessionId, access: 'read' })
    if (open.status !== 200) return open
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('the viewer grant did not expire')
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  await restart()
  const owner = await createIdentity()
  const viewerA = await createIdentity()
  const viewerB = await createIdentity()
  assert.equal(new Set([owner, viewerA, viewerB]).size, 3)

  const sessionId = `sess-link-${randomUUID()}`
  const created = await call(owner, '/api/browser-native/session/create', {
    ...protocol(),
    sessionId,
    header: { id: sessionId, version: 4, createdAt: Date.now(), cwd: '/dsh/home/workspace' },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const ownerRef = { ownerToken: created.body.owner.ownerToken, ownerEpoch: created.body.owner.ownerEpoch }
  const appended = await call(owner, '/api/browser-native/session/append', {
    ...protocol(),
    sessionId,
    ...ownerRef,
    expectedNextSeq: 0,
    events: [
      { seq: 0, type: 'user', data: { text: 'link-visible transcript' } },
      { seq: 1, type: 'assistant', data: { text: 'readable through a viewer link' } },
    ],
  })
  assert.equal(appended.status, 200, JSON.stringify(appended.body))

  const beforeRedeem = await call(viewerA, '/api/browser-native/session/open', { ...protocol(), sessionId, access: 'read' })
  assert.equal(beforeRedeem.status, 404, 'no grant exists before redemption')

  const linkA = await call(owner, '/api/browser-native/session/share-link', { ...protocol(), sessionId, expiresInMs: 120_000 })
  assert.equal(linkA.status, 200, JSON.stringify(linkA.body))
  assert.equal(linkA.body.link.role, 'viewer')
  assert.equal(linkA.body.link.token.length, 43)
  assert.equal(linkA.body.link.redeemedBy, null)
  assert.ok(linkA.body.link.expiresAt > Date.now(), 'the link must expire in the future')

  const shareFile = JSON.parse(await readFile(join(dataDir, 'session-shares.json'), 'utf8'))
  assert.equal(shareFile.version, 2)
  assert.equal(shareFile.links.length, 1)
  assert.equal(JSON.stringify(shareFile).includes(linkA.body.link.token), false,
    'the durable share file must not store the bearer token')

  const redeemed = await call(viewerA, '/api/browser-native/session/share-link/redeem', { ...protocol(), token: linkA.body.link.token })
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body))
  assert.equal(redeemed.body.role, 'viewer')
  assert.equal(redeemed.body.share.linkId, linkA.body.link.linkId)
  assert.equal(redeemed.body.share.expiresAt, linkA.body.link.expiresAt, 'the grant is bounded by the link expiry')
  assert.equal(redeemed.body.share.ownerToken, undefined, 'redemption must not hand out the owner lease')

  const readOpen = await call(viewerA, '/api/browser-native/session/open', { ...protocol(), sessionId, access: 'read' })
  assert.equal(readOpen.status, 200, JSON.stringify(readOpen.body))
  assert.equal(readOpen.body.shared, true)
  assert.equal(readOpen.body.owner, undefined, 'a redeemed viewer never receives the owner lease')
  const read = await call(viewerA, '/api/browser-native/session/read', { ...protocol(), sessionId })
  assert.equal(read.status, 200, JSON.stringify(read.body))
  assert.deepEqual(read.body.events.map(event => event.seq), [0, 1])
  assert.equal(read.body.ownerToken, undefined)

  const writeOpen = await call(viewerA, '/api/browser-native/session/open', { ...protocol(), sessionId, access: 'write' })
  assert.equal(writeOpen.status, 403, JSON.stringify(writeOpen.body))
  assert.equal(writeOpen.body.error.code, 'SESSION_READ_ONLY')
  const writeAppend = await call(viewerA, '/api/browser-native/session/append', {
    ...protocol(),
    sessionId,
    ...ownerRef,
    expectedNextSeq: 2,
    events: [{ seq: 2, type: 'user', data: { text: 'link viewer write' } }],
  })
  assert.equal(writeAppend.status, 403, JSON.stringify(writeAppend.body))
  assert.equal(writeAppend.body.error.code, 'SESSION_READ_ONLY')

  const reused = await call(viewerB, '/api/browser-native/session/share-link/redeem', { ...protocol(), token: linkA.body.link.token })
  assert.equal(reused.status, 409, JSON.stringify(reused.body))
  assert.equal(reused.body.error.code, 'SHARE_LINK_USED')

  const linkB = await call(owner, '/api/browser-native/session/share-link', { ...protocol(), sessionId, expiresInMs: 1_500 })
  assert.equal(linkB.status, 200)
  const redeemedB = await call(viewerB, '/api/browser-native/session/share-link/redeem', { ...protocol(), token: linkB.body.link.token })
  assert.equal(redeemedB.status, 200, JSON.stringify(redeemedB.body))
  assert.equal(redeemedB.body.share.expiresAt, linkB.body.link.expiresAt)
  const openB = await call(viewerB, '/api/browser-native/session/open', { ...protocol(), sessionId, access: 'read' })
  assert.equal(openB.status, 200, 'the fresh grant must read before expiry')
  const expired = await waitForReadDenied(viewerB, sessionId)
  assert.equal(expired.status, 404, JSON.stringify(expired.body))
  const expiredRedeem = await call(viewerB, '/api/browser-native/session/share-link/redeem', { ...protocol(), token: linkB.body.link.token })
  assert.equal(expiredRedeem.status, 410, JSON.stringify(expiredRedeem.body))
  assert.equal(expiredRedeem.body.error.code, 'SHARE_LINK_EXPIRED')

  const foreignRevoke = await call(viewerA, '/api/browser-native/session/share-link/revoke', { ...protocol(), sessionId, linkId: linkA.body.link.linkId })
  assert.equal(foreignRevoke.status, 404, JSON.stringify(foreignRevoke.body))
  assert.equal(foreignRevoke.body.error.code, 'SESSION_NOT_FOUND', 'only the owner can see or revoke a link')
  const revoked = await call(owner, '/api/browser-native/session/share-link/revoke', { ...protocol(), sessionId, linkId: linkA.body.link.linkId })
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
  assert.equal(revoked.body.revoked, true)
  assert.equal(revoked.body.link.revokedAt === null, false)
  assert.equal(revoked.body.shares.some(share => share.linkId === linkA.body.link.linkId), false,
    'revoking the link removes its grant')
  const afterRevoke = await call(viewerA, '/api/browser-native/session/open', { ...protocol(), sessionId, access: 'read' })
  assert.equal(afterRevoke.status, 404, 'the revoked viewer loses access')
  const revokedAgain = await call(owner, '/api/browser-native/session/share-link/revoke', { ...protocol(), sessionId, linkId: linkA.body.link.linkId })
  assert.equal(revokedAgain.status, 200)
  assert.equal(revokedAgain.body.revoked, false, 'revocation is idempotent')
  const revokedRedeem = await call(viewerB, '/api/browser-native/session/share-link/redeem', { ...protocol(), token: linkA.body.link.token })
  assert.equal(revokedRedeem.status, 410, JSON.stringify(revokedRedeem.body))
  assert.equal(revokedRedeem.body.error.code, 'SHARE_LINK_REVOKED')

  const ownerStillReads = await call(owner, '/api/browser-native/session/open', { ...protocol(), sessionId, access: 'read' })
  assert.equal(ownerStillReads.status, 200, JSON.stringify(ownerStillReads.body))

  await app.close()
  app = undefined
  await restart()
  const reopenAfterRestart = await call(viewerA, '/api/browser-native/session/open', { ...protocol(), sessionId, access: 'read' })
  assert.equal(reopenAfterRestart.status, 404, 'a revoked grant stays revoked after restart')
  const expiredAfterRestart = await call(viewerB, '/api/browser-native/session/open', { ...protocol(), sessionId, access: 'read' })
  assert.equal(expiredAfterRestart.status, 404, 'an expired grant stays expired after restart')

  const denials = auditEntries.filter(entry => entry.code === 'SESSION_READ_ONLY')
  assert.ok(denials.length >= 2, JSON.stringify(auditEntries))
  for (const denial of denials) {
    assert.equal(denial.resource, 'session')
    assert.equal(denial.resourceId, sessionId)
    assert.equal(denial.principalDigest, digest(viewerA))
    assert.equal(denial.status, 403)
  }

  const summary = {
    result: 'passed',
    scope: 'expiring-read-only-share-link',
    sessionId,
    linkId: linkA.body.link.linkId,
    linkExpiresInMs: 120_000,
    viewerReadEvents: 2,
    viewerWriteDenied: 'SESSION_READ_ONLY',
    viewerLeaseAcquired: false,
    secondRedemption: reused.body.error.code,
    expiredRedemption: expiredRedeem.body.error.code,
    revokedRedemption: revokedRedeem.body.error.code,
    revokeIdempotent: revokedAgain.body.revoked === false,
    accessAfterRestart: { revoked: reopenAfterRestart.status, expired: expiredAfterRestart.status },
    auditDenials: denials.length,
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} finally {
  await app?.close().catch(() => undefined)
  await image?.cleanup()
  await rm(dataDir, { recursive: true, force: true })
}
