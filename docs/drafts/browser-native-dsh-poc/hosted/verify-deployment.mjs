#!/usr/bin/env node

/**
 * Verify the hosted deployment forms documented in hosted-deployment.md.
 *
 * `container` builds the image from hosted/Dockerfile, starts it against a fresh
 * data volume, exercises the auth gate and a browser turn, stops it, runs the
 * read-only upgrade check, and restarts on the same volume.
 *
 * `tls` starts the same image behind hosted/nginx/browser-native-dsh.conf with a
 * self-signed certificate, then asserts the forwarded Host and Origin are
 * admitted, a foreign Origin is refused, the local auth cookie is Secure, and
 * the preview still syncs through https.
 *
 * `systemd` runs `systemd-analyze verify` on the shipped unit inside a Linux
 * container. Runtime unit verification needs systemd as PID 1 and is reported as
 * unverified when the host cannot provide it.
 *
 * Usage:
 *   node docs/drafts/browser-native-dsh-poc/hosted/verify-deployment.mjs \
 *     [--forms container,tls,nginx,systemd] [--image <tag>] [--skip-build] [--keep]
 *
 * Environment:
 *   DSH_POC_NODE_IMAGE  Override the Dockerfile NODE_IMAGE base (mirrors in
 *                       network-restricted environments)
 *   DSH_POC_NGINX_IMAGE nginx image for the TLS form (default: nginx:alpine)
 *   DSH_POC_BROWSER     Chrome channel for the browser assertion (default: chrome)
 *   DSH_POC_PLAYWRIGHT_MODULE  Playwright module path override
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openPreview } from '../tests/runtime-test-support.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../../../')
const DOCKERFILE = join(HERE, 'Dockerfile')
const UNIT = join(HERE, 'systemd/browser-native-dsh.service')
const UNIT_ENV = join(HERE, 'systemd/browser-native-dsh.env.example')
const NGINX_CONF = join(HERE, 'nginx/browser-native-dsh.conf')
const CHECK_DATA = '/app/docs/drafts/browser-native-dsh-poc/hosted/check-data.mjs'
const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright

const options = {
  forms: ['container', 'tls', 'systemd'],
  image: 'browser-native-dsh:poc-local',
  skipBuild: false,
  keep: process.env.DSH_POC_KEEP_DATA === '1',
}
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index]
  if (argument === '--forms') options.forms = process.argv[++index].split(',').map(form => form.trim())
  else if (argument === '--image') options.image = process.argv[++index]
  else if (argument === '--skip-build') options.skipBuild = true
  else if (argument === '--keep') options.keep = true
  else throw new Error(`unknown argument ${argument}; see the module comment for usage`)
}
for (const form of options.forms) {
  if (!['container', 'tls', 'systemd'].includes(form)) throw new Error(`unknown form ${form}`)
}

/** Run docker and fail with its stderr when the command fails. */
function docker(args, settings = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', ...settings })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed\n${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

/** Poll an assertion until it holds or the deadline expires. */
async function waitFor(check, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (error) {
      lastError = error
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
  }
  throw new Error(`timed out waiting for ${description}${lastError === undefined ? '' : `: ${lastError.message}`}`)
}

/** Read the local auth token from a container-managed data volume. */
function tokenFromVolume(image, volume) {
  return docker(['run', '--rm', '-v', `${volume}:/data`, '--entrypoint', 'node', image, '-e',
    'process.stdout.write(require("node:fs").readFileSync("/data/browser-native-auth-token", "utf8"))'])
}

/** Report whether the backend lock exists inside a stopped volume. */
function lockPresentInVolume(image, volume) {
  const output = docker(['run', '--rm', '-v', `${volume}:/data`, '--entrypoint', 'node', image, '-e',
    'process.stdout.write(String(require("node:fs").existsSync("/data/.browser-native-backend.lock")))'])
  return output === 'true'
}

/** Run the read-only upgrade check inside the image against a volume. */
function checkDataInVolume(image, volume) {
  const result = spawnSync('docker', ['run', '--rm', '-v', `${volume}:/data`, '--entrypoint', 'node', image,
    CHECK_DATA, '--data-dir', '/data', '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 0, `check-data must report a compatible directory\n${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout)
}

/** Accumulate PASS / FAIL / UNVERIFIED outcomes for the final summary. */
const outcomes = []
async function form(name, body) {
  try {
    await body()
    outcomes.push({ name, verdict: 'PASS' })
    process.stdout.write(`deployment-verify: PASS ${name}\n`)
  } catch (error) {
    outcomes.push({ name, verdict: 'FAIL', detail: error.message })
    process.stdout.write(`deployment-verify: FAIL ${name}: ${error.message}\n`)
  }
}

/** Build the image once unless the caller already did. */
async function buildImage() {
  if (options.skipBuild) return
  const buildArgs = ['build', '-f', DOCKERFILE, '-t', options.image]
  if (process.env.DSH_POC_NODE_IMAGE !== undefined) buildArgs.push('--build-arg', `NODE_IMAGE=${process.env.DSH_POC_NODE_IMAGE}`)
  buildArgs.push('.')
  process.stdout.write(`deployment-verify: building ${options.image}\n`)
  docker(buildArgs, { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
}

/** Assert the preview syncs in Chrome and returns its Workspace id. */
async function assertBrowserSync(previewUrl, ignoreHTTPSErrors) {
  const browser = await chromium.launch({ headless: true, channel: process.env.DSH_POC_BROWSER ?? 'chrome' })
  try {
    const context = await browser.newContext({ locale: 'en-US', ignoreHTTPSErrors })
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
    return workspaceId
  } finally {
    await browser.close()
  }
}

/** Assert the local auth gate on an origin that serves the API. */
async function assertAuthGate(origin, token) {
  const ungated = await fetch(`${origin}/api/browser-native/health`)
  assert.equal(ungated.status, 401, 'the API must reject requests without the local process token')
  const health = await fetch(`${origin}/api/browser-native/health`, { headers: { 'x-browser-native-auth': token } })
  const text = await health.text()
  assert.equal(health.status, 200, text)
  const body = JSON.parse(text)
  assert.equal(body.ok, true)
  assert.equal(body.llmMode, 'scripted')
}

/** Send an HTTPS request with the self-signed certificate ignored. */
function proxiedRequest(url, headers) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(url, { headers, rejectUnauthorized: false }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(String(chunk)))
      response.on('end', () => resolveRequest({
        status: response.statusCode,
        headers: response.headers,
        body: chunks.join(''),
      }))
    })
    request.once('error', rejectRequest)
    request.end()
  })
}

