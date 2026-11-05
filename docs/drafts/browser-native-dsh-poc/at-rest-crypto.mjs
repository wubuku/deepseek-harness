/**
 * AES-256-GCM encryption for browser-native DSH data files at rest.
 *
 * Session logs, Workspace blobs, attachments, and the observability journal are
 * written as one self-describing envelope: a magic prefix, format version,
 * key id, random 96-bit IV, GCM ciphertext, and the 16-byte authentication tag.
 * The header prefix and a per-surface context string are authenticated as AAD,
 * so a ciphertext copied to another surface or truncated on disk fails to
 * decrypt instead of being interpreted as different data.
 *
 * Keys come from the deployment either inline (`DSH_POC_AT_REST_KEY`) or from a
 * file (`DSH_POC_AT_REST_KEY_FILE`) that must not be group- or world-readable.
 * A data directory that was written with a key records a key-check file; a
 * later start without that key, or with a different one, refuses to boot rather
 * than silently writing plaintext next to unreadable ciphertext.
 *
 * One cipher can hold several keys so a rotation can add a successor, activate
 * it for new writes, and keep decrypting files that still use the predecessor.
 * A key-check passes when the configured keyring contains the recorded key, not
 * only when that key is active, so an interrupted rotation stays restartable.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile as readFileRaw, stat, writeFile as writeFileRaw } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const MAGIC = Buffer.from('DSHENC', 'ascii')
const VERSION = 1
const KEY_ID_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = MAGIC.length + 1 + KEY_ID_BYTES + IV_BYTES
/** Bytes added to every stored file by {@link createAtRestCipher}. */
export const AT_REST_OVERHEAD_BYTES = HEADER_BYTES + TAG_BYTES
const KEY_BYTES = 32
const MAX_KEY_FILE_BYTES = 64 * 1024
const KEY_CHECK_FILE = '.browser-native-at-rest-key-check'
const KEY_CHECK_PLAINTEXT = 'browser-native-at-rest-key-check'
const KEY_CHECK_CONTEXT = 'at-rest/key-check'

/** Environment names read by hosted deployments and validation runners. */
export const AT_REST_ENV = Object.freeze({
  mode: 'DSH_POC_AT_REST_ENCRYPTION',
  key: 'DSH_POC_AT_REST_KEY',
  keyId: 'DSH_POC_AT_REST_KEY_ID',
  keyFile: 'DSH_POC_AT_REST_KEY_FILE',
})

/** Typed at-rest failure carrying a stable code for startup and read paths. */
export class AtRestError extends Error {
  /**
   * @param {string} code - Stable failure code.
   * @param {string} message - Operator-facing message naming the fix.
   */
  constructor(code, message) {
    super(message)
    this.name = 'AtRestError'
    this.code = code
  }
}

/**
 * Derive the recorded key id from a 32-byte key.
 * @param {Buffer} key - AES-256 key.
 * @returns {string} 16 ASCII hex characters.
 */
export function keyIdFor(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** Whether one buffer starts with the at-rest envelope magic. */
export function isAtRestEnvelope(bytes) {
  return bytes.length >= HEADER_BYTES && bytes.subarray(0, MAGIC.length).equals(MAGIC)
}

/**
 * Read the key id recorded in one at-rest envelope.
 * @param bytes - Stored file bytes.
 * @returns 16 ASCII hex characters, or undefined for plaintext bytes.
 */
export function envelopeKeyId(bytes) {
  if (!isAtRestEnvelope(bytes)) return undefined
  return bytes.subarray(MAGIC.length + 1, MAGIC.length + 1 + KEY_ID_BYTES).toString('ascii')
}

function assertKey(key, label) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new AtRestError('AT_REST_KEY_INVALID', `${label} must decode to exactly 32 bytes`)
  }
  return key
}

function decodeBase64Key(text, label) {
  if (typeof text !== 'string' || text.length === 0) throw new AtRestError('AT_REST_KEY_INVALID', `${label} is empty`)
  const key = Buffer.from(text, 'base64')
  return assertKey(key, label)
}

/** Parse an explicitly configured key id, or derive one from the key. */
function normalizeKeyId(value, key, label) {
  const keyId = value === undefined || value === '' ? keyIdFor(key) : value
  if (typeof keyId !== 'string' || !/^[0-9a-f]{16}$/.test(keyId)) {
    throw new AtRestError('AT_REST_KEY_INVALID', `${label} must be 16 lowercase hex characters`)
  }
  return keyId
}

