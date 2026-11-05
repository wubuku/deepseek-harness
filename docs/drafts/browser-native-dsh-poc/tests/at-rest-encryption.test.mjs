/**
 * At-rest AES-256-GCM envelope behavior.
 *
 * Covers round trips, AAD context binding, damaged ciphertext, keyring parsing
 * and key-file permissions, the startup key-check that refuses a missing or
 * different key before any store opens, and key rotation across every surface.
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  AT_REST_ENV,
  AT_REST_OVERHEAD_BYTES,
  AtRestError,
  assertAtRestReady,
  createAtRestCipher,
  envelopeKeyId,
  isAtRestEnvelope,
  keyIdFor,
  loadAtRestKeyringFromEnv,
} from '../at-rest-crypto.mjs'
import { listAtRestTargets, rotateAtRestData } from '../at-rest-rotation.mjs'
import { createObservabilityJournal } from '../observability-journal.mjs'

const directories = []

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-at-rest-test-'))
  directories.push(directory)
  return directory
}

function keyRing(seed) {
  const key = Buffer.alloc(32, seed)
  const keyId = keyIdFor(key)
  return { keys: [{ keyId, key }], activeKeyId: keyId }
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('at-rest envelope', () => {
  it('round-trips bytes and spans the documented overhead', () => {
    const cipher = createAtRestCipher(keyRing(1))
    const plaintext = Buffer.from('secret prompt text', 'utf8')
    const envelope = cipher.encryptBuffer(plaintext, 'session/a.json')
    assert.equal(isAtRestEnvelope(envelope), true)
    assert.equal(envelope.byteLength, plaintext.byteLength + AT_REST_OVERHEAD_BYTES)
    assert.equal(envelope.includes(plaintext), false)
    assert.deepEqual(cipher.decryptBuffer(envelope, 'session/a.json'), plaintext)
  })

  it('rejects ciphertext moved to another surface or context', () => {
    const cipher = createAtRestCipher(keyRing(2))
    const envelope = cipher.encryptBuffer(Buffer.from('session secret'), 'session/a.json')
    const failure = () => assert.throws(
      () => cipher.decryptBuffer(envelope, 'session/b.json'),
      error => error instanceof AtRestError && error.code === 'AT_REST_CIPHERTEXT_CORRUPT',
    )
    failure()
  })

  it('detects changed ciphertext, tag, and key id', () => {
    const cipher = createAtRestCipher(keyRing(3))
    const envelope = cipher.encryptBuffer(Buffer.from('tamper target'), 'attachment/w/h')
    for (const offset of [envelope.length - 1, 40, 20]) {
      const damaged = Buffer.from(envelope)
      damaged[offset] ^= 0x01
      assert.throws(
        () => cipher.decryptBuffer(damaged, 'attachment/w/h'),
        error => error instanceof AtRestError
          && (error.code === 'AT_REST_CIPHERTEXT_CORRUPT' || error.code === 'AT_REST_KEY_UNKNOWN'),
      )
    }
  })

  it('decrypts with a retired key that is still in the keyring', () => {
    const retired = keyRing(4)
    const activeKey = Buffer.alloc(32, 5)
    const activeId = keyIdFor(activeKey)
    const cipher = createAtRestCipher({
      keys: [retired.keys[0], { keyId: activeId, key: activeKey }],
      activeKeyId: activeId,
    })
    const old = createAtRestCipher(retired).encryptBuffer(Buffer.from('old writing'), 'session/old.json')
    assert.deepEqual(cipher.decryptBuffer(old, 'session/old.json'), Buffer.from('old writing'))
    assert.equal(isAtRestEnvelope(cipher.encryptBuffer(Buffer.from('new'), 'session/new.json')), true)
    assert.equal(Buffer.from(cipher.encryptBuffer(Buffer.from('new'), 'session/new.json')
      .subarray(7, 23)).toString('ascii'), activeId)
  })

  it('reports plaintext sizes without decrypting and streams encryption', async () => {
    const directory = await temporaryDirectory()
    const cipher = createAtRestCipher(keyRing(6))
    const path = join(directory, 'blob')
    await cipher.writeFile(path, Buffer.from('blob body'), 'workspace-blob:abc')
    assert.deepEqual(await cipher.statPlaintextSize(path), { size: 9, encrypted: true })
    const encryptor = cipher.createEncryptor('attachment/w/h')
    const envelope = Buffer.concat([encryptor.header(), encryptor.update(Buffer.from('split ')), encryptor.update(Buffer.from('write')), encryptor.finish()])
    assert.deepEqual(cipher.decryptBuffer(envelope, 'attachment/w/h'), Buffer.from('split write'))
    assert.equal(await cipher.readText(path, 'workspace-blob:abc'), 'blob body')
    await writeFile(join(directory, 'legacy.json'), '{"legacy":true}')
    assert.equal(await cipher.readText(join(directory, 'legacy.json'), 'session/legacy.json'), '{"legacy":true}')
  })

  it('encrypts ledger text and still reads legacy plaintext lines', () => {
    const cipher = createAtRestCipher(keyRing(7))
    const line = cipher.encryptText('{"v":1}', 'observability/usage')
    assert.equal(/^[A-Za-z0-9+/=]+$/.test(line), true)
    assert.equal(cipher.decryptText(line, 'observability/usage'), '{"v":1}')
    assert.equal(cipher.decryptText('{"v":1}', 'observability/usage'), '{"v":1}')
    assert.throws(
      () => cipher.decryptText(line, 'observability/access-denials'),
      error => error instanceof AtRestError && error.code === 'AT_REST_CIPHERTEXT_CORRUPT',
    )
  })
})

describe('keyring configuration', () => {
  it('reads an inline key and derives its id', async () => {
    const key = Buffer.alloc(32, 8)
    const keyring = await loadAtRestKeyringFromEnv({ [AT_REST_ENV.key]: key.toString('base64') })
    assert.equal(keyring.mode, 'auto')
    assert.equal(keyring.activeKeyId, keyIdFor(key))
    assert.deepEqual(keyring.keys, [{ keyId: keyIdFor(key), key }])
  })

  it('requires a key when deployment mode says so', async () => {
    await assert.rejects(
      loadAtRestKeyringFromEnv({ [AT_REST_ENV.mode]: 'required' }),
      error => error instanceof AtRestError && error.code === 'AT_REST_KEY_REQUIRED',
    )
    await assert.rejects(
      loadAtRestKeyringFromEnv({ [AT_REST_ENV.mode]: 'invalid' }),
      error => error instanceof AtRestError && error.code === 'AT_REST_CONFIGURATION',
    )
  })

  it('rejects a key file readable beyond its owner', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'keyring')
    const key = Buffer.alloc(32, 9)
    await writeFile(path, `0123456789abcdef=${key.toString('base64')}\n`, { mode: 0o644 })
    await chmod(path, 0o644)
    await assert.rejects(
      loadAtRestKeyringFromEnv({ [AT_REST_ENV.keyFile]: path }),
      error => error instanceof AtRestError && error.code === 'AT_REST_KEY_FILE_PERMISSIONS',
    )
    await chmod(path, 0o600)
    const keyring = await loadAtRestKeyringFromEnv({ [AT_REST_ENV.keyFile]: path })
    assert.equal(keyring.activeKeyId, '0123456789abcdef')
    assert.deepEqual(keyring.keys.map(entry => entry.keyId), ['0123456789abcdef'])
  })
})

describe('startup key check', () => {
  it('records a key check and refuses a missing or different key', async () => {
    const directory = await temporaryDirectory()
    const cipher = createAtRestCipher(keyRing(10))
    assert.deepEqual(await assertAtRestReady({ dataDir: directory, cipher }), {
      state: 'encrypted', keyId: cipher.keyId, initialized: true,
    })
    const checkPath = join(directory, '.browser-native-at-rest-key-check')
    assert.equal((await stat(checkPath)).mode & 0o077, 0)
    assert.deepEqual(await assertAtRestReady({ dataDir: directory, cipher }), { state: 'encrypted', keyId: cipher.keyId })

    await assert.rejects(
      assertAtRestReady({ dataDir: directory, cipher: undefined }),
      error => error instanceof AtRestError && error.code === 'AT_REST_KEY_REQUIRED',
    )
    await assert.rejects(
      assertAtRestReady({ dataDir: directory, cipher: createAtRestCipher(keyRing(11)) }),
      error => error instanceof AtRestError && error.code === 'AT_REST_KEY_INVALID',
    )
  })

  it('leaves an empty plaintext directory usable without a key', async () => {
    const directory = await temporaryDirectory()
    assert.deepEqual(await assertAtRestReady({ dataDir: directory, cipher: undefined }), { state: 'plaintext' })
  })

  it('refuses plaintext startup when stored Session logs are encrypted', async () => {
    const directory = await temporaryDirectory()
    const cipher = createAtRestCipher(keyRing(12))
    await mkdir(join(directory, 'sessions'), { recursive: true })
    await cipher.writeFile(join(directory, 'sessions', 'enc.json'), '{"id":"enc"}', 'session/enc.json')
    await assert.rejects(
      assertAtRestReady({ dataDir: directory, cipher: undefined }),
      error => error instanceof AtRestError && error.code === 'AT_REST_KEY_REQUIRED',
    )
    assert.deepEqual(await assertAtRestReady({ dataDir: directory, cipher }), {
      state: 'encrypted', keyId: cipher.keyId, initialized: true,
    })
  })
})

describe('key rotation', () => {
  it('activates a successor key and retires the predecessor', () => {
    const predecessor = keyRing(40)
    const cipher = createAtRestCipher(predecessor)
    const oldFile = cipher.encryptBuffer(Buffer.from('before rotation'), 'session/a.json')
    const successorKey = Buffer.alloc(32, 41)
    const successorId = keyIdFor(successorKey)
    cipher.addKeys([{ keyId: successorId, key: successorKey }], successorId)
    assert.deepEqual(cipher.keyIds().sort(), [predecessor.activeKeyId, successorId].sort())
    const newFile = cipher.encryptBuffer(Buffer.from('after rotation'), 'session/a.json')
    assert.equal(envelopeKeyId(newFile), successorId)
    assert.deepEqual(cipher.decryptBuffer(oldFile, 'session/a.json'), Buffer.from('before rotation'))
    assert.equal(cipher.retireKey(predecessor.activeKeyId), true)
    assert.throws(
      () => cipher.decryptBuffer(oldFile, 'session/a.json'),
      error => error instanceof AtRestError && error.code === 'AT_REST_KEY_UNKNOWN',
    )
    assert.throws(
      () => createAtRestCipher(predecessor).decryptBuffer(newFile, 'session/a.json'),
      error => error instanceof AtRestError && error.code === 'AT_REST_KEY_UNKNOWN',
    )
    assert.throws(
      () => cipher.retireKey(successorId),
      error => error instanceof AtRestError && error.code === 'AT_REST_KEY_INVALID',
    )
  })

  it('accepts a key-check written with a predecessor that is still configured', async () => {
    const directory = await temporaryDirectory()
    const predecessor = keyRing(42)
    await assertAtRestReady({ dataDir: directory, cipher: createAtRestCipher(predecessor) })
    const successorKey = Buffer.alloc(32, 43)
    const successorId = keyIdFor(successorKey)
    const both = createAtRestCipher({
      keys: [predecessor.keys[0], { keyId: successorId, key: successorKey }],
      activeKeyId: successorId,
    })
    assert.deepEqual(await assertAtRestReady({ dataDir: directory, cipher: both }), {
      state: 'encrypted', keyId: successorId,
    })
  })

  it('re-encrypts Sessions, blobs, chunks, attachments, staging, and the journal', async () => {
    const directory = await temporaryDirectory()
    const predecessor = keyRing(44)
    const oldCipher = createAtRestCipher(predecessor)
    const hash = 'a'.repeat(64)
    const sessionPath = join(directory, 'sessions', 'rotation.json')
    const files = [
      [sessionPath, 'session/rotation.json', '{"id":"rotation","prompt":"rotate me"}'],
      [join(directory, 'workspace-v2', 'blobs', 'aa', hash), `workspace-blob:${hash}`, 'blob body'],
      [join(directory, 'workspace-v2', 'chunk-objects', 'chunks', 'aa', hash), `workspace-chunk-object:chunks/aa/${hash}`, 'chunk body'],
      [join(directory, 'workspace-v2', 'chunk-objects', 'files', `${hash}.json`), `workspace-chunk-object:files/${hash}.json`, '{"chunks":[]}'],
      [join(directory, 'attachments-v1', 'workspace', 'bb', hash), `attachment/workspace/${hash}`, 'attachment body'],
      [join(directory, 'attachment-uploads-v1', 'workspace', 'upload.part'), 'attachment-upload/workspace/upload', 'staged body'],
    ]
    for (const [path, context, body] of files) {
      await mkdir(dirname(path), { recursive: true })
      await oldCipher.writeFile(path, body, context)
    }
    await writeFile(join(directory, 'sessions', 'legacy.json'), '{"legacy":true}')
    const journal = createObservabilityJournal({ dataDir: directory, cipher: oldCipher })
    await journal.appendAccessDenial({ at: 1, method: 'POST', route: '/probe', status: 404 })
    await journal.persistMetrics({ metricsVersion: 1, requests: { total: 1 } })
    await journal.close()

    const successorKey = Buffer.alloc(32, 45)
    const successorId = keyIdFor(successorKey)
    oldCipher.addKeys([{ keyId: successorId, key: successorKey }], successorId)
    const report = await rotateAtRestData({ dataDir: directory, cipher: oldCipher, journal })
    assert.equal(report.targetKeyId, successorId)
    assert.deepEqual(report.files, {
      sessions: 2, blobs: 1, chunks: 2, attachments: 1, uploads: 1, journal: 2,
    })

    for (const target of await listAtRestTargets(directory)) {
      assert.equal(envelopeKeyId(await readFile(target.path)), successorId, target.context)
    }
    assert.match(await oldCipher.readText(sessionPath, 'session/rotation.json'), /rotate me/)
    assert.equal(await oldCipher.readText(join(directory, 'sessions', 'legacy.json'), 'session/legacy.json'), '{"legacy":true}')
    const restored = await createObservabilityJournal({ dataDir: directory, cipher: oldCipher }).restore()
    assert.equal(restored.accessDenials.length, 1)
    assert.equal(restored.integrity.verified, true)

    const successorOnly = createAtRestCipher({ keys: [{ keyId: successorId, key: successorKey }], activeKeyId: successorId })
    assert.equal(await successorOnly.readText(sessionPath, 'session/rotation.json'), '{"id":"rotation","prompt":"rotate me"}')
    assert.deepEqual(await assertAtRestReady({ dataDir: directory, cipher: successorOnly }), {
      state: 'encrypted', keyId: successorId,
    })
    const predecessorOnly = createAtRestCipher(predecessor)
    await assert.rejects(
      predecessorOnly.readFile(sessionPath, 'session/rotation.json'),
      error => error instanceof AtRestError && error.code === 'AT_REST_KEY_UNKNOWN',
    )
    await assert.rejects(
      assertAtRestReady({ dataDir: directory, cipher: predecessorOnly }),
      error => error instanceof AtRestError && error.code === 'AT_REST_KEY_INVALID',
    )
  })

  it('aborts on damaged ciphertext and leaves predecessor files readable', async () => {
    const directory = await temporaryDirectory()
    const predecessor = keyRing(46)
    const oldCipher = createAtRestCipher(predecessor)
    await assertAtRestReady({ dataDir: directory, cipher: oldCipher })
    const hash = 'b'.repeat(64)
    const sessionPath = join(directory, 'sessions', 'damaged.json')
    await mkdir(dirname(sessionPath), { recursive: true })
    await oldCipher.writeFile(sessionPath, '{"id":"damaged"}', 'session/damaged.json')
    const damaged = await readFile(sessionPath)
    damaged[damaged.length - 17] ^= 0x01
    await writeFile(sessionPath, damaged)
    const blobPath = join(directory, 'workspace-v2', 'blobs', 'aa', hash)
    await mkdir(dirname(blobPath), { recursive: true })
    await oldCipher.writeFile(blobPath, 'intact blob', `workspace-blob:${hash}`)

    const successorKey = Buffer.alloc(32, 47)
    const successorId = keyIdFor(successorKey)
    oldCipher.addKeys([{ keyId: successorId, key: successorKey }], successorId)
    await assert.rejects(
      rotateAtRestData({ dataDir: directory, cipher: oldCipher }),
      error => error instanceof AtRestError && error.code === 'AT_REST_CIPHERTEXT_CORRUPT',
    )
    const predecessorOnly = createAtRestCipher(predecessor)
    assert.equal(await predecessorOnly.readText(blobPath, `workspace-blob:${hash}`), 'intact blob')
    assert.deepEqual(await assertAtRestReady({ dataDir: directory, cipher: predecessorOnly }), {
      state: 'encrypted', keyId: predecessor.activeKeyId,
    })
  })
})