/** Build the preview handshake URL for a token and origin. */
function handshakeUrl(origin, token) {
  const next = '/preview.html?browser-native=1&browser-native-durable=1&browser-native-durable-turn=1&preview-fixture=none'
  return `${origin}/auth/handshake?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`
}

if (options.forms.includes('container')) await form('container image', async () => {
  await buildImage()
  const volume = `dsh-deploy-verify-${Date.now()}`
  const name = `dsh-deploy-verify-${Date.now()}`
  docker(['volume', 'create', volume])
  try {
    docker(['run', '-d', '--name', name, '-p', '127.0.0.1::4185', '-v', `${volume}:/data`, options.image])
    const port = Number(docker(['port', name, '4185']).split(':').pop())
    const origin = `http://127.0.0.1:${String(port)}`
    await waitFor(async () => (await fetch(`${origin}/api/browser-native/health`)).status === 401, 'the container health gate')
    const logs = docker(['logs', name])
    assert.match(logs, /^hosted: ready at http:\/\/0\.0\.0\.0:4185$/m, 'the container must print its listen origin')
    assert.match(logs, /^hosted: admission ≤8 concurrent turns, ≤16 mounted Sessions$/m)

    await waitFor(() => tokenFromVolume(options.image, volume).length > 0, 'the local auth token file')
    const token = tokenFromVolume(options.image, volume).trim()
    assert.equal(token.length, 43, 'the local auth token must be 32 random bytes in base64url')
    await assertAuthGate(origin, token)

    const handshake = await fetch(handshakeUrl(origin, token), { redirect: 'manual' })
    assert.equal(handshake.status, 302)
    assert.ok((handshake.headers.get('location') ?? '').startsWith('/preview.html'))
    const cookie = (handshake.headers.get('set-cookie') ?? '')
    assert.ok(cookie.startsWith('dsh-browser-native-auth='), 'handshake must set the local auth cookie')
    assert.ok(!cookie.includes('; Secure'), 'a plain-http container must not mark the cookie Secure')

    const workspaceId = await assertBrowserSync(handshakeUrl(origin, token), false)

    docker(['stop', '--time', '20', name])
    const exitCode = Number(docker(['inspect', '--format', '{{.State.ExitCode}}', name]))
    assert.equal(exitCode, 0, 'SIGTERM must exit the container cleanly')
    assert.equal(lockPresentInVolume(options.image, volume), false, 'the backend lock must be removed on shutdown')
    const report = checkDataInVolume(options.image, volume)
    assert.equal(report.compatible, true)
    assert.equal(report.lock.present, false)
    assert.ok(report.workspaces.total >= 1, 'the browser turn must persist Workspace metadata')
    assert.match(docker(['run', '--rm', '-v', `${volume}:/data`, '--entrypoint', 'sh', options.image,
      '-c', `test -f /data/workspace-v2/workspaces/${workspaceId}.json && echo present`]), /present/)

    docker(['rm', name])
    docker(['run', '-d', '--name', name, '-p', '127.0.0.1::4185', '-v', `${volume}:/data`, options.image])
    const restartPort = Number(docker(['port', name, '4185']).split(':').pop())
    const restartOrigin = `http://127.0.0.1:${String(restartPort)}`
    await waitFor(async () => (await fetch(`${restartOrigin}/api/browser-native/health`)).status === 401, 'the restarted container')
    await assertAuthGate(restartOrigin, tokenFromVolume(options.image, volume).trim())
    docker(['stop', '--time', '20', name])
    process.stdout.write(`deployment-verify: container data volume=${volume} workspace=${workspaceId} sessions=${String(report.sessions.total)}\n`)
  } finally {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' })
    if (!options.keep) spawnSync('docker', ['volume', 'rm', '-f', volume], { encoding: 'utf8' })
  }
})

