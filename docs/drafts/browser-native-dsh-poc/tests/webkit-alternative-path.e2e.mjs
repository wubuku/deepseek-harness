/**
 * WebKit alternative-path assessment for Browser-Native DSH.
 *
 * The pilot gate rejects Safari/WebKit before booting a Worker. This probe
 * records what WebKit actually provides, confirms the shipped gate outcome,
 * and then spoofs a Chromium UA to see how far the existing boot path gets.
 * It is an assessment, not a compatibility claim.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { webkit } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-webkit-')))
const chromeUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

const app = await createBrowserNativeV2Server({ dataDir, llmMode: 'scripted' })
const origin = await app.listen(0)
const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`
const browser = await webkit.launch({ headless: true })

try {
  const context = await browser.newContext({ locale: 'en-US' })
  const page = await context.newPage()
  await page.goto(`${origin}/health`, { waitUntil: 'domcontentloaded' })
  const capabilities = await page.evaluate(async () => {
    const state = {
      userAgent: navigator.userAgent,
      dedicatedWorker: typeof Worker === 'function',
      messageChannel: typeof MessageChannel === 'function',
      opfsDirectory: false,
      opfsWrite: false,
      indexedDb: false,
      subtleCrypto: false,
      sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
      crossOriginIsolated,
    }
    const withDeadline = async (operation, timeout = 5_000) => Promise.race([
      Promise.resolve().then(operation),
      new Promise((resolveDelay, reject) => setTimeout(() => reject(new Error('timeout')), timeout)),
    ])
    try {
      const root = await navigator.storage.getDirectory()
      state.opfsDirectory = true
      const handle = await root.getFileHandle('webkit-probe.txt', { create: true })
      const writable = await handle.createWritable()
      await writable.write('webkit-opfs-probe')
      await writable.close()
      state.opfsWrite = (await (await handle.getFile()).text()) === 'webkit-opfs-probe'
    } catch (error) { state.opfsError = String(error) }
    try {
      await withDeadline(() => new Promise((resolveWorker, rejectWorker) => {
        const source = `
          self.onmessage = async () => {
            const state = { directory: false, syncAccessHandle: false }
            try {
              const root = await navigator.storage.getDirectory()
              state.directory = true
              const handle = await root.getFileHandle('webkit-worker-probe.txt', { create: true })
              const access = await handle.createSyncAccessHandle()
              state.syncAccessHandle = true
              access.close()
            } catch (error) { state.error = String(error) }
            self.postMessage(state)
          }`
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
        worker.onmessage = event => { state.workerStorage = event.data; worker.terminate(); resolveWorker() }
        worker.onerror = event => { rejectWorker(new Error(event.message)); worker.terminate() }
        worker.postMessage('ok')
      }))
    } catch (error) { state.workerStorage = { error: String(error) } }
    try {
      await withDeadline(() => new Promise((resolveDb, rejectDb) => {
        const request = indexedDB.open('webkit-probe', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('probe')
        request.onsuccess = () => { state.indexedDb = true; request.result.close(); resolveDb() }
        request.onerror = () => rejectDb(request.error)
      }))
    } catch { state.indexedDb = false }
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('probe'))
      state.subtleCrypto = digest.byteLength === 32
    } catch { state.subtleCrypto = false }
    return state
  })

  await page.goto(previewUrl, { waitUntil: 'domcontentloaded' })
  const notice = page.locator('[data-browser-native-unsupported]')
  await notice.waitFor({ state: 'visible', timeout: 30_000 })
  const gate = {
    state: await notice.getAttribute('data-browser-native-unsupported'),
    composer: await page.locator('[data-composer-input]').count(),
    workerBooted: false,
  }
  assert.equal(gate.state, 'NON_CHROMIUM_DESKTOP')
  assert.equal(gate.composer, 0)

  const spoofContext = await browser.newContext({ locale: 'en-US', userAgent: chromeUserAgent })
  const spoofPage = await spoofContext.newPage()
  const consoleErrors = []
  spoofPage.on('pageerror', error => consoleErrors.push(error.message))
  spoofPage.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await spoofPage.goto(previewUrl, { waitUntil: 'domcontentloaded' })
  let spoofOutcome
  try {
    await spoofPage.locator('[data-composer-input][contenteditable="true"]').last().waitFor({ timeout: 45_000 })
    spoofOutcome = 'composer'
  } catch {
    spoofOutcome = (await spoofPage.locator('[data-browser-native-unsupported]').count()) === 1
      ? `unsupported:${await spoofPage.locator('[data-browser-native-unsupported]').getAttribute('data-browser-native-unsupported')}`
      : 'failed'
  }
  const spoofState = await spoofPage.evaluate(() => ({
    workspaceStatus: Boolean(window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__),
    durable: Boolean(window.__DSH_BROWSER_NATIVE_DURABLE__),
    workerTestPort: typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__,
  })).catch(() => ({}))

  const result = {
    result: 'passed',
    webkitVersion: browser.version(),
    capabilities,
    gate,
    spoofedChromium: { outcome: spoofOutcome, state: spoofState, consoleErrors: consoleErrors.slice(0, 8) },
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  await spoofContext.close()
  await context.close()
} finally {
  await browser.close().catch(() => {})
  await app.close().catch(() => {})
}
