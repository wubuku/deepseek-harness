import { requireActiveModuleLoader, type StaticModuleFactory } from '../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {
  FileAttachmentRef, ImageAttachmentLimits, ImageAttachmentRef, ImageRequestTarget,
  RequestImageAttachment, SaveFileAttachment, SaveFileStreamAttachment, SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { MemoryVfs } from '../../../packages/experimental/webworker-runtime/src/storage/memory.ts'
import type { BrowserNativeWorkspaceRuntime } from './browser-native-workspace.ts'
import { Sha256 } from './browser-native-sha256.ts'

const OPFS_DIRECTORY = 'dsh-browser-native-attachments-v1'
const MAX_FILE_BYTES = 64 * 1024 * 1024
const OPFS_WRITE_CHUNK_BYTES = 64 * 1024
const ATTACHMENT_API = '/api/browser-native/workspace/attachments'
const FILE_ID_PATTERN = /^sha256:([a-f0-9]{64})$/
const TEMPORARY_FILE_PATTERN = /^(upload|download)-([0-9a-f-]{36})(?:\.crswap)?$/iu
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

interface RuntimeAttachmentModule {
  readonly AttachmentStore: typeof import('@deepseek-ai/dsh-attachment').AttachmentStore
  readonly AttachmentError: typeof import('@deepseek-ai/dsh-attachment').AttachmentError
  readonly AttachmentId: typeof import('@deepseek-ai/dsh-attachment').AttachmentId
}

interface RuntimeLoader {
  requireFrom(path: string): (specifier: string) => unknown
}

interface FileRefUploadResponse {
  readonly attachmentId?: unknown
  readonly name?: unknown
  readonly bytes?: unknown
  readonly error?: { readonly message?: unknown; readonly code?: unknown }
}

interface OpfsWorkspaceDirectory {
  readonly directory: FileSystemDirectoryHandle
  readonly files: Map<string, FileSystemFileHandle>
  ready: Promise<void>
}

interface SharedOpfsBacking {
  readonly handle: FileSystemSyncAccessHandle
  readonly size: number
  references: number
}

/** Worker module and history hydrator sharing one OPFS/VFS attachment cache. */
export interface BrowserNativeAttachmentModule {
  readonly factory: StaticModuleFactory
  /** Reconcile abandoned staging files in the active Workspace OPFS directory. */
  reconcileTemporaryFiles(): Promise<void>
  ensureSessionFiles(
    events: readonly import('@deepseek-ai/dsh-session').SessionEvent[],
    signal?: AbortSignal,
  ): Promise<void>
}

/** Optional Worker-only hooks for deterministic attachment lifecycle tests. */
export interface BrowserNativeAttachmentTestHooks {
  readonly afterOpfsStagingWrite?: (bytesWritten: number, signal?: AbortSignal) => Promise<void>
  /** Expose module lifecycle probes only when the Worker test port is enabled. */
  readonly onModuleReady?: (module: BrowserNativeAttachmentModule) => void
}

function loaderRequire(): (specifier: string) => unknown {
  return (requireActiveModuleLoader() as RuntimeLoader).requireFrom('/dsh')
}

function runtimeAttachments(): RuntimeAttachmentModule {
  return loaderRequire()('@deepseek-ai/dsh-attachment') as RuntimeAttachmentModule
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let used = 0
  let prefix = ''
  for (const character of value) {
    const size = new TextEncoder().encode(character).byteLength
    if (used + size > maximumBytes) break
    prefix += character
    used += size
  }
  return prefix
}

function fileLeafName(value: string | undefined): string {
  if (value === undefined) return 'file'
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  let clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"|?*]/g, '_').trim().replace(/[. ]+$/u, '')
  const dot = clean.indexOf('.')
  const stem = (dot < 0 ? clean : clean.slice(0, dot)).replace(/[. ]+$/u, '')
  if (WINDOWS_DEVICE_NAME.test(stem)) clean = `_${clean}`
  clean = utf8Prefix(clean, 255).replace(/[. ]+$/u, '')
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean
}

function assertFileReference(value: FileAttachmentRef): string {
  const match = FILE_ID_PATTERN.exec(String(value.attachmentId))
  if (match?.[1] === undefined || value.name !== fileLeafName(value.name)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_FILE_BYTES) {
    throw new Error('browser-native attachments: file reference is invalid')
  }
  return match[1]
}

function filePath(ref: FileAttachmentRef): string {
  const hash = assertFileReference(ref)
  return `/dsh/home/attachments/v1/files/${hash.slice(0, 2)}/${hash}/${ref.name}`
}

