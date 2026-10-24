import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitFor } from './runtime-test-support.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(HERE, 'fixtures/workspace-backend-instance.mjs')
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-backend-multi-instance-')))

async function startBackend(label) {
  const child = fork(fixture, [dataDir], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const stderr = []
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  const ready = await new Promise((resolveReady, rejectReady) => {
    const onMessage = message => {
      if (message?.type === 'ready') {
        child.off('message', onMessage)
        resolveReady(message)
      }
    }
    child.on('message', onMessage)
    child.once('exit', (code, signal) => rejectReady(new Error(`${label} exited before ready: code=${String(code)} signal=${String(signal)} ${stderr.join('')}`)))
  })
  return { child, ...ready, stderr }
}

async function stopBackend(instance) {
  if (instance.child.exitCode !== null || instance.child.signalCode !== null) return
  const closed = new Promise((resolveClosed, rejectClosed) => {
    const onMessage = message => {
      if (message?.type === 'closed') {
        instance.child.off('message', onMessage)
        resolveClosed(undefined)
      }
    }
    instance.child.on('message', onMessage)
    instance.child.once('error', rejectClosed)
  })
  instance.child.send({ type: 'shutdown' })
  await closed
  await new Promise((resolveExit, rejectExit) => {
    if (instance.child.exitCode !== null || instance.child.signalCode !== null) return resolveExit(undefined)
    instance.child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolveExit(undefined)
      else rejectExit(new Error(`backend child exited unexpectedly: code=${String(code)} signal=${String(signal)} ${instance.stderr.join('')}`))
    })
  })
}

async function jsonRequest(origin, pathname, { method = 'GET', cookie, body, headers = {} } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}

function protocolBody(body = {}) {
  return { protocolVersion: 1, requestId: randomUUID(), ...body }
}

