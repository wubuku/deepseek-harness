#!/usr/bin/env node

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPOSITORY_ROOT = resolve(HERE, '../../..')
const cliArgs = process.argv.slice(2)
const wantsReal = cliArgs.some((value, index) => value === '--llm' && cliArgs[index + 1] === 'real')
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
if (wantsReal && proxy !== undefined && process.allowedNodeEnvironmentFlags.has('--use-env-proxy')
  && !process.execArgv.includes('--use-env-proxy') && process.env.COPILOTKIT_POC_PROXY_REEXEC !== '1') {
  const result = spawnSync(process.execPath, ['--use-env-proxy', ...process.execArgv, fileURLToPath(import.meta.url), ...cliArgs], {
    stdio: 'inherit',
    env: { ...process.env, HTTPS_PROXY: process.env.HTTPS_PROXY ?? process.env.https_proxy, HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.http_proxy, COPILOTKIT_POC_PROXY_REEXEC: '1' },
  })
  process.exit(result.status ?? 1)
}

const { createBrowserNativeV2Server } = await import('../browser-native-dsh-poc/backend-v2.mjs')

function requiredValue(argv, index, option) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} needs a value`)
  return value
}

function parseArgs(argv) {
  const values = {
    host: '127.0.0.1',
    port: 4197,
    dataDir: '/tmp/copilotkit-browser-native-dsh-poc',
    distRoot: resolve(REPOSITORY_ROOT, 'apps/web/dist'),
    llmMode: 'scripted',
    envFile: undefined,
    model: undefined,
    llmTimeoutMs: undefined,
    ownerLeaseMs: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return undefined
    if (option === '--host') { values.host = requiredValue(argv, index, option); index += 1 }
    else if (option === '--port') { values.port = Number(requiredValue(argv, index, option)); index += 1 }
    else if (option === '--data-dir') { values.dataDir = requiredValue(argv, index, option); index += 1 }
    else if (option === '--dist-root') { values.distRoot = resolve(requiredValue(argv, index, option)); index += 1 }
    else if (option === '--llm') { values.llmMode = requiredValue(argv, index, option); index += 1 }
    else if (option === '--env-file') { values.envFile = resolve(requiredValue(argv, index, option)); index += 1 }
    else if (option === '--model') { values.model = requiredValue(argv, index, option); index += 1 }
    else if (option === '--llm-timeout-ms') { values.llmTimeoutMs = Number(requiredValue(argv, index, option)); index += 1 }
    else if (option === '--owner-lease-ms') { values.ownerLeaseMs = Number(requiredValue(argv, index, option)); index += 1 }
    else throw new Error(`unknown option: ${option}`)
  }
  if (!Number.isInteger(values.port) || values.port < 1 || values.port > 65535) throw new Error('--port must be a valid port')
  if (values.llmMode !== 'scripted' && values.llmMode !== 'real') throw new Error('--llm must be scripted or real')
  return values
}

const options = parseArgs(cliArgs)
if (options === undefined) {
  process.stdout.write(`Usage: node docs/drafts/copilotkit-browser-native-dsh-poc/run.mjs [options]\n\nOptions: --port <n> --data-dir <path> --llm scripted|real --env-file <path> --model <name>\n`)
  process.exit(0)
}

const app = await createBrowserNativeV2Server(options)
const origin = await app.listen(options.port, options.host)
const appUrl = `${origin}/copilotkit-browser-native-dsh-poc/index.html`
process.stdout.write(`copilotkit browser-native dsh listening at ${origin}\n`)
process.stdout.write(`copilotkit app: ${appUrl}\n`)
process.stdout.write(`static root: ${options.distRoot}\n`)
process.stdout.write(`llm mode: ${app.llm.mode}; model: ${app.llm.model}\n`)
process.stdout.write(`session data: ${resolve(options.dataDir)}\n`)

let closing
async function close() {
  closing ??= app.close()
  await closing
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void close().then(() => process.exit(0), error => { process.stderr.write(`${String(error)}\n`); process.exit(1) }))
}
