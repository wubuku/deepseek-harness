/** Manual runtime-validation server; DSH still executes only inside the browser Worker. */
import { createRuntimeValidationDist } from './runtime-validation.mjs'
import { createBrowserNativeV2Server } from './backend-v2.mjs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const port = Number(process.env.DSH_POC_PORT ?? '4186')
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('DSH_POC_PORT must be a TCP port, or 0 for automatic allocation')
const image = await createRuntimeValidationDist({ roster: process.env.DSH_POC_ROSTER ?? 'browser' })
const dataDir = process.env.DSH_POC_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'dsh-browser-runtime-data-'))
let app
try {
  app = await createBrowserNativeV2Server({
    dataDir,
    distRoot: image.distRoot,
    llmMode: process.env.DSH_POC_LLM ?? 'scripted',
    envFile: process.env.DSH_POC_ENV_FILE,
  })
  const origin = await app.listen(port)
  console.log(JSON.stringify({ url: `${origin}/preview.html?browser-native=1&preview-fixture=none`, roster: image.roster, mode: app.llm.mode, model: app.llm.model, dataDir: resolve(dataDir), pid: process.pid }))
} catch (error) {
  await app?.close()
  await image.cleanup()
  throw error
}
let closing
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    closing ??= app.close().finally(() => image.cleanup())
    void closing.then(() => process.exit(0), error => {
      console.error(error)
      process.exit(1)
    })
  })
}
