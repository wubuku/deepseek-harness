/**
 * Session-list scaling at 220 persisted Sessions.
 *
 * Seeds 220 Sessions through the browser-native backend, reloads the preview so
 * the shipped sidebar rebuilds its catalog, and measures the three list
 * mechanisms the user asked to scale: initial pagination, search, and ordering.
 * It also counts the backend `session/list` page requests the sidebar's list
 * costs at this size.
 *
 * Usage:
 *   DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-list-scale.e2e.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { openPreview, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const SESSIONS = 220
const SEARCH_INDEX = SESSIONS - 3
const SEARCH_CWD = '/dsh/home/scale-search'
const SEARCH_QUERY = 'scale-search'
const BACKEND_PAGE_SIZE = 100
const WATERMARK_STEP = 5
/** Observed upper bounds for 220 persisted Sessions on the PoC backend. */
const LIMITS = {
  reloadMs: 10_000,
  listMs: 2_500,
  expandMs: 20_000,
  searchMs: 2_000,
  listRequests: 2 * Math.ceil(SESSIONS / BACKEND_PAGE_SIZE) + 2,
}

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-session-list-scale-'))
const pageErrors = []
const listRequests = []
let app
let browser
let page

function sessionId(index) {
  return `scale-session-${String(index).padStart(3, '0')}`
}

function sessionRow(index) {
  return page.locator(`[data-row-key="session:${sessionId(index)}"]`)
}

function visibleRows() {
  return page.locator('[data-row-key^="session:scale-session-"]')
}

