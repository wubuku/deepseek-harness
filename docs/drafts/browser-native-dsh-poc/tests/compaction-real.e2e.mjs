import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, sessionRequest, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const envFile = process.env.DSH_POC_ENV_FILE ?? 'docs/drafts/.env'
const contextWindow = Number(process.env.DSH_POC_CONTEXT_WINDOW ?? 32_768)
const dataDir = resolve(await mkdtemp(join(tmpdir(), 'dsh-browser-real-compaction-')))
const sentinel = `BROWSER_NATIVE_REAL_COMPACTION_SENTINEL_${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`
let image
let app
let browser
let page
const requests = []
const pageErrors = []
const externalRequests = []
let ownerToken

function requestBody(request) {
  try { return request.postDataJSON() ?? {} } catch { return {} }
}

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content ?? event.data?.summary
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

async function readSecretValues(file) {
  const text = await readFile(file, 'utf8')
  return text.split(/\r?\n/)
    .map(line => line.match(/^(OPENAI_NEXT_(?:GPT|GROK)_API_KEY)=(.*)$/)?.[2])
    .filter(value => value !== undefined && value.length > 0)
}

if (!Number.isSafeInteger(contextWindow) || contextWindow < 8_192) {
  throw new Error('DSH_POC_CONTEXT_WINDOW must be an integer of at least 8192')
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'real',
    envFile,
    contextWindow,
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) externalRequests.push(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    requests.push({ path: url.pathname, body: requestBody(request), status: undefined })
  })
  page.on('response', response => {
    const record = requests.find(candidate => candidate.path === new URL(response.url()).pathname
      && candidate.status === undefined)
    if (record !== undefined) record.status = response.status()
    if (response.url().endsWith('/session/open') || response.url().endsWith('/session/create')) {
      void response.json().then(payload => {
        if (typeof payload.owner?.ownerToken === 'string') ownerToken = payload.owner.ownerToken
      })
    }
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&preview-fixture=none`)
  const history = Array.from({ length: 180 }, (_, index) =>
    `Historical Browser-Native validation record ${index + 1}: preserve the distinction between the DSH Session event log, the Worker VFS, and the cloud Workspace receipt. `).join('\n')
  const first = await sendTurn({
    page,
    origin,
    requests,
    prompt: `Do not use tools. Keep the following project record available for later context. Reply concisely with the marker BROWSER_NATIVE_REAL_COMPACTION_READY.\n${history}\nCritical exact fact that must survive compaction: the identifier is ${sentinel}. Repeat that identifier exactly in your response.`,
    marker: 'BROWSER_NATIVE_REAL_COMPACTION_READY',
    timeout: 180_000,
  })
  ownerToken = await waitFor(() => ownerToken, 'Session owner token', 30_000)
  const beforeCompact = await sessionRequest(origin, 'read', { sessionId: first.sessionId, offset: 0 })
  assert.equal(beforeCompact.status, 200)
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill('/compact')
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const afterCompact = await waitFor(async () => {
    const current = await sessionRequest(origin, 'read', { sessionId: first.sessionId, offset: 0 })
    return current.events.some((event, index) => index >= beforeCompact.events.length && event.type === 'compaction/end')
      ? current
      : undefined
  }, 'real LLM compaction completion', 180_000)
  const summaries = afterCompact.events.filter(event => event.type === 'compaction/summary')
  const compactionEnds = afterCompact.events.filter(event => event.type === 'compaction/end')
  assert.ok(summaries.length > 0, `real /compact must persist a summary event; events=${afterCompact.events.map(event => event.type).join(',')}; ends=${JSON.stringify(compactionEnds.map(event => event.data.error ?? null))}; purposes=${JSON.stringify(requests.filter(request => request.path.endsWith('/llm')).map(request => request.body.purpose ?? 'conversation'))}`)
  assert.equal(compactionEnds.length, summaries.length)
  assert.ok(summaries.some(event => eventText(event).includes(sentinel)),
    'the real compaction summary must retain the sentinel')
  const llmCountBeforeReload = requests.filter(request => request.path.endsWith('/llm')).length
  const compactFlush = await sessionRequest(origin, 'flush', { sessionId: first.sessionId, ownerToken })
  assert.equal(compactFlush.status, 200)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  await page.getByText('BROWSER_NATIVE_REAL_COMPACTION_READY', { exact: false }).last().waitFor({ timeout: 30_000 })
  const afterReload = await sessionRequest(origin, 'read', { sessionId: first.sessionId, offset: 0 })
  assert.deepEqual(afterReload.events.slice(0, afterCompact.events.length), afterCompact.events)
  assert.equal(requests.filter(request => request.path.endsWith('/llm')).length, llmCountBeforeReload,
    'refresh must hydrate a compacted Session without replaying an LLM request')

  const recall = await sendTurn({
    page,
    origin,
    requests,
    sessionId: first.sessionId,
    prompt: `What exact identifier did I ask you to remember? Do not use tools. Reply with ${sentinel} and the marker BROWSER_NATIVE_REAL_COMPACTION_RECALL.`,
    marker: 'BROWSER_NATIVE_REAL_COMPACTION_RECALL',
    timeout: 180_000,
  })
  const recalled = assistantText(recall.session, recall.turn).includes(sentinel)
  assert.equal(recalled, true, 'the real model must recall the sentinel after compaction and refresh')
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(externalRequests, [])
  const serializedRequests = JSON.stringify(requests)
  const browserWire = JSON.stringify(requests.map(request => ({ path: request.path, body: request.body })))
  for (const secret of await readSecretValues(envFile)) {
    assert.equal(serializedRequests.includes(secret), false)
    assert.equal(browserWire.includes(secret), false)
  }
  assert.equal(requests.some(request => request.path.endsWith('/llm') && request.body.purpose === 'compaction'), true)
  assert.equal(requests.every(request => request.status === undefined || request.status < 400), true,
    `unexpected Browser-Native response status: ${JSON.stringify(requests.map(request => ({ path: request.path, status: request.status })))}`)
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    mode: 'real',
    contextWindow,
    sessionId: first.sessionId,
    eventCountAfterCompact: afterCompact.events.length,
    summaryCount: summaries.length,
    compactEndCount: compactionEnds.length,
    recalled,
    llmCountBeforeReload,
    llmCountAfterRecall: requests.filter(request => request.path.endsWith('/llm')).length,
    pageErrors,
    externalRequestCount: externalRequests.length,
  })}\n`)
} finally {
  await page?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  await rm(dataDir, { recursive: true, force: true })
}
