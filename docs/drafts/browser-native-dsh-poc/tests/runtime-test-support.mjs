/** Browser/runtime test helpers; all model and Session traffic uses the v2 backend. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const sessionPrincipalCookies = new Map()

/**
 * Send a v2 Session operation without logging owner tokens.
 * @param {string} origin - Same-origin backend URL.
 * @param {string} operation - Session route suffix.
 * @param {object} body - Operation fields.
 * @returns {Promise<object>} Parsed success or failure for explicit assertions.
 */
export async function sessionRequest(origin, operation, body = {}) {
  const cookie = sessionPrincipalCookies.get(body.sessionId)
  if (cookie === undefined) throw new Error(`No browser Session principal was captured for ${String(body.sessionId)}`)
  const response = await fetch(`${origin}/api/browser-native/session/${operation}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), ...body }),
  })
  return { status: response.status, ...await response.json() }
}

/**
 * Poll observable state with a diagnostic deadline, not a fixed readiness sleep.
 * @param {() => Promise<unknown>} observe - Return a truthy result when ready.
 * @param {string} label - Failure context.
 * @param {number} timeout - Outer wait budget.
 * @returns {Promise<unknown>} Ready result.
 */
export async function waitFor(observe, label, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await observe()
    if (result) return result
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out: ${label}`)
}

/**
 * Open the actual native preview and choose the Worker VFS workspace when required.
 * @param {import('playwright').Page} page - Browser page.
 * @param {string} url - Preview URL.
 * @returns {Promise<void>} Composer is visible.
 */
export async function openPreview(page, url) {
  const startedAt = Date.now()
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  return { elapsedMs: Date.now() - startedAt }
}

/**
 * Wait for the preview already loaded in the page to become interactive.
 * @param {import('playwright').Page} page - Page whose current navigation is the preview.
 * @returns {Promise<void>} Composer is visible after workspace setup.
 */
export async function waitForPreview(page) {
  await page.waitForSelector('[class*="frame"]', { timeout: 45_000 })
  const notice = page.getByRole('button', { name: /^(Continue|继续)$/ }).first()
  if (await notice.isVisible() && await notice.isEnabled()) await notice.click({ timeout: 15_000 })
  const chooser = page.getByRole('textbox', { name: /^(Choose workspace|选择工作区)$/ }).first()
  if (await chooser.isVisible()) {
    await chooser.click()
    const dialog = page.getByRole('dialog', { name: /^(Select Workspace Directory|选择工作区目录)$/ })
    await dialog.waitFor()
    const edit = dialog.getByRole('button', { name: /^(Edit path|编辑路径)$/ })
    if (await edit.isVisible()) await edit.click()
    const path = dialog.getByRole('textbox', { name: /^(Edit path|编辑路径)$/ })
    await path.fill('/dsh/home/')
    await path.press('Enter')
    await dialog.getByRole('button', { name: /^(Open|打开)$/ }).click()
  }
  await page.locator('[data-composer-input][contenteditable="true"]').last().waitFor({ timeout: 30_000 })
}

