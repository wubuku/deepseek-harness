import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createExperimentServer } from './server.mjs'

const args = process.argv.slice(2)
const value = (key, fallback) => { const index = args.indexOf(key); return index < 0 ? fallback : args[index + 1] }
if (args.includes('real') && (process.env.https_proxy || process.env.HTTPS_PROXY) && process.allowedNodeEnvironmentFlags.has('--use-env-proxy') && !process.execArgv.includes('--use-env-proxy')) {
  const result = spawnSync(process.execPath, ['--use-env-proxy', ...process.execArgv, fileURLToPath(import.meta.url), ...args], { stdio: 'inherit', env: { ...process.env, HTTPS_PROXY: process.env.HTTPS_PROXY ?? process.env.https_proxy, HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.http_proxy, NO_PROXY: '127.0.0.1,localhost' } })
  process.exit(result.status ?? 1)
}
const options = { llmMode: value('--llm', 'scripted'), dataDir: resolve(value('--data-dir', '/tmp/dsh-saas-complex')), envFile: value('--env-file', undefined), distRoot: resolve(import.meta.dirname, '../../../../apps/web/dist') }
const app = await createExperimentServer(options)
await app.listen(Number(value('--port', '0')), '127.0.0.1')
console.log(`复杂业务实验：http://127.0.0.1:${app.server.address().port}/saas-agentic-ui-comparison-poc/complex/index.html?ui=copilot`)
console.log(`模式：${app.llm.mode}；数据：${options.dataDir}；PID：${process.pid}`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => process.exit(0)) })
