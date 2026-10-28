/** Disposable, instance-private OPFS backing for committed read-only Workspace files. */
import type { VfsFileBacking } from '../../../packages/experimental/webworker-runtime/src/storage/types.ts'
import type { VerifiedDownload } from './browser-native-verified-download.ts'
import { Sha256 } from './browser-native-sha256.ts'

const IO_BYTES = 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Per-observer admission limits, checked before acquiring storage or downloading bytes. */
export interface ObserverCacheLimits {
  readonly maxFiles: number
  readonly maxBytes: number
}

/** Validated manifest content identity; aliases must agree on the complete byte length. */
export interface ObserverCacheEntry {
  readonly hash: string
  readonly bytes: number
}

type ObserverSyncHandle = Pick<FileSystemSyncAccessHandle, 'read' | 'write' | 'truncate' | 'flush' | 'close'>

/** Minimal OPFS operations, injectable for deterministic storage failure tests. */
export interface ObserverCacheDirectory {
  getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<ObserverCacheDirectory>
  getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<{
    createSyncAccessHandle(): Promise<ObserverSyncHandle>
  }>
  removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void>
  keys(): AsyncIterableIterator<string>
}

interface CachedFile {
  readonly handle: ObserverSyncHandle
  readonly bytes: number
  references: number
}

function validateEntries(entries: readonly ObserverCacheEntry[], limits: ObserverCacheLimits): Map<string, number> {
  if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1
    || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 0) {
    throw new Error('browser-native observer cache: invalid file or byte budget')
  }
  const unique = new Map<string, number>()
  let bytes = 0
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error('browser-native observer cache: invalid content identity')
    }
    const previous = unique.get(entry.hash)
    if (previous !== undefined) {
      if (previous !== entry.bytes) throw new Error('browser-native observer cache: aliases disagree on byte length')
      continue
    }
    unique.set(entry.hash, entry.bytes)
    bytes += entry.bytes
    if (!Number.isSafeInteger(bytes) || bytes > limits.maxBytes || unique.size > limits.maxFiles) {
      throw new Error('browser-native observer cache: manifest exceeds the per-observer storage budget')
    }
  }
  return unique
}

/**
 * Own one disposable directory and its liveness Web Lock. No writer metadata is accessed.
 * Handles are immutable to consumers; aliases share bytes until the final backing closes.
 * Call dispose after reads quiesce, or before abandoning a failed prepare. Worker termination
 * releases its lock; the next observer reclaims only unlocked directories for this Workspace.
 */
export class BrowserObserverCache {
  private readonly files = new Map<string, CachedFile>()
  private active: { readonly source: VerifiedDownload; readonly work: Promise<VfsFileBacking> } | undefined
  private disposed = false
  private disposal: Promise<void> | undefined

  private constructor(
    private readonly root: ObserverCacheDirectory,
    private readonly directory: ObserverCacheDirectory,
    private readonly name: string,
    private readonly entries: ReadonlyMap<string, number>,
    private readonly release: () => void,
    private readonly holding: Promise<void>,
  ) {}

  /**
   * Admit a manifest and acquire private storage, reclaiming only demonstrably inactive caches.
   * @param workspaceId - Authorized Workspace UUID.
   * @param entries - Committed file identities, including aliases.
   * @param limits - Per-instance unique file and byte limits.
   * @param environment - Optional OPFS/Web Locks provider for deterministic tests.
   * @returns A cache whose dispose method releases its directory and lock.
   */
  static async create(
    workspaceId: string,
    entries: readonly ObserverCacheEntry[],
    limits: ObserverCacheLimits,
    environment: { readonly root: () => Promise<ObserverCacheDirectory>; readonly locks: Pick<LockManager, 'request'> }
      = { root: () => navigator.storage.getDirectory(), locks: navigator.locks },
  ): Promise<BrowserObserverCache> {
    const admitted = validateEntries(entries, limits)
    if (!UUID.test(workspaceId)) throw new Error('browser-native observer cache: invalid Workspace UUID')
    const root: ObserverCacheDirectory = await environment.root()
    if (environment.locks === undefined) throw new Error('browser-native observer cache: Web Locks are required')
    const prefix = `dsh-observer-cache-v1-${workspaceId}-`
    for await (const name of root.keys()) {
      if (!name.startsWith(prefix) || !UUID.test(name.slice(prefix.length))) continue
      await environment.locks.request(name, { ifAvailable: true }, async lock => {
        if (lock === null) return
        try {
          await root.removeEntry(name, { recursive: true })
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
        }
      })
    }
    const name = `${prefix}${crypto.randomUUID()}`
    let release = (): void => {}
    let acquired = (): void => {}
    let failed = (error: unknown): void => { void error }
    const ready = new Promise<void>((resolveReady, rejectReady) => { acquired = resolveReady; failed = rejectReady })
    const holding = environment.locks.request(name, async () => {
      await new Promise<void>(resolveRelease => { release = resolveRelease; acquired() })
    })
    void holding.catch(failed)
    await ready
    try {
      const directory = await root.getDirectoryHandle(name, { create: true })
      return new BrowserObserverCache(root, directory, name, admitted, release, holding)
    } catch (error) {
      release()
      await holding
      throw error
    }
  }

