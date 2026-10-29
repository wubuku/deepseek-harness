#!/usr/bin/env node

/** Start the browser-native DSH v2 backend and serve the built Web preview. */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const cliArgs = process.argv.slice(2)
const wantsReal = cliArgs.some((value, index) => value === '--llm' && cliArgs[index + 1] === 'real')
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
if (wantsReal && proxy !== undefined && process.allowedNodeEnvironmentFlags.has('--use-env-proxy')
  && !process.execArgv.includes('--use-env-proxy') && process.env.BROWSER_NATIVE_PROXY_REEXEC !== '1') {
  const result = spawnSync(process.execPath, [
    '--use-env-proxy',
    ...process.execArgv,
    fileURLToPath(import.meta.url),
    ...cliArgs,
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? process.env.https_proxy,
      HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.http_proxy,
      BROWSER_NATIVE_PROXY_REEXEC: '1',
    },
  })
  process.exit(result.status ?? 1)
}

const { createBrowserNativeV2Server } = await import('./backend-v2.mjs')

function usage() {
  process.stdout.write(`Usage: node docs/drafts/browser-native-dsh-poc/run-v2.mjs [options]

Options:
  --port <number>       Listen port (default: 4185)
  --host <name>         Listen host (default: 127.0.0.1)
  --data-dir <path>     Session data directory (default: /tmp/browser-native-dsh-v2)
  --dist-root <path>    Built Web dist directory (default: apps/web/dist)
  --llm <mode>          scripted or real (default: scripted)
  --env-file <path>     Backend-only dotenv file for real mode
  --model <name>        Override the configured real-provider model
  --llm-timeout-ms <n>  Upstream model request deadline (default: 60000)
  --owner-lease-ms <n>  Write lease duration in milliseconds (default: 30000)
  --state-authority-origin <url>  PoC shared Session/Workspace authority
  --state-authority-token <token> Internal token for the shared authority
  --help                Show this message

Open:
  http://<host>:<port>/preview.html?browser-native=1&preview-fixture=none
`)
}

function requiredValue(argv, index, option) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} needs a value`)
  return value
}

function parseArgs(argv) {
  const values = {
    host: '127.0.0.1',
    port: 4185,
    dataDir: '/tmp/browser-native-dsh-v2',
    distRoot: resolve('apps/web/dist'),
    llmMode: 'scripted',
    envFile: undefined,
    model: undefined,
    llmTimeoutMs: undefined,
    ownerLeaseMs: undefined,
    stateAuthorityOrigin: undefined,
    stateAuthorityToken: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return undefined
    if (option === '--host') {
      values.host = requiredValue(argv, index, option)
      index += 1
    } else if (option === '--port') {
      const raw = requiredValue(argv, index, option)
      values.port = Number(raw)
      if (!Number.isInteger(values.port) || values.port < 1 || values.port > 65535) throw new Error('--port must be an integer from 1 through 65535')
      index += 1
    } else if (option === '--data-dir') {
      values.dataDir = requiredValue(argv, index, option)
      index += 1
    } else if (option === '--dist-root') {
      values.distRoot = resolve(requiredValue(argv, index, option))
      index += 1
    } else if (option === '--llm') {
      values.llmMode = requiredValue(argv, index, option)
      if (values.llmMode !== 'scripted' && values.llmMode !== 'real') throw new Error('--llm must be scripted or real')
      index += 1
    } else if (option === '--env-file') {
      values.envFile = resolve(requiredValue(argv, index, option))
      index += 1
    } else if (option === '--model') {
      values.model = requiredValue(argv, index, option)
      index += 1
    } else if (option === '--llm-timeout-ms') {
      values.llmTimeoutMs = Number(requiredValue(argv, index, option))
      if (!Number.isSafeInteger(values.llmTimeoutMs) || values.llmTimeoutMs < 1) throw new Error('--llm-timeout-ms must be a positive safe integer')
      index += 1
    } else if (option === '--owner-lease-ms') {
      values.ownerLeaseMs = Number(requiredValue(argv, index, option))
      if (!Number.isSafeInteger(values.ownerLeaseMs) || values.ownerLeaseMs < 300) throw new Error('--owner-lease-ms must be an integer of at least 300')
      index += 1
    } else if (option === '--state-authority-origin') {
      values.stateAuthorityOrigin = requiredValue(argv, index, option)
      index += 1
    } else if (option === '--state-authority-token') {
      values.stateAuthorityToken = requiredValue(argv, index, option)
      index += 1
    } else {
      throw new Error(`unknown option: ${option}`)
    }
  }
  return values
}

const options = parseArgs(cliArgs)
if (options === undefined) {
  usage()
  process.exit(0)
}

const app = await createBrowserNativeV2Server(options)
const origin = await app.listen(options.port, options.host)
const previewUrl = `${origin}/preview.html?browser-native=1&preview-fixture=none`
process.stdout.write(`browser-native dsh v2 listening at ${origin}\n`)
process.stdout.write(`browser-native preview: ${previewUrl}\n`)
process.stdout.write(`llm mode: ${app.llm.mode}; model: ${app.llm.model}\n`)
process.stdout.write(`session data: ${resolve(options.dataDir)}\n`)

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