if (options.forms.includes('tls')) await form('tls reverse proxy', async () => {
  if (!options.forms.includes('container')) await buildImage()
  const network = `dsh-deploy-tls-${Date.now()}`
  const backend = `${network}-backend`
  const proxy = `${network}-proxy`
  const volume = `${network}-data`
  const tlsDir = await mkdtemp(join(tmpdir(), 'dsh-deploy-tls-'))
  const publicPort = 8443
  const publicOrigin = `https://localhost:${String(publicPort)}`
  const nginxImage = process.env.DSH_POC_NGINX_IMAGE ?? 'nginx:alpine'
  docker(['volume', 'create', volume])
  docker(['network', 'create', network])
  try {
    const keys = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', join(tlsDir, 'server.key'), '-out', join(tlsDir, 'server.crt'),
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { encoding: 'utf8' })
    assert.equal(keys.status, 0, keys.stderr)
    docker(['run', '-d', '--name', backend, '--network', network, '--network-alias', 'backend', '-v', `${volume}:/data`,
      '-e', 'DSH_POC_HOST=0.0.0.0', '-e', `DSH_POC_PUBLIC_ORIGIN=${publicOrigin}`, options.image])
    docker(['run', '-d', '--name', proxy, '--network', network, '-p', `127.0.0.1:${String(publicPort)}:443`,
      '-v', `${NGINX_CONF}:/etc/nginx/conf.d/default.conf:ro`,
      '-v', `${tlsDir}:/etc/nginx/tls:ro`, nginxImage])
    await waitFor(async () => (await proxiedRequest(`${publicOrigin}/api/browser-native/health`)).status === 401,
      'the TLS proxy to reach the backend')
    await waitFor(() => tokenFromVolume(options.image, volume).length > 0, 'the local auth token file')
    const token = tokenFromVolume(options.image, volume).trim()

    const health = await proxiedRequest(`${publicOrigin}/api/browser-native/health`, { 'x-browser-native-auth': token })
    assert.equal(health.status, 200, health.body)
    assert.equal(JSON.parse(health.body).ok, true)

    const sameOrigin = await proxiedRequest(`${publicOrigin}/api/browser-native/health`, {
      'x-browser-native-auth': token, origin: publicOrigin,
    })
    assert.equal(sameOrigin.status, 200, 'the configured public origin must pass the Origin check')
    const foreignOrigin = await proxiedRequest(`${publicOrigin}/api/browser-native/health`, {
      'x-browser-native-auth': token, origin: 'https://evil.example',
    })
    assert.equal(foreignOrigin.status, 403, 'a foreign Origin must be refused behind the proxy')

    const handshake = await proxiedRequest(handshakeUrl(publicOrigin, token))
    assert.equal(handshake.status, 302)
    const cookie = handshake.headers['set-cookie']?.join(';') ?? ''
    assert.ok(cookie.startsWith('dsh-browser-native-auth='), 'handshake must set the local auth cookie')
    assert.ok(cookie.includes('; Secure'), 'an https public origin must mark the cookie Secure')

    const workspaceId = await assertBrowserSync(handshakeUrl(publicOrigin, token), true)
    docker(['stop', '--time', '20', proxy])
    docker(['stop', '--time', '20', backend])
    assert.equal(Number(docker(['inspect', '--format', '{{.State.ExitCode}}', backend])), 0, 'the backend must exit cleanly on SIGTERM')
    assert.equal(lockPresentInVolume(options.image, volume), false)
    const report = checkDataInVolume(options.image, volume)
    assert.equal(report.compatible, true)
    process.stdout.write(`deployment-verify: tls workspace=${workspaceId} origin=${publicOrigin} sessions=${String(report.sessions.total)}\n`)
  } finally {
    spawnSync('docker', ['rm', '-f', proxy, backend], { encoding: 'utf8' })
    spawnSync('docker', ['network', 'rm', network], { encoding: 'utf8' })
    if (!options.keep) spawnSync('docker', ['volume', 'rm', '-f', volume], { encoding: 'utf8' })
    await rm(tlsDir, { recursive: true, force: true })
  }
})

