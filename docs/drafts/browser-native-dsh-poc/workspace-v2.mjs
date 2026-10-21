import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const COOKIE_NAME = 'dsh-browser-native-principal'
const MAX_ENTRIES = 2_000
const MAX_PATH_LENGTH = 512

export class WorkspaceError extends Error {
  constructor(code, message, status = 400, details) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function assertRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceError('INVALID_REQUEST', `${label} must be an object`)
  }
  return value
}

function assertId(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new WorkspaceError('INVALID_REQUEST', `${label} is invalid`)
  }
  return value
}

function assertProtocol(body) {
  assertRecord(body, 'request')
  if (body.protocolVersion !== 1) throw new WorkspaceError('PROTOCOL_UNSUPPORTED', 'unsupported browser-native protocol')
  if (typeof body.requestId !== 'string' || body.requestId.length === 0 || body.requestId.length > 200) {
    throw new WorkspaceError('INVALID_REQUEST', 'requestId is required')
  }
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseCookies(header) {
  const cookies = new Map()
  for (const item of (header ?? '').split(';')) {
    const separator = item.indexOf('=')
    if (separator < 0) continue
    cookies.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim())
  }
  return cookies
}

function validatePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH
    || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new WorkspaceError('INVALID_PATH', 'workspace path must be a relative POSIX path')
  }
  const segments = value.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new WorkspaceError('INVALID_PATH', 'workspace path contains an invalid segment')
  }
  return value
}

function validateMode(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o777) {
    throw new WorkspaceError('INVALID_REQUEST', 'mode must contain permission bits only')
  }
  return value
}

function stableManifest(entries) {
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path))
}

