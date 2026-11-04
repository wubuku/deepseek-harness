/**
 * Offline erasure of one Session or one principal from a stopped browser-native
 * data directory.
 *
 * Erasure must remove the records themselves rather than hide them: Session
 * logs, Workspace metadata and blobs, attachment objects, durable running-turn
 * runs, cross-store ledger records, and the matching observability entries are
 * deleted. The observability hash chain is re-anchored from GENESIS, so it keeps
 * verifying after the rewrite and no prior chain continuity is retained.
 *
 * The backend must be stopped: an offline rewrite behind a live process would
 * race its in-memory state.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redactObservabilityJournal } from '../observability-journal.mjs'

const DATA_DIR_LOCK_NAME = '.browser-native-backend.lock'
const ATTACHMENT_REFERENCE = /sha256:([a-f0-9]{64})/g
const ATTACHMENT_FILE_PATTERN = /^[a-f0-9]{64}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/

class ErasureError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ErasureError'
    this.code = code
    this.status = status
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

async function atomicWrite(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, path)
}

/** Refuse to rewrite a data directory whose backend still holds the lock. */
async function assertStopped(dataDir) {
  if (await exists(join(dataDir, DATA_DIR_LOCK_NAME))) {
    throw new ErasureError('BACKEND_RUNNING', 'stop the backend before erasing data', 409)
  }
}

/** Collect attachment hashes referenced by every Session log that remains. */
async function referencedAttachmentHashes(dataDir, exclude = new Set()) {
  const directory = join(dataDir, 'sessions')
  const hashes = new Set()
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return []
    throw error
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    if (exclude.has(entry.name.slice(0, -'.json'.length))) continue
    const raw = await readIfExists(join(directory, entry.name))
    for (const match of raw.matchAll(ATTACHMENT_REFERENCE)) hashes.add(match[1])
  }
  return hashes
}

/** Delete attachment objects whose hash no longer appears in any Session log. */
async function sweepAttachments(dataDir, referenced) {
  const root = join(dataDir, 'attachments-v1')
  let removed = 0
  for (const workspace of await readdir(root, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return []
    throw error
  })) {
    if (!workspace.isDirectory()) continue
    const workspaceRoot = join(root, workspace.name)
    for (const bucket of await readdir(workspaceRoot, { withFileTypes: true })) {
      if (!bucket.isDirectory()) continue
      for (const file of await readdir(join(workspaceRoot, bucket.name), { withFileTypes: true })) {
        if (!file.isFile() || !ATTACHMENT_FILE_PATTERN.test(file.name) || referenced.has(file.name)) continue
        await rm(join(workspaceRoot, bucket.name, file.name), { force: true })
        removed += 1
      }
    }
  }
  return removed
}

/** Read one Session log's header id and owner without trusting the rest. */
function describeSession(raw) {
  try {
    const parsed = JSON.parse(raw)
    return { id: parsed.header?.id, principalId: parsed.principalId }
  } catch {
    return {}
  }
}

/** Delete every Session log matching the predicate and return removed ids and attachment refs. */
async function removeSessions(dataDir, matches) {
  const directory = join(dataDir, 'sessions')
  const removed = []
  const attachmentHashes = new Set()
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return []
    throw error
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = join(directory, entry.name)
    const raw = await readIfExists(path)
    const described = describeSession(raw)
    if (!matches(described, entry.name)) continue
    for (const match of raw.matchAll(ATTACHMENT_REFERENCE)) attachmentHashes.add(match[1])
    await rm(path, { force: true })
    removed.push(described.id ?? entry.name.slice(0, -'.json'.length))
  }
  return { removed, attachmentHashes }
}

/** Drop running-turn journal entries for erased Sessions. */
async function removeDurableRuns(dataDir, sessionIds) {
  const path = join(dataDir, 'durable-runs.json')
  const raw = await readIfExists(path)
  if (raw === '') return 0
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed?.runs)) return 0
  const kept = parsed.runs.filter(run => !sessionIds.has(run?.sessionId))
  const removed = parsed.runs.length - kept.length
  if (removed > 0) await atomicWrite(path, `${JSON.stringify({ ...parsed, runs: kept })}\n`)
  return removed
}

/** Drop cross-store ledger records owned by the erased Session or principal. */
async function removeLedgerRecords(dataDir, matches) {
  const path = join(dataDir, 'cross-store-operation-ledger.json')
  const raw = await readIfExists(path)
  if (raw === '') return 0
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed?.records)) return 0
  const kept = parsed.records.filter(record => !matches(record?.identity))
  const removed = parsed.records.length - kept.length
  if (removed > 0) await atomicWrite(path, `${JSON.stringify({ ...parsed, records: kept })}\n`)
  return removed
}

