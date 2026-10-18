import { resolve } from 'node:path'
import { createComparisonServer } from './server.mjs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.includes('real') && (process.env.HTTPS_PROXY ?? process.env.https_proxy) && process.allowedNodeEnvironmentFlags.has('--use-env-proxy') && !process.execArgv.includes('--use-env-proxy')) {
  const result = spawnSync(process.execPath, ['--use-env-proxy', ...process.execArgv, fileURLToPath(import.meta.url), ...args], { stdio: 'inherit', env: { ...process.env, HTTPS_PROXY: process.env.HTTPS_PROXY ?? process.env.https_proxy, HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.http_proxy, NO_PROXY: process.env.NO_PROXY ?? '127.0.0.1,localhost' } })
  process.exit(result.status ?? 1)
}
const value = (key, fallback) => { const index = args.indexOf(key); return index < 0 ? fallback : args[index + 1] }
const options = {
  llmMode: value('--llm', 'scripted'),
  port: Number(value('--port', '0')),
  dataDir: resolve(value('--data-dir', '/tmp/dsh-saas-comparison')),
  envFile: value('--env-file', undefined),
  distRoot: resolve(import.meta.dirname, '../../../apps/web/dist'),
}
const app = await createComparisonServer(options)
await app.listen(options.port, '127.0.0.1')
const origin = `http://127.0.0.1:${app.server.address().port}`
console.log(`SaaS comparison: ${origin}/saas-agentic-ui-comparison-poc/index.html?ui=native`)
console.log(`LLM: ${app.llm.mode}; data: ${options.dataDir}; PID: ${process.pid}`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => process.exit(0)) })
