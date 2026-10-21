import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

async function temporaryRoot(context) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-workspace-durability-'))
  context.after(async () => { await rm(directory, { recursive: true, force: true }) })
  return directory
}

async function backendProcess(context, dataDir) {
  const env = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  const child = fork(fileURLToPath(new URL('./fixtures/workspace-backend-process.mjs', import.meta.url)), [dataDir], {
    execArgv: [], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr = `${stderr}${String(data)}`.slice(-4_000) })
  const exited = once(child, 'exit')
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
  context.after(stop)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  let ready
  try {
    const [message] = await Promise.race([
      once(child, 'message', { signal: controller.signal }),
      exited.then(() => { throw new Error(`backend fixture exited before readiness: ${stderr}`) }),
    ])
    assert.equal(message.type, 'ready')
    ready = message
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return {
    origin: ready.origin,
    pid: child.pid,
    stop,
    metrics: async () => {
      const response = once(child, 'message', { signal: AbortSignal.timeout(5_000) })
      child.send({ type: 'metrics' })
      const [message] = await response
      assert.equal(message.type, 'metrics')
      return message
    },
  }
}

async function identity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  return { workspaceId: body.workspaceId, cookie: response.headers.get('set-cookie').split(';', 1)[0] }
}

async function upload(origin, owner, bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex')
  const response = await fetch(`${origin}/api/browser-native/workspace/blob/${hash}`, {
    method: 'PUT',
    headers: {
      cookie: owner.cookie,
      'content-type': 'application/octet-stream',
      'x-browser-native-protocol': '1',
      'x-request-id': randomUUID(),
      'x-workspace-id': owner.workspaceId,
    },
    body: bytes,
  })
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  return { hash, bytes: bytes.byteLength }
}

