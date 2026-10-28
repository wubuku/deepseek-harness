/** Real Chrome Host boot, interrupted OPFS publication, journal recovery and Workspace Web Locks; no model calls. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { openPreview, waitFor, waitForPreview } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const timeout = Number(process.env.DSH_POC_CACHE_RECOVERY_TIMEOUT_MS ?? 120_000)
assert.ok(Number.isSafeInteger(timeout) && timeout > 0, 'DSH_POC_CACHE_RECOVERY_TIMEOUT_MS must be a positive integer')
const publicationStages = ['intent-durable', 'entry-created', 'first-chunk-written', 'published']
const cases = [...publicationStages, 'missing-intent']
const selection = process.env.DSH_POC_CACHE_RECOVERY_SCENARIO ?? 'all'
const selected = cases.filter(name => selection === 'all' || selection === 'stages' && publicationStages.includes(name) || selection === name)
assert.ok(selected.length > 0, `Unknown scenario ${selection}; choose all, stages, or ${cases.join(', ')}`)
const artifactDir = await mkdtemp(join(resolve(process.env.DSH_POC_CACHE_RECOVERY_ARTIFACT_DIR ?? tmpdir()), 'dsh-cache-recovery-'))
const resultFile = resolve(process.env.DSH_POC_RESULT_FILE ?? join(artifactDir, 'results.json'))
const dataDir = await mkdtemp(join(resolve(process.env.DSH_POC_DATA_DIR ?? artifactDir), 'backend-'))
const api = '/api/browser-native/workspace'
const previewQuery = 'browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none'
const workspacePath = '/dsh/home/workspace/cache-recovery.bin'
const fixture = Buffer.alloc(3 * 1024 * 1024 + 173)
for (let index = 0; index < fixture.length; index += 1) fixture[index] = (index * 31 + (index >>> 9) + 17) & 255
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex')
const expected = { hash: hashBytes(fixture), bytes: fixture.byteLength }
const startedAt = performance.now()
const evidence = {
  result: 'running', selection, artifactDir, dataDir, expected, timeout,
  browser: process.env.DSH_POC_BROWSER ?? 'chrome',
  backend: { chunkObjects: true, verifiedDownloads: true, llmMode: 'scripted' },
  modelRequests: 0, scenarios: [], cleanupErrors: [],
  scope: 'Dedicated Worker.terminate only; no claim about OS crashes, eviction or power loss',
}
let browser
let image
let app
let origin
let active

async function bounded(promise, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((resolveUnused, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout)
    })])
  } finally {
    clearTimeout(timer)
  }
}

async function action(page, request) {
  const value = await bounded(page.evaluate(async payload => {
    if (typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ !== 'function') throw new Error('Workspace test API unavailable')
    return await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__(payload)
  }, request), `Worker ${request.action}`)
  assert.equal(value?.ok, true, JSON.stringify(value))
  return value
}

async function ready(page, workspaceId, revision) {
  await page.waitForFunction(({ id, expectedRevision }) => {
    const status = window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__
    return typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function' && status?.state === 'synced'
      && (id === undefined || status.workspaceId === id) && status.revision === expectedRevision
  }, { id: workspaceId, expectedRevision: revision }, { timeout })
  return await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
}

async function screenshot(page, name) {
  const path = join(artifactDir, `${name}.png`)
  await page.screenshot({ path, timeout })
  return path
}

async function installWorkerObserver(context) {
  await context.addInitScript(() => {
    const state = { workers: [], pauses: [], initializations: [] }
    Object.defineProperty(window, '__dshCacheRecovery', { value: state })
    window.Worker = new Proxy(window.Worker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args, target)
        const record = { worker, id: state.workers.length, name: args[1]?.name, source: String(args[0]), terminated: false }
        state.workers.push(record)
        worker.addEventListener('message', event => {
          if (event.data?.type !== 'browser-native-workspace-test-download-paused') return
          event.stopImmediatePropagation()
          const pause = { stage: event.data.stage, workerId: record.id, terminated: false }
          state.pauses.push(pause)
          worker.terminate()
          record.terminated = true
          pause.terminated = true
        })
        worker.postMessage = new Proxy(worker.postMessage, {
          apply(method, receiver, values) {
            if (values[0]?.type === 'browser-native-durable-workspace-init') {
              return Reflect.apply(method, receiver, [{ ...values[0], contentDefinedUpload: true }, ...values.slice(1)])
            }
            if (values[0]?.type === 'browser-native-workspace-test-init') {
              const armed = sessionStorage.getItem('dsh-cache-recovery-pause')
              sessionStorage.removeItem('dsh-cache-recovery-pause')
              const options = armed === null ? {} : JSON.parse(armed)
              state.initializations.push({ workerId: record.id, source: record.source, downloadPauseStage: options.stage ?? null })
              return Reflect.apply(method, receiver, [{ ...values[0], downloadPauseStage: options.stage }, ...values.slice(1)])
            }
            return Reflect.apply(method, receiver, values)
          },
        })
        return worker
      },
    })
  })
}

async function localState(page, workspaceId) {
  return await bounded(page.evaluate(async ({ id, hash }) => {
    const read = async (databaseName, storeName, key) => {
      const databases = await indexedDB.databases()
      if (!databases.some(database => database.name === databaseName)) return null
      return await new Promise((resolveRead, reject) => {
        const request = indexedDB.open(databaseName)
        request.onerror = () => reject(request.error)
        request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error('Audit must not create a database')) }
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(storeName, 'readonly')
          const get = transaction.objectStore(storeName).get(key)
          transaction.oncomplete = () => { database.close(); resolveRead(get.result ?? null) }
          transaction.onabort = () => { database.close(); reject(transaction.error) }
          transaction.onerror = () => { database.close(); reject(transaction.error) }
        }
      })
    }
    const metadata = await read('dsh-browser-native-workspace-v1', 'workspace', id)
    const intent = await read('dsh-browser-native-downloads-v1', 'downloads', [id, hash])
    const root = await navigator.storage.getDirectory()
    let blob = null
    try {
      const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
      const file = await (await directory.getFileHandle(hash)).getFile()
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      blob = { bytes: file.size, hash: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') }
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error
    }
    const locks = await navigator.locks.query()
    const lockName = `dsh-workspace-local-${id}`
    return { metadata, intent, blob, locks: {
      held: locks.held.filter(lock => lock.name === lockName), pending: locks.pending.filter(lock => lock.name === lockName),
    } }
  }, { id: workspaceId, hash: expected.hash }), 'read real IndexedDB, OPFS and Web Locks')
}

function assertResidue(snapshot, stage, workspaceId) {
  assert.equal(snapshot.metadata?.workspaceId, workspaceId)
  assert.deepEqual(snapshot.metadata.pending, [])
  assert.equal(snapshot.metadata.retryBatch, undefined)
  assert.equal(snapshot.intent?.version, 1)
  assert.equal(snapshot.intent.workspaceId, workspaceId)
  assert.equal(snapshot.intent.hash, expected.hash)
  assert.equal(snapshot.intent.bytes, expected.bytes)
  assert.equal(typeof snapshot.intent.attemptId, 'string')
  assert.ok(snapshot.intent.attemptId.length > 0)
  if (stage === 'intent-durable') assert.equal(snapshot.blob, null, 'intent must precede canonical entry creation')
  else if (stage === 'published') assert.deepEqual(snapshot.blob, expected, 'closed canonical bytes must already match the manifest')
  else {
    assert.ok(snapshot.blob, 'canonical OPFS residue must survive Worker termination')
    assert.equal(snapshot.blob.bytes, 0, 'unclosed createWritable does not publish its temporary writes')
  }
}

async function cookie(context) {
  const principal = (await context.cookies(`${origin}${api}`)).find(item => item.name === 'dsh-browser-native-principal')
  assert.ok(principal, 'real Host boot must establish the browser Workspace principal')
  return `${principal.name}=${principal.value}`
}

async function requestJson(run, path, body) {
  const response = await fetch(`${origin}${api}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: await cookie(run.context), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), ...body }) }),
    signal: AbortSignal.timeout(timeout), redirect: 'error',
  })
  const value = await response.json()
  assert.equal(response.status, 200, JSON.stringify({ path, value }))
  return value
}

async function seedManifest(run) {
  const operationId = randomUUID()
  const chunks = []
  for (let offset = 0; offset < fixture.length; offset += 1024 * 1024) {
    const bytes = fixture.subarray(offset, Math.min(offset + 1024 * 1024, fixture.length))
    chunks.push({ offset, length: bytes.length, hash: hashBytes(bytes) })
  }
  const layout = { version: 1, algorithm: 'dsh-gear-v1', minimumBytes: 32 * 1024,
    averageBytes: 128 * 1024, maximumBytes: 1024 * 1024, chunks }
  const upload = `blob-upload/${operationId}-${expected.hash}`
  const start = await requestJson(run, 'blob-upload/start', {
    workspaceId: run.workspaceId, operationId, hash: expected.hash, totalBytes: expected.bytes, chunkBytes: 1024 * 1024, layout,
  })
  assert.equal(start.complete, false)
  for (const index of start.missing) {
    const chunk = chunks[index]
    const response = await fetch(`${origin}${api}/${upload}/${index}`, {
      method: 'PUT', signal: AbortSignal.timeout(timeout), redirect: 'error',
      headers: { cookie: await cookie(run.context), 'content-type': 'application/octet-stream',
        'x-browser-native-protocol': '1', 'x-workspace-id': run.workspaceId,
        'x-request-id': randomUUID(), 'x-chunk-sha256': chunk.hash },
      body: fixture.subarray(chunk.offset, chunk.offset + chunk.length),
    })
    const value = await response.json()
    assert.equal(response.status, 200, JSON.stringify(value))
  }
  const complete = await requestJson(run, `${upload}/complete`, { workspaceId: run.workspaceId })
  assert.equal(complete.complete, true)
  assert.equal(complete.assembledWriteBytes, 0, 'seed must exercise real chunk-object composition')
  const commit = await requestJson(run, 'commit', { workspaceId: run.workspaceId, operationId: randomUUID(), baseRevision: 0,
    changes: [{ path: 'cache-recovery.bin', kind: 'file', mode: 0o644, hash: expected.hash, bytes: expected.bytes }] })
  assert.equal(commit.revision, 1)
  const manifest = await requestJson(run, `manifest?protocolVersion=1&workspaceId=${run.workspaceId}`)
  assert.equal(manifest.entries.length, 1)
  assert.deepEqual(manifest.entries[0], { path: 'cache-recovery.bin', kind: 'file', mode: 0o644, ...expected })
  return { complete, manifest }
}

async function newPage(run, label) {
  const page = await run.context.newPage()
  run.pages.push(page)
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) run.diagnostics.push({ page: label, type: message.type(), text: message.text() })
  })
  page.on('pageerror', error => run.pageErrors.push({ page: label, message: error.message }))
  return page
}

async function createRun(name) {
  const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' })
  context.setDefaultTimeout(timeout)
  context.setDefaultNavigationTimeout(timeout)
  const run = { name, context, pages: [], downloads: [], llmRequests: [], sessionIds: new Set(),
    forbiddenSessionEvents: [], pageErrors: [], diagnostics: [], externalRequests: [], phase: 'bootstrap' }
  active = run
  await installWorkerObserver(context)
  context.on('request', request => {
    const url = new URL(request.url())
    if (url.protocol.startsWith('http') && url.origin !== origin) run.externalRequests.push(url.origin + url.pathname)
    if (url.pathname === '/api/browser-native/llm') run.llmRequests.push(url.pathname)
    if (url.pathname.startsWith(`${api}/blob/`)) run.downloads.push({ phase: run.phase, path: url.pathname,
      query: url.search, method: request.method() })
    if (url.pathname.startsWith('/api/browser-native/session/') && request.method() === 'POST') {
      const body = request.postDataJSON()
      if (body?.sessionId !== undefined) run.sessionIds.add(body.sessionId)
      run.forbiddenSessionEvents.push(...(body?.events ?? []).filter(event => /^(turn|user|assistant|tool|input)(?:\/|[.-])/.test(event.type)))
    }
  })
  const page = await newPage(run, 'primary')
  run.page = page
  await openPreview(page, `${origin}/preview.html?${previewQuery}`)
  run.workspaceId = (await ready(page, undefined, 0)).workspaceId
  await action(page, { action: 'close-vfs' })
  await page.evaluate(() => {
    for (const record of window.__dshCacheRecovery.workers) {
      if (record.name === 'dsh-host') { record.worker.terminate(); record.terminated = true }
    }
  })
  const clean = await localState(page, run.workspaceId)
  assert.equal(clean.intent, null)
  assert.equal(clean.blob, null, 'fresh isolated browser context has no fixture cache to clear')
  run.seed = await seedManifest(run)
  return run
}

async function armAndReload(run, stage) {
  await run.page.evaluate(options => sessionStorage.setItem('dsh-cache-recovery-pause', JSON.stringify(options)), { stage })
  run.phase = 'interrupted-download'
  await run.page.reload({ waitUntil: 'domcontentloaded' })
  await run.page.waitForFunction(expectedStage => window.__dshCacheRecovery?.pauses.some(pause => pause.stage === expectedStage), stage, { timeout })
  const state = await run.page.evaluate(() => ({ pauses: window.__dshCacheRecovery.pauses,
    initializations: window.__dshCacheRecovery.initializations }))
  assert.equal(state.pauses.length, 1, 'one-shot pause must hit only the selected publication')
  assert.equal(state.pauses[0].terminated, true)
  assert.equal(state.initializations[0].downloadPauseStage, stage)
  await waitFor(async () => (await localState(run.page, run.workspaceId)).locks.held.length === 0,
    'browser releases terminated Worker Web Lock', timeout)
  return state
}

async function recover(run, page = run.page) {
  run.phase = 'recovery'
  const beforeDownloads = run.downloads.length
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(page)
  const status = await ready(page, run.workspaceId, 1)
  const digest = await action(page, { action: 'read-digest', path: workspacePath })
  assert.equal(digest.digest, expected.hash)
  assert.equal(digest.bytes, expected.bytes)
  const after = await localState(page, run.workspaceId)
  assert.equal(after.intent, null, 'recovery must clear the durable publication intent')
  assert.deepEqual(after.blob, expected)
  assert.deepEqual(after.metadata.pending, [])
  const observer = await page.evaluate(() => ({ pauses: window.__dshCacheRecovery.pauses,
    initializations: window.__dshCacheRecovery.initializations }))
  assert.deepEqual(observer.pauses, [], 'new Worker must not inherit the pause')
  assert.equal(observer.initializations[0].downloadPauseStage, null)
  return { status, digest, after, observer, downloads: run.downloads.slice(beforeDownloads) }
}

async function deleteIntent(page, workspaceId) {
  await bounded(page.evaluate(async ({ id, hash }) => await new Promise((resolveDelete, reject) => {
    const request = indexedDB.open('dsh-browser-native-downloads-v1', 1)
    request.onerror = () => reject(request.error)
    request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error('Expected an existing journal')) }
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('downloads', 'readwrite', { durability: 'strict' })
      transaction.objectStore('downloads').delete([id, hash])
      transaction.oncomplete = () => { database.close(); resolveDelete() }
      transaction.onerror = () => { database.close(); reject(transaction.error) }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
  }), { id: workspaceId, hash: expected.hash }), 'delete only matching publication intent')
}

async function verifySessions(run) {
  assert.deepEqual(run.llmRequests, [], 'LLM requests must remain zero')
  assert.deepEqual(run.forbiddenSessionEvents, [])
  assert.deepEqual(run.externalRequests, [])
  const sessions = [...run.sessionIds].map(sessionId => {
    const session = app.store.get(sessionId)
    assert.ok(session, 'bootstrap Session must remain in the backend')
    const eventTypes = session.events.map(event => event.type)
    assert.deepEqual(eventTypes.filter(type => /^(turn|user|assistant|tool|input)(?:\/|[.-])/.test(type)), [])
    return { sessionId, eventTypes, durableThroughSeq: session.durableThroughSeq }
  })
  evidence.modelRequests += run.llmRequests.length
  return sessions
}

async function runScenario(name, result) {
  const run = await createRun(name)
  Object.assign(result, { workspaceId: run.workspaceId, seed: run.seed, downloads: run.downloads,
    diagnostics: run.diagnostics, pageErrors: run.pageErrors })
  const stage = name === 'missing-intent' ? 'entry-created' : name
  result.interruption = await armAndReload(run, stage)
  result.residue = await localState(run.page, run.workspaceId)
  assertResidue(result.residue, stage, run.workspaceId)
  result.pausedScreenshot = await screenshot(run.page, `${name}-interrupted`)
  if (name === 'missing-intent') {
    process.stderr.write(`${JSON.stringify({ name, step: 'remove-intent' })}\n`)
    await deleteIntent(run.page, run.workspaceId)
    result.afterIntentRemoval = await localState(run.page, run.workspaceId)
    assert.equal(result.afterIntentRemoval.intent, null)
    assert.deepEqual(result.afterIntentRemoval.blob, result.residue.blob)
    assert.deepEqual(result.afterIntentRemoval.metadata, result.residue.metadata)
    run.phase = 'negative-control'
    const beforeDownloads = run.downloads.length
    await run.page.reload({ waitUntil: 'domcontentloaded' })
    process.stderr.write(`${JSON.stringify({ name, step: 'observe-corrupt-status' })}\n`)
    await run.page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'local-corrupt', undefined, { timeout })
    result.status = await run.page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
    assert.match(result.status.message, /local blob size mismatch/)
    assert.ok(result.status.message.includes(expected.hash))
    await waitFor(async () => run.diagnostics.some(item => item.text.includes('Worker Host startup failed')
      && item.text.includes('local blob size mismatch')), 'actual Host startup rejects the unregistered damaged file', timeout)
    result.startupFailure = run.diagnostics.find(item => item.text.includes('Worker Host startup failed'))
    process.stderr.write(`${JSON.stringify({ name, step: 'audit-preserved-residue' })}\n`)
    result.afterFailure = await localState(run.page, run.workspaceId)
    assert.deepEqual(result.afterFailure.blob, result.residue.blob, 'unregistered damaged bytes must remain untouched')
    assert.deepEqual(result.afterFailure.metadata, result.residue.metadata)
    assert.equal(run.downloads.length, beforeDownloads, 'missing journal evidence must never trigger redownload')
  } else {
    result.recovery = await recover(run)
    assert.equal(result.recovery.downloads.length, stage === 'published' ? 0 : 1,
      'closed verified cache must be reused; incomplete publication must download exactly once')
    if (stage !== 'published') assert.ok(result.recovery.downloads[0].path.endsWith('/stream'))
  }
  process.stderr.write(`${JSON.stringify({ name, step: 'final-screenshot' })}\n`)
  result.finalScreenshot = await screenshot(run.page, `${name}-final`)
  result.sessions = await verifySessions(run)
  if (name !== 'missing-intent') assert.deepEqual(run.pageErrors, [])
  result.result = 'passed'
  process.stderr.write(`${JSON.stringify({ name, step: 'close-context' })}\n`)
  await run.context.close()
  active = undefined
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  evidence.previewWorkers = await Promise.all((await readdir(join(image.distRoot, 'preview')))
    .filter(file => /^browser-native-worker-.*\.js$/.test(file)).map(async file => ({
      file, sha256: hashBytes(await readFile(join(image.distRoot, 'preview', file))),
    })))
  app = await createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted',
    workspaceChunkObjects: true, workspaceVerifiedDownloads: true })
  origin = await app.listen(0)
  evidence.origin = origin
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  evidence.browserVersion = browser.version()
  for (const name of selected) {
    const result = { name, result: 'running' }
    evidence.scenarios.push(result)
    process.stderr.write(`${JSON.stringify({ name, state: 'started' })}\n`)
    await runScenario(name, result)
    process.stderr.write(`${JSON.stringify({ name, state: result.result })}\n`)
    await writeFile(join(artifactDir, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`)
  }
  evidence.result = 'passed'
} catch (error) {
  evidence.result = 'failed'
  if (evidence.scenarios.at(-1)?.result === 'running') evidence.scenarios.at(-1).result = 'failed'
  evidence.failure = { name: error.name, message: error.message, stack: error.stack }
  process.exitCode = 1
  if (active !== undefined) {
    evidence.active = { name: active.name, phase: active.phase, downloads: active.downloads,
      diagnostics: active.diagnostics, pageErrors: active.pageErrors }
    try { evidence.failureScreenshot = await screenshot(active.page, `${active.name}-failure`) } catch (captureError) {
      evidence.captureError = captureError.message
    }
  }
} finally {
  for (const [resource, dispose] of [
    ['context', async () => await active?.context.close()],
    ['browser', async () => await browser?.close()],
    ['backend', async () => await app?.close()],
    ['validation-image', async () => await image?.cleanup()],
    ['private-data', async () => {
      if (process.env.DSH_POC_CACHE_RECOVERY_KEEP_DATA !== '1') await rm(dataDir, { recursive: true, force: true })
    }],
  ]) {
    try { await dispose() } catch (error) {
      evidence.cleanupErrors.push({ resource, message: error.message })
      evidence.result = 'failed'
      process.exitCode = 1
    }
  }
  evidence.elapsedMs = performance.now() - startedAt
  await mkdir(dirname(resultFile), { recursive: true })
  await writeFile(resultFile, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ result: evidence.result, resultFile, artifactDir, elapsedMs: evidence.elapsedMs,
    scenarios: evidence.scenarios.map(item => ({ name: item.name, result: item.result })), failure: evidence.failure?.message })}\n`)
}
