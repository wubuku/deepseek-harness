import type { ObserverCacheDirectory } from '../browser-native-observer-cache.ts'

/** In-memory OPFS and liveness locks with observable handle ownership and injected short IO. */
export function observerCacheFixture() {
  const directories = new Map<string, ObserverCacheDirectory>()
  const contents = new Map<string, Uint8Array>()
  const held = new Map<string, Promise<void>>()
  const state = { openHandles: 0, maxWrite: 0, shortWrite: false, shortRead: false, quota: false }
  const makeDirectory = (prefix: string): ObserverCacheDirectory => ({
    getDirectoryHandle: async (name, options) => {
      const path = `${prefix}${name}/`
      if (!directories.has(path) && options?.create !== true) throw new DOMException('missing', 'NotFoundError')
      if (!directories.has(path)) directories.set(path, makeDirectory(path))
      return directories.get(path)!
    },
    getFileHandle: async (name, options) => {
      const path = `${prefix}${name}`
      if (!contents.has(path) && options?.create !== true) throw new DOMException('missing', 'NotFoundError')
      if (!contents.has(path)) contents.set(path, new Uint8Array(0))
      return { createSyncAccessHandle: async () => {
        state.openHandles += 1
        let closed = false
        return {
          truncate: size => { contents.set(path, new Uint8Array(size)) },
          write: (buffer, options) => {
            if (state.quota) throw new DOMException('quota', 'QuotaExceededError')
            const source = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer)
            state.maxWrite = Math.max(state.maxWrite, source.byteLength)
            contents.get(path)!.set(source, options?.at ?? 0)
            return state.shortWrite ? source.byteLength - 1 : source.byteLength
          },
          read: (buffer, options) => {
            const output = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer)
            output.set(contents.get(path)!.subarray(options?.at ?? 0, (options?.at ?? 0) + output.byteLength))
            return state.shortRead ? output.byteLength - 1 : output.byteLength
          },
          flush: () => {},
          close: () => { if (!closed) { closed = true; state.openHandles -= 1 } },
        }
      } }
    },
    removeEntry: async name => {
      const path = `${prefix}${name}`
      if (contents.delete(path)) return
      if (!directories.delete(`${path}/`)) throw new DOMException('missing', 'NotFoundError')
      for (const key of contents.keys()) if (key.startsWith(`${path}/`)) contents.delete(key)
    },
    keys: async function* () {
      for (const path of [...directories.keys()]) {
        if (path.startsWith(prefix) && !path.slice(prefix.length, -1).includes('/')) yield path.slice(prefix.length, -1)
      }
    },
  })
  const root = makeDirectory('')
  const locks: Pick<LockManager, 'request'> = {
    request: async <Result>(name: string, optionsOrCallback: LockOptions | LockGrantedCallback<Result>, callback?: LockGrantedCallback<Result>): Promise<Result> => {
      const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
      const run = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback!
      if (options.ifAvailable === true && held.has(name)) return await run(null)
      while (held.has(name)) await held.get(name)
      let release = (): void => {}
      held.set(name, new Promise<void>(resolveRelease => { release = resolveRelease }))
      try { return await run({ name, mode: 'exclusive' }) } finally { held.delete(name); release() }
    },
  }
  return { root: async () => root, locks, state, contents, directories, held }
}
