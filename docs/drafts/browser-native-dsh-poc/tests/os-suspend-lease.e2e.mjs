import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createBrowserNativeV2Server } from '../backend-v2.mjs'
import { createRuntimeValidationDist } from '../runtime-validation.mjs'
import { waitFor } from './runtime-test-support.mjs'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright')
const playwright = await import(playwrightPath)
const playwrightModule = playwright.default ?? playwright
const { chromium } = playwrightModule
const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-os-suspend-')))
const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-os-suspend-chrome-'))
const leaseDurationMs = 4_000
const pageErrors = []
const leaseTraffic = []
let image
let app
let context
let page
let frozenPids = []

/**
 * List Chrome processes belonging to this Playwright launch and their parent links.
 * @returns {Array<{ pid: number, ppid: number, command: string }>} Parsed process table.
 */
function chromeProcesses() {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  return output.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }]
  })
}

/**
 * Find renderer processes under the browser process that owns this user-data directory.
 * Renderers host the page and its Dedicated Worker, so SIGSTOP on them freezes all page-side timers.
 * @returns {number} Browser process id chosen for this launch.
 */
function browserProcessId() {
  const processes = chromeProcesses()
  const browser = processes.find(process => process.command.includes(`--user-data-dir=${userDataDir}`) && !process.command.includes('--type='))
  assert.ok(browser, `Chrome browser process for ${userDataDir} was not found`)
  return browser.pid
}

function rendererProcessIds(rootPid) {
  const processes = chromeProcesses()
  const children = new Map()
  for (const process of processes) children.set(process.ppid, [...(children.get(process.ppid) ?? []), process])
  const descendants = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const child of children.get(current) ?? []) {
      descendants.push(child)
      queue.push(child.pid)
    }
  }
  return descendants.filter(process => process.command.includes('--type=renderer')).map(process => process.pid)
}

function leaseRequest(origin, cookie, body) {
  return fetch(`${origin}/api/browser-native/workspace/lease`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), ...body }),
  }).then(async response => ({ status: response.status, body: await response.json() }))
}

