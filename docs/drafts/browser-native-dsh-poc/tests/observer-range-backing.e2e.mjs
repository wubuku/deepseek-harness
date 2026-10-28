/** Complete Chrome Hosts and direct Workers verify private read caches without touching writer state. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { sendTurn, waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
assert.equal(process.env.DSH_POC_BROWSER ?? 'chrome', 'chrome')
const artifactParent = resolve(process.env.DSH_POC_OBSERVER_ARTIFACT_DIR ?? tmpdir())
await mkdir(artifactParent, { recursive: true })
const artifactDir = await mkdtemp(join(artifactParent, 'dsh-observer-range-'))
const dataDir = join(artifactDir, 'backend')
const resultFile = join(artifactDir, 'results.json')
const chunkBytes = 1024 * 1024
const fileBytes = 16 * chunkBytes
const content = Buffer.alloc(fileBytes)
content.fill(`owner-committed-value stable record ${'.'.repeat(96)}\n`)
content.write('OBSERVER_RANGE_TARGET\n', fileBytes - 100)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = hash(content)
const control = process.env.DSH_POC_OBSERVER_VOLATILE_CONTROL === '1'
const startedAt = performance.now()
const evidence = { result: 'running', artifactDir, dataDir, control, steps: [], pageErrors: [], externalRequests: [], requests: [], cleanupErrors: [] }
const requestsByPage = new Map()
let image
let app
let browser
let context
let origin
let owner
let observer

async function step(name, details = {}) {
  evidence.steps.push({ name, elapsedMs: Math.round(performance.now() - startedAt), ...details })
  process.stderr.write(`${JSON.stringify({ name, ...details })}\n`)
  await writeFile(resultFile, `${JSON.stringify(evidence, null, 2)}\n`)
}

async function hostReady(page) {
  const notice = page.getByRole('button', { name: /^(Continue|继续)$/ }).first()
  await notice.waitFor({ timeout: 45_000 })
  await notice.click()
  await notice.waitFor({ state: 'hidden' })
  let opening = false
  await waitFor(async () => {
    if (await page.locator('[data-composer-input][contenteditable="true"]').last().isVisible()) return true
    if (opening) return false
    const dialog = page.getByRole('dialog', { name: /^(Select Workspace Directory|选择工作区目录)$/ })
    if (await dialog.isVisible()) {
      const path = dialog.getByRole('textbox', { name: /^(Edit path|编辑路径)$/ })
      const edit = dialog.getByRole('button', { name: /^(Edit path|编辑路径)$/ })
      if (await edit.isVisible()) await edit.click()
      else if (await path.isVisible()) {
        await path.fill('/dsh/home/')
        await path.press('Enter')
        await dialog.getByRole('button', { name: /^(Open|打开)$/ }).click()
        opening = true
      }
    } else {
      const chooser = page.getByRole('textbox', { name: /^(Choose workspace|选择工作区)$/ }).first()
      if (await chooser.isVisible()) await chooser.click()
    }
    return false
  }, 'complete DSH Host composer', 60_000)
}

async function action(page, body) {
  const result = await page.evaluate(async input => await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__(input), body)
  assert.equal(result.ok, true, JSON.stringify(result))
  return result
}

async function newPage(role) {
  const page = await context.newPage()
  const requests = []
  requestsByPage.set(page, requests)
  page.on('pageerror', error => evidence.pageErrors.push({ role, message: error.message }))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.protocol.startsWith('http') && url.origin !== origin) evidence.externalRequests.push(url.origin + url.pathname)
    if (!url.pathname.startsWith('/api/browser-native/')) return
    let body
    try { body = request.postDataJSON() } catch {}
    requests.push({ path: url.pathname, body })
    evidence.requests.push({ role, path: url.pathname, method: request.method() })
  })
  return page
}

async function api(path, body) {
  const response = await context.request.fetch(`${origin}/api/browser-native/workspace/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { data: { protocolVersion: 1, requestId: randomUUID(), ...body } }),
  })
  const value = await response.json()
  assert.equal(response.status(), 200, JSON.stringify(value))
  return value
}

async function sharedState(page, workspaceId) {
  return await page.evaluate(async id => {
    const records = await new Promise((resolveRecords, reject) => {
      const request = indexedDB.open('dsh-browser-native-workspace-v1')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction(['workspace', 'control'], 'readonly')
        const snapshot = transaction.objectStore('workspace').get(id)
        const control = transaction.objectStore('control').get(id)
        transaction.oncomplete = () => { database.close(); resolveRecords({ snapshot: snapshot.result, control: control.result }) }
        transaction.onabort = () => { database.close(); reject(transaction.error) }
      }
    })
    const root = await navigator.storage.getDirectory()
    const directories = []
    for await (const name of root.keys()) if (name.startsWith(`dsh-workspace-blobs-${id}`)) directories.push(name)
    return { records, directories: directories.sort() }
  }, workspaceId)
}

async function probeMain(origin) {
  const { BrowserObserverCache, MemoryVfs } = await import(`${origin}/observer-cache-probe-module.js`)
  let cache
  let vfs
  self.onmessage = async ({ data }) => {
    try {
      let value
      if (data.action === 'create') {
        cache = await BrowserObserverCache.create(data.workspaceId, [{ hash: data.hash, bytes: data.bytes }],
          { maxFiles: 2, maxBytes: 32 * 1024 * 1024 })
        vfs = new MemoryVfs()
        value = true
      } else if (data.action === 'open') {
        let rejectRead
        let maxRead = 0
        let reads = 0
        const backing = await cache.open(data.hash, {
          read: async (offset, length) => {
            reads += 1
            maxRead = Math.max(maxRead, length)
            if (data.hold && offset >= 1024 * 1024) {
              self.postMessage({ event: 'download-held' })
              return await new Promise((resolveUnused, reject) => { rejectRead = reject })
            }
            return new Uint8Array(length).fill(data.corrupt ? 5 : 7)
          },
          close: async () => { rejectRead?.(new Error('closed')) },
        })
        vfs.seedExternal('/probe.bin', backing)
        value = { usage: vfs.usage(), reads, maxRead }
      } else if (data.action === 'read') value = Array.from(vfs.readFileRangeSync('/probe.bin', 1024 * 1024, 8))
      else if (data.action === 'dispose') { vfs.close(); await cache.dispose(); value = true }
      self.postMessage({ id: data.id, value })
    } catch (error) { self.postMessage({ id: data.id, error: error.message }) }
  }
  self.postMessage({ event: 'ready' })
}

async function directWorkers(page) {
  const directId = randomUUID()
  const directHash = hash(Buffer.alloc(4 * chunkBytes, 7))
  await page.evaluate(source => {
    const state = { workers: [], requests: new Map(), events: [], next: 0 }
    window.__observerProbe = state
    state.create = async () => {
      const worker = new Worker(URL.createObjectURL(new Blob([`(${source})(${JSON.stringify(location.origin)})`], { type: 'text/javascript' })), { type: 'module' })
      let ready = () => {}
      let failed = () => {}
      const initialized = new Promise((resolveReady, rejectReady) => { ready = resolveReady; failed = rejectReady })
      const timer = setTimeout(() => failed(new Error('Worker initialization timed out')), 30_000)
      worker.onerror = event => {
        failed(new Error(event.message))
        for (const [id, pending] of state.requests) if (pending.worker === state.workers.indexOf(worker)) {
          state.requests.delete(id); pending.reject(new Error(event.message))
        }
      }
      worker.onmessage = ({ data }) => {
        if (data.event === 'ready') { ready(); return }
        if (data.event) state.events.push({ worker: state.workers.indexOf(worker), event: data.event })
        else {
          const pending = state.requests.get(data.id)
          state.requests.delete(data.id)
          if (data.error) pending.reject(new Error(data.error))
          else pending.resolve(data.value)
        }
      }
      state.workers.push(worker)
      const index = state.workers.length - 1
      try { await initialized; return index } finally { clearTimeout(timer) }
    }
    state.send = (index, action, body) => new Promise((resolveReply, rejectReply) => {
      const id = state.next++
      const timer = setTimeout(() => { state.requests.delete(id); rejectReply(new Error(`Worker ${action} timed out`)) }, 30_000)
      state.requests.set(id, { resolve: value => { clearTimeout(timer); resolveReply(value) },
        reject: error => { clearTimeout(timer); rejectReply(error) }, worker: index })
      state.workers[index].postMessage({ id, action, ...body })
    })
    state.kill = index => {
      state.workers[index].terminate()
      for (const [id, request] of state.requests) if (request.worker === index) {
        state.requests.delete(id); request.reject(new Error('worker terminated'))
      }
    }
  }, probeMain.toString())
  const send = async (index, action, extra = {}) => await page.evaluate(async input =>
    await window.__observerProbe.send(input.index, input.action, input.body), {
    index, action, body: { workspaceId: directId, hash: directHash, bytes: 4 * chunkBytes, ...extra },
  })
  const create = async () => await page.evaluate(() => window.__observerProbe.create())
  const names = async () => await page.evaluate(async id => {
    const root = await navigator.storage.getDirectory()
    const result = []
    for await (const name of root.keys()) if (name.startsWith(`dsh-observer-cache-v1-${id}-`)) result.push(name)
    return result.sort()
  }, directId)
  const first = await create()
  await send(first, 'create')
  const metrics = await send(first, 'open')
  assert.equal(metrics.usage.residentBytes, 0)
  assert.equal(metrics.maxRead, chunkBytes)
  const firstNames = await names()
  const doomed = await create()
  await send(doomed, 'create')
  const pending = send(doomed, 'open', { hold: true }).then(() => 'unexpected success', error => error.message)
  await waitFor(async () => await page.evaluate(index => window.__observerProbe.events.some(event => event.worker === index
    && event.event === 'download-held'), doomed), 'actual partial OPFS download')
  await page.evaluate(index => window.__observerProbe.kill(index), doomed)
  assert.match(await pending, /terminated/)
  assert.equal((await names()).length, 2)
  const successor = await create()
  await send(successor, 'create')
  const recoveredNames = await names()
  assert.equal(recoveredNames.length, 2)
  assert.ok(recoveredNames.includes(firstNames[0]), 'live reader directory must survive orphan cleanup')
  assert.deepEqual(await send(first, 'read'), Array(8).fill(7))
  await assert.rejects(send(successor, 'open', { corrupt: true }), /SHA-256/)
  await send(successor, 'open')
  await send(first, 'dispose')
  await send(successor, 'dispose')
  assert.deepEqual(await names(), [])
  await page.evaluate(() => { for (let index = 0; index < window.__observerProbe.workers.length; index += 1) window.__observerProbe.kill(index) })
  return { metrics, killedPartial: true, livePreserved: true, orphanReaped: true, corruptRejected: true, directoriesAfterDispose: [] }
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  const esbuild = createRequire(require.resolve('tsx'))('esbuild')
  const built = await esbuild.build({ stdin: {
    contents: 'export { BrowserObserverCache } from "./browser-native-observer-cache.ts"; export { MemoryVfs } from "../../../packages/experimental/webworker-runtime/src/storage/memory.ts";',
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false })
  await writeFile(join(image.distRoot, 'observer-cache-probe-module.js'), built.outputFiles[0].contents)
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted',
    workspaceChunkObjects: true, workspaceVerifiedDownloads: true })
  origin = await app.listen(0)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  evidence.browserVersion = browser.version()
  context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(30_000)
  await context.addInitScript(() => {
    window.Worker = new Proxy(window.Worker, { construct(target, args) {
      const worker = Reflect.construct(target, args, target)
      const post = worker.postMessage
      worker.postMessage = (message, ...transfer) => Reflect.apply(post, worker, [
        message?.type === 'browser-native-durable-workspace-init' ? { ...message, contentDefinedUpload: true } : message, ...transfer,
      ])
      return worker
    } })
  })
  owner = await newPage('owner')
  const url = `${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`
  await owner.goto(url)
  await hostReady(owner)
  const baseline = await action(owner, { action: 'usage' })
  const identity = await api('identity')
  const workspaceId = identity.workspaceId
  const lease = await action(owner, { action: 'lease-info' })
  const operationId = randomUUID()
  const chunks = Array.from({ length: fileBytes / chunkBytes }, (_, index) => ({ offset: index * chunkBytes,
    length: chunkBytes, hash: hash(content.subarray(index * chunkBytes, (index + 1) * chunkBytes)) }))
  const upload = `blob-upload/${operationId}-${fileHash}`
  const started = await api('blob-upload/start', { workspaceId, operationId, hash: fileHash, totalBytes: fileBytes,
    chunkBytes, layout: { version: 1, algorithm: 'dsh-gear-v1', minimumBytes: 32 * 1024,
      averageBytes: 128 * 1024, maximumBytes: chunkBytes, chunks } })
  for (const index of started.missing) {
    const response = await context.request.put(`${origin}/api/browser-native/workspace/${upload}/${index}`, {
      headers: { 'content-type': 'application/octet-stream', 'x-browser-native-protocol': '1', 'x-workspace-id': workspaceId,
        'x-request-id': randomUUID(), 'x-chunk-sha256': chunks[index].hash },
      data: content.subarray(index * chunkBytes, (index + 1) * chunkBytes),
    })
    assert.equal(response.status(), 200)
  }
  await api(`${upload}/complete`, { workspaceId })
  const writer = { writerToken: lease.writerToken, fencingToken: lease.fencingToken }
  await api('commit', { workspaceId, ...writer, operationId: randomUUID(), baseRevision: 0,
    changes: ['owner-committed.txt', 'alias-a.txt', 'alias-b.txt'].map(path => ({ path,
      kind: 'file', mode: 0o644, hash: fileHash, bytes: fileBytes })) })
  const before = await sharedState(owner, workspaceId)
  await step('seeded', { fileBytes, aliases: 3, revision: 1, baselineResidentBytes: baseline.residentBytes })
  const probe = await newPage('direct-workers')
  await probe.goto(`${origin}/api/browser-native/health`)
  evidence.direct = await directWorkers(probe)
  await step('direct-workers-passed', evidence.direct)
  observer = await newPage('observer')
  await observer.goto(`${origin}/api/browser-native/health`)
  await observer.evaluate(() => localStorage.removeItem('dsh.sessions.current'))
  await observer.goto(control ? url.replace('&browser-native-durable=1', '') : url)
  await hostReady(observer)
  assert.equal(await observer.evaluate(async () => (await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__({ action: 'lease-info' })).accessMode), 'observer')
  const usage = await action(observer, { action: 'usage' })
  evidence.hostUsage = { baseline, usage, logicalFileBytes: fileBytes * 3 }
  await step('observer-ready', evidence.hostUsage)
  assert.ok(usage.residentBytes <= baseline.residentBytes + chunkBytes,
    `observer must not retain whole files: baseline=${baseline.residentBytes}, current=${usage.residentBytes}`)
  const range = await action(observer, { action: 'read-range', path: '/dsh/home/workspace/alias-a.txt', offset: fileBytes - 100, length: 22 })
  assert.equal(Buffer.from(range.base64, 'base64').toString(), 'OBSERVER_RANGE_TARGET\n')
  const read = await sendTurn({ page: observer, origin, requests: requestsByPage.get(observer),
    prompt: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_READ_E2E read the committed file.', marker: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_READ_DONE' })
  const readResult = read.session.events.find(event => event.type === 'tool/result')
  assert.equal(readResult.data.message.isError, false)
  const names = await observer.evaluate(async id => {
    const root = await navigator.storage.getDirectory()
    const names = []
    for await (const name of root.keys()) if (name.startsWith(`dsh-observer-cache-v1-${id}-`)) {
      const directory = await root.getDirectoryHandle(name)
      const files = []
      for await (const file of directory.keys()) files.push(file)
      names.push({ name, files })
    }
    return names
  }, workspaceId)
  assert.equal(names.length, 1)
  assert.deepEqual(names[0].files, [fileHash])
  assert.deepEqual(await sharedState(owner, workspaceId), before, 'observer must not mutate shared writer state')
  assert.ok((await action(observer, { action: 'usage' })).residentBytes <= baseline.residentBytes + chunkBytes,
    'normal Session/config VFS changes may grow; Workspace bytes must remain externally backed')
  let grepRequests = 0
  await observer.route(`${origin}/api/browser-native/llm`, async route => {
    const body = route.request().postDataJSON()
    if (!JSON.stringify(body.messages).includes('BROWSER_NATIVE_OBSERVER_RANGE_GREP_E2E')) { await route.continue(); return }
    grepRequests += 1
    let chunks
    if (grepRequests === 1) {
      const argumentsText = JSON.stringify({ pattern: 'OBSERVER_RANGE_TARGET', path: '/dsh/home/workspace/alias-a.txt' })
      chunks = [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: 'observer-range-grep', name: 'grep', argumentsDelta: argumentsText },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'observer-range-grep', name: 'grep', arguments: argumentsText } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]
    } else {
      evidence.grepMatched = body.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('OBSERVER_RANGE_TARGET'))
      evidence.grepLastResult = body.messages.filter(message => message.role === 'tool').at(-1)
      const text = 'BROWSER_NATIVE_OBSERVER_RANGE_GREP_DONE'
      chunks = [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
        { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
    }
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson',
      body: `${chunks.map(chunk => JSON.stringify({ kind: 'chunk', chunk })).join('\n')}\n` })
  })
  const grep = await sendTurn({ page: observer, origin, requests: requestsByPage.get(observer), sessionId: read.sessionId,
    prompt: 'BROWSER_NATIVE_OBSERVER_RANGE_GREP_E2E find the committed marker.', marker: 'BROWSER_NATIVE_OBSERVER_RANGE_GREP_DONE' })
  assert.equal(grep.session.events.filter(event => event.type === 'tool/call' && event.data.name === 'grep').length, 1)
  assert.equal(grepRequests, 2)
  assert.equal(evidence.grepMatched, true, JSON.stringify(evidence.grepLastResult))
  delete evidence.grepLastResult
  await observer.unroute(`${origin}/api/browser-native/llm`)
  assert.ok((await action(observer, { action: 'usage' })).residentBytes <= baseline.residentBytes + chunkBytes)
  evidence.grepRequests = grepRequests
  await api('commit', { workspaceId, ...writer, operationId: randomUUID(), baseRevision: 1,
    changes: [{ path: 'next-revision', kind: 'directory', mode: 0o755 }] })
  const stale = await sendTurn({ page: observer, origin, requests: requestsByPage.get(observer), sessionId: read.sessionId,
    prompt: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_STALE_E2E reject the obsolete cached file.', marker: 'BROWSER_NATIVE_WORKSPACE_OBSERVER_STALE_BLOCKED' })
  assert.equal(stale.session.events.filter(event => event.type === 'browser-native/workspace-receipt').length, 0)
  assert.equal(await observer.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.state), 'stale')
  await observer.screenshot({ path: join(artifactDir, 'observer-stale.png') })
  await action(observer, { action: 'release-lease' })
  const remaining = await observer.evaluate(async id => {
    const root = await navigator.storage.getDirectory()
    const result = []
    for await (const name of root.keys()) if (name.startsWith(`dsh-observer-cache-v1-${id}-`)) result.push(name)
    return result
  }, workspaceId)
  assert.deepEqual(remaining, [])
  assert.deepEqual(await sharedState(owner, workspaceId), before)
  assert.deepEqual(evidence.pageErrors, [])
  assert.deepEqual(evidence.externalRequests, [])
  evidence.sessionId = read.sessionId
  evidence.observerRequests = requestsByPage.get(observer).map(request => request.path)
  evidence.result = 'passed'
  await step('complete-host-passed', { residentBytes: usage.residentBytes, logicalFileBytes: fileBytes * 3,
    sharedWriterStateUnchanged: true, staleRejected: true, cleanRelease: true })
} catch (error) {
  evidence.result = 'failed'
  evidence.error = { message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  for (const [label, cleanup] of [
    ['context', async () => await context?.close()], ['browser', async () => await browser?.close()],
    ['backend', async () => await app?.close()], ['image', async () => await image?.cleanup()],
  ]) {
    try { await cleanup() } catch (error) { evidence.cleanupErrors.push({ label, message: error.message }); process.exitCode = 1 }
  }
  if (evidence.cleanupErrors.length > 0) evidence.result = 'failed'
  await writeFile(resultFile, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ result: evidence.result, artifactDir, error: evidence.error?.message, cleanupErrors: evidence.cleanupErrors })}\n`)
}
