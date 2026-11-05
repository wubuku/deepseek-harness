/**
 * SIGKILL the backend at random moments and prove recovery invariants.
 *
 * Sixty runs cover a hanging or completing durable turn, chunked attachment
 * uploads, audit appends, and at-rest key rotation. Each run kills the process
 * mid-operation, restarts it on the same data directory, and asserts the
 * Session log reads with contiguous unique seqs, a turn settles once, startup
 * removed every orphan temporary, the audit chain verifies, and an interrupted
 * rotation stays readable and finishes on retry.
 */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createAtRestCipher, envelopeKeyId, keyIdFor } from '../at-rest-crypto.mjs'
import { listAtRestTargets } from '../at-rest-rotation.mjs'
import { listOrphanTemporaries } from '../crash-recovery.mjs'
import { createObservabilityJournal } from '../observability-journal.mjs'

const CHILD = fileURLToPath(new URL('./fixtures/durable-backend-process.mjs', import.meta.url))
const OLD_KEY = Buffer.alloc(32, 41)
const NEW_KEY = Buffer.alloc(32, 42)
const OLD_ID = keyIdFor(OLD_KEY)
const NEW_ID = keyIdFor(NEW_KEY)
const keyringJson = (keys, activeKeyId) => JSON.stringify({
  keys: keys.map(({ keyId, key }) => ({ keyId, key: key.toString('base64') })),
  activeKeyId,
})
const OLD_RING = keyringJson([{ keyId: OLD_ID, key: OLD_KEY }], OLD_ID)
const BOTH_RING = keyringJson([{ keyId: NEW_ID, key: NEW_KEY }, { keyId: OLD_ID, key: OLD_KEY }], NEW_ID)

const PHASES = ['turn-hang', 'turn-text', 'attachment', 'audit', 'rotation']
const RUNS = 60
const children = new Set()
const directories = []

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-crash-fuzz-'))
  directories.push(directory)
  return directory
}

async function spawnBackend(dataDir, mode, rings = {}) {
  const env = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  if (rings.atRest !== undefined) env.CRASH_AT_REST_KEYS = rings.atRest
  if (rings.reload !== undefined) env.CRASH_AT_REST_RELOAD_KEYS = rings.reload
  const child = fork(CHILD, [dataDir, mode], { execArgv: [], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.add(child)
  let stderr = ''
  child.stderr.on('data', data => { stderr = `${stderr}${String(data)}`.slice(-2_000) })
  const exited = once(child, 'exit')
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    exited.then(() => { throw new Error(`backend exited before readiness: ${stderr}`) }),
  ])
  assert.equal(ready.type, 'ready')
  return {
    origin: ready.origin,
    recovered: ready.recovered,
    child,
    async kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
      children.delete(child)
    },
    async metrics() {
      const answer = once(child, 'message', { signal: AbortSignal.timeout(5_000) })
      child.send({ type: 'metrics' })
      const [message] = await answer
      assert.equal(message.type, 'metrics')
      return message
    },
  }
}

function request(origin, pathname, { method = 'GET', cookie, body } = {}) {
  return fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), ...body }) }),
  })
}

/** Send one raw byte body; chunk and blob routes reject JSON payloads. */
function putRaw(origin, pathname, { cookie, bytes, headers = {} } = {}) {
  return fetch(`${origin}${pathname}`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/octet-stream', ...headers },
    body: bytes,
  })
}

async function identity(origin) {
  const response = await request(origin, '/api/browser-native/workspace/identity')
  assert.equal(response.status, 200)
  const cookies = response.headers.getSetCookie().map(value => value.split(';')[0])
  const body = await response.json()
  return { cookie: cookies.join('; '), workspaceId: body.workspaceId }
}

async function readEventsMaybe(origin, cookie, sessionId) {
  const response = await request(origin, '/api/browser-native/session/read', {
    method: 'POST', cookie, body: { sessionId, offset: 0, length: 1_000 },
  })
  if (response.status === 404) return undefined
  if (response.status !== 200) assert.fail(`session read failed: ${await response.text()}`)
  return (await response.json()).events
}

async function readEvents(origin, cookie, sessionId) {
  const events = await readEventsMaybe(origin, cookie, sessionId)
  assert.notEqual(events, undefined, `session ${sessionId} is missing after restart`)
  return events
}

function assertSessionEvents(events) {
  const seqs = events.map(event => event.seq)
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, index) => index), 'seq must be contiguous from 0')
  assert.equal(new Set(seqs).size, seqs.length, 'seq must not repeat')
  for (const event of events) assert.equal(typeof event.type, 'string', `event ${String(event.seq)} has no type`)
}

function countTurnEnds(events, turn) {
  return events.filter(event => event.type === 'turn/end' && event.data?.turn === turn).length
}

