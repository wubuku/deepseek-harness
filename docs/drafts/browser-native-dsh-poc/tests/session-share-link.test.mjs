/**
 * Share-link unit tests: single-use redemption, expiry, revocation, and the
 * legacy grant-only file.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionShareStore } from '../session-shares.mjs'

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-share-link-'))
let now = 1_000_000
const clock = { now: () => now }

/** Build a store over the shared temp directory. */
async function openStore() {
  const store = new SessionShareStore(dataDir, clock)
  await store.load()
  return store
}

try {
  const sessionId = `sess-link-${randomUUID()}`
  const owner = randomUUID()
  const viewer = randomUUID()
  const other = randomUUID()
  const store = await openStore()

  const link = await store.createLink({ sessionId, ownerPrincipalId: owner, expiresAt: now + 60_000 })
  assert.equal(link.role, 'viewer')
  assert.equal(link.token.length, 43)
  assert.equal(link.redeemedBy, null)
  assert.equal(link.revokedAt, null)
  assert.equal(store.roleOf(sessionId, viewer), undefined, 'creating a link grants nothing')

  const file = JSON.parse(await readFile(join(dataDir, 'session-shares.json'), 'utf8'))
  assert.equal(file.version, 2)
  assert.equal(file.links.length, 1)
  assert.equal(file.links[0].tokenHash.length, 64)
  assert.equal(JSON.stringify(file).includes(link.token), false, 'the share file must not store the bearer token')

  const redeemed = await store.redeemLink({ token: link.token, viewerPrincipalId: viewer })
  assert.equal(redeemed.share.role, 'viewer')
  assert.equal(redeemed.share.linkId, link.linkId)
  assert.equal(redeemed.share.expiresAt, link.expiresAt)
  assert.equal(store.roleOf(sessionId, viewer), 'viewer')
  assert.equal(store.isEditor(sessionId, viewer), false, 'a link never grants editor rights')

  assert.throws(() => store.inspectLink({ token: link.token }), error => error.code === 'SHARE_LINK_USED' && error.status === 409)
  assert.throws(() => store.inspectLink({ token: 'x'.repeat(43) }), error => error.code === 'SHARE_LINK_UNKNOWN' && error.status === 404)
  assert.throws(() => store.inspectLink({ token: 'short' }), error => error.code === 'INVALID_REQUEST')

  const reloaded = await openStore()
  assert.equal(reloaded.roleOf(sessionId, viewer), 'viewer', 'the redeemed grant survives a reload')

  now = link.expiresAt
  assert.equal(store.roleOf(sessionId, viewer), undefined, 'the grant ends at the link expiry')
  assert.throws(() => store.inspectLink({ token: link.token }), error => error.code === 'SHARE_LINK_EXPIRED', 'expiry outranks prior use')

  const expiring = await store.createLink({ sessionId, ownerPrincipalId: owner, expiresAt: now + 1_000 })
  now += 1_000
  assert.throws(() => store.inspectLink({ token: expiring.token }), error => error.code === 'SHARE_LINK_EXPIRED' && error.status === 410)

  const ownerLink = await store.createLink({ sessionId, ownerPrincipalId: owner, expiresAt: now + 60_000 })
  await assert.rejects(store.redeemLink({ token: ownerLink.token, viewerPrincipalId: owner }),
    error => error.code === 'INVALID_REQUEST')
  const revocable = await store.createLink({ sessionId, ownerPrincipalId: owner, expiresAt: now + 60_000 })
  await store.redeemLink({ token: revocable.token, viewerPrincipalId: other })
  assert.equal(store.roleOf(sessionId, other), 'viewer')
  const revoked = await store.revokeLink({ sessionId, linkId: revocable.linkId, ownerPrincipalId: owner })
  assert.equal(revoked.revoked, true)
  assert.equal(store.roleOf(sessionId, other), undefined, 'revoking the link removes its grant')
  assert.deepEqual(store.listLinksForOwner(sessionId, owner).map(item => [item.linkId, item.revokedAt !== null]),
    [[link.linkId, false], [expiring.linkId, false], [ownerLink.linkId, false], [revocable.linkId, true]])
  assert.equal((await store.revokeLink({ sessionId, linkId: revocable.linkId, ownerPrincipalId: owner })).revoked, false)
  await assert.rejects(store.redeemLink({ token: revocable.token, viewerPrincipalId: randomUUID() }),
    error => error.code === 'SHARE_LINK_REVOKED' && error.status === 410)
  await assert.rejects(store.revokeLink({ sessionId, linkId: revocable.linkId, ownerPrincipalId: other }),
    error => error.code === 'SESSION_OWNER_REQUIRED' && error.status === 403)
  await assert.rejects(store.createLink({ sessionId, ownerPrincipalId: owner, role: 'editor', expiresAt: now + 60_000 }),
    error => error.code === 'INVALID_REQUEST')
  await assert.rejects(store.createLink({ sessionId, ownerPrincipalId: owner, expiresAt: now - 1 }),
    error => error.code === 'INVALID_REQUEST')

  const legacyDir = await mkdtemp(join(tmpdir(), 'dsh-share-legacy-'))
  try {
    await writeFile(join(legacyDir, 'session-shares.json'), `${JSON.stringify({
      version: 1,
      shares: [{ sessionId, ownerPrincipalId: owner, viewerPrincipalId: viewer, role: 'viewer', grantedAt: 1 }],
    })}\n`, 'utf8')
    const legacy = new SessionShareStore(legacyDir, clock)
    await legacy.load()
    assert.equal(legacy.roleOf(sessionId, viewer), 'viewer')
    assert.deepEqual(legacy.listLinksForOwner(sessionId, owner), [])
  } finally {
    await rm(legacyDir, { recursive: true, force: true })
  }

  process.stdout.write(`${JSON.stringify({ result: 'passed', cases: 7, tokenLength: link.token.length })}\n`)
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
