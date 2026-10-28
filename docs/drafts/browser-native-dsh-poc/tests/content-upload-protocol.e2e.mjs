/** Real Chrome upload costs and durable response-loss recovery; consumes a freshly built preview. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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
const mib = 1024 * 1024
const workspacePath = '/dsh/home/workspace/fixture.bin'
const api = '/api/browser-native/workspace'
const previewQuery = 'browser-native=1&browser-native-durable=1&browser-native-test=workspace-recovery&preview-fixture=none'
const forceFixed = process.env.DSH_POC_CONTENT_UPLOAD_FORCE_FIXED === '1'
const timeout = Number(process.env.DSH_POC_CONTENT_UPLOAD_TIMEOUT_MS ?? 240_000)
assert.ok(Number.isSafeInteger(timeout) && timeout > 0, 'DSH_POC_CONTENT_UPLOAD_TIMEOUT_MS must be a positive integer')
const scenarios = [
  { name: 'binary-16m-insert', contentKind: 'binary', byteLength: 16 * mib, editKind: 'insert' },
  { name: 'binary-16m-delete', contentKind: 'binary', byteLength: 16 * mib, editKind: 'delete' },
  { name: 'text-16m-insert', contentKind: 'text', byteLength: 16 * mib, editKind: 'insert' },
  { name: 'text-16m-delete', contentKind: 'text', byteLength: 16 * mib, editKind: 'delete' },
  { name: 'binary-64m-replace', contentKind: 'binary', byteLength: 64 * mib, editKind: 'replace' },
  ...['reuse', 'put', 'complete', 'commit'].map(stage => ({
    name: `recovery-${stage}`, contentKind: 'binary', byteLength: 16 * mib, editKind: 'insert', lossStage: stage,
  })),
].map(scenario => ({ ...scenario, editPosition: 'middle' }))
const selection = process.env.DSH_POC_CONTENT_UPLOAD_SCENARIO ?? 'all'
const selected = scenarios.filter(scenario => selection === 'all'
  || selection === 'normal' && scenario.lossStage === undefined
  || selection === 'recovery' && scenario.lossStage !== undefined
  || selection === scenario.name)
assert.ok(selected.length > 0, `Unknown scenario ${selection}; choose normal, recovery, all, or ${scenarios.map(item => item.name).join(', ')}`)
const resultFile = resolve(process.env.DSH_POC_RESULT_FILE ?? join(tmpdir(), `dsh-content-upload-${Date.now()}.json`))
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-content-upload-backend-')))
const startedAt = performance.now()
const evidence = {
  result: 'running', selection, forceFixedNegativeControl: forceFixed, browser: process.env.DSH_POC_BROWSER ?? 'chrome',
  model: 'not used; no composer submission or ctx.agentLoop execution',
  measurements: 'Actual HTTP request bodies; backend response I/O counters exclude audit downloads and metadata filesystem I/O',
  storageIsolation: 'Each strategy and case owns a new backend dataDir and empty blob store; recovery reuses only its own dataDir and port',
  derivedIo: 'derivedManifestCommitVerifyBytes sums file sizes in successful non-replayed commits because WorkspaceRepository.commit verifies each complete blob; this is source-based accounting, not an observed I/O counter',
  scenarios: [], cleanupErrors: [],
}
let image
let app
let browser
let origin
let active
let currentDataDir

function deferred() {
  let resolveValue
  const promise = new Promise(resolvePromise => { resolveValue = resolvePromise })
  return { promise, resolve: resolveValue }
}

async function bounded(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolveUnused, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function uploadIdentity(path) {
  const match = path.match(/\/blob-upload\/([0-9a-f-]{36})-([a-f0-9]{64})(?:\/(reuse|complete|[0-9]+))?$/i)
  return match === null ? {} : {
    operationId: match[1], hash: match[2],
    ...(match[3] !== undefined && /^\d+$/.test(match[3]) ? { chunkIndex: Number(match[3]) } : {}),
  }
}

function requestStage(path, method) {
  if (path === `${api}/blob-upload/start`) return 'start'
  if (path === `${api}/commit`) return 'commit'
  if (path.includes('/blob-upload/')) {
    if (path.endsWith('/reuse')) return 'reuse'
    if (path.endsWith('/complete')) return 'complete'
    return method === 'PUT' ? 'put' : 'status'
  }
  return 'other'
}

async function action(run, request) {
  const value = await bounded(run.page.evaluate(async payload => {
    if (typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ !== 'function') throw new Error('Workspace test API is unavailable')
    return await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__(payload)
  }, request), `Worker action ${request.action}`)
  assert.equal(value?.ok, true, JSON.stringify({ action: request.action, value }))
  return value
}

async function workspaceReady(run, revision) {
  await run.page.waitForFunction(expected => {
    const status = window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__
    return typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ === 'function'
      && status?.state === 'synced' && (expected === undefined || status.revision === expected)
  }, revision, { timeout })
  const status = await run.page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
  if (run.workspaceId !== undefined) assert.equal(status.workspaceId, run.workspaceId, 'refresh must preserve Workspace identity')
  else run.workspaceId = status.workspaceId
  assert.equal(typeof run.workspaceId, 'string')
  return status
}

async function cookies(run) {
  const values = await run.context.cookies(`${origin}${api}`)
  const principal = values.find(cookie => cookie.name === 'dsh-browser-native-principal')
  assert.ok(principal, 'Browser Workspace principal cookie is missing')
  return `${principal.name}=${principal.value}`
}

async function auditJson(run, path) {
  const response = await fetch(`${origin}${api}/${path}${path.includes('?') ? '&' : '?'}protocolVersion=1&workspaceId=${encodeURIComponent(run.workspaceId)}`, {
    headers: { cookie: await cookies(run) }, redirect: 'error', signal: AbortSignal.timeout(timeout),
  })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify({ path, body }))
  return body
}

async function hashRemoteBlob(run, expected) {
  const before = performance.now()
  const response = await fetch(`${origin}${api}/blob/${expected.digest}?protocolVersion=1&workspaceId=${encodeURIComponent(run.workspaceId)}`, {
    headers: { cookie: await cookies(run) }, redirect: 'error', signal: AbortSignal.timeout(timeout),
  })
  assert.equal(response.status, 200, 'complete blob must be readable with the browser identity')
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of response.body) {
    hash.update(chunk)
    bytes += chunk.byteLength
  }
  const digest = hash.digest('hex')
  assert.equal(bytes, expected.bytes)
  assert.equal(digest, expected.digest)
  return { bytes, digest, elapsedMs: performance.now() - before, transport: 'Node fetch streaming SHA-256; no file bytes enter the page' }
}

async function verifyManifest(run, expected, revision) {
  const manifest = await auditJson(run, 'manifest')
  assert.equal(manifest.workspaceId, run.workspaceId)
  assert.equal(manifest.revision, revision)
  const entry = manifest.entries.find(item => item.path === 'fixture.bin')
  assert.equal(entry?.kind, 'file', JSON.stringify(manifest))
  assert.equal(entry.hash, expected.digest)
  assert.equal(entry.bytes, expected.bytes)
  return manifest
}

async function captureRoute(run, route) {
  const request = route.request()
  const url = new URL(request.url())
  if (url.origin !== origin || !url.pathname.startsWith(api)) {
    await route.continue()
    return
  }
  const method = request.method()
  const stage = requestStage(url.pathname, method)
  const payload = method === 'POST' ? request.postDataJSON() : undefined
  const requestBytes = request.postDataBuffer()?.byteLength ?? 0
  const record = {
    phase: run.phase, epoch: run.epoch, stage, method, path: url.pathname,
    ...uploadIdentity(url.pathname), requestBytes,
    ...(payload === undefined ? {} : { request: payload, operationId: payload.operationId ?? uploadIdentity(url.pathname).operationId }),
    ...(stage !== 'start' ? {} : { layoutBytes: payload.layout === undefined ? 0 : Buffer.byteLength(JSON.stringify(payload.layout)) }),
  }
  run.requests.push(record)
  if (stage === 'start' && run.uploadGate !== undefined) await run.uploadGate.promise
  const before = performance.now()
  const response = await route.fetch({ timeout, maxRetries: 0, maxRedirects: 0 })
  const body = await response.body()
  record.elapsedMs = performance.now() - before
  record.status = response.status()
  record.responseBytes = body.byteLength
  if (response.headers()['content-type']?.includes('application/json')) record.response = JSON.parse(body.toString('utf8'))
  const loseResponse = run.phase === 'target' && run.lossStage === stage && run.lost === undefined
  if (loseResponse) {
    assert.equal(record.status, 200, `backend must process ${stage} before response loss`)
    run.lost = record
    record.responseLost = true
    await run.page.evaluate(() => {
      if (window.__dshContentUploadWorkers.length === 0) throw new Error('Dedicated Worker was not captured')
      for (const worker of window.__dshContentUploadWorkers) worker.terminate()
    })
    await route.abort('aborted')
    run.lossReached = true
    return
  }
  await route.fulfill({ response, body })
}

async function createRun(scenario, strategy) {
  await app?.close()
  app = undefined
  await mkdir(dataDir, { recursive: true })
  currentDataDir = await mkdtemp(join(dataDir, 'run-'))
  app = await createBrowserNativeV2Server({ dataDir: currentDataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  origin = await app.listen(0)
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' })
  const run = {
    strategy, lossStage: scenario.lossStage, context, phase: 'boot', epoch: 0,
    contentDefinedUpload: strategy === 'cdc' && !forceFixed, sessionIds: new Set(), sessionTraffic: [], llmRequests: [],
    requests: [], externalRequests: [], pageErrors: [], workerErrors: [], routeErrors: [], routes: new Set(), closing: false,
  }
  active = run
  await context.addInitScript(({ enabled }) => {
    const workers = []
    const initializations = []
    Object.defineProperty(window, '__dshContentUploadWorkers', { value: workers })
    Object.defineProperty(window, '__dshContentUploadInitializations', { value: initializations })
    window.Worker = new Proxy(window.Worker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args, target)
        workers.push(worker)
        worker.postMessage = new Proxy(worker.postMessage, {
          apply(method, receiver, values) {
            if (values[0]?.type === 'browser-native-durable-workspace-init') {
              initializations.push({ contentDefinedUpload: enabled })
              if (enabled) {
                const patched = [...values]
                patched[0] = { ...values[0], contentDefinedUpload: true }
                return Reflect.apply(method, receiver, patched)
              }
            }
            return Reflect.apply(method, receiver, values)
          },
        })
        return worker
      },
    })
  }, { enabled: run.contentDefinedUpload })
  context.on('request', request => {
    const url = new URL(request.url())
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin) {
      run.externalRequests.push({ origin: url.origin, path: url.pathname })
    }
    if (url.pathname === '/api/browser-native/llm') run.llmRequests.push(url.pathname)
    if (url.pathname.startsWith('/api/browser-native/session/')) {
      const body = request.method() === 'POST' ? request.postDataJSON() : undefined
      if (body?.sessionId !== undefined) run.sessionIds.add(body.sessionId)
      run.sessionTraffic.push({ path: url.pathname, sessionId: body?.sessionId, eventTypes: body?.events?.map(event => event.type) })
    }
  })
  await context.route('**/*', route => {
    const pending = captureRoute(run, route).catch(async error => {
      if (!run.closing) run.routeErrors.push(error.message)
      const aborted = await Promise.allSettled([route.abort('failed')])
      if (!run.closing && aborted[0].status === 'rejected') run.routeErrors.push(aborted[0].reason.message)
    })
    run.routes.add(pending)
    return pending.finally(() => run.routes.delete(pending))
  })
  run.page = await context.newPage()
  run.page.on('pageerror', error => run.pageErrors.push(error.message))
  run.page.on('worker', worker => worker.on('pageerror', error => run.workerErrors.push(error.message)))
  await openPreview(run.page, `${origin}/preview.html?${previewQuery}`)
  await workspaceReady(run, 0)
  assert.deepEqual(await run.page.evaluate(() => window.__dshContentUploadInitializations), [{ contentDefinedUpload: run.contentDefinedUpload }])
  return run
}

