import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { createExperimentServer } from '../server.mjs'

const imported = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? join(homedir(), 'node_modules/playwright/index.js'))
const playwright = imported.default ?? imported
const real = process.argv.includes('--real')
const webkit = process.argv.includes('--webkit')
const only = process.argv.find(argument => argument.startsWith('--ui='))?.slice(5)
const root = await mkdtemp(join(tmpdir(), `dsh-complex-${real ? 'real' : 'scripted'}-${webkit ? 'webkit' : 'chrome'}-`))
const artifacts = resolve(root, 'artifacts')
await mkdir(artifacts)
const options = { llmMode: real ? 'real' : 'scripted', dataDir: root, distRoot: resolve(import.meta.dirname, '../../../../../apps/web/dist'), envFile: process.env.DSH_POC_ENV_FILE ?? '/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/.env', testHooks: { dropResponse: true } }
let app = await createExperimentServer(options)
let browser
const outcomes = []
try {
  await app.listen(0, '127.0.0.1')
  const port = app.server.address().port
  const origin = `http://127.0.0.1:${port}`
  browser = await (webkit ? playwright.webkit : playwright.chromium).launch({ headless: true, ...(webkit ? {} : { channel: 'chrome' }) })
  for (const ui of only ? only.split(',') : ['copilot', 'assistant', 'native']) {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
    const page = await context.newPage()
    const pageErrors = []
    const network = []
    const steps = []
    const modelBaseline = app.metrics.modelRequests
    let sent = 0
    let streamingSamples = []
    context.on('request', request => { network.push({ url: request.url(), method: request.method(), body: request.postData() }) })
    page.on('pageerror', error => { pageErrors.push(error.message) })
    const timeout = real ? 240000 : 60000
    page.setDefaultTimeout(timeout)
    const workspace = `experiment-${ui}`
    const snapshot = async () => (await fetch(`${origin}/api/complex/${workspace}/snapshot`)).json()
    async function session() {
      const sessionId = new URL(page.url()).searchParams.get('sessionId')
      const response = await fetch(`${origin}/api/browser-native/session/read`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-browser-native-protocol': '1' }, body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId, offset: 0, length: 50000 }) })
      assert.equal(response.status, 200)
      return response.json()
    }
    async function wait(label, predicate) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (pageErrors.length) throw new Error(pageErrors.join('\n'))
        if (await predicate()) return
        await new Promise(release => setTimeout(release, 100))
      }
      throw new Error(`等待超时：${label}`)
    }
    async function send(text) {
      const before = (await session()).events.at(-1)?.seq ?? -1
      const input = ui === 'copilot' ? page.getByTestId('copilot-chat-textarea') : ui === 'assistant' ? page.getByRole('textbox', { name: '消息', exact: true }) : page.locator('[contenteditable=true]').first()
      if (ui === 'native') {
        await input.click()
        await input.press('ControlOrMeta+A')
        await input.pressSequentially(text)
      } else await input.fill(text)
      if (ui === 'native') await page.getByRole('button', { name: '发送消息', exact: true }).click()
      else await input.press('Enter')
      sent += 1
      return before
    }
    async function finish(before) { await wait('DSH turn/end', async () => (await session()).events.some(event => event.type === 'turn/end' && event.seq > before)) }
    async function exchange(text) { const before = await send(text); await finish(before) }
    async function record(name) { steps.push({ name, writes: (await snapshot()).writes, events: (await session()).events.length }); console.log(`${ui}: ${name}`) }
    const activeReview = () => page.getByTestId('review-card').filter({ has: page.getByRole('button', { name: '批准当前版本', exact: true }) }).last()
    async function post(input, role = 'editor', headers = {}) {
      const response = await fetch(`${origin}/api/complex/${workspace}/operations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mock-role': role, ...headers }, body: JSON.stringify(input) })
      return { status: response.status, value: await response.json() }
    }
    try {
      await page.goto(`${origin}/saas-agentic-ui-comparison-poc/complex/index.html?ui=${ui}&workspace=${workspace}`)
      await page.getByTestId('complex-ready').waitFor()
      if (ui === 'native') await page.locator('[contenteditable=true]').first().waitFor()
      const preview = page.getByRole('button', { name: '继续', exact: true })
      if (ui === 'native') { await preview.waitFor(); await preview.click() }
      await page.screenshot({ path: join(artifacts, `${ui}-initial.png`), fullPage: true })
      await page.evaluate(() => {
        const samples = []
        const selector = '[data-testid="copilot-assistant-message"],.assistant-message,[data-chat-flow-kind="assistant-step"]'
        const capture = () => { const size = [...document.querySelectorAll(selector)].at(-1)?.textContent?.length ?? 0; if (size && samples.at(-1) !== size) samples.push(size) }
        const observer = new MutationObserver(capture)
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        const timer = window.setInterval(capture, 20)
        window.__streamSamples = samples
        window.__stopStreamCapture = () => { observer.disconnect(); window.clearInterval(timer) }
      })
      await exchange('请记住本会话的验收代号是“银杏海鸥”。请用三条简短项目列表介绍你能如何协助已有业务界面，不调用工具。')
      streamingSamples = await page.evaluate(() => { window.__stopStreamCapture?.(); return window.__streamSamples })
      assert.ok(new Set(streamingSamples).size >= 2, '必须观察到多个文本长度，而非只有最终完整消息')
      await record('流式消息与第一轮输入')
      await exchange('把当前选中的工单分配给周宁。只操作已选的两张，不要修改其他工单。')
      let data = await snapshot()
      assert.deepEqual(data.accounts.acme.tickets.map(ticket => ticket.assignee), ['周宁', '周宁', '陈晨'])
      assert.equal(data.writes, 1)
      await record('根据当前选择批量操作，无重复写入')
      await page.getByRole('combobox', { name: '当前客户' }).selectOption('birch')
      await page.getByRole('checkbox', { name: '选择 TK-81', exact: true }).check()
      await exchange('把当前选中的工单分配给周宁，只处理当前客户。')
      data = await snapshot()
      assert.equal(data.accounts.birch.tickets[0].assignee, '周宁')
      assert.equal(data.writes, 2)
      await record('切换客户后使用新上下文')
      await page.getByRole('combobox', { name: '当前客户' }).selectOption('acme')
      await page.getByRole('button', { name: '续约报价', exact: true }).click()
      const quotePage = page.getByTestId('quote-page')
      await quotePage.getByRole('spinbutton', { name: '年度预算' }).fill('150000')
      await quotePage.getByRole('button', { name: '保存草稿' }).click()
      await wait('人工预算保存', async () => (await snapshot()).accounts.acme.quote.budget === 150000)
      await exchange('只把当前报价折扣调整为 8%，保留我刚刚手工保存的预算，不需要审批或发送。')
      data = await snapshot()
      assert.equal(data.accounts.acme.quote.budget, 150000)
      assert.equal(data.accounts.acme.quote.discount, 8)
      await record('人工和 Agent 协同编辑不同字段')

      const currentVersion = data.accounts.acme.quote.version
      let intercepted = false
      await page.route('**/api/complex/*/operations', async route => {
        const input = route.request().postDataJSON()
        if (!intercepted && input.kind === 'patch' && input.operationId.startsWith('session-')) {
          intercepted = true
          await post({ operationId: `concurrent-${ui}`, customerId: 'acme', kind: 'patch', expectedVersion: currentVersion, budget: 151000 })
        }
        await route.continue()
      })
      await exchange('只把当前报价折扣从 8% 调整为 9%，保留预算。若版本冲突则解释并停止，不重试。')
      await page.unroute('**/api/complex/*/operations')
      assert.equal(intercepted, true)
      data = await snapshot()
      assert.equal(data.accounts.acme.quote.budget, 151000)
      const failures = (await session()).events.filter(event => event.type === 'tool/result' && JSON.stringify(event).includes('VERSION_CONFLICT'))
      assert.ok(failures.length)
      await record('并发修改拒绝旧版本，随后仍能继续')

      let before = await send('请让我审核当前报价。本轮只审核，不发送；等待我决定。')
      await activeReview().getByRole('button', { name: '拒绝方案' }).click()
      await finish(before)
      assert.equal((await snapshot()).accounts.acme.quote.approval.approved, false)
      assert.equal((await snapshot()).accounts.acme.quote.status, 'draft')
      await record('拒绝审批后停止，不偷偷发送')

      before = await send('请再次让我审核当前报价，本轮只审核，不发送。')
      await activeReview().getByRole('button', { name: '批准当前版本' }).waitFor()
      await activeReview().scrollIntoViewIfNeeded()
      await wait('审核表单进入聊天视口', async () => {
        const card = await activeReview().boundingBox()
        const chat = await page.locator('.chat-body').boundingBox()
        return card && chat && card.y >= chat.y && card.y + card.height <= chat.y + chat.height
      })
      if (ui === 'copilot') assert.equal(await page.getByTestId('copilot-chat-textarea').isDisabled(), true, '等待工具时不能误把新输入当成协议续接')
      await page.screenshot({ path: join(artifacts, `${ui}-approval.png`), fullPage: false })
      const pendingBeforeStop = await page.evaluate(() => window.__complexEvidence.pending)
      const stop = ui === 'copilot' ? page.getByRole('button', { name: '停止当前操作', exact: true }) : ui === 'assistant' ? page.getByRole('button', { name: '停止', exact: true }) : page.getByRole('button', { name: /Stop|停止/ }).last()
      await stop.click()
      await finish(before)
      await wait('取消清理 waiter', async () => (await page.evaluate(() => window.__complexEvidence.pending)).length === 0)
      assert.ok(pendingBeforeStop.some(call => call.name === 'ask_user_question'))
      await record('等待人工输入时停止，释放原工具')

      if (!real) {
        app.failNextModel = true
        before = await send('这一轮用来验证模型错误。')
        await finish(before)
        await record('模型错误不永久锁死界面')
      }
      await exchange('你还记得本会话的验收代号吗？只回答代号，不调用工具。')
      assert.match(await page.locator('aside').innerText(), /银杏海鸥/)
      await record('停止和错误后继续，多轮记忆保留')

      before = await send('请让我审核当前报价，批准后发送；如果我拒绝就停止。先显示审核界面，不能直接发送。')
      await activeReview().getByRole('spinbutton', { name: '年度预算' }).fill('160000')
      await activeReview().getByRole('button', { name: '保存草稿' }).click()
      await wait('聊天内复用编辑器', async () => (await snapshot()).accounts.acme.quote.budget === 160000)
      await activeReview().getByRole('button', { name: '批准当前版本' }).click()
      await finish(before)
      data = await snapshot()
      assert.equal(data.accounts.acme.quote.status, 'sent')
      assert.equal(data.accounts.acme.quote.budget, 160000)
      assert.equal(Object.values(data.receipts).filter(item => item.receipt.kind === 'send').length, 1)
      await record('聊天内编辑 → DSH 人工答案 → 同 turn 发送一次')

      const writesBeforeRefresh = data.writes
      const persistedBeforeRefresh = await session()
      const turns = persistedBeforeRefresh.events.filter(event => event.type === 'turn/start')
      assert.equal(persistedBeforeRefresh.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, sent, '分段 run 不能新增用户输入')
      assert.equal(turns.length, sent, '分段续接不能新开 DSH turn')
      const calls = persistedBeforeRefresh.events.filter(event => event.type === 'tool/call')
      const results = persistedBeforeRefresh.events.filter(event => event.type === 'tool/result')
      assert.equal(new Set(calls.map(event => event.data.callId)).size, calls.length)
      for (const call of calls) assert.ok(results.some(event => event.data.message.toolCallId === call.data.callId), `原调用必须有结果 ${call.data.callId}`)
      const evidence = await page.evaluate(() => ({ bridge: window.__complexEvidence, segments: window.__complexSegments ?? [] }))
      if (ui === 'copilot') {
        assert.equal(new Set(evidence.bridge.executions.map(item => item.callId)).size, evidence.bridge.executions.length, '每个原始 DSH 调用只执行一个原生 handler')
        assert.ok(evidence.bridge.executions.some(item => item.name === 'ask_user_question' && item.channel === 'copilot-native'))
        assert.ok(evidence.segments.filter(segment => segment.kind === 'continue').length >= 4)
        assert.equal(evidence.segments.filter(segment => segment.kind === 'prompt').length, sent)
      }
      await page.reload()
      await page.getByTestId('complex-ready').waitFor()
      await wait('聊天历史 hydration', async () => (await page.locator('aside').innerText()).includes('银杏海鸥'))
      assert.equal((await snapshot()).writes, writesBeforeRefresh)
      await record('刷新 hydration 不重放副作用')

      await page.getByRole('combobox', { name: '模拟角色' }).selectOption('viewer')
      await exchange('把当前选中的工单分配给周宁。如果当前页面没有操作工具，直接说明无法执行，不要调用其他工具绕过。')
      assert.equal((await snapshot()).writes, writesBeforeRefresh)
      const forbidden = await post({ operationId: `forbidden-${ui}`, customerId: 'birch', kind: 'assign', ticketIds: ['TK-81'], assignee: '陈晨' }, 'viewer')
      assert.equal(forbidden.status, 403)
      await record('撤销页面能力和服务端只读检查')
      const replay = Object.values((await snapshot()).receipts).find(item => item.receipt.kind === 'assign').receipt
      const repeat = { operationId: replay.operationId, customerId: 'acme', kind: 'assign', ticketIds: ['TK-41', 'TK-42'], assignee: '周宁' }
      assert.equal((await post(repeat)).status, 200)
      assert.equal((await snapshot()).writes, writesBeforeRefresh)
      try { await post({ operationId: `lost-${ui}`, customerId: 'birch', kind: 'assign', ticketIds: ['TK-81'], assignee: '周宁' }, 'editor', { 'x-poc-drop-response': 'once' }) } catch (error) { assert.match(String(error), /fetch|socket|terminated/i) }
      assert.equal((await post({ operationId: `lost-${ui}`, customerId: 'birch', kind: 'assign', ticketIds: ['TK-81'], assignee: '周宁' })).status, 200)
      assert.equal((await snapshot()).writes, writesBeforeRefresh + 1)
      await record('重复提交与丢响应重试只写一次')

      const allEvents = (await session()).events
      const modelRequests = app.metrics.modelRequests
      const headers = allEvents.filter(event => event.type === 'request/header')
      const reads = allEvents.filter(event => event.type === 'tool/result').flatMap(event => {
        try { const value = JSON.parse(event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')); return value.page ? [value] : [] } catch { return [] }
      })
      assert.ok(reads.some(value => value.context.customerId === 'acme') && reads.some(value => value.context.customerId === 'birch'))
      if (ui === 'copilot') assert.ok(reads.some(value => Array.isArray(value.frameworkContext) && value.frameworkContext.length > 0), 'hook 上下文必须经过 DSH 工具结果落盘')
      assert.ok(headers.length)
      assert.ok(headers.some(event => JSON.stringify(event).includes('bulk_assign')))
      assert.ok(headers.some(event => JSON.stringify(event).includes('quote_patch') && !JSON.stringify(event).includes('bulk_assign')))
      const currentSessionId = new URL(page.url()).searchParams.get('sessionId')
      const modelTraffic = network.filter(item => new URL(item.url).pathname === '/api/browser-native/llm' && item.method === 'POST').map(item => {
        const payload = JSON.parse(item.body)
        const title = payload.messages?.some(message => typeof message.content === 'string' && message.content.startsWith('Generate the session title from this JSON array of human messages:'))
        return { requestId: payload.requestId, sessionId: payload.sessionId, purpose: title ? 'session-title' : payload.sessionId ? 'session-turn' : 'unclassified' }
      })
      const modelRequestProof = { dshSteps: allEvents.filter(event => event.type === 'step/start').length, sessionRequests: modelTraffic.filter(item => item.sessionId === currentSessionId && item.purpose === 'session-turn').length, titleRequests: modelTraffic.filter(item => item.purpose === 'session-title').length, requests: modelTraffic }
      assert.ok(modelTraffic.every(item => item.sessionId === currentSessionId || item.purpose === 'session-title'), '不得出现未归属 DSH Session 或标题服务的模型请求')
      assert.equal(modelRequestProof.sessionRequests, modelRequestProof.dshSteps, '本实验每个 DSH step 只发一个模型请求，不允许额外框架模型循环')
      assert.ok(!network.some(item => /^https?:/.test(item.url) && !item.url.startsWith(origin)), '不允许隐式连接 CopilotKit 云或其他外部服务')
      const exposed = JSON.stringify({ network, allEvents })
      const envText = real ? await readFile(options.envFile, 'utf8') : ''
      for (const match of envText.matchAll(/^\s*(?:export\s+)?[A-Z_]*(?:API_KEY|TOKEN|SECRET)[A-Z_]*\s*=\s*["']?([^\s"'#]+)/gm)) if (match[1].length > 12) assert.ok(!exposed.includes(match[1]), '浏览器或 Session 泄露凭据')
      await page.screenshot({ path: join(artifacts, `${ui}-complete.png`), fullPage: true })
      await writeFile(join(artifacts, `${ui}-evidence.json`), JSON.stringify({ sent, steps, modelRequests: modelRequests - modelBaseline, modelRequestProof, failedOrEmptyAttempts: allEvents.filter(event => event.type === 'assistant/attempt').length, loggedPageReads: reads.map(value => ({ page: value.page, context: value.context, frameworkContext: value.frameworkContext })), calls: calls.map(event => ({ seq: event.seq, turn: event.data.turn, callId: event.data.callId, name: event.data.name })), resultIds: results.map(event => event.data.message.toolCallId), evidence, streamingSamples, pageErrors, network: network.map(({ url, method }) => ({ url, method })), receipts: (await snapshot()).receipts }, null, 2))
      outcomes.push({ ui, passed: true, sent, steps, evidence: `${ui}-evidence.json` })
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `${ui}-failed.png`), fullPage: true }).catch(() => {})
      await writeFile(join(artifacts, `${ui}-failed.txt`), `${error.stack}\n${await page.locator('body').innerText()}\n${JSON.stringify(await page.evaluate(() => ({ segments: window.__complexSegments, bridge: window.__complexEvidence })))}`)
      outcomes.push({ ui, passed: false, error: error.message, steps })
      throw error
    } finally { await context.close() }
  }
} finally {
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({ real, browser: webkit ? 'Playwright WebKit (not Safari.app)' : 'installed Chrome', outcomes, dataDir: root }, null, 2))
  console.log(`证据：${artifacts}`)
  await browser?.close()
  await app.close()
}
