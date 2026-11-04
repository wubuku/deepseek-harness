/**
 * Multi-principal load characterization for the browser-native PoC.
 *
 * Ten principals each open two Sessions in two tabs of one BrowserContext and
 * submit a turn at the same time. The backend admits eight model turns, so the
 * remaining twelve queue. The run also shares one Session with a second
 * principal and reads it while the load is active, settles one approval-gated
 * turn through the shipped card, and probes the mounted-Session cap. A smaller
 * ten-Session run at the same admission width provides the throughput
 * comparison that locates the pressure knee.
 *
 * Usage:
 *   DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/multi-principal-load.e2e.mjs
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, submitPrompt, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const LOAD_MARKER = 'BROWSER_NATIVE_PRINCIPAL_LOAD_TURN'
const APPROVAL_MARKER = 'BROWSER_NATIVE_APPROVAL_ALLOW_ONCE_E2E'
const PRINCIPALS = Number(process.env.DSH_POC_PRINCIPAL_COUNT ?? 10)
const SESSIONS_PER_PRINCIPAL = Number(process.env.DSH_POC_PRINCIPAL_SESSIONS ?? 2)
const TURN_SLOTS = Number(process.env.DSH_POC_PRINCIPAL_TURN_SLOTS ?? 8)
const MOUNT_SLOTS = Number(process.env.DSH_POC_PRINCIPAL_MOUNT_SLOTS ?? 24)
const TURN_BUDGET_MS = Number(process.env.DSH_POC_PRINCIPAL_TURN_BUDGET_MS ?? 30_000)
const HEAP_BUDGET_BYTES = Number(process.env.DSH_POC_PRINCIPAL_HEAP_BUDGET_MB ?? 512) * 1024 * 1024
const PREVIEW = origin => `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=approval-integrity&preview-fixture=none`

for (const [name, value] of [['DSH_POC_PRINCIPAL_COUNT', PRINCIPALS],
  ['DSH_POC_PRINCIPAL_SESSIONS', SESSIONS_PER_PRINCIPAL],
  ['DSH_POC_PRINCIPAL_TURN_SLOTS', TURN_SLOTS],
  ['DSH_POC_PRINCIPAL_MOUNT_SLOTS', MOUNT_SLOTS]]) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function percentile(values, ratio) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))]
}

function timing(values) {
  return { samples: values, median: median(values), p95: percentile(values, 0.95), max: Math.max(...values), min: Math.min(...values) }
}

function createRecorder(page, origin) {
  const recorder = { requests: [], pageErrors: [], external: [] }
  page.on('pageerror', error => recorder.pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== origin) {
      recorder.external.push(request.url())
      return
    }
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = request.postDataJSON() ?? {} } catch {}
    recorder.requests.push({ path: url.pathname, body })
  })
  return recorder
}

async function enableMetrics(page) {
  const session = await page.context().newCDPSession(page)
  await session.send('Performance.enable')
  return session
}

async function readMetrics(session) {
  const { metrics } = await session.send('Performance.getMetrics')
  return Object.fromEntries(metrics.map(metric => [metric.name, metric.value]))
}

async function principalCookie(context, origin) {
  const cookies = await context.cookies(`${origin}/api/browser-native/session/create`)
  const cookie = cookies.find(candidate => candidate.name === 'dsh-browser-native-session-principal')
  assert.ok(cookie, 'each principal context must authorize Session operations')
  return `${cookie.name}=${cookie.value}`
}

async function sessionCall(origin, cookie, operation, body) {
  const response = await fetch(`${origin}/api/browser-native/session/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), ...body }),
  })
  const payload = await response.json()
  return { status: response.status, ...payload }
}

async function admissionSnapshot(origin) {
  return await fetch(`${origin}/api/browser-native/admission`).then(response => response.json())
}

function sessionIdOf(tab) {
  return tab.recorder.requests.find(request => request.path.endsWith('/session/create'))?.body.sessionId
}

async function openTab(context, origin) {
  const page = await context.newPage()
  const recorder = createRecorder(page, origin)
  await openPreview(page, PREVIEW(origin))
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'string', undefined, { timeout: 90_000 })
  return { page, recorder, sessionId: undefined }
}

/**
 * Submit a turn, optionally acting through the shipped approval card once the
 * request becomes visible, and return the measured turn latency.
 */
