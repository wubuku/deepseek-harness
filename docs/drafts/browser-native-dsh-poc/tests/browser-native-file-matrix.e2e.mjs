import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightModule = process.env.DSH_POC_PLAYWRIGHT_MODULE
  ?? (() => {
    try { return require.resolve('playwright') } catch {
      throw new Error('Set DSH_POC_PLAYWRIGHT_MODULE to an installed Playwright entry')
    }
  })()
const playwright = await import(playwrightModule)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-file-matrix-`))

let image
let app
let browser
let page
const pageErrors = []
const nonLocalRequests = []
try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== new URL(origin).origin) nonLocalRequests.push(request.url())
  })
  await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
  await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })

  const call = async request => await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.(value), request)
  const root = '/dsh/home/workspace'
  assert.equal((await call({ action: 'mkdir', path: `${root}/matrix`, mode: 0o750 }))?.ok, true)
  assert.equal((await call({ action: 'write', path: `${root}/matrix/unicode-文件.txt`, content: '第一行\n' }))?.ok, true)
  assert.equal((await call({ action: 'append', path: `${root}/matrix/unicode-文件.txt`, content: '第二行\n' }))?.ok, true)
  const textStat = await call({ action: 'stat', path: `${root}/matrix/unicode-文件.txt` })
  assert.deepEqual({ kind: textStat?.kind, bytes: textStat?.bytes }, { kind: 'file', bytes: 20 })
  assert.equal((await call({ action: 'chmod', path: `${root}/matrix/unicode-文件.txt`, mode: 0o640 }))?.ok, true)
  const directoryListing = await call({ action: 'list', path: `${root}/matrix` })
  assert.deepEqual(directoryListing?.entries, ['unicode-文件.txt'])
  assert.equal((await call({ action: 'rename', from: `${root}/matrix/unicode-文件.txt`, to: `${root}/matrix/renamed.txt` }))?.ok, true)
  assert.equal((await call({ action: 'read', path: `${root}/matrix/renamed.txt` }))?.content, '第一行\n第二行\n')
  assert.equal((await call({ action: 'write', path: `${root}/matrix/empty.txt`, content: '' }))?.ok, true)
  assert.equal((await call({ action: 'write-binary', path: `${root}/matrix/binary.bin`, base64: 'AP+AQQ==' }))?.ok, true)

  const staging = `${root}/.result.txt.1.123e4567-e89b-12d3-a456-426614174000.tmpdir`
  assert.equal((await call({ action: 'mkdir', path: staging }))?.ok, true)
  assert.equal((await call({ action: 'write', path: `${staging}/result.txt.tmp`, content: 'atomic result\n' }))?.ok, true)
  assert.equal((await call({ action: 'rename', from: `${staging}/result.txt.tmp`, to: `${root}/result.txt` }))?.ok, true)
  assert.equal((await call({ action: 'remove', path: staging }))?.ok, true)
  assert.equal((await call({ action: 'remove', path: `${root}/matrix/empty.txt` }))?.ok, true)
  const flushed = await call({ action: 'flush-workspace' })
  assert.equal(flushed?.ok, true, JSON.stringify(flushed))
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced'
    && window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.dirtyCount === 0, undefined, { timeout: 30_000 })

  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  const manifest = await page.evaluate(async id => await (await fetch(
    `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
  )).json(), workspaceId)
  const paths = manifest.entries.map(entry => entry.path).sort()
  assert.deepEqual(paths, ['matrix', 'matrix/binary.bin', 'matrix/renamed.txt', 'result.txt'])
  assert.equal(paths.some(path => path.includes('.tmpdir')), false)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(nonLocalRequests, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    browser: 'chrome',
    scope: 'Worker-VFS-file-operation-matrix',
    workspaceId,
    revision: manifest.revision,
    paths,
    pageErrors,
    nonLocalRequests,
  })}\n`)
} finally {
  await page?.close()
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
