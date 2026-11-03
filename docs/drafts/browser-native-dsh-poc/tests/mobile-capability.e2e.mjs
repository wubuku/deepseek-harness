/**
 * Probe mobile browser capabilities that the Browser-Native Host depends on.
 *
 * Two emulated profiles are compared: iOS Safari (Playwright WebKit + iPhone
 * descriptor) and Android Chrome (Playwright Chromium + Pixel descriptor).
 * Emulation reproduces user agent, viewport, touch and device scale, but runs
 * the desktop engine, so results bound engine behavior, not real-device memory.
 *
 * The probe reports capabilities first and then attempts the real preview boot.
 * A synced Workspace requires a successful write/read through the test port; a
 * blocked boot must record an explicit startup reason instead of passing silently.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { sendTurn, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const playwrightModule = playwright.default ?? playwright

const MARKER = 'BROWSER_NATIVE_SCRIPTED_E2E_OK'
const profiles = [
  { name: 'ios-safari', engine: 'webkit', device: 'iPhone 15' },
  { name: 'android-chrome', engine: 'chromium', device: 'Pixel 7' },
]

const probePageHtml = `<!doctype html>
<meta charset="utf-8">
<title>mobile capability probe</title>
<body><p>capability probe</p></body>`

const serviceWorkerSource = `self.addEventListener('install', event => { self.skipWaiting() })
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()) })
self.addEventListener('message', event => { if (event.data) event.source?.postMessage({ echoed: event.data }) })`

/**
 * Collect browser facts on the current page and inside a dedicated Worker.
 * @returns {Promise<object>} Capability record for the verdict.
 */
async function capabilitySnapshot(page) {
  return await page.evaluate(async () => {
    const opfsState = async () => {
      try {
        const root = await navigator.storage.getDirectory()
        const name = `mobile-probe-${String(Math.random()).slice(2)}`
        const handle = await root.getFileHandle(name, { create: true })
        const access = typeof handle.createSyncAccessHandle === 'function' ? await handle.createSyncAccessHandle() : null
        const syncAccessHandle = access !== null
        if (access !== null) access.close()
        await root.removeEntry(name).catch(() => {})
        return { opfs: true, syncAccessHandle }
      } catch (error) {
        return {
          opfs: typeof navigator.storage?.getDirectory === 'function',
          syncAccessHandle: false,
          failure: error instanceof Error ? error.message : String(error),
        }
      }
    }
    const workerState = () => new Promise(resolve => {
      const source = `self.onmessage = async () => {
        let opfs = false, syncAccessHandle = false, failure
        try {
          const root = await navigator.storage.getDirectory()
          opfs = true
          const name = 'mobile-probe-worker-' + Math.random().toString().slice(2)
          const handle = await root.getFileHandle(name, { create: true })
          const access = await handle.createSyncAccessHandle()
          access.write(new Uint8Array([1, 2, 3]))
          access.flush()
          access.close()
          await root.removeEntry(name).catch(() => {})
          syncAccessHandle = true
        } catch (error) {
          failure = String(error && error.message || error)
        }
        self.postMessage({ opfs, syncAccessHandle, failure, indexedDB: typeof indexedDB !== 'undefined' })
      }`
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
      const timer = setTimeout(() => resolve({ opfs: false, syncAccessHandle: false, failure: 'worker probe timed out' }), 20_000)
      worker.addEventListener('message', event => { clearTimeout(timer); worker.terminate(); resolve(event.data) })
      worker.addEventListener('error', event => {
        clearTimeout(timer); worker.terminate()
        resolve({ opfs: false, syncAccessHandle: false, failure: event.message || 'worker probe failed' })
      })
      worker.postMessage('probe')
    })
    const serviceWorker = async () => {
      if (!navigator.serviceWorker) return { available: false, registered: false }
      try {
        const registration = await navigator.serviceWorker.register('/mobile-probe-sw.js', { scope: '/' })
        await navigator.serviceWorker.ready
        return { available: true, registered: true, state: registration.active?.state ?? null }
      } catch (error) {
        return { available: true, registered: false, failure: error instanceof Error ? error.message : String(error) }
      }
    }
    const storage = async () => {
      try {
        const estimate = await navigator.storage.estimate()
        const persisted = typeof navigator.storage.persisted === 'function'
          ? await navigator.storage.persisted()
          : null
        return { quota: estimate.quota ?? null, usage: estimate.usage ?? null, persisted }
      } catch (error) {
        return { quota: null, usage: null, failure: error instanceof Error ? error.message : String(error) }
      }
    }
    let moduleWorker = false
    try {
      moduleWorker = new Worker(URL.createObjectURL(new Blob(['export {}'], { type: 'module' })), { type: 'module' }) instanceof Worker
    } catch {}
    return {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemory: navigator.deviceMemory ?? null,
      jsHeapSizeLimit: performance.memory?.jsHeapSizeLimit ?? null,
      jsHeapUsedSize: performance.memory?.usedJSHeapSize ?? null,
      measureUserAgentSpecificMemory: typeof performance.measureUserAgentSpecificMemory === 'function',
      secureContext: window.isSecureContext,
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
      page: await opfsState(),
      worker: await workerState(),
      dedicatedWorker: typeof window.Worker === 'function',
      moduleWorker,
      cryptoSubtle: typeof crypto.subtle?.digest === 'function',
      sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
      crossOriginIsolated: window.crossOriginIsolated === true,
      broadcastChannel: typeof BroadcastChannel === 'function',
      locks: typeof navigator.locks?.request === 'function',
      indexedDb: typeof indexedDB !== 'undefined',
      serviceWorker: await serviceWorker(),
      storage: await storage(),
    }
  })
}

