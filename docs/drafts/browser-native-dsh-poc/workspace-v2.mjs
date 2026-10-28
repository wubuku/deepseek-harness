import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ChunkObjectWorkspaceBlobStore } from './chunk-object-store.mjs'

const COOKIE_NAME = 'dsh-browser-native-principal'
const SESSION_COOKIE_NAME = 'dsh-browser-native-session-principal'
const COOKIE_MAX_AGE_SECONDS = 31_536_000
const MAX_ENTRIES = 2_000
const MAX_PATH_LENGTH = 512
const DEFAULT_WRITER_LEASE_MS = 30_000
export const WORKSPACE_BLOB_CHUNK_BYTES = 1024 * 1024
export const WORKSPACE_CONTENT_LAYOUT = Object.freeze({
  version: 1,
  algorithm: 'dsh-gear-v1',
  minimumBytes: 32768,
  averageBytes: 131072,
  maximumBytes: WORKSPACE_BLOB_CHUNK_BYTES,
  maxChunks: 2048,
})
const MAX_WORKSPACE_BLOB_BYTES = 64 * 1024 * 1024
const UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class WorkspaceError extends Error {
  constructor(code, message, status = 400, details) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
    this.status = status
    this.details = details
  }
}

class FileWorkspaceBlobStore {
  constructor(root) {
    this.root = root
  }

  async initialize() {
    await mkdir(this.root, { recursive: true })
  }

  path(hash) {
    return join(this.root, hash.slice(0, 2), hash)
  }

  async stat(hash) {
    try {
      const info = await stat(this.path(hash))
      return { size: info.size }
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  async get(hash) {
    return await readFile(this.path(hash))
  }

  async verify(hash, expectedBytes) {
    const info = await this.stat(hash)
    return info !== undefined && info.size === expectedBytes && await hashFile(this.path(hash)) === hash
  }

  async getRange(hash, offset, length) {
    const buffer = Buffer.alloc(length)
    const handle = await open(this.path(hash), 'r')
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  async put(hash, bytes) {
    const existing = await this.stat(hash)
    if (existing !== undefined) {
      const stored = await this.get(hash)
      if (existing.size !== bytes.byteLength || !stored.equals(bytes) || hashBytes(stored) !== hash) {
        throw new WorkspaceError('BLOB_CORRUPT', 'stored blob failed size or SHA-256 verification', 500)
      }
      return { reused: true }
    }
    await atomicWrite(this.path(hash), bytes)
    return { reused: false }
  }

  async putFile(hash, sourcePath, byteLength) {
    const existing = await this.stat(hash)
    if (existing !== undefined) {
      if (existing.size !== byteLength || !await this.verify(hash, byteLength)) {
        throw new WorkspaceError('BLOB_CORRUPT', 'stored blob failed size or SHA-256 verification', 500)
      }
      return { reused: true }
    }
    const target = this.path(hash)
    await mkdir(dirname(target), { recursive: true })
    await rename(sourcePath, target)
    const directory = await open(dirname(target), 'r')
    try { await directory.sync() } finally { await directory.close() }
    return { reused: false }
  }

  async listHashes() {
    const hashes = []
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{2}$/.test(entry.name)) continue
      for (const blob of await readdir(join(this.root, entry.name), { withFileTypes: true })) {
        if (blob.isFile() && /^[a-f0-9]{64}$/.test(blob.name)) hashes.push(blob.name)
      }
    }
    return hashes
  }

  async delete(hash) {
    await rm(this.path(hash), { force: true })
  }
}

function assertRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceError('INVALID_REQUEST', `${label} must be an object`)
  }
  return value
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function metadataRecord(value, label) {
  if (!isRecord(value)) throw new WorkspaceError('WORKSPACE_METADATA_INVALID', `${label} is invalid`, 500)
  return value
}

function metadataKeys(value, required, optional, label, code = 'WORKSPACE_METADATA_INVALID') {
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) {
    throw new WorkspaceError(code, `${label} has missing or unknown fields`, 500)
  }
}

function assertId(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
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

async function hashFile(path, io) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
    if (io !== undefined) io.bytes += chunk.byteLength
  }
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

function validateContentLayout(value, totalBytes) {
  assertRecord(value, 'layout')
  const fields = ['version', 'algorithm', 'minimumBytes', 'averageBytes', 'maximumBytes', 'chunks']
  if (fields.some(field => !Object.hasOwn(value, field)) || Object.keys(value).some(field => !fields.includes(field))) {
    throw new WorkspaceError('CONTENT_LAYOUT_INVALID', 'layout has missing or unknown fields')
  }
  for (const field of fields.filter(field => field !== 'chunks')) {
    if (value[field] !== WORKSPACE_CONTENT_LAYOUT[field]) {
      throw new WorkspaceError('CONTENT_LAYOUT_UNSUPPORTED', `unsupported layout ${field}`)
    }
  }
  if (!Array.isArray(value.chunks) || value.chunks.length > WORKSPACE_CONTENT_LAYOUT.maxChunks) {
    throw new WorkspaceError('CONTENT_LAYOUT_INVALID', 'layout contains too many chunks')
  }
  let offset = 0
  const chunks = value.chunks.map((chunk, index) => {
    if (!isRecord(chunk) || Object.keys(chunk).length !== 3
      || !Number.isSafeInteger(chunk.offset) || chunk.offset !== offset
      || !Number.isSafeInteger(chunk.length) || chunk.length < 1 || chunk.length > WORKSPACE_CONTENT_LAYOUT.maximumBytes
      || index < value.chunks.length - 1 && chunk.length < WORKSPACE_CONTENT_LAYOUT.minimumBytes
      || typeof chunk.hash !== 'string' || !/^[a-f0-9]{64}$/.test(chunk.hash)
      || chunk.offset + chunk.length > totalBytes) {
      throw new WorkspaceError('CONTENT_LAYOUT_INVALID', 'layout chunks must be bounded contiguous SHA-256 ranges')
    }
    offset += chunk.length
    return { offset: chunk.offset, length: chunk.length, hash: chunk.hash }
  })
  if (offset !== totalBytes) throw new WorkspaceError('CONTENT_LAYOUT_INVALID', 'layout does not cover the complete file')
  return { version: value.version, algorithm: value.algorithm, minimumBytes: value.minimumBytes,
    averageBytes: value.averageBytes, maximumBytes: value.maximumBytes, chunks }
}

function uploadChunkRange(metadata, chunkIndex) {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= metadata.chunkCount) {
    throw new WorkspaceError('INVALID_REQUEST', 'chunk index is invalid')
  }
  return metadata.layout === undefined
    ? { offset: chunkIndex * WORKSPACE_BLOB_CHUNK_BYTES, length: expectedChunkBytes(metadata.totalBytes, chunkIndex, metadata.chunkCount) }
    : metadata.layout.chunks[chunkIndex]
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

function validateLoadedEntry(value, workspaceId) {
  const entry = metadataRecord(value, `Workspace ${workspaceId} manifest entry`)
  try {
    if (entry.kind === 'directory') metadataKeys(entry, ['path', 'kind', 'mode'], [], `Workspace ${workspaceId} directory`)
    else if (entry.kind === 'file') metadataKeys(entry, ['path', 'kind', 'hash', 'bytes', 'mode'], [], `Workspace ${workspaceId} file`)
    else throw new Error('entry kind is invalid')
    const path = validatePath(entry.path)
    if (entry.kind === 'directory') return { path, kind: 'directory', mode: validateMode(entry.mode) }
    if (!/^[a-f0-9]{64}$/.test(entry.hash)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error('file entry fields are invalid')
    }
    return { path, kind: 'file', hash: entry.hash, bytes: entry.bytes, mode: validateMode(entry.mode) }
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === 'WORKSPACE_METADATA_INVALID') throw error
    throw new WorkspaceError('WORKSPACE_METADATA_INVALID', `Workspace ${workspaceId} contains an invalid manifest entry`, 500, { cause: error })
  }
}

