/**
 * 16-Session dashboard cost and state rendering.
 *
 * Seeds 16 persisted Sessions, reloads the preview, and measures the session
 * sidebar at that scale: first-page render, expanding the folded list, opening
 * a Session, switching to another, switching while a turn holds the admission
 * slot, and interaction after a model failure. It also checks that a queued
 * prompt reports its queue position and that the failure stays visible while
 * the list remains interactive.
 *
 * Usage:
 *   DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-dashboard-16.e2e.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, submitPrompt, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const SESSIONS = 16
/** Observed upper bounds for the 16-Session dashboard on the PoC backend. */
const LIMITS = {
  reloadMs: 8_000,
  listMs: 1_500,
  expandMs: 1_500,
  openMs: 3_000,
  switchMs: 1_000,
  switchDuringTurnMs: 2_000,
  postFailureMs: 1_500,
}
const HOLD_MARKER = 'DASHBOARD_HOLD'
const QUEUE_MARKER = 'DASHBOARD_QUEUE'
const FAIL_MARKER = 'DASHBOARD_FAIL'

function deferred() {
  let resolvePromise
  const promise = new Promise(resolveRelease => { resolvePromise = resolveRelease })
  return { promise, resolve: resolvePromise }
}

const holdRelease = deferred()
let holdStarted = false

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-dashboard-'))
const pageErrors = []
let image
let app
let browser
let page

function rowTitles() {
  return page.locator('[data-row-key^="session:"]')
}

function sessionRow(index) {
  return page.locator(`[data-row-key="session:dashboard-session-${String(index).padStart(2, '0')}"]`)
}

function sessionMarker(index) {
  return `DASHBOARD_SESSION_${String(index).padStart(2, '0')}`
}

