/**
 * Measure long-session navigation at the 300-Turn scale: history search for
 * windowed-out Turns, rail jumps into loaded and unloaded Turns, the Turn
 * process disclosure, and the return-to-latest control.
 *
 * Turns run through the real composer so the UI builds its own transcript and
 * the window hides early Turns. Every operation is timed against the same page
 * with Chrome long-task entries and Performance metrics around the action.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const browserChannel = process.env.DSH_POC_BROWSER ?? 'chrome'

const MARKER = 'BROWSER_NATIVE_LONG_SESSION_USABILITY_E2E'
/** Prompt marker whose scripted handler performs one `write`, so that Turn has process content. */
const TOOL_MARKER = 'BROWSER_NATIVE_PRINCIPAL_SCOPE_B'
const turnCount = Number(process.env.DSH_POC_USABILITY_TURNS ?? 300)
const unloadedTarget = Number(process.env.DSH_POC_USABILITY_UNLOADED_TURN ?? 20)
const jumpBudgetMs = Number(process.env.DSH_POC_USABILITY_JUMP_MS ?? 5_000)
const loadedJumpBudgetMs = Number(process.env.DSH_POC_USABILITY_LOADED_JUMP_MS ?? 1_500)
const searchBudgetMs = Number(process.env.DSH_POC_USABILITY_SEARCH_MS ?? 2_000)
const disclosureBudgetMs = Number(process.env.DSH_POC_USABILITY_DISCLOSURE_MS ?? 1_000)
const toLatestBudgetMs = Number(process.env.DSH_POC_USABILITY_TO_LATEST_MS ?? 1_500)
const longTaskBudgetMs = Number(process.env.DSH_POC_USABILITY_LONG_TASK_MS ?? 100)
const domNodeBudget = Number(process.env.DSH_POC_USABILITY_DOM_BUDGET ?? 20_000)
const windowTurns = 150

if (!Number.isSafeInteger(turnCount) || turnCount < 200) throw new Error(`DSH_POC_USABILITY_TURNS must be at least 200, got ${String(turnCount)}`)
if (!Number.isSafeInteger(unloadedTarget) || unloadedTarget < 2 || unloadedTarget > turnCount - windowTurns) {
  throw new Error(`DSH_POC_USABILITY_UNLOADED_TURN must stay inside the windowed-out prefix, got ${String(unloadedTarget)}`)
}

/** The Turn that carries a tool call; it must sit inside the followed window. */
const disclosureTurn = turnCount - 20
const previewUrl = origin => `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=session-query&preview-fixture=none`

function pad(value) {
  return String(value).padStart(4, '0')
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function createRecorder(page, origin) {
  const requests = []
  const pageErrors = []
  const nonLocalRequests = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.origin.startsWith(origin)) nonLocalRequests.push(`${url.origin}${url.pathname}`)
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body = {}
    try { body = JSON.parse(request.postData() ?? '{}') } catch {}
    requests.push({ path: url.pathname, body })
  })
  return { requests, pageErrors, nonLocalRequests }
}

async function metrics(cdp) {
  const { metrics: values } = await cdp.send('Performance.getMetrics')
  const read = name => (values.find(metric => metric.name === name)?.value ?? 0) * 1_000
  return { task: read('TaskDuration'), script: read('ScriptDuration'), layout: read('LayoutDuration') }
}

async function installLongTaskObserver(page) {
  await page.evaluate(() => {
    const recorder = { entries: [] }
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) recorder.entries.push({ start: entry.startTime, duration: entry.duration })
    })
    observer.observe({ entryTypes: ['longtask'] })
    window.__dshLongTasks = recorder
    window.__dshLongTaskObserver = observer
  })
}

async function resetLongTasks(page) {
  await page.evaluate(() => { window.__dshLongTasks.entries.length = 0 })
}