/** Drop viewer grants that name an erased Session or principal. */
async function removeShares(dataDir, matches) {
  const path = join(dataDir, 'session-shares.json')
  const raw = await readIfExists(path)
  if (raw === '') return 0
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed?.shares)) return 0
  const kept = parsed.shares.filter(share => !matches(share))
  const removed = parsed.shares.length - kept.length
  if (removed > 0) await atomicWrite(path, `${JSON.stringify({ version: parsed.version ?? 1, shares: kept })}\n`)
  return removed
}

/** Hashes referenced by the Workspace manifests and pending uploads that remain. */
async function referencedWorkspaceHashes(dataDir) {
  const directory = join(dataDir, 'workspace-v2', 'workspaces')
  const hashes = new Set()
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return []
    throw error
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const parsed = JSON.parse(await readFile(join(directory, entry.name), 'utf8'))
    for (const manifest of parsed.entries ?? []) if (HASH_PATTERN.test(manifest?.hash ?? '')) hashes.add(manifest.hash)
    for (const hash of parsed.uploadedHashes ?? []) if (HASH_PATTERN.test(hash)) hashes.add(hash)
  }
  return hashes
}

/** Delete blob, descriptor, and chunk objects that no remaining Workspace references. */
async function sweepWorkspaceBlobs(dataDir) {
  const referenced = await referencedWorkspaceHashes(dataDir)
  let removedBlobs = 0
  const blobsRoot = join(dataDir, 'workspace-v2', 'blobs')
  for (const bucket of await readdir(blobsRoot, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return []
    throw error
  })) {
    if (!bucket.isDirectory()) continue
    for (const file of await readdir(join(blobsRoot, bucket.name), { withFileTypes: true })) {
      if (!file.isFile() || referenced.has(file.name)) continue
      await rm(join(blobsRoot, bucket.name, file.name), { force: true })
      removedBlobs += 1
    }
  }
  const filesRoot = join(dataDir, 'workspace-v2', 'chunk-objects', 'files')
  let removedDescriptors = 0
  const chunkRoots = new Set()
  for (const entry of await readdir(filesRoot, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return []
    throw error
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const hash = entry.name.slice(0, -'.json'.length)
    if (!referenced.has(hash)) {
      await rm(join(filesRoot, entry.name), { force: true })
      removedDescriptors += 1
      continue
    }
    const descriptor = JSON.parse(await readFile(join(filesRoot, entry.name), 'utf8'))
    for (const chunk of descriptor.layout?.chunks ?? []) if (HASH_PATTERN.test(chunk?.hash ?? '')) chunkRoots.add(chunk.hash)
  }
  const chunksRoot = join(dataDir, 'workspace-v2', 'chunk-objects', 'chunks')
  let removedChunks = 0
  for (const bucket of await readdir(chunksRoot, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return []
    throw error
  })) {
    if (!bucket.isDirectory()) continue
    for (const file of await readdir(join(chunksRoot, bucket.name), { withFileTypes: true })) {
      if (!file.isFile() || chunkRoots.has(file.name)) continue
      await rm(join(chunksRoot, bucket.name, file.name), { force: true })
      removedChunks += 1
    }
  }
  return { removedBlobs, removedDescriptors, removedChunks }
}

/** Remove one Workspace's metadata, layouts, staging, and attachments directory. */
async function removeWorkspace(dataDir, workspaceId) {
  const removed = []
  const paths = [
    join(dataDir, 'workspace-v2', 'workspaces', `${workspaceId}.json`),
    join(dataDir, 'workspace-v2', 'layouts', workspaceId),
    join(dataDir, 'workspace-v2', 'uploads', workspaceId),
    join(dataDir, 'attachment-uploads-v1', workspaceId),
    join(dataDir, 'attachments-v1', workspaceId),
  ]
  for (const path of paths) {
    if (!(await exists(path))) continue
    await rm(path, { recursive: true, force: true })
    removed.push(path)
  }
  return removed
}

/** Remove one identity record and return its workspace id, or false when absent. */
async function removeIdentity(dataDir, principalId) {
  const path = join(dataDir, 'workspace-v2', 'identities.json')
  const raw = await readIfExists(path)
  if (raw === '') return false
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed?.identities)) return false
  const record = parsed.identities.find(candidate => candidate?.principalId === principalId)
  if (record === undefined) return false
  const kept = parsed.identities.filter(candidate => candidate.principalId !== principalId)
  await atomicWrite(path, `${JSON.stringify({ version: parsed.version, identities: kept })}\n`)
  return { workspaceId: record.workspaceId }
}

