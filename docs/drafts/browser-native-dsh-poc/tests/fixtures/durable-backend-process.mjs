import { createBrowserNativeV2Server } from '../../backend-v2.mjs'

const dataDir = process.argv[2]
const modelMode = process.argv[3] ?? 'write'
let modelRequests = 0
let toolCalls = 0

function parseKeyring(text) {
  if (text === undefined || text === '') return undefined
  const parsed = JSON.parse(text)
  return {
    keys: parsed.keys.map(entry => ({ keyId: entry.keyId, key: Buffer.from(entry.key, 'base64') })),
    activeKeyId: parsed.activeKeyId,
  }
}

const atRestKeyring = parseKeyring(process.env.CRASH_AT_REST_KEYS)
const reloadKeyring = parseKeyring(process.env.CRASH_AT_REST_RELOAD_KEYS)

const app = await createBrowserNativeV2Server({
  dataDir,
  llmMode: 'scripted',
  durableTurnTimeoutMs: 120_000,
  durableApprovalTimeoutMs: 600_000,
  ...(atRestKeyring === undefined ? {} : { atRestKeyring }),
  ...(reloadKeyring === undefined ? {} : { reloadAtRestKeyring: async () => reloadKeyring }),
  testHooks: {
    scriptedLlmFault: () => {
      modelRequests += 1
      if (modelMode === 'hang') return { kind: 'barrier-text', release: new Promise(() => {}) }
      if (modelMode === 'hang-first' && modelRequests === 1) return { kind: 'barrier-text', release: new Promise(() => {}) }
      if (modelMode === 'text' || modelMode === 'hang-first') return { kind: 'text', text: 'RESTART_TURN_DONE' }
      if (modelMode === 'commit-write' || modelMode === 'read-committed') {
        if (modelRequests > 1) return { kind: 'text', text: 'WORKSPACE_RECOVERY_DONE' }
        toolCalls += 1
        return modelMode === 'commit-write'
          ? {
              kind: 'tool-call',
              call: {
                id: 'durable-commit-write',
                name: 'write',
                arguments: { file_path: '/dsh/home/workspace/durable-committed.txt', content: 'DURABLE_COMMITTED_BODY\n' },
              },
            }
          : {
              kind: 'tool-call',
              call: {
                id: 'durable-commit-read',
                name: 'read',
                arguments: { file_path: '/dsh/home/workspace/durable-committed.txt' },
              },
            }
      }
      toolCalls += 1
      return {
        kind: 'tool-call',
        call: {
          id: `restart-write-${String(toolCalls)}`,
          name: 'write',
          arguments: { file_path: '/dsh/home/workspace/restart-pending.txt', content: 'must not be written before approval' },
        },
      }
    },
  },
})
const origin = await app.listen(0)
process.on('message', message => {
  if (message?.type === 'metrics') process.send?.({
    type: 'metrics',
    pid: process.pid,
    modelRequests,
    toolCalls,
    journalHealthy: app.durableHost.snapshot().journalHealthy,
    recovered: app.durableRecovery.recovered,
  })
})
process.send?.({ type: 'ready', origin, pid: process.pid, recovered: app.durableRecovery.recovered })
