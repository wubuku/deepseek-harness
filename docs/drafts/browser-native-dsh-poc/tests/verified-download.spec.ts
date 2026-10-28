import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTENT_UPLOAD_PARAMETERS } from '../browser-native-content-upload.ts'
import {
  createVerifiedDownload,
  hasVerifiedDownloadCapability,
  VerifiedDownloadUnsupportedError,
} from '../browser-native-verified-download.ts'
import { createBrowserNativeWorkspaceRuntime } from '../browser-native-workspace.ts'
import { BrowserDurableWorkspaceStore, MemoryDurableWorkspaceStore } from '../browser-native-workspace-store.ts'
import { createWorkspaceBlobProtocolMock } from './workspace-blob-protocol-mock.ts'

const workspaceId = '7cb327fe-f71a-4d54-ac91-17f0ab4fb163'
const root = '/dsh/home/workspace'
const chunkBytes = 1024 * 1024
const source = Uint8Array.from({ length: chunkBytes * 2 + 37 }, (_, index) => index % 251)
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const capabilities = { contentLayout: { ...CONTENT_UPLOAD_PARAMETERS, maxChunks: 2048 },
  fileDownload: { version: 1, kind: 'verified-stream' } }

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function wire(bytes: Uint8Array, fragments: readonly number[] = [bytes.byteLength], options: {
  readonly headers?: Record<string, string>
  readonly failAfter?: number
  readonly holdEof?: boolean
} = {}) {
  let offset = 0
  let pulls = 0
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller },
    pull(controller) {
      if (offset === options.failAfter) throw new TypeError('wire connection aborted')
      if (offset === bytes.byteLength) {
        if (options.holdEof !== true) controller.close()
        return
      }
      const length = fragments[pulls % fragments.length] ?? bytes.byteLength
      controller.enqueue(bytes.subarray(offset, offset + length))
      offset = Math.min(offset + length, bytes.byteLength)
      pulls += 1
    },
    cancel,
  }, { highWaterMark: 0 })
  const response = new Response(body, { headers: {
    'x-content-sha256': hash(bytes), 'x-total-bytes': String(bytes.byteLength),
    'content-length': String(bytes.byteLength), ...options.headers,
  } })
  const arrayBuffer = vi.spyOn(response, 'arrayBuffer').mockRejectedValue(new Error('whole response buffering is forbidden'))
  const requests: RequestInit[] = []
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {})
    return response
  })
  return { body, response, cancel, arrayBuffer, requests, fetchMock,
    end: () => { streamController!.close() } }
}

async function readAll(bytes: Uint8Array): Promise<void> {
  const download = createVerifiedDownload(workspaceId, hash(bytes), bytes.byteLength)
  try {
    if (bytes.byteLength === 0) expect(await download.read(0, 0)).toEqual(bytes)
    for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      const length = Math.min(chunkBytes, bytes.byteLength - offset)
      expect(await download.read(offset, length)).toEqual(bytes.subarray(offset, offset + length))
    }
  } finally {
    await download.close()
  }
}

function workspaceFetch(bytes: Uint8Array, stream: () => Response | Promise<Response>, advertised: Record<string, unknown> = capabilities) {
  const protocol = createWorkspaceBlobProtocolMock()
  protocol.registerBlob(hash(bytes), bytes)
  const calls: string[] = []
  const requests: RequestInit[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    calls.push(path)
    if (path.endsWith('/upload-capabilities')) return json(advertised)
    if (path.includes('/stream?')) {
      requests.push(init ?? {})
      return await stream()
    }
    if (path.endsWith('/identity')) return json({ workspaceId })
    if (path.includes('/manifest?')) return json({ workspaceId, revision: 1,
      entries: [{ path: 'file.bin', kind: 'file', hash: hash(bytes), bytes: bytes.byteLength, mode: 0o600 }] })
    if (path.endsWith('/lease')) return json({ error: { code: 'WORKSPACE_ALREADY_OWNED' } }, 409)
    const response = protocol.respond(input, init)
    if (response !== undefined) return response
    throw new Error(`unexpected request ${path}`)
  }))
  return { calls, requests }
}

