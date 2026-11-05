import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * Read the Session and Workspace cookies issued by the identity endpoint.
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
  return { session: pick('dsh-browser-native-session-principal'), workspace: pick('dsh-browser-native-principal'), workspaceId: body.workspaceId }
}

async function request(origin, pathname, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ protocolVersion: 1, requestId: `align-${String(Date.now())}-${String(Math.random())}`, ...body }) }),
  })
  const payload = await response.json()
  return { status: response.status, body: payload }
}

async function sessionEvents(origin, cookie, sessionId) {
  const read = await request(origin, '/api/browser-native/session/read', { method: 'POST', cookie, body: { sessionId, offset: 0 } })
  assert.equal(read.status, 200, JSON.stringify(read.body))
  return read.body.events
}

async function startTurn(origin, cookie, sessionId, turnId, prompt, attachments) {
  return await request(origin, '/api/browser-native/session/durable', {
    method: 'POST',
    cookie,
    body: { sessionId, turnId, prompt, ...(attachments === undefined ? {} : { attachments }) },
  })
}

async function waitForStatus(origin, cookie, turnId, expected, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let current
  while (Date.now() < deadline) {
    const status = await request(origin, `/api/browser-native/session/durable?turnId=${encodeURIComponent(turnId)}`, { cookie })
    assert.equal(status.status, 200, JSON.stringify(status.body))
    current = status.body
    if (current.status === expected) return current
    if (current.status === 'failed' || current.status === 'cancelled') {
      throw new Error(`turn ${turnId} settled as ${current.status}: ${JSON.stringify(current)}`)
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  }
  throw new Error(`turn ${turnId} never reached ${expected}: ${JSON.stringify(current)}`)
}

async function withBackend(options, run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-durable-alignment-'))
  const app = await createBrowserNativeV2Server({ dataDir, llmMode: 'scripted', durableTurnTimeoutMs: 20_000, ...options })
  try {
    const origin = await app.listen(0)
    await run({ app, origin, dataDir })
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

test('durable image attachment reaches the model wire and persists as an ImageBlock', async () => {
  await withBackend({}, async ({ origin, dataDir }) => {
    const identity = await openIdentity(origin)
    const pngBytes = Buffer.from(PNG_BASE64, 'base64')
    const hash = createHash('sha256').update(pngBytes).digest('hex')
    const sessionId = 'durable-image-session'
    const started = await startTurn(origin, identity.session, sessionId, 'durable-image-turn', 'BROWSER_NATIVE_IMAGE_APPLICATION_E2E inspect this image', [{
      hash,
      data: PNG_BASE64,
      mediaType: 'image/png',
      width: 1,
      height: 1,
      name: 'pixel.png',
    }])
    assert.equal(started.status, 202, JSON.stringify(started.body))
    const settled = await waitForStatus(origin, identity.session, 'durable-image-turn', 'completed')
    assert.equal(settled.status, 'completed')

    const events = await sessionEvents(origin, identity.session, sessionId)
    const userEvent = events.find(event => event.type === 'user/message')
    assert.ok(Array.isArray(userEvent.data.content), 'an image turn stores content blocks')
    assert.equal(userEvent.data.content[0].text, 'BROWSER_NATIVE_IMAGE_APPLICATION_E2E inspect this image')
    assert.equal(userEvent.surfaceOp, 'append')
    assert.equal(userEvent.data.role, 'user')
    assert.equal(userEvent.data.source.kind, 'user')
    const imageBlock = userEvent.data.content.find(block => block.type === 'image')
    assert.equal(imageBlock.attachment.attachmentId, `sha256:${hash}`)
    assert.equal(imageBlock.attachment.mediaType, 'image/png')
    assert.equal(imageBlock.attachment.bytes, pngBytes.byteLength)
    assert.equal(imageBlock.attachment.width, 1)
    assert.equal(imageBlock.attachment.height, 1)

    const assistant = events.filter(event => event.type === 'assistant/message')
      .flatMap(event => event.data.message.content).filter(block => block.type === 'text').map(block => block.text).join('')
    assert.match(assistant, new RegExp(`BROWSER_NATIVE_IMAGE_APPLICATION_APPLIED:image/png:${String(pngBytes.byteLength)}:`))

    const attachmentRoot = join(dataDir, 'attachments-v1', identity.workspaceId)
    const files = await readdir(attachmentRoot, { recursive: true, withFileTypes: true })
    const storedPath = files.find(entry => entry.isFile() && entry.name.includes(hash))
    assert.ok(storedPath, 'the attachment bytes must be published into the Workspace attachment store')
    const stored = await readFile(join(storedPath.parentPath, storedPath.name))
    assert.equal(stored.toString('base64'), PNG_BASE64, 'the stored attachment bytes must equal the uploaded image')
  })
})

test('a shared viewer cannot run durable turns and a shared editor can continue the Session', async () => {
  await withBackend({}, async ({ origin }) => {
    const owner = await openIdentity(origin)
    const editor = await openIdentity(origin)
    const viewer = await openIdentity(origin)
    const sessionId = 'durable-share-session'

    const ownerTurn = await startTurn(origin, owner.session, sessionId, 'durable-share-owner', 'DURABLE_SHARING_OWNER')
    assert.equal(ownerTurn.status, 202)
    await waitForStatus(origin, owner.session, 'durable-share-owner', 'completed')

    for (const [principalId, role] of [[editor.session, 'editor'], [viewer.session, 'viewer']]) {
      const grant = await request(origin, `/api/browser-native/session/${sessionId}/share`, {
        method: 'POST',
        cookie: owner.session,
        body: { sessionId, viewerPrincipalId: principalId.split('=').at(-1), role },
      })
      assert.equal(grant.status, 200, JSON.stringify(grant.body))
    }

    const denied = await startTurn(origin, viewer.session, sessionId, 'durable-share-viewer', 'DURABLE_SHARING_VIEWER')
    assert.equal(denied.status, 403)
    assert.equal(denied.body.error.code, 'SESSION_READ_ONLY')

    const editorTurn = await startTurn(origin, editor.session, sessionId, 'durable-share-editor', 'DURABLE_SHARING_EDITOR')
    assert.equal(editorTurn.status, 202, JSON.stringify(editorTurn.body))
    await waitForStatus(origin, editor.session, 'durable-share-editor', 'completed')

    const editorEvents = await sessionEvents(origin, editor.session, sessionId)
    assert.ok(editorEvents.some(event => event.type === 'user/message'
      && JSON.stringify(event.data.content).includes('DURABLE_SHARING_EDITOR')), 'the editor turn must persist')

    const ownerAgain = await startTurn(origin, owner.session, sessionId, 'durable-share-owner-again', 'DURABLE_SHARING_OWNER_AGAIN')
    assert.equal(ownerAgain.status, 202, JSON.stringify(ownerAgain.body))
    await waitForStatus(origin, owner.session, 'durable-share-owner-again', 'completed')
    const final = await sessionEvents(origin, owner.session, sessionId)
    assert.equal(final.filter(event => event.type === 'turn/end').length, 3)
  })
})

test('sixteen durable sessions run concurrently under the sixteen-slot admission limit and stay listed', async () => {
  const gate = Promise.withResolvers()
  const prompts = []
  const appOptions = {
    admission: { maxConcurrentTurns: 16, maxMountedSessions: 16 },
    testHooks: {
      scriptedLlmFault: body => {
        const text = body.messages.find(message => message.role === 'user' && typeof message.content === 'string')?.content ?? ''
        if (!text.startsWith('DURABLE_DASHBOARD_')) return undefined
        prompts.push(text)
        return { kind: 'barrier-text', release: gate.promise, text: `DURABLE_DASHBOARD_DONE:${text}` }
      },
    },
  }
  await withBackend(appOptions, async ({ origin }) => {
    const identity = await openIdentity(origin)
    const sessionIds = Array.from({ length: 16 }, (_, index) => `durable-dashboard-${String(index).padStart(2, '0')}`)
    for (const [index, sessionId] of sessionIds.entries()) {
      const started = await startTurn(origin, identity.session, sessionId, `durable-dashboard-turn-${String(index)}`, `DURABLE_DASHBOARD_${String(index)}`)
      assert.equal(started.status, 202, JSON.stringify(started.body))
    }
    for (const [index] of sessionIds.entries()) {
      await waitForStatus(origin, identity.session, `durable-dashboard-turn-${String(index)}`, 'running')
    }
    const admission = await request(origin, '/api/browser-native/admission', { cookie: identity.session })
    assert.equal(admission.status, 200)
    assert.equal(admission.body.activeTurns, 16, JSON.stringify(admission.body))
    gate.resolve()
    for (const [index] of sessionIds.entries()) {
      await waitForStatus(origin, identity.session, `durable-dashboard-turn-${String(index)}`, 'completed')
    }
    assert.equal(prompts.length, 16)
    const list = await request(origin, '/api/browser-native/session/list', { method: 'POST', cookie: identity.session, body: { limit: 50 } })
    assert.equal(list.status, 200, JSON.stringify(list.body))
    const listed = list.body.items.filter(item => item.sessionId.startsWith('durable-dashboard-'))
    assert.equal(listed.length, 16, JSON.stringify(list.body.items))
    assert.ok(listed.every(item => item.blank === false))
  })
})

test('cross-Session retrieval lists every durable Session and reads its persisted events', async () => {
  await withBackend({}, async ({ origin }) => {
    const identity = await openIdentity(origin)
    const sessionIds = ['durable-retrieval-alpha', 'durable-retrieval-beta']
    for (const [index, sessionId] of sessionIds.entries()) {
      const started = await startTurn(origin, identity.session, sessionId, `durable-retrieval-turn-${String(index)}`, `DURABLE_RETRIEVAL_NEEDLE_${String(index)}`)
      assert.equal(started.status, 202)
      await waitForStatus(origin, identity.session, `durable-retrieval-turn-${String(index)}`, 'completed')
    }
    const list = await request(origin, '/api/browser-native/session/list', { method: 'POST', cookie: identity.session, body: { limit: 5 } })
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.items.map(item => item.sessionId).sort(), sessionIds)
    for (const sessionId of sessionIds) {
      const events = await sessionEvents(origin, identity.session, sessionId)
      const text = events.filter(event => event.type === 'user/message')
        .map(event => JSON.stringify(event.data.content)).join('')
      assert.match(text, /DURABLE_RETRIEVAL_NEEDLE/)
    }
  })
})

test('durable subagents can nest one level below the parent turn', async () => {
  const requests = []
  await withBackend({
    testHooks: {
      scriptedLlmFault: body => {
        const text = body.messages.filter(message => message.role === 'user' && typeof message.content === 'string').at(-1)?.content ?? ''
        const hasSubagent = body.tools?.some(tool => tool.function?.name === 'subagent') === true
        const toolResults = body.messages.filter(message => message.role === 'tool').length
        if (text.includes('DURABLE_NESTED_PARENT')) {
          requests.push({ text, hasSubagent })
          if (toolResults === 0) {
            return {
              kind: 'tool-call',
              call: { id: 'nested-parent-call', name: 'subagent', arguments: { prompt: 'DURABLE_NESTED_CHILD', description: 'nested read' } },
            }
          }
          return { kind: 'text', text: 'DURABLE_NESTED_PARENT_DONE' }
        }
        if (text.includes('DURABLE_NESTED_CHILD')) {
          requests.push({ text, hasSubagent })
          if (toolResults === 0 && hasSubagent) {
            return {
              kind: 'tool-call',
              call: { id: 'nested-child-call', name: 'subagent', arguments: { prompt: 'DURABLE_NESTED_GRANDCHILD', description: 'deep read' } },
            }
          }
          return { kind: 'text', text: 'DURABLE_NESTED_CHILD_DONE' }
        }
        if (text.includes('DURABLE_NESTED_GRANDCHILD')) {
          requests.push({ text, hasSubagent })
          return { kind: 'text', text: 'DURABLE_NESTED_GRANDCHILD_DONE' }
        }
        return undefined
      },
    },
  }, async ({ origin }) => {
    const identity = await openIdentity(origin)
    const sessionId = 'durable-nested-session'
    const started = await startTurn(origin, identity.session, sessionId, 'durable-nested-turn', 'DURABLE_NESTED_PARENT')
    assert.equal(started.status, 202)
    await waitForStatus(origin, identity.session, 'durable-nested-turn', 'completed')
    assert.equal(requests.length, 5, JSON.stringify(requests))
    assert.deepEqual(requests.map(request => request.hasSubagent), [true, true, false, true, true],
      'the parent and first child advertise subagent; the grandchild does not')
    const events = await sessionEvents(origin, identity.session, sessionId)
    const finalText = events.filter(event => event.type === 'assistant/message')
      .flatMap(event => event.data.message.content).filter(block => block.type === 'text').map(block => block.text).join('')
    assert.match(finalText, /DURABLE_NESTED_PARENT_DONE/)
    const subagentResult = events.find(event => event.type === 'tool/result' && event.data.message?.toolCallId === 'nested-parent-call')
    assert.ok(subagentResult, 'the parent must record the child result')
    assert.match(subagentResult.data.message.content[0].text, /DURABLE_NESTED_CHILD_DONE/)
  })
})

test('an archived Session reopens for a durable turn with its history intact', async () => {
  await withBackend({}, async ({ app, origin }) => {
    const identity = await openIdentity(origin)
    const sessionId = 'durable-archive-session'
    const first = await startTurn(origin, identity.session, sessionId, 'durable-archive-first', 'DURABLE_ARCHIVE_BEFORE')
    assert.equal(first.status, 202)
    await waitForStatus(origin, identity.session, 'durable-archive-first', 'completed')
    const archived = await request(origin, '/api/browser-native/admin/session/archive', {
      method: 'POST',
      body: { sessionIds: [sessionId] },
    })
    assert.equal(archived.status, 200, JSON.stringify(archived.body))
    assert.equal(archived.body.archived[0].sessionId, sessionId)
    assert.ok(app.store.archived.has(sessionId))

    const second = await startTurn(origin, identity.session, sessionId, 'durable-archive-second', 'DURABLE_ARCHIVE_AFTER')
    assert.equal(second.status, 202, JSON.stringify(second.body))
    await waitForStatus(origin, identity.session, 'durable-archive-second', 'completed')
    const events = await sessionEvents(origin, identity.session, sessionId)
    const content = events.filter(event => event.type === 'user/message').map(event => JSON.stringify(event.data.content)).join('')
    assert.match(content, /DURABLE_ARCHIVE_BEFORE/)
    assert.match(content, /DURABLE_ARCHIVE_AFTER/)
    assert.equal(events.filter(event => event.type === 'turn/end').length, 2)
    assert.ok(app.store.sessions.has(sessionId), 'the reopened Session is active again')
  })
})