async function openSeeded(index) {
  const startedAt = Date.now()
  await sessionRow(index).first().click()
  await page.getByText(sessionMarker(index), { exact: true }).last().waitFor({ timeout: 15_000 })
  return Date.now() - startedAt
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    admission: { maxConcurrentTurns: 1, queueTimeoutMs: 3_000 },
    testHooks: {
      scriptedLlmFault: body => {
        const text = JSON.stringify(body.messages ?? [])
        if (text.includes(HOLD_MARKER)) {
          holdStarted = true
          return { kind: 'barrier-text', text: 'DASHBOARD_HOLD_RELEASED', release: holdRelease.promise }
        }
        if (text.includes(FAIL_MARKER)) {
          return { kind: 'error', code: 'DASHBOARD_INJECTED_FAILURE', message: 'scripted dashboard failure' }
        }
        return undefined
      },
    },
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  await waitForPreview(page)

  const identity = await page.evaluate(async () => await fetch('/api/browser-native/workspace/identity', { method: 'GET' }).then(response => response.status))
  assert.equal(identity, 200)

  const seeded = await page.evaluate(async ({ count }) => {
    const baseTime = Date.now() - count * 1_000
    const ids = []
    for (let index = 0; index < count; index += 1) {
      const id = `dashboard-session-${String(index).padStart(2, '0')}`
      const marker = `DASHBOARD_SESSION_${String(index).padStart(2, '0')}`
      const poster = async (operation, body) => {
        const response = await fetch(`/api/browser-native/session/${operation}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), ...body }),
        })
        const payload = await response.json()
        if (response.status !== 200) throw new Error(`${operation} failed: ${JSON.stringify(payload)}`)
        return payload
      }
      const created = await poster('create', {
        sessionId: id,
        header: { version: 4, id, createdAt: baseTime + index * 1_000, isSeeded: false, cwd: '/dsh/home/' },
      })
      const time = baseTime + index * 1_000
      await poster('append', {
        sessionId: id,
        ownerToken: created.owner.ownerToken,
        ownerEpoch: created.owner.ownerEpoch,
        expectedNextSeq: 0,
        events: [
          {
            seq: 0,
            type: 'user/message',
            time,
            surfaceOp: 'append',
            data: {
              id: `${id}-message`,
              role: 'user',
              source: { kind: 'user' },
              content: [{ type: 'text', text: marker }],
            },
          },
        ],
      })
      await poster('close', { sessionId: id, ownerToken: created.owner.ownerToken })
      ids.push(id)
    }
    return ids
  }, { count: SESSIONS })
  assert.equal(seeded.length, SESSIONS)

  const reloadedAt = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  const previewReadyAt = Date.now()
  await waitFor(async () => await rowTitles().count() >= 5, 'first dashboard page', 15_000)
  const listMs = Date.now() - previewReadyAt

  const expandStartedAt = Date.now()
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const showMore = page.getByRole('button', { name: /^Show \d+ more sessions$/ })
    if (await showMore.count() === 0) break
    const before = await rowTitles().count()
    await showMore.first().click()
    await waitFor(async () => {
      const after = await rowTitles().count()
      const remaining = await page.getByRole('button', { name: /^Show \d+ more sessions$/ }).count()
      return after > before || remaining === 0 ? after : undefined
    }, 'dashboard expansion step', 10_000)
  }
  const expandMs = Date.now() - expandStartedAt
  const rowCount = await rowTitles().count()
  assert.ok(rowCount >= SESSIONS, `dashboard must list all seeded Sessions: ${rowCount}`)

  for (const index of [0, 15]) {
    const text = await sessionRow(index).textContent()
    assert.ok(text?.includes('Untitled'), `seeded row ${index} must show the unnamed title: ${text}`)
    assert.doesNotMatch(text ?? '', /(Running|Completed|Waiting|运行中|已完成)/, `idle row ${index} must not show a live status: ${text}`)
  }

  const openMs = await openSeeded(0)
  const switchMs = await openSeeded(15)

  const holdTurn = submitPrompt({ page, origin, requests: [], prompt: HOLD_MARKER, sessionId: 'dashboard-session-15', timeout: 120_000 })
  holdTurn.catch(() => {})
  await waitFor(async () => holdStarted || undefined, 'held turn occupies the admission slot', 30_000)

  const switchDuringTurnMs = await openSeeded(0)
  const queuedTurn = submitPrompt({
    page,
    origin,
    requests: [],
    prompt: QUEUE_MARKER,
    sessionId: 'dashboard-session-00',
    expectedReason: 'error',
    timeout: 120_000,
  })
  queuedTurn.catch(() => {})
  const queueText = await waitFor(async () => {
    const queued = page.getByText(/queue position \d+/).last()
    return await queued.count() > 0 ? await queued.innerText() : undefined
  }, 'queued prompt reports its queue position', 30_000)
  assert.match(queueText, /queue position 1/)
  const queuedFailure = await queuedTurn
  const queuedTerminal = queuedFailure.session.events.findLast(event => event.type === 'turn/end' && event.data.turn === queuedFailure.turn)
  assert.equal(queuedTerminal.data.reason.error.code, 'ADMISSION_TIMEOUT')
  await page.locator('code').filter({ hasText: 'ADMISSION_TIMEOUT' }).last().waitFor({ timeout: 15_000 })

  holdRelease.resolve()
  await holdTurn
  const completedText = await waitFor(async () => {
    const text = await sessionRow(15).textContent()
    return text !== null && /Completed/.test(text) ? text : undefined
  }, 'completed status on the background Session row', 20_000)

  const failure = await submitPrompt({
    page,
    origin,
    requests: [],
    prompt: FAIL_MARKER,
    sessionId: 'dashboard-session-00',
    expectedReason: 'error',
    timeout: 120_000,
  })
  const failureTerminal = failure.session.events.findLast(event => event.type === 'turn/end' && event.data.turn === failure.turn)
  assert.equal(failureTerminal.data.reason.error.code, 'DASHBOARD_INJECTED_FAILURE')
  await page.locator('code').filter({ hasText: 'DASHBOARD_INJECTED_FAILURE' }).last().waitFor({ timeout: 15_000 })
  await page.getByText('scripted dashboard failure', { exact: false }).last().waitFor({ timeout: 15_000 })

  const rowsAfterFailure = await rowTitles().count()
  assert.ok(rowsAfterFailure >= SESSIONS, `failure must not remove dashboard rows: ${rowsAfterFailure}`)
  const postFailureMs = await openSeeded(15)

  assert.ok(previewReadyAt - reloadedAt <= LIMITS.reloadMs, `reload ${previewReadyAt - reloadedAt}ms exceeds ${LIMITS.reloadMs}ms`)
  assert.ok(listMs <= LIMITS.listMs, `list ${listMs}ms exceeds ${LIMITS.listMs}ms`)
  assert.ok(expandMs <= LIMITS.expandMs, `expand ${expandMs}ms exceeds ${LIMITS.expandMs}ms`)
  assert.ok(openMs <= LIMITS.openMs, `open ${openMs}ms exceeds ${LIMITS.openMs}ms`)
  assert.ok(switchMs <= LIMITS.switchMs, `switch ${switchMs}ms exceeds ${LIMITS.switchMs}ms`)
  assert.ok(switchDuringTurnMs <= LIMITS.switchDuringTurnMs, `switch during turn ${switchDuringTurnMs}ms exceeds ${LIMITS.switchDuringTurnMs}ms`)
  assert.ok(postFailureMs <= LIMITS.postFailureMs, `post-failure switch ${postFailureMs}ms exceeds ${LIMITS.postFailureMs}ms`)
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'))

  console.log(JSON.stringify({
    scope: 'browser-session-dashboard-16',
    sessions: SESSIONS,
    rows: rowCount,
    timings: { reloadMs: previewReadyAt - reloadedAt, listMs, expandMs, openMs, switchMs, switchDuringTurnMs, postFailureMs },
    acceptableLimits: LIMITS,
    states: {
      failureVisible: true,
      listInteractiveAfterFailure: true,
      idleRowsWithoutStatus: true,
      backgroundCompletionStatus: completedText,
      queueText,
      queueStateInList: 'not surfaced in the dashboard; queued prompts render in the active composer',
    },
  }, null, 2))
} finally {
  if (pageErrors.length > 0) console.error('pageErrors', JSON.stringify(pageErrors, null, 2))
  if (app !== undefined) await app.close().catch(() => {})
  if (browser !== undefined) await browser.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
