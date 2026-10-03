#!/usr/bin/env node
/** Start the browser-native PoC backend and static page. */
import { mkdir } from 'node:fs/promises'
import { createBrowserNativeServer } from './backend.mjs'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index]
  if (!value.startsWith('--')) continue
  const [key, inline] = value.slice(2).split('=', 2)
  args.set(key, inline ?? process.argv[++index])
}

const port = Number(args.get('port') ?? 4175)
const dataDir = args.get('data-dir') ?? new URL('./.data', import.meta.url).pathname
await mkdir(dataDir, { recursive: true })
const app = await createBrowserNativeServer({ dataDir, port })
const origin = await app.listen()
console.log(`browser-native-dsh-poc listening at ${origin}`)
console.log(`data directory: ${dataDir}`)
process.once('SIGINT', () => { void app.close().finally(() => process.exit(0)) })
process.once('SIGTERM', () => { void app.close().finally(() => process.exit(0)) })