async function submitMeasured(tab, origin, prompt, { approval = false, label = 'turn' } = {}) {
  const startedAt = Date.now()
  if (approval) {
    // A second tab in the same context can persist Workspace Write; reset this
    // Session to Read Only so the shipped card, not the tool policy, settles it.
    await tab.page.locator('button[aria-label^="Access mode"]').first().click()
    await tab.page.getByRole('menuitem', { name: 'Read Only' }).click()
    await tab.page.locator('button[aria-label="Access mode, current: Read Only"]').waitFor({ timeout: 15_000 })
  }
  const submission = submitPrompt({
    page: tab.page,
    origin,
    requests: tab.recorder.requests,
    prompt,
    timeout: TURN_BUDGET_MS,
  })
  if (approval) {
    // Background tabs in a shared BrowserContext may not paint, so wait for the
    // card in the document and bypass actionability rather than requiring paint.
    const card = tab.page.locator('[data-approval-key]').first()
    try {
      await card.waitFor({ state: 'attached', timeout: TURN_BUDGET_MS })
    } catch (error) {
      const sessionId = sessionIdOf(tab)
      const cookie = await principalCookie(tab.page.context(), origin)
      const read = sessionId === undefined ? undefined : await sessionCall(origin, cookie, 'read', { sessionId, offset: 0 })
      throw new Error(`approval card did not appear: ${JSON.stringify({
        sessionId,
        requests: tab.recorder.requests.map(request => request.path),
        events: read?.events?.map(event => event.type),
        error: read?.error,
        body: (await tab.page.locator('body').innerText()).slice(-400),
      })}`, { cause: error })
    }
    await card.getByRole('button', { name: 'Allow once' }).click({ force: true })
  }
  let result
  try {
    result = await submission
  } catch (error) {
    throw new Error(`${label}: ${error.message}; composer=${JSON.stringify((await tab.page.locator('[data-composer-input]').last().innerText()).slice(0, 120))}`, { cause: error })
  }
  tab.sessionId = result.sessionId
  return {
    sessionId: result.sessionId,
    turn: result.turn,
    turnMs: Date.now() - startedAt,
    approvalEvents: result.session.events.filter(event => event.type === 'approval/decided').length,
  }
}

