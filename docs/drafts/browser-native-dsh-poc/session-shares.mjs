/**
 * Durable read and editor grants for Session sharing.
 *
 * A viewer grant lets one other principal read a Session's events without the
 * owner token, the write lease, or any mutation right. An editor grant adds
 * append and flush rights, still gated by the separate editor lease in the
 * backend. Grants are stored outside the Session log so the log format and its
 * ownership epoch stay unchanged.
 *
 * A share link is a single-use bearer token the owner creates with an expiry.
 * Redeeming it records a viewer grant that ends with the link's `expiresAt`,
 * and revoking the link removes that grant. The token itself is stored only as
 * a SHA-256 hash, so the share file never contains a live secret.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const FILE_NAME = 'session-shares.json'
const VERSION = 2
/** Older share files carry grants only; they load with an empty link set. */
const LEGACY_VERSION = 1
const ROLES = new Set(['viewer', 'editor'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/

class SessionShareError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'SessionShareError'
    this.code = code
    this.status = status
  }
}

/** Normalize a stored share, defaulting the role for files written before roles existed. */
function normalizedRole(share) {
  if (share.role === undefined) return 'viewer'
  if (!ROLES.has(share.role)) throw new SessionShareError('SHARE_FILE_INVALID', `invalid Session share role in ${FILE_NAME}`, 500)
  return share.role
}

/** Hash a bearer token so the share file stores no live secret. */
function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

/** Client-visible link fields; the token and its hash never appear here. */
function publicLink(link) {
  return {
    linkId: link.linkId,
    sessionId: link.sessionId,
    role: link.role,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    redeemedBy: link.redeemedBy,
    revokedAt: link.revokedAt,
  }
}

/**
 * Session share records keyed by Session id and viewer principal, plus
 * single-use links keyed by id and token hash.
 */
export class SessionShareStore {
  #path
  #shares = new Map()
  #links = new Map()
  #linkHashes = new Map()
  #now

  /**
   * @param dataDir - Backend data directory that owns the share file.
   * @param options - `now` clock for expiry checks and deterministic tests.
   */
  constructor(dataDir, options = {}) {
    this.#path = join(dataDir, FILE_NAME)
    if (options.now !== undefined && typeof options.now !== 'function') throw new TypeError('now must be a function')
    this.#now = options.now ?? Date.now
  }