async function writeWorkload(run, scenario, edit) {
  run.uploadGate = deferred()
  const value = await action(run, {
    action: 'write-content-workload', path: workspacePath, byteLength: scenario.byteLength,
    contentKind: scenario.contentKind,
    ...(edit ? { editKind: scenario.editKind, editPosition: scenario.editPosition } : {}),
  })
  assert.equal(value.durable, true, 'target must be in OPFS/IndexedDB before upload')
  assert.equal(value.bytes, scenario.byteLength + (!edit ? 0 : scenario.editKind === 'insert' ? 64 * 1024 : scenario.editKind === 'delete' ? -64 * 1024 : 0))
  assert.match(value.digest, /^[a-f0-9]{64}$/)
  assert.ok(value.usage !== undefined)
  return value
}

function releaseUpload(run) {
  run.uploadGate?.resolve()
  run.uploadGate = undefined
}

async function flushWorkload(run, revision) {
  const pending = action(run, { action: 'flush-workspace' })
  releaseUpload(run)
  const flush = await pending
  await workspaceReady(run, revision)
  return flush
}

function assertHealthy(run) {
  assert.deepEqual(run.pageErrors, [])
  assert.deepEqual(run.workerErrors, [])
  assert.deepEqual(run.externalRequests, [])
  assert.deepEqual(run.routeErrors, [])
  assert.deepEqual(run.llmRequests, [], 'upload validation must not issue an LLM request')
  run.uiBootstrap = [...run.sessionIds].map(sessionId => {
    const session = app.store.get(sessionId)
    const eventTypes = session.events.map(event => event.type)
    const forbidden = eventTypes.filter(type => /^(turn|user|assistant|tool|input)(?:\/|[.-])/.test(type))
    assert.deepEqual(forbidden, [], 'UI bootstrap Session must contain no turn, user input, assistant output, or tool execution')
    return { sessionId, eventTypes, durableThroughSeq: session.durableThroughSeq }
  })
  const submittedInputs = run.sessionTraffic.flatMap(request => request.eventTypes ?? [])
    .filter(type => /^(turn|user|assistant|tool|input)(?:\/|[.-])/.test(type))
  assert.deepEqual(submittedInputs, [], 'captured Session appends must contain no submitted prompt or loop event')
  const failures = run.requests.filter(request => request.status !== 200)
  assert.deepEqual(failures, [], 'Workspace protocol requests must succeed')
}

