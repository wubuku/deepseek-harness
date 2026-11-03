import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SESSION_FORMAT_VERSION = 4

function childEnv() {
  const env = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

function startInstance(context, dataDir, { fixture, mode = '' } = {}) {
  const script = fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url))
  const child = fork(script, mode === '' ? [dataDir] : [dataDir, mode], {
    execArgv: [], env: childEnv(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
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
      reject(Object.assign(new Error(`backend fixture exited before readiness: ${stderr}`), { exitCode: code, signal, stderr }))
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
    ...(body === undefined ? {} : { body: JSON.stringify({ protocolVersion: 1, requestId: `multi-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`, ...body }) }),
  })
  return { status: response.status, body: await response.json() }
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

test('only one backend wins a dataDir and only one writer wins the Session lease', { timeout: 40_000 }, async context => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-multi-host-'))
  context.after(async () => { await rm(dataDir, { recursive: true, force: true }) })
  const race = await Promise.allSettled([
    startInstance(context, dataDir, { fixture: 'workspace-backend-instance.mjs' }),
    startInstance(context, dataDir, { fixture: 'workspace-backend-instance.mjs' }),
  ])
  const winners = race.filter(result => result.status === 'fulfilled').map(result => result.value)
  const losers = race.filter(result => result.status === 'rejected').map(result => result.reason)
  assert.equal(winners.length, 1, 'exactly one backend must own the dataDir')
  assert.equal(losers.length, 1, 'the competing backend must be refused')
  assert.notEqual(losers[0].exitCode, 0)
  assert.match(losers[0].stderr, /BACKEND_ALREADY_RUNNING|BACKEND_LOCK_UNREADABLE|BACKEND_LOCK_INVALID/)
  const first = winners[0]
  const { cookie } = await openIdentity(first.origin)

  const sessionId = 'multi-host-session'
  const created = await request(first.origin, '/api/browser-native/session/create', {
    method: 'POST', cookie, body: { sessionId, header: { id: sessionId, version: SESSION_FORMAT_VERSION, cwd: '/dsh/home', createdAt: Date.now() } },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const createOwner = created.body.owner
  const closed = await request(first.origin, '/api/browser-native/session/close', {
    method: 'POST', cookie, body: { sessionId, ownerToken: createOwner.ownerToken },
  })
  assert.equal(closed.status, 200, JSON.stringify(closed.body))

  const claims = await Promise.all([
    request(first.origin, '/api/browser-native/session/open', { method: 'POST', cookie, body: { sessionId, access: 'write' } }),
    request(first.origin, '/api/browser-native/session/open', { method: 'POST', cookie, body: { sessionId, access: 'write' } }),
  ])
  const claimWinner = claims.find(claim => claim.status === 200)
  const claimLoser = claims.find(claim => claim.status !== 200)
  assert.ok(claimWinner, `one simultaneous claim must win: ${JSON.stringify(claims)}`)
  assert.ok(claimLoser, 'one simultaneous claim must be refused')
  assert.equal(claimLoser.body.error.code, 'SESSION_ALREADY_OWNED')
  assert.ok(claimLoser.body.error.retryAfterMs > 0, 'a refused claim must report the remaining lease')
  const owner = claimWinner.body.owner
  assert.ok(owner.ownerEpoch > createOwner.ownerEpoch, 'a new claim must advance the owner epoch')

  const staleAppend = await request(first.origin, '/api/browser-native/session/append', {
    method: 'POST', cookie, body: { sessionId, ownerToken: createOwner.ownerToken, expectedNextSeq: 0, events: [{ seq: 0, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'stale' }] } } }] },
  })
  assert.equal(staleAppend.status, 409, JSON.stringify(staleAppend.body))
  assert.equal(staleAppend.body.error.code, 'SESSION_OWNERSHIP_LOST')
  const liveAppend = await request(first.origin, '/api/browser-native/session/append', {
    method: 'POST', cookie, body: { sessionId, ownerToken: owner.ownerToken, ownerEpoch: owner.ownerEpoch, expectedNextSeq: 0, events: [{ seq: 0, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'from the winning owner' }] } } }] },
  })
  assert.equal(liveAppend.status, 200, JSON.stringify(liveAppend.body))
  const flushed = await request(first.origin, '/api/browser-native/session/flush', {
    method: 'POST', cookie, body: { sessionId, ownerToken: owner.ownerToken, ownerEpoch: owner.ownerEpoch },
  })
  assert.equal(flushed.status, 200, JSON.stringify(flushed.body))

  await first.stop()
  const restarted = await startInstance(context, dataDir, { fixture: 'workspace-backend-instance.mjs' })
  const persisted = await request(restarted.origin, '/api/browser-native/session/read', { method: 'POST', cookie, body: { sessionId, offset: 0 } })
  assert.equal(persisted.status, 200, JSON.stringify(persisted.body))
  assert.equal(persisted.body.events.length, 1)

  const takeover = await request(restarted.origin, '/api/browser-native/session/open', { method: 'POST', cookie, body: { sessionId, access: 'write' } })
  assert.equal(takeover.status, 200, JSON.stringify(takeover.body))
  const restartedOwner = takeover.body.owner
  assert.ok(restartedOwner.ownerEpoch > owner.ownerEpoch, 'the new instance must fence the pre-restart owner')
  const oldTokenAppend = await request(restarted.origin, '/api/browser-native/session/append', {
    method: 'POST', cookie, body: { sessionId, ownerToken: owner.ownerToken, ownerEpoch: owner.ownerEpoch, expectedNextSeq: 1, events: [{ seq: 1, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'stale after takeover' }] } } }] },
  })
  assert.equal(oldTokenAppend.status, 409, JSON.stringify(oldTokenAppend.body))
  assert.equal(oldTokenAppend.body.error.code, 'SESSION_OWNERSHIP_LOST')
  const takeoverAppend = await request(restarted.origin, '/api/browser-native/session/append', {
    method: 'POST', cookie, body: { sessionId, ownerToken: restartedOwner.ownerToken, ownerEpoch: restartedOwner.ownerEpoch, expectedNextSeq: 1, events: [{ seq: 1, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'from the new instance' }] } } }] },
  })
  assert.equal(takeoverAppend.status, 200, JSON.stringify(takeoverAppend.body))

  context.diagnostic(JSON.stringify({
    result: 'passed',
    scope: 'multi-host-dataDir-and-session-writer',
    backend: { winnerPid: first.pid, loserExitCode: losers[0]?.exitCode, loserStartupError: losers[0]?.stderr.match(/BACKEND_[A-Z_]+/)?.[0] },
    startupRace: { ready: winners.length, refused: losers.length },
    claimRace: { statuses: claims.map(claim => claim.status).sort(), refusedCode: claimLoser.body.error.code, refusedRetryAfterMs: claimLoser.body.error.retryAfterMs },
    fencing: { createEpoch: createOwner.ownerEpoch, claimEpoch: owner.ownerEpoch, afterRestartEpoch: restartedOwner.ownerEpoch, staleAppend: staleAppend.body.error.code, staleAfterRestart: oldTokenAppend.body.error.code },
    session: { persistedEvents: persisted.body.events.length, liveAppendStatus: liveAppend.status, takeoverAppendStatus: takeoverAppend.status },
  }))
})

