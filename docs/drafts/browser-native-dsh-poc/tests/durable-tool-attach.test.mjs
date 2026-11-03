import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

/**
 * Read both principal cookies and the workspace id issued by the identity endpoint.
 * @param {string} origin - Loopback server origin.
 * @returns {Promise<{session: string, workspace: string, workspaceId: string}>} Cookies and Workspace identity.
 */
async function openIdentity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const body = await response.json()
  const cookies = response.headers.getSetCookie()
  const pick = name => {
    const cookie = cookies.find(value => value.startsWith(`${name}=`))
    assert.ok(cookie, `identity must issue ${name}`)
    return cookie.split(';')[0]
  }
  return {
    session: pick('dsh-browser-native-session-principal'),
    workspace: pick('dsh-browser-native-principal'),
    workspaceId: body.workspaceId,
  }
}

async function request(origin, pathname, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ protocolVersion: 1, requestId: `attach-${String(Date.now())}`, ...body }) }),
  })
  const payload = await response.json()
  return { status: response.status, body: payload }
}

async function sessionEvents(origin, cookie, sessionId) {
  const read = await request(origin, '/api/browser-native/session/read', {
    method: 'POST',
    cookie,
    body: { sessionId, offset: 0 },
  })
  assert.equal(read.status, 200, JSON.stringify(read.body))
  return read.body.events
}

/**
 * Collect every NDJSON line the attach endpoint writes until it closes.
 * @param {string} origin - Loopback server origin.
 * @param {string} cookie - Session principal cookie.
 * @param {{turnId: string, fromSeq: number}} query - Turn and first sequence to attach from.
 * @returns {Promise<{events: object[], settled: object}>} Streamed events and the final settlement line.
 */
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
  const events = lines.filter(line => line.kind === 'event').map(line => ({ seq: line.seq, type: line.type, data: line.data }))
  const settled = lines.find(line => line.kind === 'settled')
  assert.ok(settled, 'the attach stream must end with a settled line')
  return { events, settled }
}