/**
 * Read a key file whose first non-comment entry is the active key.
 *
 * Each entry is `keyId=base64key` or a bare `base64key`. The file must be a
 * regular file and must not be readable or writable by group or others.
 * @param {string} path - Key file path.
 * @returns {Promise<{keyId: string, key: Buffer}[]>} Parsed keys in file order.
 */
async function readKeyFile(path) {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new AtRestError('AT_REST_KEY_REQUIRED', `at-rest key file ${path} does not exist`)
    }
    throw error
  }
  if (!info.isFile()) throw new AtRestError('AT_REST_KEY_INVALID', `at-rest key file ${path} is not a regular file`)
  if ((info.mode & 0o077) !== 0) {
    throw new AtRestError('AT_REST_KEY_FILE_PERMISSIONS',
      `at-rest key file ${path} is accessible beyond its owner (mode ${(info.mode & 0o777).toString(8)}); use chmod 600`)
  }
  if (info.size > MAX_KEY_FILE_BYTES) throw new AtRestError('AT_REST_KEY_INVALID', `at-rest key file ${path} is too large`)
  const text = await readFileRaw(path, 'utf8')
  const keys = []
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    let keyId
    let encoded = line
    if (separator > 0) {
      keyId = line.slice(0, separator).trim()
      encoded = line.slice(separator + 1).trim()
    }
    const label = `at-rest key file ${path} line ${String(index + 1)}`
    const key = decodeBase64Key(encoded, label)
    keys.push({ keyId: normalizeKeyId(keyId, key, label), key })
  }
  if (keys.length === 0) throw new AtRestError('AT_REST_KEY_INVALID', `at-rest key file ${path} contains no keys`)
  const ids = new Set()
  for (const entry of keys) {
    if (ids.has(entry.keyId)) throw new AtRestError('AT_REST_KEY_INVALID', `at-rest key file ${path} repeats key id ${entry.keyId}`)
    ids.add(entry.keyId)
  }
  return keys
}

/**
 * Read at-rest deployment configuration from the environment.
 *
 * `auto` (the default) encrypts when a key is configured and leaves new writes
 * plaintext otherwise; `required` refuses to start without a key. A data
 * directory that already holds ciphertext refuses to start without its key
 * regardless of this setting (see {@link assertAtRestReady}).
 * @param {Record<string, string | undefined>} [environment] - Hosted environment or a test stand-in.
 * @returns {Promise<{mode: 'auto'|'required', keys: {keyId: string, key: Buffer}[], activeKeyId: string|undefined}>} Parsed keyring.
 */
export async function loadAtRestKeyringFromEnv(environment = process.env) {
  const modeRaw = environment[AT_REST_ENV.mode]
  const mode = modeRaw === undefined || modeRaw === '' || modeRaw === 'auto' ? 'auto' : modeRaw
  if (mode !== 'auto' && mode !== 'required') {
    throw new AtRestError('AT_REST_CONFIGURATION', `${AT_REST_ENV.mode} must be auto or required`)
  }
  const keyFile = environment[AT_REST_ENV.keyFile] || undefined
  const inline = environment[AT_REST_ENV.key] || undefined
  if (keyFile !== undefined && inline !== undefined) {
    throw new AtRestError('AT_REST_CONFIGURATION', `${AT_REST_ENV.keyFile} and ${AT_REST_ENV.key} must not both be set`)
  }
  if (keyFile === undefined && inline === undefined) {
    if (mode === 'required') {
      throw new AtRestError('AT_REST_KEY_REQUIRED',
        `${AT_REST_ENV.mode}=required needs ${AT_REST_ENV.keyFile} or ${AT_REST_ENV.key}`)
    }
    return { mode, keys: [], activeKeyId: undefined }
  }
  let keys
  if (keyFile === undefined) {
    const key = decodeBase64Key(inline, AT_REST_ENV.key)
    keys = [{ keyId: normalizeKeyId(environment[AT_REST_ENV.keyId], key, AT_REST_ENV.key), key }]
  } else {
    keys = await readKeyFile(resolve(keyFile))
  }
  return { mode, keys, activeKeyId: keys[0].keyId }
}

/** Write `bytes` to one file path, creating its directory first. */
async function writeFileBytes(path, bytes, mode) {
  await mkdir(dirname(path), { recursive: true })
  await writeFileRaw(path, bytes, mode === undefined ? undefined : { mode })
}