async function readLongTasks(page) {
  return await page.evaluate(() => {
    const durations = window.__dshLongTasks.entries.map(entry => entry.duration)
    return {
      count: durations.length,
      totalMs: durations.reduce((total, value) => total + value, 0),
      longestMs: durations.length === 0 ? 0 : Math.max(...durations),
    }
  })
}

async function domStats(page) {
  return await page.evaluate(() => {
    const flowItems = document.querySelectorAll('[data-chat-flow-kind]')
    const boundary = document.querySelector('[data-chat-window-boundary]')
    return {
      nodes: document.getElementsByTagName('*').length,
      flowItems: flowItems.length,
      assistantSteps: document.querySelectorAll('[data-chat-flow-kind="assistant-step"]').length,
      textLength: document.body.innerText.length,
      windowHiddenTurns: boundary === null ? 0 : Number(boundary.getAttribute('data-chat-window-hidden') ?? '0'),
      followingTail: document.querySelector('[data-chat-following-tail]') !== null,
    }
  })
}

async function prepareScroller(page) {
  const found = await page.evaluate(() => {
    const candidates = [document.scrollingElement, ...document.querySelectorAll('*')]
    let best
    for (const node of candidates) {
      if (!(node instanceof HTMLElement)) continue
      if (node.clientHeight < 200) continue
      if (!/(auto|scroll)/.test(getComputedStyle(node).overflowY)) continue
      const overflow = node.scrollHeight - node.clientHeight
      if (overflow <= 0) continue
      if (best === undefined || overflow > best.overflow) best = { node, overflow, clientHeight: node.clientHeight }
    }
    if (best === undefined) return undefined
    window.__dshTranscriptScroller = best.node
    return { overflow: best.overflow, clientHeight: best.clientHeight }
  })
  assert.notEqual(found, undefined, 'the transcript must expose a vertical scroller')
  return found
}

async function railMarkCount(page, turn) {
  return await page.evaluate(target => {
    const nav = document.querySelector('nav[aria-label="Turn navigation"]')
    if (nav === null) return 0
    return [...nav.querySelectorAll('button[aria-label]')]
      .filter(mark => (mark.getAttribute('aria-label') ?? '').endsWith(`turn ${String(target)}`)).length
  }, turn)
}

/** Scroll the fixed-pitch rail until the virtualizer mounts the target mark. */
async function revealRailMark(page, turn) {
  await page.evaluate(target => {
    const nav = document.querySelector('nav[aria-label="Turn navigation"]')
    if (nav === null) return
    const scroller = nav.firstElementChild
    if (!(scroller instanceof HTMLElement)) return
    scroller.scrollTop = Math.max(0, (target - 1) * 10 + 6 - scroller.clientHeight / 2)
  }, turn)
  await page.waitForFunction(target => {
    const nav = document.querySelector('nav[aria-label="Turn navigation"]')
    if (nav === null) return false
    return [...nav.querySelectorAll('button[aria-label]')]
      .some(mark => (mark.getAttribute('aria-label') ?? '').endsWith(`turn ${String(target)}`))
  }, turn, { timeout: 10_000, polling: 100 })
  assert.equal(await railMarkCount(page, turn), 1, `the rail must expose exactly one mark for turn ${String(turn)}`)
}

async function clickRailMark(page, turn) {
  const clicked = await page.evaluate(target => {
    const nav = document.querySelector('nav[aria-label="Turn navigation"]')
    if (nav === null) return false
    const mark = [...nav.querySelectorAll('button[aria-label]')]
      .find(candidate => (candidate.getAttribute('aria-label') ?? '').endsWith(`turn ${String(target)}`))
    if (mark === undefined) return false
    mark.click()
    return true
  }, turn)
  assert.equal(clicked, true, `the rail mark for turn ${String(turn)} must be clickable`)
}

async function waitForTurnVisible(page, turn, timeout = 30_000) {
  await page.waitForFunction(target => {
    for (const row of document.querySelectorAll(`[data-chat-turn="${String(target)}"]`)) {
      const box = row.getBoundingClientRect()
      if (box.bottom > 8 && box.top < window.innerHeight - 8) return true
    }
    return false
  }, turn, { timeout, polling: 16 })
}