test('a browser cannot take over a Session while a durable turn holds the lease', { timeout: 40_000 }, async context => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-multi-host-turn-'))
  context.after(async () => { await rm(dataDir, { recursive: true, force: true }) })
  const backend = await startInstance(context, dataDir, { fixture: 'durable-backend-process.mjs', mode: 'hang-first' })
  const { cookie } = await openIdentity(backend.origin)
  const sessionId = 'multi-host-turn-session'
  const turnId = 'multi-host-turn-1'

  const started = await request(backend.origin, '/api/browser-native/session/durable', {
    method: 'POST', cookie, body: { sessionId, turnId, prompt: 'take a long step' },
  })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  assert.equal(started.body.status, 'running')

  const takeoverDuringTurn = await request(backend.origin, '/api/browser-native/session/open', {
    method: 'POST', cookie, body: { sessionId, access: 'write' },
  })
  assert.equal(takeoverDuringTurn.status, 409, JSON.stringify(takeoverDuringTurn.body))
  assert.equal(takeoverDuringTurn.body.error.code, 'SESSION_ALREADY_OWNED')
  assert.ok(takeoverDuringTurn.body.error.retryAfterMs > 0)

  const unownedAppend = await request(backend.origin, '/api/browser-native/session/append', {
    method: 'POST', cookie, body: { sessionId, ownerToken: 'not-the-owner', expectedNextSeq: 0, events: [{ seq: 0, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'guessed' }] } } }] },
  })
  assert.equal(unownedAppend.status, 409, JSON.stringify(unownedAppend.body))
  assert.equal(unownedAppend.body.error.code, 'SESSION_OWNERSHIP_LOST')

  const secondTurn = await request(backend.origin, '/api/browser-native/session/durable', {
    method: 'POST', cookie, body: { sessionId, turnId: 'multi-host-turn-2', prompt: 'compete for the lease' },
  })
  assert.equal(secondTurn.status, 409, JSON.stringify(secondTurn.body))
  assert.equal(secondTurn.body.error.code, 'SESSION_TURN_ACTIVE')

  const stopped = await request(backend.origin, '/api/browser-native/session/durable/stop', {
    method: 'POST', cookie, body: { turnId },
  })
  assert.equal(stopped.status, 202, JSON.stringify(stopped.body))
  const settled = await waitSettled(backend.origin, cookie, turnId)
  assert.equal(settled.status, 'cancelled')

  const takeoverAfterStop = await request(backend.origin, '/api/browser-native/session/open', {
    method: 'POST', cookie, body: { sessionId, access: 'write' },
  })
  assert.equal(takeoverAfterStop.status, 200, JSON.stringify(takeoverAfterStop.body))
  const owner = takeoverAfterStop.body.owner
  const closed = await request(backend.origin, '/api/browser-native/session/close', {
    method: 'POST', cookie, body: { sessionId, ownerToken: owner.ownerToken },
  })
  assert.equal(closed.status, 200, JSON.stringify(closed.body))

  const nextTurnId = 'multi-host-turn-3'
  const nextTurn = await request(backend.origin, '/api/browser-native/session/durable', {
    method: 'POST', cookie, body: { sessionId, turnId: nextTurnId, prompt: 'run after the takeover' },
  })
  assert.equal(nextTurn.status, 202, JSON.stringify(nextTurn.body))
  const nextSettled = await waitSettled(backend.origin, cookie, nextTurnId)
  assert.equal(nextSettled.status, 'completed')
  const events = await request(backend.origin, '/api/browser-native/session/read', { method: 'POST', cookie, body: { sessionId, offset: 0 } })
  assert.equal(events.status, 200, JSON.stringify(events.body))
  const cancellations = events.body.events.filter(event => event.type === 'turn/end' && event.data?.reason?.kind === 'aborted')
  assert.equal(cancellations.length, 1)

  context.diagnostic(JSON.stringify({
    result: 'passed',
    scope: 'durable-lease-takeover-across-writers',
    backend: { pid: backend.pid },
    duringTurn: { openStatus: takeoverDuringTurn.status, code: takeoverDuringTurn.body.error.code, retryAfterMs: takeoverDuringTurn.body.error.retryAfterMs, appendStatus: unownedAppend.status, secondTurnStatus: secondTurn.status, secondTurnCode: secondTurn.body.error.code },
    afterStop: { turnStatus: settled.status, openStatus: takeoverAfterStop.status, ownerEpoch: owner.ownerEpoch },
    nextTurn: { status: nextSettled.status, turn: nextSettled.turn },
    cancellationEvents: cancellations.length,
  }))
})
