/**
 * Hosted deployment smoke.
 *
 * Starts the documented single command against a fresh data directory, checks
 * the local auth gate, opens the printed handshake URL in Chrome, waits for the
 * Workspace sync, stops the process, and runs the upgrade compatibility check on
 * the data it created.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { openPreview } from './runtime-test-support.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const START = join(REPO_ROOT, 'docs/drafts/browser-native-dsh-poc/hosted/start-hosted.mjs')
const CHECK = join(REPO_ROOT, 'docs/drafts/browser-native-dsh-poc/hosted/check-data.mjs')
const DIST_ROOT = join(REPO_ROOT, 'apps/web/dist')
const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const dataDir = resolve(process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-hosted-deployment-')))
const childEnv = {
  ...process.env,
  DSH_POC_HOST: '127.0.0.1',
  DSH_POC_PORT: '0',
  DSH_POC_DATA_DIR: dataDir,
  DSH_POC_DIST_ROOT: DIST_ROOT,
  DSH_POC_BUILD: '0',
  DSH_POC_LLM: 'scripted',
  DSH_POC_INPUT_USD_PER_1M: '1',
  DSH_POC_OUTPUT_USD_PER_1M: '2',
  DSH_POC_ALERT_FAILURE_RATIO: '0.5',
  DSH_POC_ALERT_FAILURE_MIN_SAMPLES: '100',
  DSH_POC_ALERT_QUEUE_BACKLOG: '6',
  DSH_POC_ALERT_BUDGET_USD: '5',
}
for (const name of ['DSH_POC_ALERT_FAILURE_WINDOW', 'DSH_POC_ALERT_WEBHOOK_URL', 'DSH_POC_ALERT_INTERVAL_MS']) {
  delete childEnv[name]
}
for (const name of ['DSH_POC_HOSTED_ISSUER', 'DSH_POC_HOSTED_AUDIENCE', 'DSH_POC_HOSTED_SECRET',
  'DSH_POC_STATE_AUTHORITY_ORIGIN', 'DSH_POC_STATE_AUTHORITY_TOKEN']) {
  delete childEnv[name]
}

/** Start the documented command and wait for its printed ready URL. */
function startHosted() {
  const stdout = []
  const stderr = []
  const child = spawn(process.execPath, [START], { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => stdout.push(String(chunk)))
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  const ready = new Promise((resolveReady, rejectReady) => {
    const deadline = setTimeout(() => {
      rejectReady(new Error(`hosted startup timed out\nstdout:\n${stdout.join('')}\nstderr:\n${stderr.join('')}`))
    }, 30_000)
    child.stdout.on('data', () => {
      const text = stdout.join('')
      const match = text.match(/^hosted: ready at (http:\/\/\S+)$/m)
      const preview = text.match(/^hosted: preview (\S+)$/m)
      if (match !== null && preview !== null) {
        clearTimeout(deadline)
        resolveReady({ origin: match[1], previewUrl: preview[1] })
      }
    })
    child.once('exit', code => {
      clearTimeout(deadline)
      rejectReady(new Error(`hosted startup exited with ${String(code)}\nstdout:\n${stdout.join('')}\nstderr:\n${stderr.join('')}`))
    })
  })
  return { child, ready, stdout, stderr }
}

/** Stop the child and require a clean exit. */
async function stopHosted(child) {
  const exited = new Promise(resolveExit => child.once('exit', code => resolveExit(code)))
  child.kill('SIGTERM')
  const code = await Promise.race([
    exited,
    new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error('hosted process did not exit after SIGTERM')), 15_000)),
  ])
  assert.equal(code, 0, 'the hosted process must exit cleanly on SIGTERM')
}