async function reloadWorkspace(run, expected) {
  run.phase = 'refresh'
  await action(run, { action: 'close-vfs' })
  await run.page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPreview(run.page)
  const status = await workspaceReady(run, 2)
  const read = await action(run, { action: 'read-digest', path: workspacePath })
  assert.equal(read.digest, expected.digest)
  assert.equal(read.bytes, expected.bytes)
  const manifest = await verifyManifest(run, expected, 2)
  return { status, read, manifest, usage: await action(run, { action: 'usage' }) }
}

async function recoverWorkload(run, expected) {
  const interrupted = action(run, { action: 'flush-workspace' }).then(
    value => ({ outcome: 'resolved', value }),
    error => ({ outcome: 'rejected', message: error.message }),
  )
  releaseUpload(run)
  await waitFor(() => {
    assert.deepEqual(run.routeErrors, [])
    return run.lossReached
  }, `real backend ${run.lossStage} response before Worker termination`, timeout)
  const lost = run.lost
  const operationId = lost.response.operationId
  const hash = lost.response.hash ?? expected.digest
  assert.equal(hash, expected.digest)
  assert.equal(typeof operationId, 'string')
  if (run.lossStage === 'reuse') assert.ok(lost.response.reused.length > 0 && lost.response.missing.length > 0)
  if (run.lossStage === 'put') assert.equal(lost.response.replayed, false)
  if (run.lossStage === 'complete') assert.equal(lost.response.complete, true)
  if (run.lossStage === 'commit') assert.equal(lost.response.replayed, false)
  const uploadPath = `blob-upload/${operationId}-${hash}`
  const beforeRestart = await auditJson(run, uploadPath)
  const manifestBeforeRestart = await auditJson(run, 'manifest')
  assert.equal(manifestBeforeRestart.revision, run.lossStage === 'commit' ? 2 : 1)
  if (run.lossStage === 'put') assert.equal(beforeRestart.missing.includes(lost.chunkIndex), false)
  if (run.lossStage === 'reuse') assert.deepEqual(beforeRestart.missing, lost.response.missing)
  if (run.lossStage === 'complete' || run.lossStage === 'commit') assert.equal(beforeRestart.complete, true)
  const port = Number(new URL(origin).port)
  await app.close()
  app = undefined
  app = await createBrowserNativeV2Server({ dataDir: currentDataDir, distRoot: image.distRoot, llmMode: 'scripted' })
  assert.equal(await app.listen(port), origin, 'restart must preserve origin and browser storage')
  const afterRestart = await auditJson(run, uploadPath)
  assert.equal(afterRestart.complete, beforeRestart.complete)
  assert.deepEqual(afterRestart.missing, beforeRestart.missing)
  run.epoch = 1
  await run.page.reload({ waitUntil: 'domcontentloaded' })
  const interruptedResult = await interrupted
  assert.equal(interruptedResult.outcome, 'rejected', 'the interrupted page.evaluate must be observed after navigation destroys its context')
  assert.match(interruptedResult.message, /Execution context was destroyed|navigation|Target.*closed|context.*destroyed/i)
  await waitForPreview(run.page)
  await workspaceReady(run, 2)
  const operation = await auditJson(run, `operation/${operationId}`)
  assert.equal(operation.found, true)
  assert.equal(operation.receipt.revision, 2)
  const targetRequests = run.requests.filter(request => request.phase === 'target')
  const resumedPuts = targetRequests.filter(request => request.stage === 'put' && request.epoch === 1)
  assert.deepEqual(resumedPuts.map(request => request.chunkIndex).sort((left, right) => left - right),
    [...beforeRestart.missing].sort((left, right) => left - right), 'restart must PUT exactly the durable missing chunks')
  const targetPuts = targetRequests.filter(request => request.stage === 'put')
  assert.equal(new Set(targetPuts.map(request => request.chunkIndex)).size, targetPuts.length, 'acknowledged and response-lost PUTs must not be uploaded again')
  const starts = targetRequests.filter(request => request.stage === 'start')
  assert.ok(starts.length > 0)
  for (const start of starts) {
    assert.equal(start.request.operationId, operationId)
    assert.equal(start.request.hash, expected.digest)
    assert.deepEqual(start.request.layout, starts[0].request.layout)
  }
  const commits = targetRequests.filter(request => request.stage === 'commit')
  assert.ok(commits.length > 0)
  for (const commit of commits) {
    assert.equal(commit.request.operationId, operationId)
    assert.equal(commit.request.baseRevision, 1)
    assert.deepEqual(commit.request.changes, commits[0].request.changes)
    assert.equal(commit.response.revision, 2)
  }
  assert.equal(commits.filter(request => request.response.replayed === false).length, 1, 'Workspace revision must advance exactly once')
  return { stage: run.lossStage, operationId, hash, beforeRestart, afterRestart, manifestBeforeRestart, operation, interruptedEvaluation: interruptedResult }
}

