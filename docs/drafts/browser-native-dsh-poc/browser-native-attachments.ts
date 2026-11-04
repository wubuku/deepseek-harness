import { requireActiveModuleLoader, type StaticModuleFactory } from '../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {
  FileAttachmentRef, ImageAttachmentLimits, ImageAttachmentRef, SaveFileAttachment, SaveFileStreamAttachment,
  SaveImageAttachment, StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { MemoryVfs } from '../../../packages/experimental/webworker-runtime/src/storage/memory.ts'
import type { BrowserNativeWorkspaceRuntime } from './browser-native-workspace.ts'
import { Sha256 } from './browser-native-sha256.ts'

const OPFS_DIRECTORY = 'dsh-browser-native-attachments-v1'
const MAX_FILE_BYTES = 64 * 1024 * 1024
const OPFS_WRITE_CHUNK_BYTES = 64 * 1024
const CHUNKED_UPLOAD_THRESHOLD_BYTES = 8 * 1024 * 1024
const ATTACHMENT_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
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

interface ChunkedUploadBeginResponse {
  readonly uploadId?: unknown
  readonly chunkBytes?: unknown
  readonly error?: { readonly message?: unknown; readonly code?: unknown }
}

interface ChunkedUploadChunkResponse {
  readonly received?: unknown
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
  /** Report whether an object verification re-read the file or matched the verification cache. */
  readonly onAttachmentVerify?: (hash: string, mode: 'full' | 'cached') => void
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

const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 200 * 1024 * 1024,
  maxImagePixels: 64_000_000,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

interface ParsedImage {
  readonly mediaType: string
  readonly width: number
  readonly height: number
}

/**
 * Header-only image probe: no decode, so stored bytes stay byte-identical to
 * the upload. Returns `undefined` for an unrecognized container.
 */
function parseImageBytes(data: Uint8Array): ParsedImage | undefined {
  const png = data.length >= 26 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
  if (png) {
    return {
      mediaType: 'image/png',
      width: readUint32(data, 16),
      height: readUint32(data, 20),
    }
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = data[offset + 1]
      if (marker === undefined) break
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          mediaType: 'image/jpeg',
          width: readUint16(data, offset + 7),
          height: readUint16(data, offset + 5),
        }
      }
      const length = readUint16(data, offset + 2)
      if (length < 2) break
      offset += 2 + length
    }
  }
  if (data.length >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return {
      mediaType: 'image/gif',
      width: readUint16LittleEndian(data, 6),
      height: readUint16LittleEndian(data, 8),
    }
  }
  if (data.length >= 30 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    const chunk = String.fromCharCode(data[12] ?? 0, data[13] ?? 0, data[14] ?? 0, data[15] ?? 0)
    if (chunk === 'VP8X') {
      return {
        mediaType: 'image/webp',
        width: readUint24LittleEndian(data, 24) + 1,
        height: readUint24LittleEndian(data, 27) + 1,
      }
    }
    if (chunk === 'VP8L' && data.length >= 26) {
      const b1 = data[21] ?? 0
      const b2 = data[22] ?? 0
      const b3 = data[23] ?? 0
      const b4 = data[24] ?? 0
      const bits = b1 | (b2 << 8) | (b3 << 16) | (b4 << 24)
      return {
        mediaType: 'image/webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      }
    }
    if (chunk === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
      return {
        mediaType: 'image/webp',
        width: readUint16LittleEndian(data, 26) & 0x3fff,
        height: readUint16LittleEndian(data, 28) & 0x3fff,
      }
    }
  }
  return undefined
}

function readUint16(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0)
}

function readUint16LittleEndian(data: Uint8Array, offset: number): number {
  return ((data[offset + 1] ?? 0) << 8) | (data[offset] ?? 0)
}

function readUint24LittleEndian(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8) | ((data[offset + 2] ?? 0) << 16)
}

function readUint32(data: Uint8Array, offset: number): number {
  return (((data[offset] ?? 0) << 24) | ((data[offset + 1] ?? 0) << 16)
    | ((data[offset + 2] ?? 0) << 8) | (data[offset + 3] ?? 0)) >>> 0
}