function validateLoadedOperation(value, workspaceId, operationId, currentRevision) {
  const operation = metadataRecord(value, `Workspace ${workspaceId} operation`)
  metadataKeys(operation, ['digest', 'receipt'], [], `Workspace ${workspaceId} operation`)
  if (!/^[a-f0-9]{64}$/.test(operation.digest) || !isRecord(operation.receipt)) {
    throw new WorkspaceError('WORKSPACE_METADATA_INVALID', `Workspace ${workspaceId} contains an invalid operation`, 500)
  }
  const receipt = operation.receipt
  metadataKeys(receipt, ['workspaceId', 'revision', 'operationId', 'changedPaths', 'digest'], [], `Workspace ${workspaceId} operation receipt`)
  if (receipt.workspaceId !== workspaceId || receipt.operationId !== operationId
    || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || receipt.revision > currentRevision
    || !Array.isArray(receipt.changedPaths) || receipt.changedPaths.length === 0 || receipt.changedPaths.length > MAX_ENTRIES
    || new Set(receipt.changedPaths).size !== receipt.changedPaths.length || receipt.changedPaths.some(path => {
      try { validatePath(path); return false } catch { return true }
    }) || !/^[a-f0-9]{64}$/.test(receipt.digest)) {
    throw new WorkspaceError('WORKSPACE_METADATA_INVALID', `Workspace ${workspaceId} contains an invalid operation receipt`, 500)
  }
  return { digest: operation.digest, receipt: structuredClone(receipt) }
}

function validateLoadedWorkspace(raw, workspaceId) {
  if (!isRecord(raw)) throw new WorkspaceError('WORKSPACE_METADATA_INVALID', `Workspace ${workspaceId} metadata is invalid`, 500)
  metadataKeys(raw, ['version', 'id', 'owner', 'revision', 'entries'], ['operations', 'uploadedHashes', 'uploadedAt', 'writerEpoch'], `Workspace ${workspaceId} metadata`)
  if (!UUID_PATTERN.test(workspaceId) || raw.version !== 1 || raw.id !== workspaceId || !UUID_PATTERN.test(raw.owner)
    || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !Array.isArray(raw.entries)
    || raw.entries.length > MAX_ENTRIES) {
    throw new WorkspaceError('WORKSPACE_METADATA_INVALID', `Workspace ${workspaceId} metadata is invalid`, 500)
  }
  const entries = new Map()
  for (const rawEntry of raw.entries) {
    const entry = validateLoadedEntry(rawEntry, workspaceId)
    if (entries.has(entry.path)) throw new WorkspaceError('WORKSPACE_METADATA_INVALID', `Workspace ${workspaceId} contains a duplicate path`, 500)
    entries.set(entry.path, entry)
  }
  for (const entry of entries.values()) {
    const segments = entry.path.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      const parent = entries.get(segments.slice(0, index).join('/'))
      if (parent?.kind !== 'directory') throw new WorkspaceError('WORKSPACE_METADATA_INVALID', `Workspace ${workspaceId} has a missing or non-directory parent`, 500)
    }
  }
  const operations = new Map()
  if (raw.operations !== undefined) {
    const rawOperations = metadataRecord(raw.operations, `Workspace ${workspaceId} operations`)
    for (const [operationId, operation] of Object.entries(rawOperations)) {
      if (!UUID_PATTERN.test(operationId)) throw new WorkspaceError('WORKSPACE_METADATA_INVALID', `Workspace ${workspaceId} has an invalid operation id`, 500)
      operations.set(operationId, validateLoadedOperation(operation, workspaceId, operationId, raw.revision))
    }
  }
  const uploadedHashes = new Set()
  if (raw.uploadedHashes !== undefined && !Array.isArray(raw.uploadedHashes)) {
    throw new WorkspaceError('WORKSPACE_METADATA_INVALID', `Workspace ${workspaceId} pending uploads are invalid`, 500)
  }
  for (const hash of raw.uploadedHashes ?? []) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new WorkspaceError('WORKSPACE_METADATA_INVALID', `Workspace ${workspaceId} has an invalid pending upload hash`, 500)
    if (uploadedHashes.has(hash)) throw new WorkspaceError('WORKSPACE_METADATA_INVALID', `Workspace ${workspaceId} has a duplicate pending upload hash`, 500)
    uploadedHashes.add(hash)
  }
  const uploadedAt = new Map()
  if (raw.uploadedAt !== undefined) {
    const timestamps = metadataRecord(raw.uploadedAt, `Workspace ${workspaceId} upload timestamps`)
    for (const [hash, timestamp] of Object.entries(timestamps)) {
      if (!uploadedHashes.has(hash) || !Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new WorkspaceError('WORKSPACE_METADATA_INVALID', `Workspace ${workspaceId} has an invalid pending upload timestamp`, 500)
      }
      uploadedAt.set(hash, timestamp)
    }
  }
  const writerEpoch = raw.writerEpoch === undefined ? 0 : raw.writerEpoch
  if (!Number.isSafeInteger(writerEpoch) || writerEpoch < 0) {
    throw new WorkspaceError('WORKSPACE_METADATA_INVALID', `Workspace ${workspaceId} has an invalid writer epoch`, 500)
  }
  return { entries, operations, uploadedHashes, uploadedAt, owner: raw.owner, revision: raw.revision, writerEpoch }
}

function validateLoadedIdentities(raw) {
  if (!isRecord(raw)) {
    throw new WorkspaceError('IDENTITY_METADATA_INVALID', 'Workspace identity metadata is invalid', 500)
  }
  metadataKeys(raw, ['version', 'identities'], [], 'Workspace identity metadata', 'IDENTITY_METADATA_INVALID')
  if (raw.version !== 1 || !Array.isArray(raw.identities)) throw new WorkspaceError('IDENTITY_METADATA_INVALID', 'Workspace identity metadata is invalid', 500)
  const identities = new Map()
  const workspaces = new Set()
  for (const value of raw.identities) {
    if (!isRecord(value)) throw new WorkspaceError('IDENTITY_METADATA_INVALID', 'Workspace identity record is invalid', 500)
    metadataKeys(value, ['principalId', 'workspaceId'], [], 'Workspace identity record', 'IDENTITY_METADATA_INVALID')
    if (!UUID_PATTERN.test(value.principalId)
      || !UUID_PATTERN.test(value.workspaceId) || identities.has(value.principalId)
      || workspaces.has(value.workspaceId)) {
      throw new WorkspaceError('IDENTITY_METADATA_INVALID', 'Workspace identity record is invalid', 500)
    }
    identities.set(value.principalId, value.workspaceId)
    workspaces.add(value.workspaceId)
  }
  return identities
}

