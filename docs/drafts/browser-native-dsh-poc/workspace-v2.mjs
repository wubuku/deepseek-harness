import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const COOKIE_NAME = 'dsh-browser-native-principal'
const COOKIE_MAX_AGE_SECONDS = 31_536_000
const MAX_ENTRIES = 2_000
const MAX_PATH_LENGTH = 512
const DEFAULT_WRITER_LEASE_MS = 30_000
export const WORKSPACE_BLOB_CHUNK_BYTES = 1024 * 1024
const MAX_WORKSPACE_BLOB_BYTES = 64 * 1024 * 1024
const UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1000

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

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function assertUploadIdentity(operationId, hash) {
  assertId(operationId, 'operationId')
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new WorkspaceError('INVALID_REQUEST', 'blob hash is invalid')
  }
}

function expectedChunkBytes(totalBytes, chunkIndex, chunkCount) {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount) {
    throw new WorkspaceError('INVALID_REQUEST', 'chunk index is invalid')
  }
  const start = chunkIndex * WORKSPACE_BLOB_CHUNK_BYTES
  return Math.min(WORKSPACE_BLOB_CHUNK_BYTES, totalBytes - start)
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
  constructor(dataDir, options = {}) {
    this.root = join(dataDir, 'workspace-v2')
    this.blobsDir = join(this.root, 'blobs')
    this.workspacesDir = join(this.root, 'workspaces')
    this.uploadsDir = join(this.root, 'uploads')
    this.identitiesPath = join(this.root, 'identities.json')
    this.identities = new Map()
    this.workspaces = new Map()
    this.locks = new Map()
    this.writerLeaseMs = options.writerLeaseMs ?? DEFAULT_WRITER_LEASE_MS
    if (!Number.isSafeInteger(this.writerLeaseMs) || this.writerLeaseMs < 300) {
      throw new TypeError('workspace writer lease must be an integer of at least 300 ms')
    }
  }

  async load() {
    await Promise.all([
      mkdir(this.blobsDir, { recursive: true }),
      mkdir(this.workspacesDir, { recursive: true }),
      mkdir(this.uploadsDir, { recursive: true }),
    ])
    await this.removeExpiredUploads()
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
      this.workspaces.set(workspaceId, {
        id: workspaceId,
        owner: raw.owner,
        revision: raw.revision,
        entries,
        operations,
        uploadedHashes,
        writerEpoch: Number.isSafeInteger(raw.writerEpoch) && raw.writerEpoch >= 0 ? raw.writerEpoch : 0,
        writerToken: undefined,
        writerExpiresAt: 0,
      })
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
      writerEpoch: workspace.writerEpoch,
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
          writerEpoch: 0, writerToken: undefined, writerExpiresAt: 0,
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
    const cookie = `${COOKIE_NAME}=${principalId}; Path=/api/browser-native/workspace; Max-Age=${String(COOKIE_MAX_AGE_SECONDS)}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
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

  uploadDirectory(workspaceId, operationId, hash) {
    return join(this.uploadsDir, workspaceId, `${operationId}-${hash}`)
  }

  uploadMetadataPath(workspaceId, operationId, hash) {
    return join(this.uploadDirectory(workspaceId, operationId, hash), 'upload.json')
  }

  async removeExpiredUploads() {
    for (const workspace of await readdir(this.uploadsDir, { withFileTypes: true })) {
      if (!workspace.isDirectory() || !/^[0-9a-f-]{36}$/i.test(workspace.name)) continue
      const workspaceDirectory = join(this.uploadsDir, workspace.name)
      for (const upload of await readdir(workspaceDirectory, { withFileTypes: true })) {
        if (!upload.isDirectory()) continue
        const directory = join(workspaceDirectory, upload.name)
        try {
          const metadata = JSON.parse(await readFile(join(directory, 'upload.json'), 'utf8'))
          if (!Number.isSafeInteger(metadata.updatedAt) || Date.now() - metadata.updatedAt > UPLOAD_EXPIRY_MS) {
            await rm(directory, { recursive: true, force: true })
          }
        } catch (error) {
          if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
            await rm(directory, { recursive: true, force: true })
            continue
          }
          throw error
        }
      }
    }
  }

  async readUploadMetadata(workspaceId, operationId, hash) {
    try {
      const metadata = JSON.parse(await readFile(this.uploadMetadataPath(workspaceId, operationId, hash), 'utf8'))
      if (metadata.version !== 1 || metadata.workspaceId !== workspaceId || metadata.operationId !== operationId
        || metadata.hash !== hash || !Number.isSafeInteger(metadata.totalBytes)
        || !Number.isSafeInteger(metadata.chunkCount) || !Array.isArray(metadata.chunks)) {
        throw new WorkspaceError('UPLOAD_METADATA_INVALID', 'upload metadata is invalid', 500)
      }
      return metadata
    } catch (error) {
      if (error?.code === 'ENOENT') throw new WorkspaceError('UPLOAD_NOT_FOUND', 'blob upload does not exist', 404)
      throw error
    }
  }

  async startBlobUpload(request, input) {
    const principalId = this.principalFromRequest(request)
    const workspaceId = assertId(input.workspaceId, 'workspaceId')
    const operationId = input.operationId
    const hash = input.hash
    assertUploadIdentity(operationId, hash)
    if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 0 || input.totalBytes > MAX_WORKSPACE_BLOB_BYTES
      || input.chunkBytes !== WORKSPACE_BLOB_CHUNK_BYTES) {
      throw new WorkspaceError('UPLOAD_SIZE_UNSUPPORTED', 'blob size or chunk size is unsupported', 413, {
        maxBytes: MAX_WORKSPACE_BLOB_BYTES,
        chunkBytes: WORKSPACE_BLOB_CHUNK_BYTES,
      })
    }
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.requireWorkspace(principalId, workspaceId)
      if (workspace.uploadedHashes.has(hash)) {
        return { workspaceId, operationId, hash, complete: true, missing: [] }
      }
      const metadataPath = this.uploadMetadataPath(workspaceId, operationId, hash)
      const chunkCount = Math.ceil(input.totalBytes / WORKSPACE_BLOB_CHUNK_BYTES)
      let metadata
      try {
        metadata = await this.readUploadMetadata(workspaceId, operationId, hash)
      } catch (error) {
        if (!(error instanceof WorkspaceError) || error.code !== 'UPLOAD_NOT_FOUND') throw error
      }
      if (metadata !== undefined && (metadata.totalBytes !== input.totalBytes || metadata.chunkBytes !== input.chunkBytes
        || metadata.chunkCount !== chunkCount)) {
        throw new WorkspaceError('UPLOAD_ID_CONFLICT', 'upload id was reused with different blob metadata', 409)
      }
      if (metadata === undefined) {
        metadata = {
          version: 1,
          workspaceId,
          operationId,
          hash,
          totalBytes: input.totalBytes,
          chunkBytes: input.chunkBytes,
          chunkCount,
          chunks: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        await atomicWrite(metadataPath, JSON.stringify(metadata))
      }
      const missing = []
      for (let index = 0; index < chunkCount; index += 1) {
        if (metadata.chunks[index] === undefined) missing.push(index)
      }
      return { workspaceId, operationId, hash, complete: false, chunkBytes: metadata.chunkBytes, chunkCount, missing }
    })
  }

  async blobUploadStatus(request, workspaceId, operationId, hash) {
    const principalId = this.principalFromRequest(request)
    workspaceId = assertId(workspaceId, 'workspaceId')
    assertUploadIdentity(operationId, hash)
    const workspace = this.requireWorkspace(principalId, workspaceId)
    if (workspace.uploadedHashes.has(hash)) return { workspaceId, operationId, hash, complete: true, missing: [] }
    const metadata = await this.readUploadMetadata(workspaceId, operationId, hash)
    const missing = []
    for (let index = 0; index < metadata.chunkCount; index += 1) {
      const expectedDigest = metadata.chunks[index]
      if (expectedDigest === undefined) {
        missing.push(index)
        continue
      }
      const path = join(this.uploadDirectory(workspaceId, operationId, hash), `${String(index)}.part`)
      try {
        const info = await stat(path)
        if (info.size !== expectedChunkBytes(metadata.totalBytes, index, metadata.chunkCount)
          || await hashFile(path) !== expectedDigest) missing.push(index)
      } catch (error) {
        if (error?.code === 'ENOENT') missing.push(index)
        else throw error
      }
    }
    return { workspaceId, operationId, hash, complete: false, chunkBytes: metadata.chunkBytes, chunkCount: metadata.chunkCount, missing }
  }

  async putBlobChunk(request, workspaceId, operationId, hash, chunkIndex, bytes, chunkHash) {
    const principalId = this.principalFromRequest(request)
    workspaceId = assertId(workspaceId, 'workspaceId')
    assertUploadIdentity(operationId, hash)
    if (typeof chunkHash !== 'string' || !/^[a-f0-9]{64}$/.test(chunkHash) || hashBytes(bytes) !== chunkHash) {
      throw new WorkspaceError('UPLOAD_CHUNK_HASH_MISMATCH', 'uploaded chunk does not match its SHA-256 hash')
    }
    return await this.exclusive(workspaceId, async () => {
      this.requireWorkspace(principalId, workspaceId)
      const metadata = await this.readUploadMetadata(workspaceId, operationId, hash)
      const expectedBytes = expectedChunkBytes(metadata.totalBytes, chunkIndex, metadata.chunkCount)
      if (bytes.byteLength !== expectedBytes) throw new WorkspaceError('UPLOAD_CHUNK_SIZE_MISMATCH', 'uploaded chunk has an invalid byte length')
      const directory = this.uploadDirectory(workspaceId, operationId, hash)
      const path = join(directory, `${String(chunkIndex)}.part`)
      const previousHash = metadata.chunks[chunkIndex]
      if (previousHash !== undefined) {
        if (previousHash !== chunkHash) {
          throw new WorkspaceError('UPLOAD_CHUNK_CONFLICT', 'chunk index was already stored with different content', 409)
        }
        try {
          const previous = await readFile(path)
          if (previous.equals(bytes)) {
            return { workspaceId, operationId, hash, chunkIndex, chunkHash, replayed: true }
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
      await atomicWrite(path, bytes)
      const chunks = [...metadata.chunks]
      chunks[chunkIndex] = chunkHash
      await atomicWrite(this.uploadMetadataPath(workspaceId, operationId, hash), JSON.stringify({
        ...metadata,
        chunks,
        updatedAt: Date.now(),
      }))
      return { workspaceId, operationId, hash, chunkIndex, chunkHash, replayed: false }
    })
  }

  async completeBlobUpload(request, workspaceId, operationId, hash) {
    const principalId = this.principalFromRequest(request)
    workspaceId = assertId(workspaceId, 'workspaceId')
    assertUploadIdentity(operationId, hash)
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.requireWorkspace(principalId, workspaceId)
      if (workspace.uploadedHashes.has(hash)) return { workspaceId, operationId, hash, complete: true, replayed: true }
      const metadata = await this.readUploadMetadata(workspaceId, operationId, hash)
      if (metadata.chunks.length !== metadata.chunkCount || metadata.chunks.some(chunk => typeof chunk !== 'string')) {
        throw new WorkspaceError('UPLOAD_INCOMPLETE', 'blob upload is missing one or more chunks', 409)
      }
      const target = join(this.blobsDir, hash.slice(0, 2), hash)
      let reused = false
      try {
        const existing = await stat(target)
        if (existing.size !== metadata.totalBytes || await hashFile(target) !== hash) {
          throw new WorkspaceError('BLOB_CORRUPT', 'stored blob failed size or SHA-256 verification', 500)
        }
        reused = true
      } catch (error) {
        if (error instanceof WorkspaceError || error?.code !== 'ENOENT') throw error
        const temporary = `${target}.${randomUUID()}.upload`
        await mkdir(dirname(target), { recursive: true })
        const output = await open(temporary, 'wx', 0o600)
        const digest = createHash('sha256')
        let totalBytes = 0
        try {
          for (let index = 0; index < metadata.chunkCount; index += 1) {
            const chunk = await readFile(join(this.uploadDirectory(workspaceId, operationId, hash), `${String(index)}.part`))
            const expectedBytes = expectedChunkBytes(metadata.totalBytes, index, metadata.chunkCount)
            if (chunk.byteLength !== expectedBytes || hashBytes(chunk) !== metadata.chunks[index]) {
              throw new WorkspaceError('UPLOAD_CHUNK_CORRUPT', `stored chunk ${String(index)} failed validation`, 409)
            }
            digest.update(chunk)
            totalBytes += chunk.byteLength
            await output.writeFile(chunk)
          }
          await output.sync()
        } catch (error) {
          await output.close()
          await rm(temporary, { force: true })
          throw error
        }
        await output.close()
        if (totalBytes !== metadata.totalBytes || digest.digest('hex') !== hash) {
          await rm(temporary, { force: true })
          throw new WorkspaceError('UPLOAD_BLOB_HASH_MISMATCH', 'assembled blob does not match its declared size or SHA-256 hash', 409)
        }
        await rename(temporary, target)
        const directory = await open(dirname(target), 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
      const next = { ...workspace, uploadedHashes: new Set(workspace.uploadedHashes).add(hash) }
      await this.persistWorkspace(next)
      this.workspaces.set(workspaceId, next)
      await rm(this.uploadDirectory(workspaceId, operationId, hash), { recursive: true, force: true })
      return { workspaceId, operationId, hash, complete: true, reused, replayed: false }
    })
  }

  async getBlobChunk(request, workspaceId, hash, chunkIndex) {
    const principalId = this.principalFromRequest(request)
    const workspace = this.requireWorkspace(principalId, workspaceId)
    const referenced = [...workspace.entries.values()].some(entry => entry.kind === 'file' && entry.hash === hash)
    if (!referenced) throw new WorkspaceError('BLOB_NOT_FOUND', 'blob is not referenced by this workspace', 404)
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new WorkspaceError('INVALID_REQUEST', 'blob hash is invalid')
    const path = join(this.blobsDir, hash.slice(0, 2), hash)
    const info = await stat(path)
    const chunkCount = Math.ceil(info.size / WORKSPACE_BLOB_CHUNK_BYTES)
    const bytesInChunk = expectedChunkBytes(info.size, chunkIndex, chunkCount)
    const buffer = Buffer.alloc(bytesInChunk)
    const handle = await open(path, 'r')
    try {
      const { bytesRead } = await handle.read(buffer, 0, bytesInChunk, chunkIndex * WORKSPACE_BLOB_CHUNK_BYTES)
      if (bytesRead !== bytesInChunk) throw new WorkspaceError('BLOB_CORRUPT', 'stored blob chunk is truncated', 500)
    } finally {
      await handle.close()
    }
    return { bytes: buffer, chunkHash: hashBytes(buffer), chunkIndex, chunkCount, totalBytes: info.size }
  }

  async lease(request, body) {
    const principalId = this.principalFromRequest(request)
    const workspaceId = assertId(body.workspaceId, 'workspaceId')
    const operation = body.operation
    if (!['claim', 'renew', 'release', 'resume'].includes(operation)) {
      throw new WorkspaceError('INVALID_REQUEST', 'workspace lease operation is invalid')
    }
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.requireWorkspace(principalId, workspaceId)
      const now = Date.now()
      if (operation === 'release') {
        this.assertWriter(workspace, body.writerToken, body.fencingToken)
        workspace.writerToken = undefined
        workspace.writerExpiresAt = 0
        workspace.lastResume = undefined
        return { workspaceId, released: true, fencingToken: workspace.writerEpoch }
      }
      if (operation === 'resume') {
        assertId(body.resumeId, 'resumeId')
        const previousResume = workspace.lastResume
        if (previousResume?.resumeId === body.resumeId
          && previousResume.writerToken === workspace.writerToken
          && previousResume.fencingToken === workspace.writerEpoch
          && workspace.writerExpiresAt > now) {
          return structuredClone(previousResume.lease)
        }
        this.assertWriter(workspace, body.writerToken, body.fencingToken)
        const next = {
          ...workspace,
          writerEpoch: workspace.writerEpoch + 1,
          writerToken: randomUUID(),
          writerExpiresAt: now + this.writerLeaseMs,
        }
        const lease = this.writerLease(next)
        next.lastResume = {
          resumeId: body.resumeId,
          writerToken: next.writerToken,
          fencingToken: next.writerEpoch,
          lease,
        }
        await this.persistWorkspace(next)
        this.workspaces.set(workspaceId, next)
        return lease
      }
      if (operation === 'renew') {
        this.assertWriter(workspace, body.writerToken, body.fencingToken)
        workspace.writerExpiresAt = now + this.writerLeaseMs
        return this.writerLease(workspace)
      }
      if (workspace.writerToken !== undefined && workspace.writerExpiresAt > now) {
        throw new WorkspaceError(
          'WORKSPACE_ALREADY_OWNED',
          'Workspace is already owned by another browser writer',
          409,
          { retryAfterMs: workspace.writerExpiresAt - now },
        )
      }
      const next = {
        ...workspace,
        writerEpoch: workspace.writerEpoch + 1,
        writerToken: randomUUID(),
        writerExpiresAt: now + this.writerLeaseMs,
        lastResume: undefined,
      }
      await this.persistWorkspace(next)
      this.workspaces.set(workspaceId, next)
      return this.writerLease(next)
    })
  }

  writerLease(workspace) {
    return {
      workspaceId: workspace.id,
      writerToken: workspace.writerToken,
      fencingToken: workspace.writerEpoch,
      leaseDurationMs: this.writerLeaseMs,
      renewAfterMs: Math.floor(this.writerLeaseMs / 3),
    }
  }

  assertWriter(workspace, writerToken, fencingToken) {
    if (typeof writerToken !== 'string' || writerToken !== workspace.writerToken
      || fencingToken !== workspace.writerEpoch || workspace.writerExpiresAt <= Date.now()) {
      throw new WorkspaceError('WORKSPACE_OWNERSHIP_LOST', 'Workspace writer lease is no longer valid', 409)
    }
  }

  operation(request, workspaceId, operationId) {
    const principalId = this.principalFromRequest(request)
    const workspace = this.requireWorkspace(principalId, workspaceId)
    assertId(operationId, 'operationId')
    const operation = workspace.operations.get(operationId)
    return operation === undefined
      ? { workspaceId, operationId, found: false }
      : { workspaceId, operationId, found: true, receipt: structuredClone(operation.receipt) }
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
      if (body.writerToken !== undefined || body.fencingToken !== undefined) {
        this.assertWriter(workspace, body.writerToken, body.fencingToken)
      }
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
        const blobInfo = await stat(blobPath).catch(error => {
          if (error?.code === 'ENOENT') throw new WorkspaceError('BLOB_MISSING', `blob ${change.hash} must be uploaded before commit`, 409)
          throw error
        })
        if (blobInfo.size !== change.bytes || await hashFile(blobPath) !== change.hash) {
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
