import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createBrowserNativeV2Server } from '../../browser-native-dsh-poc/backend-v2.mjs'
import { applyOperation, BusinessError, fixture, operationSchema, persistedWorkspacesSchema } from './domain.ts'

/** Reuse DSH persistence/LLM proxy and add a separate, transaction-serialized mock business API.
 * @param options - Backend paths, model mode and optional test fault injection.
 * @returns An unlistened server with explicit lifecycle and execution counters.
 */
export async function createExperimentServer(options) {
  await mkdir(options.dataDir, { recursive: true })
  const file = resolve(options.dataDir, 'complex-saas.json')
  let database = {}
  try { database = persistedWorkspacesSchema.parse(JSON.parse(await readFile(file, 'utf8'))) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  let transaction = Promise.resolve()
  const app = await createBrowserNativeV2Server(options)
  const [original] = app.server.listeners('request')
  app.server.removeListener('request', original)
  app.metrics = { modelRequests: 0, businessPosts: 0, traces: [] }
  app.failNextModel = false
  app.server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/api/browser-native/llm') {
      app.metrics.modelRequests += 1
      if (app.failNextModel) { app.failNextModel = false; send(response, 502, { error: '实验注入的模型故障' }); return }
      if (options.llmMode === 'scripted') { void scripted(request, response, app, options.testHooks).catch(error => send(response, 400, { error: error.message })); return }
    }
    if (!url.pathname.startsWith('/api/complex/')) { original(request, response); return }
    void (async () => {
      const [, , , workspaceId, resource, operationId] = url.pathname.split('/')
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(workspaceId ?? '')) throw new BusinessError('INVALID_WORKSPACE', '工作区不合法', 400)
      if (request.method === 'GET') {
        await transaction
        const workspace = database[workspaceId] ?? fixture()
        if (resource === 'snapshot') send(response, 200, workspace)
        else if (resource === 'receipts') {
          const receipt = workspace.receipts[decodeURIComponent(operationId ?? '')]?.receipt
          if (!receipt) throw new BusinessError('NOT_FOUND', '业务凭据不存在', 404)
          send(response, 200, receipt)
        } else throw new BusinessError('NOT_FOUND', 'API 不存在', 404)
        return
      }
      if (request.method !== 'POST' || resource !== 'operations') throw new BusinessError('NOT_FOUND', 'API 不存在', 404)
      const input = operationSchema.parse(await body(request))
      app.metrics.businessPosts += 1
      const work = transaction.then(async () => {
        const draft = structuredClone(database)
        const workspace = draft[workspaceId] ??= fixture()
        const receipt = applyOperation(workspace, input, request.headers['x-mock-role'])
        await writeFile(`${file}.next`, JSON.stringify(draft))
        await rename(`${file}.next`, file)
        database = draft
        return receipt
      })
      transaction = work.then(() => {}, () => {})
      const receipt = await work
      if (options.testHooks?.dropResponse && request.headers['x-poc-drop-response'] === 'once') response.destroy()
      else send(response, 200, receipt)
    })().catch(error => send(response, error instanceof BusinessError ? error.status : 400, { ok: false, code: error.code ?? 'INVALID_REQUEST', error: error.message }))
  })
  return app
}

