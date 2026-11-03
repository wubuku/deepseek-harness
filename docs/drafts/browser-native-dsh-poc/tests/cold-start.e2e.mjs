import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const { chromium } = playwright.default ?? playwright
const browserName = process.env.DSH_POC_BROWSER ?? 'chrome'
const scale = Number(process.env.DSH_POC_COLD_SCALE ?? 16)
const rounds = Number(process.env.DSH_POC_COLD_ROUNDS ?? 2)
const fault = process.env.DSH_POC_COLD_FAULT === '1'
const previewUrl = '/preview.html?browser-native=1&preview-fixture=none'
const imagePattern = '**/preview/vfs-image.tar.gz'
const dataDir = await mkdtemp(join(tmpdir(), 'dsh-cold-start-e2e-'))
const image = await createRuntimeValidationDist({ roster: 'original' })
const app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' })
const origin = await app.listen(0)
const report = { scale, rounds, fault, rounds_seen: [] }

try {
  for (let round = 0; round < rounds; round += 1) {
    const browser = await chromium.launch({ headless: true, channel: browserName })
    const contexts = await Promise.all(Array.from({ length: scale }, async () => await browser.newContext()))
    const events = []
    try {
      let routedImageRequests = 0
      for (const context of contexts) {
        if (!fault) continue
        let aborted = false
        await context.route(imagePattern, async route => {
          routedImageRequests += 1
          if (!aborted) {
            aborted = true
            await route.abort('failed')
            return
          }
          await route.continue()
        })
      }
      const startedAt = Date.now()
      const boots = await Promise.all(contexts.map(async (context, index) => {
        const page = await context.newPage()
        page.on('pageerror', error => events.push({ index, kind: 'pageerror', text: error.message }))
        const pageStartedAt = Date.now()
        try {
          await openPreview(page, `${origin}${previewUrl}`)
          return { index, ok: true, ms: Date.now() - pageStartedAt }
        } catch (error) {
          return { index, ok: false, ms: Date.now() - pageStartedAt, error: String(error).slice(0, 240) }
        }
      }))
      const failures = boots.filter(boot => !boot.ok)
      const wallMs = Date.now() - startedAt
      if (fault) assert.ok(routedImageRequests >= scale, `fault injection must reach the worker image requests; saw ${String(routedImageRequests)}`)
      assert.equal(failures.length, 0, `cold-start failures: ${JSON.stringify(failures)}`)
      report.rounds_seen.push({ round, wallMs, routedImageRequests, failures: failures.length, slowestMs: Math.max(...boots.map(boot => boot.ms)) })
      for (const event of events.filter(item => item.kind !== 'pageerror')) process.stderr.write(`${JSON.stringify(event)}\n`)
    } finally {
      await Promise.all(contexts.map(async context => await context.close()))
      await browser.close()
    }
  }
} finally {
  await app.close()
  await image.cleanup()
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