function isValidUploadMetadata(value, workspaceId, operationId, hash) {
  const fields = ['version', 'workspaceId', 'operationId', 'hash', 'totalBytes', 'chunkBytes', 'chunkCount', 'chunks', 'createdAt', 'updatedAt']
  let layout
  if (isRecord(value) && Object.hasOwn(value, 'layout')) {
    try {
      layout = validateContentLayout(value.layout, value.totalBytes)
    } catch (error) {
      if (error instanceof WorkspaceError) return false
      throw error
    }
  }
  return isRecord(value)
    && Object.keys(value).every(field => fields.includes(field) || field === 'reuse' || field === 'layout' || field === 'completed')
    && fields.every(field => Object.hasOwn(value, field))
    && value.version === 1
    && value.workspaceId === workspaceId
    && value.operationId === operationId
    && value.hash === hash
    && Number.isSafeInteger(value.totalBytes) && value.totalBytes >= 0 && value.totalBytes <= MAX_WORKSPACE_BLOB_BYTES
    && value.chunkBytes === WORKSPACE_BLOB_CHUNK_BYTES
    && value.chunkCount === (layout === undefined ? Math.ceil(value.totalBytes / WORKSPACE_BLOB_CHUNK_BYTES) : layout.chunks.length)
    && Array.isArray(value.chunks) && value.chunks.length <= value.chunkCount
    && value.chunks.every(chunkHash => chunkHash === null || typeof chunkHash === 'string' && /^[a-f0-9]{64}$/.test(chunkHash))
    && (layout === undefined || value.chunks.every((chunkHash, index) => chunkHash === null || chunkHash === layout.chunks[index].hash))
    && (value.reuse === undefined || isValidReusePlan(value.reuse, value.chunkCount))
    && (layout === undefined || value.reuse === undefined || value.reuse.chunkHashes.every((hash, index) => hash === layout.chunks[index].hash))
    && (!Object.hasOwn(value, 'completed') || value.completed === true && layout !== undefined
      && value.chunks.length === value.chunkCount && value.chunks.every(hash => typeof hash === 'string'))
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0
}

