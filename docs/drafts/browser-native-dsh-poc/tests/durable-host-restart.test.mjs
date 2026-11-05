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
    ...(body === undefined ? {} : { body: JSON.stringify({ protocolVersion: 1, requestId: `restart-${String(Date.now())}`, ...body }) }),
  })
  const payload = await response.json()
  return { status: response.status, body: payload }
}

async function manifestPaths(origin, cookie, workspaceId) {
  const manifest = await request(origin, `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`, { cookie })
  assert.equal(manifest.status, 200, JSON.stringify(manifest.body))
  return (manifest.body.entries ?? []).map(entry => entry.path)
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

async function waitSettled(origin, cookie, turnId) {
  let last
  for (let attempt = 0; attempt < 300; attempt += 1) {
    last = await request(origin, `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`, { cookie })
    if (last.body.status !== 'running') return last.body
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  }
  throw new Error(`turn ${turnId} did not settle: ${JSON.stringify(last)}`)
}

async function collectAttach(origin, cookie, { turnId, fromSeq }) {
  const response = await fetch(`${origin}/api/browser-native/session/durable/stream?turnId=${encodeURIComponent(turnId)}&fromSeq=${String(fromSeq)}`, {
    headers: { cookie },
  })
  assert.equal(response.status, 200)
  const lines = []
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) if (part !== '') lines.push(JSON.parse(part))
  }
  if (buffer !== '') lines.push(JSON.parse(buffer))
  return {
    events: lines.filter(line => line.kind === 'event').map(line => ({
      seq: line.seq,
      time: line.time,
      type: line.type,
      ...(line.surfaceOp === undefined ? {} : { surfaceOp: line.surfaceOp }),
      data: line.data,
    })),
    settled: lines.find(line => line.kind === 'settled'),
  }
}

test('a killed backend settles its unfinished durable turn without re-running the model or the tool', { timeout: 40_000 }, async context => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-durable-restart-'))
  context.after(async () => { await rm(dataDir, { recursive: true, force: true }) })
  const sessionId = 'durable-restart-session'
  const turnId = 'durable-restart-turn'
  const journalPath = join(dataDir, 'durable-runs.json')
  const sessionPath = join(dataDir, 'sessions', `${sessionId}.json`)

  const first = await backendProcess(context, dataDir, 'write')
  const { cookie, workspaceId } = await openIdentity(first.origin)
  const started = await request(first.origin, '/api/browser-native/session/durable', {
    method: 'POST', cookie, body: { sessionId, turnId, prompt: 'write a file after the restart' },
  })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  const pending = await waitPending(first.origin, cookie, turnId)
  assert.equal(pending.name, 'write')
  assert.deepEqual(await manifestPaths(first.origin, cookie, workspaceId), [], 'the write must wait for approval')

  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  assert.equal(journal.version, 1)
  assert.equal(journal.runs.length, 1)
  assert.equal(journal.runs[0].turnId, turnId)
  const before = JSON.parse(await readFile(sessionPath, 'utf8'))
  assert.deepEqual(before.events.map(event => event.type), [
    'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'tool/call',
  ])
  const firstMetrics = await first.metrics()
  assert.equal(firstMetrics.modelRequests, 1)
  assert.equal(firstMetrics.toolCalls, 1)
  await first.stop()

  const second = await backendProcess(context, dataDir, 'text')
  assert.notEqual(second.pid, first.pid)
  assert.equal(second.recovered, 1, 'the restarted backend must settle exactly one unfinished turn')

  const restoredStatus = await request(second.origin, `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`, { cookie })
  assert.equal(restoredStatus.status, 200, JSON.stringify(restoredStatus.body))
  assert.equal(restoredStatus.body.status, 'failed')
  assert.equal(restoredStatus.body.error.code, 'DURABLE_HOST_RESTARTED')
  assert.equal(restoredStatus.body.recovered, true)
  assert.equal(restoredStatus.body.turn, 1)

  const attached = await collectAttach(second.origin, cookie, { turnId, fromSeq: 0 })
  assert.equal(attached.settled.status, 'failed')
  assert.deepEqual(attached.events.map(event => event.type), [
    'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'tool/call',
    'tool/result', 'turn/end',
  ])
  const result = attached.events.find(event => event.type === 'tool/result')
  assert.equal(result.data.message.toolCallId, 'restart-write-1')
  assert.equal(result.data.message.isError, true)
  assert.match(result.data.message.content[0].text, /backend restart/i)
  const end = attached.events.at(-1)
  assert.equal(end.data.reason.kind, 'error')
  assert.equal(end.data.reason.error.code, 'DURABLE_HOST_RESTARTED')

  const after = await eventsOf(second.origin, cookie, sessionId)
  assert.equal(after.filter(event => event.type === 'assistant/message').length, 1, 'recovery must not request the model again')
  assert.equal(after.filter(event => event.type === 'tool/call').length, after.filter(event => event.type === 'tool/result').length)
  assert.equal(after.filter(event => event.type === 'turn/end').length, 1)
  assert.deepEqual(await manifestPaths(second.origin, cookie, workspaceId), [], 'the unapproved write must not run during recovery')

  const afterRestartMetrics = await second.metrics()
  assert.equal(afterRestartMetrics.modelRequests, 0, 'recovery must not call the model')
  assert.equal(afterRestartMetrics.toolCalls, 0, 'recovery must not execute the tool')
  assert.equal(afterRestartMetrics.journalHealthy, true)
  assert.equal(afterRestartMetrics.recovered, 1)

  const stored = JSON.parse(await readFile(sessionPath, 'utf8'))
  assert.equal(stored.ownerEpoch, before.ownerEpoch + 1, 'recovery must fence the pre-restart lease')
  assert.equal(stored.ownerToken, undefined)
  await assert.rejects(readFile(journalPath, 'utf8'), error => error.code === 'ENOENT', 'recovery must clear the journal')

  const claimed = await request(second.origin, '/api/browser-native/session/open', {
    method: 'POST', cookie, body: { sessionId, access: 'write' },
  })
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body))
  assert.equal(claimed.body.owner.ownerEpoch, stored.ownerEpoch + 1, 'a new claim must advance the recovered epoch')
  await request(second.origin, '/api/browser-native/session/close', {
    method: 'POST', cookie, body: { sessionId, ownerToken: claimed.body.owner.ownerToken },
  })

  const nextTurnId = 'durable-restart-next-turn'
  const nextStart = await request(second.origin, '/api/browser-native/session/durable', {
    method: 'POST', cookie, body: { sessionId, turnId: nextTurnId, prompt: 'continue after recovery' },
  })
  assert.equal(nextStart.status, 202, JSON.stringify(nextStart.body))
  const nextSettled = await waitSettled(second.origin, cookie, nextTurnId)
  assert.equal(nextSettled.status, 'completed')
  assert.equal(nextSettled.turn, 2)
  const finalMetrics = await second.metrics()
  assert.equal(finalMetrics.modelRequests, 1, 'the next turn issues exactly one model request')

  const metrics = await request(second.origin, '/api/browser-native/observability/metrics')
  assert.equal(metrics.status, 200)
  assert.equal(metrics.body.durableTurns.recovered, 1)
  assert.equal(metrics.body.durableTurns.journalHealthy, true)

  context.diagnostic(JSON.stringify({
    result: 'passed',
    scope: 'durable-host-restart',
    pids: [first.pid, second.pid],
    recoveredTurns: second.recovered,
    restored: { status: restoredStatus.body.status, code: restoredStatus.body.error.code, turn: restoredStatus.body.turn },
    settlement: attached.events.map(event => event.type),
    journalCleared: true,
    modelRequestsAfterRestart: afterRestartMetrics.modelRequests,
    toolCallsAfterRestart: afterRestartMetrics.toolCalls,
    workspaceEntriesAfterRestart: 0,
    ownerEpoch: { before: before.ownerEpoch, after: stored.ownerEpoch },
    nextTurn: { status: nextSettled.status, turn: nextSettled.turn },
  }))
})

