import { createHash } from 'node:crypto'

const CHUNK_BYTES = 1024 * 1024

interface UploadState {
  readonly hash: string
  readonly totalBytes: number
  readonly chunkCount: number
  readonly chunks: Map<number, Uint8Array>
  complete: boolean
  reusePlanned?: boolean
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function bytesFromBody(body: BodyInit | null | undefined): Uint8Array {
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  throw new Error('expected a binary Workspace chunk request body')
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Mock the Browser-Native Workspace chunk protocol for client unit tests. */
export function createWorkspaceBlobProtocolMock() {
  const uploads = new Map<string, UploadState>()
  const remoteBlobs = new Map<string, Uint8Array>()
  const completedBlobs = new Map<string, Uint8Array>()
  const uploadedChunks: Array<{ readonly hash: string; readonly index: number; readonly bytes: Uint8Array }> = []

  return {
    readonlyUploads: uploadedChunks,
    completedBlobs,
    registerBlob(hash: string, bytes: Uint8Array): void {
      remoteBlobs.set(hash, bytes.slice())
    },
    respond(
      input: RequestInfo | URL,
      init?: RequestInit,
      beforeChunk?: (bytes: Uint8Array, index: number, hash: string) => Response | undefined,
    ): Response | undefined {
      const url = new URL(String(input), 'http://workspace.test')
      const method = init?.method ?? 'GET'
      const start = url.pathname.endsWith('/blob-upload/start')
      if (method === 'POST' && start) {
        const body = JSON.parse(String(init?.body)) as {
          operationId: string
          hash: string
          totalBytes: number
          chunkBytes: number
        }
        const id = `${body.operationId}-${body.hash}`
        const chunkCount = Math.ceil(body.totalBytes / body.chunkBytes)
        const previous = uploads.get(id)
        if (previous !== undefined && (previous.hash !== body.hash || previous.totalBytes !== body.totalBytes
          || previous.chunkCount !== chunkCount)) return jsonResponse({ error: { code: 'UPLOAD_ID_CONFLICT' } }, 409)
        if (previous === undefined) uploads.set(id, { hash: body.hash, totalBytes: body.totalBytes, chunkCount, chunks: new Map(), complete: false })
        return jsonResponse({ complete: uploads.get(id)?.complete === true, reusePlanned: uploads.get(id)?.reusePlanned === true })
      }

      const status = url.pathname.match(/\/blob-upload\/([0-9a-f-]{36}-[a-f0-9]{64})$/i)
      if (method === 'GET' && status !== null) {
        const upload = uploads.get(status[1] ?? '')
        if (upload === undefined) return jsonResponse({ error: { code: 'UPLOAD_NOT_FOUND' } }, 404)
        const missing = Array.from({ length: upload.chunkCount }, (_, index) => index)
          .filter(index => !upload.chunks.has(index))
        return jsonResponse({ complete: upload.complete, missing })
      }

      const chunk = url.pathname.match(/\/blob-upload\/([0-9a-f-]{36}-[a-f0-9]{64})\/([0-9]+)$/i)
      const reuse = url.pathname.match(/\/blob-upload\/([0-9a-f-]{36}-[a-f0-9]{64})\/reuse$/i)
      if (method === 'POST' && reuse !== null) {
        const upload = uploads.get(reuse[1] ?? '')
        const body = JSON.parse(String(init?.body)) as { baseHash: string; chunkHashes: string[] }
        const base = remoteBlobs.get(body.baseHash)
        if (upload === undefined || base === undefined) return jsonResponse({ error: { code: 'BLOB_NOT_FOUND' } }, 404)
        upload.reusePlanned = true
        const reused: number[] = []
        for (let index = 0; index < upload.chunkCount; index += 1) {
          const length = Math.min(CHUNK_BYTES, upload.totalBytes - index * CHUNK_BYTES)
          const bytes = base.subarray(index * CHUNK_BYTES, index * CHUNK_BYTES + length)
          if (bytes.byteLength === length && hashBytes(bytes) === body.chunkHashes[index]) {
            upload.chunks.set(index, bytes.slice())
            reused.push(index)
          }
        }
        return jsonResponse({ reused })
      }

      if (method === 'PUT' && chunk !== null) {
        const upload = uploads.get(chunk[1] ?? '')
        if (upload === undefined) return jsonResponse({ error: { code: 'UPLOAD_NOT_FOUND' } }, 404)
        const index = Number(chunk[2])
        const bytes = bytesFromBody(init?.body)
        const expectedBytes = Math.min(CHUNK_BYTES, upload.totalBytes - index * CHUNK_BYTES)
        const chunkHash = hashBytes(bytes)
        const customResponse = beforeChunk?.(bytes.slice(), index, upload.hash)
        if (customResponse !== undefined) return customResponse
        if (index < 0 || index >= upload.chunkCount || bytes.byteLength !== expectedBytes
          || chunkHash !== new Headers(init?.headers).get('x-chunk-sha256')) {
          return jsonResponse({ error: { code: 'UPLOAD_CHUNK_INVALID' } }, 400)
        }
        const previous = upload.chunks.get(index)
        if (previous !== undefined && hashBytes(previous) !== chunkHash) {
          return jsonResponse({ error: { code: 'UPLOAD_CHUNK_CONFLICT' } }, 409)
        }
        upload.chunks.set(index, bytes.slice())
        uploadedChunks.push({ hash: upload.hash, index, bytes: bytes.slice() })
        return jsonResponse({ replayed: previous !== undefined })
      }

      const complete = url.pathname.match(/\/blob-upload\/([0-9a-f-]{36}-[a-f0-9]{64})\/complete$/i)
      if (method === 'POST' && complete !== null) {
        const upload = uploads.get(complete[1] ?? '')
        if (upload === undefined) return jsonResponse({ error: { code: 'UPLOAD_NOT_FOUND' } }, 404)
        if (upload.complete) return jsonResponse({ complete: true, replayed: true })
        if (upload.chunks.size !== upload.chunkCount) return jsonResponse({ error: { code: 'UPLOAD_INCOMPLETE' } }, 409)
        const bytes = new Uint8Array(upload.totalBytes)
        for (let index = 0; index < upload.chunkCount; index += 1) {
          const part = upload.chunks.get(index)
          if (part === undefined) return jsonResponse({ error: { code: 'UPLOAD_INCOMPLETE' } }, 409)
          bytes.set(part, index * CHUNK_BYTES)
        }
        if (hashBytes(bytes) !== upload.hash) return jsonResponse({ error: { code: 'UPLOAD_BLOB_HASH_MISMATCH' } }, 409)
        upload.complete = true
        completedBlobs.set(upload.hash, bytes)
        return jsonResponse({ complete: true, replayed: false })
      }

      const download = url.pathname.match(/\/blob\/([a-f0-9]{64})\/chunk\/([0-9]+)$/i)
      if (method === 'GET' && download !== null) {
        const blob = remoteBlobs.get(download[1] ?? '')
        if (blob === undefined) return undefined
        const index = Number(download[2])
        const chunkCount = Math.ceil(blob.byteLength / CHUNK_BYTES)
        if (index < 0 || index >= chunkCount) return jsonResponse({ error: { code: 'BLOB_NOT_FOUND' } }, 404)
        const bytes = blob.subarray(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, blob.byteLength))
        return new Response(bytes, { headers: {
          'x-content-sha256': hashBytes(bytes),
          'x-chunk-index': String(index),
          'x-chunk-count': String(chunkCount),
          'x-total-bytes': String(blob.byteLength),
        } })
      }
      return undefined
    },
  }
}