function eventText(event) {
  const content = event.data?.content ?? event.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

function eventTurn(event) {
  return typeof event.data?.turn === 'number' ? event.data.turn : undefined
}

/**
 * Extract authoritative assistant text, excluding user prompts and tool output.
 * @param {object} session - Read response.
 * @param {number} [turn] - Restrict the text to one Agent turn.
 * @returns {string} Assistant text from persisted messages.
 */
export function assistantText(session, turn) {
  return session.events.filter(event => event.type === 'assistant/message')
    .filter(event => turn === undefined || eventTurn(event) === turn)
    .flatMap(event => event.data.message.content).filter(block => block.type === 'text')
    .map(block => block.text).join('\n')
}

/**
 * Submit through the real composer and await the turn's terminal Session event.
 * @param {object} options - Page, backend, request capture and expected text.
 * @returns {Promise<object>} Settled Session response and id.
 */
export async function sendTurn({ page, origin, requests, prompt, marker, sessionId, timeout = 180_000, captureStream = false, probeWhileRunning }) {
  const result = await submitPrompt({ page, origin, requests, prompt, sessionId, timeout, captureStream, probeWhileRunning })
  if (marker !== undefined) {
    assert.equal(assistantText(result.session, result.turn).includes(marker), true,
      `Missing assistant marker ${marker} in turn ${String(result.turn)}; events=${result.session.events.map(event => event.type).join(',')}`)
  }
  return result
}

/**
 * Submit through the native composer and return after any terminal turn result.
 * @param {object} options - Page, backend, request capture and prompt.
 * @returns {Promise<object>} Settled Session response and id.
 */
export async function submitPrompt({ page, origin, requests, prompt, sessionId, timeout = 180_000, captureStream = false, probeWhileRunning, expectedReason = 'completed' }) {
  await page.locator('[data-composer-input][contenteditable="true"]').last().fill(prompt)
  if (captureStream) {
    await page.evaluate(() => {
      const capture = { samples: [], startedAt: performance.now(), previous: '', active: true, frame: 0 }
      const sample = () => {
        if (!capture.active) return
        const current = [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')]
          .map(node => node.textContent ?? '').join('\n').trim()
        if (current !== '' && current !== capture.previous) {
          capture.previous = current
          capture.samples.push({ elapsedMs: performance.now() - capture.startedAt, textLength: current.length })
        }
        capture.frame = requestAnimationFrame(sample)
      }
      window.__dshBrowserStreamCapture = capture
      capture.frame = requestAnimationFrame(sample)
    })
  }
  const send = page.getByRole('button', { name: /^(Send message|发送消息)$/ })
  const submittedAt = Date.now()
  await send.click()
  const streamSamples = []
  sessionId ??= await waitFor(async () => requests.find(request => request.path.endsWith('/session/create'))?.body.sessionId, 'Session creation')
  const sessionCookie = (await page.context().cookies(`${origin}/api/browser-native/session/create`))
    .find(cookie => cookie.name === 'dsh-browser-native-session-principal')
  assert.ok(sessionCookie, 'browser identity must authorize Session API requests')
  sessionPrincipalCookies.set(sessionId, `${sessionCookie.name}=${sessionCookie.value}`)
  const submitted = await waitFor(async () => {
    const current = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const userIndex = [...(current.events ?? [])].findLastIndex(event => event.type === 'user/message'
      && eventText(event).trim() === prompt.trim())
    if (userIndex < 0) return undefined
    return { session: current, userIndex }
  }, `user message for ${prompt.slice(0, 80)}`, timeout)
  const runningProbe = probeWhileRunning === undefined
    ? undefined
    : await probeWhileRunning({ page, requests, sessionId, submittedAt, timeout })
  const session = await waitFor(async () => {
    const current = await sessionRequest(origin, 'read', { sessionId, offset: 0 })
    const completed = (current.events ?? []).some((event, index) => index > submitted.userIndex && event.type === 'turn/end')
    return completed ? current : undefined
  }, `terminal turn for ${prompt.slice(0, 80)}`, timeout)
  const terminal = session.events.findLast((event, index) => index > submitted.userIndex && event.type === 'turn/end')
  assert.ok(terminal, `Missing terminal turn event for ${prompt.slice(0, 80)}`)
  const turn = terminal.data.turn
  if (expectedReason !== null) {
    assert.equal(terminal.data.reason.kind, expectedReason,
      `Turn ${String(turn)} ended as ${JSON.stringify(terminal.data.reason)}; expected ${expectedReason} for ${prompt.slice(0, 80)}`)
  }
  if (captureStream) {
    streamSamples.push(...await page.evaluate(() => {
      const capture = window.__dshBrowserStreamCapture
      if (capture !== undefined) {
        capture.active = false
        cancelAnimationFrame(capture.frame)
      }
      return capture?.samples ?? []
    }))
  }
  return { sessionId, session, turn, streamSamples, runningProbe, submittedAt, settledAt: Date.now(), elapsedMs: Date.now() - submittedAt }
}
