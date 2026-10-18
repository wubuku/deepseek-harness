import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createBrowserNativeV2Server } from '../browser-native-dsh-poc/backend-v2.mjs'
import { BusinessError, applyOperation, fixture, operationSchema } from './src/domain.ts'

/** Persist the mock business database separately from DSH Session data. */
export async function createComparisonServer(options) {
  await mkdir(options.dataDir, { recursive: true })
  const file = resolve(options.dataDir, 'saas.json')
  let database
  try { database = JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error; database = {} }
  let transaction = Promise.resolve()
  const app = await createBrowserNativeV2Server(options)
  const [original] = app.server.listeners('request')
  app.server.removeListener('request', original)
  const metrics = { modelRequests: 0, businessPosts: 0 }
  app.server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/api/browser-native/llm') metrics.modelRequests += 1
    if (!url.pathname.startsWith('/api/saas/')) {
      if (options.llmMode === 'scripted' && url.pathname === '/api/browser-native/llm') {
        void scripted(request, response, app).catch(error => send(response, 400, { error: String(error) }))
      } else original(request, response)
      return
    }
    void (async () => {
      const [, , , workspaceId, resource, operationId] = url.pathname.split('/')
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(workspaceId ?? '')) throw new BusinessError('INVALID_WORKSPACE', 'workspace id 不合法')
      if (request.method === 'GET') {
        await transaction
        const workspace = database[workspaceId] ?? fixture()
        if (resource === 'snapshot') send(response, 200, { ...workspace, metrics })
        else if (resource === 'receipts') {
          const receipt = workspace.receipts[decodeURIComponent(operationId ?? '')]?.receipt
          if (receipt === undefined) throw new BusinessError('NOT_FOUND', '未找到业务凭据', 404)
          send(response, 200, receipt)
        } else throw new BusinessError('NOT_FOUND', 'API 不存在', 404)
        return
      }
      if (request.method !== 'POST' || resource !== 'operations') throw new BusinessError('NOT_FOUND', 'API 不存在', 404)
      const input = operationSchema.parse(await body(request))
      metrics.businessPosts += 1
      const work = transaction.then(async () => {
        const draft = structuredClone(database)
        const workspace = draft[workspaceId] ??= fixture()
        const result = applyOperation(workspace, input, request.headers['x-mock-role'])
        await writeFile(`${file}.next`, JSON.stringify(draft))
        await rename(`${file}.next`, file)
        database = draft
        return result
      })
      transaction = work.then(() => {}, () => {})
      const receipt = await work
      if (options.testHooks?.dropBusinessResponse && request.headers['x-poc-drop-response'] === 'once') response.destroy()
      else send(response, 200, receipt)
    })().catch(error => send(response, error instanceof BusinessError ? error.status : 400, { ok: false, code: error.code ?? 'INVALID_REQUEST', error: error.message }))
  })
  return app
}

function send(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function body(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_000_000) throw new Error('request too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function scripted(request, response, app) {
  const input = await body(request)
  if (input.sessionId !== undefined) app.store.assertOwner(app.store.get(input.sessionId), input.ownerToken)
  const messages = input.messages
  const lastUser = messages.findLastIndex(message => message.role === 'user' && typeof message.content === 'string' && !message.content.startsWith('Current runtime context.'))
  const text = messages[lastUser]?.content ?? ''
  const later = messages.slice(lastUser + 1)
  const completed = later.some(message => message.role === 'tool')
  const name = text.startsWith('Generate the session title') ? undefined : text.includes('账单') ? 'saas_approve_invoice' : text.includes('工单') ? 'saas_update_ticket' : text.includes('任务') ? 'saas_create_task' : undefined
  const args = name === 'saas_create_task' ? { title: '比较实验任务', assignee: '林悦', priority: 'high' }
    : name === 'saas_update_ticket' ? { id: 'TICKET-42', assignee: '周宁', priority: 'high', status: 'in_progress', expectedVersion: 1 }
    : { id: 'INV-2026-018', expectedVersion: 1 }
  response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
  const chunk = value => response.write(`${JSON.stringify({ kind: 'chunk', chunk: value })}\n`)
  if (name !== undefined && !completed) {
    const block = { type: 'tool-call', id: `call-${crypto.randomUUID()}`, name, arguments: JSON.stringify(args) }
    chunk({ type: 'block-start', index: 0, blockType: 'tool-call' })
    chunk({ type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments })
    chunk({ type: 'block-end', index: 0, block })
    chunk({ type: 'finish', reason: { kind: 'tool-calls' } })
  } else {
    const output = text.includes('之前告诉你的验收代号') ? '橙色海豚'
      : completed ? `业务操作结果已记录。${JSON.stringify(later.filter(message => message.role === 'tool').map(message => message.content))}`
        : `收到：${text}。这是同一 DSH Session 的流式回复。`
    chunk({ type: 'block-start', index: 0, blockType: 'text' })
    for (const part of output.match(/.{1,16}/gs) ?? []) {
      chunk({ type: 'text-delta', index: 0, text: part })
      await new Promise(resolveDelay => setTimeout(resolveDelay, 15))
    }
    chunk({ type: 'block-end', index: 0, block: { type: 'text', text: output } })
    chunk({ type: 'finish', reason: { kind: 'stop' } })
  }
  response.end()
}