test('durable turn executes tools after the page stops reading and a reopened tab can attach mid-stream', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-durable-tools-'))
  const gate = Promise.withResolvers()
  const modelRequests = []
  const app = await createBrowserNativeV2Server({
    dataDir,
    llmMode: 'scripted',
    durableTurnTimeoutMs: 20_000,
    testHooks: {
      scriptedLlmFault: body => {
        const roles = body.messages.map(message => message.role)
        modelRequests.push(roles.join(','))
        const toolMessages = body.messages.filter(message => message.role === 'tool')
        if (toolMessages.length === 0) {
          return {
            kind: 'tool-call',
            call: {
              id: 'durable-call-1',
              name: 'write',
              arguments: { file_path: '/dsh/home/workspace/durable/tool-note.txt', content: 'written after the page stopped reading' },
            },
          }
        }
        if (toolMessages.length === 1) {
          return {
            kind: 'tool-call',
            call: {
              id: 'durable-call-2',
              name: 'read',
              arguments: { file_path: 'durable/tool-note.txt' },
            },
          }
        }
        return { kind: 'barrier-text', release: gate.promise, text: 'DURABLE_TOOL_ATTACH_DONE' }
      },
    },
  })
  let origin
  try {
    origin = await app.listen(0)
    const first = await openIdentity(origin)
    const sessionId = 'durable-tool-session'
    const started = await request(origin, '/api/browser-native/session/durable', {
      method: 'POST',
      cookie: first.session,
      body: { sessionId, turnId: 'durable-tool-turn-1', prompt: 'DURABLE_TOOL_ATTACH: write then read a note.' },
    })
    assert.equal(started.status, 202, JSON.stringify(started.body))

    await request(origin, '/api/browser-native/session/durable/approve', {
      method: 'POST',
      cookie: first.session,
      body: await (async () => {
        for (let attempt = 0; attempt < 300; attempt += 1) {
          const status = await request(origin, '/api/browser-native/session/durable?turnId=durable-tool-turn-1', { cookie: first.session })
          if (status.body.pendingApproval !== undefined) {
            return { turnId: 'durable-tool-turn-1', approvalId: status.body.pendingApproval.approvalId, decision: 'approve' }
          }
          await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
        }
        throw new Error(`the durable write never requested approval: ${JSON.stringify(await request(origin, '/api/browser-native/session/durable?turnId=durable-tool-turn-1', { cookie: first.session }))}`)
      })(),
    })

    let beforeAttach = []
    for (let attempt = 0; attempt < 400; attempt += 1) {
      beforeAttach = await sessionEvents(origin, first.session, sessionId)
      const toolResults = beforeAttach.filter(event => event.type === 'tool/result')
      if (toolResults.length >= 2 && beforeAttach.at(-1).type === 'step/start' && beforeAttach.at(-1).data.step === 3) break
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
    }
    const toolEvents = beforeAttach.filter(event => event.type === 'tool/result')
    assert.equal(toolEvents.length, 2, `both tools must finish on the backend while no client reads the turn: ${JSON.stringify({ events: beforeAttach.map(event => [event.seq, event.type, event.data?.reason ?? event.data?.message?.content ?? event.data?.callId ?? null]), modelRequests })}`)
    assert.equal(beforeAttach.at(-1).type, 'step/start', JSON.stringify(beforeAttach))
    assert.equal(beforeAttach.at(-1).data.step, 3)
    assert.ok(beforeAttach.some(event => event.type === 'tool/call' && event.data.callId === 'durable-call-1'))
    assert.ok(beforeAttach.some(event => event.type === 'tool/result' && event.data.message.toolCallId === 'durable-call-2'))
    assert.equal(toolEvents[0].data.message.content[0].text, 'wrote durable/tool-note.txt (38 bytes)')
    assert.equal(toolEvents[1].data.message.content[0].text, 'written after the page stopped reading')

    const manifest = await request(origin, `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${first.workspaceId}`, {
      cookie: first.workspace,
    })
    assert.equal(manifest.status, 200, JSON.stringify(manifest.body))
    const entry = manifest.body.entries.find(candidate => candidate.path === 'durable/tool-note.txt')
    assert.ok(entry, 'the durable write tool must commit the file')
    const bytes = await app.workspaces.getBlob({ headers: { cookie: first.workspace } }, first.workspaceId, entry.hash)
    assert.equal(bytes.toString('utf8'), 'written after the page stopped reading')

    const writeAttemptDuringRun = await request(origin, '/api/browser-native/session/open', {
      method: 'POST',
      cookie: first.session,
      body: { sessionId, access: 'write' },
    })
    assert.equal(writeAttemptDuringRun.status, 409)
    assert.equal(writeAttemptDuringRun.body.error.code, 'SESSION_ALREADY_OWNED')

    const foreign = await openIdentity(origin)
    const foreignAttach = await fetch(`${origin}/api/browser-native/session/durable/stream?turnId=durable-tool-turn-1&fromSeq=0`, {
      headers: { cookie: foreign.session },
    })
    assert.equal(foreignAttach.status, 404)
    assert.equal((await foreignAttach.json()).error.code, 'TURN_NOT_FOUND')

    const attachFromZero = collectAttach(origin, first.session, { turnId: 'durable-tool-turn-1', fromSeq: 0 })
    const attachFromNine = collectAttach(origin, first.session, { turnId: 'durable-tool-turn-1', fromSeq: 9 })
    gate.resolve()
    const [full, late] = await Promise.all([attachFromZero, attachFromNine])

    assert.equal(full.settled.status, 'completed', JSON.stringify(full.settled))
    const finalAfterAttach = await sessionEvents(origin, first.session, sessionId)
    assert.equal(full.events.length, beforeAttach.length + 3, `the reopened tab must receive the settled step events: ${JSON.stringify({ streamed: full.events.map(event => event.seq), persisted: finalAfterAttach.map(event => event.seq), settled: full.settled })}`)
    for (const [index, event] of full.events.entries()) assert.equal(event.seq, index, 'streamed sequence numbers must be contiguous')
    assert.deepEqual(full.events.slice(0, beforeAttach.length), beforeAttach, 'the attach stream must replay exactly the persisted events')
    assert.deepEqual(full.events.slice(beforeAttach.length).map(event => event.type), ['assistant/message', 'step/end', 'turn/end'])
    assert.equal(late.events.length, 7, 'a late tab must start at its requested sequence')
    assert.equal(late.events[0].seq, 9, 'the late tab must not receive earlier history')
    assert.deepEqual(late.events.map(event => event.type), [
      'step/end', 'tool/call', 'tool/result', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])

    const final = await sessionEvents(origin, first.session, sessionId)
    assert.deepEqual(final, full.events, 'the attach stream must equal the persisted Session log')
    assert.equal(final.filter(event => event.type === 'tool/result').length, 2)
    assert.equal(final.filter(event => event.type === 'turn/end').length, 1)
    assert.equal(final.at(-1).data.reason.kind, 'completed')

    assert.deepEqual(modelRequests, ['user', 'user,assistant,tool', 'user,assistant,tool,assistant,tool'], 'each step must request the model once')
    const replay = await request(origin, '/api/browser-native/session/durable', {
      method: 'POST',
      cookie: first.session,
      body: { sessionId, turnId: 'durable-tool-turn-1', prompt: 'replay must not run tools again' },
    })
    assert.equal(replay.status, 200)
    assert.equal(replay.body.status, 'completed')
    assert.deepEqual(modelRequests, ['user', 'user,assistant,tool', 'user,assistant,tool,assistant,tool'])

    let takeover
    for (let attempt = 0; attempt < 100; attempt += 1) {
      takeover = await request(origin, '/api/browser-native/session/open', {
        method: 'POST',
        cookie: first.session,
        body: { sessionId, access: 'write' },
      })
      if (takeover.status === 200) break
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
    }
    assert.equal(takeover.status, 200, 'the settled durable turn must release its lease to a reopened tab')

    process.stdout.write(`${JSON.stringify({
      result: 'passed',
      scope: 'durable-tool-attach',
      toolResults: final.filter(event => event.type === 'tool/result').length,
      workspaceBytes: entry.bytes,
      streamedEvents: full.events.length,
      lateTabFirstSeq: late.events[0].seq,
      modelRequests,
      leaseDuringRun: writeAttemptDuringRun.status,
      foreignAttach: foreignAttach.status,
    })}\n`)
  } finally {
    gate.resolve()
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
