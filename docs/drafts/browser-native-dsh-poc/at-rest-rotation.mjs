/**
 * Re-encrypt every at-rest surface under the cipher's active key.
 *
 * The backend adds a successor key and activates it before calling this, so new
 * writes already use it while existing files are rewritten atomically one by
 * one. Files that still need the predecessor stay readable because the keyring
 * holds every key until the caller retires them after this run succeeds. A
 * failure leaves a mixed directory that any keyring with both keys can read;
 * only a complete, verified run updates the key-check sample, which lets a
 * restart with the successor alone accept the directory.
 */
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { AtRestError, envelopeKeyId, writeAtRestKeyCheck } from './at-rest-crypto.mjs'
import { applyStorageFault } from './storage-fault.mjs'

const HASH_PATTERN = /^[a-f0-9]{64}$/
const BLOB_PREFIX_PATTERN = /^[a-f0-9]{2}$/

async function entries(directory) {
  return await readdir(directory, { withFileTypes: true }).catch(() => [])
}

/**
 * List every stored file an at-rest rotation must rewrite.
 * @param dataDir - Backend data directory.
 * @returns `{path, context, surface}` entries for Sessions, archived Sessions,
 * Workspace blobs, chunk objects, attachment objects, and attachment staging parts.
 */
export async function listAtRestTargets(dataDir) {
  const targets = []
  const sessionsDir = join(dataDir, 'sessions')
  for (const entry of await entries(sessionsDir)) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      targets.push({
        path: join(sessionsDir, entry.name),
        context: `session/${entry.name}`,
        surface: 'sessions',
      })
    }
  }

  const archiveDir = join(dataDir, 'archives-v1')
  for (const entry of await entries(archiveDir)) {
    if (!entry.isFile()) continue
    if (entry.name.endsWith('.json.gz')) {
      targets.push({
        path: join(archiveDir, entry.name),
        context: `archive/${entry.name}`,
        surface: 'archives',
      })
    } else if (entry.name === 'index.json') {
      targets.push({
        path: join(archiveDir, entry.name),
        context: 'archive-index/index.json',
        surface: 'archives',
      })
    }
  }

  const blobsDir = join(dataDir, 'workspace-v2', 'blobs')
  for (const prefix of await entries(blobsDir)) {
    if (!prefix.isDirectory() || !BLOB_PREFIX_PATTERN.test(prefix.name)) continue
    for (const entry of await entries(join(blobsDir, prefix.name))) {
      if (!entry.isFile() || !HASH_PATTERN.test(entry.name)) continue
      targets.push({
        path: join(blobsDir, prefix.name, entry.name),
        context: `workspace-blob:${entry.name}`,
        surface: 'blobs',
      })
    }
  }

  const chunkRoot = join(dataDir, 'workspace-v2', 'chunk-objects')
  for (const prefix of await entries(join(chunkRoot, 'chunks'))) {
    if (!prefix.isDirectory() || !BLOB_PREFIX_PATTERN.test(prefix.name)) continue
    for (const entry of await entries(join(chunkRoot, 'chunks', prefix.name))) {
      if (!entry.isFile() || !HASH_PATTERN.test(entry.name)) continue
      const path = join(chunkRoot, 'chunks', prefix.name, entry.name)
      targets.push({
        path,
        context: `workspace-chunk-object:${relative(chunkRoot, path)}`,
        surface: 'chunks',
      })
    }
  }
  for (const entry of await entries(join(chunkRoot, 'files'))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = join(chunkRoot, 'files', entry.name)
    targets.push({
      path,
      context: `workspace-chunk-object:${relative(chunkRoot, path)}`,
      surface: 'chunks',
    })
  }

  for (const store of [['attachments-v1', 'attachments'], ['attachment-uploads-v1', 'uploads']]) {
    const [directoryName, surface] = store
    for (const workspace of await entries(join(dataDir, directoryName))) {
      if (!workspace.isDirectory()) continue
      if (surface === 'attachments') {
        for (const prefix of await entries(join(dataDir, directoryName, workspace.name))) {
          if (!prefix.isDirectory() || !BLOB_PREFIX_PATTERN.test(prefix.name)) continue
          for (const entry of await entries(join(dataDir, directoryName, workspace.name, prefix.name))) {
            if (!entry.isFile() || !HASH_PATTERN.test(entry.name)) continue
            targets.push({
              path: join(dataDir, directoryName, workspace.name, prefix.name, entry.name),
              context: `attachment/${workspace.name}/${entry.name}`,
              surface,
            })
          }
        }
        continue
      }
      for (const entry of await entries(join(dataDir, directoryName, workspace.name))) {
        if (!entry.isFile() || !entry.name.endsWith('.part')) continue
        targets.push({
          path: join(dataDir, directoryName, workspace.name, entry.name),
          context: `attachment-upload/${workspace.name}/${entry.name.slice(0, -'.part'.length)}`,
          surface,
        })
      }
    }
  }
  return targets
}

