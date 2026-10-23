import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(`${tmpdir()}/dsh-browser-capacity-`))
const repetitions = 3
const workloads = [
  { name: 'many-small', files: 64, bytesPerFile: 256 },
  { name: 'multi-medium', files: 8, bytesPerFile: 16_384 },
  { name: 'few-large', files: 2, bytesPerFile: 524_288 },
]
const samples = []
const pageErrors = []
let image
let app
let browser

async function waitForWorkspace(page, revision) {
  await page.waitForFunction(expected => {
    const status = window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__
    return status?.state === 'synced' && status.dirtyCount === 0
      && (expected === undefined || status.revision >= expected)
  }, revision, { timeout: 60_000 })
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  for (const workload of workloads) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
      const page = await context.newPage()
      const commitRequests = []
      page.on('pageerror', error => pageErrors.push(error.message))
      page.on('request', request => {
        if (!new URL(request.url()).pathname.endsWith('/workspace/commit')) return
        let body = {}
        try { body = JSON.parse(request.postData() ?? '{}') } catch {}
        commitRequests.push({
          request,
          status: undefined,
          operationId: body.operationId,
          baseRevision: body.baseRevision,
          changeCount: Array.isArray(body.changes) ? body.changes.length : undefined,
          paths: Array.isArray(body.changes) ? body.changes.map(change => change.path) : [],
          startedAt: Date.now(),
        })
      })
      page.on('response', response => {
        if (!new URL(response.url()).pathname.endsWith('/workspace/commit')) return
        const record = commitRequests.find(request => request.request === response.request())
        if (record !== undefined) {
          record.status = response.status()
          record.completedAt = Date.now()
        }
      })
      try {
        const opened = await openPreview(page, `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none`)
        await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
        await waitForWorkspace(page)
        const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
        const before = await page.evaluate(async () => await navigator.storage.estimate())
        const frameSamples = await page.evaluate(() => {
          const state = { previous: performance.now(), intervals: [], active: true, frame: 0 }
          const tick = now => {
            if (!state.active) return
            state.intervals.push(now - state.previous)
            state.previous = now
            state.frame = requestAnimationFrame(tick)
          }
          state.frame = requestAnimationFrame(tick)
          window.__dshCapacityFrames = state
          return true
        })
        assert.equal(frameSamples, true)
        const writeStartedAt = performance.now()
        const expectedPaths = []
        for (let index = 0; index < workload.files; index += 1) {
          const path = `/dsh/home/workspace/cap-${workload.name}-${repetition}-${String(index).padStart(3, '0')}.bin`
          const char = String.fromCharCode(65 + ((index + repetition) % 26))
          const content = char.repeat(workload.bytesPerFile)
          const result = await page.evaluate(async value => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
            action: 'write', path: value.path, content: value.content,
          }), { path, content })
          assert.equal(result?.ok, true, JSON.stringify({ workload, repetition, index, result }))
          expectedPaths.push(path.slice('/dsh/home/workspace/'.length))
        }
        const localDurableMs = performance.now() - writeStartedAt
        const commitStartedAt = performance.now()
        const flush = await page.evaluate(async () => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({ action: 'flush-workspace' }))
        assert.equal(flush?.ok, true, JSON.stringify(flush))
        await waitForWorkspace(page, 1)
        const workspaceCommitMs = performance.now() - commitStartedAt
        assert.equal(commitRequests.length > 0, true, 'the workload must produce a Workspace commit')
        assert.equal(commitRequests.every(request => request.status === 200), true, JSON.stringify(commitRequests.map(request => ({
          operationId: request.operationId,
          status: request.status,
          paths: request.paths,
        }))))
        const manifest = await page.evaluate(async id => await (await fetch(
          `/api/browser-native/workspace/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(id)}`,
        )).json(), workspaceId)
        assert.deepEqual(manifest.entries.map(entry => entry.path).sort(), expectedPaths.sort())
        const after = await page.evaluate(async () => await navigator.storage.estimate())
        const frameMetrics = await page.evaluate(() => {
          const state = window.__dshCapacityFrames
          state.active = false
          cancelAnimationFrame(state.frame)
          const sorted = [...state.intervals].sort((left, right) => left - right)
          return {
            frameCount: sorted.length,
            maxFrameMs: sorted.at(-1) ?? 0,
            p95FrameMs: sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0,
          }
        })
        const reloadStartedAt = performance.now()
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.waitForFunction(() => typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function', undefined, { timeout: 30_000 })
        await waitForWorkspace(page, manifest.revision)
        const hydrateMs = performance.now() - reloadStartedAt
        const recovered = await page.evaluate(async paths => {
          const results = []
          for (const path of paths) results.push(await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__?.({
            action: 'read', path: `/dsh/home/workspace/${path}`,
          }))
          return results
        }, expectedPaths)
        assert.equal(recovered.length, workload.files)
        assert.equal(recovered.every(result => result?.ok === true), true)
        samples.push({
          workload: workload.name,
          repetition,
          browserVersion: browser.version(),
          platform: process.platform,
          fileCount: workload.files,
          bytes: workload.files * workload.bytesPerFile,
          startupToWorkspaceReadyMs: opened.elapsedMs,
          localVfsOpfsIndexedDbWriteMs: localDurableMs,
          workspaceCommitMs,
          refreshHydrateMs: hydrateMs,
          durableStorageEstimateBefore: before,
          durableStorageEstimateAfter: after,
          workspaceRevision: manifest.revision,
          workspaceCommitRequests: commitRequests.length,
          workspaceCommits: commitRequests.map(({ operationId, baseRevision, changeCount, paths, status, startedAt, completedAt }) => ({
            operationId,
            baseRevision,
            changeCount,
            paths,
            status,
            ...(completedAt === undefined ? {} : { elapsedMs: completedAt - startedAt }),
          })),
          frameMetrics,
          restoredFiles: recovered.length,
        })
      } finally {
        await context.close()
      }
    }
  }
  assert.deepEqual(pageErrors, [])
  const result = { result: 'passed', browser: 'chrome', repetitions, samples, pageErrors }
  if (process.env.DSH_POC_RESULT_FILE !== undefined) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(resolve(process.env.DSH_POC_RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