function temporaryFileLockName(workspaceId: string, fileName: string): string {
  return `dsh-browser-native-attachment-temp:${workspaceId}:${fileName}`
}

async function withTemporaryFileLock<T>(
  workspaceId: string,
  fileName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const locks = globalThis.navigator?.locks
  if (typeof locks?.request !== 'function') return await operation()
  return await locks.request(temporaryFileLockName(workspaceId, fileName), { mode: 'exclusive' }, operation)
}

function readResponseError(value: FileRefUploadResponse, fallback: string): string {
  return typeof value.error?.message === 'string' ? value.error.message : fallback
}

function workspaceIdOf(workspace: BrowserNativeWorkspaceRuntime): string {
  const id = workspace.getWorkspaceId()
  if (id === undefined || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error('browser-native attachments: Workspace identity is unavailable')
  }
  return id
}

function digestStreamChunk(digest: Sha256, bytes: Uint8Array, total: number): number {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('browser-native attachments: upload stream yielded a non-byte chunk')
  if (bytes.byteLength > MAX_FILE_BYTES - total) throw new RangeError('browser-native attachments: file exceeds the 64 MiB PoC limit')
  digest.update(bytes)
  return total + bytes.byteLength
}

async function writeStreamToOpfs(
  directory: FileSystemDirectoryHandle,
  file: FileSystemFileHandle,
  data: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
  afterStagingWrite?: (signal?: AbortSignal) => Promise<void>,
): Promise<{ readonly hash: string; readonly bytes: number }> {
  const writer = await file.createWritable({ keepExistingData: false })
  const digest = new Sha256()
  let bytes = 0
  let stagedBytes = 0
  try {
    for await (const chunk of data) {
      signal?.throwIfAborted()
      bytes = digestStreamChunk(digest, chunk, bytes)
      for (let offset = 0; offset < chunk.byteLength; offset += OPFS_WRITE_CHUNK_BYTES) {
        signal?.throwIfAborted()
        const part = chunk.subarray(offset, Math.min(offset + OPFS_WRITE_CHUNK_BYTES, chunk.byteLength))
        await writer.write(part)
        stagedBytes += part.byteLength
        await afterStagingWrite?.(stagedBytes, signal)
      }
    }
    signal?.throwIfAborted()
    await writer.close()
    return { hash: digest.digestHex(), bytes }
  } catch (error) {
    await writer.abort(error).catch(() => {})
    await directory.removeEntry(file.name).catch(() => {})
    throw error
  }
}