async function measureLoad({ browser, browserCdp, origin, principals, sessionsPerPrincipal, role }) {
  const contexts = []
  const tabs = []
  const work = []
  const contextOptions = { locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 } }
  try {
    // Every Session gets its own window, and later windows reuse the first
    // window's principal cookie so one principal can hold several Sessions
    // without a shared tab throttling its Worker.
    const groups = await Promise.all(Array.from({ length: principals }, async (_, principal) => {
      const firstContext = await browser.newContext(contextOptions)
      contexts.push(firstContext)
      const group = [await openTab(firstContext, origin)]
      for (let index = 1; index < sessionsPerPrincipal; index += 1) {
        const cookie = (await firstContext.cookies(`${origin}/api/browser-native/workspace/identity`))
          .find(candidate => candidate.name === 'dsh-browser-native-principal')
        assert.ok(cookie, `principal ${String(principal)} must have an identity cookie`)
        const context = await browser.newContext(contextOptions)
        contexts.push(context)
        await context.addCookies([{ name: cookie.name, value: cookie.value, url: `${origin}/api/browser-native/workspace/identity` }])
        group.push(await openTab(context, origin))
      }
      return group
    }))
    tabs.push(...groups.flat())
    const before = await browserCdp.send('SystemInfo.getProcessInfo')
    const beforeTotal = before.processInfo.reduce((total, entry) => total + entry.cpuTime, 0)
    const loadStartedAt = Date.now()
    let maxActiveTurns = 0
    let maxQueuedTurns = 0
    let admissionSamples = 0
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        const snapshot = await admissionSnapshot(origin)
        maxActiveTurns = Math.max(maxActiveTurns, snapshot.activeTurns)
        maxQueuedTurns = Math.max(maxQueuedTurns, snapshot.queuedTurns)
        admissionSamples += 1
        await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
      }
    })()
    const approvalTab = tabs[0]
    for (const [index, tab] of tabs.entries()) {
      work.push(submitMeasured(tab, origin, index === 0 ? APPROVAL_MARKER : `${LOAD_MARKER}: ${role}-${String(index)}`, {
        approval: index === 0, label: `${role}-${String(index)}`,
      }).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason })))
    }
    const ownerCookie = await waitFor(async () => {
      const id = sessionIdOf(approvalTab)
      return id === undefined ? undefined : { id, cookie: await principalCookie(approvalTab.page.context(), origin) }
    }, 'owner Session creation', 60_000)
    let collaboration
    let collaborationError
    if (principals > 1 && SESSIONS_PER_PRINCIPAL > 0) try {
      const viewerTab = tabs[SESSIONS_PER_PRINCIPAL]
      const viewerCookie = await waitFor(async () => {
        const id = sessionIdOf(viewerTab)
        return id === undefined ? undefined : await principalCookie(viewerTab.page.context(), origin)
      }, 'viewer Session creation', 60_000)
      const shared = await sessionCall(origin, ownerCookie.cookie, 'share', {
        sessionId: ownerCookie.id, viewerPrincipalId: decodeURIComponent(viewerCookie.split('=')[1]),
      })
      assert.equal(shared.status, 200, JSON.stringify(shared))
      const viewerOpen = await sessionCall(origin, viewerCookie, 'open', {
        sessionId: ownerCookie.id, access: 'read',
      })
      assert.equal(viewerOpen.status, 200, JSON.stringify(viewerOpen))
      assert.equal(viewerOpen.owner, undefined, 'a viewer open must not receive the owner lease')
      const viewerRead = await waitFor(async () => {
        const read = await sessionCall(origin, viewerCookie, 'read', { sessionId: ownerCookie.id, offset: 0 })
        return read.status === 200 && read.events.length > 0 ? read : undefined
      }, 'collaboration read during load', 60_000)
      const viewerWrite = await sessionCall(origin, viewerCookie, 'open', {
        sessionId: ownerCookie.id, access: 'write',
      })
      assert.equal(viewerWrite.status, 403, JSON.stringify(viewerWrite))
      assert.equal(viewerWrite.error.code, 'SESSION_READ_ONLY')
      collaboration = {
        sessionId: ownerCookie.id,
        viewerOpenStatus: viewerOpen.status,
        viewerReadEvents: viewerRead.events.length,
        viewerWriteStatus: viewerWrite.status,
        viewerWriteCode: viewerWrite.error.code,
      }
    } catch (error) {
      collaborationError = error
    }
    let settled
    try {
      settled = await Promise.all(work)
    } finally {
      sampling = false
      await sampler
    }
    if (collaborationError !== undefined) throw collaborationError
    const rejected = settled.filter(entry => entry.status === 'rejected')
    if (rejected.length > 0) throw rejected[0].reason
    const turns = settled.map(entry => entry.value)
    const wallMs = Date.now() - loadStartedAt
    const after = await browserCdp.send('SystemInfo.getProcessInfo')
    const afterTotal = after.processInfo.reduce((total, entry) => total + entry.cpuTime, 0)
    const metricSessions = await Promise.all(tabs.map(async tab => enableMetrics(tab.page)))
    const taskDurations = (await Promise.all(metricSessions.map(async session => readMetrics(session)))
      .then(values => values.map(value => value.TaskDuration * 1000)))
    const heaps = await Promise.all(metricSessions.map(async session => {
      await session.send('HeapProfiler.collectGarbage')
      return (await readMetrics(session)).JSHeapUsedSize
    }))
    await Promise.all(metricSessions.map(async session => session.detach().catch(() => {})))
    const latencies = turns.map(turn => turn.turnMs)
    const throughputPerSecond = turns.length / (wallMs / 1000)
    return {
      role,
      principals,
      sessions: turns.length,
      turnMs: timing(latencies),
      throughputPerSecond,
      wallMs,
      admission: {
        samples: admissionSamples,
        maxActiveTurns,
        maxQueuedTurns,
        limit: TURN_SLOTS,
        queueObserved: maxQueuedTurns > 0,
      },
      cpuPercentOfOneCore: ((afterTotal - beforeTotal) / (wallMs / 1000)) * 100,
      taskDurationMs: { median: median(taskDurations), p95: percentile(taskDurations, 0.95) },
      pageHeapBytes: { median: median(heaps), max: Math.max(...heaps) },
      approval: {
        tab: approvalTab.sessionId,
        turnsWithDecision: turns.filter(turn => turn.approvalEvents > 0).length,
        decidedEvents: turns.reduce((total, turn) => total + turn.approvalEvents, 0),
      },
      collaboration: collaboration ?? null,
      pageErrors: tabs.flatMap(tab => tab.recorder.pageErrors),
      external: tabs.flatMap(tab => tab.recorder.external),
    }
  } finally {
    await Promise.all(contexts.map(async context => await context.close().catch(() => {})))
  }
}


