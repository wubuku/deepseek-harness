/**
 * The image download retries transport failures and transient statuses, and
 * refuses everything else at once.
 *
 * The load-bearing case is the truncated first response: a cold browser aborting
 * a large image download mid-body is exactly how a fresh worker sees the failure,
 * and a boot that cannot take a second attempt never reaches the tree. The spec
 * also pins the refusals — a 404 or an exhausted attempt budget must stay an
 * error instead of becoming a boot that waits forever.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { readImage } from '../../src/storage/image-fetch.ts'
import { packTar } from '../../src/storage/tar.ts'

const encoder = new TextEncoder()

/** A one-entry archive, as the packer would lay one out. */
const archive = (): Uint8Array => packTar({ 'config/cordis.yml': encoder.encode('- id: subject\n') })

/** How one request is answered; the attempt number starts at one. */
type Serving = (attempt: number, response: ServerResponse) => void

interface Harness {
  readonly url: string
  readonly requests: () => number
  close(): Promise<void>
}

/** Serve one image URL with the named behavior and count requests. */
async function serveImage(serving: Serving): Promise<Harness> {
  let requests = 0
  const handler = (_request: IncomingMessage, response: ServerResponse): void => {
    requests += 1
    serving(requests, response)
  }
  const server = createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('spec server did not bind a port')
  return {
    url: `http://127.0.0.1:${String(address.port)}/preview/vfs-image.tar.gz`,
    requests: () => requests,
    close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) },
  }
}

/** Send the whole compressed image. */
function sendImage(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'application/gzip' })
  response.end(gzipSync(archive()))
}

/** Send a body that stops mid-member, the way an aborted download arrives. */
function sendPartial(response: ServerResponse): void {
  const bytes = gzipSync(archive())
  response.writeHead(200, { 'content-type': 'application/gzip' })
  response.write(bytes.subarray(0, 32))
  response.destroy()
}

const harnesses: Harness[] = []
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async (harness) => { await harness.close() }))
})

describe('image fetch', () => {
  it('returns the archive from the first response when it completes', async () => {
    const harness = await serveImage((_attempt, response) => { sendImage(response) })
    harnesses.push(harness)
    expect([...await readImage(harness.url)]).toEqual([...archive()])
    expect(harness.requests()).toBe(1)
  })

  it('retries a response truncated mid-body', async () => {
    const harness = await serveImage((attempt, response) => {
      if (attempt === 1) sendPartial(response)
      else sendImage(response)
    })
    harnesses.push(harness)
    expect([...await readImage(harness.url)]).toEqual([...archive()])
    expect(harness.requests()).toBe(2)
  })

  it('retries a transient server status', async () => {
    const harness = await serveImage((attempt, response) => {
      if (attempt === 1) response.writeHead(503).end()
      else sendImage(response)
    })
    harnesses.push(harness)
    expect([...await readImage(harness.url)]).toEqual([...archive()])
    expect(harness.requests()).toBe(2)
  })

  it('refuses a missing image without a second attempt', async () => {
    const harness = await serveImage((_attempt, response) => { response.writeHead(404).end() })
    harnesses.push(harness)
    await expect(readImage(harness.url)).rejects.toThrow('image fetch failed with 404')
    expect(harness.requests()).toBe(1)
  })

  it('stops after the attempt budget when every response is truncated', async () => {
    const harness = await serveImage((_attempt, response) => { sendPartial(response) })
    harnesses.push(harness)
    await expect(readImage(harness.url)).rejects.toBeInstanceOf(TypeError)
    expect(harness.requests()).toBe(3)
  })
})
