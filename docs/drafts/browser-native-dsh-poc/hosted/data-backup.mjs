/**
 * Full data-directory export and import for hosted browser-native DSH.
 *
 * A backup is a directory bundle with a deterministic manifest: every file under
 * the data directory except the backend lock is copied with its SHA-256 digest
 * and byte size. Import verifies the whole manifest, checks store compatibility
 * against this build, and only then writes into an empty target directory, so a
 * tampered or incompatible bundle cannot leave a partial data directory.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { inspectDataDirectory } from './check-data.mjs'
import { readDataFormat } from './data-format.mjs'

/** Bundle protocol identifier recorded in the manifest. */
export const BACKUP_PROTOCOL = 'dsh-browser-native-data-backup/1'
const MANIFEST_NAME = 'manifest.json'
const FILES_DIRECTORY = 'files'
const BACKEND_LOCK_NAME = '.browser-native-backend.lock'

/** Typed backup failure carrying a stable code for CLI exit mapping. */
export class BackupError extends Error {
  /**
   * @param {string} code - Stable failure code.
   * @param {string} message - Operator-facing message.
   */
  constructor(code, message) {
    super(message)
    this.name = 'BackupError'
    this.code = code
  }
}

/** Recursively list regular files under a directory as sorted relative paths. */
async function listFiles(root, prefix = '') {
  const files = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...await listFiles(root, path))
    else if (entry.isFile()) files.push(path)
  }
  return files.sort()
}

/** Hash one file without loading it whole. */
async function digestFile(path) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { sha256: hash.digest('hex'), bytes }
}

/** Count non-empty lines in an optional journal file. */
async function countLines(path) {
  if (!existsSync(path)) return 0
  const text = await readFile(path, 'utf8')
  return text.split('\n').filter(line => line.length > 0).length
}

/** Summarize store categories so an operator can sanity-check the bundle. */
async function summarizeStores(dataDir, files) {
  const sessions = files.filter(path => path.startsWith('sessions/') && path.endsWith('.json'))
  const workspaces = files.filter(path => path.startsWith('workspace-v2/workspaces/') && path.endsWith('.json'))
  const attachments = files.filter(path => path.startsWith('attachments-v1/'))
  let attachmentBytes = 0
  for (const path of attachments) attachmentBytes += (await stat(join(dataDir, path))).size
  return {
    sessions: { count: sessions.length },
    workspaces: { count: workspaces.length, chunkObjects: existsSync(join(dataDir, 'workspace-v2', 'chunk-objects')) },
    attachments: { count: attachments.length, bytes: attachmentBytes },
    observability: {
      accessDenials: await countLines(join(dataDir, 'observability', 'access-denials.jsonl')),
      usage: await countLines(join(dataDir, 'observability', 'usage.jsonl')),
      metrics: existsSync(join(dataDir, 'observability', 'metrics.json')),
    },
    crossStoreLedger: existsSync(join(dataDir, 'cross-store-operation-ledger.json')),
    identity: existsSync(join(dataDir, 'workspace-v2', 'identities.json')),
  }
}

/**
 * Export a stopped data directory into a new bundle directory.
 *
 * The backend must not hold the data directory lock: a live process keeps
 * writing while files are copied, so the bundle would mix revisions.
 * @param {{ dataDir: string, outputDir: string }} request - Source directory and new bundle path.
 * @returns {Promise<object>} Written manifest.
 */
