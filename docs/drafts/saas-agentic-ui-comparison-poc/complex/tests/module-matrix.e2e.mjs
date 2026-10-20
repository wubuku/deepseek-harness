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
const root = await mkdtemp(join(tmpdir(), `dsh-module-matrix-${real ? 'real-' : ''}${webkit ? 'webkit' : 'chrome'}-`))
const artifacts = resolve(root, 'artifacts')
await mkdir(artifacts)
console.log(`测试证据：${artifacts}`)
const app = await createExperimentServer({ llmMode: real ? 'real' : 'scripted', dataDir: root, distRoot: resolve(import.meta.dirname, '../../../../../apps/web/dist'), envFile: process.env.DSH_POC_ENV_FILE ?? '/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/.env' })
const browser = await (webkit ? playwright.webkit : playwright.chromium).launch({ headless: true, ...(webkit ? {} : { channel: 'chrome' }) })
const outcomes = []

try {
  await app.listen(0, '127.0.0.1')
  const origin = `http://127.0.0.1:${app.server.address().port}`
  for (const ui of (only ? only.split(',') : ['assistant', 'copilot'])) {
    const workspace = `module-${ui}`
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
    const wait = async (label, predicate) => {
      const deadline = Date.now() + (real ? 240000 : 60000)
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolveDelay => setTimeout(resolveDelay, 100)) }
      throw new Error(`等待超时：${label}`)
    }
    const submitMessage = async text => {
      const input = ui === 'copilot' ? page.getByTestId('copilot-chat-textarea') : page.getByRole('textbox', { name: '消息', exact: true })
      await input.fill(text)
      await input.press('Enter')
    }
    try {
      await page.goto(`${origin}/saas-agentic-ui-comparison-poc/complex/index.html?ui=${ui}&workspace=${workspace}`)
      await page.getByTestId('complex-ready').waitFor()
      await page.getByRole('button', { name: '账单减免', exact: true }).click()
      await page.getByTestId('billing-page').waitFor()
      await submitMessage('请处理当前页面的账单争议：先只调用一次 page_read，然后调用 billing_review 展示可编辑减免预览，建议减免 10000 元，理由为服务中断补偿。批准前不要调用 billing_apply，等待我在审核卡中修改并批准；我批准后立即在同一 DSH turn 续接调用 billing_apply，不要再次 page_read 或重新询问。')
      const review = page.getByTestId('billing-review-card').filter({ has: page.getByRole('button', { name: '批准账单减免', exact: true }) }).last()
      await review.waitFor()
      await review.getByLabel('账单减免金额').fill('8000')
      await review.getByLabel('账单减免原因').fill('服务中断补偿（人工确认）')
      await review.getByRole('button', { name: '保存减免草稿', exact: true }).click()
      await review.getByRole('button', { name: '批准账单减免', exact: true }).click()
      await wait('账单减免提交', async () => { const value = await snapshot(); return value.accounts.acme.billing.status === 'credited' && value.accounts.acme.billing.creditAmount === 8000 && value.writes === 2 })
      const final = await snapshot()
      const persisted = await session()
      const calls = persisted.events.filter(event => event.type === 'tool/call')
      const results = persisted.events.filter(event => event.type === 'tool/result')
      const turns = persisted.events.filter(event => event.type === 'turn/start')
      const userMessages = persisted.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
      assert.equal(userMessages.length, 1)
      assert.equal(turns.length, 1)
      assert.deepEqual(calls.map(event => event.data.name), ['page_read', 'billing_review', 'billing_apply'])
      assert.equal(calls.length, results.length)
      for (const call of calls) assert.ok(results.some(event => event.data.message.toolCallId === call.data.callId), `调用必须有结果 ${call.data.callId}`)
      assert.equal(Object.values(final.receipts).filter(item => item.receipt.kind === 'billing_approve').length, 1)
      assert.equal(Object.values(final.receipts).filter(item => item.receipt.kind === 'billing_apply').length, 1)
      assert.ok(!network.some(item => /^https?:/.test(item.url) && !item.url.startsWith(origin)))
      const evidence = { ui, workspace, writes: final.writes, turns: turns.length, calls: calls.map(event => ({ name: event.data.name, callId: event.data.callId })), results: results.map(event => ({ callId: event.data.message.toolCallId, text: event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('') })), business: final.accounts.acme.billing, network: network.map(({ url, method }) => ({ url, method })) }
      await page.screenshot({ path: join(artifacts, `${ui}-module-matrix.png`), fullPage: true })
      await writeFile(join(artifacts, `${ui}-module-matrix.json`), JSON.stringify(evidence, null, 2))
      outcomes.push({ ui, passed: true, evidence: `${ui}-module-matrix.json` })
      console.log(`${ui}: module matrix passed`)
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `${ui}-module-matrix-failed.png`), fullPage: true }).catch(() => {})
      await writeFile(join(artifacts, `${ui}-module-matrix-failed.txt`), `${error.stack}\n${await page.locator('body').innerText()}`)
      throw error
    } finally { await context.close() }
  }
} finally {
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({ real, browser: webkit ? 'Playwright WebKit (not Safari.app)' : 'installed Chrome', outcomes }, null, 2))
  await browser.close()
  await app.close()
}
