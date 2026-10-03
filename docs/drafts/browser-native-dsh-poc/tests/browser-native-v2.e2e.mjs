import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const { chromium } = await import(playwrightModule)

const mode = process.env.DSH_POC_LLM ?? 'scripted'
const envFile = process.env.DSH_POC_ENV_FILE
const port = Number(process.env.DSH_POC_PORT ?? '4196')
const distRoot = resolve(process.env.DSH_POC_DIST_ROOT ?? 'apps/web/dist')
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'browser-native-dsh-v2-e2e-')))
const prompt = mode === 'real'
  ? '请只回复：BROWSER_NATIVE_REAL_E2E_OK'
  : '请回复：BROWSER_NATIVE_SCRIPTED_E2E_OK'

const localNoProxy = new Set((process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').filter(Boolean))
localNoProxy.add('127.0.0.1')
localNoProxy.add('localhost')
process.env.NO_PROXY = [...localNoProxy].join(',')
process.env.no_proxy = process.env.NO_PROXY

if (mode !== 'scripted' && mode !== 'real') throw new Error('DSH_POC_LLM must be scripted or real')
if (mode === 'real' && envFile === undefined) throw new Error('DSH_POC_ENV_FILE is required for real mode')
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')

function requestJson(request) {
  const body = request.postData()
  if (body === null) return undefined
  try { return JSON.parse(body) } catch { return undefined }
}

async function clickPreviewNotice(page) {
  const button = page.getByRole('button', { name: /^(Continue|继续)$/ }).first()
  if (await button.count() > 0 && await button.isVisible()) await button.click()
}

async function chooseWorkspace(page) {
  const chooser = page.getByRole('textbox', { name: /^(Choose workspace|选择工作区)$/ }).first()
  await chooser.click()
  const dialog = page.getByRole('dialog', { name: /^(Select Workspace Directory|选择工作区目录)$/ })
  await dialog.waitFor({ timeout: 15_000 })
  const editPath = dialog.getByRole('button', { name: /^(Edit path|编辑路径)$/ })
  if (await editPath.count() > 0 && await editPath.isVisible()) await editPath.click()
  const pathInput = dialog.getByRole('textbox', { name: /^(Edit path|编辑路径)$/ })
  if (await pathInput.count() > 0) {
    await pathInput.fill('/dsh/home/')
    await pathInput.press('Enter')
  }
  await dialog.getByRole('button', { name: /^(Open|打开)$/ }).click()
}

async function readSession(origin, id) {
  const response = await fetch(`${origin}/api/browser-native/session/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, requestId: `e2e-read-${id}`, sessionId: id, offset: 0 }),
  })
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  return body
}

async function waitForSession(origin, id, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await readSession(origin, id)
    if (predicate(latest)) return latest
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  throw new Error(`Session did not reach the expected state; event types: ${JSON.stringify(latest?.events?.map(event => event.type) ?? [])}`)
}

async function readSecrets(file) {
  if (file === undefined) return []
  const text = await readFile(file, 'utf8')
  return text.split(/\r?\n/)
    .map(line => line.match(/^(OPENAI_NEXT_(?:GPT|GROK)_API_KEY)=(.*)$/)?.[2])
    .filter(value => value !== undefined && value.length > 0)
}

const app = await createBrowserNativeV2Server({ dataDir, distRoot, llmMode: mode, envFile })
const origin = await app.listen(port)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
const requests = []
const pageErrors = []
page.on('request', request => {
  if (request.url().includes('/api/browser-native/')) requests.push({ url: request.url(), method: request.method(), body: requestJson(request) })
})
page.on('pageerror', error => pageErrors.push(error.message))

try {
  await page.goto(`${origin}/preview.html?browser-native=1&preview-fixture=none`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  await clickPreviewNotice(page)
  await chooseWorkspace(page)
  await page.getByText('Browser-native remote', { exact: true }).waitFor({ timeout: 15_000 })

  const input = page.locator('[data-composer-input][contenteditable="true"]').last()
  await input.waitFor({ timeout: 15_000 })
  await input.fill(prompt)
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()

  const creationDeadline = Date.now() + 15_000
  let createRequest
  while (createRequest === undefined && Date.now() < creationDeadline) {
    createRequest = requests.find(request => request.url.endsWith('/session/create'))
    if (createRequest === undefined) await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  assert.notEqual(createRequest, undefined, 'the Web UI did not create a remote Session')
  assert.equal(typeof createRequest.body.sessionId, 'string')
  const session = await waitForSession(origin, createRequest.body.sessionId, value => {
    const eventTypes = value.events.map(event => event.type)
    return eventTypes.includes('user/message') || eventTypes.includes('agent/inbox/spliced')
      ? eventTypes.includes('assistant/message')
      : false
  }, mode === 'real' ? 180_000 : 30_000)
  const eventTypes = session.events.map(event => event.type)
  assert.equal(eventTypes.includes('user/message') || eventTypes.includes('agent/inbox/spliced'), true, JSON.stringify(eventTypes))
  assert.equal(eventTypes.includes('assistant/message'), true, JSON.stringify(eventTypes))
  const sessionText = JSON.stringify(session.events)
  assert.equal(sessionText.includes(prompt), true, 'the persisted user message did not contain the submitted prompt')
  assert.equal(sessionText.includes(mode === 'real' ? 'BROWSER_NATIVE_REAL_E2E_OK' : 'BROWSER_NATIVE_SCRIPTED_E2E_OK'), true,
    'the persisted assistant response did not contain the provider marker')
  assert.equal(requests.some(request => request.url.endsWith('/session/flush')), true)
  assert.equal(requests.some(request => request.url.endsWith('/llm')), true)
  assert.deepEqual(pageErrors, [])

  const durableRecord = JSON.parse(await readFile(join(dataDir, 'sessions', `${createRequest.body.sessionId}.json`), 'utf8'))
  assert.equal(durableRecord.durableThroughSeq, durableRecord.events.length - 1)

  const browserWire = JSON.stringify(requests)
  for (const secret of await readSecrets(envFile)) assert.equal(browserWire.includes(secret), false)

  process.stdout.write(`${JSON.stringify({
    mode,
    model: app.llm.model,
    sessionId: createRequest.body.sessionId,
    eventCount: session.events.length,
    durableThroughSeq: session.durableThroughSeq,
    browserApiRoutes: [...new Set(requests.map(request => new URL(request.url).pathname))],
  })}\n`)
} finally {
  await page.close()
  await browser.close()
  await app.close()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
