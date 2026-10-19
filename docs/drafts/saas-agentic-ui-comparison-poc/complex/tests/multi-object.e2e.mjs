import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { createExperimentServer } from '../server.mjs'

const imported = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? join(homedir(), 'node_modules/playwright/index.js'))
const playwright = imported.default ?? imported
const real = process.argv.includes('--real')
const webkit = process.argv.includes('--webkit')
const only = process.argv.find(argument => argument.startsWith('--ui='))?.slice(5)
const root = await mkdtemp(join(tmpdir(), `dsh-multi-object-${real ? 'real-' : ''}${webkit ? 'webkit' : 'chrome'}-`))
const artifacts = resolve(root, 'artifacts')
await mkdir(artifacts)
console.log(`测试证据：${artifacts}`)
const app = await createExperimentServer({ llmMode: real ? 'real' : 'scripted', dataDir: root, distRoot: resolve(import.meta.dirname, '../../../../../apps/web/dist'), envFile: process.env.DSH_POC_ENV_FILE ?? '/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/.env', testHooks: { dropResponse: true } })
const browser = await (webkit ? playwright.webkit : playwright.chromium).launch({ headless: true, ...(webkit ? {} : { channel: 'chrome' }) })
const outcomes = []

try {
  await app.listen(0, '127.0.0.1')
  const origin = `http://127.0.0.1:${app.server.address().port}`
  for (const ui of (only ? only.split(',') : ['assistant', 'copilot'])) {
    const workspace = `multi-${ui}`
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
    const page = await context.newPage()
    const network = []
    context.on('request', request => { network.push({ url: request.url(), method: request.method(), body: request.postData() }) })
    page.setDefaultTimeout(real ? 240000 : 60000)
    const session = async () => {
      const sessionId = new URL(page.url()).searchParams.get('sessionId')
      const response = await fetch(`${origin}/api/browser-native/session/read`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-browser-native-protocol': '1' }, body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId, offset: 0, length: 50000 }) })
      assert.equal(response.status, 200)
      return response.json()
    }
    const snapshot = async () => (await fetch(`${origin}/api/complex/${workspace}/snapshot`)).json()
    const post = async input => {
      const response = await fetch(`${origin}/api/complex/${workspace}/operations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mock-role': 'editor' }, body: JSON.stringify(input) })
      return { status: response.status, value: await response.json() }
    }
    const wait = async (label, predicate) => {
      const deadline = Date.now() + (real ? 240000 : 60000)
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolveDelay => setTimeout(resolveDelay, 100)) }
      throw new Error(`等待超时：${label}`)
    }
    const submitMessage = async text => {
      const before = (await session()).events.at(-1)?.seq ?? -1
      const input = ui === 'copilot' ? page.getByTestId('copilot-chat-textarea') : page.getByRole('textbox', { name: '消息', exact: true })
      await input.fill(text)
      await input.press('Enter')
      return before
    }
    const approveVisibleReviews = async (limit = 4) => {
      for (let attempt = 0; attempt < limit; attempt += 1) {
        const cards = page.getByTestId('review-card').filter({ has: page.getByRole('button', { name: '批准批量方案', exact: true }) })
        if (await cards.count() === 0) return
        const card = cards.last()
        if (!await card.isVisible().catch(() => false)) return
        const button = card.getByRole('button', { name: '批准批量方案', exact: true })
        if (!await button.isEnabled().catch(() => false)) {
          await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
          continue
        }
        await button.click()
        await card.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {})
      }
    }
    try {
      await page.goto(`${origin}/saas-agentic-ui-comparison-poc/complex/index.html?ui=${ui}&workspace=${workspace}`)
      await page.getByTestId('complex-ready').waitFor()
      await page.getByRole('button', { name: '续约组合', exact: true }).click()
      await page.getByTestId('portfolio-page').waitFor()
      const firstBefore = await submitMessage('请为选中的两个客户制定统一续约方案，把折扣都调到 8%。本轮严格按顺序执行：只调用一次 page_read，然后调用 portfolio_review 展示可编辑预览；不要再次调用 page_read，不要调用 portfolio_apply，等待我批准审核卡。')
      const firstReview = page.getByTestId('review-card').filter({ has: page.getByRole('button', { name: '批准批量方案', exact: true }) }).last()
      await firstReview.waitFor()
      await firstReview.getByRole('button', { name: '批准批量方案', exact: true }).click()
      await approveVisibleReviews()
      await wait('首轮冲突 turn 结束', async () => (await session()).events.some(event => event.type === 'turn/end' && event.seq > firstBefore))
      const conflict = await post({ operationId: `external-conflict-${ui}`, customerId: 'acme', kind: 'patch', expectedVersion: 1, discount: 6 })
      assert.equal(conflict.status, 200)
      const stale = await post({ operationId: `stale-approved-plan-${ui}`, customerId: 'acme', kind: 'portfolio_apply', changes: [
        { customerId: 'acme', expectedVersion: 1, budget: 120000, discount: 8 },
        { customerId: 'birch', expectedVersion: 1, budget: 60000, discount: 8 },
      ] })
      assert.equal(stale.status, 409)
      assert.equal(stale.value.code, 'VERSION_CONFLICT')
      const afterConflict = await snapshot()
      assert.equal(afterConflict.accounts.acme.quote.discount, 6)
      assert.equal(afterConflict.accounts.birch.quote.discount, 0)
      assert.equal(afterConflict.writes, 2)

      const secondBefore = await submitMessage('刚才批准的方案遇到版本冲突。请读取当前两个客户，按当前版本重新展示批量续约预览；折扣仍为 8%。我批准后必须调用 portfolio_apply 执行，不要只回复总结。')
      const secondReview = page.getByTestId('review-card').filter({ has: page.getByRole('button', { name: '批准批量方案', exact: true }) }).last()
      await secondReview.waitFor()
      if (!real) {
        const birchForm = secondReview.getByLabel('白桦设计 / 折扣').locator('xpath=ancestor::form')
        await secondReview.getByLabel('白桦设计 / 折扣').fill('9')
        await birchForm.getByRole('button', { name: '保存草稿', exact: true }).click()
      }
      await secondReview.getByRole('button', { name: '批准批量方案', exact: true }).click()
      await approveVisibleReviews()
      await wait('第二轮 turn 结束', async () => (await session()).events.some(event => event.type === 'turn/end' && event.seq > secondBefore))
      if ((await snapshot()).writes !== 4) {
        const finalConfirmBefore = await submitMessage('确认执行刚才的批量续约方案，请直接调用 portfolio_apply 并返回业务凭据。')
        await wait('最终执行确认 turn 结束', async () => (await session()).events.some(event => event.type === 'turn/end' && event.seq > finalConfirmBefore))
      }
      await wait('批量提交完成', async () => { const value = await snapshot(); return value.accounts.acme.quote.discount === 8 && value.accounts.birch.quote.discount === (real ? 8 : 9) && value.writes === 4 })
      const final = await snapshot()
      assert.equal(final.accounts.acme.quote.version, 3)
      assert.equal(final.accounts.birch.quote.version, 2)
      assert.equal(Object.values(final.receipts).filter(item => item.receipt.kind === 'portfolio_apply').length, 1)
      const persisted = await session()
      const userMessages = persisted.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
      const turns = persisted.events.filter(event => event.type === 'turn/start')
      const calls = persisted.events.filter(event => event.type === 'tool/call')
      const results = persisted.events.filter(event => event.type === 'tool/result')
      assert.equal(userMessages.length, 2)
      assert.equal(turns.length, userMessages.length)
      assert.equal(calls.length, results.length)
      assert.deepEqual(calls.map(event => event.data.name), ['page_read', 'portfolio_review', 'page_read', 'portfolio_review', 'portfolio_apply'])
      for (const call of calls) assert.ok(results.some(event => event.data.message.toolCallId === call.data.callId), `调用必须有结果 ${call.data.callId}`)
      const modelRequests = network.filter(item => new URL(item.url).pathname === '/api/browser-native/llm' && item.method === 'POST').map(item => JSON.parse(item.body))
      const sessionTurnRequests = modelRequests.filter(request => request.sessionId === new URL(page.url()).searchParams.get('sessionId') && !request.messages?.some(message => typeof message.content === 'string' && message.content.startsWith('Generate the session title from this JSON array of human messages:')))
      assert.equal(sessionTurnRequests.length, persisted.events.filter(event => event.type === 'step/start').length)
      assert.ok(!network.some(item => /^https?:/.test(item.url) && !item.url.startsWith(origin)))
      const receiptKinds = Object.values(final.receipts).map(item => item.receipt.kind)
      assert.equal(receiptKinds.filter(kind => kind === 'portfolio_approve').length, 2)
      assert.equal(receiptKinds.filter(kind => kind === 'portfolio_apply').length, 1)
      const evidence = { ui, workspace, writes: final.writes, turns: turns.length, calls: calls.map(event => ({ name: event.data.name, callId: event.data.callId })), results: results.map(event => ({ callId: event.data.message.toolCallId, text: event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('') })), modelRequests: modelRequests.length, sessionTurnRequests: sessionTurnRequests.length, network: network.map(({ url, method }) => ({ url, method })), business: { acme: final.accounts.acme.quote, birch: final.accounts.birch.quote } }
      await page.screenshot({ path: join(artifacts, `${ui}-multi-object.png`), fullPage: true })
      await writeFile(join(artifacts, `${ui}-multi-object.json`), JSON.stringify(evidence, null, 2))
      outcomes.push({ ui, passed: true, evidence: `${ui}-multi-object.json` })
      console.log(`${ui}: multi-object scenario passed`)
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `${ui}-multi-object-failed.png`), fullPage: true }).catch(() => {})
      await writeFile(join(artifacts, `${ui}-multi-object-failed.txt`), `${error.stack}\n${await page.locator('body').innerText()}`)
      throw error
    } finally { await context.close() }
  }
} finally {
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({ real, browser: webkit ? 'Playwright WebKit (not Safari.app)' : 'installed Chrome', outcomes }, null, 2))
  await browser.close()
  await app.close()
}