async function durableStatusMaybe(origin, cookie, turnId) {
  const response = await request(origin, `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`, { cookie })
  if (response.status === 404) return undefined
  if (response.status !== 200) assert.fail(`durable status failed: ${await response.text()}`)
  return await response.json()
}

async function waitSettled(origin, cookie, turnId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await durableStatusMaybe(origin, cookie, turnId)
    assert.notEqual(status, undefined, `turn ${turnId} disappeared after restart`)
    if (status.status !== 'running') return status
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`turn ${turnId} did not settle after restart`)
}

async function assertAuditVerifies(dataDir, cipher) {
  const journal = createObservabilityJournal({ dataDir, cipher })
  const restored = await journal.restore()
  for (const name of ['accessDenials', 'usage', 'collaboration']) {
    assert.equal(restored.integrity[name].verified, true, `${name}: ${JSON.stringify(restored.integrity[name])}`)
    assert.equal(restored.integrity[name].invalidLines, 0)
  }
}

async function assertNoOrphans(dataDir) {
  assert.deepEqual(await listOrphanTemporaries(dataDir), [], 'restart must remove orphan temporaries')
}

async function seedSession(origin, cookie, sessionId, text) {
  const created = await request(origin, '/api/browser-native/session/create', {
    method: 'POST', cookie, body: { sessionId, header: { id: sessionId, version: 4, createdAt: 1_700_000_000_000, cwd: '/workspace' } },
  })
  if (created.status !== 200) assert.fail(`session create failed: ${await created.text()}`)
  const body = await created.json()
  const appended = await request(origin, '/api/browser-native/session/append', {
    method: 'POST', cookie, body: {
      sessionId, ownerToken: body.owner.ownerToken, expectedNextSeq: 0,
      events: [{ seq: 0, type: 'user/message', data: { content: text }, at: '2026-11-05T00:00:00.000Z' }],
    },
  })
  assert.equal(appended.status, 200, await appended.text())
  const flushed = await request(origin, '/api/browser-native/session/flush', {
    method: 'POST', cookie, body: { sessionId, ownerToken: body.owner.ownerToken },
  })
  assert.equal(flushed.status, 200, await flushed.text())
}
/** Start an upload, push chunks, and commit; returns the begin response body. */
async function beginUpload(origin, caller, hash, bytes, name) {
  const response = await request(origin,
    `/api/browser-native/workspace/attachments/${hash}/uploads?workspaceId=${caller.workspaceId}&name=${encodeURIComponent(name)}`,
    { method: 'POST', cookie: caller.cookie, body: { bytes: bytes.length } })
  if (response.status !== 200) assert.fail(`upload begin failed: ${await response.text()}`)
  return await response.json()
}