function manifestDigest(entries) {
  return createHash('sha256').update(JSON.stringify(stableManifest(entries))).digest('hex')
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(contents)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
  const directory = await open(dirname(path), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export class WorkspaceStore {
  constructor(dataDir) {
    this.root = join(dataDir, 'workspace-v2')
    this.blobsDir = join(this.root, 'blobs')
    this.workspacesDir = join(this.root, 'workspaces')
    this.identitiesPath = join(this.root, 'identities.json')
    this.identities = new Map()
    this.workspaces = new Map()
    this.locks = new Map()
  }

  async load() {
    await Promise.all([
      mkdir(this.blobsDir, { recursive: true }),
      mkdir(this.workspacesDir, { recursive: true }),
    ])
    try {
      const raw = JSON.parse(await readFile(this.identitiesPath, 'utf8'))
      if (Array.isArray(raw.identities)) {
        for (const identity of raw.identities) {
          if (typeof identity.principalId === 'string' && typeof identity.workspaceId === 'string') {
            this.identities.set(identity.principalId, identity.workspaceId)
          }
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    for (const entry of await readdir(this.workspacesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const workspaceId = entry.name.slice(0, -'.json'.length)
      const raw = JSON.parse(await readFile(join(this.workspacesDir, entry.name), 'utf8'))
      if (raw.id !== workspaceId || !Number.isSafeInteger(raw.revision) || !Array.isArray(raw.entries)) continue
      const entries = new Map(raw.entries.map(item => [item.path, item]))
      const operations = new Map(Object.entries(raw.operations ?? {}))
      const uploadedHashes = new Set(raw.uploadedHashes ?? [])
      this.workspaces.set(workspaceId, { id: workspaceId, owner: raw.owner, revision: raw.revision, entries, operations, uploadedHashes })
    }
  }

  async exclusive(id, operation) {
    const previous = this.locks.get(id) ?? Promise.resolve()
    let release
    const current = new Promise(resolveRelease => { release = resolveRelease })
    this.locks.set(id, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.locks.get(id) === current) this.locks.delete(id)
    }
  }

  async writeIdentities(records) {
    const identities = [...records].map(([principalId, workspaceId]) => ({ principalId, workspaceId }))
    await atomicWrite(this.identitiesPath, JSON.stringify({ version: 1, identities }))
  }

  workspacePath(id) {
    return join(this.workspacesDir, `${id}.json`)
  }

  async persistWorkspace(workspace) {
    const value = {
      version: 1,
      id: workspace.id,
      owner: workspace.owner,
      revision: workspace.revision,
      entries: stableManifest(workspace.entries),
      operations: Object.fromEntries(workspace.operations),
      uploadedHashes: [...workspace.uploadedHashes].sort(),
    }
    await atomicWrite(this.workspacePath(workspace.id), JSON.stringify(value))
  }

  principalFromRequest(request) {
    const principalId = parseCookies(request.headers.cookie).get(COOKIE_NAME)
    if (principalId === undefined || !this.identities.has(principalId)) {
      throw new WorkspaceError('UNAUTHENTICATED', 'workspace identity is missing or expired', 401)
    }
    return principalId
  }

  async openIdentity(request, secure) {
    const existing = parseCookies(request.headers.cookie).get(COOKIE_NAME)
    let principalId = existing !== undefined && this.identities.has(existing) ? existing : undefined
    if (principalId === undefined) {
      principalId = await this.exclusive('identities', async () => {
        const newPrincipalId = randomUUID()
        const workspaceId = randomUUID()
        const identities = new Map(this.identities).set(newPrincipalId, workspaceId)
        const workspace = {
          id: workspaceId, owner: newPrincipalId, revision: 0,
          entries: new Map(), operations: new Map(), uploadedHashes: new Set(),
        }
        await this.persistWorkspace(workspace)
        await this.writeIdentities(identities)
        this.workspaces.set(workspaceId, workspace)
        this.identities = identities
        return newPrincipalId
      })
    }
    const workspaceId = this.identities.get(principalId)
    if (workspaceId === undefined) throw new WorkspaceError('IDENTITY_NOT_FOUND', 'workspace identity does not exist', 401)
    const cookie = `${COOKIE_NAME}=${principalId}; Path=/api/browser-native/workspace; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
    return { workspaceId, cookie }
  }

  requireWorkspace(principalId, workspaceId) {
    assertId(workspaceId, 'workspaceId')
    if (this.identities.get(principalId) !== workspaceId) {
      throw new WorkspaceError('WORKSPACE_FORBIDDEN', 'workspace is not available to this browser identity', 403)
    }
    const workspace = this.workspaces.get(workspaceId)
    if (workspace === undefined || workspace.owner !== principalId) {
      throw new WorkspaceError('WORKSPACE_NOT_FOUND', 'workspace does not exist', 404)
    }
    return workspace
  }

  snapshot(workspace) {
    const entries = stableManifest(workspace.entries)
    return {
      workspaceId: workspace.id,
      revision: workspace.revision,
      entries,
      digest: manifestDigest(workspace.entries),
    }
  }

  manifest(request, workspaceId) {
    const principalId = this.principalFromRequest(request)
    return this.snapshot(this.requireWorkspace(principalId, workspaceId))
  }

  async putBlob(request, workspaceId, hash, bytes) {
    const principalId = this.principalFromRequest(request)
    this.requireWorkspace(principalId, workspaceId)
    if (!/^[a-f0-9]{64}$/.test(hash) || hashBytes(bytes) !== hash) {
      throw new WorkspaceError('BLOB_HASH_MISMATCH', 'uploaded bytes do not match the requested SHA-256 hash')
    }
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.requireWorkspace(principalId, workspaceId)
      const path = join(this.blobsDir, hash.slice(0, 2), hash)
      let reused = false
      try {
        const info = await stat(path)
        if (info.size !== bytes.byteLength) throw new WorkspaceError('BLOB_HASH_COLLISION', 'stored blob size differs for this hash', 500)
        if (hashBytes(await readFile(path)) !== hash) throw new WorkspaceError('BLOB_CORRUPT', 'stored blob failed SHA-256 verification', 500)
        reused = true
      } catch (error) {
        if (error instanceof WorkspaceError || error?.code !== 'ENOENT') throw error
      }
      if (!reused) await atomicWrite(path, bytes)
      if (!workspace.uploadedHashes.has(hash)) {
        const next = { ...workspace, uploadedHashes: new Set(workspace.uploadedHashes).add(hash) }
        await this.persistWorkspace(next)
        this.workspaces.set(workspaceId, next)
      }
      return { hash, bytes: bytes.byteLength, reused }
    })
  }

  async getBlob(request, workspaceId, hash) {
    const principalId = this.principalFromRequest(request)
    const workspace = this.requireWorkspace(principalId, workspaceId)
    const referenced = [...workspace.entries.values()].some(entry => entry.kind === 'file' && entry.hash === hash)
    if (!referenced) throw new WorkspaceError('BLOB_NOT_FOUND', 'blob is not referenced by this workspace', 404)
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new WorkspaceError('INVALID_REQUEST', 'blob hash is invalid')
    const bytes = await readFile(join(this.blobsDir, hash.slice(0, 2), hash))
    if (hashBytes(bytes) !== hash) throw new WorkspaceError('BLOB_CORRUPT', 'stored blob failed SHA-256 verification', 500)
    return bytes
  }

  validateChanges(changes) {
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_ENTRIES) {
      throw new WorkspaceError('INVALID_REQUEST', `changes must contain 1 through ${MAX_ENTRIES} entries`)
    }
    const seen = new Set()
    return changes.map(change => {
      assertRecord(change, 'change')
      const path = validatePath(change.path)
      if (seen.has(path)) throw new WorkspaceError('INVALID_REQUEST', `changes contain duplicate path ${path}`)
      seen.add(path)
      if (change.deleted === true) return { path, deleted: true }
      const mode = validateMode(change.mode)
      if (change.kind === 'directory') return { path, kind: 'directory', mode }
      if (change.kind !== 'file' || !/^[a-f0-9]{64}$/.test(change.hash)
        || !Number.isSafeInteger(change.bytes) || change.bytes < 0) {
        throw new WorkspaceError('INVALID_REQUEST', `file change for ${path} is invalid`)
      }
      return { path, kind: 'file', hash: change.hash, bytes: change.bytes, mode }
    }).sort((left, right) => left.path.localeCompare(right.path))
  }

  async commit(request, body) {
    assertProtocol(body)
    const principalId = this.principalFromRequest(request)
    const workspaceId = assertId(body.workspaceId, 'workspaceId')
    const operationId = assertId(body.operationId, 'operationId')
    if (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0) {
      throw new WorkspaceError('INVALID_REQUEST', 'baseRevision must be a non-negative safe integer')
    }
    const changes = this.validateChanges(body.changes)
    const operationDigest = hashBytes(Buffer.from(JSON.stringify({ baseRevision: body.baseRevision, changes })))
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.requireWorkspace(principalId, workspaceId)
      const prior = workspace.operations.get(operationId)
      if (prior !== undefined) {
        if (prior.digest !== operationDigest) throw new WorkspaceError('OPERATION_ID_REUSED', 'operationId was reused with different changes', 409)
        return { ...prior.receipt, replayed: true }
      }
      if (body.baseRevision !== workspace.revision) {
        throw new WorkspaceError('WORKSPACE_CONFLICT', 'workspace revision changed before commit', 409, {
          current: this.snapshot(workspace),
        })
      }
      for (const change of changes) {
        if (change.kind !== 'file') continue
        const referenced = [...workspace.entries.values()].some(entry => entry.kind === 'file' && entry.hash === change.hash)
        if (!referenced && !workspace.uploadedHashes.has(change.hash)) {
          throw new WorkspaceError('BLOB_FORBIDDEN', 'blob must be uploaded by this Workspace before commit', 403)
        }
        const blobPath = join(this.blobsDir, change.hash.slice(0, 2), change.hash)
        const blob = await readFile(blobPath).catch(error => {
          if (error?.code === 'ENOENT') throw new WorkspaceError('BLOB_MISSING', `blob ${change.hash} must be uploaded before commit`, 409)
          throw error
        })
        if (blob.byteLength !== change.bytes || hashBytes(blob) !== change.hash) {
          throw new WorkspaceError('BLOB_CORRUPT', `blob ${change.hash} failed size or hash verification`, 409)
        }
      }
      const entries = new Map(workspace.entries)
      for (const change of changes) {
        if (change.deleted) {
          for (const path of entries.keys()) {
            if (path === change.path || path.startsWith(`${change.path}/`)) entries.delete(path)
          }
          continue
        }
        const segments = change.path.split('/')
        for (let index = 1; index < segments.length; index += 1) {
          const parent = segments.slice(0, index).join('/')
          const existing = entries.get(parent)
          if (existing?.kind === 'file') throw new WorkspaceError('INVALID_PATH', `parent ${parent} is a file`)
          if (existing === undefined) entries.set(parent, { path: parent, kind: 'directory', mode: 0o755 })
        }
        for (const [path, existing] of entries) {
          if (path.startsWith(`${change.path}/`) && change.kind === 'file') {
            throw new WorkspaceError('INVALID_PATH', `file ${change.path} cannot replace a non-empty directory`)
          }
          if (path === change.path && existing.kind !== change.kind) {
            for (const descendant of entries.keys()) {
              if (descendant.startsWith(`${change.path}/`)) entries.delete(descendant)
            }
          }
        }
        entries.set(change.path, change.kind === 'directory'
          ? { path: change.path, kind: 'directory', mode: change.mode }
          : { path: change.path, kind: 'file', hash: change.hash, bytes: change.bytes, mode: change.mode })
      }
      if (entries.size > MAX_ENTRIES) throw new WorkspaceError('WORKSPACE_TOO_LARGE', `workspace exceeds ${MAX_ENTRIES} entries`, 413)
      const next = {
        ...workspace,
        revision: workspace.revision + 1,
        entries,
        operations: new Map(workspace.operations),
      }
      const receipt = {
        workspaceId,
        revision: next.revision,
        operationId,
        changedPaths: changes.map(change => change.path),
        digest: manifestDigest(entries),
      }
      next.operations.set(operationId, { digest: operationDigest, receipt })
      await this.persistWorkspace(next)
      this.workspaces.set(workspaceId, next)
      return { ...receipt, replayed: false }
    })
  }
}
