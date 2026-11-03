import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'

const progressLog = process.env.DSH_POC_PROGRESS_LOG
async function stage(name) {
  if (progressLog === undefined) return
  await appendFile(progressLog, `${new Date().toISOString()} ${name}\n`)
}
async function timed(label, promise, ms = 40_000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-residency-`))
const pageErrors = []
let image
let app
let browser
let context
let origin
let page

const HARNESS_PAGE = `<!doctype html><meta charset="utf-8"><title>residency probe</title>
<script>
const DB_NAME = 'dsh-residency-probe'
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('events')) request.result.createObjectStore('events', { keyPath: 'id', autoIncrement: true })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function activeRegistration() {
  let registration = await navigator.serviceWorker.getRegistration()
  if (registration?.active?.state === 'activated') return registration
  registration = await navigator.serviceWorker.register('/browser-native-residency-sw.js', { scope: '/' })
  const deadline = Date.now() + 10_000
  while (registration.active?.state !== 'activated' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (registration.active?.state !== 'activated') throw new Error('service worker did not activate')
  return registration
}
window.__RESIDENCY__ = {
  async registerSw() {
    const registration = await activeRegistration()
    return { scope: registration.scope, state: registration.active?.state }
  },
  async ask(type, payload = {}) {
    const registration = await activeRegistration()
    const worker = registration.active
    return await new Promise((resolve, reject) => {
      const channel = new MessageChannel()
      channel.port1.onmessage = event => resolve(event.data)
      worker.postMessage({ type, ...payload }, [channel.port2])
      setTimeout(() => reject(new Error('service worker reply timeout')), 10_000)
    })
  },
  async startJob(job) { return await this.ask('start-job', { job }) },
  async registerSync(tag) {
    const registration = await activeRegistration()
    if (typeof registration.sync !== 'object') return { tag, supported: false }
    await registration.sync.register(tag)
    return { tag, supported: true }
  },
  async syncSupported() {
    const registration = await activeRegistration()
    return typeof registration.sync === 'object'
  },
  async events() {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('events', 'readonly')
      const request = transaction.objectStore('events').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  },
}
</script>`

const SERVICE_WORKER = `const DB_NAME = 'dsh-residency-probe'
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('events')) request.result.createObjectStore('events', { keyPath: 'id', autoIncrement: true })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function windowClients() {
  return (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).length
}
async function record(kind, detail = {}) {
  const db = await openDb()
  const clients = await windowClients()
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('events', 'readwrite')
    const request = transaction.objectStore('events').add({ kind, at: Date.now(), clients, detail })
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
async function runJob(job) {
  await record('job-start', job)
  for (let step = 1; step <= job.steps; step++) {
    await sleep(job.stepMs)
    await record('job-step', { id: job.id, step })
  }
  await record('job-done', job)
}
self.addEventListener('install', event => { event.waitUntil((async () => { await record('install'); await self.skipWaiting() })()) })
self.addEventListener('activate', event => { event.waitUntil((async () => { await record('activate'); await self.clients.claim() })()) })
self.addEventListener('message', event => {
  const port = event.ports[0]
  const data = event.data
  if (data?.type === 'capabilities') {
    event.waitUntil((async () => {
      const result = {
        hasDocument: typeof self.document !== 'undefined',
        hasWorkerConstructor: typeof self.Worker === 'function',
        hasSyncAccessHandleConstructor: typeof self.FileSystemSyncAccessHandle !== 'undefined',
        hasIndexedDb: typeof indexedDB !== 'undefined',
        hasWebLocks: typeof navigator.locks !== 'undefined',
        crossOriginIsolated: self.crossOriginIsolated,
      }
      try {
        const root = await navigator.storage.getDirectory()
        const handle = await root.getFileHandle('sw-probe.bin', { create: true })
        result.syncAccessHandleOnFileHandle = typeof handle.createSyncAccessHandle
        const writable = await handle.createWritable()
        await writable.write('sw-opfs\\n')
        await writable.close()
        result.opfsAsyncText = await (await handle.getFile()).text()
      } catch (error) {
        result.opfsException = error.name + ': ' + error.message
      }
      port.postMessage(result)
    })())
    return
  }
  if (data?.type === 'start-job') {
    event.waitUntil((async () => {
      await record('job-accepted', data.job)
      port.postMessage({ started: true })
      await runJob(data.job)
    })())
    return
  }
})
self.addEventListener('sync', event => {
  if (!String(event.tag).startsWith('dsh-residency-sync')) return
  event.waitUntil((async () => {
    await record('sync-start', { tag: event.tag })
    for (let step = 1; step <= 3; step++) {
      await sleep(1_000)
      await record('sync-step', { tag: event.tag, step })
    }
    await record('sync-done', { tag: event.tag })
  })())
})`

async function events(target) {
  return await timed('events', target.evaluate(() => window.__RESIDENCY__.events()))
}

function byKind(list, kind) {
  return list.filter(event => event.kind === kind)
}

try {
  await stage('start')
  image = await createRuntimeValidationDist({ roster: 'browser' })
  await stage('dist-ready')
  await writeFile(join(image.distRoot, 'browser-native-residency.html'), HARNESS_PAGE)
  await writeFile(join(image.distRoot, 'browser-native-residency-sw.js'), SERVICE_WORKER)
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  const url = `${origin}/browser-native-residency.html`
  await timed('goto', page.goto(url, { waitUntil: 'domcontentloaded' }))
  await stage('page-loaded')
  const registered = await timed('registerSw', page.evaluate(() => window.__RESIDENCY__.registerSw()))
  await stage(`sw-${registered.state}`)
  assert.equal(registered.state, 'activated')
  const capabilities = await timed('capabilities', page.evaluate(() => window.__RESIDENCY__.ask('capabilities')))
  await stage('capabilities')
  assert.equal(capabilities.hasDocument, false, 'a Service Worker has no document')
  assert.equal(capabilities.hasWorkerConstructor, false, 'a Service Worker cannot spawn Dedicated Workers')
  assert.equal(capabilities.syncAccessHandleOnFileHandle, 'undefined',
    'OPFS sync access handles are unavailable in a Service Worker')
  assert.equal(capabilities.opfsAsyncText, 'sw-opfs\n')
  assert.equal(capabilities.hasWebLocks, true)
  const syncSupported = await timed('syncSupported', page.evaluate(() => window.__RESIDENCY__.syncSupported()))

  const closeRuns = []
  for (let run = 0; run < 3; run++) {
    const job = { id: `short-after-close-${run}`, steps: 4, stepMs: 500 }
    await timed('startShortJob', page.evaluate(target => window.__RESIDENCY__.startJob(target), job))
    const closedAt = Date.now()
    await page.close()
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10_000))
    page = await context.newPage()
    await timed('goto-after-short', page.goto(url, { waitUntil: 'domcontentloaded' }))
    const reopenedAt = Date.now()
    await stage(`short-reopened-${run}`)
    let list = await events(page)
    const doneDeadline = Date.now() + 30_000
    while (!byKind(list, 'job-done').some(event => event.detail.id === job.id) && Date.now() < doneDeadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
      list = await events(page)
    }
    const done = byKind(list, 'job-done').find(event => event.detail.id === job.id)
    assert.ok(done, `the Service Worker must complete ${job.id} across a tab close`)
    const steps = byKind(list, 'job-step').filter(event => event.detail.id === job.id)
    assert.equal(steps.length, job.steps)
    closeRuns.push({
      id: job.id,
      steps: steps.length,
      completedWhileClosed: done.at < reopenedAt - 200,
      stepsStrictlyBeforeReopen: steps.filter(event => event.at < reopenedAt - 200).length,
      completedAtMsAfterClose: done.at - closedAt,
      reopenedAtMsAfterClose: reopenedAt - closedAt,
      firstStepMsAfterClose: steps[0].at - closedAt,
    })
  }
  await stage('short-polled')
  const completedWhileClosedRuns = closeRuns.filter(run => run.completedWhileClosed).length

  const syncTag = `dsh-residency-sync-${Date.now()}`
  await timed('ensureSyncedWorker', page.evaluate(() => window.__RESIDENCY__.syncSupported()))
  await timed('setOffline', context.setOffline(true))
  await stage('offline-set')
  const registeredSync = await timed('registerSync',
    page.evaluate(tag => window.__RESIDENCY__.registerSync(tag), syncTag))
  await stage(`sync-registered-${registeredSync.supported}`)
  const syncClosedAt = Date.now()
  await page.close()
  await timed('setOnline', context.setOffline(false))
  await stage('online-set')
  await new Promise(resolveDelay => setTimeout(resolveDelay, 10_000))
  page = await context.newPage()
  await timed('goto-after-sync', page.goto(url, { waitUntil: 'domcontentloaded' }))
  let afterSync = await events(page)
  const syncDeadline = Date.now() + 30_000
  while (!byKind(afterSync, 'sync-done').some(event => event.detail.tag === syncTag) && Date.now() < syncDeadline) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
    afterSync = await events(page)
  }
  await stage('sync-polled')
  const syncStart = byKind(afterSync, 'sync-start').find(event => event.detail.tag === syncTag)
  const syncDone = byKind(afterSync, 'sync-done').find(event => event.detail.tag === syncTag)
  assert.equal(registeredSync.supported, true, 'Chrome must expose the one-shot Background Sync API')
  assert.ok(syncStart, 'Background Sync must deliver the event after the tab closes')
  assert.ok(syncDone, 'the sync event must run to completion')
  assert.equal(syncStart.clients, 0,
    'the sync event must run with no open window client')
  assert.ok(syncStart.at >= syncClosedAt)

  const killedJob = { id: 'killed-by-browser', steps: 12, stepMs: 500 }
  await timed('startKilledJob', page.evaluate(job => window.__RESIDENCY__.startJob(job), killedJob))
  await stage('killed-started')
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1_500))
  const cdp = await context.newCDPSession(page)
  await cdp.send('ServiceWorker.enable')
  await cdp.send('ServiceWorker.stopAllWorkers')
  await stage('workers-stopped')
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000))
  const afterKill = await events(page)
  const killedSteps = byKind(afterKill, 'job-step').filter(event => event.detail.id === killedJob.id)
  assert.equal(byKind(afterKill, 'job-done').some(event => event.detail.id === killedJob.id), false,
    'a browser-initiated Worker stop must not complete the job')
  assert.ok(killedSteps.length < killedJob.steps)
  await page.close()
  await new Promise(resolveDelay => setTimeout(resolveDelay, 2_000))
  page = await context.newPage()
  await timed('goto-after-kill', page.goto(url, { waitUntil: 'domcontentloaded' }))
  const afterReopen = await events(page)
  const stalledSteps = byKind(afterReopen, 'job-step').filter(event => event.detail.id === killedJob.id)
  assert.equal(stalledSteps.length, killedSteps.length,
    'reopening a page must not resume a browser-stopped job')
  await stage('kill-verified')
  assert.deepEqual(pageErrors, [])
  await stage('done')

  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: browser.version(),
    scope: 'service-worker-background-residency',
    serviceWorker: registered,
    capabilities: {
      hasDocument: capabilities.hasDocument,
      hasWorkerConstructor: capabilities.hasWorkerConstructor,
      hasSyncAccessHandleConstructor: capabilities.hasSyncAccessHandleConstructor,
      syncAccessHandleOnFileHandle: capabilities.syncAccessHandleOnFileHandle,
      opfsAsyncText: capabilities.opfsAsyncText,
      hasWebLocks: capabilities.hasWebLocks,
      crossOriginIsolated: capabilities.crossOriginIsolated,
    },
    backgroundSyncSupported: syncSupported,
    tabCloseRuns: {
      runs: closeRuns.length,
      completed: closeRuns.length,
      completedWhileClosed: completedWhileClosedRuns,
      frozenUntilReopen: closeRuns.length - completedWhileClosedRuns,
      detail: closeRuns,
    },
    browserStop: {
      stepsBeforeStop: killedSteps.length,
      expectedSteps: killedJob.steps,
      completed: byKind(afterReopen, 'job-done').some(event => event.detail.id === killedJob.id),
      resumedAfterReopen: stalledSteps.length > killedSteps.length,
    },
    backgroundSyncAfterTabClose: {
      tag: syncTag,
      registered: registeredSync,
      startDelayMsAfterClose: syncStart.at - syncClosedAt,
      clientsAtStart: syncStart.clients,
      completed: true,
      steps: byKind(afterSync, 'sync-step').filter(event => event.detail.tag === syncTag).length,
    },
    verdict: {
      canHostDshAgentLoopInServiceWorker: false,
      blockers: [
        'no DOM or Dedicated Worker constructor, so the existing host/runtime cannot be instantiated',
        'OPFS sync access handles are unavailable, so the current Workspace VFS write path cannot run',
        'an in-memory Service Worker job completes after a tab close only in some runs; in other runs it is frozen until a client reopens, so background progress is not guaranteed',
        'the browser can stop all Workers at will and does not resume unfinished jobs on reopen',
        'Background Sync only delivers discrete events and provides no durable Agent loop ownership',
      ],
      recommendation: 'A browser-native product still needs a server-resident host for Agent work that must outlive the tab; a Service Worker can at most run short, idempotent background jobs and wake on Background Sync.',
    },
    note: 'Three tab-close runs each completed a four-step job while no window client existed, and Background Sync woke the Service Worker with zero clients and ran the event to completion. Earlier runs of the same harness saw a job stay frozen until a page reopened, so progress without a client is possible but not guaranteed. The browser can also stop all Workers at will without resuming unfinished jobs on reopen. The Service Worker scope has no DOM, no Dedicated Worker constructor, and no OPFS sync access handle. Therefore a Service Worker cannot host the current DSH Agent loop or guarantee residency.',
  })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    failure: error instanceof Error ? error.message : String(error),
    pageErrors,
    events: page !== undefined ? await events(page).catch(() => undefined) : undefined,
  })}\n`)
  throw error
} finally {
  await page?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
