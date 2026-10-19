import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { createExperimentServer } from '../server.mjs'

const imported = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? join(homedir(), 'node_modules/playwright/index.js'))
const playwright = imported.default ?? imported
const root = await mkdtemp(join(tmpdir(), 'dsh-complex-lifecycle-'))
const webkit = process.argv.includes('--webkit')
const real = process.argv.includes('--real')
const options = { llmMode: real ? 'real' : 'scripted', dataDir: root, distRoot: resolve(import.meta.dirname, '../../../../../apps/web/dist'), envFile: '/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/.env' }
let app = await createExperimentServer(options)
let browser
const results = []
try {
  await app.listen(0, '127.0.0.1')
  const port = app.server.address().port
  const origin = `http://127.0.0.1:${port}`
  browser = await (webkit ? playwright.webkit : playwright.chromium).launch({ headless: true, ...(webkit ? {} : { channel: 'chrome' }) })
  for (const ui of process.argv.find(value => value.startsWith('--ui='))?.slice(5).split(',') ?? ['copilot', 'assistant', 'native']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    let page = await context.newPage()
    page.setDefaultTimeout(real ? 180000 : 45000)
    const workspace = `restart-${ui}`
    const base = `${origin}/saas-agentic-ui-comparison-poc/complex/index.html?ui=${ui}&workspace=${workspace}`
    const business = async () => (await fetch(`${origin}/api/complex/${workspace}/snapshot`)).json()
    const prompt = '请记住本会话代号“银杏海鸥”，只回复已记住，不调用工具。'
    const read = async () => (await fetch(`${origin}/api/browser-native/session/read`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-browser-native-protocol': '1' }, body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId: new URL(page.url()).searchParams.get('sessionId'), offset: 0, length: 50000 }) })).json()
    const send = async text => {
      const before = (await read()).events.at(-1)?.seq ?? -1
      const input = ui === 'copilot' ? page.getByTestId('copilot-chat-textarea') : ui === 'assistant' ? page.getByRole('textbox', { name: '消息', exact: true }) : page.locator('[contenteditable=true]').first()
      if (ui === 'native') { await input.click(); await input.press('ControlOrMeta+A'); await input.pressSequentially(text) } else await input.fill(text)
      if (ui === 'native') await page.getByRole('button', { name: '发送消息', exact: true }).click()
      else await input.press('Enter')
      await expectCondition(async () => (await read()).events.some(event => event.seq > before && event.type === 'turn/end'))
    }
    async function expectCondition(predicate) {
      const deadline = Date.now() + (real ? 180000 : 45000)
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(release => setTimeout(release, 100)) }
      throw new Error('生命周期验收超时')
    }
    try {
      await page.goto(base)
      await page.getByTestId('complex-ready').waitFor()
      if (ui === 'native') await page.locator('[contenteditable=true]').first().waitFor()
      const preview = page.getByRole('button', { name: '继续', exact: true })
      if (ui === 'native') { await preview.waitFor(); await preview.click() }
      await send(prompt)
      const url = page.url()
      const duplicateContext = await browser.newContext()
      try {
        const duplicate = await duplicateContext.newPage()
        await duplicate.goto(url)
        await expectCondition(async () => /already owned|write|写权|owned by|启动失败/.test(await duplicate.locator('body').innerText()))
      } finally { await duplicateContext.close() }
      await send('你还记得代号吗？只回复代号，不调用工具。')
      const beforeRestart = await read()
      assert.equal(beforeRestart.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 2)
      await page.getByRole('button', { name: '分配所选给周宁', exact: true }).click()
      await expectCondition(async () => (await business()).writes === 1)
      const businessBeforeRestart = await business()
      await page.close()
      await app.close()
      app = await createExperimentServer(options)
      await app.listen(port, '127.0.0.1')
      page = await context.newPage()
      page.setDefaultTimeout(real ? 180000 : 45000)
      await page.goto(url)
      await page.getByTestId('complex-ready').waitFor()
      await expectCondition(async () => (await page.locator('aside').innerText()).includes('银杏海鸥'))
      const afterRestart = await read()
      assert.equal(afterRestart.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 2)
      assert.deepEqual(await business(), businessBeforeRestart, '业务记录与幂等凭据必须同 Session 一起恢复')
      await send('重启后你还记得代号吗？只回复代号，不调用工具。')
      const final = await read()
      assert.equal(final.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 3)
      assert.ok(JSON.stringify(final.events.filter(event => event.type === 'assistant/message').at(-1)).includes('银杏海鸥'))
      if (ui === 'copilot') {
        await page.getByRole('button', { name: '续约报价', exact: true }).click()
        await page.getByTestId('copilot-chat-textarea').fill('请让我审核当前报价，本轮只审核，不发送。')
        await page.getByTestId('copilot-chat-textarea').press('Enter')
        await page.getByRole('button', { name: '批准当前版本', exact: true }).waitFor()
        await page.reload()
        await page.getByTestId('complex-ready').waitFor()
        await expectCondition(async () => /执行已中断|已结束 \/ 历史记录/.test(await page.locator('aside').innerText()))
        assert.equal(await page.getByRole('button', { name: '批准当前版本', exact: true }).count(), 0)
        assert.equal((await page.evaluate(() => window.__complexEvidence.pending)).length, 0)
        await send('刷新后你还记得代号吗？只回复代号，不调用工具。')
        assert.deepEqual(await business(), businessBeforeRestart, '未完成审批的刷新不能增加业务写入')
      }
      results.push({ ui, duplicateWriterRejected: true, backendRestartHydrated: true, businessRestartHydrated: true, continuedAfterRestart: true, ...(ui === 'copilot' ? { pendingApprovalRefreshDidNotReplay: true } : {}) })
      console.log(`${ui}: 双标签写权冲突、落盘重启、恢复后继续均通过`)
    } catch (error) {
      await page.screenshot({ path: join(root, `${ui}-failed.png`), fullPage: true }).catch(() => {})
      await writeFile(join(root, `${ui}-failed.txt`), await page.locator('body').innerText())
      throw error
    } finally { await context.close() }
  }
} finally {
  await browser?.close()
  await app.close()
  await writeFile(join(root, 'results.json'), JSON.stringify({ real, browser: webkit ? 'Playwright WebKit' : 'installed Chrome', results }, null, 2))
  console.log(`生命周期证据：${root}/results.json`)
}