/**
 * Erase one Session and every record that exists only because of it.
 * @param options - Erasure target.
 * @param options.dataDir - Stopped backend data directory.
 * @param options.sessionId - Session id to erase.
 * @returns Counts for each store that changed.
 */
export async function eraseSession({ dataDir, sessionId }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new ErasureError('INVALID_REQUEST', 'sessionId is required')
  await assertStopped(dataDir)
  const { removed, attachmentHashes } = await removeSessions(dataDir, described => described.id === sessionId)
  if (removed.length === 0) throw new ErasureError('SESSION_NOT_FOUND', `session "${sessionId}" does not exist`, 404)
  const referenced = await referencedAttachmentHashes(dataDir)
  const removedAttachments = await sweepAttachments(dataDir, referenced)
  const removedRuns = await removeDurableRuns(dataDir, new Set(removed))
  const removedLedgerRecords = await removeLedgerRecords(dataDir, identity => identity?.sessionId === sessionId)
  const removedShares = await removeShares(dataDir, share => share?.sessionId === sessionId)
  const journal = await redactObservabilityJournal({
    dataDir,
    shouldRemove: (record, ledger) => ledger === 'usage'
      ? record.sessionId === sessionId
      : record.resource === 'session' && record.resourceId === sessionId,
  })
  return {
    target: { kind: 'session', sessionId },
    sessions: removed,
    attachmentReferences: attachmentHashes.size,
    removedAttachments,
    removedDurableRuns: removedRuns,
    removedLedgerRecords,
    removedShares,
    removedJournalRecords: journal,
    removedWorkspaces: [],
  }
}

/**
 * Erase one principal, its Sessions, Workspace, attachments, ledger records,
 * and observability entries.
 * @param options - Erasure target.
 * @param options.dataDir - Stopped backend data directory.
 * @param options.principalId - Principal id recorded at identity creation.
 * @returns Counts for each store that changed.
 */
export async function erasePrincipal({ dataDir, principalId }) {
  if (typeof principalId !== 'string' || principalId.length === 0) throw new ErasureError('INVALID_REQUEST', 'principalId is required')
  await assertStopped(dataDir)
  const identity = await removeIdentity(dataDir, principalId)
  if (identity === false) throw new ErasureError('PRINCIPAL_NOT_FOUND', `principal "${principalId}" does not exist`, 404)
  const { removed, attachmentHashes } = await removeSessions(dataDir, described => described.principalId === principalId)
  const removedWorkspaces = await removeWorkspace(dataDir, identity.workspaceId)
  const removedAttachments = await sweepAttachments(dataDir, await referencedAttachmentHashes(dataDir))
  const removedRuns = await removeDurableRuns(dataDir, new Set(removed))
  const removedLedgerRecords = await removeLedgerRecords(dataDir, record => record?.principalId === principalId)
  const removedShares = await removeShares(dataDir, share => share?.ownerPrincipalId === principalId || share?.viewerPrincipalId === principalId)
  const principalDigest = createHash('sha256').update(principalId).digest('hex').slice(0, 16)
  const journal = await redactObservabilityJournal({
    dataDir,
    shouldRemove: (record, ledger) => ledger === 'usage'
      ? record.principalId === principalId
      : record.principalDigest === principalDigest,
  })
  const swept = await sweepWorkspaceBlobs(dataDir)
  return {
    target: { kind: 'principal', principalId },
    sessions: removed,
    workspaceId: identity.workspaceId,
    attachmentReferences: attachmentHashes.size,
    removedAttachments,
    removedDurableRuns: removedRuns,
    removedLedgerRecords,
    removedShares,
    removedJournalRecords: journal,
    removedWorkspaces,
    ...swept,
  }
}

/** Walk every file in the data directory as UTF-8 text. */
async function walkFiles(root, current = root, files = []) {
  for (const entry of await readdir(current, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return []
    throw error
  })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) await walkFiles(root, path, files)
    else if (entry.isFile()) files.push(path)
  }
  return files
}

/**
 * Report any file whose path or contents still contain a needle.
 * @param options - Residue scan inputs.
 * @param options.dataDir - Data directory to scan.
 * @param options.needles - Literal identifiers that must be gone.
 * @returns Matches carrying the file path and matched needle.
 */
export async function findResidue({ dataDir, needles }) {
  const matches = []
  for (const path of await walkFiles(dataDir)) {
    for (const needle of needles) {
      if (needle.length === 0) continue
      if (path.includes(needle)) matches.push({ path, needle, where: 'path' })
      const text = await readFile(path, 'utf8').catch(() => '')
      if (text.includes(needle)) matches.push({ path, needle, where: 'contents' })
    }
  }
  return matches
}

export { ErasureError }
