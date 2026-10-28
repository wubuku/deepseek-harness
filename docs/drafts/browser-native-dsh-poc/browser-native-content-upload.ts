import { findContentChunks } from './browser-native-content-chunker.ts'

/** Frozen experimental upload parameters; changes require a new algorithm identifier. */
export const CONTENT_UPLOAD_PARAMETERS = {
  version: 1,
  algorithm: 'dsh-gear-v1',
  minimumBytes: 32 * 1024,
  averageBytes: 128 * 1024,
  maximumBytes: 1024 * 1024,
} as const

/** A validated target byte range and its complete SHA-256 digest. */
export interface ContentUploadChunk {
  readonly offset: number
  readonly length: number
  readonly hash: string
}

/** Immutable layout sent with an experimental Workspace blob upload. */
export interface ContentUploadLayout {
  readonly version: 1
  readonly algorithm: 'dsh-gear-v1'
  readonly minimumBytes: number
  readonly averageBytes: number
  readonly maximumBytes: number
  readonly chunks: readonly ContentUploadChunk[]
}

/**
 * Reject backends that do not explicitly advertise the frozen content layout.
 * @param value - Parsed backend capability response.
 * @returns Nothing when the backend supports this exact experimental layout.
 */
export function requireContentUploadCapability(value: Record<string, unknown>): void {
  const capability = value.contentLayout
  if (capability === null || typeof capability !== 'object' || Array.isArray(capability)) {
    throw new Error('browser-native workspace: content upload capability is unavailable')
  }
  const fields = capability as Record<string, unknown>
  if (Object.entries(CONTENT_UPLOAD_PARAMETERS).some(([key, expected]) => fields[key] !== expected)
    || fields.maxChunks !== 2048) {
    throw new Error('browser-native workspace: content upload capability version or parameters are unsupported')
  }
}

/**
 * Build the same bounded content layout on first upload and durable retry.
 * @param totalBytes - Complete immutable target size, at most the PoC 64 MiB limit.
 * @param readRange - Read exactly one range from the retained target version.
 * @param hashBytes - SHA-256 implementation used by the Workspace uploader.
 * @returns The complete ordered layout; no network requests or Workspace mutations occur.
 */
export async function buildContentUploadLayout(
  totalBytes: number,
  readRange: (offset: number, length: number) => Uint8Array,
  hashBytes: (bytes: Uint8Array) => Promise<string>,
): Promise<ContentUploadLayout> {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > 64 * 1024 * 1024) {
    throw new RangeError('browser-native workspace: content upload file size is unsupported')
  }
  const ranges = await findContentChunks(totalBytes, readRange, {
    ...CONTENT_UPLOAD_PARAMETERS,
    readBytes: 1024 * 1024,
    yieldToCaller: async () => await new Promise<void>(resolve => setTimeout(resolve, 0)),
  })
  if (ranges.chunks.length > 2048) throw new RangeError('browser-native workspace: content upload has too many chunks')
  const chunks: ContentUploadChunk[] = []
  for (const range of ranges.chunks) {
    const bytes = readRange(range.offset, range.length)
    if (bytes.byteLength !== range.length) throw new Error('browser-native workspace: short content upload hash read')
    chunks.push({ ...range, hash: await hashBytes(bytes) })
  }
  return { ...CONTENT_UPLOAD_PARAMETERS, chunks }
}
