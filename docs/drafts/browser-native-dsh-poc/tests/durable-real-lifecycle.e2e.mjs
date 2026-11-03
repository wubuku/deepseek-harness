import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const envFile = process.env.DSH_POC_ENV_FILE === undefined ? undefined : resolve(process.env.DSH_POC_ENV_FILE)
const provider = process.env.DSH_POC_REAL_PROVIDER ?? 'openai-next'
const skip = envFile === undefined ? 'DSH_POC_ENV_FILE is not set; real durable lifecycle is skipped' : false
const localNoProxy = new Set((process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').filter(Boolean))
localNoProxy.add('127.0.0.1')
localNoProxy.add('localhost')
process.env.NO_PROXY = [...localNoProxy].join(',')
process.env.no_proxy = process.env.NO_PROXY

function childEnv() {
  const env = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'NO_PROXY', 'no_proxy']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

function startInstance(context, dataDir) {
  const script = fileURLToPath(new URL('./fixtures/real-durable-backend-process.mjs', import.meta.url))
  const child = fork(script, [dataDir, envFile, provider], { execArgv: [], env: childEnv(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr.on('data', data => { stderr = `${stderr}${String(data)}`.slice(-4_000) })
  const exited = once(child, 'exit')
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
  context.after(stop)
  return new Promise((resolve, reject) => {
    child.once('message', message => {
      if (message?.type !== 'ready') return
      resolve({ origin: message.origin, pid: message.pid, recovered: message.recovered, stop })
    })
    child.once('exit', (code, signal) => {
      reject(Object.assign(new Error(`real durable backend exited before readiness: ${stderr}`), { exitCode: code, signal, stderr }))
    })
  })
}

async function openIdentity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const body = await response.json()
  return { cookie, workspaceId: body.workspaceId }
}

async function request(origin, pathname, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ protocolVersion: 1, requestId: `real-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`, ...body }) }),
  })
  return { status: response.status, body: await response.json() }
}

async function turnStatus(origin, cookie, turnId) {
  return request(origin, `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`, { cookie })
}