export async function exportDataDir({ dataDir, outputDir }) {
  const source = resolve(dataDir)
  const output = resolve(outputDir)
  if (!existsSync(source)) throw new BackupError('DATA_DIR_MISSING', `no data directory at ${source}`)
  if (existsSync(join(source, BACKEND_LOCK_NAME))) {
    throw new BackupError('BACKEND_RUNNING', 'stop the backend before exporting; the data directory lock is held')
  }
  if (output.startsWith(`${source}${sep}`)) throw new BackupError('OUTPUT_INSIDE_DATA_DIR', 'the backup directory must be outside the data directory')
  if (existsSync(output) && (await readdir(output)).length > 0) {
    throw new BackupError('OUTPUT_NOT_EMPTY', `backup directory ${output} is not empty`)
  }
  const files = (await listFiles(source)).filter(path => path !== BACKEND_LOCK_NAME)
  const manifest = {
    protocol: BACKUP_PROTOCOL,
    createdAt: new Date().toISOString(),
    dataset: await readDataFormat(source),
    files: [],
    stores: await summarizeStores(source, files),
  }
  await mkdir(join(output, FILES_DIRECTORY), { recursive: true })
  for (const path of files) {
    const digest = await digestFile(join(source, path))
    manifest.files.push({ path, sha256: digest.sha256, bytes: digest.bytes })
    const destination = join(output, FILES_DIRECTORY, path)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(source, path), destination)
  }
  const target = join(output, MANIFEST_NAME)
  await writeFile(`${target}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rename(`${target}.tmp`, target)
  return manifest
}

/** Refuse a manifest entry that could escape the bundle or the data directory. */
function assertSafeRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new BackupError('INVALID_BACKUP', 'manifest file path is invalid')
  }
  if (path.startsWith('/') || path.startsWith('../') || path.includes('/../') || path === '..') {
    throw new BackupError('INVALID_BACKUP', `manifest file path escapes the bundle: ${path}`)
  }
}

/** Parse and shape-check the manifest before touching any destination file. */
async function readManifest(bundleDir) {
  const path = join(bundleDir, MANIFEST_NAME)
  if (!existsSync(path)) throw new BackupError('INVALID_BACKUP', `no manifest at ${path}`)
  let manifest
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new BackupError('INVALID_BACKUP', `manifest is not valid JSON: ${error.message}`)
  }
  if (manifest?.protocol !== BACKUP_PROTOCOL) {
    throw new BackupError('UNSUPPORTED_BACKUP_VERSION', `manifest protocol is ${String(manifest?.protocol)}, expected ${BACKUP_PROTOCOL}`)
  }
  if (!Array.isArray(manifest.files)) throw new BackupError('INVALID_BACKUP', 'manifest files must be an array')
  for (const entry of manifest.files) {
    assertSafeRelativePath(entry?.path)
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new BackupError('INVALID_BACKUP', `manifest entry for ${entry.path} has no valid digest or size`)
    }
  }
  const duplicates = new Set()
  for (const entry of manifest.files) {
    if (duplicates.has(entry.path)) throw new BackupError('INVALID_BACKUP', `manifest lists ${entry.path} twice`)
    duplicates.add(entry.path)
  }
  if (manifest.dataset !== undefined && (!Number.isSafeInteger(manifest.dataset?.version) || manifest.dataset.version < 1)) {
    throw new BackupError('INVALID_BACKUP', 'manifest dataset record has no valid version')
  }
  return manifest
}

/** Verify every bundled file against its manifest digest and size. */
async function verifyBundleFiles(bundleDir, manifest) {
  const filesRoot = join(bundleDir, FILES_DIRECTORY)
  const listed = new Set(manifest.files.map(entry => entry.path))
  for (const path of await listFiles(filesRoot)) {
    if (!listed.has(path)) throw new BackupError('INVALID_BACKUP', `bundle contains an unlisted file: ${path}`)
  }
  for (const entry of manifest.files) {
    const path = join(filesRoot, entry.path)
    if (!existsSync(path)) throw new BackupError('INTEGRITY_MISMATCH', `bundle is missing ${entry.path}`)
    const digest = await digestFile(path)
    if (digest.bytes !== entry.bytes || digest.sha256 !== entry.sha256) {
      throw new BackupError('INTEGRITY_MISMATCH', `bundle file ${entry.path} does not match its manifest digest or size`)
    }
  }
}

/**
 * Verify a bundle's manifest and file digests without writing anything.
 * @param bundleDir - Backup bundle directory.
 * @returns {Promise<object>} Verified manifest.
 */
export async function inspectBackupManifest(bundleDir) {
  const bundle = resolve(bundleDir)
  if (!existsSync(bundle)) throw new BackupError('BUNDLE_MISSING', `no backup bundle at ${bundle}`)
  const manifest = await readManifest(bundle)
  await verifyBundleFiles(bundle, manifest)
  return manifest
}

/**
 * Restore a bundle into a new empty data directory.
 *
 * Compatibility is checked on the verified bundle before writing, so an
 * unsupported Session format or metadata version never produces a partial
 * directory this build would refuse to start on.
 * @param {{ bundleDir: string, dataDir: string }} request - Bundle path and empty target directory.
 * @returns {Promise<{ manifest: object, compatibility: object }>} Restored manifest and compatibility report.
 */
export async function importDataDir({ bundleDir, dataDir }) {
  const bundle = resolve(bundleDir)
  const target = resolve(dataDir)
  const manifest = await inspectBackupManifest(bundle)
  const compatibility = await inspectDataDirectory(join(bundle, FILES_DIRECTORY))
  if (!compatibility.compatible) {
    throw new BackupError('INCOMPATIBLE_BACKUP', 'the bundle records a Session or metadata version this build cannot read')
  }
  if (existsSync(target)) {
    if ((await readdir(target)).length > 0) throw new BackupError('TARGET_NOT_EMPTY', `target data directory ${target} is not empty`)
  } else {
    await mkdir(target, { recursive: true })
  }
  try {
    for (const entry of manifest.files) {
      const destination = join(target, entry.path)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(join(bundle, FILES_DIRECTORY, entry.path), destination)
    }
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
  const restored = await listFiles(target)
  if (restored.length !== manifest.files.length) {
    throw new BackupError('INTEGRITY_MISMATCH', `restored ${String(restored.length)} files, expected ${String(manifest.files.length)}`)
  }
  return { manifest, compatibility }
}

/** Describe one bundle manifest as one operator-facing line. */
export function describeManifest(manifest) {
  const stores = manifest.stores
  return `${String(manifest.files.length)} files, ${String(stores.sessions.count)} Sessions, ${String(stores.workspaces.count)} Workspaces, ${String(stores.attachments.count)} attachments, ${String(stores.observability.accessDenials + stores.observability.usage)} journal records`
}