async function commit(origin, owner, baseRevision, changes, operationId = randomUUID()) {
  const body = { protocolVersion: 1, requestId: randomUUID(), workspaceId: owner.workspaceId, baseRevision, operationId, changes }
  const response = await fetch(`${origin}/api/browser-native/workspace/commit`, {
    method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const value = await response.json()
  assert.equal(response.ok, true, JSON.stringify(value))
  return { value, requestBytes: Buffer.byteLength(JSON.stringify(body)) }
}

async function manifest(origin, owner) {
  const response = await fetch(`${origin}/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${owner.workspaceId}`, {
    headers: { cookie: owner.cookie },
  })
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  return body
}

test('Workspace commit receipts and upload authorization survive an OS backend kill/restart', { timeout: 30_000 }, async context => {
  const dataDir = await temporaryRoot(context)
  const first = await backendProcess(context, dataDir)
  const owner = await identity(first.origin)
  const binary = Buffer.from([0, 255, 128, 10])
  const empty = Buffer.alloc(0)
  const binaryBlob = await upload(first.origin, owner, binary)
  const emptyBlob = await upload(first.origin, owner, empty)
  const pendingBytes = Buffer.from('uploaded before commit, then killed')
  const pendingBlob = await upload(first.origin, owner, pendingBytes)
  const operationId = randomUUID()
  const changes = [
    { path: '目录/binary.dat', kind: 'file', mode: 0o640, ...binaryBlob },
    { path: 'empty.bin', kind: 'file', mode: 0o600, ...emptyBlob },
  ]
  await commit(first.origin, owner, 0, changes, operationId)
  const before = await manifest(first.origin, owner)
  await first.stop()

  const restarted = await backendProcess(context, dataDir)
  assert.notEqual(restarted.pid, first.pid)
  const after = await manifest(restarted.origin, owner)
  assert.deepEqual(after, before)
  const replay = await commit(restarted.origin, owner, 0, changes, operationId)
  assert.equal(replay.value.replayed, true)
  assert.equal(replay.value.revision, 1)
  for (const [blob, expected] of [[binaryBlob, binary], [emptyBlob, empty]]) {
    const response = await fetch(`${restarted.origin}/api/browser-native/workspace/blob/${blob.hash}?protocolVersion=1&workspaceId=${owner.workspaceId}`, {
      headers: { cookie: owner.cookie },
    })
    assert.equal(response.ok, true)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected)
  }
  const pendingCommit = await commit(restarted.origin, owner, 1, [
    { path: 'pending.txt', kind: 'file', mode: 0o600, ...pendingBlob },
  ])
  assert.equal(pendingCommit.value.revision, 2)
  const metrics = await restarted.metrics()
  assert.equal(metrics.childProcessLaunches, 0)
  context.diagnostic(JSON.stringify({ result: 'passed', scope: 'OS-restart-API', beforePid: first.pid, afterPid: restarted.pid, revisions: [1, 2], childProcessLaunches: 0 }))
})

test('one backend serves eight concurrent Workspace clients with incremental payloads and no Agent child processes', { timeout: 30_000 }, async context => {
  const dataDir = await temporaryRoot(context)
  const backend = await backendProcess(context, dataDir)
  const started = performance.now()
  const owners = await Promise.all(Array.from({ length: 8 }, () => identity(backend.origin)))
  assert.equal(new Set(owners.map(owner => owner.workspaceId)).size, owners.length)
  const payloadBytes = { initial: 0, changed: 0, commitMetadata: 0 }
  const expectedEntries = await Promise.all(owners.map(async (owner, index) => {
    const baseline = Buffer.alloc(64 * 1024, index)
    const note = Buffer.from(`note=${index}\n`)
    const largeBlob = await upload(backend.origin, owner, baseline)
    const noteBlob = await upload(backend.origin, owner, note)
    payloadBytes.initial += baseline.byteLength + note.byteLength
    const initial = await commit(backend.origin, owner, 0, [
      { path: 'large.bin', kind: 'file', mode: 0o600, ...largeBlob },
      { path: 'note.txt', kind: 'file', mode: 0o600, ...noteBlob },
    ])
    const changed = Buffer.from(`note=${index}\nupdated=true\n`)
    const changedBlob = await upload(backend.origin, owner, changed)
    payloadBytes.changed += changed.byteLength
    const updated = await commit(backend.origin, owner, 1, [{ path: 'note.txt', kind: 'file', mode: 0o640, ...changedBlob }])
    const renamed = await commit(backend.origin, owner, 2, [
      { path: 'note.txt', deleted: true },
      { path: 'renamed.txt', kind: 'file', mode: 0o640, ...changedBlob },
    ])
    payloadBytes.commitMetadata += initial.requestBytes + updated.requestBytes + renamed.requestBytes
    return await manifest(backend.origin, owner)
  }))
  const metrics = await backend.metrics()
  assert.equal(metrics.pid, backend.pid)
  assert.equal(metrics.childProcessLaunches, 0)
  assert.equal(metrics.workspaceCount, owners.length)
  assert.equal(expectedEntries.every(value => value.revision === 3), true)
  assert.equal(payloadBytes.changed, owners.length * Buffer.byteLength('note=0\nupdated=true\n'))
  assert.equal(expectedEntries.every(value => value.entries.map(entry => entry.path).join(',') === 'large.bin,renamed.txt'), true)
  const durationMs = performance.now() - started
  await backend.stop()
  const restarted = await backendProcess(context, dataDir)
  const restored = await Promise.all(owners.map(owner => manifest(restarted.origin, owner)))
  assert.deepEqual(restored, expectedEntries)
  context.diagnostic(JSON.stringify({
    result: 'passed', scope: 'protocol-concurrency-not-browser-load', clients: owners.length,
    commits: owners.length * 3, backendProcesses: 1, agentChildProcesses: metrics.childProcessLaunches,
    payloadBytes, manifestBytes: expectedEntries.map(value => Buffer.byteLength(JSON.stringify(value))),
    durationMs, backendRssBytes: metrics.memory.rss,
  }))
})
