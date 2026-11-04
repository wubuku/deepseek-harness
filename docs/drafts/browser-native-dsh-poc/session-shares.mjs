/**
 * Durable read and editor grants for Session sharing.
 *
 * A viewer grant lets one other principal read a Session's events without the
 * owner token, the write lease, or any mutation right. An editor grant adds
 * append and flush rights, still gated by the separate editor lease in the
 * backend. Grants are stored outside the Session log so the log format and its
 * ownership epoch stay unchanged.
 */
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const FILE_NAME = 'session-shares.json'
const VERSION = 1
const ROLES = new Set(['viewer', 'editor'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

/**
 * Session share records keyed by Session id and viewer principal.
 */
export class SessionShareStore {
  #path
  #shares = new Map()

  /**
   * @param dataDir - Backend data directory that owns the share file.
   */
  constructor(dataDir) {
    this.#path = join(dataDir, FILE_NAME)
  }

  /** Load grants from disk, ignoring a missing file. */
  async load() {
    let raw
    try {
      raw = await readFile(this.#path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    const parsed = JSON.parse(raw)
    if (parsed?.version !== VERSION || !Array.isArray(parsed.shares)) {
      throw new SessionShareError('SHARE_FILE_UNSUPPORTED', `unsupported Session share file version in ${FILE_NAME}`, 500)
    }
    for (const share of parsed.shares) {
      if (typeof share?.sessionId !== 'string' || typeof share?.ownerPrincipalId !== 'string' || typeof share?.viewerPrincipalId !== 'string') {
        throw new SessionShareError('SHARE_FILE_INVALID', `invalid Session share record in ${FILE_NAME}`, 500)
      }
      this.#shares.set(`${share.sessionId}\u0000${share.viewerPrincipalId}`, { ...share, role: normalizedRole(share) })
    }
  }

  /**
   * The grant role a principal holds for a Session.
   * @param sessionId - Session identifier.
   * @param principalId - Candidate viewer or editor principal.
   * @returns `viewer`, `editor`, or `undefined` when no grant exists.
   */
  roleOf(sessionId, principalId) {
    return this.#shares.get(`${sessionId}\u0000${principalId}`)?.role
  }

  /**
   * Whether a principal holds any read grant for a Session.
   * @param sessionId - Session identifier.
   * @param principalId - Candidate viewer principal.
   * @returns True when a viewer or editor grant exists.
   */
  isViewer(sessionId, principalId) {
    return this.roleOf(sessionId, principalId) !== undefined
  }

  /**
   * Whether a principal holds an editor grant for a Session.
   * @param sessionId - Session identifier.
   * @param principalId - Candidate editor principal.
   * @returns True when an editor grant exists.
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
    const share = { sessionId, ownerPrincipalId, viewerPrincipalId, role, grantedAt: Date.now() }
    this.#shares.set(key, share)
    await this.#persist()
    return share
  }

  /**
   * List grants for one Session, visible only to its owner.
   * @param sessionId - Session identifier.
   * @param ownerPrincipalId - Requesting principal.
   * @returns Grants belonging to that owner.
   */
  listForOwner(sessionId, ownerPrincipalId) {
    return [...this.#shares.values()]
      .filter(share => share.sessionId === sessionId && share.ownerPrincipalId === ownerPrincipalId)
      .sort((left, right) => left.viewerPrincipalId.localeCompare(right.viewerPrincipalId))
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
    await writeFile(temporary, `${JSON.stringify({ version: VERSION, shares: [...this.#shares.values()] })}\n`, 'utf8')
    await rename(temporary, this.#path)
  }
}

export { SessionShareError }