function opfsCache(existing?: Uint8Array, options: {
  readonly createFailure?: boolean
  readonly writeFailure?: boolean
  readonly closeFailure?: boolean
  readonly abortFailure?: boolean
} = {}) {
  let canonical = existing?.slice()
  let staging = new Uint8Array(0)
  const writable = {
    write: vi.fn(async (command: { position: number; data: ArrayBuffer }) => {
      if (options.writeFailure) throw new DOMException('OPFS write failed', 'QuotaExceededError')
      const output = new Uint8Array(command.position + command.data.byteLength)
      output.set(staging)
      output.set(new Uint8Array(command.data), command.position)
      staging = output
    }),
    close: vi.fn(async () => {
      if (options.closeFailure) throw new Error('OPFS close failed')
      canonical = staging
    }),
    abort: vi.fn(async () => {
      if (options.abortFailure) throw new Error('OPFS abort failed')
      staging = new Uint8Array(0)
    }),
  }
  const handle = {
    getFile: vi.fn(async () => {
      if (canonical === undefined) throw new DOMException('missing file', 'NotFoundError')
      return new File([canonical], 'cache')
    }),
    createWritable: vi.fn(async () => {
      if (options.createFailure) throw new DOMException('OPFS createWritable failed', 'QuotaExceededError')
      return writable
    }),
    createSyncAccessHandle: vi.fn(async () => ({
      getSize: () => canonical!.byteLength,
      read: (output: Uint8Array, readOptions: { at: number }) => {
        const range = canonical!.subarray(readOptions.at, readOptions.at + output.byteLength)
        output.set(range)
        return range.byteLength
      },
      close: vi.fn(),
    })),
  }
  const directory = {
    getFileHandle: vi.fn(async (_name: string, fileOptions?: { create?: boolean }) => {
      if (canonical === undefined && fileOptions?.create !== true) throw new DOMException('missing file', 'NotFoundError')
      canonical ??= new Uint8Array(0)
      return handle
    }),
    removeEntry: vi.fn(async () => { canonical = undefined }),
  }
  vi.stubGlobal('indexedDB', { open: () => {
    const request = { result: { version: 1 }, onsuccess: () => {}, onerror: () => {} }
    queueMicrotask(() => { request.onsuccess() })
    return request
  } })
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) } })
  return { store: new BrowserDurableWorkspaceStore(), writable, directory, handle,
    canonical: () => canonical }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('verified download reader', () => {
  it.each([
    ['wire fragments', source, [1, 13, 65_537, 177]],
    ['crossing application ranges', source, [chunkBytes + 19, chunkBytes]],
    ['one large legal browser chunk', source, [source.byteLength]],
    ['short tail', source.subarray(0, chunkBytes + 1), [8191]],
    ['empty file', source.subarray(0, 0), [1]],
  ] as const)('verifies %s without buffering the response', async (_name, bytes, fragments) => {
    const remote = wire(bytes, fragments)
    vi.stubGlobal('fetch', remote.fetchMock)
    await readAll(bytes)
    expect(remote.fetchMock).toHaveBeenCalledTimes(1)
    expect(remote.arrayBuffer).not.toHaveBeenCalled()
    expect(remote.body.locked).toBe(false)
    expect(remote.requests[0]?.signal?.aborted).toBe(true)
    expect(remote.fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/browser-native/workspace/blob/${hash(bytes)}/stream?protocolVersion=1&workspaceId=${workspaceId}`,
    )
  })

  it.each([
    ['truncated', source.subarray(0, source.byteLength - 1), {}, /truncated/],
    ['excess', new Uint8Array([...source, 9]), {}, /excess/],
    ['wrong hash', new Uint8Array(source.byteLength), {}, /SHA-256/],
    ['wrong hash header', source, { 'x-content-sha256': 'f'.repeat(64) }, /headers/],
    ['wrong length header', source, { 'content-length': '1' }, /headers/],
    ['wrong total header', source, { 'x-total-bytes': '1' }, /headers/],
    ['missing header', source, { 'content-length': '' }, /headers/],
  ] as const)('rejects %s before the final callback returns', async (_name, bytes, headers, message) => {
    const remote = wire(bytes, [chunkBytes], { headers: {
      'x-content-sha256': hash(source), 'x-total-bytes': String(source.byteLength),
      'content-length': String(source.byteLength), ...headers,
    } })
    vi.stubGlobal('fetch', remote.fetchMock)
    const download = createVerifiedDownload(workspaceId, hash(source), source.byteLength)
    let delivered = 0
    try {
      await expect((async () => {
        for (let offset = 0; offset < source.byteLength; offset += chunkBytes) {
          await download.read(offset, Math.min(chunkBytes, source.byteLength - offset))
          delivered += 1
        }
      })()).rejects.toThrow(message)
      expect(delivered).toBeLessThan(3)
    } finally {
      await download.close()
    }
    expect(remote.body.locked).toBe(false)
    expect(remote.requests[0]?.signal?.aborted).toBe(true)
  })

  it('waits for EOF before returning the last range', async () => {
    const bytes = source.subarray(0, 8)
    const remote = wire(bytes, [8], { holdEof: true })
    vi.stubGlobal('fetch', remote.fetchMock)
    const download = createVerifiedDownload(workspaceId, hash(bytes), bytes.byteLength)
    let delivered = false
    const reading = download.read(0, bytes.byteLength).then(value => { delivered = true; return value })
    try {
      await vi.waitFor(() => { expect(remote.body.locked).toBe(true) })
      expect(delivered).toBe(false)
      remote.end()
      expect(await reading).toEqual(bytes)
    } finally {
      await download.close()
    }
  })

  it.each([0, 8])('rejects extra bytes for a %i-byte file', async length => {
    const bytes = source.subarray(0, length)
    const remote = wire(source.subarray(0, length + 1), [length || 1], { headers: {
      'x-content-sha256': hash(bytes), 'x-total-bytes': String(length), 'content-length': String(length),
    } })
    vi.stubGlobal('fetch', remote.fetchMock)
    const download = createVerifiedDownload(workspaceId, hash(bytes), length)
    try {
      await expect(download.read(0, length)).rejects.toThrow(/excess/)
    } finally {
      await download.close()
    }
  })

  it('requires the empty file hash as well as EOF', async () => {
    const remote = wire(new Uint8Array(0), [1], { headers: { 'x-content-sha256': 'f'.repeat(64) } })
    vi.stubGlobal('fetch', remote.fetchMock)
    const download = createVerifiedDownload(workspaceId, 'f'.repeat(64), 0)
    try {
      await expect(download.read(0, 0)).rejects.toThrow(/SHA-256/)
    } finally {
      await download.close()
    }
  })

  it('rejects skipped, overlapping, invalid and concurrent ranges', async () => {
    const remote = wire(source, [chunkBytes])
    vi.stubGlobal('fetch', remote.fetchMock)
    const download = createVerifiedDownload(workspaceId, hash(source), source.byteLength)
    try {
      for (const [offset, length] of [[1, 1], [-1, 1], [0, -1], [0, 0], [0, chunkBytes + 1], [0, 0.5]]) {
        await expect(download.read(offset!, length!)).rejects.toThrow(/range/)
      }
      expect(remote.fetchMock).not.toHaveBeenCalled()
      const first = download.read(0, chunkBytes)
      await expect(download.read(0, chunkBytes)).rejects.toThrow(/not readable/)
      await first
      await expect(download.read(0, 1)).rejects.toThrow(/range/)
      await download.read(chunkBytes, chunkBytes)
      await expect(download.read(chunkBytes * 2, 38)).rejects.toThrow(/range/)
      await download.read(chunkBytes * 2, 37)
      await expect(download.read(source.byteLength, 0)).rejects.toThrow(/not readable/)
    } finally {
      await download.close()
    }
  })

  it('closes an unconsumed reader without opening a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const download = createVerifiedDownload(workspaceId, hash(source), source.byteLength)
    await download.close()
    await download.close()
    await expect(download.read(0, 1)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cancels and unlocks a reader when its consumer throws', async () => {
    const remote = wire(source, [chunkBytes])
    vi.stubGlobal('fetch', remote.fetchMock)
    const download = createVerifiedDownload(workspaceId, hash(source), source.byteLength)
    await expect((async () => {
      try {
        await download.read(0, chunkBytes)
        throw new Error('consumer failed')
      } finally {
        await download.close()
      }
    })()).rejects.toThrow('consumer failed')
    expect(remote.cancel).toHaveBeenCalledTimes(1)
    expect(remote.body.locked).toBe(false)
    expect(remote.requests[0]?.signal?.aborted).toBe(true)
  })

  it('settles a pending body read when closed', async () => {
    const remote = wire(new Uint8Array(0), [1], { holdEof: true,
      headers: { 'x-content-sha256': hash(source), 'x-total-bytes': String(source.byteLength), 'content-length': String(source.byteLength) } })
    vi.stubGlobal('fetch', remote.fetchMock)
    const download = createVerifiedDownload(workspaceId, hash(source), source.byteLength)
    const reading = expect(download.read(0, chunkBytes)).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await vi.waitFor(() => { expect(remote.body.locked).toBe(true) })
    } finally {
      await download.close()
    }
    await reading
    expect(remote.cancel).toHaveBeenCalledTimes(1)
    expect(remote.body.locked).toBe(false)
  })

  it('aborts a connection while awaiting its response headers', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return await new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener('abort', () => { reject(signal!.reason) }, { once: true })
      })
    }))
    const download = createVerifiedDownload(workspaceId, hash(source), source.byteLength)
    const reading = expect(download.read(0, chunkBytes)).rejects.toMatchObject({ name: 'AbortError' })
    await download.close()
    await reading
    expect(signal?.aborted).toBe(true)
  })
})

describe('negotiated Workspace downloads', () => {
  it.each([null, false, {}, { version: 2, kind: 'verified-stream' }, { version: 1, kind: 'unknown' },
    { version: 1, kind: 'verified-stream', extra: true }])('rejects unknown capability %j before identity', async fileDownload => {
    const fetchMock = vi.fn(async () => json({ ...capabilities, fileDownload }))
    vi.stubGlobal('fetch', fetchMock)
    const runtime = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true, onStatus: () => {} })
    await expect(runtime.prepareVfs(runtime.vfs)).rejects.toThrow(/capability/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('preserves legacy requests when contentDefinedUpload=%s and no download capability exists', async enabled => {
    expect(hasVerifiedDownloadCapability({})).toBe(false)
    const bytes = source.subarray(0, 32)
    const remote = workspaceFetch(bytes, () => { throw new Error('unexpected stream') },
      { contentLayout: capabilities.contentLayout })
    const runtime = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: enabled, onStatus: () => {} })
    await runtime.prepareVfs(runtime.vfs)
    expect(runtime.vfs.readFileSync(`${root}/file.bin`)).toEqual(bytes)
    expect(remote.calls.filter(path => path.includes('/stream?'))).toEqual([])
    expect(remote.calls.filter(path => path.endsWith('/upload-capabilities'))).toHaveLength(enabled ? 1 : 0)
    expect(remote.calls.filter(path => path.includes('/chunk/'))).toHaveLength(1)
  })

  it('does not open a speculative stream when the memory store declines chunk caching', async () => {
    const remote = wire(source, [chunkBytes])
    const network = workspaceFetch(source, () => remote.response)
    const store = new MemoryDurableWorkspaceStore()
    const runtime = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true, store, onStatus: () => {} })
    await runtime.prepareVfs(runtime.vfs)
    expect(network.requests).toHaveLength(1)
    expect(network.calls.some(path => path.includes('/chunk/'))).toBe(false)
    expect(runtime.vfs.readFileSync(`${root}/file.bin`)).toEqual(source)
    expect(remote.arrayBuffer).not.toHaveBeenCalled()
  })

  it('uses one verified request and the real OPFS cache implementation', async () => {
    const remote = wire(source, [8191, chunkBytes])
    const network = workspaceFetch(source, () => remote.response)
    const cache = opfsCache()
    vi.spyOn(cache.store, 'listWorkspaceIds').mockResolvedValue([])
    vi.spyOn(cache.store, 'load').mockResolvedValue(undefined)
    vi.spyOn(cache.store, 'save').mockResolvedValue()
    vi.spyOn(cache.store, 'reconcileBlobs').mockResolvedValue({ removedFiles: 0, removedBytes: 0, retainedFiles: 1 })
    const runtime = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true, store: cache.store, onStatus: () => {} })
    await runtime.prepareVfs(runtime.vfs)
    expect(cache.writable.write).toHaveBeenCalledTimes(3)
    expect(cache.writable.close).toHaveBeenCalledTimes(1)
    expect(cache.writable.abort).not.toHaveBeenCalled()
    expect(network.requests).toHaveLength(1)
    expect(network.calls.some(path => path.includes('/chunk/'))).toBe(false)
    expect(runtime.vfs.readFileSync(`${root}/file.bin`)).toEqual(source)
    expect(remote.body.locked).toBe(false)
  })

  it('uses no download connection when chunk caching finds a verified local entry', async () => {
    const remote = workspaceFetch(source, () => { throw new Error('cache hit must not download') })
    const cache = opfsCache(source)
    vi.spyOn(cache.store, 'listWorkspaceIds').mockResolvedValue([])
    vi.spyOn(cache.store, 'load').mockResolvedValue(undefined)
    vi.spyOn(cache.store, 'save').mockResolvedValue()
    vi.spyOn(cache.store, 'reconcileBlobs').mockResolvedValue({ removedFiles: 0, removedBytes: 0, retainedFiles: 1 })
    const open = cache.store.openBlob.bind(cache.store)
    vi.spyOn(cache.store, 'openBlob').mockImplementationOnce(async () => undefined).mockImplementation(open)
    const runtime = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true, store: cache.store, onStatus: () => {} })
    await runtime.prepareVfs(runtime.vfs)
    expect(remote.requests).toHaveLength(0)
    expect(cache.writable.close).not.toHaveBeenCalled()
    expect(runtime.vfs.readFileSync(`${root}/file.bin`)).toEqual(source)
  })

  it.each([false, true])('verifies zero bytes and EOF before publishing with an OPFS store=%s', async durable => {
    const bytes = new Uint8Array(0)
    const remote = wire(bytes, [1])
    const network = workspaceFetch(bytes, () => remote.response)
    const store = durable ? opfsCache().store : new MemoryDurableWorkspaceStore()
    vi.spyOn(store, 'listWorkspaceIds').mockResolvedValue([])
    vi.spyOn(store, 'load').mockResolvedValue(undefined)
    vi.spyOn(store, 'save').mockResolvedValue()
    vi.spyOn(store, 'reconcileBlobs').mockResolvedValue({ removedFiles: 0, removedBytes: 0, retainedFiles: 1 })
    const runtime = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true, store, onStatus: () => {} })
    await runtime.prepareVfs(runtime.vfs)
    expect(network.requests).toHaveLength(1)
    expect(runtime.vfs.readFileSync(`${root}/file.bin`)).toEqual(bytes)
    expect(remote.body.locked).toBe(false)
  })

  it('downloads an observer snapshot through the verified stream', async () => {
    const bytes = source.subarray(0, 32)
    const remote = wire(bytes)
    const network = workspaceFetch(bytes, () => remote.response)
    const runtime = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true, writerLease: true, onStatus: () => {} })
    await runtime.prepareVfs(runtime.vfs)
    expect(runtime.getAccessMode()).toBe('observer')
    expect(runtime.vfs.readFileSync(`${root}/file.bin`)).toEqual(bytes)
    expect(network.requests).toHaveLength(1)
  })

  it('falls back only for the exact unsupported response, including OPFS cleanup before retry', async () => {
    const network = workspaceFetch(source, () => json({ error: { code: 'FILE_DOWNLOAD_UNSUPPORTED' } }, 409))
    const cache = opfsCache()
    vi.spyOn(cache.store, 'listWorkspaceIds').mockResolvedValue([])
    vi.spyOn(cache.store, 'load').mockResolvedValue(undefined)
    vi.spyOn(cache.store, 'save').mockResolvedValue()
    vi.spyOn(cache.store, 'reconcileBlobs').mockResolvedValue({ removedFiles: 0, removedBytes: 0, retainedFiles: 1 })
    const runtime = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true, store: cache.store, onStatus: () => {} })
    await runtime.prepareVfs(runtime.vfs)
    expect(network.requests).toHaveLength(1)
    expect(network.requests[0]?.signal?.aborted).toBe(true)
    expect(network.calls.filter(path => path.includes('/chunk/'))).toHaveLength(3)
    expect(cache.directory.removeEntry).toHaveBeenCalledTimes(1)
    expect(runtime.vfs.readFileSync(`${root}/file.bin`)).toEqual(source)
  })

  it.each([
    [404, { error: { code: 'FILE_DOWNLOAD_UNSUPPORTED' } }],
    [500, { error: { code: 'FILE_DOWNLOAD_UNSUPPORTED' } }],
    [409, { error: { code: 'WORKSPACE_NOT_FOUND' } }],
    [409, { code: 'FILE_DOWNLOAD_UNSUPPORTED' }],
  ])('does not fall back for HTTP %i and %j', async (status, body) => {
    const network = workspaceFetch(source, () => json(body, status))
    const runtime = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true, onStatus: () => {} })
    await expect(runtime.prepareVfs(runtime.vfs)).rejects.toThrow(/HTTP/)
    expect(network.calls.some(path => path.includes('/chunk/'))).toBe(false)
    expect(runtime.vfs.existsSync(`${root}/file.bin`)).toBe(false)
    expect(network.requests[0]?.signal?.aborted).toBe(true)
  })

  it('does not publish cache or VFS after metadata failure', async () => {
    const remote = workspaceFetch(source, () => { throw new Error('unexpected network') })
    const store = new MemoryDurableWorkspaceStore()
    vi.spyOn(store, 'save').mockRejectedValue(new Error('metadata failure'))
    const runtime = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true, store, onStatus: () => {} })
    await expect(runtime.prepareVfs(runtime.vfs)).rejects.toThrow('metadata failure')
    expect(remote.requests).toHaveLength(0)
    expect(runtime.vfs.existsSync(`${root}/file.bin`)).toBe(false)
  })

  it('propagates VFS publication failure after releasing the verified connection', async () => {
    const remote = wire(source)
    const network = workspaceFetch(source, () => remote.response)
    const runtime = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true, onStatus: () => {} })
    vi.spyOn(runtime.vfs, 'seed').mockImplementation(() => { throw new Error('VFS publication failed') })
    await expect(runtime.prepareVfs(runtime.vfs)).rejects.toThrow('VFS publication failed')
    expect(runtime.vfs.existsSync(`${root}/file.bin`)).toBe(false)
    expect(remote.body.locked).toBe(false)
    expect(network.requests[0]?.signal?.aborted).toBe(true)
  })
})

describe('failed OPFS download publication', () => {
  it.each(['corrupt', 'truncated', 'excess', 'aborted', 'write', 'close', 'create'] as const)(
    'removes only the new unpublished entry after %s and restores without clearing storage', async fault => {
      const bytes = fault === 'truncated' ? source.subarray(0, source.byteLength - 1)
        : fault === 'excess' ? new Uint8Array([...source, 1])
          : fault === 'corrupt' ? new Uint8Array(source.byteLength) : source
      const remote = wire(bytes, [chunkBytes], { headers: {
        'x-content-sha256': hash(source), 'x-total-bytes': String(source.byteLength), 'content-length': String(source.byteLength),
      }, ...(fault === 'aborted' ? { failAfter: chunkBytes } : {}) })
      const network = workspaceFetch(source, () => remote.response)
      const options = { createFailure: fault === 'create', writeFailure: fault === 'write', closeFailure: fault === 'close' }
      const cache = opfsCache(undefined, options)
      vi.spyOn(cache.store, 'listWorkspaceIds').mockResolvedValue([])
      vi.spyOn(cache.store, 'load').mockResolvedValue(undefined)
      vi.spyOn(cache.store, 'save').mockResolvedValue()
      vi.spyOn(cache.store, 'reconcileBlobs').mockResolvedValue({ removedFiles: 0, removedBytes: 0, retainedFiles: 1 })
      const runtime = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true, store: cache.store, onStatus: () => {} })
      await expect(runtime.prepareVfs(runtime.vfs)).rejects.toThrow()
      expect(cache.canonical()).toBeUndefined()
      expect(await cache.store.openBlob(workspaceId, hash(source), source.byteLength)).toBeUndefined()
      expect(runtime.vfs.existsSync(`${root}/file.bin`)).toBe(false)
      expect(cache.writable.close).toHaveBeenCalledTimes(fault === 'close' ? 1 : 0)
      expect(network.calls.some(path => path.includes('/chunk/'))).toBe(false)
      expect(remote.body.locked).toBe(false)
      if (fault !== 'create') expect(network.requests[0]?.signal?.aborted).toBe(true)
      options.createFailure = false
      options.writeFailure = false
      options.closeFailure = false
      const recoveredWire = wire(source, [chunkBytes])
      workspaceFetch(source, () => recoveredWire.response)
      const recovered = createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true, store: cache.store, onStatus: () => {} })
      await recovered.prepareVfs(recovered.vfs)
      expect(recovered.vfs.readFileSync(`${root}/file.bin`)).toEqual(source)
    },
  )

  it.each([0, 31, source.byteLength])(
    'retains existing damaged objects and keeps openBlob fail-closed (%i bytes)', async length => {
      const existing = new Uint8Array(length)
      const cache = opfsCache(existing)
      const read = vi.fn()
      await expect(cache.store.openBlob(workspaceId, hash(source), source.byteLength)).rejects.toMatchObject({
        code: existing.byteLength === source.byteLength ? 'LOCAL_BLOB_CORRUPT' : 'LOCAL_BLOB_SIZE_MISMATCH',
      })
      await expect(cache.store.cacheBlobFromChunks(workspaceId, hash(source), source.byteLength, read)).rejects.toThrow()
      expect(cache.canonical()).toEqual(existing)
      expect(cache.directory.removeEntry).not.toHaveBeenCalled()
      expect(cache.handle.createWritable).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
    },
  )

  it('cleans a new empty entry even if abort rejects', async () => {
    const cache = opfsCache(undefined, { writeFailure: true, abortFailure: true })
    await expect(cache.store.cacheBlobFromChunks(workspaceId, hash(source), source.byteLength,
      async (offset, length) => source.subarray(offset, offset + length))).rejects.toThrow('OPFS write failed')
    expect(cache.writable.abort).toHaveBeenCalledTimes(1)
    expect(cache.canonical()).toBeUndefined()
  })

  it('exposes only the typed unsupported error for a precise fallback response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'FILE_DOWNLOAD_UNSUPPORTED' } }, 409)))
    const download = createVerifiedDownload(workspaceId, hash(source), source.byteLength)
    try {
      await expect(download.read(0, chunkBytes)).rejects.toBeInstanceOf(VerifiedDownloadUnsupportedError)
    } finally {
      await download.close()
    }
  })
})