async function waitPending(origin, cookie, turnId, limitMs = 170_000) {
  let last
  const deadline = Date.now() + limitMs
  while (Date.now() < deadline) {
    last = await turnStatus(origin, cookie, turnId)
    if (last.body.pendingApproval !== undefined) return { pending: last.body.pendingApproval, status: last.body }
    if (last.body.status !== 'running') {
      throw new Error(`turn ${turnId} settled as ${last.body.status} without a pending write approval: ${JSON.stringify(last.body)}`)
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  throw new Error(`no pending approval for ${turnId}: ${JSON.stringify(last)}`)
}

async function waitSettled(origin, cookie, turnId, limitMs = 170_000) {
  let last
  const deadline = Date.now() + limitMs
  while (Date.now() < deadline) {
    last = await turnStatus(origin, cookie, turnId)
    if (last.body.status !== 'running') return last.body
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  throw new Error(`turn ${turnId} did not settle: ${JSON.stringify(last)}`)
}

async function manifestPaths(origin, cookie, workspaceId) {
  const manifest = await request(origin, `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`, { cookie })
  assert.equal(manifest.status, 200, JSON.stringify(manifest.body))
  return (manifest.body.entries ?? []).map(entry => entry.path)
}

async function collectAttach(origin, cookie, { turnId, fromSeq }) {
  const response = await fetch(`${origin}/api/browser-native/session/durable/stream?turnId=${encodeURIComponent(turnId)}&fromSeq=${String(fromSeq)}`, { headers: { cookie } })
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
    events: lines.filter(line => line.kind === 'event').map(line => ({ seq: line.seq, type: line.type, data: line.data })),
    settled: lines.find(line => line.kind === 'settled'),
  }
}

function writePrompt(filePath, content) {
  return `Call the write tool now, exactly once. Use file_path ${filePath} and content ${content}. Do not answer before calling the tool. After the tool result, reply DONE.`
}

test('real model completes a durable approval turn, cancels a second turn, and a killed backend recovers the third', { skip, timeout: 600_000 }, async context => {
  const startedAt = Date.now()
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-durable-real-'))
  context.after(async () => { await rm(dataDir, { recursive: true, force: true }) })
  const journalPath = join(dataDir, 'durable-runs.json')
  const sessionId = `durable-real-${String(startedAt)}`
  const first = await startInstance(context, dataDir)
  const { cookie, workspaceId } = await openIdentity(first.origin)

  const approvedTurn = 'real-durable-approval'
  const approvedPath = '/dsh/home/workspace/real-durable-approved.txt'
  const startedApproval = await request(first.origin, '/api/browser-native/session/durable', {
    method: 'POST', cookie, body: { sessionId, turnId: approvedTurn, prompt: writePrompt(approvedPath, 'REAL_DURABLE_APPROVED') },
  })
  assert.equal(startedApproval.status, 202, JSON.stringify(startedApproval.body))
  const pendingApproval = await waitPending(first.origin, cookie, approvedTurn)
  assert.equal(pendingApproval.pending.name, 'write')
  assert.equal((await manifestPaths(first.origin, cookie, workspaceId)).includes('real-durable-approved.txt'), false, 'the write must not run before approval')
  const approved = await request(first.origin, '/api/browser-native/session/durable/approve', {
    method: 'POST', cookie, body: { turnId: approvedTurn, approvalId: pendingApproval.pending.approvalId, decision: 'approve' },
  })
  assert.equal(approved.status, 202, JSON.stringify(approved.body))
  const approvedSettled = await waitSettled(first.origin, cookie, approvedTurn)
  assert.equal(approvedSettled.status, 'completed')
  assert.equal((await manifestPaths(first.origin, cookie, workspaceId)).includes('real-durable-approved.txt'), true)

  const cancelledTurn = 'real-durable-cancel'
  const cancelledPath = '/dsh/home/workspace/real-durable-cancelled.txt'
  const startedCancel = await request(first.origin, '/api/browser-native/session/durable', {
    method: 'POST', cookie, body: { sessionId, turnId: cancelledTurn, prompt: writePrompt(cancelledPath, 'REAL_DURABLE_CANCELLED') },
  })
  assert.equal(startedCancel.status, 202, JSON.stringify(startedCancel.body))
  const pendingCancel = await waitPending(first.origin, cookie, cancelledTurn)
  assert.equal(pendingCancel.pending.name, 'write')
  const stopped = await request(first.origin, '/api/browser-native/session/durable/stop', {
    method: 'POST', cookie, body: { turnId: cancelledTurn },
  })
  assert.equal(stopped.status, 202, JSON.stringify(stopped.body))
  const cancelledSettled = await waitSettled(first.origin, cookie, cancelledTurn)
  assert.equal(cancelledSettled.status, 'cancelled')
  assert.equal(cancelledSettled.pendingApproval, undefined)
  assert.equal((await manifestPaths(first.origin, cookie, workspaceId)).includes('real-durable-cancelled.txt'), false)

  const restartTurn = 'real-durable-restart'
  const restartPath = '/dsh/home/workspace/real-durable-restart.txt'
  const startedRestart = await request(first.origin, '/api/browser-native/session/durable', {
    method: 'POST', cookie, body: { sessionId, turnId: restartTurn, prompt: writePrompt(restartPath, 'REAL_DURABLE_RESTART') },
  })
  assert.equal(startedRestart.status, 202, JSON.stringify(startedRestart.body))
  const pendingRestart = await waitPending(first.origin, cookie, restartTurn)
  assert.equal(pendingRestart.pending.name, 'write')
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  assert.equal(journal.runs.some(run => run.turnId === restartTurn), true)
  await first.stop()

  const second = await startInstance(context, dataDir)
  assert.notEqual(second.pid, first.pid)
  assert.equal(second.recovered, 1)
  const restored = await turnStatus(second.origin, cookie, restartTurn)
  assert.equal(restored.status, 200, JSON.stringify(restored.body))
  assert.equal(restored.body.status, 'failed')
  assert.equal(restored.body.error.code, 'DURABLE_HOST_RESTARTED')
  assert.equal(restored.body.recovered, true)
  const attached = await collectAttach(second.origin, cookie, { turnId: restartTurn, fromSeq: 0 })
  assert.equal(attached.settled.status, 'failed')
  const result = attached.events.find(event => event.type === 'tool/result')
  assert.equal(result.data.message.isError, true)
  assert.match(result.data.message.content[0].text, /backend restart/i)
  assert.equal(attached.events.at(-1).data.reason.error.code, 'DURABLE_HOST_RESTARTED')
  assert.equal((await manifestPaths(second.origin, cookie, workspaceId)).includes('real-durable-restart.txt'), false)
  await assert.rejects(readFile(journalPath, 'utf8'), error => error.code === 'ENOENT')

  const metrics = await request(second.origin, '/api/browser-native/observability/metrics')
  assert.equal(metrics.status, 200)
  assert.equal(metrics.body.model.requests, 0, 'recovery must not call the real model')
  assert.equal(metrics.body.durableTurns.recovered, 1)
  assert.equal(metrics.body.durableTurns.journalHealthy, true)

  context.diagnostic(JSON.stringify({
    result: 'passed',
    scope: 'durable-real-approval-cancel-restart',
    provider,
    pids: [first.pid, second.pid],
    approval: { status: approvedSettled.status, pendingName: pendingApproval.pending.name, wroteFile: true },
    cancellation: { status: cancelledSettled.status, pendingName: pendingCancel.pending.name, wroteFile: false },
    restart: { recovered: second.recovered, status: restored.body.status, code: restored.body.error.code, settlement: attached.events.map(event => event.type), modelRequestsAfterRestart: metrics.body.model.requests, journalCleared: true, wroteFile: false },
    elapsedMs: Date.now() - startedAt,
  }))
})