async function pushChunks(origin, caller, hash, uploadId, bytes) {
  for (let offset = 0; offset < bytes.length; offset += 1_024) {
    const response = await putRaw(origin,
      `/api/browser-native/workspace/attachments/${hash}/uploads/${uploadId}/chunks/${String(offset)}?workspaceId=${caller.workspaceId}`,
      { cookie: caller.cookie, bytes: bytes.subarray(offset, offset + 1_024) })
    assert.equal(response.status, 200, await response.text())
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

async function rotationProgress(dataDir, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const target of await listAtRestTargets(dataDir)) {
      try {
        if (envelopeKeyId(await readFile(target.path)) === NEW_ID) return true
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  return false
}

/** Resolve once staging holds at least one full chunk, so the kill lands mid-upload. */
async function stagingHasChunk(dataDir, workspaceId, timeoutMs = 3_000) {
  const directory = join(dataDir, 'attachment-uploads-v1', workspaceId)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const parts = (await readdir(directory).catch(() => [])).filter(name => name.endsWith('.part'))
    for (const name of parts) {
      const size = await stat(join(directory, name)).then(entry => entry.size, () => 0)
      if (size >= 1_024) return true
    }
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  return false
}

function commitUpload(origin, caller, hash, uploadId) {
  return request(origin,
    `/api/browser-native/workspace/attachments/${hash}/uploads/${uploadId}/commit?workspaceId=${caller.workspaceId}`,
    { method: 'POST', cookie: caller.cookie, body: {} })
}

after(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
})

test('random SIGKILL leaves readable, non-duplicating, verifiable state', { timeout: 900_000 }, async () => {
  const order = []
  const coverage = { recoveredTurns: 0, interruptedRotations: 0, interruptedUploads: 0 }
  for (let cycle = 0; cycle < RUNS / PHASES.length; cycle += 1) {
    for (const phase of PHASES) order.push(phase)
  }
  // Keep the phase mix but vary order so a failure cannot depend on a fixed sequence.
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[order[index], order[swap]] = [order[swap], order[index]]
  }

  for (const [index, phase] of order.entries()) {
    const dataDir = await temporaryDirectory()
    const nonce = `${String(index)}-${randomUUID().slice(0, 8)}`
    const sessionId = `crash-${nonce}`
    const turnId = `crash-turn-${nonce}`

    try {
      if (phase === 'turn-hang' || phase === 'turn-text') {
        const first = await spawnBackend(dataDir, phase === 'turn-hang' ? 'hang' : 'text')
        const { cookie } = await identity(first.origin)
        const started = request(first.origin, '/api/browser-native/session/durable', {
          method: 'POST', cookie, body: { sessionId, turnId, prompt: `crash prompt ${nonce}` },
        }).then(async response => response.status, () => undefined)
        await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * (phase === 'turn-hang' ? 70 : 40)))
        await first.kill()
        const startStatus = await started
        if (startStatus !== undefined) assert.equal(startStatus, 202, `${phase}: turn start`)

        const second = await spawnBackend(dataDir, 'text')
        assert.ok(second.recovered <= 1, `${phase}: recovered ${String(second.recovered)} turns`)
        const status = await durableStatusMaybe(second.origin, cookie, turnId)
        if (status !== undefined) await waitSettled(second.origin, cookie, turnId)
        if (status?.recovered === true) coverage.recoveredTurns += 1
        const beforeReplay = await readEventsMaybe(second.origin, cookie, sessionId)
        if (beforeReplay !== undefined) assertSessionEvents(beforeReplay)
        const before = await second.metrics()

        const replay = await request(second.origin, '/api/browser-native/session/durable', {
          method: 'POST', cookie, body: { sessionId, turnId, prompt: `crash prompt ${nonce}` },
        })
        if (replay.status !== 200 && replay.status !== 202) {
          assert.fail(`${phase}: replay ${String(replay.status)} ${await replay.text()}`)
        }
        await waitSettled(second.origin, cookie, turnId)
        const events = await readEvents(second.origin, cookie, sessionId)
        assertSessionEvents(events)
        assert.equal(countTurnEnds(events, 1), 1, `${phase}: turn settled ${String(countTurnEnds(events, 1))} times`)
        const after = await second.metrics()
        if (status !== undefined) {
          assert.equal(after.modelRequests, before.modelRequests, `${phase}: replay must not call the model`)
        }
        await assertNoOrphans(dataDir)
        await assertAuditVerifies(dataDir, undefined)
        await second.kill()
        continue
      }

      if (phase === 'attachment') {
        const first = await spawnBackend(dataDir, 'text')
        const caller = await identity(first.origin)
        const bytes = Buffer.from(`crash attachment ${nonce}`.repeat(64))
        const hash = createHash('sha256').update(bytes).digest('hex')
        const begun = await beginUpload(first.origin, caller, hash, bytes, 'crash.bin')
        const uploadId = begun.uploadId
        assert.equal(typeof uploadId, 'string')
        const interrupt = Math.random() < 0.5
        if (interrupt) {
          (async () => {
            await pushChunks(first.origin, caller, hash, uploadId, bytes)
            await commitUpload(first.origin, caller, hash, uploadId)
          })().catch(() => {})
          assert.ok(await stagingHasChunk(dataDir, caller.workspaceId), `${phase}: staging never received a chunk`)
        } else {
          await pushChunks(first.origin, caller, hash, uploadId, bytes)
          const committed = await commitUpload(first.origin, caller, hash, uploadId)
          assert.equal(committed.status, 200, `${phase}: commit ${await committed.text()}`)
        }
        await first.kill()

        const second = await spawnBackend(dataDir, 'text')
        await assertNoOrphans(dataDir)
        const download = () => request(second.origin,
          `/api/browser-native/workspace/attachments/${hash}?workspaceId=${caller.workspaceId}`, { cookie: caller.cookie })
        const stored = await download()
        if (stored.status === 200) {
          assert.deepEqual(Buffer.from(await stored.arrayBuffer()), bytes, `${phase}: published object must be complete`)
        } else {
          assert.equal(stored.status, 404, `${phase}: interrupted upload published a partial object`)
          coverage.interruptedUploads += 1
          const retried = await beginUpload(second.origin, caller, hash, bytes, 'crash.bin')
          await pushChunks(second.origin, caller, hash, retried.uploadId, bytes)
          assert.equal((await commitUpload(second.origin, caller, hash, retried.uploadId)).status, 200)
          const redownload = await download()
          assert.equal(redownload.status, 200, `${phase}: retry must publish the object`)
          assert.deepEqual(Buffer.from(await redownload.arrayBuffer()), bytes, `${phase}: retry content`)
        }
        await assertAuditVerifies(dataDir, undefined)
        await second.kill()
        continue
      }

      if (phase === 'audit') {
        const first = await spawnBackend(dataDir, 'text')
        const { cookie } = await identity(first.origin)
        await Promise.race([
          (async () => {
            for (let attempt = 0; attempt < 40; attempt += 1) {
              await request(first.origin, '/api/browser-native/session/read', {
                method: 'POST', cookie, body: { sessionId: `missing-${nonce}-${String(attempt)}`, offset: 0, length: 1 },
              }).catch(() => {})
              await new Promise(resolve => setTimeout(resolve, 2))
            }
          })().catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 3 + Math.random() * 60)),
        ])
        await first.kill()

        const second = await spawnBackend(dataDir, 'text')
        await assertNoOrphans(dataDir)
        await assertAuditVerifies(dataDir, undefined)
        await second.kill()
        continue
      }

      // rotation
      const first = await spawnBackend(dataDir, 'text', { atRest: OLD_RING, reload: BOTH_RING })
      const caller = await identity(first.origin)
      await seedSession(first.origin, caller.cookie, sessionId, `crash rotation ${nonce}`)
      for (let extra = 0; extra < 10; extra += 1) {
        await seedSession(first.origin, caller.cookie, `${sessionId}-${String(extra)}`, `crash rotation ${nonce} ${String(extra)}`)
      }
      const blob = Buffer.from(`crash rotation blob ${nonce}`)
      const blobHash = createHash('sha256').update(blob).digest('hex')
      const uploaded = await putRaw(first.origin, `/api/browser-native/workspace/blob/${blobHash}`, {
        cookie: caller.cookie,
        bytes: blob,
        headers: {
          'x-browser-native-protocol': '1', 'x-request-id': randomUUID(), 'x-workspace-id': caller.workspaceId,
        },
      })
      if (uploaded.status !== 200) assert.fail(`blob upload failed: ${await uploaded.text()}`)
      request(first.origin, '/api/browser-native/admin/at-rest-key/rotate', { method: 'POST' }).catch(() => {})
      // Kill as soon as the first target carries the new key, so the crash lands
      // inside the rewrite loop with old and new envelopes still coexisting.
      await rotationProgress(dataDir)
      // Do not wait for completion: a SIGKILL during rotation is the scenario under test.
      await first.kill()

      const second = await spawnBackend(dataDir, 'text', { atRest: BOTH_RING, reload: BOTH_RING })
      await assertNoOrphans(dataDir)
      const events = await readEvents(second.origin, caller.cookie, sessionId)
      assertSessionEvents(events)
      const bothCipher = createAtRestCipher({
        keys: [{ keyId: NEW_ID, key: NEW_KEY }, { keyId: OLD_ID, key: OLD_KEY }], activeKeyId: NEW_ID,
      })
      let sawOldKey = false
      let sawNewKey = false
      for (const target of await listAtRestTargets(dataDir)) {
        const stored = await readFile(target.path)
        const storedKeyId = envelopeKeyId(stored)
        assert.ok(storedKeyId === OLD_ID || storedKeyId === NEW_ID,
          `${phase}: ${target.context} uses unknown key ${String(storedKeyId)}`)
        if (storedKeyId === OLD_ID) sawOldKey = true
        else sawNewKey = true
        bothCipher.decryptBuffer(stored, target.context)
      }
      if (sawOldKey && sawNewKey) coverage.interruptedRotations += 1
      assert.ok(sawNewKey, `${phase}: rotation never rewrote a target`)
      await assertAuditVerifies(dataDir, bothCipher)
      const retried = await request(second.origin, '/api/browser-native/admin/at-rest-key/rotate', { method: 'POST' })
      if (retried.status !== 200) assert.fail(`rotation retry failed: ${await retried.text()}`)
      for (const target of await listAtRestTargets(dataDir)) {
        assert.equal(envelopeKeyId(await readFile(target.path)), NEW_ID, `${phase}: ${target.context} was not re-encrypted`)
      }
      const newCipher = createAtRestCipher({ keys: [{ keyId: NEW_ID, key: NEW_KEY }], activeKeyId: NEW_ID })
      await assertAuditVerifies(dataDir, newCipher)
      await assertNoOrphans(dataDir)
      await second.kill()
    } catch (error) {
      error.message = `[run ${String(index + 1)}/${String(order.length)} ${phase}] ${error.message}`
      throw error
    }
  }

  assert.equal(order.length, RUNS)
  assert.ok(coverage.recoveredTurns > 0, 'no run killed a durable turn mid-execution')
  assert.ok(coverage.interruptedRotations > 0, 'no run killed a rotation mid-rewrite')
  assert.ok(coverage.interruptedUploads > 0, 'no run killed an attachment upload before commit')
})
