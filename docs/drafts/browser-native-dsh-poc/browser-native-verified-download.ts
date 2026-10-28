/** Sequential HTTP downloads verified before their final range can enter durable storage. */
import { Sha256 } from './browser-native-sha256.ts'

const READ_BYTES = 1024 * 1024

/** The backend explicitly declined streaming for a file without a chunk descriptor. */
export class VerifiedDownloadUnsupportedError extends Error {
  override readonly name = 'VerifiedDownloadUnsupportedError'
  readonly code = 'FILE_DOWNLOAD_UNSUPPORTED'

  constructor() {
    super('browser-native workspace: verified download is unsupported for this file')
  }
}

/** A lazy connection owned by one sequential consumer; always close it in finally. */
export interface VerifiedDownload {
  /**
   * Read the next range, checking EOF and full SHA-256 before returning the final range.
   * @param offset - Consumed byte count; overlapping, skipped and concurrent reads are rejected.
   * @param length - Positive length up to 1 MiB, or zero for the sole empty-file read.
   * @returns Exactly the requested bytes; rejects invalid headers, lengths, hashes and cancellation.
   */
  read(offset: number, length: number): Promise<Uint8Array>
  /**
   * Abort the connection, cancel and release its reader, and settle pending work; safe before reading.
   * @returns Completion of idempotent cleanup, including failed or unconsumed downloads.
   */
  close(): Promise<void>
}

/**
 * Accept only the exact negotiated download protocol; absence preserves legacy requests.
 * @param value - Parsed upload-capabilities response.
 * @returns Whether verified streaming is advertised; rejects unknown versions and fields.
 */
export function hasVerifiedDownloadCapability(value: Record<string, unknown>): boolean {
  if (!Object.hasOwn(value, 'fileDownload')) return false
  const capability = value.fileDownload
  if (capability === null || typeof capability !== 'object' || Array.isArray(capability)
    || Object.keys(capability).length !== 2 || !('version' in capability) || capability.version !== 1
    || !('kind' in capability) || capability.kind !== 'verified-stream') {
    throw new Error('browser-native workspace: file download capability version or fields are unsupported')
  }
  return true
}

/**
 * Adapt a lazy HTTP ReadableStream with at most 1 MiB of output plus one browser-delivered chunk.
 * @param workspaceId - Manifest-authorized Workspace identity.
 * @param hash - Complete lowercase SHA-256 from the manifest.
 * @param totalBytes - Complete manifest byte length; empty files require read(0, 0).
 * @returns A consumer-owned reader; only an exact HTTP 409 FILE_DOWNLOAD_UNSUPPORTED permits fallback.
 */
export function createVerifiedDownload(workspaceId: string, hash: string, totalBytes: number): VerifiedDownload {
  const controller = new AbortController()
  const digest = new Sha256()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let opening: Promise<void> | undefined
  let reading: Promise<Uint8Array> | undefined
  let closing: Promise<void> | undefined
  let pending: Uint8Array = new Uint8Array(0)
  let consumed = 0
  let complete = false
  let closed = false
  let failed = false

  const assertOpen = (): void => {
    if (closed) throw new DOMException('browser-native workspace: verified download was closed', 'AbortError')
  }

  const open = async (): Promise<void> => {
    const response = await fetch(
      `/api/browser-native/workspace/blob/${hash}/stream?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
      { credentials: 'same-origin', signal: controller.signal },
    )
    if (!response.ok) {
      if (response.status === 409) {
        const body: unknown = await response.json()
        if (body !== null && typeof body === 'object' && 'error' in body
          && body.error !== null && typeof body.error === 'object' && 'code' in body.error
          && body.error.code === 'FILE_DOWNLOAD_UNSUPPORTED') {
          throw new VerifiedDownloadUnsupportedError()
        }
      }
      if (!response.bodyUsed) reader = response.body?.getReader()
      throw new Error(`browser-native workspace: verified download failed with HTTP ${String(response.status)}`)
    }
    if (response.body === null) throw new Error('browser-native workspace: verified download omitted its body')
    reader = response.body.getReader()
    assertOpen()
    if (response.status !== 200 || response.headers.get('x-content-sha256') !== hash
      || response.headers.get('x-total-bytes') !== String(totalBytes)
      || response.headers.get('content-length') !== String(totalBytes)) {
      throw new Error('browser-native workspace: verified download headers do not match the manifest')
    }
  }

  const next = async (): Promise<boolean> => {
    while (pending.byteLength === 0) {
      assertOpen()
      const result = await reader!.read()
      assertOpen()
      if (result.done) return false
      pending = result.value
    }
    return true
  }

  const consume = async (length: number): Promise<Uint8Array> => {
    opening ??= open()
    await opening
    assertOpen()
    const output = new Uint8Array(length)
    let copied = 0
    while (copied < length) {
      if (!await next()) throw new Error('browser-native workspace: verified download is truncated')
      const count = Math.min(length - copied, pending.byteLength)
      output.set(pending.subarray(0, count), copied)
      pending = pending.subarray(count)
      copied += count
    }
    digest.update(output)
    consumed += length
    if (consumed === totalBytes) {
      if (await next()) throw new Error('browser-native workspace: verified download contains excess bytes')
      if (digest.digestHex() !== hash) throw new Error('browser-native workspace: verified download failed full SHA-256 verification')
      complete = true
    }
    return output
  }

  return {
    read: async (offset, length) => {
      assertOpen()
      if (reading !== undefined || failed || complete) throw new Error('browser-native workspace: verified download is not readable')
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset !== consumed
        || length < 0 || length > READ_BYTES || length > totalBytes - consumed
        || (length === 0 && totalBytes !== 0)) {
        throw new RangeError('browser-native workspace: invalid sequential verified download range')
      }
      reading = consume(length)
      try {
        return await reading
      } catch (error) {
        failed = true
        throw error
      } finally {
        reading = undefined
      }
    },
    close: () => {
      if (closing !== undefined) return closing
      closed = true
      controller.abort()
      closing = (async () => {
        if (opening !== undefined) await Promise.allSettled([opening])
        if (reader !== undefined) {
          try {
            await reader.cancel()
          } catch (cancelError) {
            void cancelError
          }
          if (reading !== undefined) await Promise.allSettled([reading])
          reader.releaseLock()
        }
        if (reading !== undefined) await Promise.allSettled([reading])
        pending = new Uint8Array(0)
      })()
      return closing
    },
  }
}
