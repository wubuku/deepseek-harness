/**
 * Browser-side Session retrieval at 100+ Session scale.
 *
 * The web profile mounts the shipped `session-query` SQLite engine inside the
 * Worker. This run seeds 120 persisted Sessions with known working directories
 * and markers, then measures the shipped listing, exact filtering,
 * cross-Session search, and within-Session search. Correctness is
 * asserted from the seeded ids; the printed timings are the observed upper
 * bounds for the PoC's 120-Session corpus.
 *
 * Usage:
 *   DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-query-scale.e2e.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const SEEDED_SESSIONS = 120
const ALPHA_CWD = '/dsh/home/query-alpha'
const BETA_CWD = '/dsh/home/query-beta'
const QUERY = 'needle_alpha'
const WITHIN_SESSION_ID = 'query-session-000'
/** Observed upper bounds for 120 persisted Sessions on the PoC backend. */
const LIMITS = { listMs: 2_000, filterMs: 2_000, searchMs: 20_000, withinSessionMs: 2_000 }

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-session-query-'))
const pageErrors = []
const workerErrors = []
let image
let app
let browser
let page

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

function userMessage(id, text) {
  return {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser-session-query' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('worker', worker => worker.on('pageerror', error => workerErrors.push(error.message)))

  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=session-query&preview-fixture=none`)
  await waitForPreview(page)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })

  // Identity opens both the workspace and Session principal cookies used below.
  const identity = await page.evaluate(async () => await fetch('/api/browser-native/workspace/identity', { method: 'GET' }).then(response => response.status))
  assert.equal(identity, 200)

  const seeded = await page.evaluate(async ({ count, alphaCwd, betaCwd }) => {
    const baseTime = Date.now() - count * 1_000
    const ids = []
    for (let index = 0; index < count; index += 1) {
      const id = `query-session-${String(index).padStart(3, '0')}`
      const alpha = index % 2 === 0
      const cwd = alpha ? alphaCwd : betaCwd
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
      const events = [0, 1, 2].map(seq => ({
        seq,
        type: 'user/message',
        time: baseTime + index * 1_000 + seq,
        surfaceOp: 'append',
        data: {
          id: `${id}-message-${seq}`,
          role: 'user',
          source: { kind: 'user' },
          content: [{
            type: 'text',
            text: seq === (alpha ? 1 : 2)
              ? `${alpha ? 'NEEDLE_ALPHA' : 'NEEDLE_BETA'} payload ${index}`
              : `routine ${alpha ? 'alpha' : 'beta'} message ${index}`,
          }],
        },
      }))
      await poster('append', {
        sessionId: id,
        ownerToken: created.owner.ownerToken,
        ownerEpoch: created.owner.ownerEpoch,
        expectedNextSeq: 0,
        events,
      })
      // Release the backend mount slot so the next seed Session can be created.
      await poster('close', { sessionId: id, ownerToken: created.owner.ownerToken })
      ids.push(id)
    }
    return ids
  }, { count: SEEDED_SESSIONS, alphaCwd: ALPHA_CWD, betaCwd: BETA_CWD })
  assert.equal(seeded.length, SEEDED_SESSIONS)
  const alphaIds = seeded.filter((_, index) => index % 2 === 0)
  const betaIds = seeded.filter((_, index) => index % 2 === 1)

  const probe = await waitFor(async () => {
    const response = await testAction({
      action: 'session-query-probe',
      query: QUERY,
      cwd: BETA_CWD,
      sessionId: WITHIN_SESSION_ID,
      limit: 100,
    })
    return response?.ok === true ? response.sessionQuery : undefined
  }, 'session-query probe', 120_000)

  assert.ok(probe.sessions >= SEEDED_SESSIONS && probe.sessions <= SEEDED_SESSIONS + 1,
    `corpus must contain all seeded Sessions plus at most one preview Session: ${probe.sessions}`)
  assert.equal(probe.filtered, betaIds.length, `cwd filter must return the beta Sessions: ${probe.filtered}`)
  assert.deepEqual([...probe.filteredIds].sort(), [...betaIds].sort())
  assert.equal(probe.matched, alphaIds.length, `full-text search must find every alpha Session: ${probe.matched}`)
  const hitIds = probe.hits.map(hit => hit.sessionId)
  assert.equal(new Set(hitIds).size, alphaIds.length, 'each alpha Session must be one search hit')
  assert.deepEqual([...hitIds].sort(), [...alphaIds].sort())
  assert.ok(probe.hits.every(hit => hit.snippet.includes('NEEDLE_ALPHA')), 'snippets must carry the matched text')
  assert.equal(probe.searchBackend, 'linear-fallback', `browser search must not claim the SQLite index: ${probe.searchError}`)
  assert.equal(probe.withinSession?.hits, 1, `within-Session search must return one hit: ${JSON.stringify(probe.withinSession)}`)

  const timings = {
    listMs: probe.listMs,
    filterMs: probe.filterMs,
    searchMs: probe.searchMs,
    withinSessionMs: probe.withinSession.ms,
  }
  for (const [metric, bound] of Object.entries(LIMITS)) {
    assert.ok(timings[metric] <= bound, `${metric} ${timings[metric]}ms exceeds the PoC bound ${bound}ms`)
  }
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'))

  console.log(JSON.stringify({
    scope: 'browser-session-query-scale',
    sessions: probe.sessions,
    correctness: {
      cwdFilter: { expected: betaIds.length, actual: probe.filtered, exact: true },
      textSearch: {
        expected: alphaIds.length,
        actual: probe.matched,
        unique: new Set(hitIds).size,
        snippetSample: probe.hits[0]?.snippet,
        backend: probe.searchBackend,
        shippedIndexError: probe.searchError,
      },
      withinSession: probe.withinSession,
    },
    timings,
    acceptableLimits: LIMITS,
    fullTextBackend: 'linear fallback in Worker; node:sqlite.DatabaseSync is unavailable',
  }, null, 2))
} finally {
  if (pageErrors.length > 0) console.error('pageErrors', JSON.stringify(pageErrors, null, 2))
  if (workerErrors.length > 0) console.error('workerErrors', JSON.stringify(workerErrors, null, 2))
  if (app !== undefined) await app.close().catch(() => {})
  if (browser !== undefined) await browser.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