test('a restart during an open model step closes the step and settles the turn', { timeout: 30_000 }, async context => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-durable-restart-step-'))
  context.after(async () => { await rm(dataDir, { recursive: true, force: true }) })
  const sessionId = 'durable-restart-step-session'
  const turnId = 'durable-restart-step-turn'

  const first = await backendProcess(context, dataDir, 'hang')
  const { cookie } = await openIdentity(first.origin)
  const started = await request(first.origin, '/api/browser-native/session/durable', {
    method: 'POST', cookie, body: { sessionId, turnId, prompt: 'answer slowly' },
  })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  const before = await eventsOf(first.origin, cookie, sessionId)
  assert.deepEqual(before.map(event => event.type), ['turn/start', 'user/message', 'step/start'])
  await first.stop()

  const second = await backendProcess(context, dataDir, 'text')
  assert.equal(second.recovered, 1)
  const attached = await collectAttach(second.origin, cookie, { turnId, fromSeq: 0 })
  assert.deepEqual(attached.events.map(event => event.type), ['turn/start', 'user/message', 'step/start', 'step/end', 'turn/end'])
  assert.equal(attached.settled.status, 'failed')
  assert.equal(attached.settled.error.code, 'DURABLE_HOST_RESTARTED')
  const metrics = await second.metrics()
  assert.equal(metrics.modelRequests, 0, 'recovery must not resume the interrupted model request')
  const after = await eventsOf(second.origin, cookie, sessionId)
  assert.equal(after.filter(event => event.type === 'step/start').length, after.filter(event => event.type === 'step/end').length)
  assert.equal(after.filter(event => event.type === 'turn/end').length, 1)

  context.diagnostic(JSON.stringify({
    result: 'passed',
    scope: 'durable-host-restart-open-step',
    pids: [first.pid, second.pid],
    settlement: attached.events.map(event => event.type),
    modelRequestsAfterRestart: metrics.modelRequests,
  }))
})
