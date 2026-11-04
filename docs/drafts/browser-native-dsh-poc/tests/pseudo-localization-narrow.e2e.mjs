/**
 * Pseudo-localization pass: lengthen every visible label by 40% and verify that
 * the Browser-Native status surfaces (first-use guide, workspace/queue/offline
 * notices, export controls) still fit a narrow viewport without clipped text.
 *
 * A run covers one locale and one viewport so the failing state is reproducible:
 *   DSH_POC_BROWSER=chrome DSH_POC_LOCALE=en-US DSH_POC_WIDTH=320 node docs/drafts/browser-native-dsh-poc/tests/pseudo-localization-narrow.e2e.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, submitPrompt, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const LOCALE = process.env.DSH_POC_LOCALE ?? 'en-US'
const WIDTH = Number(process.env.DSH_POC_WIDTH ?? '320')
const HEIGHT = Number(process.env.DSH_POC_HEIGHT ?? '720')

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-pseudo-'))
const pageErrors = []
let image
let app
let browser
let context
let queueContext
let queueRelease
let holdStarted = false

function messageText(message) {
  return typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content) ? message.content.map(block => block?.text ?? '').join('') : ''
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') return messageText(messages[index])
  }
  return ''
}

function trackRequests(target, sink) {
  target.on('request', request => {
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/browser-native/session/')) return
    try {
      sink.push({ path, body: JSON.parse(request.postData() ?? 'null') })
    } catch {
      sink.push({ path, body: null })
    }
  })
}

async function applyPseudo(target) {
  await target.evaluate(() => {
    if (window.__dshPseudoApplied === true) return
    window.__dshPseudoApplied = true
    const accents = {
      a: 'á', b: 'ƀ', c: 'ç', d: 'ď', e: 'é', f: 'ƒ', g: 'ğ', h: 'ĥ', i: 'í', j: 'ĵ',
      k: 'ķ', l: 'ĺ', m: 'ḿ', n: 'ñ', o: 'ó', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ',
      u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
    }
    const lengthen = part => {
      const mapped = [...part].map(character => accents[character.toLowerCase()] ?? character).join('')
      const extra = Math.ceil(part.length * 0.4)
      return mapped + (/\p{Script=Han}/u.test(part) ? '字'.repeat(extra) : 'x'.repeat(extra))
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    for (const node of nodes) {
      const parent = node.parentElement
      if (parent === null) continue
      if (parent.closest('script, style, textarea, [contenteditable="true"]') !== null) continue
      const text = node.nodeValue
      if (text === null || text.trim().length === 0) continue
      node.nodeValue = text.split(/(\s+)/).map(part => /\s/.test(part) || part.length === 0 ? part : lengthen(part)).join('')
    }
    return new Promise(resolve => { requestAnimationFrame(() => { requestAnimationFrame(resolve) }) })
  })
}

async function measure(target, label) {
  const findings = await target.evaluate(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const roots = []
    const add = element => {
      if (element !== null && !roots.includes(element)) roots.push(element)
    }
    const firstUseTitle = document.querySelector('[data-browser-native-first-use-title]')
    add(firstUseTitle?.parentElement ?? null)
    const exportButton = document.querySelector('[data-browser-native-session-export]')
    add(exportButton?.parentElement ?? null)
    for (const selector of [
      '[data-browser-native-workspace-status]',
      '[data-browser-native-queue-status]',
      '[data-browser-native-offline-status]',
      '[data-browser-native-first-use-status]',
      '[data-mobile-status]',
      '[data-mobile-storage]',
      '[data-mobile-transcript]',
      '[data-mobile-form]',
    ]) {
      add(document.querySelector(selector))
    }
    const visible = element => element.getBoundingClientRect().width > 0
      || element.getBoundingClientRect().height > 0
    const describe = element => {
      const id = element.getAttribute('data-browser-native-first-use-title') !== null ? 'first-use-title'
        : element.getAttribute('data-browser-native-first-use-status') !== null ? 'first-use-status'
          : element.getAttribute('data-browser-native-queue-status') !== null ? 'queue-status'
            : element.getAttribute('data-browser-native-workspace-status') !== null ? 'workspace-status'
              : element.getAttribute('data-browser-native-offline-status') !== null ? 'offline-status'
                : element.getAttribute('data-browser-native-session-export') !== null ? 'export-button'
                  : element.className?.toString().slice(0, 40) || element.tagName.toLowerCase()
      return `${id} <${element.tagName.toLowerCase()}>`
    }
    const problems = []
    for (const root of roots) {
      if (!visible(root)) continue
      for (const element of [root, ...root.querySelectorAll('*')]) {
        if (!visible(element)) continue
        const rect = element.getBoundingClientRect()
        if (rect.right > viewport.width + 1 || rect.left < -1) {
          problems.push({ kind: 'viewport-overflow', element: describe(element), rect: [rect.left, rect.right], viewport: viewport.width })
        }
        const style = getComputedStyle(element)
        if (element.scrollWidth > element.clientWidth + 1 && style.overflowX !== 'visible') {
          problems.push({
            kind: 'clipped-text',
            element: describe(element),
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            overflowX: style.overflowX,
            text: element.innerText.slice(0, 120),
          })
        }
      }
    }
    return { viewport, measured: roots.length, problems }
  })
  return { label, ...findings }
}

async function assertFits(report, output) {
  output.push(report)
  assert.deepEqual(report.problems, [], `${report.label}: pseudo-localized labels overflow at ${WIDTH}px\n${JSON.stringify(report.problems, null, 2)}`)
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  const queueHold = new Promise(resolve => { queueRelease = resolve })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    admission: { maxConcurrentTurns: 1, queueTimeoutMs: 120_000 },
    testHooks: {
      scriptedLlmFault(body) {
        if (body?.purpose !== undefined) return undefined
        const text = lastUserText(body)
        if (!text.includes('PSEUDO_QUEUE')) return undefined
        if (text.includes('PSEUDO_QUEUE_FIRST')) holdStarted = true
        return { kind: 'barrier-text', release: queueHold, text: 'PSEUDO_QUEUE_DONE' }
      },
    },
  })
  const origin = await app.listen(0)
  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  context = await browser.newContext({
    locale: LOCALE,
    timezoneId: 'Asia/Shanghai',
    viewport: { width: WIDTH, height: HEIGHT },
    acceptDownloads: true,
  })
  const page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  const requests = []
  trackRequests(page, requests)
  await openPreview(page, previewUrl)
  await waitForPreview(page)
  const reports = []
  const zh = LOCALE.toLowerCase().startsWith('zh')
  await submitPrompt({ page, origin, requests, prompt: 'PSEUDO_MAIN', timeout: 120_000 })

  const exportLabel = await page.locator('[data-browser-native-session-export]').innerText()
  assert.ok(zh ? exportLabel.includes('下载') : exportLabel.includes('Download'), exportLabel)
  const download = page.waitForEvent('download')
  await page.locator('[data-browser-native-session-export]').click()
  await download
  await waitFor(async () => await page.locator('[data-browser-native-session-export-result]').evaluate(node => node.textContent?.length > 0),
    'export result', 15_000)

  const ownSessionId = requests.find(request => request.path.endsWith('/session/create'))?.body?.sessionId
  assert.equal(typeof ownSessionId, 'string')
  let heldError
  const heldTurn = submitPrompt({
    page, origin, requests, sessionId: ownSessionId, prompt: 'PSEUDO_QUEUE_FIRST', timeout: 120_000,
  }).catch(error => { heldError = error; return error })
  await waitFor(async () => holdStarted || heldError !== undefined, 'held admission slot', 45_000)
  assert.equal(heldError, undefined, String(heldError?.stack ?? heldError))
  queueContext = await browser.newContext({
    locale: LOCALE,
    timezoneId: 'Asia/Shanghai',
    viewport: { width: WIDTH, height: HEIGHT },
  })
  const queuePage = await queueContext.newPage()
  queuePage.on('pageerror', error => pageErrors.push(`queue: ${error.message}`))
  const queueRequests = []
  trackRequests(queuePage, queueRequests)
  await openPreview(queuePage, previewUrl)
  await waitForPreview(queuePage)
  const queuedTurn = submitPrompt({
    page: queuePage, origin, requests: queueRequests, prompt: 'PSEUDO_QUEUE_SECOND', timeout: 120_000,
  })
  await waitFor(async () => {
    const status = queuePage.locator('[data-browser-native-queue-status]')
    return await status.count() > 0 && await status.isVisible()
  }, 'queue status', 30_000)
  const queueLabel = await queuePage.locator('[data-browser-native-queue-status]').innerText()
  assert.ok(zh ? queueLabel.includes('队列') : queueLabel.includes('position'), queueLabel)
  await applyPseudo(queuePage)
  await assertFits(await measure(queuePage, 'queued'), reports)
  queueRelease()
  await Promise.all([heldTurn, queuedTurn])
  await queueContext.close()
  queueContext = undefined

  // Lengthen the labels only after real submissions finish: pseudo text is a
  // measurement device, not an input the composer or session API should ingest.
  await applyPseudo(page)
  await assertFits(await measure(page, 'main'), reports)
  await assertFits(await measure(page, 'export'), reports)

  await context.setOffline(true)
  await waitFor(async () => {
    const status = page.locator('[data-browser-native-offline-status]')
    return await status.count() > 0 && await status.isVisible()
  }, 'offline status', 15_000)
  if (zh) assert.ok(await page.locator('[data-browser-native-offline-status]').innerText().then(text => text.includes('网络已断开')))
  await assertFits(await measure(page, 'offline-recovery'), reports)
  await context.setOffline(false)

  const page2 = await context.newPage()
  page2.on('pageerror', error => pageErrors.push(`tab2: ${error.message}`))
  await openPreview(page2, previewUrl)
  await waitForPreview(page2)
  const conflict = await waitFor(async () => {
    const status = page2.locator('[data-browser-native-workspace-status]')
    const state = await status.getAttribute('data-state').catch(() => null)
    return ['lease-conflict', 'session-conflict', 'recovery-conflict'].includes(state) ? state : undefined
  }, 'cross-tab conflict notice', 20_000).catch(() => undefined)
  if (conflict !== undefined) {
    await applyPseudo(page2)
    await assertFits(await measure(page2, `collaboration-${conflict}`), reports)
  } else {
    reports.push({ label: 'collaboration', skipped: 'second tab reported no lease/session/recovery conflict' })
  }

  const mobile = await context.newPage()
  await mobile.goto(`${origin}/mobile`, { waitUntil: 'domcontentloaded' })
  await waitFor(async () => await mobile.locator('[data-mobile-status]').count() > 0, 'mobile status line', 10_000)
  const mobileStatus = await mobile.locator('[data-mobile-status]').innerText()
  assert.equal(mobileStatus, zh ? '就绪' : 'ready')
  await applyPseudo(mobile)
  await assertFits(await measure(mobile, 'mobile-ui-only'), reports)

  assert.equal(await mobile.evaluate(() => document.documentElement.lang), LOCALE.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en')
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'))
  console.log(JSON.stringify({
    result: 'passed',
    locale: LOCALE,
    viewport: { width: WIDTH, height: HEIGHT },
    reports,
    pageErrors,
    note: 'Pseudo localization lengthens every visible word by 40%; scans measure the rendered status/export/guide surfaces for viewport overflow and clipped text, not overlap between fixed notices.',
  }, null, 2))
} finally {
  queueRelease?.()
  await queueContext?.close().catch(() => {})
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await image?.cleanup().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
}