function imageObjectName(ref: ImageAttachmentRef): string {
  const hash = String(ref.attachmentId).slice('sha256:'.length)
  return fileLeafName(`${hash.slice(0, 16)}.${IMAGE_EXTENSIONS[ref.mediaType] ?? 'bin'}`)
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
    const verifiedObjects = new Map<string, { readonly bytes: number; readonly lastModified: number }>()
    const seededPaths = new Set<string>()
    const vfs = workspace.vfs
    if (!(vfs instanceof MemoryVfs)) throw new Error('browser-native attachments: Worker VFS runtime identity differs')

    class BrowserNativeAttachmentStore extends AttachmentStore {
      override readonly imageLimits: ImageAttachmentLimits = IMAGE_LIMITS

      constructor(ctx: Context) {
        super(ctx)
      }

      /** Reject bytes without a supported container header before any storage write. */
      private parseImage(data: Uint8Array): ParsedImage {
        const parsed = parseImageBytes(data)
        if (parsed === undefined) {
          throw new AttachmentError('Uploaded image has no recognizable PNG, JPEG, WebP or GIF header.', 'INVALID_IMAGE')
        }
        return parsed
      }

      override async validateImage(input: SaveImageAttachment): Promise<void> {
        const parsed = this.parseImage(input.data)
        if (parsed.mediaType !== input.mediaType) {
          throw new AttachmentError(`Uploaded image bytes are ${parsed.mediaType}, not ${input.mediaType}.`, 'IMAGE_TYPE_MISMATCH')
        }
        if (input.data.byteLength > this.imageLimits.maxImageBytes) {
          throw new AttachmentError('Image exceeds the per-image byte limit.', 'IMAGE_TOO_LARGE')
        }
        if (parsed.width > this.imageLimits.maxImageDimension || parsed.height > this.imageLimits.maxImageDimension) {
          throw new AttachmentError('Image exceeds the per-side pixel limit.', 'IMAGE_DIMENSION_TOO_LARGE')
        }
        if (parsed.width * parsed.height > this.imageLimits.maxImagePixels) {
          throw new AttachmentError('Image exceeds the intrinsic pixel budget.', 'IMAGE_TOO_MANY_PIXELS')
        }
      }

      override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        input.signal?.throwIfAborted()
        const parsed = this.parseImage(input.data)
        if (parsed.mediaType !== input.mediaType) {
          throw new AttachmentError(`Uploaded image bytes are ${parsed.mediaType}, not ${input.mediaType}.`, 'IMAGE_TYPE_MISMATCH')
        }
        const workspaceId = workspaceIdOf(workspace)
        const directory = await opfsWorkspace(workspaceId)
        const temporaryName = `upload-${crypto.randomUUID()}`
        return await withTemporaryFileLock(workspaceId, temporaryName, async () => {
          const temporary = await directory.directory.getFileHandle(temporaryName, { create: true })
          const stored = await writeStreamToOpfs(
            directory.directory,
            temporary,
            (async function* (): AsyncGenerator<Uint8Array> { yield input.data })(),
            input.signal,
            testHooks.afterOpfsStagingWrite,
          )
          const ref: ImageAttachmentRef = {
            attachmentId: AttachmentId(`sha256:${stored.hash}`),
            mediaType: input.mediaType,
            bytes: stored.bytes,
            width: parsed.width,
            height: parsed.height,
          }
          const fileRef: FileAttachmentRef = {
            attachmentId: ref.attachmentId,
            name: imageObjectName(ref),
            bytes: stored.bytes,
          }
          const object = await publishLocalObject(directory, temporary, stored.hash, stored.bytes)
          await uploadObject(workspaceId, object, fileRef, input.signal)
          await mountFile(directory, fileRef, stored.hash)
          return ref
        })
      }

      override async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
        signal?.throwIfAborted()
        const fileRef: FileAttachmentRef = {
          attachmentId: ref.attachmentId,
          name: imageObjectName(ref),
          bytes: ref.bytes,
        }
        await ensureAttachmentFile(fileRef, signal)
        const directory = await opfsWorkspace(workspaceIdOf(workspace))
        const object = await directory.directory.getFileHandle(assertFileReference(fileRef))
        const data = new Uint8Array(await (await object.getFile()).arrayBuffer())
        signal?.throwIfAborted()
        const digest = new Sha256()
        digest.update(data)
        if (data.byteLength !== ref.bytes || digest.digestHex() !== String(ref.attachmentId).slice('sha256:'.length)) {
          throw new AttachmentError('Stored browser image failed integrity verification.', 'ATTACHMENT_CORRUPT')
        }
        const parsed = this.parseImage(data)
        if (parsed.mediaType !== ref.mediaType || parsed.width !== ref.width || parsed.height !== ref.height) {
          throw new AttachmentError('Stored browser image metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
        }
        return { ref, data }
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
    }

    async function verifyObject(file: File, hash: string, bytes: number, signal?: AbortSignal): Promise<void> {
      const cached = verifiedObjects.get(hash)
      if (cached !== undefined && cached.bytes === bytes && file.size === bytes && file.lastModified === cached.lastModified) {
        testHooks.onAttachmentVerify?.(hash, 'cached')
        return
      }
      try {
        await verifyFile(file, hash, bytes, signal)
      } catch (error) {
        verifiedObjects.delete(hash)
        throw error
      }
      verifiedObjects.set(hash, { bytes, lastModified: file.lastModified })
      testHooks.onAttachmentVerify?.(hash, 'full')
    }

    async function ensureAttachmentFile(ref: FileAttachmentRef, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted()
      const hash = assertFileReference(ref)
      const directory = await opfsWorkspace(workspaceIdOf(workspace))
      let object: FileSystemFileHandle
      try {
        object = await directory.directory.getFileHandle(hash)
        await verifyObject(await object.getFile(), hash, ref.bytes, signal)
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
        await verifyObject(await target.getFile(), hash, bytes)
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
      await verifyObject(await target.getFile(), hash, bytes)
      return target
    }

    async function uploadObject(
      workspaceId: string,
      file: FileSystemFileHandle,
      ref: FileAttachmentRef,
      signal?: AbortSignal,
    ): Promise<void> {
      const hash = assertFileReference(ref)
      const object = await file.getFile()
      if (object.size >= CHUNKED_UPLOAD_THRESHOLD_BYTES) {
        await uploadObjectInChunks(workspaceId, object, ref, hash, signal)
        return
      }
      const url = new URL(`${ATTACHMENT_API}/${hash}`, globalThis.location.origin)
      url.searchParams.set('workspaceId', workspaceId)
      url.searchParams.set('name', ref.name)
      const response = await fetch(url, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream' },
        body: object,
        ...(signal === undefined ? {} : { signal }),
      })
      const value = await response.json() as FileRefUploadResponse
      if (!response.ok) throw new Error(readResponseError(value, `attachment upload failed with HTTP ${String(response.status)}`))
      if (value.attachmentId !== ref.attachmentId || value.name !== ref.name || value.bytes !== ref.bytes) {
        throw new Error('browser-native attachments: backend upload receipt differs from the local file')
      }
    }

    /**
     * Upload a large object in bounded chunks and discard staging when it fails.
     *
     * Each chunk reports its received offset, so a lost or reordered chunk
     * surfaces as an error instead of a corrupt object. Aborting the caller's
     * signal also removes server-side staging.
     */
    async function uploadObjectInChunks(
      workspaceId: string,
      object: File,
      ref: FileAttachmentRef,
      hash: string,
      signal?: AbortSignal,
    ): Promise<void> {
      const beginUrl = new URL(`${ATTACHMENT_API}/${hash}/uploads`, globalThis.location.origin)
      beginUrl.searchParams.set('workspaceId', workspaceId)
      beginUrl.searchParams.set('name', ref.name)
      const begun = await fetch(beginUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bytes: ref.bytes }),
        ...(signal === undefined ? {} : { signal }),
      })
      const beginValue = await begun.json() as ChunkedUploadBeginResponse
      if (!begun.ok) throw new Error(readResponseError(beginValue, `attachment upload begin failed with HTTP ${String(begun.status)}`))
      if (typeof beginValue.uploadId !== 'string') throw new Error('browser-native attachments: backend did not return an upload id')
      const uploadUrl = new URL(`${ATTACHMENT_API}/${hash}/uploads/${beginValue.uploadId}`, globalThis.location.origin)
      uploadUrl.searchParams.set('workspaceId', workspaceId)
      const operationUrl = (suffix: string) => new URL(`${uploadUrl.pathname}${suffix}${uploadUrl.search}`, uploadUrl.origin)
      const chunkBytes = Number.isSafeInteger(beginValue.chunkBytes) && Number(beginValue.chunkBytes) > 0
        ? Math.min(Number(beginValue.chunkBytes), ATTACHMENT_UPLOAD_CHUNK_BYTES)
        : ATTACHMENT_UPLOAD_CHUNK_BYTES
      try {
        for (let offset = 0; offset < ref.bytes; offset += chunkBytes) {
          signal?.throwIfAborted()
          const end = Math.min(offset + chunkBytes, ref.bytes)
          const response = await fetch(operationUrl(`/chunks/${String(offset)}`), {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/octet-stream' },
            body: await object.slice(offset, end).arrayBuffer(),
            ...(signal === undefined ? {} : { signal }),
          })
          const value = await response.json() as ChunkedUploadChunkResponse
          if (!response.ok) throw new Error(readResponseError(value, `attachment chunk failed with HTTP ${String(response.status)}`))
          if (value.received !== end) throw new Error('browser-native attachments: backend chunk receipt differs from the sent offset')
        }
        signal?.throwIfAborted()
        const committed = await fetch(operationUrl('/commit'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          ...(signal === undefined ? {} : { signal }),
        })
        const receipt = await committed.json() as FileRefUploadResponse
        if (!committed.ok) throw new Error(readResponseError(receipt, `attachment upload commit failed with HTTP ${String(committed.status)}`))
        if (receipt.attachmentId !== ref.attachmentId || receipt.name !== ref.name || receipt.bytes !== ref.bytes) {
          throw new Error('browser-native attachments: backend upload receipt differs from the local file')
        }
      } catch (error) {
        await fetch(operationUrl(''), { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => {})
        throw error
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
