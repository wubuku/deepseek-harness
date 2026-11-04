#!/usr/bin/env node

/**
 * One-command startup for hosted browser-native DSH.
 *
 * Reads deployment configuration from the environment, builds the Web preview
 * when it is missing, then starts the backend with the local process token so a
 * caller cannot reach the API before the printed handshake URL is used. Hosted
 * bearer tokens additionally map verified JWTs to isolated principals; they do
 * not replace the local token gate.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const HELP = `Usage: node docs/drafts/browser-native-dsh-poc/hosted/start-hosted.mjs

Environment:
  DSH_POC_HOST                 Listen host (default: 127.0.0.1; use 0.0.0.0 in a container)
  DSH_POC_PORT                 Listen port (default: 4185; 0 selects an ephemeral port)
  DSH_POC_DATA_DIR             Session and Workspace data directory (default: ./browser-native-data)
  DSH_POC_DIST_ROOT            Built Web dist directory (default: apps/web/dist)
  DSH_POC_BUILD                auto (default), 1, or 0; auto builds the preview when it is missing
  DSH_POC_LLM                  scripted (default) or real
  DSH_POC_ENV_FILE             Backend-only dotenv file for real mode
  DSH_POC_MODEL                Real-provider model override
  DSH_POC_LLM_TIMEOUT_MS       Upstream model request deadline (default: 60000)
  DSH_POC_OWNER_LEASE_MS       Session write lease in milliseconds (default: 30000)
  DSH_POC_MAX_CONCURRENT_TURNS Model turns allowed at once (default: 8)
  DSH_POC_MAX_MOUNTED_SESSIONS Mounted Sessions allowed at once (default: 16)
  DSH_POC_WORKSPACE_CHUNK_OBJECTS       Require chunk-object storage (default: 0)
  DSH_POC_WORKSPACE_VERIFIED_DOWNLOADS  Verify downloaded chunks (default: 0)
  DSH_POC_INPUT_USD_PER_1M     Input token price for the usage report; pair with the output price
  DSH_POC_OUTPUT_USD_PER_1M    Output token price; both prices or neither
  DSH_POC_HOSTED_ISSUER        Hosted token issuer; requires the audience and secret
  DSH_POC_HOSTED_AUDIENCE      Hosted token audience
  DSH_POC_HOSTED_SECRET        HS256 shared secret, at least 32 bytes
  DSH_POC_HOSTED_CLOCK_TOLERANCE_SECONDS  Token clock tolerance (default: 30)
  DSH_POC_STATE_AUTHORITY_ORIGIN  Shared Session/Workspace authority origin
  DSH_POC_STATE_AUTHORITY_TOKEN   Internal token for the shared authority
  DSH_POC_PUBLIC_ORIGIN        Externally served origin when a TLS reverse proxy terminates TLS

See hosted-deployment.md for the configuration reference and upgrade path.
`

const cliArgs = process.argv.slice(2)
if (cliArgs.includes('--help')) {
  process.stdout.write(HELP)
  process.exit(0)
}
if (cliArgs.length > 0) {
  process.stderr.write('start-hosted reads configuration from the environment; see --help\n')
  process.exit(2)
}

const env = process.env

/** Parse an integer environment value, failing loud on malformed input. */
function integerEnv(name, fallback, minimum, maximum) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${String(minimum)} through ${String(maximum)}`)
  }
  return value
}

/** Parse an on/off environment value without guessing unknown spellings. */
function booleanEnv(name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (raw === '1' || raw === 'true') return true
  if (raw === '0' || raw === 'false') return false
  throw new Error(`${name} must be 1 or 0`)
}

/** Read the optional per-million token price pair; both present or none. */
function usagePricingFromEnv() {
  const input = env.DSH_POC_INPUT_USD_PER_1M
  const output = env.DSH_POC_OUTPUT_USD_PER_1M
  if (input === undefined && output === undefined) return undefined
  if (input === undefined || output === undefined) {
    throw new Error('DSH_POC_INPUT_USD_PER_1M and DSH_POC_OUTPUT_USD_PER_1M must be set together')
  }
  const rates = { inputUsdPer1M: Number(input), outputUsdPer1M: Number(output) }
  for (const [name, value] of Object.entries(rates)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name === 'inputUsdPer1M' ? 'DSH_POC_INPUT_USD_PER_1M' : 'DSH_POC_OUTPUT_USD_PER_1M'} must be a non-negative number`)
    }
  }
  return rates
}

/** Read the hosted token verifier settings; all three present or none. */
function hostedAuthFromEnv() {
  const issuer = env.DSH_POC_HOSTED_ISSUER
  const audience = env.DSH_POC_HOSTED_AUDIENCE
  const secret = env.DSH_POC_HOSTED_SECRET
  const configured = [issuer, audience, secret].filter(value => value !== undefined && value !== '').length
  if (configured === 0) return undefined
  if (configured !== 3) {
    throw new Error('DSH_POC_HOSTED_ISSUER, DSH_POC_HOSTED_AUDIENCE, and DSH_POC_HOSTED_SECRET must be set together')
  }
  if (Buffer.byteLength(secret) < 32) throw new Error('DSH_POC_HOSTED_SECRET must contain at least 32 bytes')
  const clockToleranceSeconds = integerEnv('DSH_POC_HOSTED_CLOCK_TOLERANCE_SECONDS', 30, 0, 3_600)
  return { issuer, audience, secret, clockToleranceSeconds }
}

