import { createRequire } from 'node:module'
import { createBrowserNativeV2Server } from '../../backend-v2.mjs'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')
let childProcessLaunches = 0
for (const name of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']) {
  const original = childProcess[name]
  childProcess[name] = function (...args) {
    childProcessLaunches += 1
    return Reflect.apply(original, this, args)
  }
}

const app = await createBrowserNativeV2Server({ dataDir: process.argv[2], llmMode: 'scripted' })
const origin = await app.listen(0)
process.on('message', message => {
  if (message?.type === 'metrics') process.send?.({
    type: 'metrics',
    pid: process.pid,
    childProcessLaunches,
    workspaceCount: app.workspaces.workspaces.size,
    memory: process.memoryUsage(),
  })
})
process.send?.({ type: 'ready', origin, pid: process.pid })
