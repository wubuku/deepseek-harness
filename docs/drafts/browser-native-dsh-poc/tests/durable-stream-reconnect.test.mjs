import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

async function openIdentity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const cookie = response.headers.getSetCookie()
    .find(value => value.startsWith('dsh-browser-native-session-principal='))
  assert.ok(cookie)
  return cookie.split(';')[0]
}

function deferred() {
  let resolvePromise
  const promise = new Promise(resolveRelease => { resolvePromise = resolveRelease })
  return { promise, resolve: resolvePromise }
}

/**
 * Read NDJSON stream frames until the predicate or the stream ends.
 * @param {Response} response - Streaming response.
 * @param {(frame: object) => boolean} until - Stop condition.
 * @returns {Promise<object[]>} Parsed frames.
 */
async function readFrames(response, until = () => false) {
  assert.equal(response.status, 200)
  const frames = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        const frame = JSON.parse(line)
        frames.push(frame)
        if (until(frame)) return frames
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return frames
}

test('a dropped durable stream resumes at the next sequence without replaying the prompt', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-stream-resume-'))
  const release = deferred()
  let modelRequests = 0
  const app = await createBrowserNativeV2Server({
    dataDir,
    llmMode: 'scripted',
    durableTurnTimeoutMs: 20_000,
    testHooks: {
      scriptedLlmFault: body => {
        if (body.purpose !== undefined) return undefined
        modelRequests += 1
        return { kind: 'barrier-text', text: 'STREAM_RESUME_OK', release: release.promise }
      },
    },
  })
  try {
    const origin = await app.listen(0)
    const cookie = await openIdentity(origin)
    const started = await fetch(`${origin}/api/browser-native/session/durable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ protocolVersion: 1, requestId: 'resume-1', sessionId: 'resume-session', turnId: 'resume-turn', prompt: 'STREAM_RESUME_PROMPT' }),
    })
    assert.equal(started.status, 202)

    const first = await fetch(`${origin}/api/browser-native/session/durable/stream?turnId=resume-turn&fromSeq=0`, { headers: { cookie } })
    const firstFrames = await readFrames(first, frame => frame.kind === 'event' && frame.seq === 2)
    const lastSeq = firstFrames.at(-1).seq
    assert.equal(lastSeq, 2)

    // The resume request must be in flight before the barrier lifts; waiting
    // for its headers would deadlock because no event is written until then.
    const secondPromise = fetch(`${origin}/api/browser-native/session/durable/stream?turnId=resume-turn&fromSeq=${lastSeq + 1}`, { headers: { cookie } })
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200))
    release.resolve()
    const second = await secondPromise
    assert.equal(second.status, 200)
    const secondFrames = await readFrames(second)
    const resumedEvents = secondFrames.filter(frame => frame.kind === 'event')
    assert.equal(resumedEvents[0].seq, lastSeq + 1, 'resume must start at the next sequence')
    for (let index = 1; index < resumedEvents.length; index += 1) {
      assert.equal(resumedEvents[index].seq, resumedEvents[index - 1].seq + 1, 'resumed events must be contiguous')
    }
    const settled = secondFrames.at(-1)
    assert.equal(settled.kind, 'settled')
    assert.equal(settled.status, 'completed')

    const full = await fetch(`${origin}/api/browser-native/session/durable/stream?turnId=resume-turn&fromSeq=0`, { headers: { cookie } })
    const allEvents = (await readFrames(full)).filter(frame => frame.kind === 'event')
    assert.equal(allEvents.filter(frame => frame.type === 'user/message').length, 1, 'the prompt must be persisted once')
    assert.equal(allEvents.filter(frame => frame.type === 'turn/start').length, 1)
    assert.equal(modelRequests, 1, 'resuming the stream must not re-run the model')
    assert.equal(allEvents.at(-1).type, 'turn/end')

    const gap = await fetch(`${origin}/api/browser-native/session/durable/stream?turnId=resume-turn&fromSeq=${allEvents.at(-1).seq + 3}`, { headers: { cookie } })
    assert.equal(gap.status, 409)
    const gapBody = await gap.json()
    assert.equal(gapBody.error.code, 'DURABLE_STREAM_GAP')
    assert.match(gapBody.error.message, /skips sequence/)
  } finally {
    release.resolve()
    await app.close().catch(() => {})
    await rm(dataDir, { recursive: true, force: true })
  }
})