function summarizeRequests(requests) {
  const byStage = {}
  const backendIo = {}
  let uploadPutBytes = 0
  let requestBodyBytes = 0
  let responseBodyBytes = 0
  let derivedManifestCommitVerifyBytes = 0
  for (const request of requests) {
    byStage[request.stage] = (byStage[request.stage] ?? 0) + 1
    requestBodyBytes += request.requestBytes
    responseBodyBytes += request.responseBytes ?? 0
    if (request.stage === 'put') uploadPutBytes += request.requestBytes
    if (request.stage === 'commit' && request.status === 200 && request.response?.replayed === false) {
      derivedManifestCommitVerifyBytes += request.request.changes
        .filter(change => change.kind === 'file').reduce((sum, change) => sum + change.bytes, 0)
    }
    for (const [key, value] of Object.entries(request.response ?? {})) {
      if (key.endsWith('Bytes') && key !== 'totalBytes' && key !== 'chunkBytes' && typeof value === 'number') {
        backendIo[key] = (backendIo[key] ?? 0) + value
      }
    }
  }
  return {
    requests: requests.length, byStage, requestBodyBytes, responseBodyBytes, uploadPutBytes,
    putRequests: byStage.put ?? 0,
    startBodyBytes: requests.filter(request => request.stage === 'start').map(request => request.requestBytes),
    startLayoutBytes: requests.filter(request => request.stage === 'start').map(request => request.layoutBytes),
    backendIo, derivedManifestCommitVerifyBytes,
  }
}

