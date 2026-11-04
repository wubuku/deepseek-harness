/**
 * Cross-Session full-text search at 200+ Session and 10k+ event scale.
 *
 * The Web deployment cannot open the SQLite index inside a Worker, so
 * `searchSessions()` degrades to a linear scan of persisted Sessions. This run
 * measures that fallback in two corpus phases (120 and 240 Sessions, each with
 * 120 events) and asserts recall, first-hit ordering, and the derived latency
 * bound. A one-time probe run at each corpus size makes the growth rate
 * observable instead of extrapolated.
 *
 * Usage:
 *   DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-query-large-scale.e2e.mjs
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

const SESSIONS_PER_PHASE = Number(process.env.DSH_POC_QUERY_SESSIONS ?? 120)
const EVENTS_PER_SESSION = Number(process.env.DSH_POC_QUERY_EVENTS ?? 120)
const ALPHA_CWD = '/dsh/home/query-large-alpha'
const BETA_CWD = '/dsh/home/query-large-beta'
const NEEDLE = 'NEEDLE_OMEGA'
const RARE = 'RARE_OMEGA'
const EVERYWHERE = 'routine'
const ABSENT = 'NEEDLE_ABSENT_9F31'
const WITHIN_SESSION_ID = 'query-large-session-000'
/** Newest alpha Session; the probe must report its first needle, not its second. */
const FIRST_HIT_SESSION_ID = `query-large-session-${String(SESSIONS_PER_PHASE - 1).padStart(3, '0')}`
const FIRST_HIT_SEQ = 30
const STANDARD_NEEDLE_SEQ = 60
const RARE_SEQ = 61
/** Probe reports at most 100 hits per query; completeness comes from `matched`. */
const HIT_LIMIT = 100
/** Machine tolerance for the PoC run; the product ceiling derived from this run is 3 s. */
const LIMITS = { listMs: 2_000, filterMs: 2_000, searchMs: 10_000, withinSessionMs: 2_000 }

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-session-query-large-'))
const pageErrors = []
const workerErrors = []
let image
let app
let browser
let page

async function testAction(request) {
  return await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
}

/** Seed one closed Session with 120 user messages and return its id. */
async function seedSessions({ start, count, alpha }) {
  return await page.evaluate(async ({ start, count, alpha, alphaCwd, betaCwd, eventsPerSession, needle, rare, rareSession, rareSeq, firstHitSession, firstHitSeq, standardSeq }) => {
    const baseTime = Date.now() - (start + count) * 1_000
    const ids = []
    for (let offset = 0; offset < count; offset += 1) {
      const index = start + offset
      const id = `query-large-session-${String(index).padStart(3, '0')}`
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
      const events = Array.from({ length: eventsPerSession }, (_, seq) => {
        let text = `routine ${alpha ? 'alpha' : 'beta'} message ${index} seq ${seq}`
        if (alpha && seq === (id === firstHitSession ? firstHitSeq : standardSeq)) text = `${needle} payload ${index} seq ${seq}`
        if (alpha && id === firstHitSession && seq === 90) text = `${needle} payload ${index} seq ${seq} second`
        if (alpha && id === rareSession && seq === rareSeq) text = `${rare} payload ${index} seq ${seq}`
        return {
          seq,
          type: 'user/message',
          time: baseTime + index * 1_000 + seq,
          surfaceOp: 'append',
          data: {
            id: `${id}-message-${seq}`,
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text }],
          },
        }
      })
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
  }, {
    start,
    count,
    alpha,
    alphaCwd: ALPHA_CWD,
    betaCwd: BETA_CWD,
    eventsPerSession: EVENTS_PER_SESSION,
    needle: NEEDLE,
    rare: RARE,
    rareSession: FIRST_HIT_SESSION_ID,
    rareSeq: RARE_SEQ,
    firstHitSession: FIRST_HIT_SESSION_ID,
    firstHitSeq: FIRST_HIT_SEQ,
    standardSeq: STANDARD_NEEDLE_SEQ,
  })
}