const instances = []
try {
  const first = await startBackend('backend A')
  instances.push(first)

  const identityResponse = await fetch(`${first.origin}/api/browser-native/workspace/identity`)
  assert.equal(identityResponse.status, 200)
  const setCookie = identityResponse.headers.get('set-cookie')
  assert.ok(setCookie)
  const cookie = setCookie.split(';', 1)[0]
  const workspaceId = (await identityResponse.json()).workspaceId

  const sessionId = `session-${randomUUID()}`
  const header = { id: sessionId, cwd: '/dsh/home', createdAt: Date.now() }
  const created = await jsonRequest(first.origin, '/api/browser-native/session/create', {
    method: 'POST',
    body: protocolBody({ sessionId, header }),
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const initialOwner = created.body.owner.ownerToken
  const flushed = await jsonRequest(first.origin, '/api/browser-native/session/flush', {
    method: 'POST',
    body: protocolBody({ sessionId, ownerToken: initialOwner }),
  })
  assert.equal(flushed.status, 200, JSON.stringify(flushed.body))

  const second = await startBackend('backend B')
  instances.push(second)

  const ownerA = await jsonRequest(first.origin, '/api/browser-native/session/open', {
    method: 'POST',
    body: protocolBody({ sessionId, access: 'write', ownerToken: initialOwner }),
  })
  const ownerB = await jsonRequest(second.origin, '/api/browser-native/session/open', {
    method: 'POST',
    body: protocolBody({ sessionId, access: 'write' }),
  })
  assert.equal(ownerA.status, 200, JSON.stringify(ownerA.body))
  assert.equal(ownerB.status, 200, JSON.stringify(ownerB.body))
  assert.notEqual(ownerA.body.owner.ownerToken, ownerB.body.owner.ownerToken)

  const eventA = { seq: 0, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'from-backend-A' }] } } }
  const eventB = { seq: 0, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'from-backend-B' }] } } }
  const [appendA, appendB] = await Promise.all([
    jsonRequest(first.origin, '/api/browser-native/session/append', {
      method: 'POST', body: protocolBody({ sessionId, ownerToken: ownerA.body.owner.ownerToken, expectedNextSeq: 0, events: [eventA] }),
    }),
    jsonRequest(second.origin, '/api/browser-native/session/append', {
      method: 'POST', body: protocolBody({ sessionId, ownerToken: ownerB.body.owner.ownerToken, expectedNextSeq: 0, events: [eventB] }),
    }),
  ])
  assert.deepEqual([appendA.status, appendB.status], [200, 200])
  const [flushA, flushB] = await Promise.all([
    jsonRequest(first.origin, '/api/browser-native/session/flush', {
      method: 'POST', body: protocolBody({ sessionId, ownerToken: ownerA.body.owner.ownerToken }),
    }),
    jsonRequest(second.origin, '/api/browser-native/session/flush', {
      method: 'POST', body: protocolBody({ sessionId, ownerToken: ownerB.body.owner.ownerToken }),
    }),
  ])
  assert.deepEqual([flushA.status, flushB.status], [200, 200])

  const claimBody = () => protocolBody({ workspaceId, operation: 'claim' })
  const [claimA, claimB] = await Promise.all([
    jsonRequest(first.origin, '/api/browser-native/workspace/lease', { method: 'POST', cookie, body: claimBody() }),
    jsonRequest(second.origin, '/api/browser-native/workspace/lease', { method: 'POST', cookie, body: claimBody() }),
  ])
  assert.deepEqual([claimA.status, claimB.status], [200, 200])
  assert.equal(claimA.body.fencingToken, claimB.body.fencingToken)
  assert.notEqual(claimA.body.writerToken, claimB.body.writerToken)

  const workspaceChanges = [
    { instance: first, origin: first.origin, lease: claimA.body, path: 'backend-a.txt', content: 'backend A\n' },
    { instance: second, origin: second.origin, lease: claimB.body, path: 'backend-b.txt', content: 'backend B\n' },
  ]
  for (const item of workspaceChanges) {
    item.hash = createHash('sha256').update(item.content).digest('hex')
    item.operationId = randomUUID()
    const upload = await fetch(`${item.origin}/api/browser-native/workspace/blob/${item.hash}`, {
      method: 'PUT',
      headers: {
        cookie,
        'x-browser-native-protocol': '1',
        'x-request-id': randomUUID(),
        'x-workspace-id': workspaceId,
      },
      body: item.content,
    })
    assert.equal(upload.status, 200, await upload.text())
  }
  const commits = await Promise.all(workspaceChanges.map(item => jsonRequest(item.origin, '/api/browser-native/workspace/commit', {
    method: 'POST',
    cookie,
    body: protocolBody({
      workspaceId,
      operationId: item.operationId,
      baseRevision: 0,
      writerToken: item.lease.writerToken,
      fencingToken: item.lease.fencingToken,
      changes: [{
        path: item.path,
        kind: 'file',
        hash: item.hash,
        bytes: Buffer.byteLength(item.content),
        mode: 0o644,
      }],
    }),
  })))
  assert.deepEqual(commits.map(result => result.status), [200, 200])

  await Promise.all(instances.map(stopBackend))
  instances.length = 0
  const restarted = await startBackend('backend C')
  instances.push(restarted)

  const persistedSession = await jsonRequest(restarted.origin, '/api/browser-native/session/read', {
    method: 'POST', body: protocolBody({ sessionId, offset: 0 }),
  })
  assert.equal(persistedSession.status, 200, JSON.stringify(persistedSession.body))
  const persistedEvents = persistedSession.body.events
  assert.equal(persistedEvents.length, 1)

  const persistedManifest = await jsonRequest(restarted.origin,
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
    { cookie })
  assert.equal(persistedManifest.status, 200, JSON.stringify(persistedManifest.body))
  assert.equal(persistedManifest.body.revision, 1)
  assert.equal(persistedManifest.body.entries.filter(entry => entry.kind === 'file').length, 1)
  const operationResults = await Promise.all(workspaceChanges.map(item => jsonRequest(restarted.origin,
    `/api/browser-native/workspace/operation/${item.operationId}?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
    { cookie })))
  assert.equal(operationResults.filter(result => result.body.found === true).length, 1)

  process.stdout.write(`${JSON.stringify({
    result: 'unsafe-multi-instance-confirmed',
    scope: 'two-real-node-processes-sharing-one-local-dataDir',
    backendPids: [first.pid, second.pid],
    session: {
      bothWriterClaimsAccepted: true,
      distinctOwnerTokens: ownerA.body.owner.ownerToken !== ownerB.body.owner.ownerToken,
      bothSameSeqAppendsAccepted: [appendA.status, appendB.status],
      bothFlushesAccepted: [flushA.status, flushB.status],
      eventsAfterColdRestart: persistedEvents.length,
      survivingMessage: persistedEvents[0].data.message.content[0].text,
    },
    workspace: {
      bothLeaseClaimsAccepted: true,
      sameFencingToken: claimA.body.fencingToken,
      distinctWriterTokens: claimA.body.writerToken !== claimB.body.writerToken,
      bothBaseZeroCommitsAccepted: commits.map(result => result.status),
      committedRevisionAfterColdRestart: persistedManifest.body.revision,
      survivingPaths: persistedManifest.body.entries.filter(entry => entry.kind === 'file').map(entry => entry.path),
      operationReceiptsAfterColdRestart: operationResults.map(result => result.body.found === true),
    },
    conclusion: 'the PoC backend is not safe for concurrent instances sharing dataDir; in-process locks do not coordinate processes',
  })}\n`)
} finally {
  await Promise.all(instances.map(instance => stopBackend(instance).catch(async error => {
    if (instance.child.exitCode === null && instance.child.signalCode === null) instance.child.kill('SIGKILL')
    await new Promise(resolveExit => {
      if (instance.child.exitCode !== null || instance.child.signalCode !== null) return resolveExit(undefined)
      instance.child.once('exit', resolveExit)
    })
    if (!(error instanceof Error)) throw error
  })))
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
