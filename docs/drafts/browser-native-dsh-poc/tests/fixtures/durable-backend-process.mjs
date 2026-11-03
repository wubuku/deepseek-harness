import { createBrowserNativeV2Server } from '../../backend-v2.mjs'

const dataDir = process.argv[2]
const modelMode = process.argv[3] ?? 'write'
let modelRequests = 0
let toolCalls = 0

const app = await createBrowserNativeV2Server({
  dataDir,
  llmMode: 'scripted',
  durableTurnTimeoutMs: 120_000,
  durableApprovalTimeoutMs: 600_000,
  testHooks: {
    scriptedLlmFault: () => {
      modelRequests += 1
      if (modelMode === 'hang') return { kind: 'barrier-text', release: new Promise(() => {}) }
      if (modelMode === 'text') return { kind: 'text', text: 'RESTART_TURN_DONE' }
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