if (options.forms.includes('systemd')) await form('systemd unit', async () => {
  const image = process.env.DSH_POC_NODE_IMAGE ?? 'node:24-bookworm-slim'
  const verify = spawnSync('docker', ['run', '--rm',
    '-v', `${REPO_ROOT}:/opt/browser-native-dsh:ro`,
    '-v', `${UNIT}:/etc/systemd/system/browser-native-dsh.service:ro`,
    '-v', `${UNIT_ENV}:/etc/browser-native-dsh/browser-native-dsh.env:ro`,
    image, 'sh', '-c', 'apt-get update -qq >/dev/null && apt-get install -y -qq systemd >/dev/null && ln -sf /usr/local/bin/node /usr/bin/node && systemd-analyze verify browser-native-dsh.service'],
  { encoding: 'utf8', timeout: 300_000 })
  const output = `${verify.stdout}${verify.stderr}`.trim()
  if (verify.status !== 0) throw new Error(`systemd-analyze verify failed\n${output}`)
  assert.ok(existsSync(UNIT), 'the unit file must exist')
  process.stdout.write(`deployment-verify: systemd-analyze verify PASS${output === '' ? '' : `\n${output}`}\n`)
})

const failed = outcomes.filter(outcome => outcome.verdict !== 'PASS')
process.stdout.write(`deployment-verify: ${String(outcomes.length - failed.length)}/${String(outcomes.length)} forms passed\n`)
if (failed.length > 0) process.exitCode = 1