function assertUpload(run, phase, expected) {
  const requests = run.requests.filter(request => request.phase === phase)
  const starts = requests.filter(request => request.stage === 'start')
  assert.ok(starts.length > 0, `${phase} must use the real resumable upload protocol`)
  const layout = starts[0].request.layout
  assert.equal(layout !== undefined, run.contentDefinedUpload)
  if (layout !== undefined) {
    assert.equal(layout.algorithm, 'dsh-gear-v1')
    assert.equal(layout.version, 1)
    assert.ok(layout.chunks.length > 0 && layout.chunks.length <= 2048)
    assert.equal(layout.chunks.reduce((sum, chunk) => sum + chunk.length, 0), expected.bytes)
  }
  const puts = requests.filter(request => request.stage === 'put')
  assert.ok(puts.length > 0)
  if (phase === 'source') assert.equal(puts.reduce((sum, request) => sum + request.requestBytes, 0), expected.bytes)
  const completes = requests.filter(request => request.stage === 'complete')
  assert.ok(completes.some(request => request.response?.complete === true))
  const commits = requests.filter(request => request.stage === 'commit')
  assert.ok(commits.length > 0)
  if (phase === 'target') {
    const reuse = requests.filter(request => request.stage === 'reuse')
    assert.equal(reuse.length, 1, 'a durable reuse plan must be reused after restart')
    assert.ok(reuse[0].response.baseVerificationBytes > 0)
    assert.ok(reuse[0].response.comparedSourceBytes > 0)
    assert.ok(reuse[0].response.stagedReuseBytes > 0)
  }
  return summarizeRequests(requests)
}