/** Run one probe query; returns the raw report. */
async function probe(query) {
  let attempts = 0
  return await waitFor(async () => {
    attempts += 1
    const response = await testAction({
      action: 'session-query-probe',
      query,
      cwd: BETA_CWD,
      sessionId: WITHIN_SESSION_ID,
      limit: HIT_LIMIT,
    })
    if (response?.ok !== true) process.stdout.write(`probe ${query} attempt ${attempts}: ${JSON.stringify(response)}\n`)
    return response?.ok === true ? response.sessionQuery : undefined
  }, `session-query probe ${query}`, 300_000)
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

  const identity = await page.evaluate(async () => await fetch('/api/browser-native/workspace/identity', { method: 'GET' }).then(response => response.status))
  assert.equal(identity, 200)

  const alphaIds = await seedSessions({ start: 0, count: SESSIONS_PER_PHASE, alpha: true })
  const phaseA = await probe(NEEDLE)
  assert.equal(phaseA.sessions, SESSIONS_PER_PHASE + 1,
    `phase A corpus must contain the seeded Sessions plus the preview Session: ${phaseA.sessions}`)
  assert.equal(phaseA.matched, SESSIONS_PER_PHASE, 'phase A must find the needle in every alpha Session')
  assert.equal(phaseA.hits.length, Math.min(HIT_LIMIT, SESSIONS_PER_PHASE),
    'the probe must report hits up to its limit without dropping matched Sessions')
  assert.equal(new Set(phaseA.hits.map(hit => hit.sessionId)).size, phaseA.hits.length,
    'each matched Session must appear once')

  const betaIds = await seedSessions({ start: SESSIONS_PER_PHASE, count: SESSIONS_PER_PHASE, alpha: false })
  const totalSessions = SESSIONS_PER_PHASE * 2
  const totalEvents = totalSessions * EVENTS_PER_SESSION
  const phaseB = await probe(NEEDLE)
  assert.equal(phaseB.sessions, totalSessions + 1,
    `phase B corpus must contain all seeded Sessions plus the preview Session: ${phaseB.sessions}`)
  assert.equal(phaseB.matched, SESSIONS_PER_PHASE, 'doubling the corpus must not add needle Sessions')

  const hitIds = phaseB.hits.map(hit => hit.sessionId)
  assert.equal(new Set(hitIds).size, phaseB.hits.length, 'each alpha Session must appear at most once')
  assert.ok(hitIds.every(id => alphaIds.includes(id)), 'search must not invent Sessions')
  const firstHits = new Map(phaseB.hits.map(hit => [hit.sessionId, hit.seq]))
  assert.equal(firstHits.get(FIRST_HIT_SESSION_ID), FIRST_HIT_SEQ,
    'the newest alpha Session must report its first needle, not its second')
  for (const [id, seq] of firstHits) {
    assert.equal(seq, id === FIRST_HIT_SESSION_ID ? FIRST_HIT_SEQ : STANDARD_NEEDLE_SEQ,
      `Session ${id} must report its first needle event`)
  }
  assert.ok(phaseB.hits.every(hit => hit.snippet.toLowerCase().includes(NEEDLE.toLowerCase())),
    'every snippet must carry the matched text')
  assert.equal(phaseB.searchBackend, 'linear-fallback', `browser search must not claim the SQLite index: ${phaseB.searchError}`)
  assert.equal(typeof phaseB.searchError, 'string')

  const rare = await probe(RARE)
  assert.equal(rare.matched, 1, 'a token in one Session must produce exactly one hit')
  assert.equal(rare.hits.length, 1)
  assert.equal(rare.hits[0].sessionId, FIRST_HIT_SESSION_ID)
  assert.equal(rare.hits[0].seq, RARE_SEQ)
  assert.ok(rare.hits[0].snippet.includes(RARE))

  const everywhere = await probe(EVERYWHERE)
  assert.equal(everywhere.matched, totalSessions, 'a token in every event must match every Session')
  assert.equal(everywhere.hits.length, Math.min(HIT_LIMIT, totalSessions))
  assert.equal(new Set(everywhere.hits.map(hit => hit.sessionId)).size, Math.min(HIT_LIMIT, totalSessions))
  assert.ok(everywhere.hits.every(hit => hit.seq === 0), 'each Session reports its first matching event')

  const absent = await probe(ABSENT)
  assert.equal(absent.matched, 0, 'an absent token must return no hit')
  assert.equal(absent.hits.length, 0)

  const repeated = await probe(NEEDLE)
  assert.deepEqual(
    repeated.hits.map(hit => [hit.sessionId, hit.seq]),
    phaseB.hits.map(hit => [hit.sessionId, hit.seq]),
    'repeated searches must be deterministic',
  )

  assert.equal(phaseB.filtered, SESSIONS_PER_PHASE, 'the cwd filter must return the beta Sessions')
  assert.deepEqual([...phaseB.filteredIds].sort(), [...betaIds].sort())
  assert.equal(phaseB.withinSession?.hits, 1, `within-Session search must return one hit: ${JSON.stringify(phaseB.withinSession)}`)

  for (const timing of [['listMs', phaseB.listMs], ['filterMs', phaseB.filterMs], ['searchMs', phaseB.searchMs], ['withinSessionMs', phaseB.withinSession.ms]]) {
    assert.ok(timing[1] <= LIMITS[timing[0]], `${timing[0]} ${timing[1]}ms exceeds the PoC bound ${LIMITS[timing[0]]}ms`)
  }
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'))
  assert.deepEqual(workerErrors, [], workerErrors.join('\n'))

  const scaledSearchMs = (phaseB.searchMs - phaseA.searchMs) / (totalEvents - SESSIONS_PER_PHASE * EVENTS_PER_SESSION) * 1_000
  console.log(JSON.stringify({
    scope: 'browser-session-query-large-scale',
    corpus: {
      sessions: phaseB.sessions,
      seededSessions: totalSessions,
      eventsPerSession: EVENTS_PER_SESSION,
      seededEvents: totalEvents,
    },
    phaseA: { sessions: phaseA.sessions, events: SESSIONS_PER_PHASE * EVENTS_PER_SESSION, searchMs: phaseA.searchMs },
    correctness: {
      needle: { expected: SESSIONS_PER_PHASE, actual: phaseB.matched, unique: new Set(hitIds).size, firstHitSeq: firstHits.get(FIRST_HIT_SESSION_ID) },
      rare: { expected: 1, actual: rare.matched, sessionId: rare.hits[0].sessionId, seq: rare.hits[0].seq },
      everywhere: { expected: totalSessions, actual: everywhere.matched },
      absent: { expected: 0, actual: absent.matched },
      repeatedSearch: 'identical',
      cwdFilter: { expected: betaIds.length, actual: phaseB.filtered },
      withinSession: phaseB.withinSession,
      backend: phaseB.searchBackend,
      shippedIndexError: phaseB.searchError,
    },
    timings: {
      listMs: phaseB.listMs,
      filterMs: phaseB.filterMs,
      searchMs: phaseB.searchMs,
      withinSessionMs: phaseB.withinSession.ms,
      marginalMsPerThousandEvents: Number(scaledSearchMs.toFixed(3)),
    },
    acceptableLimits: LIMITS,
  }, null, 2))
} finally {
  if (pageErrors.length > 0) console.error('pageErrors', JSON.stringify(pageErrors, null, 2))
  if (workerErrors.length > 0) console.error('workerErrors', JSON.stringify(workerErrors, null, 2))
  if (app !== undefined) await app.close().catch(() => {})
  if (browser !== undefined) await browser.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