function send(response, status, value) {
  if (response.headersSent) { response.end(); return }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function body(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) { size += chunk.length; if (size > 1_000_000) throw new Error('请求过大'); chunks.push(chunk) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function scripted(request, response, app, hooks) {
  const input = await body(request)
  if (input.sessionId !== undefined) app.store.assertOwner(app.store.get(input.sessionId), input.ownerToken)
  const last = input.messages.findLastIndex(message => message.role === 'user' && typeof message.content === 'string' && !message.content.startsWith('Current runtime context.'))
  const prompt = input.messages[last]?.content ?? ''
  const results = input.messages.slice(last + 1).filter(message => message.role === 'tool').map(message => {
    try { return JSON.parse(message.content) } catch { return { raw: message.content } }
  })
  const previousResults = input.messages.slice(0, last).filter(message => message.role === 'tool').map(message => {
    try { return JSON.parse(message.content) } catch { return { raw: message.content } }
  })
  app.metrics.traces.push({ prompt, tools: input.tools?.map(tool => tool.name), resultCount: results.length })
  const context = results.find(result => result.page)?.context
  const approvedPlan = previousResults.findLast(result => result.approved === true && Array.isArray(result.changes))
  const failed = results.some(result => result.ok === false || JSON.stringify(result).includes('VERSION_CONFLICT'))
  const intent = /批量|组合|多客户|续约方案|确认执行/.test(prompt) ? 'portfolio' : /账单|发票|减免|抵扣|费用/.test(prompt) ? 'billing' : /分配/.test(prompt) ? 'bulk_assign' : /折扣|调整预算/.test(prompt) ? 'quote_patch' : /审核|发送|批准/.test(prompt) ? 'approval' : undefined
  const explicitPortfolioConfirmation = /^(确认执行|确认提交|执行刚才|请直接执行)/.test(prompt.trim())
  const applyAfterApproval = /批准后(?:立即|必须)调用/.test(prompt) && !/等我|等待|不要自行/.test(prompt)
  let name
  let args = {}
  if (intent && !failed) {
    if (!results.length) name = 'page_read'
    else if (intent === 'bulk_assign' && results.length === 1) { name = intent; args = { customerId: context.customerId, ticketIds: context.selected, assignee: '周宁' } }
    else if (intent === 'quote_patch' && results.length === 1) { name = intent; args = { customerId: context.customerId, expectedVersion: context.quote.version, discount: prompt.includes('9%') ? 9 : 8 } }
    else if (intent === 'billing' && results.length === 1) { name = 'billing_review'; args = { customerId: context.customerId, expectedVersion: context.billing.version, creditAmount: /8000/.test(prompt) ? 8000 : 10000, reason: '服务中断补偿' } }
    else if (intent === 'billing' && results.length === 2 && results[1].approved === true) { name = 'billing_apply'; args = { customerId: results[1].customerId, expectedVersion: results[1].expectedVersion, creditAmount: results[1].creditAmount, reason: results[1].reason } }
    else if (intent === 'portfolio' && results.length === 1 && explicitPortfolioConfirmation && approvedPlan?.changes) {
      name = 'portfolio_apply'
      args = { changes: approvedPlan.changes }
    }
    else if (intent === 'portfolio' && results.length === 1) {
      name = 'portfolio_review'
      const changes = Object.entries(context.portfolio ?? {}).map(([customerId, value]) => ({ customerId, expectedVersion: value.quote.version, budget: value.quote.budget, discount: prompt.includes('9%') ? 9 : 8 }))
      args = { changes }
    }
    else if (intent === 'approval') {
      if (results.length === 1) { name = 'ask_user_question'; args = { questions: [{ id: 'renewal', question: '请审核当前客户的续约报价，是否批准？', options: [{ label: '批准' }, { label: '拒绝' }] }] } }
      else if (results.length === 2 && JSON.stringify(results[1]).includes('批准') && /发送/.test(prompt)) name = 'page_read'
      else if (results.length === 3) { name = 'quote_send'; args = { customerId: results[2].context.customerId, expectedVersion: results[2].context.quote.version } }
    } else if (intent === 'portfolio' && results.length === 2 && results[1].changes && (explicitPortfolioConfirmation || applyAfterApproval)) {
      name = 'portfolio_apply'
      args = { changes: results[1].approved === false ? [] : results[1].changes }
    }
  }
  response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
  const chunk = value => response.write(`${JSON.stringify({ kind: 'chunk', chunk: value })}\n`)
  if (name) {
    const block = { type: 'tool-call', id: `call-${crypto.randomUUID()}`, name, arguments: JSON.stringify(args) }
    chunk({ type: 'block-start', index: 0, blockType: 'tool-call' })
    chunk({ type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments })
    chunk({ type: 'block-end', index: 0, block })
    chunk({ type: 'finish', reason: { kind: 'tool-calls' } })
  } else {
    const outcome = results.at(-1)
    const summary = outcome?.ok === false ? `业务操作未完成：${outcome.error ?? outcome.code}。未自动重试。` : outcome?.answers ? `审核结果已记录：${outcome.answers.map(answer => answer.custom ?? answer.selected.join('、')).join('；')}` : outcome?.approved && outcome?.creditAmount !== undefined ? `账单减免审核已记录：¥${outcome.creditAmount}。` : outcome?.kind === 'billing_apply' ? '账单减免已提交，业务凭据已记录。' : outcome?.kind === 'portfolio_apply' ? '批量续约方案已提交，两个客户的业务凭据已记录。' : outcome?.kind === 'send' ? '已发送您批准的报价，发送凭据已记录。' : outcome?.kind === 'patch' ? '报价已更新，保留未指定修改的字段。业务凭据已记录。' : outcome?.kind === 'assign' ? '已将当前选中的工单分配给周宁，其他工单保持不变。' : '当前页面信息已记录。'
    const text = /记得.*代号/.test(prompt) ? '续约验收代号：银杏海鸥。' : results.length ? summary : `收到：${prompt}。\n\n- 读取当前页面和业务数据。\n- 保留人工编辑，只修改指定字段。\n- 等待确认后执行，并提供业务凭据。`
    chunk({ type: 'block-start', index: 0, blockType: 'text' })
    for (const part of text.match(/.{1,12}/gs) ?? []) {
      if (response.destroyed) return
      chunk({ type: 'text-delta', index: 0, text: part })
      await hooks?.afterText?.({ prompt, part })
      await new Promise(resolveDelay => setTimeout(resolveDelay, 12))
    }
    chunk({ type: 'block-end', index: 0, block: { type: 'text', text } })
    chunk({ type: 'finish', reason: { kind: 'stop' } })
  }
  response.end()
}