const started = startHosted()
let browser
try {
  const { origin, previewUrl } = await started.ready
  const token = new URL(previewUrl).searchParams.get('token')
  assert.ok(token, 'the printed handshake URL carries the local auth token')

  const tokenHeader = { 'x-browser-native-auth': token }
  const health = await fetch(`${origin}/api/browser-native/health`, { headers: tokenHeader })
  const healthText = await health.text()
  assert.equal(health.status, 200, healthText)
  const healthBody = JSON.parse(healthText)
  assert.equal(healthBody.ok, true)
  assert.equal(healthBody.llmMode, 'scripted')
  assert.ok(started.stdout.join('').includes('hosted: alerts failure-rate ≥0.5, queue ≥6, budget $5'),
    'the readiness output must report the configured alert thresholds')

  const alerts = await fetch(`${origin}/api/browser-native/observability/alerts`, { headers: tokenHeader })
  const alertText = await alerts.text()
  assert.equal(alerts.status, 200, alertText)
  const alertBody = JSON.parse(alertText)
  assert.equal(alertBody.enabled, true)
  assert.equal(alertBody.thresholds.failureRate.ratio, 0.5)
  assert.equal(alertBody.thresholds.queueBacklog.queuedTurns, 6)
  assert.equal(alertBody.thresholds.budgetUsd, 5)
  assert.equal(alertBody.window.failures, 0)
  assert.deepEqual(alertBody.active, [])

  const ungated = await fetch(`${origin}/api/browser-native/health`)
  assert.equal(ungated.status, 401, 'the API must reject requests without the local process token')

  const handshake = await fetch(previewUrl, { redirect: 'manual' })
  assert.equal(handshake.status, 302)
  const location = handshake.headers.get('location')
  assert.ok(location?.startsWith('/preview.html'), `handshake must redirect to the preview, got ${String(location)}`)
  const authCookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
  assert.ok(authCookie.startsWith('dsh-browser-native-auth='), 'handshake must set the local auth cookie')

  const identity = await fetch(`${origin}/api/browser-native/workspace/identity`, {
    headers: { ...tokenHeader, cookie: authCookie, 'x-browser-native-identity-mode': 'existing' },
  })
  assert.equal(identity.status, 401, 'an existing-identity probe without a principal cookie must not mint one')

  const tokenFile = join(dataDir, 'browser-native-auth-token')
  assert.ok(existsSync(tokenFile), 'the local auth token file must be written')
  const mode = (await stat(tokenFile)).mode & 0o777
  assert.equal(mode, 0o600, 'the local auth token file must be owner-only')

  browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  const context = await browser.newContext({ locale: 'en-US' })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await openPreview(page, previewUrl)
  await page.waitForFunction(
    () => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.state === 'synced',
    undefined,
    { timeout: 60_000 },
  )
  const workspaceId = await page.evaluate(() => window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__?.workspaceId)
  assert.ok(workspaceId, 'the preview must report its Workspace identity after sync')
  assert.deepEqual(pageErrors, [], 'the preview must load without page errors')

  await stopHosted(started.child)
  assert.ok(!existsSync(join(dataDir, '.browser-native-backend.lock')), 'the backend lock must be removed on shutdown')
  const workspaces = await readdir(join(dataDir, 'workspace-v2', 'workspaces'))
  assert.ok(workspaces.some(name => name === `${workspaceId}.json`), 'the synced Workspace metadata must exist')

  const check = spawnSync(process.execPath, [CHECK, '--data-dir', dataDir, '--json'], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr || check.stdout)
  const report = JSON.parse(check.stdout)
  assert.equal(report.compatible, true)
  assert.equal(report.lock.present, false)
  assert.equal(report.workspaces.total, workspaces.length)

  process.stdout.write(`hosted-deployment-smoke: PASS dataDir=${dataDir} workspace=${workspaceId} sessions=${String(report.sessions.total)} workspaces=${String(report.workspaces.total)}\n`)
} finally {
  await browser?.close()
  if (started.child.exitCode === null && started.child.signalCode === null) started.child.kill('SIGKILL')
  if (process.env.DSH_POC_KEEP_DATA !== '1') await rm(dataDir, { recursive: true, force: true })
}