  /**
   * Download sequential ranges, verify full SHA-256, then publish a synchronous backing.
   * @param hash - Identity admitted by create; concurrent downloads are rejected.
   * @param source - Consumer-owned sequential download, closed on every success or failure.
   * @returns An independent backing; failure never publishes partial bytes or resident fallback.
   */
  async open(hash: string, source: VerifiedDownload): Promise<VfsFileBacking> {
    try {
      this.assertOpen()
      if (this.active !== undefined) throw new Error('browser-native observer cache: concurrent download is not supported')
      const bytes = this.entries.get(hash)
      if (bytes === undefined) throw new Error('browser-native observer cache: content was not admitted')
      const existing = this.files.get(hash)
      if (existing !== undefined) return this.backing(hash, existing)
      const work = this.download(hash, bytes, source)
      this.active = { source, work }
      try {
        return await work
      } finally {
        this.active = undefined
      }
    } finally {
      await source.close()
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('browser-native observer cache: cache was disposed')
  }

  private async download(hash: string, bytes: number, source: VerifiedDownload): Promise<VfsFileBacking> {
    let handle: ObserverSyncHandle | undefined
    try {
      const entry = await this.directory.getFileHandle(hash, { create: true })
      this.assertOpen()
      handle = await entry.createSyncAccessHandle()
      this.assertOpen()
      handle.truncate(bytes)
      const digest = new Sha256()
      if (bytes === 0) {
        const empty = await source.read(0, 0)
        this.assertOpen()
        if (empty.byteLength !== 0) throw new Error('browser-native observer cache: invalid empty file')
      }
      for (let offset = 0; offset < bytes; offset += IO_BYTES) {
        const length = Math.min(IO_BYTES, bytes - offset)
        const chunk = await source.read(offset, length)
        this.assertOpen()
        if (chunk.byteLength !== length) throw new Error('browser-native observer cache: short download range')
        digest.update(chunk)
        if (handle.write(chunk, { at: offset }) !== length) throw new Error('browser-native observer cache: short OPFS write')
      }
      if (digest.digestHex() !== hash) throw new Error('browser-native observer cache: full SHA-256 mismatch')
      handle.flush()
      this.assertOpen()
      const file: CachedFile = { handle, bytes, references: 0 }
      this.files.set(hash, file)
      return this.backing(hash, file)
    } catch (error) {
      handle?.close()
      try {
        await this.directory.removeEntry(hash)
      } catch (cleanupError) {
        if (!(cleanupError instanceof DOMException) || cleanupError.name !== 'NotFoundError') {
          throw new AggregateError([error, cleanupError], 'browser-native observer cache: download and partial cleanup failed')
        }
      }
      throw error
    }
  }

  private backing(hash: string, file: CachedFile): VfsFileBacking {
    file.references += 1
    let closed = false
    return {
      size: file.bytes,
      reference: { hash, bytes: file.bytes },
      read: (position, length) => {
        this.assertOpen()
        if (closed) throw new Error('browser-native observer cache: backing was closed')
        if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0) {
          throw new RangeError('browser-native observer cache: invalid read range')
        }
        const output = new Uint8Array(Math.min(length, Math.max(0, file.bytes - position)))
        if (file.handle.read(output, { at: position }) !== output.byteLength) throw new Error('browser-native observer cache: short OPFS read')
        return output
      },
      close: () => {
        if (closed) return
        closed = true
        file.references -= 1
        if (file.references === 0 && this.files.get(hash) === file) {
          file.handle.close()
          this.files.delete(hash)
        }
      },
    }
  }

  /**
   * Stop downloads, close handles, delete only this directory, and release the liveness lock.
   * @returns Idempotent cleanup; failures preserve the error and still release the lock.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.disposal = (async () => {
      try {
        if (this.active !== undefined) {
          const active = this.active
          await active.source.close()
          await Promise.allSettled([active.work])
        }
        for (const file of this.files.values()) file.handle.close()
        this.files.clear()
        await this.root.removeEntry(this.name, { recursive: true })
      } finally {
        this.release()
        await this.holding
      }
    })()
    return this.disposal
  }
}
