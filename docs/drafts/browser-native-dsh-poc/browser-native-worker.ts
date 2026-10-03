/**
 * Browser-native PoC Worker entry.
 *
 * This entry intentionally mirrors the upstream WebWorker bootstrap while
 * keeping the experimental injection point in this draft directory. Phase 1
 * only proves that the existing Host and tunnel can boot from this entry;
 * provider factories are added through the same `staticModules` table in the
 * next phase.
 */
import { createWorkerHost } from '../../../packages/experimental/webworker-runtime/src/worker-host.ts'
import '../../../packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/buffer.ts'
import {
  alsCausality,
  runAtAsyncContextRoot,
} from '../../../packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/async_hooks.ts'
import { installAsyncContextHooks } from '../../../packages/experimental/webworker-runtime/src/polyfill/async-context/async-context-hooks.ts'
import {
  createNodeBuiltins,
  REPLACED_PREFIXES,
} from '../../../packages/experimental/webworker-runtime/src/node/builtins.ts'
import { whenRequestListener } from '../../../packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/http.ts'
import { installTimerGlobals } from '../../../packages/experimental/webworker-runtime/src/node/globals/timers.ts'
import { installCryptoGlobals } from '../../../packages/experimental/webworker-runtime/src/node/globals/crypto.ts'
import { isShellStartFrame } from '../../../packages/experimental/webworker-runtime/src/shell/process/protocol.ts'
import { runShellProcess } from '../../../packages/experimental/webworker-runtime/src/shell/process/host.ts'
import { installProcessGlobal } from '../../../packages/experimental/webworker-runtime/src/node/globals/process.ts'
import { createBrowserNativeStaticModules } from './browser-native-providers.ts'

installAsyncContextHooks()
installTimerGlobals()
installCryptoGlobals()

console.info('browser-native dsh: worker entry active')

let host: { handleMessage(data: unknown): void } | undefined
let shellRole = false
const pending: unknown[] = []

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as Record<string, unknown> | null
  if (host === undefined && isShellStartFrame(data)) {
    shellRole = true
    installProcessGlobal({ cwd: data.cwd, env: data.env })
    runShellProcess(data, self)
    return
  }
  if (host === undefined && data !== null && typeof data === 'object' && data.t === 'init') {
    if (typeof data.image !== 'string') {
      throw new Error('browser-native worker: init frame needs a string image url')
    }
    if (!Array.isArray(data.overlays) || data.overlays.some(overlay => typeof overlay !== 'string')) {
      throw new Error('browser-native worker: init frame needs an array of string overlay urls')
    }
    const created = createWorkerHost({
      staticModules: { ...createNodeBuiltins(), ...createBrowserNativeStaticModules() },
      staticModulePrefixes: REPLACED_PREFIXES,
      requestListener: whenRequestListener,
      alsCausality,
      image: data.image,
      overlays: data.overlays as string[],
    })
    host = created
    for (const queued of pending) {
      runAtAsyncContextRoot(() => { created.handleMessage(queued) })
    }
    pending.length = 0
    created.start().catch(() => {
      // start() reports the boot failure through the tunnel.
    })
    return
  }
  if (host === undefined) {
    if (shellRole) return
    pending.push(event.data)
    return
  }
  const ready = host
  runAtAsyncContextRoot(() => { ready.handleMessage(event.data) })
})
