import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { createComparisonServer } from '../server.mjs'

const require = createRequire(import.meta.url)
const imported = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? join(homedir(), 'node_modules/playwright/index.js'))
const playwright = imported.default ?? imported
const real = process.argv.includes('--real')
const webkit = process.argv.includes('--webkit')
const only = process.argv.find(argument => argument.startsWith('--ui='))?.slice(5)
const dataDir = await mkdtemp(join(tmpdir(), `dsh-saas-${real ? 'real' : 'scripted'}-${webkit ? 'webkit' : 'chrome'}-`))
const artifacts = resolve(dataDir, 'artifacts')
await mkdir(artifacts)
const app = await createComparisonServer({
  llmMode: real ? 'real' : 'scripted', dataDir,
  distRoot: resolve(import.meta.dirname, '../../../../apps/web/dist'),
  envFile: process.env.DSH_POC_ENV_FILE ?? '/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/.env',
})
const results = []
let browser
try {
  await app.listen(0, '127.0.0.1')
  const origin = `http://127.0.0.1:${app.server.address().port}`
  browser = await (webkit ? playwright.webkit : playwright.chromium).launch({ headless: true, ...(webkit ? {} : { channel: 'chrome' }) })
  for (const ui of only ? [only] : ['native', 'assistant', 'copilot']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    const requests = []
    page.on('pageerror', error => { errors.push(error.message); console.error(ui, error.message) })
    context.on('request', request => { requests.push({ url: request.url(), body: request.postData(), headers: request.headers() }) })
    const timeout = real ? 240_000 : 45_000
    page.setDefaultTimeout(timeout)
    async function session() {
      const sessionId = new URL(page.url()).searchParams.get('sessionId')
      const response = await fetch(`${origin}/api/browser-native/session/read`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-browser-native-protocol': '1' }, body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId, offset: 0, length: 10000 }) })
      assert.equal(response.status, 200)
      return response.json()
    }
    async function wait(label, predicate) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (await predicate()) return
        if (errors.length > 0) throw new Error(errors.join('\n'))
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
      }
      throw new Error(`timeout: ${label}`)
    }
    async function send(text) {
      const input = ui === 'native' ? page.locator('[contenteditable="true"]').first() : ui === 'copilot' ? page.getByTestId('copilot-chat-textarea') : page.getByRole('textbox', { name: '消息', exact: true })
      await input.fill(text)
      await input.press('Enter')
    }
    async function finishAfter(seq) {
      await wait('DSH turn end', async () => (await session()).events.some(event => event.type === 'turn/end' && event.seq > seq))
    }
    try {
      await page.goto(`${origin}/saas-agentic-ui-comparison-poc/index.html?ui=${ui}&workspace=e2e-${ui}`, { waitUntil: 'domcontentloaded' })
      await page.getByTestId('comparison-ready').waitFor()
      const preview = page.getByRole('button', { name: '继续', exact: true })
      if (await preview.isVisible()) await preview.click()
      await page.screenshot({ path: join(artifacts, `${ui}-initial.png`), fullPage: true })

      await page.getByRole('button', { name: '＋ 新建任务', exact: true }).click()
      await page.getByRole('dialog').getByRole('textbox', { name: '任务标题' }).fill('GUI 基线任务')
      await page.getByRole('dialog').getByRole('button', { name: '确认保存' }).click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      assert.equal((await (await fetch(`${origin}/api/saas/e2e-${ui}/snapshot`)).json()).tasks.length, 2)

      let before = (await session()).events.at(-1)?.seq ?? -1
      const assistantSelector = ui === 'native' ? '.native-host [data-chat-flow-kind="assistant-step"]' : ui === 'assistant' ? '.assistant-message' : '[data-testid="copilot-assistant-message"]'
      await page.evaluate(selector => {
        const samples = []
        const observer = new MutationObserver(() => {
          const text = [...document.querySelectorAll(selector)].at(-1)?.textContent ?? ''
          if (text.length > 0 && samples.at(-1) !== text.length) samples.push(text.length)
        })
        observer.observe(document.querySelector('.chat-body'), { subtree: true, childList: true, characterData: true })
        window.__streamObservation = { samples, observer }
      }, assistantSelector)
      await send('请用三条项目列表简述如何读取工作台、填写表单、等待人工确认。每条约三十字，不调用工具。')
      await finishAfter(before)
      const streamSamples = await page.evaluate(() => { window.__streamObservation.observer.disconnect(); return window.__streamObservation.samples })
      assert.ok(new Set(streamSamples).size >= 2 && Math.min(...streamSamples) < Math.max(...streamSamples), `UI must render incremental text, observed lengths: ${streamSamples}`)
      await page.screenshot({ path: join(artifacts, `${ui}-streamed-message.png`), fullPage: true })
      before = (await session()).events.at(-1).seq
      await send('请创建一个标题为“比较实验任务”的项目任务，负责人林悦，优先级高。使用已有业务表单让我修改后确认。不要使用文件或 bash。')
      const task = page.locator('[data-tool="saas_create_task"]').filter({ has: page.getByTestId('business-form') }).last()
      await task.getByRole('textbox', { name: '任务标题' }).fill('用户修改后的任务')
      await task.getByRole('combobox', { name: '负责人', exact: true }).selectOption('周宁')
      await page.screenshot({ path: join(artifacts, `${ui}-task-form.png`), fullPage: true })
      await task.getByRole('button', { name: '确认保存' }).click()
      await finishAfter(before)
      let state = await (await fetch(`${origin}/api/saas/e2e-${ui}/snapshot`)).json()
      assert.equal(state.tasks.length, 3)
      assert.equal(state.tasks.at(-1).title, '用户修改后的任务')
      assert.equal(state.tasks.at(-1).assignee, '周宁')

      before = (await session()).events.at(-1).seq
      await send('请把工单 TICKET-42 分配给周宁，设为高优先级，状态改为处理中。请读取当前版本并让我确认。')
      const ticket = page.locator('[data-tool="saas_update_ticket"]').filter({ has: page.getByTestId('business-form') }).last()
      await ticket.getByRole('button', { name: '确认保存' }).click()
      await finishAfter(before)
      state = await (await fetch(`${origin}/api/saas/e2e-${ui}/snapshot`)).json()
      assert.equal(state.tickets[0].status, 'in_progress')
      assert.equal(state.tickets[0].version, 2)

      before = (await session()).events.at(-1).seq
      await send('请审批账单 INV-2026-018，展示现有审批界面让我决定。')
      const invoice = page.locator('[data-tool="saas_approve_invoice"]').filter({ has: page.getByTestId('business-form') }).last()
      await invoice.getByRole('button', { name: '取消操作' }).click()
      await finishAfter(before)
      state = await (await fetch(`${origin}/api/saas/e2e-${ui}/snapshot`)).json()
      assert.equal(state.invoices[0].status, 'pending')
      assert.equal(Object.keys(state.receipts).length, 3)

      before = (await session()).events.at(-1).seq
      await send('现在我决定批准账单 INV-2026-018。请再次显示审批界面让我确认。')
      await page.locator('[data-tool="saas_approve_invoice"]').filter({ has: page.getByTestId('business-form') }).last().getByRole('button', { name: '确认批准' }).click()
      await finishAfter(before)
      state = await (await fetch(`${origin}/api/saas/e2e-${ui}/snapshot`)).json()
      assert.equal(state.invoices[0].status, 'approved')
      assert.equal(Object.keys(state.receipts).length, 4)

      await page.getByRole('combobox', { name: '模拟角色' }).selectOption('viewer')
      before = (await session()).events.at(-1).seq
      await send('请创建标题为“只读拒绝验证”的项目任务，负责人林悦，优先级高。展示表单让我确认。')
      const deniedForm = page.locator('[data-tool="saas_create_task"]').filter({ has: page.getByTestId('business-form') }).last()
      await wait('viewer refusal or confirmation form', async () => await deniedForm.isVisible() || (await session()).events.some(event => event.type === 'turn/end' && event.seq > before))
      const viewerMode = await deniedForm.isVisible() ? 'api-denial' : 'model-refusal'
      if (viewerMode === 'api-denial') { await deniedForm.getByRole('button', { name: '确认保存' }).click(); await finishAfter(before) }
      state = await (await fetch(`${origin}/api/saas/e2e-${ui}/snapshot`)).json()
      assert.equal(Object.keys(state.receipts).length, 4, 'API rejects viewer writes')
      assert.equal(state.tasks.length, 3)
      await page.getByRole('combobox', { name: '模拟角色' }).selectOption('editor')

      before = (await session()).events.at(-1).seq
      await send('记住我的验收代号是“橙色海豚”。只回复已记住，不调用工具。')
      await finishAfter(before)
      before = (await session()).events.at(-1).seq
      await send('我之前告诉你的验收代号是什么？只回复代号，不调用工具。')
      await finishAfter(before)
      const memory = (await session()).events.filter(event => event.type === 'assistant/message' && event.seq > before)
      assert.ok(JSON.stringify(memory).includes('橙色海豚'), 'same Session memory survives multiple business turns')

      before = (await session()).events.at(-1).seq
      await send('请创建标题为“停止验证”的项目任务，负责人林悦，优先级高。展示表单，等待我确认。')
      await page.locator('[data-tool="saas_create_task"]').filter({ has: page.getByTestId('business-form') }).last().waitFor()
      const stop = ui === 'copilot' ? page.getByTestId('copilot-send-button') : page.locator('.chat-body').getByRole('button', { name: /停止|Stop/i }).last()
      await stop.click()
      await finishAfter(before)
      await wait('cancelled form disappears', () => page.locator('.chat-body [data-testid="business-form"]').count().then(count => count === 0))
      state = await (await fetch(`${origin}/api/saas/e2e-${ui}/snapshot`)).json()
      assert.equal(Object.keys(state.receipts).length, 4)
      before = (await session()).events.at(-1).seq
      await send('请确认可以继续对话，只回复“继续验收成功”，不调用工具。')
      await finishAfter(before)

      const oldUrl = page.url()
      const history = await session()
      const users = history.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
      assert.equal(users.length, 10, 'no synthetic prompts for tool continuation')
      const calls = history.events.filter(event => event.type === 'tool/call')
      assert.ok(calls.length >= 4)
      for (const call of calls) assert.ok(history.events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId).length <= 1, 'at most one result for a DSH call')
      const firstTask = calls.find(call => call.data.name === 'saas_create_task')
      assert.equal(history.events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === firstTask.data.callId).length, 1)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByTestId('comparison-ready').waitFor()
      assert.equal(page.url(), oldUrl)
      await wait('historical task card', () => page.locator('[data-tool="saas_create_task"]').count().then(count => count > 0))
      assert.equal(await page.locator('.chat-body [data-testid="business-form"]').count(), 0)
      state = await (await fetch(`${origin}/api/saas/e2e-${ui}/snapshot`)).json()
      assert.equal(Object.keys(state.receipts).length, 4)
      await page.screenshot({ path: join(artifacts, `${ui}-restored.png`), fullPage: true })
      assert.deepEqual(errors, [])
      assert.equal(requests.some(request => /copilotkit\.(ai|com)|cloud\.assistant-ui/.test(request.url)), false)
      const modelRequests = requests.filter(request => new URL(request.url).pathname === '/api/browser-native/llm')
      assert.equal(modelRequests.length, history.events.filter(event => event.type === 'step/start' || event.type === 'session/title-llm-request').length, 'all model requests belong to DSH steps or the DSH title service')
      const headers = history.events.filter(event => event.type === 'request/header')
      assert.ok(headers.length > 0)
      for (const header of headers) assert.deepEqual(header.data.header.tools.map(tool => tool.name).sort(), ['ask_user_question', 'saas_approve_invoice', 'saas_create_task', 'saas_read_workspace', 'saas_update_ticket'].sort(), 'identical browser-specific tool roster')
      if (real) {
        const environment = await readFile(process.env.DSH_POC_ENV_FILE ?? '/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/.env', 'utf8')
        const secrets = environment.split(/\r?\n/).flatMap(line => { const match = line.match(/^[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)=(.+)$/); return match === null ? [] : [match[1].replace(/^['"]|['"]$/g, '')] }).filter(value => value.length > 8)
        const exposed = JSON.stringify({ requests, history, page: await page.content() })
        for (const secret of secrets) assert.equal(exposed.includes(secret), false, 'browser or Session leaked a configured secret')
      }
      const evidence = { ui, real, browser: webkit ? 'webkit' : 'chrome', sessionId: new URL(oldUrl).searchParams.get('sessionId'), users: users.length, toolCalls: calls.length, toolResults: history.events.filter(event => event.type === 'tool/result').length, receipts: Object.keys(state.receipts).length, modelRequests: modelRequests.length, streamSamples, viewerMode, errors }
      await writeFile(join(artifacts, `${ui}-session.json`), JSON.stringify(history, null, 2))
      await writeFile(join(artifacts, `${ui}-evidence.json`), JSON.stringify(evidence, null, 2))
      results.push(evidence)
      console.log('PASS', JSON.stringify(evidence))
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `${ui}-failure.png`), fullPage: true }).catch(() => {})
      await writeFile(join(artifacts, `${ui}-failure.txt`), `${String(error)}\n${await page.locator('body').innerText()}`)
      await writeFile(join(artifacts, `${ui}-failure.html`), await page.content())
      throw error
    } finally { await context.close() }
  }
} finally {
  await browser?.close()
  await app.close()
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify(results, null, 2))
  console.log(`Evidence: ${artifacts}`)
}
