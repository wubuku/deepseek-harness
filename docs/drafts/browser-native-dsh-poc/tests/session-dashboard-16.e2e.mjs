/**
 * 16-Session dashboard cost and state rendering.
 *
 * Seeds 16 persisted Sessions, reloads the preview, and measures the session
 * sidebar at that scale: first-page render, expanding the folded list, opening
 * a Session, switching to another, switching while a turn holds the admission
 * slot, and interaction after a model failure. It also checks that a queued
 * prompt reports a live queue position that advances when the request ahead is
 * admitted, and that a terminal failure renders its code through the shipped
 * Tag component rather than a bare `<code>` element.
 *
 * Usage:
 *   DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-dashboard-16.e2e.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
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
const QUEUE_MARKER = 'DASHBOARD_QUEUE_HEAD'
const QUEUE_TAIL_MARKER = 'DASHBOARD_QUEUE_TAIL'
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
    admission: { maxConcurrentTurns: 1, queueTimeoutMs: 25_000 },
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
        if (text.includes(QUEUE_MARKER) || text.includes(QUEUE_TAIL_MARKER)) {
          // Keep the admitted head request open so the queued prompt's advance
          // to position 1 stays observable across the 400 ms queue poll.
          return { kind: 'delayed-text', delayMs: 3_000, text: 'DASHBOARD_QUEUE_HEAD_COMPLETE' }
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

  const readQueueNotice = async target => {
    const notice = target.locator('[data-browser-native-queue-status]')
    if (await notice.count() === 0) return undefined
    const state = await notice.getAttribute('data-state')
    if (state === null || await notice.isHidden()) return undefined
    const position = Number(await notice.getAttribute('data-position'))
    return {
      state,
      position,
      queued: Number(await notice.getAttribute('data-queued')),
      text: await notice.innerText(),
    }
  }
  const admissionQueue = async () => (await fetch(`${origin}/api/browser-native/admission`).then(response => response.json())).queue ?? []

  const holdTurn = submitPrompt({ page, origin, requests: [], prompt: HOLD_MARKER, sessionId: 'dashboard-session-15', timeout: 120_000 })
  holdTurn.catch(() => {})
  await waitFor(async () => holdStarted || undefined, 'held turn occupies the admission slot', 30_000)

  const switchDuringTurnMs = await openSeeded(0)

  // A Session-less direct model request takes the first queue place without a
  // second preview tab, whose own boot requests would otherwise queue behind
  // this held slot and delay the tab past the queue timeout.
  const headRequestId = randomUUID()
  const headRequest = fetch(`${origin}/api/browser-native/llm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-browser-native-protocol': '1' },
    body: JSON.stringify({
      protocolVersion: 1,
      requestId: headRequestId,
      provider: 'scripted',
      model: 'scripted',
      messages: [{ role: 'user', content: QUEUE_TAIL_MARKER }],
    }),
  })
  headRequest.catch(() => {})
  await waitFor(async () => (await admissionQueue()).some(entry => entry.requestId === headRequestId) || undefined,
    'direct request takes the first queue place', 15_000)

  const queuedTurn = submitPrompt({
    page,
    origin,
    requests: [],
    prompt: QUEUE_MARKER,
    sessionId: 'dashboard-session-00',
    timeout: 120_000,
  })
  queuedTurn.catch(() => {})
  const secondQueueNotice = await waitFor(async () => {
    const notice = await readQueueNotice(page)
    return notice?.state === 'queued' && notice.position === 2 ? notice : undefined
  }, 'queued prompt reports position 2 behind the direct request', 30_000)
  assert.equal(secondQueueNotice.queued, 2, `queued prompt must see two waiters: ${secondQueueNotice.text}`)

  holdRelease.resolve()
  await holdTurn
  const advancedQueueNotice = await waitFor(async () => {
    const notice = await readQueueNotice(page)
    return notice?.state === 'queued' && notice.position === 1 ? notice : undefined
  }, 'queue position advances after the request ahead is admitted', 30_000)
  assert.equal(advancedQueueNotice.queued, 1, `advanced queue must see one waiter: ${advancedQueueNotice.text}`)
  const queuedCompleted = await queuedTurn
  assert.equal(queuedCompleted.turn > 0, true)
  const headResponse = await headRequest
  await headResponse.text()
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
  const failureCode = page.locator('[data-turn-error-code="DASHBOARD_INJECTED_FAILURE"]').last()
  await failureCode.waitFor({ timeout: 15_000 })
  assert.equal(await page.locator('[data-turn-error-code="DASHBOARD_INJECTED_FAILURE"] code').count(), 0,
    'failure code must render through the Tag component, not a bare <code> element')
  assert.equal(await page.locator('code').filter({ hasText: 'DASHBOARD_INJECTED_FAILURE' }).count(), 0,
    'failure code must not appear in a bare <code> element')
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
      failureRenderedBy: 'Tag',
      listInteractiveAfterFailure: true,
      idleRowsWithoutStatus: true,
      backgroundCompletionStatus: completedText,
      queueNotice: {
        second: secondQueueNotice.text,
        advanced: advancedQueueNotice.text,
        positionChange: '2 -> 1',
      },
      queueStateInList: 'not surfaced in the dashboard; queued prompts render in the active composer',
    },
  }, null, 2))
} finally {
  if (pageErrors.length > 0) console.error('pageErrors', JSON.stringify(pageErrors, null, 2))
  if (app !== undefined) await app.close().catch(() => {})
  if (browser !== undefined) await browser.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