async function activeRailTurn(page) {
  return await page.evaluate(() => {
    const active = document.querySelector('nav[aria-label="Turn navigation"] button[aria-current="true"]')
    const label = active?.getAttribute('aria-label') ?? ''
    const match = /turn (\d+)$/.exec(label)
    return match === null ? undefined : Number(match[1])
  })
}

async function measureJump(page, cdp, turn) {
  await revealRailMark(page, turn)
  await prepareScroller(page)
  await resetLongTasks(page)
  const before = await metrics(cdp)
  const domBefore = await domStats(page)
  const started = Date.now()
  await clickRailMark(page, turn)
  await waitForTurnVisible(page, turn)
  const elapsedMs = Date.now() - started
  const after = await metrics(cdp)
  const longTasks = await readLongTasks(page)
  const domAfter = await domStats(page)
  return {
    turn,
    elapsedMs,
    activeTurn: await activeRailTurn(page),
    visible: true,
    taskMs: after.task - before.task,
    scriptMs: after.script - before.script,
    layoutMs: after.layout - before.layout,
    longTasks,
    domBefore,
    domAfter,
  }
}

async function measureDisclosure(page, cdp, turn) {
  const button = page.locator(`button[data-turn-process="${String(turn)}"]`).first()
  await button.waitFor({ state: 'visible', timeout: 10_000 })
  assert.equal(await button.isDisabled(), false, `turn ${String(turn)} must expose a foldable process disclosure`)
  const memberSelector = `[data-chat-turn="${String(turn)}"] [data-turn-process-member]`
  const hiddenCount = async () => await page.locator(`${memberSelector}[data-turn-process-hidden]`).count()
  const readState = async () => ({
    expanded: await button.getAttribute('aria-expanded'),
    hiddenMembers: await hiddenCount(),
    dom: await domStats(page),
  })
  const initial = await readState()
  assert.equal(initial.expanded, 'false', `turn ${String(turn)} must start with its process folded: ${JSON.stringify(initial)}`)

  const toggle = async (expected, label) => {
    await resetLongTasks(page)
    const before = await metrics(cdp)
    const started = Date.now()
    await button.click()
    await page.waitForFunction(({ target, state }) => {
      const control = document.querySelector(`button[data-turn-process="${String(target)}"]`)
      return control !== null && control.getAttribute('aria-expanded') === state
    }, { target: turn, state: expected }, { timeout: 5_000, polling: 16 })
    const elapsedMs = Date.now() - started
    const after = await metrics(cdp)
    const state = await readState()
    return {
      label,
      elapsedMs,
      taskMs: after.task - before.task,
      layoutMs: after.layout - before.layout,
      longTasks: await readLongTasks(page),
      expanded: state.expanded,
      hiddenMembers: state.hiddenMembers,
      nodes: state.dom.nodes,
      textLength: state.dom.textLength,
    }
  }

  const opened = await toggle('true', 'expand')
  const folded = await toggle('false', 'collapse')
  return { turn, initial, opened, folded }
}

async function measureReturnToLatest(page, cdp) {
  const button = page.getByRole('button', { name: 'Back to bottom' })
  await button.waitFor({ state: 'visible', timeout: 10_000 })
  await resetLongTasks(page)
  const before = await metrics(cdp)
  const started = Date.now()
  await button.click()
  await page.waitForFunction(() => {
    const scroller = window.__dshTranscriptScroller
    if (document.querySelector('[data-chat-following-tail]') === null) return false
    return scroller !== undefined && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4
  }, undefined, { timeout: 15_000, polling: 16 })
  const elapsedMs = Date.now() - started
  const after = await metrics(cdp)
  const dom = await domStats(page)
  return {
    elapsedMs,
    taskMs: after.task - before.task,
    scriptMs: after.script - before.script,
    layoutMs: after.layout - before.layout,
    longTasks: await readLongTasks(page),
    dom,
  }
}