async function probeMountLimit({ origin, existingSessions }) {
  const identity = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(identity.status, 200)
  const principal = identity.headers.getSetCookie()
    .map(value => value.split(';')[0])
    .find(value => value.startsWith('dsh-browser-native-principal='))
  assert.ok(principal, 'a new identity must mint a principal cookie')
  const cookie = principal.replace('dsh-browser-native-principal=', 'dsh-browser-native-session-principal=')
  const created = []
  let rejection
  for (let attempt = 0; attempt <= MOUNT_SLOTS; attempt += 1) {
    const sessionId = `principal-load-mount-${randomUUID().slice(0, 8)}`
    const response = await sessionCall(origin, cookie, 'create', {
      sessionId,
      header: { version: 4, id: sessionId, createdAt: Date.now(), cwd: '/dsh/home/' },
    })
    if (response.status === 200) {
      created.push({ sessionId, ownerToken: response.owner.ownerToken })
      continue
    }
    rejection = { status: response.status, code: response.error?.code, mounted: response.error?.details?.mounted }
    break
  }
  const snapshot = await admissionSnapshot(origin)
  for (const session of created) {
    await sessionCall(origin, cookie, 'close', { sessionId: session.sessionId, ownerToken: session.ownerToken }).catch(() => {})
  }
  return {
    loadSessionsClosedBeforeProbe: existingSessions,
    createdBeforeRejection: created.length,
    rejection,
    limits: snapshot.limits,
  }
}