async function closeRun(run) {
  run.closing = true
  releaseUpload(run)
  await run.context.close()
  await Promise.all([...run.routes])
  if (active === run) active = undefined
}

async function runScenario(scenario, strategy, result) {
  const before = performance.now()
  const run = await createRun(scenario, strategy)
  Object.assign(result, { strategy, contentDefinedUpload: run.contentDefinedUpload, workspaceId: run.workspaceId, requests: run.requests })
  try {
    run.phase = 'source'
    process.stderr.write(`${JSON.stringify({ scenario: scenario.name, strategy, phase: run.phase })}\n`)
    const sourceStarted = performance.now()
    const source = await writeWorkload(run, scenario, false)
    result.source = { workload: source }
    result.source.flush = await flushWorkload(run, 1)
    result.source.elapsedMs = performance.now() - sourceStarted
    result.source.manifest = await verifyManifest(run, source, 1)
    result.source.remote = await hashRemoteBlob(run, source)
    run.phase = 'target'
    process.stderr.write(`${JSON.stringify({ scenario: scenario.name, strategy, phase: run.phase })}\n`)
    const targetStarted = performance.now()
    const target = await writeWorkload(run, scenario, true)
    result.target = { workload: target }
    assert.notEqual(source.digest, target.digest)
    if (scenario.lossStage !== undefined) result.recovery = await recoverWorkload(run, target)
    else result.target.flush = await flushWorkload(run, 2)
    result.target.elapsedMs = performance.now() - targetStarted
    result.target.manifest = await verifyManifest(run, target, 2)
    result.target.remote = await hashRemoteBlob(run, target)
    result.target.usage = await action(run, { action: 'usage' })
    if (strategy === 'cdc') result.refresh = await reloadWorkspace(run, target)
    result.source.cost = assertUpload(run, 'source', source)
    result.target.cost = assertUpload(run, 'target', target)
    assertHealthy(run)
    result.userAgent = await run.page.evaluate(() => navigator.userAgent)
    result.pageErrors = run.pageErrors
    result.workerErrors = run.workerErrors
    result.externalRequests = run.externalRequests
    result.cost = summarizeRequests(run.requests)
    result.uiBootstrap = { sessions: run.uiBootstrap, traffic: run.sessionTraffic, llmRequests: run.llmRequests }
    result.elapsedMs = performance.now() - before
    result.result = 'passed'
  } catch (error) {
    result.result = 'failed'
    throw error
  } finally {
    Object.assign(result, { pageErrors: run.pageErrors, workerErrors: run.workerErrors, externalRequests: run.externalRequests, routeErrors: run.routeErrors })
    await closeRun(run)
  }
}

function sanitize(value, identifiers = new Map()) {
  if (typeof value === 'string') {
    return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, identifier => {
      if (!identifiers.has(identifier)) identifiers.set(identifier, `id-${identifiers.size + 1}`)
      return identifiers.get(identifier)
    }).replaceAll(dataDir, '[private-data-dir]').replaceAll(origin ?? 'http://unused.invalid', '[same-origin]')
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, identifiers))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/token|cookie|credential|secret|authorization|principal|requestId/i.test(key))
      .map(([key, item]) => [key, sanitize(item, identifiers)]))
  }
  return value
}