async function verifyFile(file: File, expectedHash: string, expectedBytes: number, signal?: AbortSignal): Promise<void> {
  if (file.size !== expectedBytes) throw new Error('browser-native attachments: cached file size does not match its reference')
  const digest = new Sha256()
  const reader = file.stream().getReader()
  let bytes = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const item = await reader.read()
      if (item.done) break
      bytes += item.value.byteLength
      digest.update(item.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (bytes !== expectedBytes || digest.digestHex() !== expectedHash) {
    throw new Error('browser-native attachments: cached file failed SHA-256 verification')
  }
}

async function* chunksFromFile(file: File, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  const reader = file.stream().getReader()
  try {
    while (true) {
      signal?.throwIfAborted()
      const item = await reader.read()
      if (item.done) return
      yield item.value
    }
  } finally {
    reader.releaseLock()
  }
}

function syncBacking(backing: SharedOpfsBacking, hash: string, bytes: number, release: () => void) {
  backing.references += 1
  let closed = false
  return {
    size: bytes,
    reference: { hash, bytes },
    read(position: number, length: number): Uint8Array {
      if (closed) throw new Error('browser-native attachments: OPFS backing is closed')
      const output = new Uint8Array(length)
      const count = backing.handle.read(output, { at: position })
      return output.subarray(0, count)
    },
    close(): void {
      if (closed) return
      closed = true
      backing.references -= 1
      if (backing.references === 0) {
        backing.handle.close()
        release()
      }
    },
  }
}

function collectFileReferences(events: readonly import('@deepseek-ai/dsh-session').SessionEvent[]): FileAttachmentRef[] {
  const refs: FileAttachmentRef[] = []
  for (const event of events) {
    if (event.type !== 'user/message' || !Array.isArray(event.data.content)) continue
    for (const block of event.data.content) {
      if (block.type === 'file') refs.push(block.attachment)
    }
  }
  return refs
}

/** Build the Worker-only AttachmentStore provider and its Session history hydrator. */
export function createBrowserNativeAttachmentModule(
  workspace: BrowserNativeWorkspaceRuntime,
  testHooks: BrowserNativeAttachmentTestHooks = {},
): BrowserNativeAttachmentModule {
  let module: unknown
  let hydrateSessionFiles: ((
    events: readonly import('@deepseek-ai/dsh-session').SessionEvent[],
    signal?: AbortSignal,
  ) => Promise<void>) | undefined
  let reconcileAttachmentTemps: (() => Promise<void>) | undefined
  const factory: StaticModuleFactory = () => {
    if (module !== undefined) return module
    const { AttachmentStore, AttachmentError, AttachmentId } = runtimeAttachments()
    const filesByWorkspace = new Map<string, OpfsWorkspaceDirectory>()
    const backings = new Map<string, SharedOpfsBacking>()
    const seededPaths = new Set<string>()
    const vfs = workspace.vfs
    if (!(vfs instanceof MemoryVfs)) throw new Error('browser-native attachments: Worker VFS runtime identity differs')

    class BrowserNativeAttachmentStore extends AttachmentStore {
      override readonly imageLimits: ImageAttachmentLimits = {
        maxImageBytes: 1,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1,
        maxImagePixels: 1,
        maxImageDimension: 1,
        mediaTypes: [],
      }

      constructor(ctx: Context) {
        super(ctx)
      }

      override async validateImage(input: SaveImageAttachment): Promise<void> {
        void input
        throw new AttachmentError('Browser-native PoC does not support image attachments.', 'ATTACHMENT_FILES_UNSUPPORTED')
      }

      override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        void input
        throw new AttachmentError('Browser-native PoC does not support image attachments.', 'ATTACHMENT_FILES_UNSUPPORTED')
      }

      override async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
        void ref
        signal?.throwIfAborted()
        throw new AttachmentError('Browser-native PoC does not support image attachments.', 'ATTACHMENT_FILES_UNSUPPORTED')
      }

      override async saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
        const data = input.data
        return await this.saveFileStream({
          data: (async function* (): AsyncGenerator<Uint8Array> { yield data })(),
          ...(input.name === undefined ? {} : { name: input.name }),
        })
      }

      override async saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
        input.signal?.throwIfAborted()
        const workspaceId = workspaceIdOf(workspace)
        const displayName = fileLeafName(input.name)
        const directory = await opfsWorkspace(workspaceId)
        const temporaryName = `upload-${crypto.randomUUID()}`
        return await withTemporaryFileLock(workspaceId, temporaryName, async () => {
          const temporary = await directory.directory.getFileHandle(temporaryName, { create: true })
          const stored = await writeStreamToOpfs(
            directory.directory,
            temporary,
            input.data,
            input.signal,
            testHooks.afterOpfsStagingWrite,
          )
          const ref: FileAttachmentRef = {
            attachmentId: AttachmentId(`sha256:${stored.hash}`),
            name: displayName,
            bytes: stored.bytes,
          }
          const object = await publishLocalObject(directory, temporary, stored.hash, stored.bytes)
          await uploadObject(workspaceId, object, ref, input.signal)
          await mountFile(directory, ref, stored.hash)
          return ref
        })
      }

      override async *readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array> {
        await ensureAttachmentFile(ref, signal)
        const hash = assertFileReference(ref)
        const directory = await opfsWorkspace(workspaceIdOf(workspace))
        const object = await directory.directory.getFileHandle(hash)
        const file = await object.getFile()
        const digest = new Sha256()
        let bytes = 0
        for await (const chunk of chunksFromFile(file, signal)) {
          bytes += chunk.byteLength
          digest.update(chunk)
          yield chunk
        }
        signal?.throwIfAborted()
        if (bytes !== ref.bytes || digest.digestHex() !== hash) {
          throw new AttachmentError('Stored browser attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
        }
      }

      override fileHostPath(ref: FileAttachmentRef): string {
        return filePath(ref)
      }

      async ensureFile(ref: FileAttachmentRef): Promise<void> {
        await ensureAttachmentFile(ref)
      }

      async ensureSessionFiles(events: readonly import('@deepseek-ai/dsh-session').SessionEvent[]): Promise<void> {
        await hydrateSessionFilesForEvents(events)
      }

      override imageHostPath(ref: ImageAttachmentRef): undefined {
        void ref
        return undefined
      }

      override readImageRequest(
        ref: ImageAttachmentRef,
        target: ImageRequestTarget,
        signal?: AbortSignal,
      ): Promise<RequestImageAttachment> {
        void ref
        void target
        signal?.throwIfAborted()
        return Promise.reject(new AttachmentError('Browser-native PoC does not support image attachments.', 'ATTACHMENT_FILES_UNSUPPORTED'))
      }
    }

    async function ensureAttachmentFile(ref: FileAttachmentRef, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted()
      const hash = assertFileReference(ref)
      const directory = await opfsWorkspace(workspaceIdOf(workspace))
      let object: FileSystemFileHandle
      try {
        object = await directory.directory.getFileHandle(hash)
        await verifyFile(await object.getFile(), hash, ref.bytes, signal)
      } catch {
        signal?.throwIfAborted()
        await downloadObject(workspaceIdOf(workspace), directory, ref, hash, signal)
        object = await directory.directory.getFileHandle(hash)
      }
      signal?.throwIfAborted()
      await mountFile(directory, ref, hash, object)
    }

    async function hydrateSessionFilesForEvents(
      events: readonly import('@deepseek-ai/dsh-session').SessionEvent[],
      signal?: AbortSignal,
    ): Promise<void> {
      const refs = new Map<string, FileAttachmentRef>()
      for (const ref of collectFileReferences(events)) refs.set(`${String(ref.attachmentId)}:${ref.name}`, ref)
      for (const ref of refs.values()) {
        signal?.throwIfAborted()
        await ensureAttachmentFile(ref, signal)
      }
    }

    async function opfsWorkspace(workspaceId: string): Promise<OpfsWorkspaceDirectory> {
      let value = filesByWorkspace.get(workspaceId)
      if (value !== undefined) {
        await value.ready
        return value
      }
      const storage = globalThis.navigator?.storage
      if (storage === undefined || typeof storage.getDirectory !== 'function') {
        throw new Error('browser-native attachments: OPFS is unavailable in this Worker')
      }
      const root = await storage.getDirectory()
      const namespace = await root.getDirectoryHandle(OPFS_DIRECTORY, { create: true })
      const directory = await namespace.getDirectoryHandle(workspaceId, { create: true })
      value = { directory, files: new Map(), ready: Promise.resolve() }
      filesByWorkspace.set(workspaceId, value)
      value.ready = cleanupTemporaryFiles(directory, workspaceId)
      await value.ready
      return value
    }

    async function cleanupTemporaryFiles(directory: FileSystemDirectoryHandle, workspaceId: string): Promise<void> {
      const locks = globalThis.navigator?.locks
      if (typeof locks?.request !== 'function') return
      const candidates = new Set<string>()
      for await (const [name, entry] of directory.entries()) {
        if (entry.kind !== 'file') continue
        const match = TEMPORARY_FILE_PATTERN.exec(name)
        if (match?.[1] !== undefined && match[2] !== undefined) candidates.add(`${match[1]}-${match[2]}`)
      }
      for (const fileName of candidates) {
        await locks.request(
          temporaryFileLockName(workspaceId, fileName),
          { mode: 'exclusive', ifAvailable: true },
          async lock => {
            if (lock === null) return
            await directory.removeEntry(fileName).catch(() => {})
            await directory.removeEntry(`${fileName}.crswap`).catch(() => {})
          },
        )
      }
    }

    async function publishLocalObject(
      directory: OpfsWorkspaceDirectory,
      temporary: FileSystemFileHandle,
      hash: string,
      bytes: number,
    ): Promise<FileSystemFileHandle> {
      let target: FileSystemFileHandle
      try {
        target = await directory.directory.getFileHandle(hash)
        await verifyFile(await target.getFile(), hash, bytes)
        await directory.directory.removeEntry(temporary.name)
        return target
      } catch {
        target = await directory.directory.getFileHandle(hash, { create: true })
      }
      const source = await temporary.getFile()
      const writer = await target.createWritable({ keepExistingData: false })
      const reader = source.stream().getReader()
      try {
        while (true) {
          const item = await reader.read()
          if (item.done) break
          for (let offset = 0; offset < item.value.byteLength; offset += OPFS_WRITE_CHUNK_BYTES) {
            await writer.write(item.value.subarray(offset, Math.min(offset + OPFS_WRITE_CHUNK_BYTES, item.value.byteLength)))
          }
        }
        await writer.close()
      } catch (error) {
        await writer.abort(error).catch(() => {})
        throw error
      } finally {
        reader.releaseLock()
      }
      await directory.directory.removeEntry(temporary.name)
      await verifyFile(await target.getFile(), hash, bytes)
      return target
    }

    async function uploadObject(
      workspaceId: string,
      file: FileSystemFileHandle,
      ref: FileAttachmentRef,
      signal?: AbortSignal,
    ): Promise<void> {
      const url = new URL(`${ATTACHMENT_API}/${assertFileReference(ref)}`, globalThis.location.origin)
      url.searchParams.set('workspaceId', workspaceId)
      url.searchParams.set('name', ref.name)
      const response = await fetch(url, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream' },
        body: await file.getFile(),
        ...(signal === undefined ? {} : { signal }),
      })
      const value = await response.json() as FileRefUploadResponse
      if (!response.ok) throw new Error(readResponseError(value, `attachment upload failed with HTTP ${String(response.status)}`))
      if (value.attachmentId !== ref.attachmentId || value.name !== ref.name || value.bytes !== ref.bytes) {
        throw new Error('browser-native attachments: backend upload receipt differs from the local file')
      }
    }

    async function downloadObject(
      workspaceId: string,
      directory: OpfsWorkspaceDirectory,
      ref: FileAttachmentRef,
      hash: string,
      signal?: AbortSignal,
    ): Promise<void> {
      const url = new URL(`${ATTACHMENT_API}/${hash}`, globalThis.location.origin)
      url.searchParams.set('workspaceId', workspaceId)
      const response = await fetch(url, { credentials: 'same-origin', ...(signal === undefined ? {} : { signal }) })
      const responseBody = response.body
      if (!response.ok || responseBody === null) {
        const detail = await response.json().catch(() => ({})) as FileRefUploadResponse
        throw new Error(readResponseError(detail, `attachment download failed with HTTP ${String(response.status)}`))
      }
      const temporaryName = `download-${crypto.randomUUID()}`
      await withTemporaryFileLock(workspaceId, temporaryName, async () => {
        const temporary = await directory.directory.getFileHandle(temporaryName, { create: true })
        const writer = await temporary.createWritable({ keepExistingData: false })
        const reader = responseBody.getReader()
        const digest = new Sha256()
        let bytes = 0
        try {
          while (true) {
            const item = await reader.read()
            if (item.done) break
            bytes = digestStreamChunk(digest, item.value, bytes)
            await writer.write(item.value)
          }
          if (bytes !== ref.bytes || digest.digestHex() !== hash) {
            throw new Error('browser-native attachments: downloaded file failed SHA-256 verification')
          }
          await writer.close()
        } catch (error) {
          await writer.abort(error).catch(() => {})
          await directory.directory.removeEntry(temporary.name).catch(() => {})
          throw error
        } finally {
          reader.releaseLock()
        }
        await publishLocalObject(directory, temporary, hash, ref.bytes)
      })
    }

    async function mountFile(
      directory: OpfsWorkspaceDirectory,
      ref: FileAttachmentRef,
      hash: string,
      file?: FileSystemFileHandle,
    ): Promise<void> {
      const path = filePath(ref)
      if (seededPaths.has(path)) return
      let backing = backings.get(hash)
      if (backing === undefined) {
        const object = file ?? await directory.directory.getFileHandle(hash)
        const handle = await object.createSyncAccessHandle()
        backing = { handle, size: ref.bytes, references: 0 }
        backings.set(hash, backing)
      }
      if (backing.size !== ref.bytes) throw new Error('browser-native attachments: same digest has conflicting byte length')
      vfs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
      const reference = syncBacking(backing, hash, ref.bytes, () => {
        if (backings.get(hash) === backing) backings.delete(hash)
      })
      try {
        vfs.seedExternal(path, reference, { mode: 0o444 })
        seededPaths.add(path)
      } catch (error) {
        reference.close()
        throw error
      }
    }

    module = {
      default: BrowserNativeAttachmentStore,
      BrowserNativeAttachmentStore,
    }
    hydrateSessionFiles = hydrateSessionFilesForEvents
    reconcileAttachmentTemps = async () => {
      const workspaceId = workspaceIdOf(workspace)
      const directory = await opfsWorkspace(workspaceId)
      await cleanupTemporaryFiles(directory.directory, workspaceId)
    }
    return module
  }
  return {
    factory,
    async reconcileTemporaryFiles(): Promise<void> {
      factory()
      if (reconcileAttachmentTemps === undefined) {
        throw new Error('browser-native attachments: temporary file reconciler is unavailable')
      }
      await reconcileAttachmentTemps()
    },
    async ensureSessionFiles(events, signal): Promise<void> {
      factory()
      if (hydrateSessionFiles === undefined) throw new Error('browser-native attachments: Session hydrator is unavailable')
      await hydrateSessionFiles(events, signal)
    },
  }
}
