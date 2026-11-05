import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

async function backendProcess(context, dataDir, modelMode) {
  const env = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  const child = fork(fileURLToPath(new URL('./fixtures/durable-backend-process.mjs', import.meta.url)), [dataDir, modelMode], {
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
      exited.then(() => { throw new Error(`durable backend fixture exited before readiness: ${stderr}`) }),
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
    recovered: ready.recovered,
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

async function openIdentity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const cookies = response.headers.getSetCookie().map(value => value.split(';')[0])
  const body = await response.json()
  return { cookie: cookies.join('; '), workspaceId: body.workspaceId }
}

async function request(origin, pathname, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ protocolVersion: 1, requestId: `workspace-recovery-${String(Date.now())}`, ...body }) }),
  })
  const payload = await response.json()
  return { status: response.status, body: payload }
}

async function manifestEntry(origin, cookie, workspaceId, path) {
  const manifest = await request(origin, `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`, { cookie })
  assert.equal(manifest.status, 200, JSON.stringify(manifest.body))
  return (manifest.body.entries ?? []).find(entry => entry.path === path)
}

async function blobText(origin, cookie, workspaceId, hash) {
  const response = await fetch(
    `${origin}/api/browser-native/workspace/blob/${hash}?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
    { headers: { cookie } },
  )
  assert.equal(response.status, 200)
  return Buffer.from(await response.arrayBuffer()).toString('utf8')
}

async function eventsOf(origin, cookie, sessionId) {
  const read = await request(origin, '/api/browser-native/session/read', { method: 'POST', cookie, body: { sessionId, offset: 0 } })
  assert.equal(read.status, 200, JSON.stringify(read.body))
  return read.body.events
}

async function waitPending(origin, cookie, turnId) {
  let last
  for (let attempt = 0; attempt < 300; attempt += 1) {
    last = await request(origin, `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`, { cookie })
    if (last.body.pendingApproval !== undefined) return last.body.pendingApproval
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  }
  throw new Error(`no pending approval for ${turnId}: ${JSON.stringify(last)}`)
}

async function waitEmptyJournal(journalPath) {
  let last
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      last = JSON.parse(await readFile(journalPath, 'utf8'))
      if (Array.isArray(last.runs) && last.runs.length === 0) return
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
  }
  throw new Error(`running-turn journal did not empty: ${JSON.stringify(last)}`)
}

async function waitSettled(origin, cookie, turnId) {
  let last
  for (let attempt = 0; attempt < 400; attempt += 1) {
    last = await request(origin, `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`, { cookie })
    if (last.body.status !== 'running') return last.body
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  }
  throw new Error(`turn ${turnId} did not settle: ${JSON.stringify(last)}`)
}

test('a committed durable Workspace write survives restart while durable turns carry no attachments', { timeout: 40_000 }, async context => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-durable-workspace-recovery-'))
  context.after(async () => { await rm(dataDir, { recursive: true, force: true }) })
  const sessionId = 'durable-workspace-session'
  const turnId = 'durable-workspace-commit'
  const journalPath = join(dataDir, 'durable-runs.json')
  const committedPath = 'durable-committed.txt'
  const committedBody = 'DURABLE_COMMITTED_BODY\n'

  const first = await backendProcess(context, dataDir, 'commit-write')
  const { cookie, workspaceId } = await openIdentity(first.origin)
  const started = await request(first.origin, '/api/browser-native/session/durable', {
    method: 'POST', cookie, body: { sessionId, turnId, prompt: 'write a committed workspace file' },
  })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  const pending = await waitPending(first.origin, cookie, turnId)
  assert.equal(pending.name, 'write')
  assert.equal(await manifestEntry(first.origin, cookie, workspaceId, committedPath), undefined, 'the write must wait for approval')
  const approved = await request(first.origin, '/api/browser-native/session/durable/approve', {
    method: 'POST', cookie, body: { turnId, approvalId: pending.approvalId, decision: 'approve' },
  })
  assert.equal(approved.status, 202, JSON.stringify(approved.body))
  const settled = await waitSettled(first.origin, cookie, turnId)
  assert.equal(settled.status, 'completed')

  const committed = await manifestEntry(first.origin, cookie, workspaceId, committedPath)
  assert.notEqual(committed, undefined, 'the approved write must commit before the restart')
  assert.equal(committed.kind, 'file')
  assert.equal(await blobText(first.origin, cookie, workspaceId, committed.hash), committedBody)

  const before = await eventsOf(first.origin, cookie, sessionId)
  assert.equal(before.filter(event => event.type === 'tool/call').length, 1)
  assert.equal(before.filter(event => event.type === 'tool/result').length, 1, 'the committed tool call must be settled')
  assert.equal(before.filter(event => event.type === 'turn/end').length, 1)
  assert.equal(before.at(-1).data.reason.kind, 'completed')
  const userMessage = before.find(event => event.type === 'user/message')
  assert.deepEqual(userMessage.data.content, [{ type: 'text', text: 'write a committed workspace file' }], 'durable turns carry a text prompt, so no attachment block can appear')
  await waitEmptyJournal(journalPath)
  await first.stop()

  const second = await backendProcess(context, dataDir, 'read-committed')
  assert.notEqual(second.pid, first.pid)
  assert.equal(second.recovered, 0, 'a settled turn has nothing to recover')
  await assert.rejects(readFile(journalPath, 'utf8'), error => error.code === 'ENOENT', 'recovery must clear the empty journal')

  const restored = await manifestEntry(second.origin, cookie, workspaceId, committedPath)
  assert.notEqual(restored, undefined, 'the committed Workspace entry must survive the restart')
  assert.equal(restored.hash, committed.hash)
  assert.equal(restored.bytes, committed.bytes)
  assert.equal(await blobText(second.origin, cookie, workspaceId, restored.hash), committedBody)

  const after = await eventsOf(second.origin, cookie, sessionId)
  assert.deepEqual(after.map(event => event.type), before.map(event => event.type), 'recovery without an unfinished turn must not append events')

  const readTurnId = 'durable-workspace-read'
  const readStarted = await request(second.origin, '/api/browser-native/session/durable', {
    method: 'POST', cookie, body: { sessionId, turnId: readTurnId, prompt: 'read the committed workspace file' },
  })
  assert.equal(readStarted.status, 202, JSON.stringify(readStarted.body))
  const readSettled = await waitSettled(second.origin, cookie, readTurnId)
  assert.equal(readSettled.status, 'completed')
  assert.equal(readSettled.turn, 2)
  const readEvents = await eventsOf(second.origin, cookie, sessionId)
  const readResult = readEvents.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === 'durable-commit-read')
  assert.equal(readResult.length, 1)
  assert.equal(readResult[0].data.message.isError, undefined, 'a successful tool result carries no isError flag')
  assert.match(readResult[0].data.message.content[0].text, /DURABLE_COMMITTED_BODY/)
  const afterRead = await second.metrics()
  assert.equal(afterRead.modelRequests, 2, 'the post-restart turn issues one tool-call request and one follow-up request')
  assert.equal(afterRead.toolCalls, 1)
  assert.equal(afterRead.journalHealthy, true)
  assert.equal(afterRead.recovered, 0)

  context.diagnostic(JSON.stringify({
    result: 'passed',
    scope: 'durable-workspace-recovery',
    pids: [first.pid, second.pid],
    committedWrite: { status: settled.status, path: committedPath, bytes: committed.bytes, hash: committed.hash },
    durableUserMessage: 'text',
    attachments: 'not-applicable',
    restart: { recovered: second.recovered, journalCleared: true, manifestHashStable: true, sessionEventsStable: before.length },
    postRestartRead: { status: readSettled.status, turn: readSettled.turn, isError: false, bytesMatch: true },
  }))
})