async function measureHistorySearch(page, sessionId, marker) {
  const started = Date.now()
  const response = await page.evaluate(async ({ target, query }) => {
    return await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
      action: 'session-query-probe', query, sessionId: target, limit: 20,
    })
  }, { target: sessionId, query: marker })
  assert.equal(response?.ok, true, `history search failed: ${JSON.stringify(response)}`)
  const result = response.sessionQuery
  return {
    marker,
    wallMs: Date.now() - started,
    withinSession: result?.withinSession,
    searchBackend: result?.searchBackend,
    searchError: result?.searchError,
  }
}

async function run() {
  const image = await createRuntimeValidationDist({ roster: 'browser-session-query' })
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-long-session-usability-'))
  let browser
  let context
  let page
  let app
  try {
    app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
    const origin = await app.listen(0)
    browser = await chromium.launch({ headless: true, channel: browserChannel })
    context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } })
    page = await context.newPage()
    const recorder = createRecorder(page, origin)
    await openPreview(page, previewUrl(origin))
    await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })
    await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
    await installLongTaskObserver(page)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable')

    const state = { sessionId: undefined }
    const turnDurations = []
    for (let index = 1; index <= turnCount; index += 1) {
      const toolTurn = index === disclosureTurn
      const prompt = toolTurn
        ? `${MARKER} turn-${pad(index)} ${TOOL_MARKER}: record the account scope file before finishing.`
        : `${MARKER} turn-${pad(index)}: keep the transcript navigable.`
      const turn = await sendTurn({
        page,
        origin,
        requests: recorder.requests,
        prompt,
        marker: toolTurn ? `${TOOL_MARKER}_DONE` : 'Browser-native DSH completed this turn',
        ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
      })
      state.sessionId = turn.sessionId
      turnDurations.push(turn.elapsedMs)
    }
    assert.equal(turnDurations.length, turnCount)
    const sessionId = state.sessionId
    assert.ok(sessionId)

    const initial = await domStats(page)
    assert.equal(initial.followingTail, true, 'the completed session must rest at the live tail')
    assert.equal(initial.windowHiddenTurns, turnCount - windowTurns,
      `the followed tail must window out ${String(turnCount - windowTurns)} Turns: ${JSON.stringify(initial)}`)
    assert.equal(await page.locator('[data-chat-turn="1"]').count(), 0, 'turn 1 must be windowed out before the search')

    // History search must reach a Turn that the transcript window does not mount.
    const search = await measureHistorySearch(page, sessionId, `${MARKER} turn-${pad(1)}`)
    const searchHits = search.withinSession?.hits ?? 0

    const loadedJump = await measureJump(page, cdp, disclosureTurn)
    const disclosure = await measureDisclosure(page, cdp, disclosureTurn)
    const unloadedJump = await measureJump(page, cdp, unloadedTarget)
    const toLatest = await measureReturnToLatest(page, cdp)

    const failures = []
    const check = (condition, label) => { if (!condition) failures.push(label) }
    check(searchHits >= 1, `history search must find the windowed-out turn 1 marker: ${JSON.stringify(search)}`)
    check(search.withinSession?.sessionId === sessionId, 'history search must report the requested Session')
    check((search.withinSession?.ms ?? Number.POSITIVE_INFINITY) <= searchBudgetMs,
      `history search took ${String(search.withinSession?.ms)} ms, budget ${String(searchBudgetMs)} ms`)
    check(loadedJump.activeTurn === disclosureTurn,
      `loaded jump must activate turn ${String(disclosureTurn)}, got ${String(loadedJump.activeTurn)}`)
    check(loadedJump.elapsedMs <= loadedJumpBudgetMs,
      `loaded jump took ${String(loadedJump.elapsedMs)} ms, budget ${String(loadedJumpBudgetMs)} ms`)
    check(unloadedJump.activeTurn === unloadedTarget,
      `unloaded jump must activate turn ${String(unloadedTarget)}, got ${String(unloadedJump.activeTurn)}`)
    check(unloadedJump.elapsedMs <= jumpBudgetMs,
      `unloaded jump took ${String(unloadedJump.elapsedMs)} ms, budget ${String(jumpBudgetMs)} ms`)
    check(unloadedJump.domAfter.windowHiddenTurns === unloadedTarget - 1,
      `jumping to turn ${String(unloadedTarget)} must reveal exactly its prefix: ${String(unloadedJump.domAfter.windowHiddenTurns)} hidden`)
    check(unloadedJump.domAfter.nodes <= domNodeBudget,
      `revealed transcript has ${String(unloadedJump.domAfter.nodes)} DOM nodes, budget ${String(domNodeBudget)}`)
    check(disclosure.opened.expanded === 'true' && disclosure.folded.expanded === 'false',
      'the process disclosure must toggle aria-expanded both ways')
    check(disclosure.opened.hiddenMembers === 0,
      `expanded process must hide no members: ${String(disclosure.opened.hiddenMembers)}`)
    check(disclosure.folded.hiddenMembers > 0,
      'folded process must mark its members hidden')
    check(disclosure.folded.textLength < disclosure.opened.textLength,
      'folding the process must reduce rendered text')
    check(Math.max(disclosure.opened.elapsedMs, disclosure.folded.elapsedMs) <= disclosureBudgetMs,
      `process disclosure took ${String(Math.max(disclosure.opened.elapsedMs, disclosure.folded.elapsedMs))} ms, budget ${String(disclosureBudgetMs)} ms`)
    check(toLatest.elapsedMs <= toLatestBudgetMs,
      `return to latest took ${String(toLatest.elapsedMs)} ms, budget ${String(toLatestBudgetMs)} ms`)
    check(toLatest.dom.followingTail === true, 'return to latest must resume tail following')
    for (const [label, operation] of [
      ['loaded jump', loadedJump], ['unloaded jump', unloadedJump],
      ['process expand', disclosure.opened], ['process collapse', disclosure.folded], ['return to latest', toLatest],
    ]) {
      check(operation.longTasks.longestMs <= longTaskBudgetMs,
        `${label}: longest task ${String(operation.longTasks.longestMs)} ms exceeds ${String(longTaskBudgetMs)} ms`)
    }
    check(recorder.pageErrors.length === 0, 'the page must not report errors')
    check(recorder.nonLocalRequests.length === 0, 'the browser must not issue any non-local request')

    const report = {
      result: failures.length === 0 ? 'passed' : 'failed',
      browser: browserChannel,
      viewport: { width: 1440, height: 1000 },
      turnCount,
      disclosureTurn,
      unloadedTarget,
      budgets: {
        loadedJumpMs: loadedJumpBudgetMs, unloadedJumpMs: jumpBudgetMs, searchMs: searchBudgetMs,
        disclosureMs: disclosureBudgetMs, toLatestMs: toLatestBudgetMs, longTaskMs: longTaskBudgetMs, domNodes: domNodeBudget,
      },
      turns: {
        completed: turnDurations.length,
        medianMs: median(turnDurations),
        maxMs: Math.max(...turnDurations),
      },
      initial,
      historySearch: search,
      loadedJump,
      disclosure,
      unloadedJump,
      returnToLatest: toLatest,
      pageErrors: recorder.pageErrors,
      nonLocalRequests: recorder.nonLocalRequests,
      failures,
    }
    console.log(JSON.stringify(report))
    assert.deepEqual(failures, [])
  } finally {
    if (page !== undefined) await page.close().catch(() => {})
    if (context !== undefined) await context.close().catch(() => {})
    if (browser !== undefined) await browser.close().catch(() => {})
    if (app !== undefined) await app.close().catch(() => {})
    if (image !== undefined) await image.cleanup().catch(() => {})
    await rm(dataDir, { recursive: true, force: true })
  }
}

await run()
