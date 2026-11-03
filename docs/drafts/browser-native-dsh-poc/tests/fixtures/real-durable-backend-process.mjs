import { readFile } from 'node:fs/promises'
import { createBrowserNativeV2Server } from '../../backend-v2.mjs'

const dataDir = process.argv[2]
const envFile = process.argv[3]
const provider = process.argv[4] ?? 'openai-next'
if (dataDir === undefined || envFile === undefined) throw new Error('real durable backend requires dataDir and envFile')

function envValue(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match?.[1] === name) return match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return undefined
}

const envText = await readFile(envFile, 'utf8')
const longcat = provider === 'longcat'
  ? {
      model: envValue(envText, 'OPENAI_MODEL'),
      llmBaseUrl: envValue(envText, 'OPENAI_BASE_URL'),
      llmCompletionsPath: 'v1/chat/completions',
      llmApiKey: envValue(envText, 'OPENAI_API_KEY'),
      llmTimeoutMs: 120_000,
    }
  : {}

const app = await createBrowserNativeV2Server({
  dataDir,
  llmMode: 'real',
  envFile,
  durableTurnTimeoutMs: 180_000,
  durableApprovalTimeoutMs: 120_000,
  ...longcat,
})
const origin = await app.listen(0)
process.on('message', message => {
  if (message?.type === 'metrics') process.send?.({
    type: 'metrics',
    pid: process.pid,
    recovered: app.durableRecovery.recovered,
    journalHealthy: app.durableHost.snapshot().journalHealthy,
  })
})
process.send?.({ type: 'ready', origin, pid: process.pid, recovered: app.durableRecovery.recovered })
