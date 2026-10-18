import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const importedPlaywright = await import(playwrightPath)
const playwright = importedPlaywright.default ?? importedPlaywright
const projectDirectory = resolve(import.meta.dirname, '..')
const runPath = join(projectDirectory, 'run.mjs')
const dataDirectory = await mkdtemp(join(tmpdir(), 'copilotkit-browser-native-restart-'))
const artifactDirectory = resolve(process.env.COPILOTKIT_POC_ARTIFACT_DIR ?? join(dataDirectory, 'artifacts'))
const probePort = createServer()
await new Promise((resolveListen, reject) => probePort.listen(0, '127.0.0.1', resolveListen).once('error', reject))
const address = probePort.address()
if (address === null || typeof address === 'string') throw new Error('could not allocate an E2E port')
const port = address.port
await new Promise((resolveClose, reject) => probePort.close(error => error === undefined ? resolveClose() : reject(error)))
const origin = `http://127.0.0.1:${port}`
const appUrl = `${origin}/copilotkit-browser-native-dsh-poc/index.html`
const servers = []
const browser = await playwright.chromium.launch({ headless: true, channel: 'chrome' })

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

async function waitFor(label, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function startServer() {
  const child = spawn(process.execPath, [runPath, '--port', String(port), '--data-dir', dataDirectory, '--llm', 'scripted'], {
    cwd: resolve(projectDirectory, '../../..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', text => { output += text })
  child.stderr.setEncoding('utf8').on('data', text => { output += text })
  servers.push(child)
  await waitFor('backend startup', async () => {
    if (child.exitCode !== null) throw new Error(`backend exited early: ${output}`)
    try {
      const response = await fetch(appUrl)
      return response.status === 200
    } catch {
      return false
    }
  })
  return child
}

async function stopServer(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('backend did not stop after SIGTERM')), 10000)
    child.once('exit', () => { clearTimeout(timer); resolveExit() })
  })
}

async function readSession(sessionId) {
  const response = await fetch(`${origin}/api/browser-native/session/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-browser-native-protocol': '1' },
    body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), sessionId, offset: 0, length: 10000 }),
  })
  assert.equal(response.status, 200)
  return response.json()
}

async function assertHydrated(sessionId, prompt) {
  await mkdir(artifactDirectory, { recursive: true })
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`${appUrl}?sessionId=${encodeURIComponent(sessionId)}&restart=${randomUUID()}`, { waitUntil: 'domcontentloaded' })
    await page.locator('.dsh-workbench').waitFor({ state: 'visible', timeout: 20000 })
    await waitFor('hydrated prompt after backend restart', async () => (await page.locator('[data-testid="copilot-message-list"]').textContent()).includes(prompt))
    await waitFor('restored scripted response', async () => (await page.locator('[data-testid="copilot-message-list"]').textContent()).includes('Browser-native DSH completed this turn'))
    await page.screenshot({ path: join(artifactDirectory, `restart-hydrated-${randomUUID()}.png`), fullPage: true })
    const session = await readSession(sessionId)
    assert.equal(session.events.filter(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === prompt)).length, 1)
    assert.deepEqual(errors, [])
    return { page, context, session }
  } catch (error) {
    await context.close()
    throw error
  }
}

try {
  await startServer()
  const context = await browser.newContext()
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const prompt = `persist across backend restart ${randomUUID()}`
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('.dsh-workbench').waitFor({ state: 'visible', timeout: 20000 })
  await page.getByTestId('copilot-chat-textarea').fill(prompt)
  await page.getByTestId('copilot-chat-textarea').press('Enter')
  await waitFor('scripted turn completion', () => page.locator('.copilotKitChat').getAttribute('data-copilot-running').then(value => value === 'false'))
  await waitFor('scripted response', async () => (await page.locator('[data-testid="copilot-message-list"]').textContent()).includes('Browser-native DSH completed this turn'))
  const sessionId = new URL(page.url()).searchParams.get('sessionId')
  assert.ok(sessionId)
  const ownerToken = await waitFor('Session write token', async () => page.evaluate(id => sessionStorage.getItem(`dsh-copilotkit-browser-native-owner:${id}`), sessionId))
  const flush = await page.evaluate(async ({ id, token }) => fetch('/api/browser-native/session/flush', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-browser-native-protocol': '1' },
    body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId: id, ownerToken: token }),
  }).then(async response => ({ status: response.status, body: await response.json() })), { id: sessionId, token: ownerToken })
  assert.equal(flush.status, 200)
  assert.equal(flush.body.durable, true)
  assert.equal(flush.body.durableThroughSeq, flush.body.nextSeq - 1)
  assert.deepEqual(pageErrors, [])
  await context.close()
  await stopServer(servers[0])

  await startServer()
  const restored = await assertHydrated(sessionId, prompt)
  const restoredOwner = await waitFor('restored Session write token', async () => restored.page.evaluate(id => sessionStorage.getItem(`dsh-copilotkit-browser-native-owner:${id}`), sessionId))
  const secondFlush = await restored.page.evaluate(async ({ id, token }) => fetch('/api/browser-native/session/flush', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-browser-native-protocol': '1' },
    body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), sessionId: id, ownerToken: token }),
  }).then(async response => ({ status: response.status, body: await response.json() })), { id: sessionId, token: restoredOwner })
  assert.equal(secondFlush.status, 200)
  assert.equal(secondFlush.body.durable, true)
  const eventCount = restored.session.events.length
  await restored.context.close()
  await stopServer(servers[1])

  await startServer()
  const afterSecondRestart = await assertHydrated(sessionId, prompt)
  assert.equal(afterSecondRestart.session.events.length, eventCount)
  await afterSecondRestart.context.close()
  process.stdout.write(`${JSON.stringify({ result: 'passed', browser: 'chrome', origin, sessionId, eventCount, flushSeq: flush.body.durableThroughSeq, afterRestartEventCount: afterSecondRestart.session.events.length, dataDirectory, artifactDirectory, pageErrors })}\n`)
} finally {
  for (const child of servers) await stopServer(child).catch(() => {})
  await browser.close()
}