/**
 * Boot the durable preview and prove a synced Workspace is usable.
 * @param {object} options - Page, origin, request log and error log.
 * @returns {Promise<object>} Boot outcome with an explicit failure reason when blocked.
 */
async function bootPreview({ page, origin, requests, pageErrors }) {
  const url = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  try {
    const outcome = await waitFor(async () => {
      const blocked = pageErrors.find(message => message.includes('startup blocked'))
      if (blocked !== undefined) return { synced: false, startupBlocked: blocked }
      const status = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__).catch(() => undefined)
      if (status?.state === 'synced') return { synced: true, state: status }
      return undefined
    }, 'durable preview startup outcome', 60_000)
    if (!outcome.synced) return outcome
    await waitForPreview(page)
    const written = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__({
      action: 'write', path: '/dsh/home/workspace/mobile-capability.txt', content: 'mobile capability\n',
    }))
    assert.equal(written.ok, true, JSON.stringify(written))
    const read = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__({
      action: 'read', path: '/dsh/home/workspace/mobile-capability.txt',
    }))
    assert.equal(read.content, 'mobile capability\n', JSON.stringify(read))
    const turn = await sendTurn({ page, origin, requests, prompt: `${MARKER} mobile capability`, marker: MARKER, timeout: 120_000 })
    return { synced: true, state: outcome.state, writeReadBack: true, turn: turn.turn, events: turn.session.events.length }
  } catch (error) {
    return {
      synced: false,
      error: error instanceof Error ? error.message : String(error),
      pageErrors: [...pageErrors],
    }
  }
}

let image
const dataDirs = []
const results = []

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  for (const profile of profiles) {
    const engine = playwrightModule[profile.engine]
    if (typeof engine?.launch !== 'function') throw new Error(`Unknown Playwright engine: ${profile.engine}`)
    const descriptor = playwrightModule.devices[profile.device]
    assert.ok(descriptor, `Playwright device descriptor ${profile.device} is unavailable`)
    const dataDir = await mkdtemp(`${tmpdir()}/dsh-browser-${profile.name}-`)
    dataDirs.push(dataDir)
    const app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
    const origin = await app.listen(0)
    const browser = await engine.launch()
    const browserVersion = browser.version()
    const context = await browser.newContext({ ...descriptor, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
    const requests = []
    const pageErrors = []
    const externalRequests = []
    const page = await context.newPage()
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin !== new URL(origin).origin) externalRequests.push(request.url())
      if (!url.pathname.startsWith('/api/browser-native/')) return
      let body
      try { body = request.postDataJSON() } catch { body = undefined }
      requests.push({ path: url.pathname, body })
    })
    await context.route(`${origin}/mobile-probe.html`, route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: probePageHtml,
    }))
    await context.route(`${origin}/mobile-probe-sw.js`, route => route.fulfill({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      body: serviceWorkerSource,
    }))
    let capabilities
    let boot
    try {
      await page.goto(`${origin}/mobile-probe.html`, { waitUntil: 'domcontentloaded' })
      capabilities = await capabilitySnapshot(page)
      boot = await bootPreview({ page, origin, requests, pageErrors })
    } finally {
      await context.close().catch(() => {})
      await browser.close()
      await app.close()
    }
    const probeComplete = ['userAgent', 'page', 'worker', 'serviceWorker', 'storage', 'moduleWorker', 'crossOriginIsolated']
      .every(key => capabilities?.[key] !== undefined)
    assert.equal(probeComplete, true, `${profile.name} capability probe did not return every field`)
    const verdict = boot.synced
      ? 'durable-workspace-supported'
      : (boot.startupBlocked ?? boot.error) !== undefined ? 'startup-blocked' : 'startup-unknown'
    results.push({
      profile: profile.name,
      engine: profile.engine,
      device: profile.device,
      browserVersion,
      capabilities,
      boot,
      pageErrors: [...new Set(pageErrors)],
      externalRequests,
      verdict,
    })
    process.stderr.write(`mobile capability: ${profile.name} -> ${verdict}\n`)
  }
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    scope: 'mobile-capability-probe',
    note: 'Emulated device descriptors reproduce user agent, viewport, touch and device scale on desktop engines; real-device memory limits and iOS Safari remain untested.',
    profiles: results,
  })}\n`)
} finally {
  await image?.cleanup()
  for (const dataDir of dataDirs) await rm(dataDir, { recursive: true, force: true })
}