try {
  app = await createBrowserNativeV2Server({ dataDir, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).pathname !== '/api/browser-native/session/list') return
    let cursor
    try {
      cursor = JSON.parse(request.postData() ?? '{}').cursor
    } catch {
      cursor = undefined
    }
    listRequests.push(cursor === undefined ? 'first' : 'next')
  })

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`)
  await waitForPreview(page)

  const identity = await page.evaluate(async () => await fetch('/api/browser-native/workspace/identity', { method: 'GET' }).then(response => response.status))
  assert.equal(identity, 200)

  const seeded = await page.evaluate(async ({ count, searchIndex, searchCwd }) => {
    const baseTime = Date.now() - count * 1_000
    const ids = []
    for (let index = 0; index < count; index += 1) {
      const id = `scale-session-${String(index).padStart(3, '0')}`
      const cwd = index === searchIndex ? searchCwd : '/dsh/home/'
      const marker = `SCALE_SESSION_${String(index).padStart(3, '0')}`
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
        header: { version: 4, id, createdAt: baseTime + index * 1_000, isSeeded: false, cwd },
      })
      await poster('append', {
        sessionId: id,
        ownerToken: created.owner.ownerToken,
        ownerEpoch: created.owner.ownerEpoch,
        expectedNextSeq: 0,
        events: [{
          seq: 0,
          type: 'user/message',
          time: baseTime + index * 1_000,
          surfaceOp: 'append',
          data: {
            id: `${id}-message`,
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: marker }],
          },
        }],
      })
      await poster('close', { sessionId: id, ownerToken: created.owner.ownerToken })
      ids.push(id)
    }
    return ids
  }, { count: SESSIONS, searchIndex: SEARCH_INDEX, searchCwd: SEARCH_CWD })
  assert.equal(seeded.length, SESSIONS)

  listRequests.length = 0
  const reloadedAt = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  const previewReadyAt = Date.now()
  await waitFor(async () => await visibleRows().count() >= 1 ? true : undefined, 'first session page', 60_000)
  const listMs = Date.now() - previewReadyAt

  const expandStartedAt = Date.now()
  let expandClicks = 0
  for (; expandClicks < 60; expandClicks += 1) {
    const showMore = page.getByRole('button', { name: /^Show \d+ more sessions$/ })
    if (await showMore.count() === 0) break
    const before = await visibleRows().count()
    await showMore.first().click()
    await waitFor(async () => {
      const after = await visibleRows().count()
      const remaining = await page.getByRole('button', { name: /^Show \d+ more sessions$/ }).count()
      return after > before || remaining === 0 ? true : undefined
    }, 'session expansion step', 10_000)
  }
  const expandMs = Date.now() - expandStartedAt
  const rowCount = await visibleRows().count()
  assert.ok(rowCount >= SESSIONS - 1, `the list must reveal every seeded Session: ${rowCount}`)

  const groupOrder = await page.evaluate(() => {
    const keys = [...document.querySelectorAll('[data-row-key]')].map(row => row.getAttribute('data-row-key'))
    const start = keys.findIndex(key => key?.startsWith('workspace:'))
    const end = keys.findIndex(key => key?.startsWith('overflow:'), start)
    return keys.slice(start + 1, end)
      .filter(key => key?.startsWith('session:scale-session-'))
      .map(key => Number(key.split('-').at(-1)))
  })
  assert.deepEqual(groupOrder, [...groupOrder].sort((left, right) => right - left),
    'the main Workspace rows must stay newest-first by createdAt')

  const searchStartedAt = Date.now()
  await page.getByRole('button', { name: 'Search sessions' }).first().click()
  await page.locator('input[placeholder="Search session names"]').first().fill(SEARCH_QUERY)
  const searchResults = page.locator('[role="treeitem"]')
  await waitFor(async () => await searchResults.count() === 1 ? true : undefined, 'single search result', 10_000)
  const searchMs = Date.now() - searchStartedAt
  assert.equal(await searchResults.count(), 1, 'the distinct cwd label must match one Session')
  await searchResults.first().click()
  await page.getByText(`SCALE_SESSION_${String(SEARCH_INDEX).padStart(3, '0')}`, { exact: true }).last().waitFor({ timeout: 15_000 })

  const expectedListRequests = Math.ceil(SESSIONS / BACKEND_PAGE_SIZE)
  assert.ok(listRequests.length >= expectedListRequests,
    `the sidebar must page the backend list: ${listRequests.length} requests for ${SESSIONS} Sessions`)
  assert.ok(listRequests.length <= LIMITS.listRequests,
    `catalog list cost ${listRequests.length} requests exceeds ${LIMITS.listRequests} at ${SESSIONS} Sessions`)
  const reloadMs = previewReadyAt - reloadedAt
  assert.ok(reloadMs <= LIMITS.reloadMs, `reload ${reloadMs}ms exceeds ${LIMITS.reloadMs}ms`)
  assert.ok(listMs <= LIMITS.listMs, `first page ${listMs}ms exceeds ${LIMITS.listMs}ms`)
  assert.ok(expandMs <= LIMITS.expandMs, `expansion ${expandMs}ms exceeds ${LIMITS.expandMs}ms`)
  assert.ok(searchMs <= LIMITS.searchMs, `search ${searchMs}ms exceeds ${LIMITS.searchMs}ms`)
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'))

  console.log(JSON.stringify({
    scope: 'browser-session-list-scale',
    sessions: SESSIONS,
    rows: rowCount,
    pagination: {
      backendPageRequests: listRequests.length,
      firstPages: listRequests.filter(kind => kind === 'first').length,
      nextPages: listRequests.filter(kind => kind === 'next').length,
      expectedPageRequests: expectedListRequests,
      maxPageRequests: LIMITS.listRequests,
      watermarkClicks: expandClicks,
      watermarkStep: WATERMARK_STEP,
    },
    search: { query: SEARCH_QUERY, results: 1, opened: true },
    ordering: 'newest-first by createdAt',
    timings: { reloadMs, listMs, expandMs, searchMs },
    acceptableLimits: LIMITS,
  }, null, 2))
} finally {
  if (pageErrors.length > 0) console.error('pageErrors', JSON.stringify(pageErrors, null, 2))
  if (app !== undefined) await app.close().catch(() => {})
  if (browser !== undefined) await browser.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
