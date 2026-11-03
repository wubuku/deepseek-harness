/**
 * The image download. A boot depends on one large, idempotent GET, so a transport
 * failure is worth another attempt: the worker has nothing else to show, and
 * every retry starts a fresh response rather than resuming a broken one.
 *
 * Retries are bounded and jittered. Bounded because a deployment that does not
 * serve the image stays broken; jittered because a freshly opened set of workers
 * fails together, and synchronized retries would rebuild the same burst that
 * caused the failure. Only transport failures (`TypeError` from `fetch` or from
 * reading the body) and transient HTTP statuses are retried; a refusal by name
 * from the gzip envelope, or a 4xx, fails immediately so a misconfigured
 * deployment is not reported as a flaky network.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/storage/image-fetch
 */
import { inflateImage, inflateImageStream } from './image-gzip.ts'

/** Total attempts for one image GET, including the first one. */
const IMAGE_FETCH_ATTEMPTS = 3

/** Base backoff between attempts, multiplied by the attempt number. */
const IMAGE_FETCH_BACKOFF_MS = 250

/** Added to the backoff so workers that failed together do not retry together. */
const IMAGE_FETCH_JITTER_MS = 250

/** An image response whose status says the deployment is reachable but not serving the image now. */
class ImageHttpStatusError extends Error {
  /**
   * @param image - image URL, named in the message.
   * @param status - HTTP status the deployment answered with.
   */
  constructor(
    readonly image: string,
    readonly status: number,
  ) {
    super(`webworker host: image fetch failed with ${String(status)} for ${image}`)
  }
}

/** Statuses that describe a transient condition rather than a refusal: retry timeout, throttling, and server faults. */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/** One attempt may fail in the transport (`TypeError`) or in the served status; everything else is a refusal. */
function retryableFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof ImageHttpStatusError && retryableStatus(error.status))
}

/** Sleep before the next attempt, spreading simultaneous boots apart. */
async function backoff(attempt: number): Promise<void> {
  const delay = IMAGE_FETCH_BACKOFF_MS * attempt + Math.random() * IMAGE_FETCH_JITTER_MS
  await new Promise<void>((resolve) => { setTimeout(resolve, delay) })
}

/**
 * Fetch the packed image over HTTP, retrying a bounded number of transport and
 * transient-status failures.
 * @param image - image URL.
 * @returns the ustar archive the image carries.
 * @throws When every attempt fails, or the first non-retryable failure arrives.
 */
async function fetchImageArchive(image: string): Promise<Uint8Array> {
  let lastError: unknown
  for (let attempt = 1; attempt <= IMAGE_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(image)
      if (!response.ok) throw new ImageHttpStatusError(image, response.status)
      if (response.body === null) throw new Error(`webworker host: image response for ${image} carried no body`)
      // Inflated off the response stream: the archive is built while the rest of
      // the image is still arriving.
      return await inflateImageStream(response.body, image)
    } catch (error) {
      lastError = error
      if (!retryableFailure(error) || attempt === IMAGE_FETCH_ATTEMPTS) throw error
      await backoff(attempt)
    }
  }
  throw lastError
}

/**
 * Resolve the image: inflate caller-supplied bytes, or download and inflate the
 * image URL.
 * @param image - image URL, or the packed bytes themselves.
 * @returns the ustar archive the image carries.
 * @throws When the URL cannot be fetched after every attempt, or the bytes are not a gzip member.
 */
export async function readImage(image: Uint8Array | string): Promise<Uint8Array> {
  if (typeof image !== 'string') return await inflateImage(image, 'the image bytes given to createWorkerHost')
  return await fetchImageArchive(image)
}