try {
  image = await createRuntimeValidationDist({ roster: 'browser' })
  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  for (const scenario of selected) {
    const result = { ...scenario, runs: [] }
    evidence.scenarios.push(result)
    for (const strategy of scenario.lossStage === undefined ? ['fixed', 'cdc'] : ['cdc']) {
      process.stderr.write(`${JSON.stringify({ scenario: scenario.name, strategy, state: 'started' })}\n`)
      const runResult = { result: 'running' }
      result.runs.push(runResult)
      await runScenario(scenario, strategy, runResult)
    }
    if (scenario.lossStage === undefined) {
      const [fixed, cdc] = result.runs
      assert.equal(fixed.source.remote.digest, cdc.source.remote.digest)
      assert.equal(fixed.target.remote.digest, cdc.target.remote.digest)
      assert.equal(fixed.target.manifest.revision, cdc.target.manifest.revision)
      assert.deepEqual(fixed.target.manifest.entries, cdc.target.manifest.entries)
      result.comparison = {
        fixedPutBytes: fixed.target.cost.uploadPutBytes, cdcPutBytes: cdc.target.cost.uploadPutBytes,
        savedPutBytes: fixed.target.cost.uploadPutBytes - cdc.target.cost.uploadPutBytes,
        savedPutFraction: 1 - cdc.target.cost.uploadPutBytes / fixed.target.cost.uploadPutBytes,
        fixed: fixed.target.cost, cdc: cdc.target.cost,
      }
      if (scenario.contentKind === 'binary' && scenario.editKind !== 'replace') {
        assert.ok(result.comparison.savedPutFraction > 0.5, 'CDC shift edit must reduce actual HTTP PUT bytes by more than 50%')
      }
    }
    result.result = 'passed'
    process.stderr.write(`${JSON.stringify({ scenario: scenario.name, state: 'passed', comparison: result.comparison })}\n`)
  }
  if (selection === 'normal' || selection === 'all') {
    const shiftSavings = evidence.scenarios.filter(scenario => scenario.lossStage === undefined && scenario.editKind !== 'replace')
    assert.ok(shiftSavings.filter(scenario => scenario.comparison.savedPutFraction > 0.5).length >= 2,
      'at least two shift edits must reduce actual HTTP PUT bytes by more than 50%')
  }
  evidence.result = 'passed'
} catch (error) {
  evidence.result = 'failed'
  evidence.failure = { name: error.name, message: error.message, stack: error.stack }
  if (active !== undefined) {
    evidence.active = {
      strategy: active.strategy, phase: active.phase, requests: active.requests, lost: active.lost,
      pageErrors: active.pageErrors, workerErrors: active.workerErrors, routeErrors: active.routeErrors,
      externalRequests: active.externalRequests,
    }
  }
  process.exitCode = 1
} finally {
  const cleanup = [
    ['context', async () => { if (active !== undefined) await closeRun(active) }],
    ['browser', async () => await browser?.close()],
    ['backend', async () => await app?.close()],
    ['validation-image', async () => await image?.cleanup()],
    ['private-backend-data', async () => { if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true }) }],
  ]
  for (const [resource, dispose] of cleanup) {
    try { await dispose() } catch (error) {
      evidence.cleanupErrors.push({ resource, message: error.message })
      evidence.result = 'failed'
      process.exitCode = 1
    }
  }
  evidence.elapsedMs = performance.now() - startedAt
  evidence.rawCostSummary = summarizeRequests(evidence.scenarios.flatMap(scenario => scenario.runs.flatMap(run => run.requests ?? [])))
  await mkdir(dirname(resultFile), { recursive: true })
  await writeFile(resultFile, `${JSON.stringify(sanitize(evidence), null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(sanitize({
    result: evidence.result, rawResults: resultFile, elapsedMs: evidence.elapsedMs,
    rawCostSummary: evidence.rawCostSummary, failure: evidence.failure?.message,
    scenarios: evidence.scenarios.map(scenario => ({
      name: scenario.name, result: scenario.result, comparison: scenario.comparison,
      runs: scenario.runs.map(run => ({ strategy: run.strategy, result: run.result, source: run.source?.cost, target: run.target?.cost, recovery: run.recovery?.stage })),
    })),
  }))}\n`)
}