const dataDir = await mkdtemp(`${tmpdir()}/dsh-browser-principal-load-`)
let image
let browser
let browserCdp
let app
try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    admission: { maxConcurrentTurns: TURN_SLOTS, maxMountedSessions: MOUNT_SLOTS, queueTimeoutMs: 60_000, mountLeaseMs: 120_000 },
    ownerLeaseMs: 120_000,
    testHooks: {
      scriptedLlmFault: body => {
        const text = JSON.stringify(body.messages ?? [])
        if (!text.includes(LOAD_MARKER)) return undefined
        // Hold each admitted model call long enough that staggered browser
        // request starts still overlap the eight configured turn slots.
        return {
          kind: 'delayed-text', delayMs: Number(process.env.DSH_POC_PRINCIPAL_LLM_MS ?? 3_000),
          text: `${LOAD_MARKER}_DONE`, prefix: `${LOAD_MARKER}_STREAMING`,
        }
      },
    },
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({
    headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome', args: ['--enable-precise-memory-info'],
  })
  browserCdp = await browser.newBrowserCDPSession()

  const small = await measureLoad({
    browser, browserCdp, origin, principals: Math.max(1, Math.floor(PRINCIPALS / 2)), sessionsPerPrincipal: SESSIONS_PER_PRINCIPAL, role: 'baseline',
  })
  const full = await measureLoad({
    browser, browserCdp, origin, principals: PRINCIPALS, sessionsPerPrincipal: SESSIONS_PER_PRINCIPAL, role: 'principal-load',
  })

  const mountProbe = await probeMountLimit({ origin, existingSessions: full.sessions })

  const loadViolations = [small, full].flatMap(entry => [
    ...entry.turnMs.samples.some(value => value >= TURN_BUDGET_MS)
      ? [{ role: entry.role, budget: 'turnMs', limit: TURN_BUDGET_MS, observedMax: entry.turnMs.max }] : [],
    ...entry.pageHeapBytes.max >= HEAP_BUDGET_BYTES
      ? [{ role: entry.role, budget: 'heapBytes', limit: HEAP_BUDGET_BYTES, observedMax: entry.pageHeapBytes.max }] : [],
  ])
  const failures = []
  if (!small.admission.queueObserved) failures.push('the baseline run must observe queued turns at the configured width')
  if (small.admission.maxActiveTurns !== TURN_SLOTS) failures.push(`baseline admission reached ${String(small.admission.maxActiveTurns)} of ${String(TURN_SLOTS)} configured slots`)
  if (full.admission.maxActiveTurns > TURN_SLOTS) failures.push('admission must never exceed the configured turn slots')
  if (full.approval.decidedEvents !== 1) failures.push('exactly one approval-gated turn must settle')
  if (full.collaboration !== null) {
    if (full.collaboration.viewerOpenStatus !== 200) failures.push('the shared viewer Session must open for reading')
    if (full.collaboration.viewerWriteStatus !== 403) failures.push('the shared viewer must stay read-only')
  } else if (PRINCIPALS > 1) {
    failures.push('the multi-principal run must exercise collaboration')
  }
  if (mountProbe.rejection?.status !== 429) failures.push('one Session beyond the mounted-Session cap must be rejected')
  if (loadViolations.length > 0) failures.push('turn latency or heap exceeded the configured budget')
  if (full.throughputPerSecond < small.throughputPerSecond * 0.5) failures.push('throughput must not collapse when principals double at the same admission width')

  const report = {
    result: failures.length === 0 ? 'passed' : 'failed',
    browser: browser.version(),
    scope: 'multi-principal-load-admission-and-kneepoint',
    settings: { principals: PRINCIPALS, sessionsPerPrincipal: SESSIONS_PER_PRINCIPAL, turnSlots: TURN_SLOTS, mountSlots: MOUNT_SLOTS },
    small,
    full,
    mountProbe,
    kneepoint: {
      latencyRatio: full.turnMs.median / small.turnMs.median,
      throughputRatio: full.throughputPerSecond / small.throughputPerSecond,
      smallSessions: small.sessions,
      fullSessions: full.sessions,
      // A saturated server queue proves the admission width binds; a partially
      // filled server with an empty queue proves browser contention binds first.
      boundBy: small.admission.queueObserved ? (full.admission.queueObserved ? 'admission' : 'browser-contention') : 'under-loaded',
    },
    loadViolations,
    failures,
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)
  assert.deepEqual(full.pageErrors, [])
  assert.deepEqual(full.external, [])
  assert.deepEqual(failures, [], 'multi-principal load characterization failed')
} finally {
  await app?.close()
  await browser?.close()
  await image?.cleanup()
  await rm(dataDir, { recursive: true, force: true })
}