/**
 * Rewrite one file under the active key, keeping its bytes when already current.
 * @param target - Entry from {@link listAtRestTargets}.
 * @param cipher - Cipher whose active key encrypts new writes.
 * @returns `'current'`, `'reencrypted'`, `'encrypted'`, or `'missing'`.
 */
async function reencryptTarget(target, cipher) {
  const info = await stat(target.path).catch(() => undefined)
  if (info === undefined || !info.isFile()) return 'missing'
  const bytes = await readFile(target.path)
  const storedKeyId = envelopeKeyId(bytes)
  if (storedKeyId === cipher.keyId) return 'current'
  const plaintext = storedKeyId === undefined ? bytes : cipher.decryptBuffer(bytes, target.context)
  const temporary = `${target.path}.${randomUUID()}.rotate.tmp`
  try {
    await cipher.writeFile(temporary, plaintext, target.context, info.mode & 0o777)
    await rename(temporary, target.path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return storedKeyId === undefined ? 'encrypted' : 'reencrypted'
}

/**
 * Re-encrypt all stored surfaces under the cipher's active key.
 *
 * Sessions, Workspace blobs and chunks, attachment objects, and attachment
 * staging are rewritten atomically. The observability journal rewrites its own
 * ledgers on its append chain when supplied. Success requires every listed file
 * to carry the active key id before the key-check sample is replaced.
 * @param options - Rotation location and cipher.
 * @param options.dataDir - Backend data directory.
 * @param options.cipher - Cipher whose active key is the rotation target.
 * @param options.journal - Observability journal exposing `reencrypt`.
 * @param options.storageFault - Optional durable-write fault hook.
 * @returns Per-surface file counts and the target key id.
 */
export async function rotateAtRestData({ dataDir, cipher, journal, storageFault }) {
  if (cipher === undefined) throw new AtRestError('AT_REST_KEY_REQUIRED', 'at-rest rotation requires a configured key')
  const targetKeyId = cipher.keyId
  const targets = await listAtRestTargets(dataDir)
  const files = { sessions: 0, blobs: 0, chunks: 0, attachments: 0, uploads: 0 }
  let reencrypted = 0
  let skipped = 0
  for (const target of targets) {
    await applyStorageFault(storageFault, 'rotation')
    const outcome = await reencryptTarget(target, cipher)
    if (outcome === 'missing') {
      skipped += 1
      continue
    }
    files[target.surface] += 1
    if (outcome !== 'current') reencrypted += 1
  }
  const journalCount = journal === undefined ? 0 : await journal.reencrypt()
  const remaining = []
  for (const target of targets) {
    const bytes = await readFile(target.path).catch(() => undefined)
    if (bytes === undefined) continue
    if (envelopeKeyId(bytes) !== targetKeyId) remaining.push(target.context)
  }
  if (remaining.length > 0) {
    throw new AtRestError('AT_REST_ROTATION_INCOMPLETE',
      `at-rest rotation left ${String(remaining.length)} file(s) outside key ${targetKeyId}: ${remaining.slice(0, 5).join(', ')}`)
  }
  await writeAtRestKeyCheck(dataDir, cipher)
  return { targetKeyId, files: { ...files, journal: journalCount }, reencrypted, skipped }
}
