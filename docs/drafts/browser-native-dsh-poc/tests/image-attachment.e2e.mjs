import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { assistantText, openPreview, sendTurn, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const mode = process.env.DSH_POC_LLM ?? 'scripted'
const envFile = process.env.DSH_POC_ENV_FILE
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-image-attachment-')))
const marker = 'BROWSER_NATIVE_IMAGE_APPLICATION_E2E'
const imageMarker = 'BROWSER_NATIVE_IMAGE_APPLICATION_APPLIED'
const pageErrors = []
const backendRequests = []
const browserRequests = []
const browserResponses = []
let image
let png
let app
let browser
let page

/** Read one value from the credential file without exporting or printing secrets. */
async function envValue(name) {
  if (envFile === undefined) return undefined
  const line = (await readFile(envFile, 'utf8')).split('\n').find(item => item.startsWith(`${name}=`))
  return line === undefined ? undefined : line.slice(name.length + 1).trim()
}

if (!['scripted', 'real'].includes(mode)) throw new Error('DSH_POC_LLM must be scripted or real')
if (mode === 'real' && envFile === undefined) throw new Error('DSH_POC_ENV_FILE is required for real mode')
const noProxy = new Set((process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').filter(Boolean))
noProxy.add('127.0.0.1')
noProxy.add('localhost')
process.env.NO_PROXY = [...noProxy].join(',')
process.env.no_proxy = process.env.NO_PROXY

/** Read one rendered transcript image back out of the page as verified bytes. */
async function renderedImage() {
  return await page.evaluate(async () => {
    const node = [...document.images].find(item => item.naturalWidth === 64 && item.naturalHeight === 64)
    if (node === undefined) return undefined
    const bytes = new Uint8Array(await (await fetch(node.src)).arrayBuffer())
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return {
      alt: node.alt,
      srcScheme: node.src.startsWith('blob:') ? 'blob' : node.src.slice(0, 5),
      width: node.naturalWidth,
      height: node.naturalHeight,
      bytes: bytes.byteLength,
      sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''),
    }
  })
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: mode,
    envFile,
    ...(mode === 'real' ? {
      llmProviderKind: 'openai',
      model: await envValue('OPENAI_MODEL'),
      llmBaseUrl: await envValue('OPENAI_BASE_URL'),
      llmCompletionsPath: 'v1/chat/completions',
      llmApiKey: await envValue('OPENAI_API_KEY'),
    } : {}),
  })
  const origin = await app.listen(0)
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  page = await browser.newPage({ locale: 'en-US', timezoneId: 'Asia/Singapore', viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    browserRequests.push({ url: request.url(), method: request.method() })
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch {}
    backendRequests.push({ path: url.pathname, url: request.url(), method: request.method(), body, bodyBytes: request.postDataBuffer()?.byteLength ?? 0 })
  })
  page.on('response', response => browserResponses.push({
    url: response.url(), status: response.status(), method: response.request().method(),
  }))

  const previewUrl = `${origin}/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`
  await openPreview(page, previewUrl)
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 60_000 })

  png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext('2d')
    context.fillStyle = '#ff0000'
    context.fillRect(0, 0, 64, 64)
    context.fillStyle = '#ffffff'
    context.font = 'bold 28px sans-serif'
    context.fillText('42', 16, 46)
    return canvas.toDataURL('image/png').split(',')[1]
  }), 'base64')
  const hash = createHash('sha256').update(png).digest('hex')
  const attachmentPath = `/dsh/home/attachments/v1/files/${hash.slice(0, 2)}/${hash}/${hash.slice(0, 16)}.png`

  const prompt = mode === 'scripted'
    ? `${marker}: describe the attached image.`
    : `${marker}: look at the attached image and answer with one word naming its dominant background color.`
  await page.locator('input[type="file"]').last().setInputFiles({
    name: 'image-fixture.png',
    mimeType: 'image/png',
    buffer: png,
  })
  const uploadReceipt = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname.endsWith(`/workspace/attachments/${hash}`) && response.request().method() === 'PUT'
  }, { timeout: 90_000 })
  const first = await sendTurn({
    page,
    origin,
    requests: backendRequests,
    prompt,
    ...(mode === 'scripted' ? { marker: imageMarker } : {}),
    timeout: mode === 'real' ? 600_000 : 90_000,
  })
  const upload = backendRequests.find(request => request.method === 'PUT'
    && request.path.endsWith(`/workspace/attachments/${hash}`))
  assert.ok(upload, 'admission must upload the image object')
  assert.equal(new URL(upload.url).searchParams.get('name'), `${hash.slice(0, 16)}.png`)
  const receipt = await (await uploadReceipt).json()
  assert.deepEqual({
    attachmentId: receipt.attachmentId, name: receipt.name, bytes: receipt.bytes,
  }, { attachmentId: `sha256:${hash}`, name: `${hash.slice(0, 16)}.png`, bytes: png.byteLength })
  assert.equal(browserResponses.find(response => response.method === 'PUT'
    && new URL(response.url).pathname.endsWith(`/workspace/attachments/${hash}`))?.status, 200)
  const imageBlock = first.session.events.find(event => event.type === 'user/message'
    && event.data.content?.some(block => block.type === 'image'))?.data.content
    ?.find(block => block.type === 'image')
  assert.ok(imageBlock, 'the Session must persist the authoritative ImageBlock')
  assert.equal(imageBlock.attachment.attachmentId, `sha256:${hash}`)
  assert.equal(imageBlock.attachment.mediaType, 'image/png')
  assert.equal(imageBlock.attachment.bytes, png.byteLength)
  assert.equal(imageBlock.attachment.width, 64)
  assert.equal(imageBlock.attachment.height, 64)

  const wireImage = backendRequests.filter(request => request.path.endsWith('/llm'))
    .flatMap(request => request.body?.messages ?? [])
    .filter(message => Array.isArray(message.content))
    .flatMap(message => message.content)
    .find(part => part.type === 'image_url')
  assert.ok(wireImage, `the LLM wire request must carry the image; ${JSON.stringify(
    backendRequests.filter(request => request.path.endsWith('/llm')).map(request => request.body?.messages?.map(message => (
      { role: message.role, content: typeof message.content === 'string' ? 'string' : message.content.map(part => part.type) }
    ))),
  )}`)
  const wireBytes = Buffer.from(wireImage.image_url.url.split(',')[1], 'base64')
  assert.equal(createHash('sha256').update(wireBytes).digest('hex'), hash, 'the model request must carry the uploaded bytes')
  if (mode === 'scripted') {
    assert.equal(assistantText(first.session, first.turn),
      `${imageMarker}:image/png:${String(png.byteLength)}:${hash.slice(0, 16)}`)
  } else {
    assert.match(assistantText(first.session, first.turn), /red/i)
  }

  const rendered = await waitFor(renderedImage, 'the transcript to render the admitted image', 30_000)
  assert.equal(rendered.width, 64)
  assert.equal(rendered.height, 64)
  assert.equal(rendered.sha256, hash, 'the rendered image must decode to the uploaded bytes')

  await page.goto(`${origin}/api/browser-native/health`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    for await (const [name] of root.entries()) {
      if (name === 'dsh-browser-native-attachments-v1') await root.removeEntry(name, { recursive: true })
    }
  })
  const downloadsBefore = backendRequests.filter(request => request.method === 'GET'
    && request.path.endsWith(`/workspace/attachments/${hash}`)).length
  await openPreview(page, previewUrl)
  const followup = await sendTurn({
    page,
    origin,
    requests: backendRequests,
    sessionId: first.sessionId,
    prompt: 'Continue after the refresh.',
    ...(mode === 'scripted' ? { marker: imageMarker } : {}),
    timeout: mode === 'real' ? 600_000 : 90_000,
  })
  assert.equal(followup.sessionId, first.sessionId, 'refresh must resume the same DSH Session')
  const downloadsAfter = backendRequests.filter(request => request.method === 'GET'
    && request.path.endsWith(`/workspace/attachments/${hash}`)).length
  assert.ok(downloadsAfter > downloadsBefore, 'the evicted image must be re-read from the backend')
  const restored = await waitFor(renderedImage, 'the resumed transcript to render the historical image', 60_000)
  assert.equal(restored.sha256, hash, 'the historical image must render from the durable Session reference')
  assert.equal(followup.session.events.filter(event => event.type === 'user/message'
    && event.data.content?.some(block => block.type === 'image')).length, 1,
  'the image must be persisted exactly once')

  assert.deepEqual(pageErrors, [])
  const crossOriginRequests = browserRequests.filter(request => new URL(request.url).origin !== origin)
  assert.deepEqual(crossOriginRequests, [], 'the page and Worker must not call external services')
  assert.equal(await readFile(join(dataDir, 'sessions', `${first.sessionId}.json`), 'utf8')
    .then(text => text.includes(`sha256:${hash}`)), true, 'the durable Session must retain the image reference')

  process.stdout.write(`${JSON.stringify({
    mode,
    browser: process.env.DSH_POC_BROWSER ?? 'chrome',
    browserVersion: browser.version(),
    sessionId: first.sessionId,
    imageBytes: png.byteLength,
    imageSha256: hash,
    attachmentPath,
    rendered: { srcScheme: rendered.srcScheme, width: rendered.width, height: rendered.height },
    backendImageDownloads: downloadsAfter - downloadsBefore,
    assistant: assistantText(first.session, first.turn),
    llmRequests: backendRequests.filter(request => request.path.endsWith('/llm')).length,
    pageErrors,
  })}\n`)
} finally {
  await browser?.close()
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
}