function isValidReusePlan(value, chunkCount) {
  return isRecord(value) && Object.keys(value).length === 2
    && typeof value.baseHash === 'string' && /^[a-f0-9]{64}$/.test(value.baseHash)
    && Array.isArray(value.chunkHashes) && value.chunkHashes.length === chunkCount
    && value.chunkHashes.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
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
    this.layoutsDir = join(this.root, 'layouts')
    if (options.chunkObjects === true && options.blobStore !== undefined) {
      throw new WorkspaceError('CHUNK_STORE_CONFIGURATION', 'chunk objects cannot wrap an external blob store')
    }
    this.chunkObjects = options.chunkObjects === true
      ? new ChunkObjectWorkspaceBlobStore(join(this.root, 'chunk-objects'), new FileWorkspaceBlobStore(this.blobsDir))
      : undefined
    this.blobStore = this.chunkObjects ?? options.blobStore ?? new FileWorkspaceBlobStore(this.blobsDir)
    this.identitiesPath = join(this.root, 'identities.json')
    this.identities = new Map()
    this.workspaces = new Map()
    this.locks = new Map()
    this.writerLeaseMs = options.writerLeaseMs ?? DEFAULT_WRITER_LEASE_MS
    this.now = options.now ?? (() => Date.now())
    this.pendingUploadTtlMs = options.pendingUploadTtlMs ?? UPLOAD_EXPIRY_MS
    if (!Number.isSafeInteger(this.writerLeaseMs) || this.writerLeaseMs < 300) {
      throw new TypeError('workspace writer lease must be an integer of at least 300 ms')
    }
    if (!Number.isSafeInteger(this.pendingUploadTtlMs) || this.pendingUploadTtlMs < 1_000) {
      throw new TypeError('pending upload TTL must be an integer of at least 1000 ms')
    }
  }

  async load() {
    if (this.chunkObjects === undefined) {
      try {
        await stat(join(this.root, 'chunk-objects'))
        throw new WorkspaceError('CHUNK_STORE_REQUIRED', 'this dataDir requires workspaceChunkObjects: true', 500)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    await Promise.all([
      mkdir(this.workspacesDir, { recursive: true }),
      mkdir(this.uploadsDir, { recursive: true }),
      mkdir(this.layoutsDir, { recursive: true }),
      this.blobStore.initialize(),
    ])
    try {
      const raw = JSON.parse(await readFile(this.identitiesPath, 'utf8'))
      this.identities = validateLoadedIdentities(raw)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    for (const entry of await readdir(this.workspacesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const workspaceId = entry.name.slice(0, -'.json'.length)
      const raw = JSON.parse(await readFile(join(this.workspacesDir, entry.name), 'utf8'))
      const validated = validateLoadedWorkspace(raw, workspaceId)
      this.workspaces.set(workspaceId, {
        id: workspaceId,
        owner: validated.owner,
        revision: validated.revision,
        entries: validated.entries,
        operations: validated.operations,
        uploadedHashes: validated.uploadedHashes,
        uploadedAt: validated.uploadedAt,
        writerEpoch: validated.writerEpoch,
        writerToken: undefined,
        writerExpiresAt: 0,
      })
    }
    for (const [principalId, workspaceId] of this.identities) {
      const workspace = this.workspaces.get(workspaceId)
      if (workspace === undefined || workspace.owner !== principalId) {
        throw new WorkspaceError('IDENTITY_METADATA_INVALID', 'Workspace identity references missing or foreign metadata', 500)
      }
    }
    await this.removeExpiredUploads(this.now())
  }

  async exclusiveKey(id, operation) {
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

  async exclusive(id, operation) {
    return await this.exclusiveKey('blob-lifecycle', async () => await this.exclusiveKey(id, operation))
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
      uploadedAt: Object.fromEntries([...workspace.uploadedAt].sort(([left], [right]) => left.localeCompare(right))),
      writerEpoch: workspace.writerEpoch,
    }
    await atomicWrite(this.workspacePath(workspace.id), JSON.stringify(value))
  }

  principalFromRequest(request, cookieName = COOKIE_NAME) {
    const principalId = parseCookies(request.headers.cookie).get(cookieName)
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
          entries: new Map(), operations: new Map(), uploadedHashes: new Set(), uploadedAt: new Map(),
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
    const cookieOptions = `Max-Age=${String(COOKIE_MAX_AGE_SECONDS)}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
    return {
      workspaceId,
      cookies: [
        `${COOKIE_NAME}=${principalId}; Path=/api/browser-native/workspace; ${cookieOptions}`,
        `${SESSION_COOKIE_NAME}=${principalId}; Path=/api/browser-native/session; ${cookieOptions}`,
      ],
    }
  }

  lookupIdentity(request) {
    const principalId = parseCookies(request.headers.cookie).get(COOKIE_NAME)
    const workspaceId = principalId === undefined ? undefined : this.identities.get(principalId)
    if (workspaceId === undefined) {
      throw new WorkspaceError('UNAUTHENTICATED', 'existing workspace identity is missing or expired', 401)
    }
    return { workspaceId }
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

  revision(request, workspaceId) {
    const principalId = this.principalFromRequest(request)
    const workspace = this.requireWorkspace(principalId, workspaceId)
    return { workspaceId: workspace.id, revision: workspace.revision }
  }

  async validateExecutionHandoff(request, { workspaceId, writerToken, fencingToken, revision }) {
    const principalId = this.principalFromRequest(request, SESSION_COOKIE_NAME)
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1
      || !Number.isSafeInteger(revision) || revision < 0) {
      throw new WorkspaceError('CHECKPOINT_INVALID', 'Workspace handoff cursors are invalid', 400)
    }
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.requireWorkspace(principalId, workspaceId)
      this.assertWriter(workspace, writerToken, fencingToken)
      if (workspace.revision !== revision) {
        throw new WorkspaceError('WORKSPACE_REVISION_CONFLICT', 'Workspace revision changed before Session handoff', 409)
      }
      workspace.writerExpiresAt = this.now() + this.writerLeaseMs
      return this.writerLease(workspace)
    })
  }

  async putBlob(request, workspaceId, hash, bytes) {
    const principalId = this.principalFromRequest(request)
    this.requireWorkspace(principalId, workspaceId)
    if (!/^[a-f0-9]{64}$/.test(hash) || hashBytes(bytes) !== hash) {
      throw new WorkspaceError('BLOB_HASH_MISMATCH', 'uploaded bytes do not match the requested SHA-256 hash')
    }
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.requireWorkspace(principalId, workspaceId)
      const stored = await this.blobStore.put(hash, bytes)
      if (!workspace.uploadedHashes.has(hash)) {
        const next = {
          ...workspace,
          uploadedHashes: new Set(workspace.uploadedHashes).add(hash),
          uploadedAt: new Map(workspace.uploadedAt).set(hash, this.now()),
        }
        await this.persistWorkspace(next)
        this.workspaces.set(workspaceId, next)
      }
      return { hash, bytes: bytes.byteLength, reused: stored.reused }
    })
  }

  uploadDirectory(workspaceId, operationId, hash) {
    return join(this.uploadsDir, workspaceId, `${operationId}-${hash}`)
  }

  uploadMetadataPath(workspaceId, operationId, hash) {
    return join(this.uploadDirectory(workspaceId, operationId, hash), 'upload.json')
  }

  contentLayoutPath(workspaceId, hash) {
    return join(this.layoutsDir, workspaceId, `${hash}.json`)
  }

  async readContentLayout(workspaceId, hash, totalBytes) {
    let value
    try {
      value = JSON.parse(await readFile(this.contentLayoutPath(workspaceId, hash), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') throw new WorkspaceError('CONTENT_LAYOUT_UNAVAILABLE', 'blob has no verified content layout', 404)
      if (error instanceof SyntaxError) throw new WorkspaceError('CONTENT_LAYOUT_CORRUPT', 'stored content layout is invalid', 500)
      throw error
    }
    try {
      if (!isRecord(value) || Object.keys(value).length !== 5 || value.version !== 1
        || value.workspaceId !== workspaceId || value.hash !== hash || value.totalBytes !== totalBytes) {
        throw new WorkspaceError('CONTENT_LAYOUT_CORRUPT', 'stored content layout identity is invalid', 500)
      }
      return validateContentLayout(value.layout, totalBytes)
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error
      throw new WorkspaceError('CONTENT_LAYOUT_CORRUPT', 'stored content layout failed validation', 500)
    }
  }

  async getContentLayout(request, workspaceId, hash) {
    const principalId = this.principalFromRequest(request)
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.requireWorkspace(principalId, workspaceId)
      const entry = [...workspace.entries.values()].find(entry => entry.kind === 'file' && entry.hash === hash)
      if (entry === undefined) throw new WorkspaceError('BLOB_NOT_FOUND', 'blob is not referenced by this Workspace', 404)
      return { layout: await this.readContentLayout(workspaceId, hash, entry.bytes) }
    })
  }

  async contentUploadComplete(workspace, metadata) {
    if (metadata.completed !== true || !workspace.uploadedHashes.has(metadata.hash)
      && ![...workspace.entries.values()].some(entry => entry.kind === 'file' && entry.hash === metadata.hash)) return false
    const layout = await this.readContentLayout(workspace.id, metadata.hash, metadata.totalBytes)
    if (JSON.stringify(layout) !== JSON.stringify(metadata.layout)) {
      throw new WorkspaceError('CONTENT_LAYOUT_CONFLICT', 'blob already has a different verified content layout', 409)
    }
    if ((await this.blobStore.stat(metadata.hash))?.size !== metadata.totalBytes) return false
    return this.chunkObjects === undefined || await this.blobStore.verify(metadata.hash, metadata.totalBytes)
  }

  async assertContentLayoutCompatible(metadata) {
    if (metadata.layout === undefined) return
    try {
      const layout = await this.readContentLayout(metadata.workspaceId, metadata.hash, metadata.totalBytes)
      if (JSON.stringify(layout) !== JSON.stringify(metadata.layout)) {
        throw new WorkspaceError('CONTENT_LAYOUT_CONFLICT', 'blob already has a different verified content layout', 409)
      }
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'CONTENT_LAYOUT_UNAVAILABLE') return
      throw error
    }
  }

  async releaseCompletedStaging(metadata) {
    const directory = this.uploadDirectory(metadata.workspaceId, metadata.operationId, metadata.hash)
    for (let index = 0; index < metadata.chunkCount; index += 1) await rm(join(directory, `${String(index)}.part`), { force: true })
    await rm(join(directory, 'assembled.upload'), { force: true })
    const handle = await open(directory, 'r')
    try { await handle.sync() } finally { await handle.close() }
  }

  async missingUploadChunks(metadata, io) {
    const missing = []
    for (let index = 0; index < metadata.chunkCount; index += 1) {
      const expectedDigest = metadata.chunks[index]
      if (typeof expectedDigest !== 'string') {
        missing.push(index)
        continue
      }
      if (metadata.layout !== undefined && this.chunkObjects !== undefined) {
        const length = uploadChunkRange(metadata, index).length
        if (!await this.chunkObjects.verifyChunk(expectedDigest, length)) missing.push(index)
        else if (io !== undefined) io.bytes += length
        continue
      }
      const path = join(this.uploadDirectory(metadata.workspaceId, metadata.operationId, metadata.hash), `${String(index)}.part`)
      try {
        const info = await stat(path)
        if (info.size !== uploadChunkRange(metadata, index).length || await hashFile(path, io) !== expectedDigest) missing.push(index)
      } catch (error) {
        if (error?.code === 'ENOENT') missing.push(index)
        else throw error
      }
    }
    return missing
  }

  async removeExpiredUploads(now = this.now()) {
    let removed = 0
    let preservedUnrecognized = 0
    for (const workspace of await readdir(this.uploadsDir, { withFileTypes: true })) {
      if (!workspace.isDirectory() || !UUID_PATTERN.test(workspace.name)) continue
      const workspaceDirectory = join(this.uploadsDir, workspace.name)
      for (const upload of await readdir(workspaceDirectory, { withFileTypes: true })) {
        if (!upload.isDirectory()) continue
        const directory = join(workspaceDirectory, upload.name)
        const identity = upload.name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([a-f0-9]{64})$/i)
        if (identity === null) {
          preservedUnrecognized += 1
          continue
        }
        let metadata
        try {
          metadata = JSON.parse(await readFile(join(directory, 'upload.json'), 'utf8'))
        } catch (error) {
          if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
            preservedUnrecognized += 1
            continue
          }
          throw error
        }
        if (!isValidUploadMetadata(metadata, workspace.name, identity[1], identity[2])) {
          preservedUnrecognized += 1
          continue
        }
        if (now >= metadata.updatedAt && now - metadata.updatedAt > UPLOAD_EXPIRY_MS) {
          await rm(directory, { recursive: true, force: true })
          removed += 1
        }
      }
    }
    return { removed, preservedUnrecognized }
  }

  async readUploadMetadata(workspaceId, operationId, hash) {
    let metadata
    try {
      metadata = JSON.parse(await readFile(this.uploadMetadataPath(workspaceId, operationId, hash), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') throw new WorkspaceError('UPLOAD_NOT_FOUND', 'blob upload does not exist', 404)
      if (error instanceof SyntaxError) throw new WorkspaceError('UPLOAD_METADATA_INVALID', 'upload metadata is invalid', 500, { cause: error })
      throw error
    }
    if (!isValidUploadMetadata(metadata, workspaceId, operationId, hash)) {
      throw new WorkspaceError('UPLOAD_METADATA_INVALID', 'upload metadata is invalid', 500)
    }
    return metadata
  }

  async pendingContentChunkRoots() {
    const roots = []
    for (const workspace of await readdir(this.uploadsDir, { withFileTypes: true })) {
      if (!workspace.isDirectory() || !UUID_PATTERN.test(workspace.name)) return { skipped: 'unrecognized-upload-metadata' }
      for (const upload of await readdir(join(this.uploadsDir, workspace.name), { withFileTypes: true })) {
        const identity = upload.name.match(/^([0-9a-f-]{36})-([a-f0-9]{64})$/i)
        if (!upload.isDirectory() || identity === null || !UUID_PATTERN.test(identity[1])) return { skipped: 'unrecognized-upload-metadata' }
        let metadata
        try {
          metadata = await this.readUploadMetadata(workspace.name, identity[1], identity[2])
        } catch (error) {
          if (!(error instanceof WorkspaceError)) throw error
          return { skipped: 'unrecognized-upload-metadata' }
        }
        if (metadata.layout === undefined) continue
        for (const [index, chunk] of metadata.layout.chunks.entries()) {
          if (metadata.chunks[index] === chunk.hash) roots.push({ hash: chunk.hash, length: chunk.length })
        }
      }
    }
    return { roots }
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
    const layout = Object.hasOwn(input, 'layout') ? validateContentLayout(input.layout, input.totalBytes) : undefined
    return await this.exclusive(workspaceId, async () => {
      let workspace = this.requireWorkspace(principalId, workspaceId)
      const metadataPath = this.uploadMetadataPath(workspaceId, operationId, hash)
      const chunkCount = layout === undefined ? Math.ceil(input.totalBytes / WORKSPACE_BLOB_CHUNK_BYTES) : layout.chunks.length
      let metadata
      try {
        metadata = await this.readUploadMetadata(workspaceId, operationId, hash)
      } catch (error) {
        if (!(error instanceof WorkspaceError) || error.code !== 'UPLOAD_NOT_FOUND') throw error
      }
      if (metadata !== undefined && (metadata.totalBytes !== input.totalBytes || metadata.chunkBytes !== input.chunkBytes
        || metadata.chunkCount !== chunkCount || JSON.stringify(metadata.layout) !== JSON.stringify(layout))) {
        throw new WorkspaceError('UPLOAD_ID_CONFLICT', 'upload id was reused with different blob metadata', 409)
      }
      await this.assertContentLayoutCompatible({ workspaceId, hash, totalBytes: input.totalBytes, layout })
      if (layout === undefined && workspace.uploadedHashes.has(hash)) {
        if (await this.blobStore.stat(hash) !== undefined) {
          return { workspaceId, operationId, hash, complete: true, missing: [] }
        }
        const uploadedHashes = new Set(workspace.uploadedHashes)
        uploadedHashes.delete(hash)
        const uploadedAt = new Map(workspace.uploadedAt)
        uploadedAt.delete(hash)
        workspace = { ...workspace, uploadedHashes, uploadedAt }
        await this.persistWorkspace(workspace)
        this.workspaces.set(workspaceId, workspace)
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
          ...(layout === undefined ? {} : { layout }),
          chunks: [],
          createdAt: this.now(),
          updatedAt: this.now(),
        }
        await atomicWrite(metadataPath, JSON.stringify(metadata))
      }
      if (await this.contentUploadComplete(workspace, metadata)) {
        await this.releaseCompletedStaging(metadata)
        return { workspaceId, operationId, hash, complete: true, missing: [], retainedStagingBytes: 0 }
      }
      if (metadata.completed === true) throw new WorkspaceError('UPLOAD_BLOB_UNAVAILABLE', 'completed upload blob is no longer available; start a new operation', 409)
      const io = { bytes: 0 }
      const missing = await this.missingUploadChunks(metadata, io)
      return { workspaceId, operationId, hash, complete: false, chunkBytes: metadata.chunkBytes, chunkCount, missing,
        reusePlanned: metadata.reuse !== undefined,
        stagingVerificationBytes: metadata.layout !== undefined && this.chunkObjects !== undefined ? 0 : io.bytes,
        ...(metadata.layout === undefined || this.chunkObjects === undefined ? {} : { chunkVerificationBytes: io.bytes }) }
    })
  }

  async reuseBlobChunks(request, workspaceId, operationId, hash, input) {
    const principalId = this.principalFromRequest(request)
    workspaceId = assertId(workspaceId, 'workspaceId')
    assertUploadIdentity(operationId, hash)
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.requireWorkspace(principalId, workspaceId)
      const metadata = await this.readUploadMetadata(workspaceId, operationId, hash)
      const plan = { baseHash: input.baseHash, chunkHashes: input.chunkHashes }
      if (!isValidReusePlan(plan, metadata.chunkCount)) {
        throw new WorkspaceError('INVALID_REQUEST', 'reuse requires a base hash and one SHA-256 per target chunk')
      }
      if (metadata.reuse !== undefined && JSON.stringify(metadata.reuse) !== JSON.stringify(plan)) {
        throw new WorkspaceError('UPLOAD_ID_CONFLICT', 'upload reuse plan cannot change', 409)
      }
      if (metadata.layout !== undefined && plan.chunkHashes.some((hash, index) => hash !== metadata.layout.chunks[index].hash)) {
        throw new WorkspaceError('UPLOAD_CHUNK_CONFLICT', 'reuse hashes conflict with the content layout', 409)
      }
      const base = [...workspace.entries.values()].find(entry => entry.kind === 'file' && entry.hash === plan.baseHash)
      if (base === undefined) throw new WorkspaceError('BLOB_NOT_FOUND', 'reuse source is not referenced by this Workspace', 404)
      if (metadata.completed === true) throw new WorkspaceError('UPLOAD_ALREADY_COMPLETE', 'completed upload cannot plan source reuse', 409)
      const sourceRanges = new Map()
      if (metadata.layout !== undefined) {
        const sourceLayout = await this.readContentLayout(workspaceId, base.hash, base.bytes)
        for (const chunk of sourceLayout.chunks) sourceRanges.set(`${chunk.length}:${chunk.hash}`, chunk)
      }
      if (!await this.blobStore.verify(base.hash, base.bytes)) {
        throw new WorkspaceError('BLOB_CORRUPT', 'reuse source failed size or SHA-256 verification', 500)
      }
      const chunks = Array.from({ length: metadata.chunkCount }, (_, index) => metadata.chunks[index] ?? null)
      if (chunks.some((chunk, index) => chunk !== null && chunk !== plan.chunkHashes[index])) {
        throw new WorkspaceError('UPLOAD_CHUNK_CONFLICT', 'stored chunk conflicts with the reuse plan', 409)
      }
      if (metadata.reuse === undefined) {
        await atomicWrite(this.uploadMetadataPath(workspaceId, operationId, hash), JSON.stringify({
          ...metadata, reuse: plan, updatedAt: this.now(),
        }))
      }
      const reused = []
      let comparedSourceBytes = 0
      let stagedReuseBytes = 0
      let stagingVerificationBytes = 0
      let referencedChunkBytes = 0
      for (let index = 0; index < metadata.chunkCount; index += 1) {
        const target = uploadChunkRange(metadata, index)
        const source = metadata.layout === undefined ? target : sourceRanges.get(`${target.length}:${plan.chunkHashes[index]}`)
        if (source === undefined) continue
        const { offset, length } = source
        if (offset + length > base.bytes) continue
        if (metadata.layout !== undefined && this.chunkObjects !== undefined) {
          if (!await this.chunkObjects.verifyChunk(plan.chunkHashes[index], length)) {
            throw new WorkspaceError('BLOB_CORRUPT', 'authorized source chunk is missing', 500)
          }
          comparedSourceBytes += length
          chunks[index] = plan.chunkHashes[index]
          reused.push(index)
          referencedChunkBytes += length
          continue
        }
        const partPath = join(this.uploadDirectory(workspaceId, operationId, hash), `${String(index)}.part`)
        if (metadata.layout !== undefined && chunks[index] !== null) {
          try {
            const staged = await readFile(partPath)
            stagingVerificationBytes += staged.byteLength
            if (staged.byteLength === length && hashBytes(staged) === plan.chunkHashes[index]) {
              reused.push(index)
              continue
            }
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error
          }
        }
        const bytes = await this.blobStore.getRange(base.hash, offset, length)
        comparedSourceBytes += bytes.byteLength
        if (bytes.byteLength !== length || hashBytes(bytes) !== plan.chunkHashes[index]) {
          if (metadata.layout !== undefined) throw new WorkspaceError('BLOB_CORRUPT', 'indexed reuse source range failed SHA-256 verification', 500)
          continue
        }
        await atomicWrite(partPath, bytes)
        chunks[index] = plan.chunkHashes[index]
        reused.push(index)
        stagedReuseBytes += bytes.byteLength
      }
      await atomicWrite(this.uploadMetadataPath(workspaceId, operationId, hash), JSON.stringify({
        ...metadata, reuse: plan, chunks, updatedAt: this.now(),
      }))
      const updated = { ...metadata, reuse: plan, chunks }
      const stagingIo = { bytes: stagingVerificationBytes }
      const missing = await this.missingUploadChunks(updated, stagingIo)
      return { workspaceId, operationId, hash, reused, missing,
        baseVerificationBytes: base.bytes, comparedSourceBytes, stagedReuseBytes,
        stagingVerificationBytes: metadata.layout !== undefined && this.chunkObjects !== undefined ? 0 : stagingIo.bytes,
        ...(metadata.layout === undefined || this.chunkObjects === undefined ? {} : { referencedChunkBytes, chunkVerificationBytes: stagingIo.bytes }) }
    })
  }

  async blobUploadStatus(request, workspaceId, operationId, hash) {
    const principalId = this.principalFromRequest(request)
    workspaceId = assertId(workspaceId, 'workspaceId')
    assertUploadIdentity(operationId, hash)
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.requireWorkspace(principalId, workspaceId)
      let metadata
      try {
        metadata = await this.readUploadMetadata(workspaceId, operationId, hash)
      } catch (error) {
        if (!(error instanceof WorkspaceError) || error.code !== 'UPLOAD_NOT_FOUND' || !workspace.uploadedHashes.has(hash)) throw error
      }
      if (metadata === undefined || metadata.layout === undefined && workspace.uploadedHashes.has(hash)) {
        return { workspaceId, operationId, hash, complete: true, missing: [] }
      }
      if (await this.contentUploadComplete(workspace, metadata)) {
        await this.releaseCompletedStaging(metadata)
        return { workspaceId, operationId, hash, complete: true, missing: [], retainedStagingBytes: 0 }
      }
      if (metadata.completed === true) throw new WorkspaceError('UPLOAD_BLOB_UNAVAILABLE', 'completed upload blob is no longer available; start a new operation', 409)
      const io = { bytes: 0 }
      const missing = await this.missingUploadChunks(metadata, io)
      return { workspaceId, operationId, hash, complete: false, chunkBytes: metadata.chunkBytes, chunkCount: metadata.chunkCount,
        missing, stagingVerificationBytes: metadata.layout !== undefined && this.chunkObjects !== undefined ? 0 : io.bytes,
        ...(metadata.layout === undefined || this.chunkObjects === undefined ? {} : { chunkVerificationBytes: io.bytes }) }
    })
  }

  async putBlobChunk(request, workspaceId, operationId, hash, chunkIndex, bytes, chunkHash) {
    const principalId = this.principalFromRequest(request)
    workspaceId = assertId(workspaceId, 'workspaceId')
    assertUploadIdentity(operationId, hash)
    if (typeof chunkHash !== 'string' || !/^[a-f0-9]{64}$/.test(chunkHash) || hashBytes(bytes) !== chunkHash) {
      throw new WorkspaceError('UPLOAD_CHUNK_HASH_MISMATCH', 'uploaded chunk does not match its SHA-256 hash')
    }
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.requireWorkspace(principalId, workspaceId)
      const metadata = await this.readUploadMetadata(workspaceId, operationId, hash)
      const expectedBytes = uploadChunkRange(metadata, chunkIndex).length
      if (bytes.byteLength !== expectedBytes) throw new WorkspaceError('UPLOAD_CHUNK_SIZE_MISMATCH', 'uploaded chunk has an invalid byte length')
      if (metadata.layout !== undefined && metadata.layout.chunks[chunkIndex].hash !== chunkHash) {
        throw new WorkspaceError('UPLOAD_CHUNK_CONFLICT', 'uploaded chunk conflicts with the content layout', 409)
      }
      if (metadata.reuse !== undefined && metadata.reuse.chunkHashes[chunkIndex] !== chunkHash) {
        throw new WorkspaceError('UPLOAD_CHUNK_CONFLICT', 'uploaded chunk conflicts with the reuse plan', 409)
      }
      if (metadata.completed === true) {
        if (!await this.contentUploadComplete(workspace, metadata)) {
          throw new WorkspaceError('UPLOAD_BLOB_UNAVAILABLE', 'completed upload blob is no longer available; start a new operation', 409)
        }
        return { workspaceId, operationId, hash, chunkIndex, chunkHash, replayed: true,
          stagedUploadBytes: 0, stagingVerificationBytes: 0, retainedStagingBytes: 0 }
      }
      if (metadata.layout !== undefined && this.chunkObjects !== undefined) {
        const stored = await this.chunkObjects.putChunk(chunkHash, bytes)
        const chunks = Array.from({ length: metadata.chunkCount }, (_, index) => metadata.chunks[index] ?? null)
        const replayed = chunks[chunkIndex] === chunkHash
        chunks[chunkIndex] = chunkHash
        await atomicWrite(this.uploadMetadataPath(workspaceId, operationId, hash), JSON.stringify({
          ...metadata, chunks, updatedAt: this.now(),
        }))
        return { workspaceId, operationId, hash, chunkIndex, chunkHash, replayed,
          stagedUploadBytes: 0, stagingVerificationBytes: 0, chunkObjectWriteBytes: stored.writtenBytes,
          chunkVerificationBytes: stored.verificationBytes }
      }
      const directory = this.uploadDirectory(workspaceId, operationId, hash)
      const path = join(directory, `${String(chunkIndex)}.part`)
      const previousHash = metadata.chunks[chunkIndex]
      let stagingVerificationBytes = 0
      if (typeof previousHash === 'string') {
        if (previousHash !== chunkHash) {
          throw new WorkspaceError('UPLOAD_CHUNK_CONFLICT', 'chunk index was already stored with different content', 409)
        }
        try {
          const previous = await readFile(path)
          stagingVerificationBytes += previous.byteLength
          if (previous.equals(bytes)) {
            return { workspaceId, operationId, hash, chunkIndex, chunkHash, replayed: true,
              stagedUploadBytes: 0, stagingVerificationBytes }
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
      await atomicWrite(path, bytes)
      const chunks = Array.from({ length: metadata.chunkCount }, (_, index) => metadata.chunks[index] ?? null)
      chunks[chunkIndex] = chunkHash
      await atomicWrite(this.uploadMetadataPath(workspaceId, operationId, hash), JSON.stringify({
        ...metadata,
        chunks,
        updatedAt: this.now(),
      }))
      return { workspaceId, operationId, hash, chunkIndex, chunkHash, replayed: false,
        stagedUploadBytes: bytes.byteLength, stagingVerificationBytes }
    })
  }

  async completeBlobUpload(request, workspaceId, operationId, hash) {
    const principalId = this.principalFromRequest(request)
    workspaceId = assertId(workspaceId, 'workspaceId')
    assertUploadIdentity(operationId, hash)
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.requireWorkspace(principalId, workspaceId)
      let metadata
      try {
        metadata = await this.readUploadMetadata(workspaceId, operationId, hash)
      } catch (error) {
        if (!(error instanceof WorkspaceError) || error.code !== 'UPLOAD_NOT_FOUND' || !workspace.uploadedHashes.has(hash)) throw error
      }
      if (metadata === undefined || metadata.layout === undefined && workspace.uploadedHashes.has(hash)) {
        return { workspaceId, operationId, hash, complete: true, replayed: true }
      }
      const referenced = [...workspace.entries.values()].some(entry => entry.kind === 'file' && entry.hash === hash)
      const replayed = workspace.uploadedHashes.has(hash) || metadata.layout !== undefined && referenced
      await this.assertContentLayoutCompatible(metadata)
      if (metadata.completed === true) {
        if (!replayed || !await this.blobStore.verify(hash, metadata.totalBytes)) {
          throw new WorkspaceError('BLOB_CORRUPT', 'completed upload blob is unavailable or failed SHA-256 verification', 409)
        }
        await this.readContentLayout(workspaceId, hash, metadata.totalBytes)
        await this.releaseCompletedStaging(metadata)
        return { workspaceId, operationId, hash, complete: true, reused: true, replayed: true,
          stagedReadBytes: 0, assembledWriteBytes: 0, blobVerificationBytes: metadata.totalBytes, retainedStagingBytes: 0 }
      }
      if (metadata.chunks.length !== metadata.chunkCount || metadata.chunks.some(chunk => typeof chunk !== 'string')) {
        throw new WorkspaceError('UPLOAD_INCOMPLETE', 'blob upload is missing one or more chunks', 409)
      }
      let reused = false
      let stagedReadBytes = 0
      let assembledWriteBytes = 0
      let blobVerificationBytes = 0
      let composition
      const existing = await this.blobStore.stat(hash)
      if (existing !== undefined) {
        if (existing.size !== metadata.totalBytes || !await this.blobStore.verify(hash, metadata.totalBytes)) {
          throw new WorkspaceError('BLOB_CORRUPT', 'stored blob failed size or SHA-256 verification', 500)
        }
        blobVerificationBytes += metadata.totalBytes
        reused = true
      }
      if (metadata.layout !== undefined && this.chunkObjects !== undefined) {
        composition = await this.chunkObjects.compose(hash, metadata.totalBytes, metadata.layout)
      } else if (existing === undefined || metadata.layout !== undefined) {
        const temporary = join(this.uploadDirectory(workspaceId, operationId, hash), 'assembled.upload')
        await rm(temporary, { force: true })
        const output = await open(temporary, 'wx', 0o600)
        const digest = createHash('sha256')
        let totalBytes = 0
        try {
          for (let index = 0; index < metadata.chunkCount; index += 1) {
            let chunk
            try {
              chunk = await readFile(join(this.uploadDirectory(workspaceId, operationId, hash), `${String(index)}.part`))
            } catch (error) {
              if (error?.code === 'ENOENT') throw new WorkspaceError('UPLOAD_CHUNK_CORRUPT', `stored chunk ${String(index)} is missing`, 409)
              throw error
            }
            stagedReadBytes += chunk.byteLength
            const expectedBytes = uploadChunkRange(metadata, index).length
            if (chunk.byteLength !== expectedBytes || hashBytes(chunk) !== metadata.chunks[index]
              || metadata.layout !== undefined && metadata.chunks[index] !== metadata.layout.chunks[index].hash) {
              throw new WorkspaceError('UPLOAD_CHUNK_CORRUPT', `stored chunk ${String(index)} failed validation`, 409)
            }
            digest.update(chunk)
            totalBytes += chunk.byteLength
            await output.writeFile(chunk)
            assembledWriteBytes += chunk.byteLength
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
        try {
          if (existing === undefined) {
            const stored = await this.blobStore.putFile(hash, temporary, totalBytes)
            reused = stored.reused
          }
        } finally {
          await rm(temporary, { force: true })
        }
      }
      if (metadata.layout !== undefined) {
        await atomicWrite(this.contentLayoutPath(workspaceId, hash), JSON.stringify({
          version: 1, workspaceId, hash, totalBytes: metadata.totalBytes, layout: metadata.layout,
        }))
      }
      const next = {
        ...workspace,
        uploadedHashes: new Set(workspace.uploadedHashes).add(hash),
        uploadedAt: new Map(workspace.uploadedAt).set(hash, this.now()),
      }
      if (!replayed) {
        await this.persistWorkspace(next)
        this.workspaces.set(workspaceId, next)
      }
      if (metadata.layout === undefined) await rm(this.uploadDirectory(workspaceId, operationId, hash), { recursive: true, force: true })
      else {
        const completed = { ...metadata, completed: true, updatedAt: this.now() }
        await atomicWrite(this.uploadMetadataPath(workspaceId, operationId, hash), JSON.stringify(completed))
        await this.releaseCompletedStaging(completed)
      }
      return { workspaceId, operationId, hash, complete: true, reused, replayed,
        stagedReadBytes, assembledWriteBytes, blobVerificationBytes, retainedStagingBytes: 0,
        ...(composition === undefined ? {} : composition) }
    })
  }

  async getBlobChunk(request, workspaceId, hash, chunkIndex) {
    const principalId = this.principalFromRequest(request)
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.requireWorkspace(principalId, workspaceId)
      const referenced = [...workspace.entries.values()].some(entry => entry.kind === 'file' && entry.hash === hash)
      if (!referenced) throw new WorkspaceError('BLOB_NOT_FOUND', 'blob is not referenced by this workspace', 404)
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new WorkspaceError('INVALID_REQUEST', 'blob hash is invalid')
      const info = await this.blobStore.stat(hash)
      if (info === undefined) throw new WorkspaceError('BLOB_NOT_FOUND', 'workspace blob is missing', 404)
      const chunkCount = Math.ceil(info.size / WORKSPACE_BLOB_CHUNK_BYTES)
      const bytesInChunk = expectedChunkBytes(info.size, chunkIndex, chunkCount)
      const buffer = await this.blobStore.getRange(hash, chunkIndex * WORKSPACE_BLOB_CHUNK_BYTES, bytesInChunk)
      if (buffer.byteLength !== bytesInChunk) throw new WorkspaceError('BLOB_CORRUPT', 'stored blob chunk is truncated', 500)
      return { bytes: buffer, chunkHash: hashBytes(buffer), chunkIndex, chunkCount, totalBytes: info.size }
    })
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
      const now = this.now()
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
      || fencingToken !== workspace.writerEpoch || workspace.writerExpiresAt <= this.now()) {
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
      : { workspaceId, operationId, found: true, requestDigest: operation.digest, receipt: structuredClone(operation.receipt) }
  }

  /**
   * Authorize a current manifest file and verify its descriptor/chunks while locked.
   * The caller owns closing the returned reader; iteration runs without Workspace locks.
   * @param {object} request - Request carrying the browser principal cookie.
   * @param {string} workspaceId - Workspace owned by that principal.
   * @param {string} hash - Full-file SHA-256 referenced by the current manifest.
   * @returns {Promise<object>} Verified reader; never buffers fallback blobs.
   * @throws {WorkspaceError} FILE_DOWNLOAD_UNSUPPORTED (409) when chunk mode is
   * disabled or this file has no descriptor; authorization and corruption errors propagate.
   */
  async openBlobRead(request, workspaceId, hash) {
    const principalId = this.principalFromRequest(request)
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.requireWorkspace(principalId, workspaceId)
      const entry = [...workspace.entries.values()].find(entry => entry.kind === 'file' && entry.hash === hash)
      if (entry === undefined) throw new WorkspaceError('BLOB_NOT_FOUND', 'blob is not referenced by this workspace', 404)
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new WorkspaceError('INVALID_REQUEST', 'blob hash is invalid')
      const reader = this.chunkObjects === undefined ? undefined : await this.chunkObjects.openVerifiedRead(hash)
      if (reader === undefined) {
        throw new WorkspaceError('FILE_DOWNLOAD_UNSUPPORTED', 'this file requires the legacy blob download endpoint', 409)
      }
      if (reader.totalBytes !== entry.bytes) {
        await reader.close()
        throw new WorkspaceError('BLOB_CORRUPT', 'stored file size differs from its manifest entry', 500)
      }
      return reader
    })
  }

  async getBlob(request, workspaceId, hash) {
    const principalId = this.principalFromRequest(request)
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.requireWorkspace(principalId, workspaceId)
      const referenced = [...workspace.entries.values()].some(entry => entry.kind === 'file' && entry.hash === hash)
      if (!referenced) throw new WorkspaceError('BLOB_NOT_FOUND', 'blob is not referenced by this workspace', 404)
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new WorkspaceError('INVALID_REQUEST', 'blob hash is invalid')
      const bytes = await this.blobStore.get(hash)
      if (hashBytes(bytes) !== hash) throw new WorkspaceError('BLOB_CORRUPT', 'stored blob failed SHA-256 verification', 500)
      return bytes
    })
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
        const blobInfo = await this.blobStore.stat(change.hash)
        if (blobInfo === undefined) throw new WorkspaceError('BLOB_MISSING', `blob ${change.hash} must be uploaded before commit`, 409)
        if (blobInfo.size !== change.bytes || !await this.blobStore.verify(change.hash, change.bytes)) {
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
      const referencedHashes = new Set([...entries.values()].filter(entry => entry.kind === 'file').map(entry => entry.hash))
      next.uploadedHashes = new Set([...workspace.uploadedHashes].filter(hash => !referencedHashes.has(hash)))
      next.uploadedAt = new Map([...workspace.uploadedAt].filter(([hash]) => next.uploadedHashes.has(hash)))
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

  async collectGarbage(workspaceId, { now = this.now() } = {}) {
    return await this.exclusive(workspaceId, async () => {
      const workspace = this.workspaces.get(workspaceId)
      if (workspace === undefined) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 'workspace does not exist', 404)
      if (typeof this.blobStore.listHashes !== 'function' || typeof this.blobStore.delete !== 'function') {
        return { workspaceId, skipped: 'blob-store-does-not-support-gc', scannedFiles: 0, retainedFiles: 0, removedFiles: 0, removedBytes: 0, expiredPending: 0, expiredUploads: 0, preservedUnrecognizedUploads: 0 }
      }
      const uploadCleanup = await this.removeExpiredUploads(now)
      const retained = new Set()
      const expiredByWorkspace = new Map()
      for (const candidate of this.workspaces.values()) {
        for (const entry of candidate.entries.values()) if (entry.kind === 'file') retained.add(entry.hash)
        const expired = new Set()
        for (const hash of candidate.uploadedHashes) {
          const uploadedAt = candidate.uploadedAt.get(hash)
          if (uploadedAt !== undefined && now - uploadedAt > this.pendingUploadTtlMs) expired.add(hash)
          else retained.add(hash)
        }
        if (expired.size > 0) expiredByWorkspace.set(candidate.id, { candidate, expired })
      }
      const hashes = await this.blobStore.listHashes()
      let removedFiles = 0
      let removedBytes = 0
      for (const hash of hashes) {
        if (retained.has(hash)) continue
        const info = await this.blobStore.stat(hash)
        await this.blobStore.delete(hash)
        removedFiles += 1
        removedBytes += info?.size ?? 0
      }
      let expiredPending = 0
      for (const { candidate, expired } of expiredByWorkspace.values()) {
        const next = {
          ...candidate,
          uploadedHashes: new Set([...candidate.uploadedHashes].filter(hash => !expired.has(hash))),
          uploadedAt: new Map([...candidate.uploadedAt].filter(([hash]) => !expired.has(hash))),
        }
        await this.persistWorkspace(next)
        this.workspaces.set(candidate.id, next)
        expiredPending += expired.size
      }
      let removedLayouts = 0
      let preservedUnrecognizedLayouts = 0
      for (const directory of await readdir(this.layoutsDir, { withFileTypes: true })) {
        if (!directory.isDirectory() || directory.name !== workspaceId) continue
        const owner = this.workspaces.get(directory.name)
        for (const entry of await readdir(join(this.layoutsDir, directory.name), { withFileTypes: true })) {
          if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
          const hash = entry.name.slice(0, -5)
          const path = this.contentLayoutPath(directory.name, hash)
          try {
            const value = JSON.parse(await readFile(path, 'utf8'))
            if (!Number.isSafeInteger(value?.totalBytes) || value.totalBytes < 0 || value.totalBytes > MAX_WORKSPACE_BLOB_BYTES) {
              throw new WorkspaceError('CONTENT_LAYOUT_CORRUPT', 'stored content layout size is invalid', 500)
            }
            await this.readContentLayout(directory.name, hash, value.totalBytes)
          } catch (error) {
            if (!(error instanceof SyntaxError) && !(error instanceof WorkspaceError)) throw error
            preservedUnrecognizedLayouts += 1
            continue
          }
          if (owner === undefined || owner.uploadedHashes.has(hash)
            || [...owner.entries.values()].some(candidate => candidate.kind === 'file' && candidate.hash === hash)) continue
          await rm(path, { force: true })
          removedLayouts += 1
        }
      }
      let chunkGarbage
      if (this.chunkObjects !== undefined) {
        const pending = await this.pendingContentChunkRoots()
        chunkGarbage = pending.skipped === undefined ? await this.chunkObjects.collectChunks(pending.roots) : pending
      }
      return {
        workspaceId,
        scannedFiles: hashes.length,
        retainedFiles: retained.size,
        removedFiles,
        removedBytes,
        expiredPending,
        expiredUploads: uploadCleanup.removed,
        preservedUnrecognizedUploads: uploadCleanup.preservedUnrecognized,
        removedLayouts,
        preservedUnrecognizedLayouts,
        ...(chunkGarbage === undefined ? {} : { chunkGarbage }),
      }
    })
  }
}