/**
 * Create the cipher used by every at-rest store in one backend process.
 * @param {{keys: {keyId: string, key: Buffer}[], activeKeyId: string}} keyring - Loaded keyring; the active key encrypts new writes.
 * @returns {object} Encrypt, decrypt, and file helpers sharing one key id.
 */
export function createAtRestCipher(keyring) {
  if (keyring === undefined || keyring.keys === undefined || keyring.keys.length === 0) {
    throw new AtRestError('AT_REST_KEY_REQUIRED', 'at-rest encryption requires at least one key')
  }
  const keys = new Map()
  for (const entry of keyring.keys) keys.set(entry.keyId, assertKey(entry.key, `key ${entry.keyId}`))
  let activeKeyId = keyring.activeKeyId ?? keyring.keys[0].keyId
  if (!keys.has(activeKeyId)) throw new AtRestError('AT_REST_KEY_INVALID', `active key id ${activeKeyId} is not in the keyring`)
  const activeKey = () => keys.get(activeKeyId)

  const requireKey = forKeyId => {
    const found = keys.get(forKeyId)
    if (found === undefined) {
      throw new AtRestError('AT_REST_KEY_UNKNOWN',
        `stored data uses at-rest key ${forKeyId}, which is not in the configured keyring`)
    }
    return found
  }

  const aadFor = (prefix, context) => Buffer.concat([prefix, Buffer.from(String(context), 'utf8')])

  const encryptBuffer = (plaintext, context) => {
    if (!(plaintext instanceof Uint8Array)) throw new TypeError('at-rest encryption requires bytes')
    const key = activeKey()
    const iv = randomBytes(IV_BYTES)
    const prefix = Buffer.concat([MAGIC, Buffer.from([VERSION]), Buffer.from(activeKeyId, 'ascii'), iv])
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aadFor(prefix, context))
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return Buffer.concat([prefix, body, cipher.getAuthTag()])
  }

  const decryptBuffer = (envelope, context) => {
    if (!Buffer.isBuffer(envelope) || envelope.length < HEADER_BYTES + TAG_BYTES) {
      throw new AtRestError('AT_REST_CIPHERTEXT_CORRUPT', 'stored ciphertext is shorter than its envelope header')
    }
    if (!envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new AtRestError('AT_REST_CIPHERTEXT_CORRUPT', 'stored bytes are not an at-rest envelope')
    }
    const version = envelope[MAGIC.length]
    if (version !== VERSION) {
      throw new AtRestError('AT_REST_CIPHERTEXT_CORRUPT', `at-rest envelope version ${String(version)} is unsupported`)
    }
    const forKeyId = envelope.subarray(MAGIC.length + 1, MAGIC.length + 1 + KEY_ID_BYTES).toString('ascii')
    const storedKey = requireKey(forKeyId)
    const iv = envelope.subarray(MAGIC.length + 1 + KEY_ID_BYTES, HEADER_BYTES)
    const prefix = envelope.subarray(0, HEADER_BYTES)
    const tag = envelope.subarray(envelope.length - TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', storedKey, iv)
    decipher.setAAD(aadFor(prefix, context))
    decipher.setAuthTag(tag)
    try {
      return Buffer.concat([decipher.update(envelope.subarray(HEADER_BYTES, envelope.length - TAG_BYTES)), decipher.final()])
    } catch {
      // Any header, context, ciphertext, or tag change makes GCM verification fail.
      throw new AtRestError('AT_REST_CIPHERTEXT_CORRUPT',
        'stored ciphertext failed AES-256-GCM authentication (wrong key, changed context, or damaged bytes)')
    }
  }

  return Object.freeze({
    /** Active key id; new envelopes are written with it. */
    get keyId() { return activeKeyId },
    /** Configured key ids, in no particular order. */
    keyIds: () => [...keys.keys()],
    /**
     * Add or replace key material and optionally change the active key.
     * @param incoming - Keys to install.
     * @param nextActiveKeyId - New active key id, or the current one.
     * @returns Nothing.
     */
    addKeys: (incoming, nextActiveKeyId) => {
      for (const entry of incoming) keys.set(entry.keyId, assertKey(entry.key, `key ${entry.keyId}`))
      if (nextActiveKeyId !== undefined) {
        if (!keys.has(nextActiveKeyId)) {
          throw new AtRestError('AT_REST_KEY_INVALID', `active key id ${nextActiveKeyId} is not in the keyring`)
        }
        activeKeyId = nextActiveKeyId
      }
    },
    /**
     * Remove one non-active key from the keyring.
     * @param retiredKeyId - Key id to remove.
     * @returns Whether the key was present.
     */
    retireKey: retiredKeyId => {
      if (retiredKeyId === activeKeyId) {
        throw new AtRestError('AT_REST_KEY_INVALID', `cannot retire the active at-rest key ${retiredKeyId}`)
      }
      return keys.delete(retiredKeyId)
    },
    /** Bytes a file grows by when it is stored encrypted. */
    overheadBytes: AT_REST_OVERHEAD_BYTES,
    encryptBuffer,
    decryptBuffer,
    /**
     * Encrypt text into one base64 line safe for JSONL ledgers.
     * @param text - UTF-8 text.
     * @param context - Surface label bound into the envelope AAD.
     * @returns Base64 envelope.
     */
    encryptText: (text, context) => encryptBuffer(Buffer.from(text, 'utf8'), context).toString('base64'),
    /**
     * Decrypt one ledger line, accepting legacy plaintext so a keyless data
     * directory can be upgraded in place.
     * @param text - Base64 envelope or legacy JSON text.
     * @param context - Surface label bound into the envelope AAD.
     * @returns Decrypted UTF-8 text.
     */
    decryptText: (text, context) => {
      const decoded = /^[A-Za-z0-9+/=]+$/.test(text) ? Buffer.from(text, 'base64') : undefined
      if (decoded === undefined || !isAtRestEnvelope(decoded)) return text
      return decryptBuffer(decoded, context).toString('utf8')
    },
    /**
     * Create an incremental encryptor for streamed writes.
     * Call `header()`, then feed each plaintext chunk to `update()`, then write
     * `finish()` once.
     * @param context - Surface label bound into the envelope AAD.
     * @returns Header, update, and finish byte producers.
     */
    createEncryptor: context => {
      const key = activeKey()
      const iv = randomBytes(IV_BYTES)
      const prefix = Buffer.concat([MAGIC, Buffer.from([VERSION]), Buffer.from(activeKeyId, 'ascii'), iv])
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(aadFor(prefix, context))
      return {
        header: () => prefix,
        update: chunk => cipher.update(chunk),
        finish: () => Buffer.concat([cipher.final(), cipher.getAuthTag()]),
      }
    },
    /**
     * Read one file, decrypting an envelope and returning legacy plaintext as is.
     * @param path - File path.
     * @param context - Surface label bound into the envelope AAD.
     * @returns Plaintext bytes.
     */
    readFile: async (path, context) => {
      const bytes = await readFileRaw(path)
      return isAtRestEnvelope(bytes) ? decryptBuffer(bytes, context) : bytes
    },
    /**
     * Read one UTF-8 file through {@link readFile}.
     * @param path - File path.
     * @param context - Surface label bound into the envelope AAD.
     * @returns Plaintext text.
     */
    readText: async (path, context) => (await cipherReadFile(path, context)).toString('utf8'),
    /**
     * Encrypt and write one file, replacing its contents atomically when the
     * caller supplies a unique temporary path.
     * @param path - Target path.
     * @param data - Plaintext bytes or UTF-8 text.
     * @param context - Surface label bound into the envelope AAD.
     * @param mode - Optional file mode.
     * @returns Promise resolving after the write.
     */
    writeFile: async (path, data, context, mode) => {
      const plaintext = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
      await writeFileBytes(path, encryptBuffer(plaintext, context), mode)
    },
    /**
     * Report the plaintext length of one stored object without decrypting it.
     * @param path - File path.
     * @returns `{size, encrypted}` or undefined when the file is absent.
     */
    statPlaintextSize: async path => {
      let info
      try {
        info = await stat(path)
      } catch (error) {
        if (error?.code === 'ENOENT') return undefined
        throw error
      }
      const handle = await open(path, 'r')
      try {
        const head = Buffer.alloc(MAGIC.length + 1)
        const { bytesRead } = await handle.read(head, 0, head.length, 0)
        const encrypted = bytesRead === head.length
          && head.subarray(0, MAGIC.length).equals(MAGIC)
          && head[MAGIC.length] === VERSION
        if (!encrypted) return { size: info.size, encrypted: false }
        const size = info.size - AT_REST_OVERHEAD_BYTES
        if (size < 0) throw new AtRestError('AT_REST_CIPHERTEXT_CORRUPT', `${path} is shorter than its envelope header`)
        return { size, encrypted: true }
      } finally {
        await handle.close()
      }
    },
    ciphertextSize: plaintextBytes => plaintextBytes + AT_REST_OVERHEAD_BYTES,
  })

  async function cipherReadFile(path, context) {
    const bytes = await readFileRaw(path)
    return isAtRestEnvelope(bytes) ? decryptBuffer(bytes, context) : bytes
  }
}

