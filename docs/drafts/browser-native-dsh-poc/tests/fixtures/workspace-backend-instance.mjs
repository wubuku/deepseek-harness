import { createBrowserNativeV2Server } from '../../backend-v2.mjs'

const app = await createBrowserNativeV2Server({ dataDir: process.argv[2], llmMode: 'scripted' })
const origin = await app.listen(0)
process.send?.({ type: 'ready', origin, pid: process.pid })

process.on('message', async message => {
  if (message?.type !== 'shutdown') return
  await app.close()
  process.send?.({ type: 'closed', pid: process.pid })
  process.disconnect()
})
