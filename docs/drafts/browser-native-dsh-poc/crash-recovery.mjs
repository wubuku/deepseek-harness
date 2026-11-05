/**
 * Remove temporary files a killed process could not clean up.
 *
 * Every durable writer publishes through a temporary sibling and a rename, so a
 * SIGKILL can leave the temporary behind but never a partial published file.
 * Startup owns the data directory; removing these temporaries is what makes a
 * restart report "no orphan temporary files" and lets the same write be retried.
 * Staged attachment uploads are intentionally kept: `<uploadId>.part` under
 * `attachment-uploads-v1` is resumable state, not a temporary.
 */
import { readdir, rm } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const LOCK_PREFIX = '.browser-native-backend.lock'

/** One file the startup cleanup removed. */
function isOrphan(relativePath) {
  const parts = relativePath.split('/')
  const name = parts.at(-1)
  if (parts[0] === 'attachments-v1' && (name.endsWith('.part') || name.endsWith('.enc'))) return true
  if (name.startsWith(LOCK_PREFIX) && name.includes('.stale-')) return true
  return name.endsWith('.tmp') || name.endsWith('.rotate.tmp')
}

async function walk(root, directory, removed) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await walk(root, path, removed)
      continue
    }
    if (!entry.isFile()) continue
    const relativePath = relative(root, path).split(sep).join('/')
    if (!isOrphan(relativePath)) continue
    await rm(path, { force: true })
    removed.push(relativePath)
  }
}

/**
 * List temporaries an interrupted process left behind without deleting them.
 * @param dataDir - Data directory to inspect.
 * @returns Relative paths that startup cleanup would remove.
 */
export async function listOrphanTemporaries(dataDir) {
  const found = []
  await walk(dataDir, dataDir, found)
  return found.sort()
}

/**
 * Delete temporaries left by an interrupted process.
 * @param dataDir - Data directory whose owner lock this process holds.
 * @returns Relative paths that were removed, in walk order.
 */
export async function cleanupOrphanTemporaries(dataDir) {
  const removed = []
  await walk(dataDir, dataDir, removed)
  return removed.sort()
}