/**
 * Verify this data directory can be opened with (or without) the configured key.
 *
 * A key-check file records the key id and one authenticated sample. Its
 * presence means the directory was written encrypted: a start without the key,
 * or with any other key, is refused before any store opens. On the first keyed
 * start the file is created; legacy plaintext directories are unaffected.
 * @param {{dataDir: string, cipher?: object}} request - Data directory and optional cipher.
 * @returns {Promise<{state: 'plaintext'|'encrypted', keyId?: string, initialized?: boolean}>} Ready state for health output.
 */
export async function assertAtRestReady({ dataDir, cipher }) {
  const directory = resolve(dataDir)
  const checkPath = join(directory, KEY_CHECK_FILE)
  const check = await readFileRaw(checkPath, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (cipher === undefined) {
    if (check !== undefined || await hasEncryptedSessions(directory)) {
      throw new AtRestError('AT_REST_KEY_REQUIRED',
        `data directory ${directory} holds encrypted data but no at-rest key is configured; ` +
        `set ${AT_REST_ENV.keyFile} or ${AT_REST_ENV.key} (${AT_REST_ENV.mode}=required in deployment)`)
    }
    return { state: 'plaintext' }
  }
  if (check !== undefined) {
    let record
    try {
      record = JSON.parse(check)
    } catch {
      throw new AtRestError('AT_REST_KEY_INVALID', `key-check file ${checkPath} is not valid JSON`)
    }
    if (record?.version !== 1 || typeof record.keyId !== 'string' || typeof record.ciphertext !== 'string') {
      throw new AtRestError('AT_REST_KEY_INVALID', `key-check file ${checkPath} is invalid`)
    }
    const sample = Buffer.from(record.ciphertext, 'base64')
    if (envelopeKeyId(sample) !== record.keyId) {
      throw new AtRestError('AT_REST_KEY_INVALID', `key-check file ${checkPath} records a different key id than its sample`)
    }
    let plaintext
    try {
      plaintext = cipher.decryptBuffer(sample, KEY_CHECK_CONTEXT).toString('utf8')
    } catch (error) {
      // The recorded key may be a predecessor during rotation; only its absence
      // or a failed authentication makes the directory unreadable.
      throw new AtRestError('AT_REST_KEY_INVALID',
        `configured keyring cannot decrypt the key-check file written with ${record.keyId} (${error instanceof Error ? error.message : String(error)})`)
    }
    if (plaintext !== KEY_CHECK_PLAINTEXT) {
      throw new AtRestError('AT_REST_KEY_INVALID', `key-check file ${checkPath} does not verify with the configured keyring`)
    }
    return { state: 'encrypted', keyId: cipher.keyId }
  }
  await writeAtRestKeyCheck(directory, cipher)
  return { state: 'encrypted', keyId: cipher.keyId, initialized: true }
}

/**
 * Write the key-check sample for the cipher's active key.
 *
 * Rotation calls this after every file has been re-encrypted so a restart with
 * only the successor key accepts the directory; an interrupted rotation leaves
 * the previous sample in place and needs both keys.
 * @param dataDir - Data directory that owns the check file.
 * @param cipher - Cipher whose active key signs the sample.
 * @returns Promise resolving after the file is durable.
 */
export async function writeAtRestKeyCheck(dataDir, cipher) {
  const directory = resolve(dataDir)
  const checkPath = join(directory, KEY_CHECK_FILE)
  const ciphertext = cipher.encryptBuffer(Buffer.from(KEY_CHECK_PLAINTEXT, 'utf8'), KEY_CHECK_CONTEXT)
  await writeFileBytes(checkPath, `${JSON.stringify({ version: 1, keyId: cipher.keyId, ciphertext: ciphertext.toString('base64') })}\n`, 0o600)
}

/** Whether any stored Session log at the root of `sessions/` is encrypted. */
async function hasEncryptedSessions(dataDir) {
  const directory = join(dataDir, 'sessions')
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const head = Buffer.alloc(MAGIC.length)
    const stream = createReadStream(join(directory, entry.name), { end: MAGIC.length - 1 })
    for await (const chunk of stream) chunk.copy(head, 0)
    if (head.equals(MAGIC)) return true
  }
  return false
}
