import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, sendTurn, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const playwrightModule = playwright.default ?? playwright
const engineName = process.env.DSH_POC_BROWSER_ENGINE ?? 'webkit'
const engine = playwrightModule[engineName]
if (typeof engine?.launch !== 'function') throw new Error(`Unknown Playwright engine: ${engineName}`)
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-webkit-capability-`))
const requests = []
const pageErrors = []
const consoleErrors = []
const externalRequests = []
let image
let app
let browser
let context
let page
let baseOrigin

async function workspaceTest(page, request) {
  return await page.evaluate(async value => {
    const test = window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__
    if (typeof test !== 'function') throw new Error('Browser-Native test port is unavailable')
    return await test(value)
  }, request)
}

function watchPage(currentPage) {
  currentPage.on('pageerror', error => pageErrors.push(error.message))
  currentPage.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  currentPage.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== baseOrigin) externalRequests.push(request.url())
    if (url.pathname.startsWith('/api/browser-native/')) {
      let body
      try { body = request.postDataJSON() } catch { body = undefined }
      requests.push({ path: url.pathname, method: request.method(), body })
    }
  })
}

/**
 * Record what the browser exposes for the Browser-Native storage, worker, and coordination APIs.
 * The OPFS checks run on the page and in a dedicated Worker because Chromium exposes sync access
 * handles only to Workers, and WebKit may fail `getDirectory()` on the page while a Worker succeeds.
 * @returns {Promise<object>} Capability facts used by the verdict.
 */
async function capabilitySnapshot() {
  return await page.evaluate(async () => {
    const opfsProbe = async () => {
      try {
        const root = await navigator.storage.getDirectory()
        const handle = await root.getFileHandle('webkit-capability-probe', { create: true })
        const syncHandle = typeof handle.createSyncAccessHandle === 'function'
          ? await handle.createSyncAccessHandle().then(access => { access.close(); return true }, () => false)
          : false
        await root.removeEntry('webkit-capability-probe').catch(() => {})
        return { opfs: true, syncAccessHandle: syncHandle }
      } catch (error) {
        return {
          opfs: typeof navigator.storage?.getDirectory === 'function',
          syncAccessHandle: false,
          failure: error instanceof Error ? error.message : String(error),
        }
      }
    }
    const workerOpfsProbe = () => new Promise(resolve => {
      const source = `self.onmessage = async () => {
        try {
          const root = await navigator.storage.getDirectory()
          const handle = await root.getFileHandle('webkit-capability-worker-probe', { create: true })
          const access = await handle.createSyncAccessHandle()
          access.close()
          await root.removeEntry('webkit-capability-worker-probe').catch(() => {})
          self.postMessage({ opfs: true, syncAccessHandle: true })
        } catch (error) {
          self.postMessage({ opfs: typeof navigator.storage?.getDirectory === 'function', syncAccessHandle: false,
            failure: String(error && error.message || error) })
        }
      }`
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
      const timer = setTimeout(() => resolve({ opfs: false, syncAccessHandle: false, failure: 'worker probe timed out' }), 15_000)
      worker.addEventListener('message', event => { clearTimeout(timer); worker.terminate(); resolve(event.data) })
      worker.addEventListener('error', event => {
        clearTimeout(timer); worker.terminate()
        resolve({ opfs: false, syncAccessHandle: false, failure: event.message || 'worker probe failed' })
      })
      worker.postMessage('probe')
    })
    const moduleWorker = (() => {
      try {
        return new Worker(URL.createObjectURL(new Blob(['export {}'], { type: 'module' })), { type: 'module' }) instanceof Worker
      } catch {
        return false
      }
    })()
    return {
      userAgent: navigator.userAgent,
      secureContext: window.isSecureContext,
      page: await opfsProbe(),
      worker: await workerOpfsProbe(),
      dedicatedWorker: typeof window.Worker === 'function',
      moduleWorker,
      cryptoSubtle: typeof crypto.subtle?.digest === 'function',
      sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
      broadcastChannel: typeof BroadcastChannel === 'function',
      locks: typeof navigator.locks?.request === 'function',
    }
  })
}

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  baseOrigin = new URL(origin).origin
  browser = await engine.launch()
  context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = await context.newPage()
  watchPage(page)

  const ephemeralUrl = `${origin}/preview.html?browser-native=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await page.goto(ephemeralUrl, { waitUntil: 'domcontentloaded' })
  const capabilities = await capabilitySnapshot()
  let ephemeralState
  let ephemeral = { available: false }
  try {
    await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 45_000 })
    await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 45_000 })
    ephemeralState = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
    const lease = await workspaceTest(page, { action: 'lease-info' })
    const written = await workspaceTest(page, {
      action: 'write',
      path: '/dsh/home/workspace/webkit-capability.txt',
      content: 'webkit workspace write\n',
    })
    assert.equal(written.ok, true, JSON.stringify(written))
    const read = await workspaceTest(page, { action: 'read', path: '/dsh/home/workspace/webkit-capability.txt' })
    assert.equal(read.ok, true, JSON.stringify(read))
    assert.equal(read.content, 'webkit workspace write\n')
    ephemeral = {
      available: true,
      accessMode: lease.accessMode,
      leaseState: lease.state,
      fencingToken: lease.fencingToken,
      revision: ephemeralState.revision,
      writeReadBack: true,
    }
  } catch (error) {
    ephemeral = { available: false, error: error instanceof Error ? error.message : String(error), state: ephemeralState }
  }
  const turnPage = await context.newPage()
  watchPage(turnPage)
  let ephemeralTurn
  if (ephemeral.available) {
    try {
      await openPreview(turnPage, `${origin}/preview.html?browser-native=1&preview-fixture=none`)
      const result = await sendTurn({ page: turnPage, origin, requests, prompt: 'BROWSER_NATIVE_SCRIPTED_E2E_OK', timeout: 90_000 })
      ephemeralTurn = { completed: true, turn: result.turn, events: result.session.events.length }
    } catch (error) {
      ephemeralTurn = { completed: false, error: error instanceof Error ? error.message : String(error) }
    }
  } else {
    ephemeralTurn = { completed: false, skipped: true }
  }
  await turnPage.close().catch(() => {})

  const durableUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`
  const durableErrors = []
  const durableListener = error => durableErrors.push(error.message)
  page.on('pageerror', durableListener)
  let durable
  try {
    await page.goto(durableUrl, { waitUntil: 'domcontentloaded' })
    durable = await waitFor(async () => {
      const blocked = durableErrors.find(message => message.includes('startup blocked'))
      if (blocked !== undefined) return { available: false, startupBlocked: blocked }
      const status = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__).catch(() => undefined)
      if (status?.state === 'synced') return { available: true, state: status }
      return undefined
    }, 'durable WebKit startup outcome', 45_000)
    if (durable.available) {
      const read = await workspaceTest(page, { action: 'read', path: '/dsh/home/workspace/webkit-capability.txt' })
      durable.readBack = read.ok === true && read.content === 'webkit workspace write\n'
    }
  } catch (error) {
    durable = { available: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    page.off('pageerror', durableListener)
  }

  const verdict = durable.available
    ? (ephemeral.available && ephemeralTurn.completed ? `${engineName}-durable-and-ephemeral-supported` : `${engineName}-durable-workspace-supported`)
    : (ephemeral.available && ephemeralTurn.completed ? `${engineName}-ephemeral-only` : `${engineName}-unavailable`)
  process.stdout.write(`${JSON.stringify({
    result: 'probe',
    engine: engineName,
    browserVersion: browser.version(),
    capabilities,
    ephemeralWorkspace: ephemeral,
    ephemeralTurn,
    durableWorkspace: durable,
    pageErrors,
    consoleErrors,
    externalRequests,
    verdict,
    note: 'DSH_POC_BROWSER_ENGINE selects the Playwright engine; the default webkit shares the WebKit engine with Safari but is a separate browser. Safari requires a safaridriver session and is probed separately.',
  })}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    result: 'probe',
    engine: engineName,
    verdict: `${engineName}-harness-failed`,
    failure: error instanceof Error ? error.message : String(error),
    pageErrors,
    consoleErrors,
    externalRequests,
  })}\n`)
  throw error
} finally {
  await context?.close().catch(() => {})
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