  /** Load grants and links from disk, ignoring a missing file. */
  async load() {
    let raw
    try {
      raw = await readFile(this.#path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    const parsed = JSON.parse(raw)
    if ((parsed?.version !== VERSION && parsed?.version !== LEGACY_VERSION) || !Array.isArray(parsed.shares)) {
      throw new SessionShareError('SHARE_FILE_UNSUPPORTED', `unsupported Session share file version in ${FILE_NAME}`, 500)
    }
    for (const share of parsed.shares) {
      if (typeof share?.sessionId !== 'string' || typeof share?.ownerPrincipalId !== 'string' || typeof share?.viewerPrincipalId !== 'string') {
        throw new SessionShareError('SHARE_FILE_INVALID', `invalid Session share record in ${FILE_NAME}`, 500)
      }
      this.#shares.set(`${share.sessionId}\u0000${share.viewerPrincipalId}`, { ...share, role: normalizedRole(share) })
    }
    const links = parsed.version === VERSION ? parsed.links : []
    if (links !== undefined && !Array.isArray(links)) {
      throw new SessionShareError('SHARE_FILE_INVALID', `invalid Session share link list in ${FILE_NAME}`, 500)
    }
    for (const link of links ?? []) {
      if (typeof link?.linkId !== 'string' || !UUID_PATTERN.test(link.linkId)
        || typeof link?.sessionId !== 'string'
        || typeof link?.ownerPrincipalId !== 'string' || !UUID_PATTERN.test(link.ownerPrincipalId)
        || typeof link?.tokenHash !== 'string' || !TOKEN_HASH_PATTERN.test(link.tokenHash)
        || !Number.isSafeInteger(link?.expiresAt)) {
        throw new SessionShareError('SHARE_FILE_INVALID', `invalid Session share link record in ${FILE_NAME}`, 500)
      }
      if (link.role !== 'viewer' || !ROLES.has(link.role)) {
        throw new SessionShareError('SHARE_FILE_INVALID', `invalid Session share link role in ${FILE_NAME}`, 500)
      }
      this.#links.set(link.linkId, link)
      this.#linkHashes.set(link.tokenHash, link.linkId)
    }
  }

  /**
   * The grant role a principal holds for a Session.
   * @param sessionId - Session identifier.
   * @param principalId - Candidate viewer or editor principal.
   * @returns `viewer`, `editor`, or `undefined` when no live grant exists.
   */
  roleOf(sessionId, principalId) {
    const share = this.#shares.get(`${sessionId}\u0000${principalId}`)
    if (share === undefined) return undefined
    if (share.expiresAt !== undefined && this.#now() >= share.expiresAt) return undefined
    return share.role
  }

  /**
   * Whether a principal holds any live read grant for a Session.
   * @param sessionId - Session identifier.
   * @param principalId - Candidate viewer principal.
   * @returns True when a viewer or editor grant exists and has not expired.
   */
  isViewer(sessionId, principalId) {
    return this.roleOf(sessionId, principalId) !== undefined
  }

  /**
   * Whether a principal holds a live editor grant for a Session.
   * @param sessionId - Session identifier.
   * @param principalId - Candidate editor principal.
   * @returns True when an editor grant exists and has not expired.
   */
  isEditor(sessionId, principalId) {
    return this.roleOf(sessionId, principalId) === 'editor'
  }

  /**
   * Record a grant. Repeating the same grant returns the existing record;
   * repeating it with a different role replaces the role.
   * @param grant - Session, owning principal, viewer principal, and role.
   * @returns The stored grant.
   */
  async grant({ sessionId, ownerPrincipalId, viewerPrincipalId, role = 'viewer' }) {
    if (!UUID_PATTERN.test(ownerPrincipalId)) throw new SessionShareError('INVALID_REQUEST', 'owner principal id is invalid')
    if (!UUID_PATTERN.test(viewerPrincipalId)) throw new SessionShareError('INVALID_REQUEST', 'viewer principal id is invalid')
    if (!ROLES.has(role)) throw new SessionShareError('INVALID_REQUEST', 'share role must be viewer or editor')
    if (ownerPrincipalId === viewerPrincipalId) {
      throw new SessionShareError('INVALID_REQUEST', 'a Session cannot be shared with its owner')
    }
    const key = `${sessionId}\u0000${viewerPrincipalId}`
    const existing = this.#shares.get(key)
    if (existing !== undefined && existing.role === role) return existing
    const share = { sessionId, ownerPrincipalId, viewerPrincipalId, role, grantedAt: this.#now() }
    this.#shares.set(key, share)
    await this.#persist()
    return share
  }

  /**
   * List grants for one Session, visible only to its owner.
   * @param sessionId - Session identifier.
   * @param ownerPrincipalId - Requesting principal.
   * @returns Grants belonging to that owner, including expired link grants.
   */
  listForOwner(sessionId, ownerPrincipalId) {
    return [...this.#shares.values()]
      .filter(share => share.sessionId === sessionId && share.ownerPrincipalId === ownerPrincipalId)
      .sort((left, right) => left.viewerPrincipalId.localeCompare(right.viewerPrincipalId))
  }

  /**
   * Create a single-use viewer link that expires at `expiresAt`.
   * @param link - Session, owning principal, role fixed to viewer, and expiry.
   * @returns Client-visible link fields plus the bearer `token`.
   */
  async createLink({ sessionId, ownerPrincipalId, role = 'viewer', expiresAt }) {
    if (!UUID_PATTERN.test(ownerPrincipalId)) throw new SessionShareError('INVALID_REQUEST', 'owner principal id is invalid')
    if (role !== 'viewer') throw new SessionShareError('INVALID_REQUEST', 'share links grant viewer access only')
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.#now()) {
      throw new SessionShareError('INVALID_REQUEST', 'expiresAt must be a future millisecond timestamp')
    }
    const token = randomBytes(32).toString('base64url')
    const link = {
      linkId: randomUUID(),
      sessionId,
      ownerPrincipalId,
      role,
      tokenHash: hashToken(token),
      createdAt: this.#now(),
      expiresAt,
      redeemedBy: null,
      revokedAt: null,
    }
    this.#links.set(link.linkId, link)
    this.#linkHashes.set(link.tokenHash, link.linkId)
    await this.#persist()
    return { ...publicLink(link), token }
  }

  /**
   * Resolve a bearer token to its live link without redeeming it.
   * @param redeem - Bearer token supplied by the viewer.
   * @returns Client-visible link fields plus the owning principal.
   * @throws SessionShareError for unknown, revoked, expired, or used links.
   */
  inspectLink({ token }) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      throw new SessionShareError('INVALID_REQUEST', 'share token is invalid')
    }
    const linkId = this.#linkHashes.get(hashToken(token))
    const link = linkId === undefined ? undefined : this.#links.get(linkId)
    if (link === undefined) throw new SessionShareError('SHARE_LINK_UNKNOWN', 'share link is unknown', 404)
    if (link.revokedAt !== null) throw new SessionShareError('SHARE_LINK_REVOKED', 'share link was revoked', 410)
    if (this.#now() >= link.expiresAt) throw new SessionShareError('SHARE_LINK_EXPIRED', 'share link expired', 410)
    if (link.redeemedBy !== null) throw new SessionShareError('SHARE_LINK_USED', 'share link was already redeemed', 409)
    return { ...publicLink(link), ownerPrincipalId: link.ownerPrincipalId }
  }

  /**
   * Exchange a live link for a viewer grant bounded by the link's expiry.
   * @param redeem - Bearer token and the redeeming principal.
   * @returns The stored grant and the redeemed link.
   */
  async redeemLink({ token, viewerPrincipalId }) {
    if (!UUID_PATTERN.test(viewerPrincipalId)) throw new SessionShareError('INVALID_REQUEST', 'viewer principal id is invalid')
    const inspected = this.inspectLink({ token })
    if (inspected.ownerPrincipalId === viewerPrincipalId) {
      throw new SessionShareError('INVALID_REQUEST', 'a Session cannot be shared with its owner')
    }
    const link = this.#links.get(inspected.linkId)
    const key = `${link.sessionId}\u0000${viewerPrincipalId}`
    const existing = this.#shares.get(key)
    let share
    if (existing !== undefined && existing.role === 'editor') {
      // An editor grant outranks the viewer grant this link would add.
      share = existing
    } else {
      share = {
        sessionId: link.sessionId,
        ownerPrincipalId: link.ownerPrincipalId,
        viewerPrincipalId,
        role: 'viewer',
        grantedAt: this.#now(),
        linkId: link.linkId,
        expiresAt: link.expiresAt,
      }
      this.#shares.set(key, share)
    }
    link.redeemedBy = viewerPrincipalId
    await this.#persist()
    return { share: { ...share }, link: publicLink(link) }
  }

  /**
   * Revoke a link and the viewer grant it created.
   * @param revoke - Session, link, and requesting owner principal.
   * @returns Whether the link changed state, plus its current fields.
   */
  async revokeLink({ sessionId, linkId, ownerPrincipalId }) {
    if (typeof linkId !== 'string' || !UUID_PATTERN.test(linkId)) throw new SessionShareError('INVALID_REQUEST', 'linkId is invalid')
    const link = this.#links.get(linkId)
    if (link === undefined || link.sessionId !== sessionId) throw new SessionShareError('SHARE_LINK_UNKNOWN', 'share link is unknown', 404)
    if (link.ownerPrincipalId !== ownerPrincipalId) throw new SessionShareError('SESSION_OWNER_REQUIRED', 'only the Session owner may revoke a share link', 403)
    if (link.revokedAt !== null) return { revoked: false, link: publicLink(link) }
    link.revokedAt = this.#now()
    for (const [key, share] of this.#shares) {
      if (share.linkId === linkId) this.#shares.delete(key)
    }
    await this.#persist()
    return { revoked: true, link: publicLink(link) }
  }

  /**
   * List links for one Session, visible only to its owner.
   * @param sessionId - Session identifier.
   * @param ownerPrincipalId - Requesting principal.
   * @returns Links in creation order without bearer tokens.
   */
  listLinksForOwner(sessionId, ownerPrincipalId) {
    return [...this.#links.values()]
      .filter(link => link.sessionId === sessionId && link.ownerPrincipalId === ownerPrincipalId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(publicLink)
  }

  /**
   * Write the loaded grants and links in the current file version.
   *
   * Used by the dataset upgrade after loading a v1 file so role defaults are
   * materialized and the file gains its `links` list.
   */
  async save() {
    await this.#persist()
  }

  /**
   * Remove a grant, used to roll back a failed ownership transfer.
   * @param revoke - Session identifier and viewer principal.
   * @returns True when a grant existed and was removed.
   */
  async revoke({ sessionId, viewerPrincipalId }) {
    const key = `${sessionId}\u0000${viewerPrincipalId}`
    if (!this.#shares.delete(key)) return false
    await this.#persist()
    return true
  }

  /** Replace the share file atomically with the current records. */
  async #persist() {
    const temporary = `${this.#path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify({
      version: VERSION,
      shares: [...this.#shares.values()],
      links: [...this.#links.values()],
    })}\n`, 'utf8')
    await rename(temporary, this.#path)
  }
}

export { SessionShareError }
