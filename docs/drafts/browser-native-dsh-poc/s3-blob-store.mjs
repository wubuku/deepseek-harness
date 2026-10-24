import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { WorkspaceError } from './workspace-v2.mjs'

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isMissing(error) {
  return error?.$metadata?.httpStatusCode === 404
    || error?.name === 'NoSuchKey'
    || error?.name === 'NotFound'
}

function unavailable(error) {
  if (error instanceof WorkspaceError) return error
  return new WorkspaceError('BLOB_STORE_UNAVAILABLE', 'Workspace blob storage is unavailable', 503)
}

/** Store content-addressed Workspace blobs in an S3-compatible service. */
export class S3WorkspaceBlobStore {
  /**
   * Create an S3-compatible blob store client.
   * @param {object} options - Endpoint, bucket, region, and backend-only credentials.
   * @param {string} options.endpoint - S3 service URL.
   * @param {string} options.bucket - Private bucket for immutable blobs.
   * @param {string} options.accessKeyId - Backend-only access key.
   * @param {string} options.secretAccessKey - Backend-only secret key.
   * @param {string} [options.region] - Signing region.
   */
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'us-east-1' }) {
    if (typeof endpoint !== 'string' || typeof bucket !== 'string' || bucket.length === 0
      || typeof accessKeyId !== 'string' || typeof secretAccessKey !== 'string') {
      throw new TypeError('S3 blob store requires endpoint, bucket, and backend credentials')
    }
    this.bucket = bucket
    this.client = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: { accessKeyId, secretAccessKey },
    })
    this.putLocks = new Map()
  }

  key(hash) {
    return `sha256/${hash.slice(0, 2)}/${hash}`
  }

  /** Create the private bucket if it is absent. */
  async initialize() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
    } catch (error) {
      if (!isMissing(error)) throw unavailable(error)
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }))
      } catch (createError) {
        throw unavailable(createError)
      }
    }
  }

  /** Return a blob's byte length, or undefined when its object key is absent. */
  async stat(hash) {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(hash) }))
      return { size: Number(result.ContentLength) }
    } catch (error) {
      if (isMissing(error)) return undefined
      throw unavailable(error)
    }
  }

  /** Read and verify a full immutable blob. */
  async get(hash) {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(hash) }))
      if (result.Body === undefined) throw new WorkspaceError('BLOB_CORRUPT', 'stored blob has no response body', 500)
      return Buffer.from(await result.Body.transformToByteArray())
    } catch (error) {
      if (error instanceof WorkspaceError) throw error
      if (isMissing(error)) throw new WorkspaceError('BLOB_NOT_FOUND', 'workspace blob is missing', 404)
      throw unavailable(error)
    }
  }

  /** Read only the requested byte range from an S3 object. */
  async getRange(hash, offset, length) {
    try {
      const end = offset + length - 1
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(hash),
        Range: `bytes=${String(offset)}-${String(end)}`,
      }))
      if (result.Body === undefined) throw new WorkspaceError('BLOB_CORRUPT', 'stored blob range has no response body', 500)
      return Buffer.from(await result.Body.transformToByteArray())
    } catch (error) {
      if (error instanceof WorkspaceError) throw error
      if (isMissing(error)) throw new WorkspaceError('BLOB_NOT_FOUND', 'workspace blob is missing', 404)
      throw unavailable(error)
    }
  }

  /**
   * Verify an object's size and SHA-256 while streaming it from storage.
   * @param {string} hash - Expected SHA-256 object key.
   * @param {number} expectedBytes - Expected byte length.
   * @returns {Promise<boolean>} Whether the object content matches its key and size.
   */
  async verify(hash, expectedBytes) {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(hash) }))
      if (result.Body === undefined) return false
      const digest = createHash('sha256')
      let byteLength = 0
      for await (const chunk of result.Body) {
        digest.update(chunk)
        byteLength += chunk.byteLength
      }
      return byteLength === expectedBytes && digest.digest('hex') === hash
    } catch (error) {
      if (isMissing(error)) return false
      throw unavailable(error)
    }
  }

  /** Store verified content without replacing an existing hash key. */
  async put(hash, bytes) {
    return await this.#withHashLock(hash, async () => await this.#put(hash, bytes))
  }

  /**
   * Stream a staged file whose length and hash were checked by the caller.
   * @param {string} hash - Expected SHA-256 object key.
   * @param {string} path - Staged file path.
   * @param {number} byteLength - Verified byte length.
   * @returns {Promise<{ reused: boolean }>} Whether the verified object already existed.
   */
  async putFile(hash, path, byteLength) {
    return await this.#withHashLock(hash, async () => {
      const existing = await this.stat(hash)
      if (existing !== undefined) return await this.#verifyExisting(hash, byteLength, existing.size)
      try {
        await this.client.send(new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(hash),
          Body: createReadStream(path),
          ContentLength: byteLength,
          Metadata: { sha256: hash },
        }))
        return { reused: false }
      } catch (error) {
        throw unavailable(error)
      }
    })
  }

  async #withHashLock(hash, operation) {
    const previous = this.putLocks.get(hash) ?? Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    this.putLocks.set(hash, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.putLocks.get(hash) === current) this.putLocks.delete(hash)
    }
  }

  async #put(hash, bytes) {
    if (hashBytes(bytes) !== hash) {
      throw new WorkspaceError('BLOB_CORRUPT', 'uploaded content does not match its SHA-256 key', 400)
    }
    const existing = await this.stat(hash)
    if (existing !== undefined) return await this.#verifyExisting(hash, bytes.byteLength, existing.size)
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(hash),
        Body: bytes,
        ContentLength: bytes.byteLength,
        Metadata: { sha256: hash },
      }))
      return { reused: false }
    } catch (error) {
      throw unavailable(error)
    }
  }

  async #verifyExisting(hash, expectedBytes, existingSize) {
    if (existingSize !== expectedBytes || !await this.verify(hash, expectedBytes)) {
      throw new WorkspaceError('BLOB_CORRUPT', 'stored blob failed size or SHA-256 verification', 500)
    }
    return { reused: true }
  }

  /** Close the AWS SDK's connection pools. */
  close() {
    this.client.destroy()
  }
}