try {
  image = await createRuntimeValidationDist({ roster: 'original' })
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: 'scripted',
    testHooks: { workspaceWriterLeaseMs: leaseDurationMs },
  })
  const origin = await app.listen(0)
  context = await chromium.launchPersistentContext(userDataDir, { locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page = context.pages()[0] ?? await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (!request.url().endsWith('/api/browser-native/workspace/lease')) return
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    leaseTraffic.push({ operation: body?.operation, at: Date.now() })
  })
  await page.goto(`${origin}/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&browser-native-test=workspace-recovery&preview-fixture=none`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 45_000 })
  const firstLease = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__({ action: 'lease-info' }))
  assert.equal(firstLease.ok, true, JSON.stringify(firstLease))
  assert.equal(firstLease.renewalScheduled, true)
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.equal(typeof workspaceId, 'string', `lease-info must expose a workspace: ${JSON.stringify(firstLease)}`)
  const cookie = (await context.cookies(`${origin}/api/browser-native/workspace`)).find(item => item.name === 'dsh-browser-native-principal')
  assert.ok(cookie, 'the browser must hold the Workspace principal cookie')

  const rootPid = browserProcessId()
  frozenPids = rendererProcessIds(rootPid)
  assert.ok(frozenPids.length > 0, 'at least one renderer process must host the page')
  const frozenAt = Date.now()
  for (const pid of frozenPids) process.kill(pid, 'SIGSTOP')
  await new Promise(resolveDelay => setTimeout(resolveDelay, leaseDurationMs + 2_000))
  const staleRenew = await leaseRequest(origin, `dsh-browser-native-principal=${cookie.value}`, {
    workspaceId, operation: 'renew', writerToken: firstLease.writerToken, fencingToken: firstLease.fencingToken,
  })
  assert.equal(staleRenew.status, 409, JSON.stringify(staleRenew))
  assert.equal(staleRenew.body.error.code, 'WORKSPACE_OWNERSHIP_LOST')
  const takeover = await leaseRequest(origin, `dsh-browser-native-principal=${cookie.value}`, { workspaceId, operation: 'claim' })
  assert.equal(takeover.status, 200, JSON.stringify(takeover))
  assert.ok(takeover.body.fencingToken > firstLease.fencingToken)
  const release = await leaseRequest(origin, `dsh-browser-native-principal=${cookie.value}`, {
    workspaceId, operation: 'release', writerToken: takeover.body.writerToken, fencingToken: takeover.body.fencingToken,
  })
  assert.equal(release.status, 200, JSON.stringify(release))
  const frozenDurationMs = Date.now() - frozenAt

  const renewalsBeforeResume = leaseTraffic.filter(item => item.operation === 'renew' && item.at > frozenAt).length
  for (const pid of frozenPids) process.kill(pid, 'SIGCONT')
  const resumedAt = Date.now()
  await page.waitForFunction(() => {
    const status = window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__
    return status?.state === 'error' || status?.state === 'lease-conflict'
  }, undefined, { timeout: 30_000 })
  const resumedStatus = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__)
  const lostLease = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__({ action: 'lease-info' }))
  let writeAfterResume
  try {
    writeAfterResume = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__({
      action: 'write', path: '/dsh/home/workspace/os-suspend.txt', content: 'must not persist\n',
    }))
  } catch (error) {
    writeAfterResume = { ok: false, rejected: error instanceof Error ? error.message : String(error) }
  }
  const renewalsAfterResume = leaseTraffic.filter(item => item.operation === 'renew' && item.at > resumedAt).length

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced', undefined, { timeout: 45_000 })
  const recoveredLease = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__({ action: 'lease-info' }))
  assert.equal(recoveredLease.ok, true, JSON.stringify(recoveredLease))
  assert.ok(recoveredLease.fencingToken > takeover.body.fencingToken)
  const recoveredWrite = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_TEST__({
    action: 'write', path: '/dsh/home/workspace/os-suspend.txt', content: 'persisted after reload\n',
  }))
  assert.equal(recoveredWrite.ok, true, JSON.stringify(recoveredWrite))

  assert.equal(resumedStatus.state, 'error')
  assert.ok(/writer lease was lost/.test(resumedStatus.message ?? ''), JSON.stringify(resumedStatus))
  assert.equal(lostLease.ok, false, JSON.stringify(lostLease))
  assert.equal(writeAfterResume.ok, false, JSON.stringify(writeAfterResume))
  assert.deepEqual(pageErrors, [])
  process.stdout.write(`${JSON.stringify({
    result: 'passed',
    scope: 'renderer-process-suspension-beyond-writer-lease-ttl',
    leaseDurationMs,
    frozenDurationMs,
    frozenRendererCount: frozenPids.length,
    staleRenewStatus: staleRenew.status,
    staleRenewCode: staleRenew.body.error.code,
    takeoverClaimStatus: takeover.status,
    takeoverFencingToken: takeover.body.fencingToken,
    releaseAfterTakeover: release.status,
    renewalsSentDuringFreeze: renewalsBeforeResume,
    renewalsSentAfterResume: renewalsAfterResume,
    resumedWorkspaceState: resumedStatus.state,
    resumedWorkspaceMessage: resumedStatus.message,
    writerLeaseAfterResume: lostLease,
    writeAfterResume,
    reloadFencingToken: recoveredLease.fencingToken,
    writeAfterReload: recoveredWrite.content,
    pageErrors,
    note: 'SIGSTOP on the Chrome renderer process simulates OS-level suspension of page-side timers. The backend clock keeps running, so the lease expires as it would while the machine sleeps.',
  })}\n`)
} finally {
  for (const pid of frozenPids) {
    try { process.kill(pid, 'SIGCONT') } catch { /* the process already exited */ }
  }
  await context?.close().catch(() => {})
  await app?.close()
  await image?.cleanup()
  if (process.env.DSH_POC_DATA_DIR === undefined) await rm(dataDir, { recursive: true, force: true })
  await rm(userDataDir, { recursive: true, force: true })
}
