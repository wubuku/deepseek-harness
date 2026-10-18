import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createComparisonServer } from '../server.mjs'

const imported = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? join(homedir(), 'node_modules/playwright/index.js'))
const playwright = imported.default ?? imported
const dataDir = await mkdtemp(join(tmpdir(), 'dsh-saas-lifecycle-'))
const artifacts = join(dataDir, 'artifacts')
await mkdir(artifacts)
const options = { dataDir, llmMode: 'scripted', distRoot: resolve(import.meta.dirname, '../../../../apps/web/dist') }
let app = await createComparisonServer(options)
let listening = false
let browser
const results = []
try {
  await app.listen(0)
  listening = true
  const address = app.server.address()
  const origin = `http://127.0.0.1:${address.port}`
  browser = await playwright.chromium.launch({ channel: 'chrome', headless: true })
  for (const ui of ['native', 'assistant', 'copilot']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    page.setDefaultTimeout(45000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    async function history() {
      const sessionId = new URL(page.url()).searchParams.get('sessionId')
      const response = await fetch(`${origin}/api/browser-native/session/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId, offset: 0, length: 10000 }) })
      assert.equal(response.status, 200)
      return (await response.json()).events
    }
    async function send(text) {
      const input = ui === 'native' ? page.locator('[contenteditable="true"]').first() : ui === 'copilot' ? page.getByTestId('copilot-chat-textarea') : page.getByRole('textbox', { name: '消息', exact: true })
      await input.fill(text)
      await input.press('Enter')
    }
    async function waitForTurn(seq) {
      const deadline = Date.now() + 45000
      while (Date.now() < deadline) {
        if ((await history()).some(event => event.type === 'turn/end' && event.seq > seq)) return
        if (errors.length > 0) throw new Error(errors.join('\n'))
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
      }
      throw new Error('DSH did not finish the lifecycle turn')
    }
    try {
      await page.goto(`${origin}/saas-agentic-ui-comparison-poc/index.html?ui=${ui}&workspace=lifecycle-${ui}`)
      await page.getByTestId('comparison-ready').waitFor()
      const preview = page.getByRole('button', { name: '继续', exact: true })
      if (await preview.isVisible()) await preview.click()
      const url = page.url()
      const sessionId = new URL(url).searchParams.get('sessionId')

      const second = await context.newPage()
      await second.goto(url)
      await second.waitForFunction(() => /会话写权不可用|启动失败/.test(document.body.innerText), { timeout: 45000 })
      assert.equal(new URL(second.url()).searchParams.get('sessionId'), sessionId)
      await second.screenshot({ path: join(artifacts, `${ui}-writer-conflict.png`) })
      await second.close()

      let seq = (await history()).at(-1)?.seq ?? -1
      await send('恢复验证第一句，请回复收到，不调用工具。')
      await waitForTurn(seq)
      const ownerToken = await page.evaluate(id => sessionStorage.getItem(`dsh-copilotkit-browser-native-owner:${id}`), sessionId)
      assert.ok(ownerToken)
      const flushed = await fetch(`${origin}/api/browser-native/session/flush`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId, ownerToken }) })
      assert.equal(flushed.status, 200)
      await page.goto('about:blank')
      await app.close()
      listening = false
      app = await createComparisonServer(options)
      await app.listen(address.port)
      listening = true
      await page.goto(url)
      await page.getByTestId('comparison-ready').waitFor()
      assert.equal(new URL(page.url()).searchParams.get('sessionId'), sessionId)
      seq = (await history()).at(-1).seq
      await send('恢复验证第二句，请回复收到，不调用工具。')
      await waitForTurn(seq)

      await send('请创建一个项目任务，标题为刷新中断验证，负责人林悦，优先级高，让我确认。')
      await page.locator('.chat-body [data-testid="business-form"]').waitFor()
      await page.reload()
      await page.getByTestId('comparison-ready').waitFor()
      assert.equal(await page.locator('.chat-body [data-testid="business-form"]').count(), 0)
      seq = (await history()).at(-1).seq
      await send('等待中的操作不再执行。请回复刷新后继续成功，不调用工具。')
      await waitForTurn(seq)
      const business = await (await fetch(`${origin}/api/saas/lifecycle-${ui}/snapshot`)).json()
      assert.equal(Object.keys(business.receipts).length, 0)
      assert.deepEqual(errors, [])
      const events = await history()
      assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 4)
      const result = { ui, writerConflict: true, flushedBackendRestart: true, pendingRefreshContinues: true, receipts: 0, errors }
      results.push(result)
      console.log('PASS', JSON.stringify(result))
      await page.screenshot({ path: join(artifacts, `${ui}-recovered.png`), fullPage: true })
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `${ui}-failure.png`), fullPage: true }).catch(() => {})
      await writeFile(join(artifacts, `${ui}-failure.txt`), `${error}\n${await page.locator('body').innerText()}`)
      throw error
    } finally { await context.close() }
  }
} finally {
  await browser?.close()
  if (listening) await app.close()
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify(results, null, 2))
  console.log(`Lifecycle evidence: ${artifacts}`)
}
