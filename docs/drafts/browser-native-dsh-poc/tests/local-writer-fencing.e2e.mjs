/** Complete Chrome Hosts exercise observer isolation, retry takeover, and a fenced queued local save. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const timeout = Number(process.env.DSH_POC_LOCAL_WRITER_TIMEOUT_MS ?? 30_000)
const caseTimeout = Number(process.env.DSH_POC_LOCAL_WRITER_CASE_TIMEOUT_MS ?? 180_000)
const cleanupTimeout = 10_000
assert.ok(Number.isSafeInteger(timeout) && timeout > 0, 'The wait timeout must be a positive integer')
assert.ok(Number.isSafeInteger(caseTimeout) && caseTimeout >= timeout, 'The case timeout must cover a bounded wait')
assert.equal(process.env.DSH_POC_BROWSER ?? 'chrome', 'chrome', 'Local writer fencing requires Chrome')
const artifactParent = resolve(process.env.DSH_POC_LOCAL_WRITER_ARTIFACT_DIR ?? tmpdir())
await mkdir(artifactParent, { recursive: true })
const artifactDir = await mkdtemp(join(artifactParent, 'dsh-local-writer-fencing-'))
const dataDir = await mkdtemp(join(artifactDir, 'backend-'))
const resultFile = join(artifactDir, 'results.json')
const logFile = join(artifactDir, 'steps.json')
const previewUrl = '/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none'
const api = '/api/browser-native/workspace'
const workspaceRoot = '/dsh/home/workspace/'
const transferredPath = 'takeover-pending.txt'
const transferredContent = 'original operation must survive the owner transfer\n'
const queuedPath = 'stale-queued.txt'
const queuedContent = 'old in-memory bytes must never enter the successor store\n'
const successorPath = 'successor-pending.txt'
const successorContent = 'successor retry must survive the old queued persistence\n'
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex')
const startedAt = performance.now()
const deadline = startedAt + caseTimeout
const requests = []
const requestRecords = new Map()
const evidence = {
  result: 'running', artifactDir, dataDir, timeout, caseTimeout, steps: [], requests,
  console: [], pageErrors: [], externalRequests: [], cleanupErrors: [], screenshots: [],
  scope: 'Two complete DSH Hosts, distinct Sessions, one Chrome context and backend; scripted model, no OS crash claim',
}
let image
let app
let browser
let context
let ownerPage
let successorPage
let origin
let phase = 'setup'
let failOwnerCommits = false
let failSuccessorCommits = false

async function bounded(work, label, budget = timeout, duringCleanup = false) {
  const remaining = duringCleanup ? budget : Math.min(budget, deadline - performance.now())
  if (remaining <= 0) throw new Error(`Case deadline reached before ${label}; phase=${phase}`)
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((resolveUnused, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}; phase=${phase}`)), remaining)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function poll(observe, label) {
  const pollDeadline = Math.min(deadline, performance.now() + timeout)
  while (performance.now() < pollDeadline) {
    const value = await bounded(observe, label, pollDeadline - performance.now())
    if (value) return value
    await bounded(() => new Promise(resolvePoll => setTimeout(resolvePoll, 50)), label,
      pollDeadline - performance.now())
  }
  throw new Error(`Timed out: ${label}; phase=${phase}`)
}

async function checkpoint(name, details = {}) {
  phase = name
  const step = { name, elapsedMs: Math.round(performance.now() - startedAt), ...details }
  evidence.steps.push(step)
  process.stderr.write(`${JSON.stringify(step)}\n`)
  await writeFile(logFile, `${JSON.stringify(evidence.steps, null, 2)}\n`)
  await writeFile(resultFile, `${JSON.stringify(evidence, null, 2)}\n`)
}

async function workerRequest(page, request) {
  return await bounded(() => page.evaluate(async payload => {
    if (typeof window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__ !== 'function') throw new Error('Workspace test port unavailable')
    return await window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__(payload)
  }, request), `Worker ${request.action}`)
}

async function workerSuccess(page, request) {
  const response = await workerRequest(page, request)
  assert.equal(response?.ok, true, JSON.stringify(response))
  return response
}

async function hostReady(page, label, expectNotice = true) {
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  const notice = page.getByRole('button', { name: /^(Continue|继续)$/ }).first()
  const chooser = page.getByRole('textbox', { name: /^(Choose workspace|选择工作区)$/ }).first()
  if (expectNotice) {
    await bounded(() => notice.waitFor({ timeout }), `${label} preview notice`)
    await bounded(() => notice.click(), `${label} acknowledge preview notice`)
    await bounded(() => notice.waitFor({ state: 'hidden', timeout }), `${label} preview notice closes`)
  }
  let opening = false
  await poll(async () => {
    if (await composer.isVisible()) return true
    if (await notice.isVisible() && await notice.isEnabled()) {
      await notice.click()
      return false
    }
    if (opening) return false
    const dialog = page.getByRole('dialog', { name: /^(Select Workspace Directory|选择工作区目录)$/ })
    if (await dialog.isVisible()) {
      const edit = dialog.getByRole('button', { name: /^(Edit path|编辑路径)$/ })
      const path = dialog.getByRole('textbox', { name: /^(Edit path|编辑路径)$/ })
      if (await edit.isVisible()) await edit.click()
      else if (await path.isVisible()) {
        await path.fill('/dsh/home/')
        await path.press('Enter')
        await dialog.getByRole('button', { name: /^(Open|打开)$/ }).click()
        opening = true
      }
    } else if (await chooser.isVisible()) await chooser.click()
    return false
  }, label)
}

async function status(page, state, workspaceId, revision) {
  return await poll(async () => {
    const current = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
    return current?.state === state && (workspaceId === undefined || current.workspaceId === workspaceId)
      && (revision === undefined || current.revision === revision) ? current : undefined
  }, `Workspace ${state} at revision ${String(revision)}`)
}

async function manifest(page, workspaceId) {
  return await bounded(() => page.evaluate(async ({ api, workspaceId }) => {
    const response = await fetch(`${api}/manifest?protocolVersion=1&workspaceId=${encodeURIComponent(workspaceId)}`,
      { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`)
    return await response.json()
  }, { api, workspaceId }), 'authoritative Workspace manifest')
}

async function storageAudit(page, workspaceId) {
  return await bounded(() => page.evaluate(async id => {
    const audit = { stage: 'list databases' }
    window.__dshLocalWriterFencing.audit = audit
    const databases = []
    for (const info of await indexedDB.databases()) {
      if (!info.name?.startsWith('dsh-browser-native-workspace') && info.name !== 'dsh-browser-native-downloads-v1') continue
      audit.stage = `open ${info.name}`
      const opened = await new Promise((resolveOpen, reject) => {
        const request = indexedDB.open(info.name)
        request.onerror = () => reject(request.error)
        request.onblocked = () => reject(new Error(`Audit open blocked: ${info.name}`))
        request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error('Audit must not create databases')) }
        request.onsuccess = () => resolveOpen(request.result)
      })
      try {
        const names = [...opened.objectStoreNames].sort()
        audit.stage = `read ${info.name}: ${names.join(', ')}`
        const stores = await Promise.all(names.map(async name => {
          const transaction = opened.transaction(name, 'readonly')
          const store = transaction.objectStore(name)
          const keys = store.getAllKeys()
          const values = store.getAll()
          await new Promise((resolveRead, reject) => {
            transaction.oncomplete = resolveRead
            transaction.onabort = () => reject(transaction.error ?? new Error(`Audit aborted: ${name}`))
            transaction.onerror = () => reject(transaction.error ?? new Error(`Audit failed: ${name}`))
          })
          return { name, records: values.result.flatMap((value, index) => {
            const key = keys.result[index]
            return JSON.stringify(key).includes(id) || value?.workspaceId === id ? [{ key, value }] : []
          }) }
        }))
        databases.push({ name: info.name, version: opened.version, stores })
      } finally {
        opened.close()
      }
    }
    databases.sort((left, right) => left.name.localeCompare(right.name))
    const files = []
    try {
      audit.stage = 'OPFS root'
      const root = await navigator.storage.getDirectory()
      audit.stage = 'OPFS blob directory'
      const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${id}`)
      audit.stage = 'OPFS list blobs'
      for await (const entry of directory.values()) {
        if (entry.kind !== 'file') continue
        audit.stage = `OPFS read ${entry.name}`
        const file = await entry.getFile()
        audit.stage = `OPFS hash ${entry.name}`
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
        files.push({ name: entry.name, bytes: file.size,
          hash: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') })
      }
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error
    }
    files.sort((left, right) => left.name.localeCompare(right.name))
    const metadata = databases.flatMap(database => database.stores)
      .find(store => store.name === 'workspace')?.records.find(record => record.key === id)?.value ?? null
    audit.stage = 'complete'
    return { databases, metadata, files }
  }, workspaceId), 'readonly IDB and OPFS audit')
}

function assertStoredBytes(audit, path, content) {
  const change = [...(audit.metadata?.pending ?? []), ...(audit.metadata?.retryBatch?.changes ?? [])]
    .find(item => item.path === path)
  assert.ok(change, `The local snapshot must retain ${path}`)
  const expected = { name: hashBytes(content), bytes: Buffer.byteLength(content), hash: hashBytes(content) }
  assert.ok(audit.files.some(file => file.name === expected.name), `OPFS must retain ${path}`)
  assert.deepEqual(audit.files.find(file => file.name === expected.name), expected)
}

function writerControl(audit, workspaceId) {
  const database = audit.databases.find(item => item.name === 'dsh-browser-native-workspace-v1')
  assert.equal(database?.version, 2, 'The complete Host must use the writer-control database schema')
  const record = database.stores.find(store => store.name === 'control')?.records
    .find(item => item.key === workspaceId)?.value
  assert.ok(Number.isSafeInteger(record?.writerEpoch) && record.writerEpoch > 0, 'The local writer epoch must be durable')
  assert.ok(Number.isSafeInteger(record?.generation) && record.generation > 0, 'The local snapshot generation must be durable')
  return record
}

function sessionSummary(session) {
  return { sessionId: session.id, durableThroughSeq: session.durableThroughSeq,
    eventTypes: session.events.map(event => event.type),
    receipts: session.events.filter(event => event.type === 'browser-native/workspace-receipt').map(event => ({
      seq: event.seq, operationId: event.data.operationId, callId: event.data.callId, toolName: event.data.toolName,
    })) }
}

async function turn(page, role, prompt, marker, sessionId) {
  await bounded(() => page.locator('[data-composer-input][contenteditable="true"]').last().fill(prompt), 'fill composer')
  await bounded(() => page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click(), 'submit DSH turn')
  sessionId ??= await poll(() => requests.findLast(item => item.role === role && item.path.endsWith('/session/create'))?.sessionId,
    `${role} Session creation`)
  const session = await poll(() => {
    const current = app.store.get(sessionId)
    const userIndex = current?.events.findLastIndex(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes(prompt)) ?? -1
    const terminal = current?.events.findLast((event, index) => index > userIndex && userIndex >= 0 && event.type === 'turn/end')
    return terminal && current.durableThroughSeq >= Number(terminal.seq) ? current : undefined
  }, `${role} durable DSH turn/end`)
  const userEvents = session.events.filter(event => event.type === 'user/message' && JSON.stringify(event.data).includes(prompt))
  assert.equal(userEvents.length, 1, 'Each prompt must be recorded once')
  assert.equal(session.events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  assert.ok(session.events.some(event => event.type === 'assistant/message' && JSON.stringify(event.data).includes(marker)),
    `Missing scripted result ${marker}`)
  await workerSuccess(page, { action: 'flush-local' })
  return session
}

async function installPage(page, role) {
  page.on('pageerror', error => evidence.pageErrors.push({ role, message: error.message }))
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) evidence.console.push({ role, type: message.type(), text: message.text() })
  })
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.protocol.startsWith('http') && url.origin !== origin) evidence.externalRequests.push({ role, path: url.origin + url.pathname })
    if (!url.pathname.startsWith('/api/browser-native/')) return
    const body = request.headers()['content-type']?.includes('application/json') && request.postData() !== null
      ? request.postDataJSON() : {}
    const record = { role, path: url.pathname, method: request.method(), phase, status: undefined,
      sessionId: body?.sessionId, operationId: body?.operationId, baseRevision: body?.baseRevision,
      changes: body?.changes?.map(change => ({ path: change.path, hash: change.hash, bytes: change.bytes })),
      tools: body?.tools?.map(tool => tool.function?.name ?? tool.name).filter(Boolean).sort() }
    requests.push(record)
    requestRecords.set(request, record)
  })
  page.on('response', response => {
    const record = requestRecords.get(response.request())
    if (record !== undefined) record.status = response.status()
  })
  page.on('requestfailed', request => {
    const record = requestRecords.get(request)
    if (record !== undefined) record.failure = request.failure()?.errorText
  })
  await page.route(`${origin}${api}/commit`, async route => {
    if (role === 'owner' ? failOwnerCommits : failSuccessorCommits) {
      const record = requestRecords.get(route.request())
      if (record !== undefined) record.injected = true
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
        error: { code: 'E2E_LOCAL_WRITER_PENDING', message: 'Retain retry batch for local writer fencing validation' },
      }) })
    } else await route.continue()
  })
}

async function screenshot(page, role, suffix) {
  if (page === undefined || page.isClosed()) return
  const path = join(artifactDir, `${role}-${suffix}.png`)
  await bounded(() => page.screenshot({ path, timeout: cleanupTimeout }), `${role} screenshot`, cleanupTimeout, true)
  evidence.screenshots.push(path)
}

try {
  await checkpoint('setup', { resultFile })
  image = await bounded(() => createRuntimeValidationDist({ roster: 'browser' }), 'private validation image')
  app = await bounded(() => createBrowserNativeV2Server({ dataDir, distRoot: image.distRoot, llmMode: 'scripted' }), 'backend creation')
  origin = await bounded(() => app.listen(0), 'backend loopback listen')
  evidence.origin = origin
  browser = await bounded(() => chromium.launch({ headless: true, channel: 'chrome', timeout }), 'launch owned Chrome')
  evidence.browserVersion = browser.version()
  context = await bounded(() => browser.newContext({ locale: 'en-US', serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } }), 'isolated Chrome context')
  context.setDefaultTimeout(timeout)
  context.setDefaultNavigationTimeout(timeout)
  await context.addInitScript(() => {
    const state = { workers: [], calls: {} }
    Object.defineProperty(window, '__dshLocalWriterFencing', { value: state })
    window.Worker = new Proxy(window.Worker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args, target)
        state.workers.push({ worker, name: args[1]?.name, source: String(args[0]) })
        return worker
      },
    })
  })
  ownerPage = await bounded(() => context.newPage(), 'owner page')
  successorPage = await bounded(() => context.newPage(), 'successor page')
  await installPage(ownerPage, 'owner')
  await installPage(successorPage, 'successor')
  await bounded(() => ownerPage.goto(`${origin}${previewUrl}`, { waitUntil: 'domcontentloaded' }), 'owner navigation')
  await hostReady(ownerPage, 'owner Host ready')
  const initialStatus = await status(ownerPage, 'synced', undefined, 0)
  const workspaceId = initialStatus.workspaceId
  evidence.workspaceId = workspaceId
  await checkpoint('owner-host-ready')
  const ownerSession = await turn(ownerPage, 'owner', 'BROWSER_NATIVE_WORKSPACE_OBSERVER_OWNER_E2E',
    'BROWSER_NATIVE_WORKSPACE_OBSERVER_OWNER_DONE')
  const ownerLease = await workerSuccess(ownerPage, { action: 'lease-info' })
  evidence.owner = { fencingToken: ownerLease.fencingToken, session: sessionSummary(ownerSession) }
  assert.equal(evidence.owner.session.receipts.length, 1)
  await status(ownerPage, 'synced', workspaceId, 1)
  await checkpoint('owner-retry')
  failOwnerCommits = true
  await workerSuccess(ownerPage, { action: 'write', path: workspaceRoot + transferredPath, content: transferredContent })
  const failedOwnerFlush = await workerRequest(ownerPage, { action: 'flush-workspace' })
  assert.equal(failedOwnerFlush.ok, false, 'The injected cloud failure must retain local retry data')
  const ownerRetry = await storageAudit(ownerPage, workspaceId)
  const ownerControl = writerControl(ownerRetry, workspaceId)
  evidence.owner.control = ownerControl
  const transferredOperation = ownerRetry.metadata?.retryBatch?.operationId
  assert.equal(typeof transferredOperation, 'string')
  assertStoredBytes(ownerRetry, transferredPath, transferredContent)
  assert.ok(requests.some(item => item.role === 'owner' && item.operationId === transferredOperation && item.status === 503))
  evidence.transferredOperation = transferredOperation
  await checkpoint('observer-start')
  await bounded(() => successorPage.goto(`${origin}/api/browser-native/health`, { waitUntil: 'domcontentloaded' }), 'observer same-origin navigation')
  await bounded(() => successorPage.evaluate(() => localStorage.removeItem('dsh.sessions.current')), 'independent Session selection')
  await bounded(() => successorPage.goto(`${origin}${previewUrl}`, { waitUntil: 'domcontentloaded' }), 'observer navigation')
  await hostReady(successorPage, 'observer complete Host ready')
  await status(successorPage, 'read-only', workspaceId, 1)
  assert.equal((await workerRequest(successorPage, { action: 'lease-info' })).accessMode, 'observer')
  assert.deepEqual(await storageAudit(successorPage, workspaceId), ownerRetry, 'Observer boot must not mutate shared dirty data')
  const observerSession = await turn(successorPage, 'successor', 'BROWSER_NATIVE_WORKSPACE_OBSERVER_READ_E2E',
    'BROWSER_NATIVE_WORKSPACE_OBSERVER_READ_DONE')
  assert.notEqual(observerSession.id, ownerSession.id)
  assert.equal(sessionSummary(observerSession).receipts.length, 0)
  const observerModel = requests.find(item => item.role === 'successor' && item.path.endsWith('/llm'))
  assert.deepEqual(observerModel.tools.filter(name => ['read', 'grep', 'glob', 'write', 'edit', 'bash'].includes(name)), ['glob', 'grep', 'read'])
  assert.equal((await workerRequest(successorPage, { action: 'read', path: workspaceRoot + transferredPath })).ok, false)
  assert.deepEqual(await storageAudit(successorPage, workspaceId), ownerRetry, 'Observer DSH read must preserve retry and owner control data')
  await checkpoint('queue-old-local-persist')
  await workerSuccess(ownerPage, { action: 'pause-local-save', stage: 'before' })
  await bounded(() => ownerPage.evaluate(({ path, content }) => {
    const record = { state: 'pending' }
    window.__dshLocalWriterFencing.calls.queued = record
    window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__({ action: 'write', path, content }).then(
      value => { record.state = 'fulfilled'; record.value = value },
      error => { record.state = 'rejected'; record.error = String(error) },
    )
  }, { path: workspaceRoot + queuedPath, content: queuedContent }), 'start old queued write without awaiting its barrier')
  await poll(async () => (await workerRequest(ownerPage, { action: 'local-save-state' })).stage === 'before', 'old local persist reaches before barrier')
  assert.equal(await ownerPage.evaluate(() => window.__dshLocalWriterFencing.calls.queued.state), 'pending')
  assert.deepEqual(await storageAudit(ownerPage, workspaceId), ownerRetry, 'The paused write must not yet publish bytes or metadata')
  await checkpoint('release-and-takeover')
  await workerSuccess(ownerPage, { action: 'release-lease' })
  evidence.releasedRequestIndex = requests.length
  assert.equal((await workerRequest(ownerPage, { action: 'local-save-state' })).stage, 'before')
  await bounded(() => successorPage.locator('[data-browser-native-workspace-refresh]').click(), 'explicit observer refresh')
  await hostReady(successorPage, 'successor complete Host ready after refresh', false)
  await status(successorPage, 'synced', workspaceId, 2)
  const successorLease = await workerSuccess(successorPage, { action: 'lease-info' })
  assert.ok(successorLease.fencingToken > ownerLease.fencingToken, 'Takeover must advance remote fencing')
  assert.equal(successorLease.accessMode, 'writer')
  assert.equal(await ownerPage.evaluate(() => window.__dshLocalWriterFencing.calls.queued.state), 'pending',
    'The old persistence must overlap the complete successor Host takeover')
  const transferredCommits = requests.filter(item => item.path === `${api}/commit` && item.operationId === transferredOperation && item.status === 200)
  assert.equal(transferredCommits.length, 1, 'The original retry operation must commit exactly once')
  assert.equal(transferredCommits[0].role, 'successor')
  assert.equal((await workerSuccess(successorPage, { action: 'read', path: workspaceRoot + transferredPath })).content, transferredContent)
  const successorSession = await turn(successorPage, 'successor', 'BROWSER_NATIVE_WORKSPACE_OBSERVER_AFTER_REFRESH_E2E',
    'BROWSER_NATIVE_WORKSPACE_OBSERVER_AFTER_REFRESH_DONE', observerSession.id)
  assert.equal(successorSession.id, observerSession.id)
  assert.equal(sessionSummary(successorSession).receipts.length, 1)
  await status(successorPage, 'synced', workspaceId, 3)
  evidence.successor = { fencingToken: successorLease.fencingToken, session: sessionSummary(successorSession) }
  await checkpoint('successor-protected-retry')
  failSuccessorCommits = true
  await workerSuccess(successorPage, { action: 'write', path: workspaceRoot + successorPath, content: successorContent })
  assert.equal((await workerRequest(successorPage, { action: 'flush-workspace' })).ok, false)
  const protectedAudit = await storageAudit(successorPage, workspaceId)
  const successorControl = writerControl(protectedAudit, workspaceId)
  assert.ok(successorControl.writerEpoch > ownerControl.writerEpoch, 'The successor must advance the local writer epoch')
  assert.notEqual(successorControl.writerId, ownerControl.writerId)
  assert.ok(successorControl.generation > ownerControl.generation, 'Successor writes must advance the atomic generation')
  evidence.successor.control = successorControl
  assertStoredBytes(protectedAudit, successorPath, successorContent)
  const successorOperation = protectedAudit.metadata?.retryBatch?.operationId
  assert.equal(typeof successorOperation, 'string')
  assert.notEqual(successorOperation, transferredOperation)
  assert.equal(protectedAudit.files.some(file => file.name === hashBytes(queuedContent)), false)
  evidence.protectedAudit = protectedAudit
  evidence.successorOperation = successorOperation
  await checkpoint('resume-fenced-old-persist')
  await workerSuccess(ownerPage, { action: 'release-local-save' })
  const queued = await poll(async () => {
    const current = await ownerPage.evaluate(() => window.__dshLocalWriterFencing.calls.queued)
    return current.state === 'pending' ? undefined : current
  }, 'old queued local persist explicitly settles after release')
  assert.equal(queued.state, 'fulfilled', JSON.stringify(queued))
  assert.equal(queued.value?.ok, false, 'The stale queued persistence must fail')
  assert.match(queued.value.error, /local writer|local.*owner|LOCAL_WRITER_LOST|writer lease was (released|lost)/i,
    'Reject for revoked writer ownership, not only changed snapshot contents')
  evidence.queuedOutcome = queued
  assert.equal((await workerRequest(ownerPage, { action: 'flush-local' })).ok, false)
  assert.equal((await workerRequest(ownerPage, { action: 'flush-workspace' })).ok, false)
  assert.deepEqual(await storageAudit(successorPage, workspaceId), protectedAudit,
    'A fenced queued save must preserve every successor control record, pending/retry/receipt, and OPFS byte')
  await workerSuccess(ownerPage, { action: 'release-lease' })
  assert.deepEqual(await storageAudit(successorPage, workspaceId), protectedAudit, 'A repeated old release must not invalidate the successor')
  assert.equal((await workerSuccess(successorPage, { action: 'lease-info' })).fencingToken, successorLease.fencingToken)
  assert.equal(requests.slice(evidence.releasedRequestIndex).filter(item => item.role === 'owner' && item.path === `${api}/commit`).length, 0,
    'The released Host must not send a late commit')
  await checkpoint('successor-final-commit')
  failSuccessorCommits = false
  await workerSuccess(successorPage, { action: 'flush-workspace' })
  await status(successorPage, 'synced', workspaceId, 4)
  const finalManifest = await manifest(successorPage, workspaceId)
  assert.equal(finalManifest.revision, 4)
  assert.equal(finalManifest.entries.some(entry => entry.path === queuedPath), false)
  for (const [path, content] of [[transferredPath, transferredContent], [successorPath, successorContent]]) {
    const entry = finalManifest.entries.find(candidate => candidate.path === path)
    assert.equal(entry?.hash, hashBytes(content))
    assert.equal(entry?.bytes, Buffer.byteLength(content))
  }
  const finalAudit = await storageAudit(successorPage, workspaceId)
  assert.deepEqual(finalAudit.metadata.pending, [])
  assert.equal(finalAudit.metadata.retryBatch, undefined)
  assert.equal(finalAudit.files.some(file => file.name === hashBytes(queuedContent)), false)
  const commits = requests.filter(item => item.path === `${api}/commit` && item.status === 200)
  assert.equal(commits.length, 4)
  assert.equal(new Set(commits.map(item => item.operationId)).size, 4)
  assert.equal(commits.filter(item => item.operationId === successorOperation).length, 1)
  evidence.sessions = [ownerSession.id, successorSession.id].map(sessionId => sessionSummary(app.store.get(sessionId)))
  assert.deepEqual(evidence.sessions.map(session => session.receipts.length), [1, 1])
  assert.deepEqual(evidence.pageErrors, [])
  assert.deepEqual(evidence.externalRequests, [])
  assert.ok(requests.filter(item => item.path.endsWith('/llm')).every(item => item.status === 200))
  evidence.finalManifest = finalManifest
  evidence.finalAudit = finalAudit
  await screenshot(ownerPage, 'owner', 'final')
  await screenshot(successorPage, 'successor', 'final')
  evidence.result = 'passed'
  await checkpoint('assertions-passed')
} catch (error) {
  evidence.result = 'failed'
  evidence.failure = { phase, message: error.message, stack: error.stack }
  process.exitCode = 1
  process.stderr.write(`${JSON.stringify({ failure: evidence.failure, artifactDir })}\n`)
  await writeFile(resultFile, `${JSON.stringify(evidence, null, 2)}\n`)
  for (const [page, role] of [[ownerPage, 'owner'], [successorPage, 'successor']]) {
    try {
      await screenshot(page, role, 'failure')
      if (page !== undefined && !page.isClosed()) {
        evidence[`${role}FailureState`] = await bounded(() => page.evaluate(async () => ({
          status: window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__ ?? null,
          locks: navigator.locks === undefined ? null : await navigator.locks.query(),
          bodyText: document.body.innerText.slice(0, 6000),
          textboxes: [...document.querySelectorAll('[role="textbox"], [contenteditable]')].map(element => ({
            role: element.getAttribute('role'), label: element.getAttribute('aria-label'),
            editable: element.getAttribute('contenteditable'), placeholder: element.getAttribute('data-placeholder'),
          })),
          workers: window.__dshLocalWriterFencing?.workers.map(record => ({ name: record.name, source: record.source })),
          queued: window.__dshLocalWriterFencing?.calls.queued,
          audit: window.__dshLocalWriterFencing?.audit,
        })), `${role} failure state`, cleanupTimeout, true)
      }
    } catch (captureError) {
      evidence.cleanupErrors.push({ resource: `${role} diagnostics`, message: captureError.message })
    }
  }
} finally {
  for (const [page, role] of [[ownerPage, 'owner'], [successorPage, 'successor']]) {
    if (page === undefined || page.isClosed()) continue
    try {
      await bounded(() => page.evaluate(() => {
        for (const record of window.__dshLocalWriterFencing?.workers ?? []) record.worker.terminate()
      }), `${role} terminate owned Workers`, cleanupTimeout, true)
    } catch (error) {
      evidence.cleanupErrors.push({ resource: `${role} Workers`, message: error.message })
    }
  }
  for (const [resource, dispose] of [
    ['browser', async () => await browser?.close()],
    ['backend', async () => await app?.close()],
    ['validation image', async () => await image?.cleanup()],
  ]) {
    try {
      await bounded(dispose, `close ${resource}`, resource === 'browser' ? timeout : cleanupTimeout, true)
    } catch (error) {
      evidence.cleanupErrors.push({ resource, message: error.message })
    }
  }
  if (evidence.cleanupErrors.length > 0) {
    evidence.result = 'failed'
    process.exitCode = 1
  }
  evidence.elapsedMs = Math.round(performance.now() - startedAt)
  await writeFile(resultFile, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ result: evidence.result, resultFile, artifactDir, dataDir,
    elapsedMs: evidence.elapsedMs, failure: evidence.failure?.message, cleanupErrors: evidence.cleanupErrors })}\n`)
}
