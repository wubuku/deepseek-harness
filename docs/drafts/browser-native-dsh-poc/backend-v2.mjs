/**
 * Backend for the browser-native DSH v2 PoC.
 *
 * It serves the already-built DSH preview surface, stores formal Session
 * headers/events, and proxies the Worker-side LLM adapter to a scripted model
 * or an OpenAI-compatible upstream. Credentials are loaded only in this Node
 * process and are never included in responses or logs.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { relative, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PROTOCOL_VERSION = 1
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_EVENTS = 100_000

class BackendError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'BackendError'
    this.code = code
    this.status = status
  }
}

function clone(value) {
  return structuredClone(value)
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)
}

function assertSessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value) || value.length === 0 || value.length > 200) {
    throw new BackendError('INVALID_REQUEST', 'session id is invalid')
  }
  return value
}

function assertRecord(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BackendError('INVALID_REQUEST', `${name} must be an object`)
  }
  return value
}

function assertProtocol(body) {
  assertRecord(body, 'request')
  if (body.protocolVersion !== PROTOCOL_VERSION) throw new BackendError('PROTOCOL_UNSUPPORTED', 'unsupported browser-native protocol')
  if (typeof body.requestId !== 'string' || body.requestId.length === 0) throw new BackendError('INVALID_REQUEST', 'requestId is required')
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new BackendError('REQUEST_TOO_LARGE', 'request body is too large', 413)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BackendError('INVALID_REQUEST', 'request body is not valid JSON')
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-browser-native-protocol': String(PROTOCOL_VERSION),
  })
  response.end(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...body }))
}

function sendError(response, error) {
  const detail = error instanceof BackendError
    ? error
    : new BackendError('INTERNAL', 'browser-native backend failed', 500)
  sendJson(response, detail.status, { error: { code: detail.code, message: detail.message } })
}

function revisionOf(session) {
  return `remote-${digest(`${session.id}:${session.events.length}:${session.durableThroughSeq}`)}`
}

class FormalSessionStore {
  constructor(dataDir) {
    this.root = resolve(dataDir)
    this.sessionsDir = join(this.root, 'sessions')
    this.sessions = new Map()
    this.locks = new Map()
  }

  async load() {
    await mkdir(this.sessionsDir, { recursive: true })
    for (const entry of await readdir(this.sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const raw = JSON.parse(await readFile(join(this.sessionsDir, entry.name), 'utf8'))
      const id = assertSessionId(raw.id)
      if (raw.header?.id !== id || !Array.isArray(raw.events)) continue
      this.sessions.set(id, {
        id,
        header: clone(raw.header),
        inheritedEventCount: raw.inheritedEventCount ?? 0,
        events: clone(raw.events),
        durableThroughSeq: raw.durableThroughSeq ?? raw.events.length - 1,
        ownerToken: undefined,
      })
    }
  }

  async exclusive(id, operation) {
    const previous = this.locks.get(id) ?? Promise.resolve()
    let release
    const current = new Promise(resolveRelease => { release = resolveRelease })
    this.locks.set(id, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.locks.get(id) === current) this.locks.delete(id)
    }
  }

  get(id) {
    const session = this.sessions.get(assertSessionId(id))
    if (session === undefined) throw new BackendError('SESSION_NOT_FOUND', 'session does not exist', 404)
    return session
  }

  create(id, header, inheritedEventCount) {
    if (this.sessions.has(id)) throw new BackendError('SESSION_ALREADY_EXISTS', 'session already exists', 409)
    if (header.id !== id) throw new BackendError('INVALID_REQUEST', 'header id does not match session id')
    const session = {
      id,
      header: clone(header),
      inheritedEventCount,
      events: [],
      durableThroughSeq: -1,
      ownerToken: undefined,
    }
    this.sessions.set(id, session)
    return session
  }

  claim(session) {
    if (session.ownerToken !== undefined) throw new BackendError('SESSION_ALREADY_OWNED', 'session is already owned', 409)
    session.ownerToken = randomUUID()
    return { ownerToken: session.ownerToken }
  }

  assertOwner(session, ownerToken) {
    if (typeof ownerToken !== 'string' || session.ownerToken !== ownerToken) {
      throw new BackendError('SESSION_OWNERSHIP_LOST', 'session write ownership is no longer valid', 409)
    }
  }

  async flush(session) {
    const target = join(this.sessionsDir, `${session.id}.json`)
    const temporary = `${target}.${randomUUID()}.tmp`
    const record = {
      id: session.id,
      header: session.header,
      inheritedEventCount: session.inheritedEventCount,
      events: session.events,
      durableThroughSeq: session.events.length - 1,
    }
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, 'utf8')
      const file = await open(temporary, 'r+')
      try { await file.sync() } finally { await file.close() }
      await rename(temporary, target)
      const directory = await open(this.sessionsDir, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) {
      await rm(temporary, { force: true })
      throw new BackendError('DURABILITY_FAILED', `Session flush failed: ${String(error)}`, 503)
    }
    session.durableThroughSeq = record.durableThroughSeq
    return `durable-${session.id}-${session.durableThroughSeq}`
  }

  snapshot(session) {
    return {
      header: clone(session.header),
      revision: revisionOf(session),
      eventCount: session.events.length,
    }
  }
}

function ownerResponse(session) {
  return session.ownerToken === undefined ? {} : { owner: { ownerToken: session.ownerToken } }
}

function sessionResponse(session, extra = {}, includeOwner = false) {
  return {
    sessionId: session.id,
    header: clone(session.header),
    inheritedEventCount: session.inheritedEventCount,
    nextSeq: session.events.length,
    revision: revisionOf(session),
    ...(includeOwner ? ownerResponse(session) : {}),
    ...extra,
  }
}

async function sessionOperation(store, operation, body) {
  assertProtocol(body)
  if (operation === 'list') {
    return store.exclusive('__list__', async () => ({ snapshots: [...store.sessions.values()].map(session => store.snapshot(session)) }))
  }
  const id = assertSessionId(body.sessionId)
  return store.exclusive(id, async () => {
    if (operation === 'create') {
      const session = store.create(id, assertRecord(body.header, 'header'), body.inheritedEventCount ?? 0)
      const owner = store.claim(session)
      return sessionResponse(session, { owner }, true)
    }
    const session = store.get(id)
    if (operation === 'open') {
      if (body.access !== 'read' && body.access !== 'write') throw new BackendError('INVALID_REQUEST', 'access must be read or write')
      if (body.access === 'write') store.claim(session)
      return sessionResponse(session, {}, body.access === 'write')
    }
    if (operation === 'stat') return sessionResponse(session)
    if (operation === 'read') {
      const offset = body.offset ?? 0
      const length = body.length ?? Number.MAX_SAFE_INTEGER
      return sessionResponse(session, {
        events: clone(session.events.slice(offset, offset + length)),
        eventState: 'shared-frozen',
      })
    }
    store.assertOwner(session, body.ownerToken)
    if (operation === 'append') {
      if (body.expectedNextSeq !== session.events.length || !Array.isArray(body.events)) {
        throw new BackendError('SEQ_CONFLICT', 'append does not continue the visible log', 409)
      }
      if (session.events.length + body.events.length > MAX_EVENTS) throw new BackendError('REQUEST_TOO_LARGE', 'Session event limit exceeded', 413)
      body.events.forEach((event, index) => {
        if (event === null || typeof event !== 'object' || event.seq !== body.expectedNextSeq + index) {
          throw new BackendError('SEQ_CONFLICT', 'event sequence is not contiguous', 409)
        }
      })
      session.events.push(...clone(body.events))
      return sessionResponse(session, { acceptedCount: body.events.length })
    }
    if (operation === 'flush') {
      const durabilityReceipt = await store.flush(session)
      return sessionResponse(session, { durable: true, durabilityReceipt, durableThroughSeq: session.durableThroughSeq })
    }
    if (operation === 'close') {
      const durabilityReceipt = session.durableThroughSeq < session.events.length - 1
        ? await store.flush(session)
        : undefined
      session.ownerToken = undefined
      return sessionResponse(session, { closed: true, ...(durabilityReceipt === undefined ? {} : { durabilityReceipt }) })
    }
    throw new BackendError('INVALID_REQUEST', `unknown Session operation: ${operation}`)
  })
}

function parseDotEnv(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match === null) continue
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return values
}

async function loadEnv(envFile) {
  const values = { ...process.env }
  if (envFile === undefined) return values
  try {
    Object.assign(values, parseDotEnv(await readFile(envFile, 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return values
}

async function createLlmConfig(options) {
  const mode = options.llmMode ?? 'scripted'
  if (mode === 'scripted') return { mode, model: 'browser-native-scripted', provider: 'scripted' }
  if (mode !== 'real') throw new Error(`unsupported LLM mode: ${mode}`)
  const env = await loadEnv(options.envFile)
  const model = options.model ?? env.OPENAI_NEXT_GPT_MODEL
  if (typeof model !== 'string' || model.length === 0) throw new Error('OPENAI_NEXT_GPT_MODEL is required in real mode')
  const grok = model.startsWith('grok-')
  const baseUrl = grok ? (env.OPENAI_NEXT_GROK_BASE_URL ?? env.OPENAI_NEXT_GPT_BASE_URL) : env.OPENAI_NEXT_GPT_BASE_URL
  const path = grok ? (env.OPENAI_NEXT_GROK_COMPLETIONS_PATH ?? env.OPENAI_NEXT_GPT_COMPLETIONS_PATH) : env.OPENAI_NEXT_GPT_COMPLETIONS_PATH
  const apiKey = grok ? env.OPENAI_NEXT_GROK_API_KEY : env.OPENAI_NEXT_GPT_API_KEY
  if (!baseUrl || !path || !apiKey) throw new Error('real LLM mode needs the configured OpenAI Next base URL, completions path, model, and API key')
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (proxy?.startsWith('socks')) throw new Error('real LLM mode needs an HTTP(S) proxy; SOCKS proxy support is not implemented in this PoC')
  return {
    mode,
    model,
    provider: grok ? 'grok' : 'gpt',
    url: new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString(),
    apiKey,
    proxyConfigured: proxy !== undefined,
  }
}

function textContent(messages) {
  const texts = messages
    .filter(message => message.role === 'user' && typeof message.content === 'string')
    .map(message => message.content)
  const last = texts.at(-1)
  if (last?.startsWith('Generate the session title from this JSON array:')) return 'Browser-native DSH session'
  return [...texts].reverse().find(text => !text.startsWith('Current runtime context.')) ?? last ?? 'the current request'
}

function writeStream(response, item) {
  if (!response.destroyed) response.write(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...item })}\n`)
}

async function scriptedLlm(response, messages) {
  const text = `Browser-native DSH completed this turn: ${textContent(messages).slice(0, 240)}`
  writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
  for (const part of text.match(/.{1,32}/g) ?? []) {
    writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text: part } })
  }
  writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
  writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } })
  response.end()
}

async function realLlm(response, request, config, body) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  request.on('aborted', abort)
  response.on('close', abort)
  const upstream = await fetch(config.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${config.apiKey}`,
      'user-agent': 'deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)',
    },
    body: JSON.stringify({
      model: config.model,
      messages: body.messages,
      tools: body.tools,
      temperature: body.temperature,
      max_tokens: body.maxTokens,
      reasoning_effort: body.reasoningEffort,
      stream: true,
    }),
    signal: controller.signal,
  })
  if (!upstream.ok || upstream.body === null) {
    throw new BackendError('UPSTREAM_LLM_FAILED', `upstream LLM returned HTTP ${upstream.status}`, 502)
  }
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-browser-native-protocol': String(PROTOCOL_VERSION),
  })
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let toolCall
  let started = false
  const consume = data => {
    if (data === '[DONE]') return true
    const item = JSON.parse(data)
    const delta = item.choices?.[0]?.delta
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      if (!started) {
        started = true
        writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
      }
      text += delta.content
      writeStream(response, { kind: 'chunk', chunk: { type: 'text-delta', index: 0, text: delta.content } })
    }
    const providerCall = delta?.tool_calls?.[0]
    if (providerCall !== undefined) {
      if (!started) {
        started = true
        toolCall = { id: providerCall.id ?? randomUUID(), name: providerCall.function?.name ?? '', arguments: '' }
        writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } })
      }
      if (providerCall.function?.arguments) {
        toolCall.arguments += providerCall.function.arguments
        writeStream(response, { kind: 'chunk', chunk: { type: 'tool-call-delta', index: 0, id: toolCall.id, name: toolCall.name, argumentsDelta: providerCall.function.arguments } })
      }
    }
    const finish = item.choices?.[0]?.finish_reason
    if (finish !== undefined && finish !== null) {
      if (toolCall !== undefined) {
        writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'tool-call', ...toolCall } } })
        writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: { kind: 'tool-calls' } } })
      } else {
        if (!started) {
          started = true
          writeStream(response, { kind: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
        }
        writeStream(response, { kind: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
        writeStream(response, { kind: 'chunk', chunk: { type: 'finish', reason: finish === 'length' ? { kind: 'max-tokens' } : { kind: 'stop' } } })
      }
      return true
    }
    return false
  }
  try {
    while (true) {
      const part = await reader.read()
      buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:') && consume(line.slice(5).trim())) {
          response.end()
          return
        }
        newline = buffer.indexOf('\n')
      }
      if (part.done) break
    }
    if (!response.writableEnded) response.end()
  } finally {
    request.off('aborted', abort)
    response.off('close', abort)
  }
}

function safeStaticPath(root, pathname) {
  const relativePath = pathname === '/' ? 'preview.html' : pathname.slice(1)
  const file = resolve(root, relativePath)
  if (relative(root, file).startsWith('..')) throw new BackendError('NOT_FOUND', 'file not found', 404)
  return file
}

async function serveStatic(response, root, pathname) {
  let body
  try {
    body = await readFile(safeStaticPath(root, pathname))
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EISDIR') throw new BackendError('NOT_FOUND', 'file not found', 404)
    throw error
  }
  const file = pathname.toLowerCase()
  const contentType = file.endsWith('.html') ? 'text/html; charset=utf-8'
    : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.json') ? 'application/json; charset=utf-8'
          : file.endsWith('.gz') ? 'application/gzip'
            : 'application/octet-stream'
  response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
  response.end(body)
}

export async function createBrowserNativeV2Server(options) {
  const store = new FormalSessionStore(options.dataDir)
  await store.load()
  const llm = await createLlmConfig(options)
  const distRoot = resolve(options.distRoot ?? join(HERE, '../../../apps/web/dist'))
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://browser-native.invalid')
      if (request.method === 'GET' && url.pathname === '/api/browser-native/health') {
        sendJson(response, 200, { ok: true, llmMode: llm.mode, model: llm.model })
        return
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/browser-native/session/')) {
        const operation = url.pathname.split('/').at(-1)
        const body = await readBody(request)
        sendJson(response, 200, await sessionOperation(store, operation, body))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/browser-native/llm') {
        const body = await readBody(request)
        assertProtocol(body)
        if (!Array.isArray(body.messages)) throw new BackendError('INVALID_REQUEST', 'messages must be an array')
        if (body.sessionId !== undefined) {
          const session = store.get(body.sessionId)
          store.assertOwner(session, body.ownerToken)
        }
        if (llm.mode === 'scripted') {
          response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
          await scriptedLlm(response, body.messages)
        } else {
          await realLlm(response, request, llm, body)
        }
        return
      }
      if (request.method === 'GET') {
        await serveStatic(response, distRoot, url.pathname)
        return
      }
      throw new BackendError('NOT_FOUND', 'route not found', 404)
    } catch (error) {
      if (!response.headersSent) sendError(response, error)
      else response.destroy()
    }
  })
  return {
    server,
    store,
    llm,
    listen: (port = options.port ?? 4175, host = options.host ?? '127.0.0.1') => new Promise((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolveListen(`http://${host}:${port}`)
      })
    }),
    close: async () => {
      await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
    },
  }
}
