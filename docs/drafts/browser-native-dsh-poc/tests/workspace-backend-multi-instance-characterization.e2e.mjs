import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

async function killBackend(instance) {
  if (instance.child.exitCode !== null || instance.child.signalCode !== null) return
  const exited = new Promise(resolveExit => instance.child.once('exit', resolveExit))
  instance.child.kill('SIGKILL')
  await exited
}

async function expectBackendStartFailure(label, expectedMessage) {
  const child = fork(fixture, [dataDir], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const stderr = []
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  const result = await new Promise((resolveResult, rejectResult) => {
    child.once('exit', (code, signal) => resolveResult({ code, signal }))
    child.once('error', rejectResult)
  })
  assert.ok(result.code !== 0 || result.signal !== null, `${label} unexpectedly started`)
  assert.match(stderr.join(''), expectedMessage)
  return { ...result, stderr: stderr.join('') }
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
    method: 'POST', body: protocolBody({ sessionId, header }),
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const initialOwner = created.body.owner.ownerToken
  const event = { seq: 0, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'from-backend-A' }] } } }
  const appended = await jsonRequest(first.origin, '/api/browser-native/session/append', {
    method: 'POST',
    body: protocolBody({ sessionId, ownerToken: initialOwner, expectedNextSeq: 0, events: [event] }),
  })
  assert.equal(appended.status, 200, JSON.stringify(appended.body))
  const flushed = await jsonRequest(first.origin, '/api/browser-native/session/flush', {
    method: 'POST', body: protocolBody({ sessionId, ownerToken: initialOwner }),
  })
  assert.equal(flushed.status, 200, JSON.stringify(flushed.body))

  const secondStart = await expectBackendStartFailure('backend B', /BACKEND_ALREADY_RUNNING|owned by a live process/)

  const claimA = await jsonRequest(first.origin, '/api/browser-native/workspace/lease', {
    method: 'POST', cookie, body: protocolBody({ workspaceId, operation: 'claim' }),
  })
  assert.equal(claimA.status, 200, JSON.stringify(claimA.body))
  const workspaceContent = 'backend A durable write\n'
  const workspaceHash = createHash('sha256').update(workspaceContent).digest('hex')
  const operationId = randomUUID()
  const upload = await fetch(`${first.origin}/api/browser-native/workspace/blob/${workspaceHash}`, {
    method: 'PUT',
    headers: {
      cookie,
      'x-browser-native-protocol': '1',
      'x-request-id': randomUUID(),
      'x-workspace-id': workspaceId,
    },
    body: workspaceContent,
  })
  assert.equal(upload.status, 200, await upload.text())
  const commitBody = protocolBody({
    workspaceId,
    operationId,
    baseRevision: 0,
    writerToken: claimA.body.writerToken,
    fencingToken: claimA.body.fencingToken,
    changes: [{
      path: 'backend-a.txt',
      kind: 'file',
      hash: workspaceHash,
      bytes: Buffer.byteLength(workspaceContent),
      mode: 0o644,
    }],
  })
  const commitA = await jsonRequest(first.origin, '/api/browser-native/workspace/commit', {
    method: 'POST', cookie, body: commitBody,
  })
  assert.equal(commitA.status, 200, JSON.stringify(commitA.body))

  await killBackend(first)
  const restarted = await startBackend('backend C')
  instances.push(restarted)

  const persistedSession = await jsonRequest(restarted.origin, '/api/browser-native/session/read', {
    method: 'POST', body: protocolBody({ sessionId, offset: 0 }),
  })
  assert.equal(persistedSession.status, 200, JSON.stringify(persistedSession.body))
  const persistedEvents = persistedSession.body.events
  assert.equal(persistedEvents.length, 1)
  assert.equal(persistedEvents[0].data.message.content[0].text, 'from-backend-A')

  const persistedManifest = await jsonRequest(restarted.origin,
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
    { cookie })
  assert.equal(persistedManifest.status, 200, JSON.stringify(persistedManifest.body))
  assert.equal(persistedManifest.body.revision, 1)
  assert.equal(persistedManifest.body.entries.filter(entry => entry.kind === 'file').length, 1)
  assert.equal(persistedManifest.body.entries.find(entry => entry.path === 'backend-a.txt')?.hash, workspaceHash)

  const claimC = await jsonRequest(restarted.origin, '/api/browser-native/workspace/lease', {
    method: 'POST', cookie, body: protocolBody({ workspaceId, operation: 'claim' }),
  })
  assert.equal(claimC.status, 200, JSON.stringify(claimC.body))
  assert.ok(claimC.body.fencingToken > claimA.body.fencingToken)
  const replayedCommit = await jsonRequest(restarted.origin, '/api/browser-native/workspace/commit', {
    method: 'POST', cookie,
    body: { ...commitBody, requestId: randomUUID(), writerToken: claimC.body.writerToken, fencingToken: claimC.body.fencingToken },
  })
  assert.equal(replayedCommit.status, 200, JSON.stringify(replayedCommit.body))
  assert.equal(replayedCommit.body.replayed, true)
  assert.equal(replayedCommit.body.revision, 1)
  const operationResult = await jsonRequest(restarted.origin,
    `/api/browser-native/workspace/operation/${operationId}?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
    { cookie })
  assert.equal(operationResult.body.found, true)

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    scope: 'single-writer-lock-and-sigkill-recovery-for-one-local-dataDir',
    backendPids: [first.pid, restarted.pid],
    secondStart: { code: secondStart.code, signal: secondStart.signal },
    session: {
      firstAppendStatus: appended.status,
      firstFlushStatus: flushed.status,
      eventsAfterColdRestart: persistedEvents.length,
      survivingMessage: persistedEvents[0].data.message.content[0].text,
    },
    workspace: {
      firstCommitStatus: commitA.status,
      committedRevisionAfterColdRestart: persistedManifest.body.revision,
      survivingPaths: persistedManifest.body.entries.filter(entry => entry.kind === 'file').map(entry => entry.path),
      replayedCommitStatus: replayedCommit.status,
      replayedOperationId: operationId,
      fencingTokens: [claimA.body.fencingToken, claimC.body.fencingToken],
      operationReceiptAfterColdRestart: operationResult.body.found === true,
    },
    conclusion: 'one backend writer is enforced per local dataDir; a SIGKILL leaves durable Session and Workspace state recoverable by a new process',
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