/** Ensure the preview build exists, building it only when configuration allows. */
function ensurePreview(distRoot, buildMode) {
  if (existsSync(join(distRoot, 'preview.html'))) return
  if (buildMode === false) {
    throw new Error(`preview build is missing at ${distRoot}; run pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview or set DSH_POC_BUILD=auto`)
  }
  process.stdout.write(`hosted: preview build missing at ${distRoot}; building it now\n`)
  const result = spawnSync('pnpm', ['--filter', '@deepseek-ai/dsh-web-frontend', 'run', 'build:preview'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`preview build failed with exit code ${String(result.status)}`)
}

/** Read optional alert thresholds; each signal is independently enabled. */
function alertsFromEnv() {
  const raw = {
    ratio: env.DSH_POC_ALERT_FAILURE_RATIO,
    queue: env.DSH_POC_ALERT_QUEUE_BACKLOG,
    budget: env.DSH_POC_ALERT_BUDGET_USD,
    webhook: env.DSH_POC_ALERT_WEBHOOK_URL,
    interval: env.DSH_POC_ALERT_INTERVAL_MS,
  }
  if (Object.values(raw).every(value => value === undefined || value === '')) return undefined
  const alerts = {}
  if (raw.ratio !== undefined && raw.ratio !== '') {
    alerts.failureRate = { ratio: Number(raw.ratio) }
    if (env.DSH_POC_ALERT_FAILURE_MIN_SAMPLES !== undefined) {
      alerts.failureRate.minSamples = integerEnv('DSH_POC_ALERT_FAILURE_MIN_SAMPLES', 20, 1, 100_000)
    }
    if (env.DSH_POC_ALERT_FAILURE_WINDOW !== undefined) {
      alerts.failureRate.windowSize = integerEnv('DSH_POC_ALERT_FAILURE_WINDOW', 200, 1, 100_000)
    }
  }
  if (raw.queue !== undefined && raw.queue !== '') {
    alerts.queueBacklog = { queuedTurns: integerEnv('DSH_POC_ALERT_QUEUE_BACKLOG', 1, 1, 100_000) }
  }
  if (raw.budget !== undefined && raw.budget !== '') alerts.budgetUsd = Number(raw.budget)
  if (raw.webhook !== undefined && raw.webhook !== '') alerts.webhookUrl = raw.webhook
  if (raw.interval !== undefined && raw.interval !== '') {
    alerts.intervalMs = integerEnv('DSH_POC_ALERT_INTERVAL_MS', 15_000, 1, 2_147_483_647)
  }
  return alerts
}

/** Build deployment options from the environment. */
function readConfiguration() {
  const llmMode = env.DSH_POC_LLM ?? 'scripted'
  if (llmMode !== 'scripted' && llmMode !== 'real') throw new Error('DSH_POC_LLM must be scripted or real')
  const buildRaw = env.DSH_POC_BUILD
  const buildMode = buildRaw === undefined || buildRaw === '' || buildRaw === 'auto'
    ? 'auto' : booleanEnv('DSH_POC_BUILD', true)
  return {
    host: env.DSH_POC_HOST ?? '127.0.0.1',
    port: integerEnv('DSH_POC_PORT', 4185, 0, 65_535),
    dataDir: resolve(env.DSH_POC_DATA_DIR ?? join(REPO_ROOT, 'browser-native-data')),
    distRoot: resolve(env.DSH_POC_DIST_ROOT ?? join(REPO_ROOT, 'apps/web/dist')),
    llmMode,
    buildMode,
    envFile: env.DSH_POC_ENV_FILE === undefined ? undefined : resolve(env.DSH_POC_ENV_FILE),
    model: env.DSH_POC_MODEL,
    llmTimeoutMs: env.DSH_POC_LLM_TIMEOUT_MS === undefined
      ? undefined : integerEnv('DSH_POC_LLM_TIMEOUT_MS', 60_000, 1, 2_147_483_647),
    ownerLeaseMs: env.DSH_POC_OWNER_LEASE_MS === undefined
      ? undefined : integerEnv('DSH_POC_OWNER_LEASE_MS', 30_000, 300, 2_147_483_647),
    hostedAuth: hostedAuthFromEnv(),
    admission: {
      maxConcurrentTurns: integerEnv('DSH_POC_MAX_CONCURRENT_TURNS', 8, 1, 256),
      maxMountedSessions: integerEnv('DSH_POC_MAX_MOUNTED_SESSIONS', 16, 1, 1_024),
    },
    workspaceChunkObjects: booleanEnv('DSH_POC_WORKSPACE_CHUNK_OBJECTS', false),
    workspaceVerifiedDownloads: booleanEnv('DSH_POC_WORKSPACE_VERIFIED_DOWNLOADS', false),
    usagePricing: usagePricingFromEnv(),
    alerts: alertsFromEnv(),
    stateAuthorityOrigin: env.DSH_POC_STATE_AUTHORITY_ORIGIN,
    stateAuthorityToken: env.DSH_POC_STATE_AUTHORITY_TOKEN,
    publicOrigin: env.DSH_POC_PUBLIC_ORIGIN,
  }
}

/** Print the URLs, locations, and limits the running server actually uses. */
function report(app, origin, options, authMode) {
  const externalOrigin = options.publicOrigin ?? origin
  const previewPath = '/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none'
  const previewUrl = `${externalOrigin}/auth/handshake?token=${encodeURIComponent(app.authToken)}&next=${encodeURIComponent(previewPath)}`
  process.stdout.write(`hosted: ready at ${externalOrigin}\n`)
  process.stdout.write(`hosted: preview ${previewUrl}\n`)
  process.stdout.write(`hosted: health ${externalOrigin}/api/browser-native/health\n`)
  process.stdout.write(`hosted: data dir ${resolve(options.dataDir)}\n`)
  if (app.authTokenPath !== undefined) process.stdout.write(`hosted: local auth token ${app.authTokenPath}\n`)
  process.stdout.write(`hosted: auth ${authMode}\n`)
  process.stdout.write(`hosted: llm ${app.llm.mode}; model ${app.llm.model}\n`)
  process.stdout.write(`hosted: admission ≤${String(options.admission.maxConcurrentTurns)} concurrent turns, ≤${String(options.admission.maxMountedSessions)} mounted Sessions\n`)
  process.stdout.write(`hosted: usage pricing ${options.usagePricing === undefined ? 'disabled' : `$${String(options.usagePricing.inputUsdPer1M)}/M input, $${String(options.usagePricing.outputUsdPer1M)}/M output`}\n`)
  process.stdout.write(`hosted: alerts ${options.alerts === undefined ? 'disabled' : [
    ...(options.alerts.failureRate === undefined ? [] : [`failure-rate ≥${String(options.alerts.failureRate.ratio)}`]),
    ...(options.alerts.queueBacklog === undefined ? [] : [`queue ≥${String(options.alerts.queueBacklog.queuedTurns)}`]),
    ...(options.alerts.budgetUsd === undefined ? [] : [`budget $${String(options.alerts.budgetUsd)}`]),
    ...(options.alerts.webhookUrl === undefined ? [] : ['webhook']),
  ].join(', ')}\n`)
}

/** Start the server and keep it alive until SIGINT or SIGTERM. */
async function main() {
  const options = readConfiguration()

  // Real mode reaches the upstream through Node's environment proxy support; re-exec
  // once so the flag is present before any network request is constructed.
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (options.llmMode === 'real' && proxy !== undefined && process.allowedNodeEnvironmentFlags.has('--use-env-proxy')
    && !process.execArgv.includes('--use-env-proxy') && env.BROWSER_NATIVE_PROXY_REEXEC !== '1') {
    const result = spawnSync(process.execPath, [
      '--use-env-proxy',
      ...process.execArgv,
      fileURLToPath(import.meta.url),
    ], {
      stdio: 'inherit',
      env: { ...env, BROWSER_NATIVE_PROXY_REEXEC: '1' },
    })
    process.exit(result.status ?? 1)
  }

  ensurePreview(options.distRoot, options.buildMode)

  const { createBrowserNativeV2Server } = await import('../backend-v2.mjs')
  const app = await createBrowserNativeV2Server({
    host: options.host,
    dataDir: options.dataDir,
    distRoot: options.distRoot,
    llmMode: options.llmMode,
    ...(options.envFile === undefined ? {} : { envFile: options.envFile }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.llmTimeoutMs === undefined ? {} : { llmTimeoutMs: options.llmTimeoutMs }),
    ...(options.ownerLeaseMs === undefined ? {} : { ownerLeaseMs: options.ownerLeaseMs }),
    ...(options.hostedAuth === undefined ? {} : { hostedAuth: options.hostedAuth }),
    admission: options.admission,
    workspaceChunkObjects: options.workspaceChunkObjects,
    workspaceVerifiedDownloads: options.workspaceVerifiedDownloads,
    ...(options.usagePricing === undefined ? {} : { usagePricing: options.usagePricing }),
    ...(options.alerts === undefined ? {} : { alerts: options.alerts }),
    ...(options.stateAuthorityOrigin === undefined ? {} : { stateAuthorityOrigin: options.stateAuthorityOrigin }),
    ...(options.stateAuthorityToken === undefined ? {} : { stateAuthorityToken: options.stateAuthorityToken }),
    ...(options.publicOrigin === undefined ? {} : { publicOrigin: options.publicOrigin }),
    requireLocalAuth: true,
  })
  const origin = await app.listen(options.port, options.host)
  report(app, origin, options, options.hostedAuth === undefined ? 'local-token' : 'local-token + hosted-bearer')

  let closing
  async function close() {
    closing ??= app.close()
    await closing
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void close().then(() => process.exit(0), error => {
        process.stderr.write(`${String(error)}\n`)
        process.exit(1)
      })
    })
  }
}

void main().catch(error => {
  process.stderr.write(`hosted: startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
