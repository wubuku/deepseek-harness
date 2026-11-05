import { readFile } from 'node:fs/promises'
import { createBrowserNativeV2Server } from '../../backend-v2.mjs'

const dataDir = process.argv[2]
const envFile = process.argv[3]
const provider = process.argv[4] ?? 'openai-next'
const llmTimeoutMs = Number(process.argv[5] ?? 120_000)
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
      llmProviderKind: 'openai',
      model: envValue(envText, 'OPENAI_MODEL'),
      llmBaseUrl: envValue(envText, 'OPENAI_BASE_URL'),
      llmCompletionsPath: 'v1/chat/completions',
      llmApiKey: envValue(envText, 'OPENAI_API_KEY'),
    }
  : {}
const minimax = provider === 'minimax'
  ? {
      llmProviderKind: 'anthropic',
      model: envValue(envText, 'ANTHROPIC_MODEL'),
      llmBaseUrl: envValue(envText, 'ANTHROPIC_BASE_URL'),
      llmApiKey: envValue(envText, 'ANTHROPIC_API_KEY'),
    }
  : {}

const app = await createBrowserNativeV2Server({
  dataDir,
  llmMode: 'real',
  envFile,
  llmTimeoutMs,
  llmIncludeUsage: true,
  durableTurnTimeoutMs: llmTimeoutMs,
  durableApprovalTimeoutMs: 120_000,
  ...longcat,
  ...minimax,
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
