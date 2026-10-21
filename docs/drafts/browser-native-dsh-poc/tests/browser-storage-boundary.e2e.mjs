import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium, webkit } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
const port = Number(process.env.DSH_POC_PORT ?? '0')
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-storage-e2e-')))

if (!['chrome', 'chromium', 'webkit'].includes(browserName)) throw new Error('DSH_POC_BROWSER must be chrome, chromium, or webkit')
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DSH_POC_PORT must be a TCP port')

let image
let app
let browser
let page
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(port)
  const launcher = browserName === 'webkit' ? webkit : chromium
  browser = await launcher.launch({ headless: true, ...(browserName === 'chrome' ? { channel: 'chrome' } : {}) })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  await openPreview(page, `${origin}/preview.html?browser-native=1&preview-fixture=none`)
  const result = await page.evaluate(async () => {
    let estimate
    let estimateError
    try {
      estimate = typeof navigator.storage?.estimate === 'function'
        ? await navigator.storage.estimate()
        : undefined
    } catch (error) {
      estimateError = { name: error.name, message: error.message }
    }
    let persisted
    let persistedError
    try {
      persisted = typeof navigator.storage?.persisted === 'function'
        ? await navigator.storage.persisted()
        : undefined
    } catch (error) {
      persistedError = { name: error.name, message: error.message }
    }
    const opfs = { supported: typeof navigator.storage?.getDirectory === 'function' }
    if (opfs.supported) {
      let root
      let name
      try {
        root = await navigator.storage.getDirectory()
        name = `dsh-storage-probe-${crypto.randomUUID()}.txt`
        const handle = await root.getFileHandle(name, { create: true })
        const writable = await handle.createWritable()
        await writable.write('BROWSER_OPFS_PROBE_OK')
        await writable.close()
        const file = await (await root.getFileHandle(name)).getFile()
        opfs.readBack = await file.text()
      } catch (error) {
        opfs.error = { name: error.name, message: error.message }
      } finally {
        if (root !== undefined && name !== undefined) {
          try { await root.removeEntry(name) } catch {}
        }
      }
    }
    return { estimate, estimateError, persisted, persistedError, opfs }
  })
  assert.equal(result.opfs.supported === false || result.opfs.readBack === 'BROWSER_OPFS_PROBE_OK' || result.opfs.error !== undefined, true,
    `OPFS probe did not round-trip: ${JSON.stringify(result)}`)
  process.stdout.write(`${JSON.stringify({ browser: browserName, ...result })}\n`)
} finally {
  await page?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
